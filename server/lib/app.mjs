/**
 * 安全巡检视频处理 · 应用服务核心
 * ------------------------------------------------------------------
 * 承载：分析流水线、人工复核闭环、复发识别、聚类、自然语言检索、
 *       设备管理与硬件告警。
 * 存储：内存态 + runs/ 目录下持久化 JSON（video/finding/audit）。
 * 生产环境替换点见 docs/PRODUCT.md「如何接真实模型与真实硬件」。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { CATEGORIES, CATEGORY_BY_CODE, SEVERITY_ORDER, isRiskCategory, isPositiveCategory } from './taxonomy.mjs';
import { parseQuery, scoreFinding } from './query.mjs';
import * as vision from './vision.mjs';
import { buildRectificationOrder, buildInspectionRecord, buildFindingsExcel } from './export.mjs';
import { ALERTS, DEVICES, FINDINGS, SHIFTS, VIDEOS } from './seed.mjs';

const run = promisify(execFile);

export const SOURCE_LABEL = {
  bodycam: '执法记录仪',
  drone: '无人机',
  robot: '巡检机器狗',
  upload: '本地上传',
  device: '设备回传'
};

/**
 * 时间轴归一化
 * ------------------------------------------------------------------
 * 演示数据里的时间是固定日期（2026-09-28），直接展示会出现"十几分钟前"
 * 之类的错位。这里统一算出与"今天"的偏移并整体平移，使台账、告警、
 * 趋势图始终贴合当前时间，看起来才像真实系统。
 */
function buildTimeShift() {
  const anchor = new Date('2026-09-28T13:30:00');       // 演示数据锚点 = vid-002 巡检当天
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 13, 30, 0);
  return target.getTime() - anchor.getTime();
}

const SHIFT = buildTimeShift();
const PAD = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}:${PAD(d.getSeconds())}`;

/** 把种子里的 'YYYY-MM-DD HH:mm:ss' 或 'YYYY-MM-DD' 平移到今天 */
function shiftTimeStr(s) {
  if (!s) return s;
  const t = String(s).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(t);
  const d = new Date(t.replace(' ', 'T') + (dateOnly ? 'T09:00:00' : ''));
  if (Number.isNaN(d.getTime())) return s;
  const shifted = new Date(d.getTime() + SHIFT);
  return dateOnly ? stamp(shifted).slice(0, 10) : stamp(shifted);
}

/** 按天回推：offset 天前的同一时刻（用于历史基线） */
function daysAgoStr(n) {
  const d = new Date(Date.now() + SHIFT - n * 86400000);
  return stamp(d);
}

export function createApp({ root, ffmpeg }) {
  const RUNS_DIR = resolve(root, 'runs');
  const UPLOADS_DIR = resolve(root, 'runs', '_uploads');
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(UPLOADS_DIR, { recursive: true });

  /* ------------------------------ 状态 ------------------------------ */
  const state = {
    videos: new Map(VIDEOS.map((v) => [v.id, applyShift({
      ...v,
      recordedAt: shiftTimeStr(v.recordedAt),
      uploadedAt: shiftTimeStr(v.uploadedAt)
    })])),
    devices: new Map(DEVICES.map((d) => [d.id, applyShift({
      ...d,
      lastSeen: '2026-09-28 13:24:11'   // 台账统一锚定到"最近一次心跳"，再随 SHIFT 平移
    })])),
    alerts: ALERTS.map((a) => applyShift({ ...a, createdAt: shiftTimeStr(a.createdAt) })),
    findings: FINDINGS.map((f) => normalizeFinding(applyShift({ ...f }))),
    runs: new Map(),
    audit: [],
    liveSessions: new Map(),
    counters: { finding: FINDINGS.length, run: 0 }
  };

  /** 平移设备台账里的心跳时间：按设备状态给出合理的最近活跃时间 */
  function applyShift(obj) {
    if ('lastSeen' in obj) {
      const offsets = { online: 25, charging: 40, offline: 5 * 3600 + 17 * 60 };
      const sec = offsets[obj.status] ?? 60;
      obj.lastSeen = stamp(new Date(Date.now() - sec * 1000));
    }
    return obj;
  }

  function normalizeFinding(f) {
    const cat = CATEGORY_BY_CODE[f.categoryCode] || {};
    return {
      severity: cat.defaultSeverity || '一般',
      needsHumanReview: true,
      reviewStatus: 'pending',
      confidence: 0.5,
      counterEvidence: cat.counterEvidenceTemplate || '',
      blindSpots: cat.blindSpotTemplate ? [cat.blindSpotTemplate] : [],
      measure: cat.measure || '',
      evidence: { frames: [], clip: null },
      ...f,
      categoryName: cat.name || f.categoryCode,
      categoryGroup: cat.group || '未分类',
      categoryColor: cat.color || '#64748b',
      basis: f.basis || cat.basis || [],
      source: f.source || 'device'
    };
  }

  /* ------------------------ 历史基线（复发识别） ------------------------ */
  /**
   * 复发识别需要"上一次"的记录。真实系统中这是数据库里的历史巡检记录，
   * 这里用一段历史基线演示，并保证部位归一化字段一致。
   */
  const HISTORY = [
    {
      id: 'H-2026-0905-01', categoryCode: 'OPENING_EDGE', severity: '较大',
      site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 中部' },
      inspectedAt: daysAgoStr(23), videoId: 'hist-0905', status: 'closed',
      note: '已下发整改单 ZG-20260905-03，9月8日复查已加盖板'
    },
    {
      id: 'H-2026-0912-01', categoryCode: 'PPE_HARDHAT', severity: '一般',
      site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 西侧' },
      inspectedAt: daysAgoStr(16), videoId: 'hist-0912', status: 'closed',
      note: '已现场纠正并纳入班前教育'
    },
    {
      id: 'H-2026-0820-01', categoryCode: 'TEMP_POWER', severity: '一般',
      site: { building: '2号楼', floor: '12F', zone: '通行通道 · 中部' },
      inspectedAt: daysAgoStr(39), videoId: 'hist-0820', status: 'closed',
      note: '已整改为架空敷设'
    },
    {
      id: 'H-2026-0905-02', categoryCode: 'MATERIAL_STACK', severity: '一般',
      site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 南侧' },
      inspectedAt: daysAgoStr(23), videoId: 'hist-0905', status: 'closed',
      note: '已重新码放'
    },
    {
      id: 'H-2026-0915-01', categoryCode: 'EDGE_SURCHARGE', severity: '较大',
      site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 南侧临边' },
      inspectedAt: daysAgoStr(13), videoId: 'hist-0915', status: 'closed',
      note: '已清运临边材料，复查合格'
    }
  ];

  /** 5 天前的巡检记录（用于趋势图与真实感，演示台账数据） */
  const HISTORICAL_DAYS = [
    { ago: 6, videos: 3, minutes: 12.4, risk: 4, findings: 5, note: '1号楼主体结构层' },
    { ago: 5, videos: 2, minutes: 8.1, risk: 2, findings: 3, note: '材料堆场专项' },
    { ago: 4, videos: 4, minutes: 19.6, risk: 6, findings: 7, note: '全场航拍 + 楼层巡检' },
    { ago: 3, videos: 1, minutes: 5.2, risk: 1, findings: 2, note: '屋面临边专项' },
    { ago: 2, videos: 3, minutes: 14.8, risk: 5, findings: 6, note: '地下室夜间巡查' },
    { ago: 1, videos: 2, minutes: 11.2, risk: 3, findings: 4, note: '1号楼屋面 + 全场航拍' }
  ];

  const sameSite = (a = {}, b = {}) =>
    (a.building || '') === (b.building || '') &&
    (a.floor || '') === (b.floor || '') &&
    normalizeZone(a.zone) === normalizeZone(b.zone);

  function normalizeZone(z = '') {
    // 部位归一化：去掉方位修饰差异，便于跨次比对
    return String(z).replace(/[\s·・-]/g, '').replace(/[（(].*?[)）]/g, '');
  }

  function recurrenceOf(finding) {
    const hits = HISTORY.filter((h) => h.categoryCode === finding.categoryCode && sameSite(h.site, finding.site));
    if (!hits.length) return { recurring: false, count: 0, history: [] };
    return {
      recurring: true,
      count: hits.length,
      latest: hits.sort((a, b) => (a.inspectedAt < b.inspectedAt ? 1 : -1))[0],
      history: hits
    };
  }

  /* ---------------------------- 查询辅助 ---------------------------- */
  const listFindings = (filter = {}) => {
    let arr = [...state.findings];
    if (filter.videoId) arr = arr.filter((f) => f.videoId === filter.videoId);
    if (filter.categoryCode) arr = arr.filter((f) => f.categoryCode === filter.categoryCode);
    if (filter.categoryGroup) arr = arr.filter((f) => f.categoryGroup === filter.categoryGroup);
    if (filter.severity) arr = arr.filter((f) => f.severity === filter.severity);
    if (filter.reviewStatus) arr = arr.filter((f) => f.reviewStatus === filter.reviewStatus);
    if (filter.source) arr = arr.filter((f) => f.source === filter.source);
    if (filter.deviceType) {
      const ids = new Set([...state.devices.values()].filter((d) => d.type === filter.deviceType).map((d) => d.id));
      arr = arr.filter((f) => ids.has(state.videos.get(f.videoId)?.deviceId));
    }
    if (filter.q) {
      const kw = String(filter.q).toLowerCase();
      arr = arr.filter((f) => `${f.title}${f.description}${f.site?.zone || ''}`.toLowerCase().includes(kw));
    }
    if (filter.minConfidence != null) arr = arr.filter((f) => f.confidence >= filter.minConfidence);
    const rank = (f) => (SEVERITY_ORDER[f.severity] ?? 9) * 1000 + f.start;
    arr.sort((a, b) => rank(a) - rank(b));
    return arr.map(decorate);
  };

  function decorate(f) {
    const video = state.videos.get(f.videoId);
    const device = video?.deviceId ? state.devices.get(video.deviceId) : null;
    return {
      ...f,
      video: video ? { id: video.id, title: video.title, source: video.source, duration: video.duration, poster: video.poster, assetPath: video.assetPath } : null,
      device: device ? { id: device.id, name: device.name, type: device.type, model: device.model } : null,
      recurrence: recurrenceOf(f)
    };
  }

  const getFinding = (id) => {
    const f = state.findings.find((x) => x.id === id);
    return f ? decorate(f) : null;
  };

  /* ---------------------------- 复核闭环 ---------------------------- */
  function review(findingId, { action, reviewer, note, severity, categoryCode }) {
    const f = state.findings.find((x) => x.id === findingId);
    if (!f) return { error: 'finding not found' };
    const before = { reviewStatus: f.reviewStatus, severity: f.severity, categoryCode: f.categoryCode };
    const map = { confirm: 'confirmed', reject: 'rejected', revise: 'revised', reopen: 'pending' };
    const status = map[action];
    if (!status) return { error: `unknown action: ${action}` };

    f.reviewStatus = status;
    f.reviewedBy = reviewer || '当前用户';
    f.reviewedAt = nowStr();
    if (note) f.reviewNote = note;
    if (action === 'revise') {
      if (severity) f.severity = severity;
      if (categoryCode && CATEGORY_BY_CODE[categoryCode]) {
        f.categoryCode = categoryCode;
        const cat = CATEGORY_BY_CODE[categoryCode];
        f.categoryName = cat.name; f.categoryGroup = cat.group; f.categoryColor = cat.color;
        f.basis = cat.basis; f.measure = cat.measure;
      }
    }
    // 人工确认后不再提示复核
    if (status === 'confirmed' || status === 'rejected') f.needsHumanReview = false;
    if (status === 'pending') f.needsHumanReview = true;

    const entry = {
      id: `AU-${String(state.audit.length + 1).padStart(5, '0')}`,
      findingId,
      action,
      reviewer: f.reviewedBy,
      note: note || '',
      before,
      after: { reviewStatus: f.reviewStatus, severity: f.severity, categoryCode: f.categoryCode },
      at: f.reviewedAt
    };
    state.audit.push(entry);

    // 人工修正回流：作为后续同类判定的阈值/提示依据（生产环境写入反馈集）
    persistFeedback(entry, f);
    return { finding: decorate(f), audit: entry };
  }

  function persistFeedback(entry, finding) {
    try {
      const file = join(RUNS_DIR, 'feedback.jsonl');
      const line = JSON.stringify({
        at: entry.at, action: entry.action, findingId: entry.findingId,
        categoryCode: finding.categoryCode, videoId: finding.videoId,
        confidence: finding.confidence, note: entry.note,
        before: entry.before, after: entry.after
      });
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, prev + line + '\n', 'utf8');
    } catch { /* 反馈写入失败不应影响主流程 */ }
  }

  /* ------------------------ 聚类整合（按类型） ------------------------ */
  function clusters(filter = {}) {
    const arr = listFindings(filter);
    const groups = new Map();
    for (const f of arr) {
      if (!groups.has(f.categoryCode)) {
        groups.set(f.categoryCode, {
          categoryCode: f.categoryCode,
          name: f.categoryName,
          group: f.categoryGroup,
          color: f.categoryColor,
          severity: f.severity,
          basis: f.basis,
          measure: f.measure,
          count: 0,
          pending: 0,
          confirmed: 0,
          rejected: 0,
          revised: 0,
          other: 0,
          firstStart: Infinity,
          lastEnd: 0,
          totalSeconds: 0,
          videos: new Set(),
          sites: new Set(),
          recurringCount: 0,
          items: []
        });
      }
      const g = groups.get(f.categoryCode);
      g.count++;
      // 注意：这里曾同时用 g[f.reviewStatus]++ 与 g.pending++ 计数，导致统计翻倍。
      // 统一只使用显式字段，避免与状态键名冲突。
      if (f.reviewStatus === 'pending') g.pending++;
      else if (f.reviewStatus === 'confirmed') g.confirmed++;
      else if (f.reviewStatus === 'rejected') g.rejected++;
      else if (f.reviewStatus === 'revised') g.revised++; else g.other++;
      g.firstStart = Math.min(g.firstStart, f.start);
      g.lastEnd = Math.max(g.lastEnd, f.end);
      g.totalSeconds += Math.max(0, f.end - f.start);
      g.videos.add(f.videoId);
      if (f.site?.zone) g.sites.add(`${f.site.building || ''} ${f.site.floor || ''} ${f.site.zone}`.trim());
      if (f.recurrence?.recurring) g.recurringCount++;
      g.items.push({
        id: f.id, videoId: f.videoId, title: f.title, start: f.start, end: f.end,
        severity: f.severity, confidence: f.confidence, reviewStatus: f.reviewStatus,
        site: f.site, clip3s: f.evidence?.clip3s, clip3sStart: f.evidence?.clip3sStart,
        poster: f.evidence?.frames?.[0]?.src || null,
        device: f.device, video: f.video, recurrence: f.recurrence
      });
    }
    const out = [...groups.values()].map((g) => ({
      ...g,
      videos: [...g.videos],
      sites: [...g.sites],
      timeRange: [Number(g.firstStart.toFixed(2)), Number(g.lastEnd.toFixed(2))],
      totalSeconds: Number(g.totalSeconds.toFixed(1))
    }));
    out.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || b.count - a.count);
    return out;
  }

  /* --------------------------- 自然语言检索 --------------------------- */
  function search(rawQuery, opts = {}) {
    const intent = parseQuery(rawQuery);
    const clipSeconds = opts.clipSeconds || intent.clipSeconds;

    let pool = [...state.findings];
    if (opts.videoId) pool = pool.filter((f) => f.videoId === opts.videoId);
    if (opts.source) pool = pool.filter((f) => f.source === opts.source);
    const wantPending = opts.onlyPending != null ? opts.onlyPending : intent.pendingOnly;
    if (wantPending === true) pool = pool.filter((f) => f.reviewStatus === 'pending');
    if (wantPending === false) pool = pool.filter((f) => f.reviewStatus !== 'pending');
    if (intent.deviceType) {
      const ids = new Set([...state.devices.values()].filter((d) => d.type === intent.deviceType).map((d) => d.id));
      pool = pool.filter((f) => ids.has(state.videos.get(f.videoId)?.deviceId));
    }

    const scoredAll = pool.map((f) => ({ f, s: scoreFinding(f, intent) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    // 相关度阈值过滤：命中明确类别时，只返回该类别的高相关结果。
    // 这一步很关键——否则一次检索会把库里全部告警都倒出来，失去"检索"的意义。
    let scored = scoredAll;
    let filteredOut = 0;
    if (intent.categories.length) {
      const top = scoredAll.length ? scoredAll[0].s : 0;
      const threshold = Math.max(8, top * 0.5);
      scored = scoredAll.filter((x) => x.s >= threshold);
      filteredOut = scoredAll.length - scored.length;
    }

    const results = scored.map(({ f, s }) => {
      const ev = f.evidence || {};
      // 片段以 3 秒为单位：优先用预切 3s 片段，否则用 finding 区间
      const start = ev.clip3sStart != null ? ev.clip3sStart : f.start;
      const duration = ev.clip3s ? Math.min(3, clipSeconds) : Math.max(0.5, Math.min(clipSeconds, f.end - f.start));
      const video = state.videos.get(f.videoId);
      return {
        findingId: f.id,
        score: Number(s.toFixed(1)),
        videoId: f.videoId,
        videoTitle: video?.title || '',
        videoAsset: video?.assetPath || null,
        categoryCode: f.categoryCode,
        categoryName: f.categoryName,
        severity: f.severity,
        confidence: f.confidence,
        reviewStatus: f.reviewStatus,
        title: f.title,
        description: f.description,
        site: f.site,
        // 与原始视频对应的一小段画面
        clip: {
          src: ev.clip3s || ev.clip || null,
          start: Number(start.toFixed(2)),
          end: Number((start + duration).toFixed(2)),
          duration: Number(duration.toFixed(2)),
          label: `${fmt(start)} – ${fmt(start + duration)}`
        },
        poster: ev.frames?.[0]?.src || null,
        source: video?.source || 'device',
        sourceLabel: SOURCE_LABEL[video?.source] || '设备回传',
        counterEvidence: f.counterEvidence,
        device: (() => {
          const d = video?.deviceId ? state.devices.get(video.deviceId) : null;
          return d ? { id: d.id, name: d.name, type: d.type } : null;
        })(),
        recurrence: recurrenceOf(f)
      };
    });

    return {
      intent,
      clipSeconds,
      total: results.length,
      matchedPool: scoredAll.length,
      filteredOut,
      results,
      groups: groupResults(results, intent)
    };
  }

  function groupResults(results, intent) {
    const m = new Map();
    for (const r of results) {
      if (!m.has(r.categoryCode)) {
        const cat = CATEGORY_BY_CODE[r.categoryCode] || {};
        m.set(r.categoryCode, {
          categoryCode: r.categoryCode, name: cat.name || r.categoryName,
          color: cat.color || '#64748b', count: 0, items: []
        });
      }
      const g = m.get(r.categoryCode);
      g.count++; g.items.push(r);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  /* --------------------------- 分析流水线 --------------------------- */
  /**
   * 启动一次分析任务。返回 runId，进度通过 tasks 查询。
   * 阶段：probe → segment → screen → confirm → summarize → done
   */
  function startRun({ videoId, deviceId, filename, uploadedPath, source = 'device', meta = {} }) {
    const runId = `RUN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(++state.counters.run).padStart(3, '0')}`;
    const dir = join(RUNS_DIR, runId);
    mkdirSync(join(dir, 'clips'), { recursive: true });
    mkdirSync(join(dir, 'shots'), { recursive: true });

    const task = {
      runId, videoId, status: 'queued', stage: 'queued', progress: 0,
      startedAt: nowStr(), finishedAt: null, error: null,
      segments: [], findings: [], summary: null,
      mode: vision.VISION_MODE,
      deviceId: deviceId || null, uploadPath: uploadedPath || null,
      meta
    };
    state.runs.set(runId, task);

    // 异步执行，不阻塞请求
    queueMicrotask(() => executeRun(task, { videoId, deviceId, filename, uploadedPath, source, dir, meta }).catch((e) => {
      task.status = 'failed'; task.error = String(e?.message || e); task.stage = 'failed';
    }));

    return task;
  }

  async function executeRun(task, ctx) {
    const { videoId, dir, uploadedPath, meta } = ctx;
    const video = state.videos.get(videoId);
    const duration = video?.duration || meta.duration || 0;

    // ---- stage 0: 清理该视频既有打标结果，保证同一视频只有一份当前结论 ----
    // 注意：必须按 videoId 全量清理，不能只删带 runId 的记录，
    // 否则预置台账数据会残留下来，与新一轮结果混在一起（曾导致结论串台）。
    const stale = state.findings.filter((f) => f.videoId === videoId);
    if (stale.length) {
      const staleIds = new Set(stale.map((f) => f.id));
      const keep = state.findings.filter((f) => f.videoId !== videoId);
      state.findings.length = 0;
      state.findings.push(...keep);
      // 同步作废这些条目的复核痕迹，避免审计记录指向不存在的 finding
      state.audit = state.audit.filter((a) => !staleIds.has(a.findingId));
      task.removedStale = stale.length;
    }

    // ---- stage 1: probe ----
    setStage(task, 'probe', 6);
    await sleep(320);
    const probeResult = vision.probe(duration, {
      width: video?.width || meta.width, height: video?.height || meta.height, fps: video?.fps || meta.fps
    });
    task.probe = probeResult;

    // ---- stage 2: segment ----
    setStage(task, 'segment', 16);
    await sleep(420);
    const segments = vision.segment(duration, {
      seed: hashSeed(videoId || ctx.filename || 'x'),
      sceneNames: video ? sceneNamesFor(video) : undefined
    });
    task.segments = segments;

    // ---- stage 3: screen（粗筛，只登记候选）----
    setStage(task, 'screen', 30);
    await sleep(500);
    const { candidates, provenance } = vision.detectCandidates(duration, segments, vision.DEMO_LIBRARY, {
      videoId, calibratedFor: vision.CALIBRATED_VIDEO_ID
    });
    task.candidates = candidates.length;
    task.provenance = provenance;
    task.stageDetail = `粗筛命中 ${candidates.length} 个候选，进入复核`;

    // ---- stage 4: confirm（复核 + 证据打包，真实调用 ffmpeg 切片）----
    const srcVideoPath = uploadedPath || resolve(root, video.assetPath);
    const created = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const pct = 30 + Math.round(((i + 1) / candidates.length) * 50);
      setStage(task, 'confirm', pct, `复核第 ${i + 1}/${candidates.length} 项：${c.title}`);
      const { finding, public: pub } = await buildFinding(c, { task, dir, srcVideoPath, videoId, video, source: ctx.source });
      created.push(finding);      // 真实对象，供总结直接使用
      task.findings.push(pub);
      await sleep(180);
    }

    // ---- stage 5: summarize ----
    setStage(task, 'summarize', 88);
    await sleep(360);
    // 直接使用本轮的 finding 对象，不做 ID 回查
    const createdFindings = created.filter(Boolean);
    if (process.env.YZX_DEBUG) {
      console.log('[debug] run', task.runId, 'videoId', videoId, 'duration', duration,
        'candidates', candidates.map((c) => `${c.categoryCode}@${c.start}-${c.end}`).join(' | '));
      console.log('[debug] summary source findings:',
        createdFindings.map((f) => `${f.id} ${f.categoryCode} ${f.start}-${f.end}`).join(' | '));
    }
    const summary = vision.buildSummary(createdFindings, video || { duration }, {
      segmentCount: segments.length,
      sceneLabel: meta.sceneLabel || deriveSceneLabel(segments)
    });
    task.summary = summary;

    // ---- done ----
    setStage(task, 'done', 100);
    task.status = 'done';
    task.finishedAt = nowStr();

    if (video) {
      video.runStatus = 'done';
      video.analyzedAt = task.finishedAt;
      video.lastRunId = task.runId;
    }
    writeRunReport(task, dir, video);
  }

  async function buildFinding(c, { task, dir, srcVideoPath, videoId, video, source }) {
    // ID 必须全局唯一。早期版本用 task.findings.length 生成序号，
    // 与历史台账的 F-001-xxx 撞号，导致"按 ID 回查"命中上一轮的旧对象，
    // 总结里就混进了别的视频条目。这里统一用分析任务序号，杜绝复用。
    const seq = task.runId.slice(-3);
    const id = `F-R${seq}-${String(task.findings.length + 1).padStart(3, '0')}`;
    const cat = CATEGORY_BY_CODE[c.categoryCode] || {};

    // 复核阶段：多帧一致性 + 局部放大（真实实现调用 VLM；此处按命中强度定档）
    const s = c.hitStrength ?? 1;
    const confidence = Math.min(0.97, Math.max(0.3, Number(c.confidence.toFixed(2))));
    const stage2 = confidence >= 0.75 ? 'confirm' : confidence >= 0.5 ? 'review' : 'screen';
    const severity = cat.defaultSeverity || '一般';
    // 跨素材标注库产出的结果一律强制人工复核，不允许自动进入结论
    const offCalibration = task.provenance && !task.provenance.matchedCalibration;
    const needsHumanReview = offCalibration || severity === '较大' || severity === '重大' || confidence < 0.7;

    // 真实切出证据帧与 3 秒片段
    const frames = [];
    const frameTs = (c.evidenceFrameTs && c.evidenceFrameTs.length
      ? c.evidenceFrameTs
      : [c.start + 0.5, (c.start + c.end) / 2, Math.max(c.start, c.end - 0.5)]
    ).slice(0, 3);

    for (let i = 0; i < frameTs.length; i++) {
      const name = `${id}_${String(i + 1).padStart(2, '0')}.jpg`;
      const abs = join(dir, 'shots', name);
      await shoot(srcVideoPath, frameTs[i], abs).catch(() => {});
      if (existsSync(abs)) frames.push({ t: Number(frameTs[i].toFixed(2)), src: relFromRoot(root, abs) });
    }

    const mid = (c.start + c.end) / 2;
    const c3Start = Math.max(0, Math.min(mid - 1.5, Math.max(0, (video?.duration || c.end) - 3)));
    const c3Name = `${id}_3s.mp4`;
    const c3Abs = join(dir, 'clips', c3Name);
    await cut(srcVideoPath, c3Start, 3, c3Abs).catch(() => {});

    const clipName = `${id}.mp4`;
    const clipAbs = join(dir, 'clips', clipName);
    const clipDur = Math.min(c.end - c.start, 12);
    await cut(srcVideoPath, c.start, clipDur, clipAbs).catch(() => {});

    const finding = normalizeFinding({
      id,
      videoId,
      runId: task.runId,
      categoryCode: c.categoryCode,
      title: c.title,
      description: c.description,
      severity,
      start: Number(c.start.toFixed(2)),
      end: Number(c.end.toFixed(2)),
      confidence,
      needsHumanReview,
      reviewStatus: 'pending',
      counterEvidence: c.counterEvidence,
      blindSpots: c.blindSpots,
      measure: c.measure,
      site: c.site,
      source,
      segmentIndex: c.segmentIndex,
      evidence: {
        frames,
        clip: existsSync(clipAbs) ? relFromRoot(root, clipAbs) : null,
        clipStart: Number(c.start.toFixed(2)),
        clipDuration: Number(clipDur.toFixed(2)),
        clip3s: existsSync(c3Abs) ? relFromRoot(root, c3Abs) : null,
        clip3sStart: Number(c3Start.toFixed(2))
      },
      detection: {
        model: `vision-adapter/${vision.VISION_MODE}`,
        stage: stage2,
        hitStrength: s,
        rawConfidence: c.rawConfidence ?? confidence,
        confidencePenalty: task.provenance?.confidencePenalty ?? 1,
        librarySource: c.sourceVideoId || 'local',
        libraryVerified: !offCalibration,
        framesScanned: (task.segments.length || 1) * 12,
        segmentIndex: c.segmentIndex
      }
    });

    state.findings.push(finding);
    // 直接返回真实对象，避免上层"按 ID 回查"再次引入复用风险
    return { finding, public: publicFinding(finding) };
  }

  const publicFinding = (f) => ({
    id: f.id, videoId: f.videoId, categoryCode: f.categoryCode, categoryName: f.categoryName,
    severity: f.severity, title: f.title, start: f.start, end: f.end, confidence: f.confidence,
    reviewStatus: f.reviewStatus, needsHumanReview: f.needsHumanReview,
    evidence: f.evidence, site: f.site
  });

  function deriveSceneLabel(segments) {
    const names = [...new Set(segments.map((s) => s.scene))];
    return names.slice(0, 3).join('、');
  }

  function writeRunReport(task, dir, video) {
    try {
      writeFileSync(join(dir, 'index.json'), JSON.stringify({
        runId: task.runId, videoId: task.videoId, video: video ? { id: video.id, title: video.title, duration: video.duration, source: video.source } : null,
        mode: task.mode, startedAt: task.startedAt, finishedAt: task.finishedAt,
        probe: task.probe, segments: task.segments, segmentCount: task.segments.length,
        candidateCount: task.candidates, findingCount: task.findings.length,
        summary: task.summary
      }, null, 2), 'utf8');
      writeFileSync(join(dir, 'findings.json'), JSON.stringify(
        state.findings.filter((f) => f.runId === task.runId), null, 2), 'utf8');
    } catch { /* 落盘失败不影响主流程 */ }
  }

  function setStage(task, stage, progress, detail) {
    task.stage = stage; task.progress = progress; if (detail) task.stageDetail = detail;
    task.status = stage === 'done' ? 'done' : 'running';
  }

  /* --------------------------- 上传与登记 --------------------------- */
  /**
   * 接收上传。
   * 注意：文件名优先从查询参数读取。经验证，Node 在「流式 body + duplex:'half'」
   * 场景下自定义请求头可能丢失，若只依赖 x-filename 会把文件名退化成默认值。
   * 因此查询参数为主、请求头为兜底。
   */
  async function handleUpload(req, headers, query = {}) {
    const rawName = query.fileName || (headers['x-filename'] ? decodeURIComponent(headers['x-filename']) : '') || 'upload.mp4';
    const name = basename(String(rawName));
    const safe = `${Date.now()}-${name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')}`;
    const abs = join(UPLOADS_DIR, safe);
    await pipeline(req, createWriteStream(abs));
    const size = statSync(abs).size;

    // 用 ffprobe 能力受限，这里用 ffmpeg 解析时长（真实实现用 ffprobe）
    const meta = await probeFile(abs);

    const id = `vid-up-${Date.now().toString(36)}`;
    const dec = (v) => { try { return v ? decodeURIComponent(v) : ''; } catch { return String(v || ''); } };
    const titleHeader = dec(headers['x-title']) || dec(query.title);
    const video = {
      id,
      // 标题优先级：显式标题 > 上传文件名（去扩展名）> 兜底
      title: titleHeader || name.replace(/\.[^.]+$/, '') || `上传视频 ${id.slice(-4)}`,
      assetPath: relFromRoot(root, abs),
      poster: null,
      duration: meta.duration, width: meta.width, height: meta.height, fps: meta.fps, codec: meta.codec,
      source: dec(headers['x-source']) || dec(query.source) || 'upload',
      deviceId: dec(headers['x-device']) || dec(query.device) || null,
      operator: dec(headers['x-operator']) || '本地上传',
      site: dec(headers['x-site']) || '未标注',
      recordedAt: headers['x-recorded-at'] || nowStr(),
      uploadedAt: nowStr(),
      runStatus: 'pending',
      realFootage: true,
      fileSize: size
    };
    state.videos.set(id, video);

    // 用真实 ffmpeg 生成封面帧
    const posterAbs = join(RUNS_DIR, `${id}-poster.jpg`);
    await shoot(abs, Math.min(3, Math.max(0, meta.duration / 10)), posterAbs).catch(() => {});
    if (existsSync(posterAbs)) video.poster = relFromRoot(root, posterAbs);

    return video;
  }

  async function probeFile(abs) {
    try {
      const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', abs, '-f', 'null', '-'], { maxBuffer: 1024 * 1024 * 8 });
      return parseFfmpegInfo(stderr);
    } catch (e) {
      return parseFfmpegInfo(String(e?.stderr || ''));
    }
  }

  function parseFfmpegInfo(text) {
    const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
    // 分辨率解析要稳：Stream 行里 h264 之后可能有多组括号与逗号
    // （如 "Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 960x544, ..."）
    // 因此不能依赖固定的逗号分段，改为优先匹配像素格式后的 WxH。
    const streamLine = (text.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*Video:/.test(l)) || '');
    const res = /(\d{2,5})x(\d{2,5})/.exec(streamLine);
    const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(streamLine) || /(\d+(?:\.\d+)?)\s*fps/.exec(text);
    const codec = /Video:\s*([A-Za-z0-9_]+)/.exec(streamLine);
    return {
      duration: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0,
      width: res ? +res[1] : null,
      height: res ? +res[2] : null,
      fps: fps ? +fps[1] : null,
      codec: codec ? codec[1] : null
    };
  }

  /* ---------------------------- 硬件管理 ---------------------------- */
  const listDevices = (filter = {}) => {
    let arr = [...state.devices.values()];
    if (filter.type) arr = arr.filter((d) => d.type === filter.type);
    if (filter.status) arr = arr.filter((d) => d.status === filter.status);
    if (filter.q) {
      const kw = filter.q.toLowerCase();
      arr = arr.filter((d) => `${d.name}${d.id}${d.model}${d.boundTo}${d.site}`.toLowerCase().includes(kw));
    }
    return arr.map((d) => ({
      ...d,
      alarmCount: state.alerts.filter((a) => a.deviceId === d.id && a.status === 'open' && a.type !== 'battery').length,
      videoCount: d.videoIds.length,
      recentVideos: d.videoIds.map((id) => state.videos.get(id)).filter(Boolean).map((v) => ({
        id: v.id, title: v.title, duration: v.duration, recordedAt: v.recordedAt, runStatus: v.runStatus, poster: v.poster
      }))
    }));
  };

  function deviceCommand(deviceId, action, payload = {}) {
    const d = state.devices.get(deviceId);
    if (!d) return { error: 'device not found' };
    switch (action) {
      case 'ota_start': {
        if (d.firmware === d.latestFirmware) return { error: '已是最新版本' };
        d.otaState = 'upgrading'; d.otaProgress = 1;
        pushAlert({ deviceId, type: 'ota', level: 'info', message: `固件 ${d.latestFirmware} 开始升级` });
        otaTick(d, deviceId);
        return { device: d, message: `开始升级到 ${d.latestFirmware}` };
      }
      case 'ota_cancel':
        d.otaState = 'available'; d.otaProgress = 0;
        pushAlert({ deviceId, type: 'ota', level: 'info', message: '固件升级已取消' });
        return { device: d, message: '已取消升级' };
      case 'live_start': {
        const sid = `LIVE-${deviceId}-${Date.now().toString(36)}`;
        state.liveSessions.set(sid, { id: sid, deviceId, startedAt: nowStr(), status: 'streaming', triggeredBy: payload.by || '当前用户' });
        pushAlert({ deviceId, type: 'live', level: 'info', message: `手动触发实时画面查看（${payload.by || '当前用户'}）` });
        return {
          session: state.liveSessions.get(sid),
          // 演示环境：实时流以最近一次录像作为画面来源，并显式标注
          streamAsset: state.videos.get(d.videoIds[0])?.assetPath || null,
          note: '演示环境未接入 RTSP/GB28181 实时流，画面取该设备最近一次录像，并在界面显式标注'
        };
      }
      case 'live_stop': {
        const s = state.liveSessions.get(payload.sessionId);
        if (s) { s.status = 'stopped'; s.stoppedAt = nowStr(); }
        return { session: s || null };
      }
      case 'rename': {
        if (!payload.name) return { error: 'name required' };
        const old = d.name; d.name = payload.name;
        pushAlert({ deviceId, type: 'config', level: 'info', message: `设备重命名：${old} → ${d.name}` });
        return { device: d };
      }
      case 'bind': {
        d.boundTo = payload.boundTo || d.boundTo;
        return { device: d };
      }
      case 'reboot':
        d.status = 'online'; d.lastSeen = nowStr();
        pushAlert({ deviceId, type: 'config', level: 'info', message: '远程重启指令已下发' });
        return { device: d, message: '重启指令已下发' };
      default:
        return { error: `unknown action: ${action}` };
    }
  }

  function otaTick(d, deviceId) {
    let n = 0;
    const timer = setInterval(() => {
      n += 7 + Math.floor(Math.random() * 9);
      if (n >= 100) {
        n = 100;
        d.firmware = d.latestFirmware;
        d.otaState = 'latest';
        clearInterval(timer);
        pushAlert({ deviceId, type: 'ota', level: 'ok', message: `固件升级完成，当前版本 ${d.firmware}` });
      }
      d.otaProgress = n;
    }, 1200);
    timer.unref?.();
  }

  function pushAlert({ deviceId, type, level, message }) {
    const a = {
      id: `AL-${1000 + state.alerts.length + 1}`,
      deviceId, type, level, message, createdAt: nowStr(), status: 'open'
    };
    state.alerts.unshift(a);
    return a;
  }

  const listAlerts = (filter = {}) => {
    let arr = [...state.alerts];
    if (filter.deviceId) arr = arr.filter((a) => a.deviceId === filter.deviceId);
    if (filter.status) arr = arr.filter((a) => a.status === filter.status);
    if (filter.type) arr = arr.filter((a) => a.type === filter.type);
    if (filter.level) arr = arr.filter((a) => a.level === filter.level);
    return arr.map((a) => {
      const d = state.devices.get(a.deviceId);
      return { ...a, deviceName: d?.name || a.deviceId, deviceType: d?.type || 'unknown', deviceStatus: d?.status || 'unknown' };
    });
  };

  function ackAlert(id) {
    const a = state.alerts.find((x) => x.id === id);
    if (!a) return { error: 'alert not found' };
    a.status = a.status === 'open' ? 'closed' : 'open';
    a.handledAt = nowStr();
    return a;
  }

  /* ---------------------------- 统计总览 ---------------------------- */
  function dashboard() {
    const fs = state.findings;
    const pending = fs.filter((f) => f.reviewStatus === 'pending');
    const confirmed = fs.filter((f) => f.reviewStatus === 'confirmed');
    const rejected = fs.filter((f) => f.reviewStatus === 'rejected');
    const risk = fs.filter((f) => isRiskCategory(f.categoryCode));
    const devices = [...state.devices.values()];

    const bySeverity = {};
    for (const s of ['重大', '较大', '一般', '提示']) bySeverity[s] = fs.filter((f) => f.severity === s).length;

    const byType = CATEGORIES.map((c) => ({
      code: c.code, name: c.name, group: c.group, color: c.color,
      count: fs.filter((f) => f.categoryCode === c.code).length,
      pending: fs.filter((f) => f.categoryCode === c.code && f.reviewStatus === 'pending').length
    })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count);

    const bySource = ['bodycam', 'drone', 'robot', 'upload'].map((s) => ({
      source: s,
      label: { bodycam: '执法记录仪', drone: '无人机', robot: '机器狗', upload: '本地上传' }[s],
      count: fs.filter((f) => (state.videos.get(f.videoId)?.source || 'bodycam') === s).length
    }));

    // 近 7 日趋势：今日为真实打标数据，更早日期叠加历史巡检台账
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const dayFindings = fs.filter((f) => (state.videos.get(f.videoId)?.recordedAt || '').slice(0, 10) === key);
      const dayVideos = [...state.videos.values()].filter((v) => (v.recordedAt || '').slice(0, 10) === key);
      const hist = HISTORICAL_DAYS.find((h) => h.ago === i);
      trend.push({
        date: key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        findings: dayFindings.length + (hist?.findings || 0),
        risk: dayFindings.filter((f) => isRiskCategory(f.categoryCode)).length + (hist?.risk || 0),
        videos: dayVideos.length + (hist?.videos || 0),
        minutes: Number((dayVideos.reduce((s, v) => s + (v.duration || 0), 0) / 60 + (hist?.minutes || 0)).toFixed(1)),
        note: hist?.note || ''
      });
    }

    // 处理效率：模型自动发现 / 人工复核修正
    const reviewed = confirmed.length + rejected.length;
    const autoCorrect = confirmed.length;
    const efficiency = {
      reviewed,
      autoCorrectRate: reviewed ? Number((autoCorrect / reviewed * 100).toFixed(1)) : null,
      rejectedRate: reviewed ? Number((rejected / reviewed * 100).toFixed(1)) : null,
      pendingReview: pending.length,
      totalMinutes: Number(([...state.videos.values()].reduce((s, v) => s + (v.duration || 0), 0) / 60).toFixed(1)),
      savedMinutes: Number(([...state.videos.values()].reduce((s, v) => s + (v.duration || 0) / 60 * 0.8, 0)).toFixed(1))
    };

    const recurring = fs.filter((f) => recurrenceOf(f).recurring);

    return {
      generatedAt: nowStr(),
      kpi: {
        videos: state.videos.size,
        videoMinutes: efficiency.totalMinutes,
        findings: fs.length,
        riskFindings: risk.length,
        pendingReview: pending.length,
        confirmed: confirmed.length,
        rejected: rejected.length,
        recurring: recurring.length,
        devices: devices.length,
        devicesOnline: devices.filter((d) => d.status === 'online').length,
        devicesOffline: devices.filter((d) => d.status === 'offline').length,
        openAlerts: state.alerts.filter((a) => a.status === 'open' && a.type !== 'battery').length,
        runs: state.runs.size
      },
      bySeverity, byType, bySource, trend, efficiency,
      recentFindings: listFindings({}).slice(0, 6),
      recentAlerts: listAlerts({ status: 'open' }).slice(0, 6),
      recurringTop: [...new Map(recurring.map((f) => [f.categoryCode, f])).values()].slice(0, 4).map((f) => ({
        categoryCode: f.categoryCode, title: f.title, recurrence: recurrenceOf(f), severity: f.severity
      }))
    };
  }

  function videoDetail(id) {
    const v = state.videos.get(id);
    if (!v) return null;
    const f = listFindings({ videoId: id });
    const run = v.lastRunId ? state.runs.get(v.lastRunId) : [...state.runs.values()].find((r) => r.videoId === id) || null;
    // 若该视频尚未执行过分析任务，按确定性种子预计算事件段，
    // 保证时间轴等依赖事件段的功能始终可用（同种子结果可复现）。
    const segments = run?.segments?.length
      ? run.segments
      : (v.duration ? vision.segment(v.duration, { seed: hashSeed(v.id), sceneNames: sceneNamesFor(v) }) : []);
    return {
      ...v,
      device: v.deviceId ? state.devices.get(v.deviceId) : null,
      findings: f,
      clusters: clusters({ videoId: id }),
      segments,
      segmentsPrecomputed: !run?.segments?.length,
      run: run ? { runId: run.runId, status: run.status, stage: run.stage, progress: run.progress, segments: run.segments, summary: run.summary } : null
    };
  }

  /** 不同来源视频的场景命名不同，避免无人机视频出现"楼梯间"这类不合理场景 */
  function sceneNamesFor(v) {
    if (v.source === 'drone') return ['全场航拍 · 塔楼区', '全场航拍 · 堆场区', '全场航拍 · 道路', '全场航拍 · 基坑区', '全场航拍 · 塔吊区'];
    if (v.source === 'robot') return ['地下室 B1 · 车道', '地下室 B1 · 设备房', '地下室 B1 · 停车区', '地下室 B1 · 楼梯口'];
    if (v.source === 'upload') return ['上传视频 · 片段 1', '上传视频 · 片段 2', '上传视频 · 片段 3', '上传视频 · 片段 4'];
    return ['室内结构楼层', '室内通行通道', '材料堆放区', '楼梯间', '室外材料堆场', '室外道路'];
  }

  const listVideos = () => [...state.videos.values()].map((v) => ({
    ...v,
    findingCount: state.findings.filter((f) => f.videoId === v.id).length,
    riskCount: state.findings.filter((f) => f.videoId === v.id && isRiskCategory(f.categoryCode)).length,
    pendingCount: state.findings.filter((f) => f.videoId === v.id && f.reviewStatus === 'pending').length,
    device: v.deviceId ? state.devices.get(v.deviceId) : null
  })).sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));

  function taskStatus(runId) {
    const t = state.runs.get(runId);
    if (!t) return null;
    return {
      runId: t.runId, videoId: t.videoId, status: t.status, stage: t.stage, progress: t.progress,
      stageDetail: t.stageDetail || '', mode: t.mode,
      startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error,
      segmentCount: t.segments.length,
      segments: t.segments,
      candidateCount: t.candidates || 0,
      provenance: t.provenance || null,
      removedStale: t.removedStale || 0,
      findings: t.findings,
      summary: t.summary,
      probe: t.probe
    };
  }

  const auditTrail = (findingId) => state.audit.filter((a) => !findingId || a.findingId === findingId);

  /* ---------------------------- 报告导出 ---------------------------- */
  /**
   * 生成正式文书（安全管理人员最终要交出去的东西）。kind:
   *   rectify —— 隐患整改通知单（排除已排除项与正向记录）
   *   record  —— 安全巡检记录表
   *   excel   —— 隐患明细表（SpreadsheetML，Excel 可直接打开）
   * 所有导出条目强制带原始视频时间码，无时间码的条目不允许进入正式文书。
   */
  function exportReport(kind, filter = {}) {
    const videoId = filter.videoId || null;
    const video = videoId ? state.videos.get(videoId) : null;
    if (videoId && !video) return { error: 'video not found' };

    const findings = listFindings(videoId ? { videoId } : {});
    const run = video
      ? (video.lastRunId ? state.runs.get(video.lastRunId) : [...state.runs.values()].find((r) => r.videoId === video.id))
      : null;
    // 总结优先取任务级结果；若该视频在本会话内未执行过分析（例如预置台账数据），
    // 则按当前打标结果现场生成一份，保证正式文书里始终有可核对的总结。
    const summary = run?.summary
      || vision.buildSummary(
        findings.map((f) => state.findings.find((s) => s.id === f.id)).filter(Boolean),
        video || { duration: 0 },
        { segmentCount: video?.duration ? Math.max(2, Math.round(video.duration / 22)) : 0 }
      );
    const generatedAt = nowStr();
    const opts = {
      video, findings, generatedAt, summary,
      device: video?.deviceId ? state.devices.get(video.deviceId) : null
    };

    const stamp = generatedAt.slice(0, 10).replace(/-/g, '');
    const safeName = String(video?.title || '全部视频').replace(/[\\/:*?"<>|]/g, '_');

    const map = {
      rectify: () => ({ contentType: 'text/html; charset=utf-8', filename: `隐患整改通知单_${safeName}_${stamp}.html`, body: buildRectificationOrder(opts) }),
      record: () => ({ contentType: 'text/html; charset=utf-8', filename: `安全巡检记录表_${safeName}_${stamp}.html`, body: buildInspectionRecord(opts) }),
      inspection: () => ({ contentType: 'text/html; charset=utf-8', filename: `安全巡检记录表_${safeName}_${stamp}.html`, body: buildInspectionRecord(opts) }),
      excel: () => ({ contentType: 'application/vnd.ms-excel; charset=utf-8', filename: `隐患明细表_${safeName}_${stamp}.xls`, body: buildFindingsExcel(opts) }),
      xls: () => ({ contentType: 'application/vnd.ms-excel; charset=utf-8', filename: `隐患明细表_${safeName}_${stamp}.xls`, body: buildFindingsExcel(opts) })
    };
    const fn = map[kind];
    return fn ? fn() : { error: `unknown export kind: ${kind}` };
  }

  /* ------------------------------ 工具 ------------------------------ */
  function shoot(src, t, out) {
    return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', src,
      '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', out], { maxBuffer: 1024 * 1024 * 16 });
  }

  function cut(src, start, dur, out) {
    return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', src,
      '-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
      '-vf', 'scale=640:-2', out], { maxBuffer: 1024 * 1024 * 32 });
  }

  return {
    state,
    listVideos, videoDetail, startRun, taskStatus, handleUpload,
    listFindings, getFinding, review, clusters, search, auditTrail,
    listDevices, deviceCommand, listAlerts, ackAlert, dashboard,
    exportReport,
    categories: CATEGORIES,
    history: HISTORY,
    recurrenceOf,
    paths: { root, RUNS_DIR, UPLOADS_DIR }
  };
}

/* ------------------------------ 通用工具 ------------------------------ */
export const fmt = vision.fmt;

function relFromRoot(root, abs) {
  return abs.replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', '');
}
function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 100000;
}
