/* 安全巡检视频处理 · 视频智能分析
   两种来源：设备回传视频 / 人工本地上传；输出：问题总结 + 精确时间码 + 同类聚类 */
import { api } from '../api.js';
import {
  $, $$, esc, fmtTime, fmtRange, fmtDate, tag, sevTag, reviewTag, sourceTag, toast,
  emptyState, demoNote, bar, DEVICE_TYPE, SEV_COLOR, lightbox
} from '../ui.js';

const STAGES = [
  ['probe', '读取元数据'],
  ['segment', '事件段切分'],
  ['screen', '视觉粗筛'],
  ['confirm', '复核取证'],
  ['summarize', '生成总结']
];

/** 与后端 taxonomy.isRiskCategory 保持一致的口径：正向记录类检查项不计入隐患。
 *  注意：前端不做隐患计数，riskCount 一律取服务端计算值，此处仅作口径对照说明。 */
const POSITIVE_CODES = new Set(['SAFE_PRACTICE', 'FIRE_EQUIP']);
void POSITIVE_CODES;

export async function render(root, ctx) {
  const state = { videos: [], selected: null, run: null, pollTimer: null, uploading: false };

  root.innerHTML = `
    <div class="grid" style="grid-template-columns: 390px minmax(0,1fr); gap:14px; align-items:start">
      <div class="stack" style="gap:14px;position:sticky;top:78px">
        <div class="card">
          <div class="card-head"><h3>上传本地视频</h3></div>
          <div class="drop" id="drop">
            <span class="big">⬆️</span>
            <div style="font-weight:620">点击选择，或把视频文件拖到这里</div>
            <div class="tiny muted" style="margin-top:5px">支持 mp4 / mov / avi / mkv，人工上传的设备原始视频与设备回传视频走同一条分析链路</div>
          </div>
          <input type="file" id="file" accept="video/*" style="display:none">
          <div id="up-progress" style="margin-top:11px;display:none">
            <div class="row" style="justify-content:space-between"><span class="tiny muted" id="up-label">上传中…</span><span class="tiny mono" id="up-pct">0%</span></div>
            <div style="margin-top:6px">${bar(0)}</div>
          </div>
        </div>

        <div class="card" style="max-height:52vh;display:flex;flex-direction:column">
          <div class="card-head">
            <h3>选择待分析视频</h3>
            <div class="right"><button class="btn sm ghost" id="refresh">↻</button></div>
          </div>
          <div class="scroll-y" style="flex:1;min-height:0;margin:-4px;padding:4px" id="vlist"></div>
        </div>
      </div>

      <div id="out"></div>
    </div>
  `;

  /* ---------------- 上传 ---------------- */
  const drop = $('#drop', root);
  const fileInput = $('#file', root);
  drop.addEventListener('click', () => fileInput.click());
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) doUpload(f); });
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) doUpload(f); });

  async function doUpload(file) {
    if (state.uploading) return;
    state.uploading = true;
    $('#up-progress', root).style.display = 'block';
    $('#up-label', root).textContent = `上传中：${file.name}（${(file.size / 1048576).toFixed(1)} MB）`;
    try {
      const r = await api.upload(file, { source: 'upload', operator: '人工上传' }, (p) => {
        $('#up-pct', root).textContent = `${p}%`;
        $('#up-progress .bar > i', root).style.width = `${p}%`;
      });
      toast(`上传成功：${r.video.title}（${fmtTime(r.video.duration)}）`);
      await loadVideos();
      state.selected = r.video.id;
      renderVideos();
      toast('已选择该视频，点击「开始智能分析」');
    } catch (e) {
      toast(`上传失败：${e.message}`, 'err');
    } finally {
      state.uploading = false;
      setTimeout(() => { $('#up-progress', root).style.display = 'none'; }, 1200);
      fileInput.value = '';
    }
  }

  /* ---------------- 视频列表 ---------------- */
  async function loadVideos() {
    const { videos } = await api.videos();
    state.videos = videos;
    if (!state.selected && videos.length) state.selected = videos.find((v) => v.realFootage)?.id || videos[0].id;
  }

  function renderVideos() {
    const host = $('#vlist', root);
    host.innerHTML = state.videos.map((v) => `
      <div class="row clickable" data-vid="${esc(v.id)}"
           style="gap:10px;padding:9px;border-radius:8px;border:1px solid ${state.selected === v.id ? 'var(--brand)' : 'transparent'};
                  background:${state.selected === v.id ? 'rgba(61,220,151,.07)' : 'transparent'};margin-bottom:5px;align-items:flex-start">
        ${v.poster ? `<img src="/${esc(v.poster)}" style="width:64px;height:38px;object-fit:cover;border-radius:5px;border:1px solid var(--line)">`
          : `<div style="width:64px;height:38px;border-radius:5px;background:#0d1626;border:1px solid var(--line);display:grid;place-items:center;font-size:15px">${DEVICE_TYPE[v.source]?.ic || '📼'}</div>`}
        <div style="min-width:0;flex:1">
          <div class="small" style="font-weight:620;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.title)}</div>
          <div class="tiny muted">${fmtTime(v.duration)} · ${esc(v.site)} · ${fmtDate(v.recordedAt).slice(5)}</div>
          <div class="row" style="gap:5px;margin-top:5px">
            ${sourceTag(v.source)}
            ${v.riskCount ? tag(`隐患 ${v.riskCount}`, 'orange') : tag('未发现', 'green')}
            ${v.pendingCount ? tag(`待复核 ${v.pendingCount}`, 'amber') : ''}
          </div>
        </div>
      </div>`).join('');

    host.querySelectorAll('[data-vid]').forEach((n) => n.addEventListener('click', () => {
      state.selected = n.dataset.vid;
      state.run = null;
      renderVideos();
      renderOut();
    }));
  }

  $('#refresh', root).addEventListener('click', async () => { await loadVideos(); renderVideos(); toast('已刷新'); });

  /* ---------------- 输出区 ---------------- */
  function renderOut() {
    const out = $('#out', root);
    const v = state.videos.find((x) => x.id === state.selected);
    if (!v) { out.innerHTML = `<div class="card">${emptyState('请先在左侧选择或上传一段视频')}</div>`; return; }

    out.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <h3>${esc(v.title)}</h3>
          <div class="right">${sourceTag(v.source)}</div>
        </div>
        <div class="row wrap" style="gap:14px;margin-bottom:13px">
          <div><div class="tiny muted">时长</div><b>${fmtTime(v.duration)}</b></div>
          <div><div class="tiny muted">分辨率</div><b>${v.width}×${v.height}</b></div>
          <div><div class="tiny muted">帧率</div><b>${v.fps || '—'} fps</b></div>
          <div><div class="tiny muted">部位</div><b>${esc(v.site)}</b></div>
          <div><div class="tiny muted">巡检人</div><b>${esc(v.operator || '—')}</b></div>
          <div><div class="tiny muted">录制时间</div><b>${fmtDate(v.recordedAt)}</b></div>
          <div><div class="tiny muted">已打标</div><b>${v.findingCount} 条（隐患 ${v.riskCount}）</b></div>
        </div>
        <div class="row" style="gap:9px">
          <button class="btn primary" id="start" ${v.assetPath ? '' : 'disabled'}>⚡ 开始智能分析</button>
          ${v.runStatus === 'done' ? `<button class="btn" id="to-review">查看已生成的告警（${v.pendingCount} 待复核）→</button>` : ''}
          ${!v.assetPath ? `<span class="tiny muted">演示台账数据未挂载真实媒体，无法执行分析。请选择「2号楼 12层 二次结构巡检」或上传本地视频。</span>` : ''}
        </div>
      </div>

      <div id="run-host"></div>
    `;

    $('#start', root).addEventListener('click', startAnalysis);
    $('#to-review', root)?.addEventListener('click', () => ctx.navigate('review'));
    if (state.run) renderRun();
  }

  /* ---------------- 启动分析 + 轮询 ---------------- */
  async function startAnalysis() {
    const v = state.videos.find((x) => x.id === state.selected);
    if (!v) return;
    try {
      const { runId } = await api.analyze(v.id);
      toast(`分析任务已创建：${runId}`);
      state.run = { runId, stage: 'queued', progress: 0, status: 'running' };
      renderRun();
      poll(runId);
    } catch (e) {
      toast(`启动失败：${e.message}`, 'err');
    }
  }

  function poll(runId) {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const t = await api.task(runId);
        state.run = t;
        renderRun();
        if (t.status === 'done' || t.status === 'failed') {
          clearInterval(state.pollTimer);
          await loadVideos();
          renderVideos();
          if (t.status === 'done') toast(`分析完成：检出 ${t.summary?.riskTotal ?? 0} 项安全隐患`);
          else toast(`分析失败：${t.error}`, 'err');
        }
      } catch (e) {
        clearInterval(state.pollTimer);
        toast(`获取任务状态失败：${e.message}`, 'err');
      }
    }, 550);
  }

  /* ---------------- 渲染分析过程与结果 ---------------- */
  function renderRun() {
    const host = $('#run-host', root);
    const t = state.run;
    if (!t) { host.innerHTML = ''; return; }

    const curIdx = STAGES.findIndex(([k]) => k === t.stage);
    const running = t.status === 'running' || t.status === 'queued';

    host.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <h3>分析流水线</h3>
          <span class="hint">${esc(t.runId)} · ${esc(t.mode || '')}</span>
          <div class="right"><span class="mono small" style="color:var(--brand)">${t.progress}%</span></div>
        </div>
        <div class="steps" style="margin-bottom:11px">
          ${STAGES.map(([k, label], i) => `<div class="step ${t.stage === k ? 'on' : (curIdx > i || t.status === 'done') ? 'done' : ''}">${label}</div>`).join('')}
        </div>
        ${bar(t.progress)}
        <div class="row" style="margin-top:9px;gap:10px">
          <span class="small muted">${esc(t.stageDetail || stageText(t.stage))}</span>
          <span class="spacer"></span>
          ${t.segmentCount ? tag(`事件段 ${t.segmentCount}`, 'blue') : ''}
          ${t.candidateCount ? tag(`候选 ${t.candidateCount}`, 'purple') : ''}
          ${t.findings?.length ? tag(`确认 ${t.findings.length}`, 'green') : ''}
        </div>
        ${running ? `<div class="tiny muted" style="margin-top:7px">分析为离线批处理形态，可离开本页，任务在服务端继续执行。</div>` : ''}
      </div>

      ${t.provenance && !t.provenance.matchedCalibration ? demoNote(`<b>来源校验未通过</b>：${esc(t.provenance.note)}`) : ''}

      ${t.probe ? `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><h3>画面质量评估</h3><span class="hint">决定检出能力上限，需随时间码一并归档</span></div>
        <div class="row" style="gap:16px;margin-bottom:9px">
          <div><div class="tiny muted">分辨率等级</div><b style="font-size:19px">${esc(t.probe.quality?.resolution || '—')}</b></div>
          <div><div class="tiny muted">短边像素</div><b>${t.probe.quality?.shortSide ?? '—'}</b></div>
          <div><div class="tiny muted">事件段数量</div><b>${t.probe.sceneCount ?? '—'}</b></div>
        </div>
        <div class="stack" style="gap:6px">
          ${(t.probe.quality?.notes || []).map((n) => `<div class="evi blind" style="font-size:12px"><b>检出限制</b>${esc(n)}</div>`).join('')}
        </div>
      </div>` : ''}

      ${t.summary ? renderSummary(t) : ''}
      ${t.findings?.length ? renderFindings(t) : ''}
      ${t.segments?.length ? renderSegments(t) : ''}
    `;

    // 证据帧点击放大
    $$('[data-shot]', host).forEach((img) =>
      img.addEventListener('click', () => lightbox(img.dataset.shot, `证据帧 · ${fmtTime(Number(img.dataset.t))}`)));
  }

  function renderSummary(t) {
    const s = t.summary;
    const sevOrder = ['重大', '较大', '一般', '提示'];
    return `
      <div class="card" style="margin-bottom:14px;border-color:rgba(61,220,151,.3)">
        <div class="card-head">
          <h3>安全问题总结</h3>
          <span class="hint">由已确认的隐患自动生成，时间码与下方列表一一对应</span>
        </div>
        <div style="font-size:13.5px;line-height:1.85;background:rgba(61,220,151,.05);border-left:3px solid var(--brand);padding:12px 14px;border-radius:0 8px 8px 0">
          ${esc(s.text)}
        </div>
        <div class="grid g4" style="gap:12px;margin-top:14px">
          <div><div class="tiny muted">检出问题合计</div><div style="font-size:22px;font-weight:700">${s.total}</div></div>
          <div><div class="tiny muted">其中安全隐患</div><div style="font-size:22px;font-weight:700;color:var(--accent)">${s.riskTotal}</div></div>
          <div><div class="tiny muted">低置信度转人工</div><div style="font-size:22px;font-weight:700;color:var(--warn)">${s.lowConfidenceTotal}</div></div>
          <div><div class="tiny muted">等级分布</div>
            <div class="row wrap" style="gap:5px;margin-top:4px">
              ${sevOrder.filter((x) => s.severityCounts[x]).map((x) => tag(`${x} ${s.severityCounts[x]}`, { 重大: 'red', 较大: 'orange', 一般: 'amber', 提示: 'blue' }[x])).join('')}
            </div>
          </div>
        </div>
        <div class="hr"></div>
        <div class="tiny muted" style="margin-bottom:8px">按时间码定位（点击跳转到复核工作台对应片段）</div>
        <div class="stack" style="gap:6px">
          ${s.highlight.map((h) => `
            <div class="row clickable" data-open="${esc(h.id)}" style="gap:9px;padding:7px 9px;border-radius:7px;background:rgba(43,179,255,.05)">
              <span class="mono small" style="color:${SEV_COLOR[h.severity]}">${fmtRange(h.start, h.end)}</span>
              ${sevTag(h.severity)}
              <span class="small">${esc(h.title)}</span>
              <span class="spacer"></span>
              <span class="tiny muted">置信 ${(h.confidence * 100).toFixed(0)}%</span>
              <span class="tiny" style="color:var(--brand-2)">查看证据 →</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  /** 同类型聚类整合展示 */
  function renderFindings(t) {
    // 客户端按类型聚合，服务端 /api/clusters 亦提供同口径数据
    const groups = new Map();
    for (const f of t.findings) {
      if (!groups.has(f.categoryCode)) groups.set(f.categoryCode, { code: f.categoryCode, items: [] });
      groups.get(f.categoryCode).items.push(f);
    }
    return `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <h3>隐患类型聚类</h3>
          <span class="hint">同类型问题自动合并，展开查看每一处的时间码与证据</span>
          <div class="right"><span class="tag blue">${groups.size} 类 / ${t.findings.length} 处</span></div>
        </div>
        <div class="stack" style="gap:10px">
          ${[...groups.values()].map((g) => {
            const first = g.items[0];
            const cat = t.findings.find((x) => x.categoryCode === g.code);
            return `
            <div class="cluster">
              <div class="cluster-head" data-toggle>
                <i class="cbar" style="background:${SEV_COLOR[first.severity] || '#4aa8ff'}"></i>
                <div style="flex:1;min-width:0">
                  <div style="font-weight:640;font-size:13.5px">${esc(first.title)}</div>
                  <div class="tiny muted">${g.items.map((x) => fmtTime(x.start)).join(' · ')}</div>
                </div>
                <span class="tag amber">${g.items.length} 处</span>
                <span class="tiny muted">展开 ▾</span>
              </div>
              <div class="cluster-body" style="display:none">
                ${g.items.map((f) => `
                  <div class="row" style="gap:12px;align-items:flex-start">
                    <div style="flex:0 0 190px">
                      <div class="shots" style="grid-template-columns:1fr">
                        ${f.evidence?.frames?.[0] ? `<div class="shot"><img data-shot="/${esc(f.evidence.frames[0].src)}" data-t="${f.evidence.frames[0].t}" src="/${esc(f.evidence.frames[0].src)}"><span class="t">${fmtTime(f.evidence.frames[0].t)}</span></div>` : ''}
                      </div>
                    </div>
                    <div style="flex:1;min-width:0">
                      <div class="row" style="gap:6px;margin-bottom:5px">
                        ${sevTag(f.severity)}
                        <span class="tag gray mono">${fmtRange(f.start, f.end)}</span>
                        ${reviewTag(f.reviewStatus)}
                        <span class="tiny muted">置信 ${(f.confidence * 100).toFixed(0)}%</span>
                      </div>
                      <div class="small" style="color:var(--text-dim)">${esc(f.description)}</div>
                      <div class="evi counter" style="margin-top:7px;font-size:12px"><b>⚠ 反证</b>${esc(f.counterEvidence || '无')}</div>
                      <div class="row" style="gap:6px;margin-top:8px">
                        ${f.evidence?.clip3s ? `<video controls preload="metadata" src="/${esc(f.evidence.clip3s)}" style="width:200px;border-radius:6px;border:1px solid var(--line)"></video>` : ''}
                        <button class="btn sm primary" data-open="${esc(f.id)}">到复核台核对 →</button>
                      </div>
                    </div>
                  </div>`).join('')}
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function renderSegments(t) {
    return `
      <div class="card">
        <div class="card-head">
          <h3>事件段切分结果</h3>
          <span class="hint">长视频被压缩为事件段，只对事件段调用视觉模型 —— 这是离线批处理的成本闸门</span>
        </div>
        <div class="row wrap" style="gap:7px">
          ${t.segments.map((s) => `
            <div class="card tight" style="padding:8px 10px;min-width:150px" title="兴趣度 ${s.interest}">
              <div class="tiny muted">#${s.index + 1} · ${esc(s.scene)}</div>
              <div class="mono small">${fmtRange(s.start, s.end)}</div>
              <div class="row" style="gap:4px;margin-top:5px">
                ${s.hasPeople ? tag('有人', 'blue') : ''}
                ${s.hasMachinery ? tag('机械', 'purple') : ''}
                ${s.interest > 0.75 ? tag('重点', 'amber') : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  function stageText(stage) {
    return {
      queued: '任务排队中…', probe: '读取视频元数据与画面质量…', segment: '切分事件段…',
      screen: '视觉粗筛中，登记候选…', confirm: '对候选做多帧复核与证据打包…',
      summarize: '生成问题总结…', done: '分析完成', failed: '分析失败'
    }[stage] || stage;
  }

  /* ---------------- 全局事件 ---------------- */
  root.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const body = toggle.parentElement.querySelector('.cluster-body');
      if (body) body.style.display = body.style.display === 'none' ? 'grid' : 'none';
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) ctx.navigate('review', { findingId: open.dataset.open });
  });

  /* ---------------- 启动 ---------------- */
  await loadVideos();
  renderVideos();
  renderOut();

  // 若选中的视频已有分析任务，自动接管进度显示
  const v = state.videos.find((x) => x.id === state.selected);
  if (v?.assetPath && v.runStatus === 'analyzing') {
    const detail = await api.video(v.id);
    if (detail.run) { state.run = await api.task(detail.run.runId); renderRun(); poll(detail.run.runId); }
  } else if (v?.assetPath) {
    // 展示该视频最近一次分析结果（若存在）
    const detail = await api.video(v.id);
    if (detail.run?.status === 'done') { state.run = await api.task(detail.run.runId); renderRun(); }
  }}
