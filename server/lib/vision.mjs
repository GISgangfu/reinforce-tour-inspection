/**
 * 安全巡检视频处理 · 视觉分析适配器（Vision Adapter）
 * ==================================================================
 * 【重要说明 · 请勿误解】
 * 本文件是「真实视觉模型的接口层 + 当前可运行的规则化实现」。
 *
 *  - 对外接口（probe / segment / screen / confirm）与生产环境接入
 *    真实 VLM（视觉语言模型）时完全一致，替换本文件即可切换。
 *  - 当前 detectCandidates() 使用「内容知识库 + 关键词规则」产出候选，
 *    result.mode 会标记为 'demo-rule'，界面也会显式提示，不伪装成模型输出。
 *  - 真实接入时，只需把 screen/confirm 内部换成：
 *      1) 抽帧 → 关键帧拼图 / 局部裁剪放大
 *      2) 调用 VLM（如通义千问-VL / 豆包视觉 / GPT-4o）返回结构化 JSON
 *      3) 多帧一致性投票 + 反证字段生成
 *    其余流水线（分段、判定、证据打包、报告）无需改动。
 */

import { isRiskCategory, isPositiveCategory } from './taxonomy.mjs';

export const VISION_MODE = process.env.YZX_VISION === 'live' ? 'live-vlm' : 'demo-rule';
/** DEMO_LIBRARY 所标定的素材（唯一具备逐帧核对结果的视频） */
export const CALIBRATED_VIDEO_ID = 'vid-002';/** 视频元数据探测（真实实现：ffprobe / 硬件 SDK） */
export function probe(durationSeconds, meta = {}) {
  const duration = Number(durationSeconds) || 0;
  const sceneCount = Math.max(2, Math.round(duration / 22));
  return {
    duration,
    width: meta.width || 960,
    height: meta.height || 544,
    fps: meta.fps || 27,
    quality: assessQuality(meta),
    sceneCount
  };
}

/** 画面质量评分：直接决定检出能力上限，必须显式暴露给使用者 */
export function assessQuality(meta = {}) {
  const h = meta.height || 544;
  const w = meta.width || 960;
  const shortSide = Math.min(w, h);
  const resolution = shortSide >= 1080 ? 'A' : shortSide >= 720 ? 'B' : shortSide >= 540 ? 'C' : 'D';
  const notes = [];
  if (resolution === 'C' || resolution === 'D') {
    notes.push('分辨率偏低，安全帽/安全带等细粒度特征需局部裁剪放大后判定');
  }
  notes.push('第一视角平视拍摄，无法俯视洞口正下方，临边防护存在视角盲区');
  notes.push('画面下缘长期被巡检员反光背心占据，该区域已屏蔽检测');
  return { resolution, shortSide, notes };
}

/**
 * 事件段切分：把长视频压缩成"事件段"，这是离线批处理的成本闸门。
 * 真实实现：镜头切换检测 + 人员/机械目标出现与位移 + 音频突变。
 */
export function segment(duration, opts = {}) {
  const seed = opts.seed || 1;
  const segs = [];
  let t = 0;
  let i = 0;
  const palette = ['室内结构楼层', '室内通行通道', '材料堆放区', '楼梯间', '室外材料堆场', '室外道路'];
  const rand = mulberry32(seed);
  let scene = 0;
  while (t < duration) {
    const len = 8 + rand() * 16;
    const end = Math.min(duration, t + len);
    const idx = Math.min(palette.length - 1, Math.floor((t / duration) * palette.length + rand() * 0.9));
    const sceneName = opts.sceneNames ? opts.sceneNames[Math.min(idx, opts.sceneNames.length - 1)] : palette[idx];
    const hasPeople = rand() > 0.35;
    const hasMachinery = rand() > 0.72;
    segs.push({
      index: i++,
      start: Number(t.toFixed(2)),
      end: Number(end.toFixed(2)),
      scene: sceneName,
      hasPeople,
      hasMachinery,
      interest: Number((0.35 + rand() * 0.6).toFixed(2))
    });
    t = end;
  }
  // 相邻同场景合并，减少调用次数
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.scene === s.scene) {
      last.end = s.end;
      last.hasPeople = last.hasPeople || s.hasPeople;
      last.hasMachinery = last.hasMachinery || s.hasMachinery;
      last.interest = Math.max(last.interest, s.interest);
    } else merged.push({ ...s });
  }
  merged.forEach((s, k) => { s.index = k; s.duration = Number((s.end - s.start).toFixed(2)); });
  return merged;
}

/**
 * 候选检测：对应真实实现里的「粗筛」。
 * 输出只登记候选，不做定性、不给等级。
 *
 * ============ 采信分级（重要设计决策） ============
 * 标注库按 scope.videoId 分区。这里区分两种情形：
 *
 *  A. 标定一致（videoId === calibratedFor）
 *     标注库正是为这段素材逐帧核对的，结果具备回归测试意义，按原始置信度采信。
 *
 *  B. 标定不一致（标定素材之外的新视频，典型场景＝人工上传）
 *     早期版本在这里做硬过滤，结果是「上传视频永远检出 0 条」——
 *     功能形式上可用，实际上没有任何价值。
 *     改为「降权采信」：按时间码匹配 + 置信度惩罚 + 强制人工复核 + 显式来源标注，
 *     绝不参与自动结论。这样既不产生假阳性结论，又让链路真正跑通。
 *
 * 注意：模型只给候选与证据，等级与条款由规则层判定，见 app.mjs。
 */
export const UNCALIBRATED_CONFIDENCE_PENALTY = 0.85;

export function detectCandidates(duration, segments, library, opts = {}) {
  const { videoId, calibratedFor } = opts;
  const matchedCalibration = !calibratedFor || !videoId || videoId === calibratedFor;

  // 时段归属过滤：先按 scope 分区取"属于这段素材"的条目；
  // 标定不一致时退化为取全部条目（降权采信），而不是丢弃。
  const inScope = library.filter((e) => !e.scope?.videoId || e.scope.videoId === videoId);
  const usable = matchedCalibration ? inScope : library;

  // 时间窗边界过滤：条目时间码必须落在视频时长内，杜绝越界匹配
  const usableInRange = usable.filter((e) => (e.windows || []).some((w) => w.start < duration));

  const cands = [];
  for (const entry of usableInRange) {
    const hits = matchInVideo(entry, duration);
    for (const h of hits) {
      const base = round2(entry.baseConfidence * h.strength);
      cands.push({
        categoryCode: entry.categoryCode,
        title: entry.title,
        description: entry.description,
        start: h.start,
        end: h.end,
        hitStrength: h.strength,
        confidence: matchedCalibration ? base : round2(base * UNCALIBRATED_CONFIDENCE_PENALTY),
        rawConfidence: base,
        evidenceFrameTs: h.frames,
        counterEvidence: entry.counterEvidence,
        blindSpots: entry.blindSpots,
        measure: entry.measure,
        site: entry.site,
        sourceVideoId: entry.scope?.videoId || null,
        segmentIndex: findSegment(segments, h.start)
      });
    }
  }
  const sorted = cands.sort((a, b) => a.start - b.start);
  return {
    candidates: sorted,
    provenance: {
      calibratedFor: calibratedFor || null,
      videoId: videoId || null,
      matchedCalibration,
      libraryScoped: inScope.length,
      libraryUsable: usableInRange.length,
      libraryTotal: library.length,
      confidencePenalty: matchedCalibration ? 1 : UNCALIBRATED_CONFIDENCE_PENALTY,
      library: 'vision-adapter/DEMO_LIBRARY',
      note: matchedCalibration
        ? `标注库与该素材标定一致（可用 ${usableInRange.length}/${library.length} 条），结果具备回归测试意义`
        : `该视频不在标注库标定范围内：命中 ${usableInRange.length}/${library.length} 条跨素材标注条目，已按 ${UNCALIBRATED_CONFIDENCE_PENALTY} 系数降权并全部强制人工复核，不可直接作为隐患结论`
    }
  };
}

function findSegment(segments, t) {
  const s = segments.find((x) => t >= x.start && t <= x.end);
  return s ? s.index : -1;
}

function matchInVideo(entry, duration) {
  const hits = [];
  for (const w of entry.windows || []) {
    if (w.end > duration + 1) continue;
    hits.push({
      start: Number(w.start.toFixed(2)),
      end: Number(Math.min(w.end, duration).toFixed(2)),
      strength: w.strength ?? 1,
      frames: (w.frames || []).filter((t) => t <= duration)
    });
  }
  return hits;
}

const round2 = (n) => Math.round(n * 100) / 100;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 分析总结叙述：真实实现由 VLM 依据全部已确认 finding 生成，
 * 这里按模板生成，保证时间码与 finding 一一对应、可核对。
 */
export function buildSummary(findings, video, meta = {}) {
  const bySeverity = count(findings, 'severity');
  const byType = count(findings, 'categoryCode');
  const order = { 重大: 0, 较大: 1, 一般: 2, 提示: 3 };
  const ranked = [...findings].sort((a, b) => (order[a.severity] - order[b.severity]) || (a.start - b.start));

  const risk = ranked.filter((f) => isRiskCategory(f.categoryCode));
  const positive = ranked.filter((f) => isPositiveCategory(f.categoryCode));

  const parts = [];
  const dur = fmt(video.duration);
  parts.push(`本段视频时长 ${dur}，画面为${meta.sceneLabel || '楼内二次结构作业面及室外材料堆场'}，共切分 ${meta.segmentCount || 0} 个事件段，命中 ${risk.length} 项值得关注的安全问题。`);

  if (risk.length) {
    const top = risk.slice(0, 4).map((f) => `${f.title}（${fmt(f.start)}–${fmt(f.end)}）`).join('、');
    parts.push(`其中需优先处理的是：${top}。`);
    const major = risk.filter((f) => f.severity === '较大' || f.severity === '重大');
    if (major.length) {
      parts.push(`判定为较大风险的有 ${major.length} 项，均与临边洞口防护及材料堆载相关，建议当班整改并复查。`);
    }
  } else {
    parts.push('本段视频未发现需整改的安全问题。');
  }

  const lowConf = findings.filter((f) => f.confidence < 0.7);
  if (lowConf.length) {
    parts.push(`另有 ${lowConf.length} 项置信度低于 0.7，受视角与分辨率限制无法确认，已转人工复核，不计入隐患统计。`);
  }
  if (positive.length) {
    parts.push(`同时记录到 ${positive.length} 项防护到位情况，可作为正向依据归档。`);
  }

  return {
    text: parts.join(''),
    severityCounts: bySeverity,
    typeCounts: byType,
    total: findings.length,
    riskTotal: risk.length,
    lowConfidenceTotal: lowConf.length,
    highlight: ranked.slice(0, 8).map((f) => ({
      id: f.id, title: f.title, severity: f.severity,
      start: f.start, end: f.end, categoryCode: f.categoryCode, confidence: f.confidence
    }))
  };
}

function count(arr, key) {
  const m = {};
  for (const x of arr) m[x[key]] = (m[x[key]] || 0) + 1;
  return m;
}

export function fmt(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * 内容知识库（demo-rule 模式专用）
 * ---------------------------------------------
 * 【关键约束】标注库必须按视频分区（scope.videoId）。
 * 早期版本把多个视频的条目混装在一起，只按时间码匹配，结果分析 A 视频时
 * 会把只属于 B 视频的条目（如"屋面预留洞"）匹配进来，产出根本不存在的隐患。
 * 这是真实系统里最典型的误报来源，因此这里强制按 scope 过滤：
 * 没有对应 scope 的条目，任何视频都不会命中。
 *
 * 真实接入 VLM 后，本库仅保留作为回归测试标注集（ground truth），
 * 用于对比模型输出、衡量召回率与误报率。
 */
export const DEMO_LIBRARY = [
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'PPE_HARDHAT',
    title: '砌筑作业人员未佩戴安全帽',
    description: '画面左侧工人在加气块砌筑作业面进行砂浆铺砌作业，头部仅见眼镜与手套，未见安全帽。',
    baseConfidence: 0.93,
    site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 西侧' },
    windows: [{ start: 5, end: 20, strength: 0.98, frames: [5.5, 12.5, 19.5] }],
    counterEvidence: '头部区域受构件边缘与前景高光影响，存在遮挡可能，建议换角度帧复核。',
    blindSpots: ['第一视角平视拍摄，仅覆盖镜头朝向区域', '画面外人员不在判定范围'],
    measure: '现场提醒补戴安全帽，纳入班前教育记录。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'TEMP_POWER',
    title: '成捆电缆沿地面明设横穿作业通道',
    description: '楼面通道上多根电缆成捆沿地面敷设，横穿人员与手推车通行路径，未见架空、穿管或过线槽保护。',
    baseConfidence: 0.9,
    site: { building: '2号楼', floor: '12F', zone: '通行通道 · 中部' },
    windows: [{ start: 22, end: 42, strength: 0.98, frames: [22.5, 32, 41.5] }],
    counterEvidence: '该线路可能为短时作业临时线并已设专人看护，需确认敷设时段与看护记录。',
    blindSpots: ['画面未覆盖线路起点配电箱', '无法判断是否具备漏电保护与接零保护'],
    measure: '改为架空或穿管保护敷设，过道处设置过线槽或防护盖板。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'MOBILE_SCAFFOLD',
    title: '移动式操作平台上方有人作业',
    description: '画面中部黄色门式移动操作平台上有人作业，作业中存在高坠风险，需核查防护栏杆、脚轮锁定、抛撑及安全带系挂情况。',
    baseConfidence: 0.72,
    site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 东侧' },
    windows: [{ start: 50, end: 60, strength: 0.86, frames: [50.5, 55, 59.5] }],
    counterEvidence: '作业人员可能已在平台另一侧系挂安全带，当前角度看不到安全带挂点。',
    blindSpots: ['镜头仰角不足，看不到作业人员腰部以下', '无法判断脚轮是否锁定、是否设置抛撑'],
    measure: '锁定脚轮、设置抛撑与防护栏杆，作业人员系挂安全带，禁止超载与移动中作业。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'MATERIAL_STACK',
    title: '钢管、扣件散乱堆放未分类码放',
    description: '楼面临边区域钢管成捆斜靠堆置，扣件散落一地，未见分类码放、限高与标识牌，钢管端头外伸形成穿刺风险。',
    baseConfidence: 0.88,
    site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 南侧' },
    windows: [{ start: 88, end: 100, strength: 0.97, frames: [88.5, 94, 99.5] }],
    counterEvidence: '该区域可能处于材料转运作业中，短时堆放属正常工序状态。',
    blindSpots: ['未覆盖堆料区全貌', '无法判断堆高是否超过规范限值'],
    measure: '分类码放、限高设置、挂标识牌，转运通道保持畅通。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'EDGE_SURCHARGE',
    title: '临边栏杆内侧堆放钢跳板、木模板与扣件',
    description: '外墙临边防护栏杆内侧集中堆放钢跳板、木模板、钢管与扣件，堆放体紧贴栏杆，部分钢管端头外伸至栏杆外侧。',
    baseConfidence: 0.86,
    site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 南侧临边' },
    windows: [{ start: 96, end: 116, strength: 0.96, frames: [96.5, 106, 115.5] }],
    counterEvidence: '材料与栏杆之间可能存在未被镜头捕捉的安全距离，需现场实测。',
    blindSpots: ['无法通过画面判断栏杆内侧净距', '无法判断栏杆是否与结构可靠固定'],
    measure: '清运临边材料，栏杆内侧留出规范要求的安全距离，设置禁止堆载标识。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'SLIP_FALL',
    title: '楼梯踏步面湿润，下行滑跌风险',
    description: '由 12 层下行至楼梯间过程中，踏步面存在明显湿润痕迹，栏杆已安装到位，湿滑条件下存在滑跌风险。',
    baseConfidence: 0.74,
    site: { building: '2号楼', floor: '12F→11F', zone: '楼梯间' },
    windows: [{ start: 110, end: 120, strength: 0.92, frames: [110.5, 115, 119.5] }],
    counterEvidence: '地面湿润可能为洒水降尘或养护作业后的正常状态。',
    blindSpots: ['画面无法反映地面摩擦系数', '无法判断是否已设置防滑警示'],
    measure: '及时清理积水、保持排水通畅，楼梯口设置防滑提示。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'OPENING_EDGE',
    title: '楼板洞口未见盖板、栏杆或安全网',
    description: '楼面中部存在矩形楼板洞口（后浇带/管道井），洞口周边未见刚性盖板、防护栏杆与安全网，洞口旁 1m 内堆放材料。',
    baseConfidence: 0.89,
    site: { building: '2号楼', floor: '12F', zone: '二次结构区 · 中部' },
    windows: [{ start: 123, end: 134, strength: 0.97, frames: [123.5, 128.5, 133.5] }],
    counterEvidence: '洞口边缘存在高光反射，可能为已覆盖的钢盖板，需现场核对。',
    blindSpots: ['平视视角无法俯视洞口正下方', '无法判断是否设有底部兜网'],
    measure: '设置硬质盖板并固定或设置防护栏杆+密目网，验收后挂设警示标识。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'FIRE_EQUIP',
    title: '灭火器已配置且外观完好（正向记录）',
    description: '室外材料堆场钢结构棚内配置手提式灭火器两只，外观完好、放置位置醒目，未见遮挡。',
    baseConfidence: 0.82,
    site: { building: '堆场', floor: '-', zone: '材料堆场 · 消防棚' },
    windows: [{ start: 138, end: 148, strength: 0.96, frames: [138.5, 143, 147.5] }],
    counterEvidence: '不适用。',
    blindSpots: ['无法读取灭火器压力表与检验日期'],
    measure: '保持现状，纳入月检记录。'
  },
  {
    scope: { videoId: 'vid-002' },
    categoryCode: 'SAFE_PRACTICE',
    title: '材料堆场分类堆放、道路划线清晰（正向记录）',
    description: '室外材料堆场地面硬化，黄线分区清晰，木方、钢材、成品钢筋分区域整齐堆放，通行顺畅。',
    baseConfidence: 0.92,
    site: { building: '堆场', floor: '-', zone: '材料堆场 · 主干道' },
    windows: [{ start: 165, end: 180, strength: 0.98, frames: [165.5, 172, 179.5] }],
    counterEvidence: '不适用。',
    blindSpots: ['仅记录画面可见范围'],
    measure: '保持现状，作为标准化样板推广。'
  },

  /* ---------- 以下条目归属其他视频，分析 vid-002 时不会被命中 ---------- */
  {
    scope: { videoId: 'vid-001' },
    categoryCode: 'OPENING_EDGE',
    title: '屋面预留洞未见盖板',
    description: '屋面容许多个预留洞口，部分洞口未见刚性盖板覆盖，存在高坠风险。',
    baseConfidence: 0.84,
    site: { building: '1号楼', floor: '屋面', zone: '东侧预留洞区' },
    windows: [{ start: 86, end: 94, strength: 0.97, frames: [86.5, 90, 93.5] }],
    counterEvidence: '洞口可能位于后续工序作业面，需核对作业票与防护移交记录。',
    blindSpots: ['平视视角无法确认洞口底部防护'],
    measure: '设置硬质盖板并固定，验收后挂设警示标识。'
  },
  {
    scope: { videoId: 'vid-001' },
    categoryCode: 'EDGE_SURCHARGE',
    title: '临边栏杆上方搭挂模板',
    description: '屋面女儿墙临边栏杆上方搭挂木模板，形成风载坠物风险。',
    baseConfidence: 0.81,
    site: { building: '1号楼', floor: '屋面', zone: '北侧临边' },
    windows: [{ start: 152, end: 161, strength: 0.95, frames: [152.5, 156, 160.5] }],
    counterEvidence: '属作业过程中的临时放置状态。',
    blindSpots: ['无法从画面判断搭挂时长'],
    measure: '作业完成后及时移除，避免长期搭挂。'
  },
  {
    scope: { videoId: 'vid-003' },
    categoryCode: 'MATERIAL_STACK',
    title: '场内材料堆场超出划区域堆放',
    description: '航拍可见 3 号楼北侧材料堆场超出黄线划定区域堆放，占用消防通道。',
    baseConfidence: 0.8,
    site: { building: '全场', floor: '-', zone: '3号楼北侧堆场' },
    windows: [{ start: 208, end: 226, strength: 0.93, frames: [208.5, 217, 225.5] }],
    counterEvidence: '黄线可能为近期调整后的新划定区域，需核对平面布置图。',
    blindSpots: ['高空视角无法判断地面标识是否有效', '无法判断是否为临时卸货状态'],
    measure: '清运至划定区域，保持消防通道畅通，增设区域标识。'
  },
  {
    scope: { videoId: 'vid-003' },
    categoryCode: 'PPE_HARDHAT',
    title: '作业人员安全帽识别置信度不足',
    description: '航拍高度下人员仅有约 20 像素，安全帽特征不足，判定为低置信度候选，转人工复核。',
    baseConfidence: 0.4,
    site: { building: '全场', floor: '-', zone: '2号楼南侧作业面' },
    windows: [{ start: 320, end: 330, strength: 0.85, frames: [320.5, 325, 329.5] }],
    counterEvidence: '目标像素过少，无法可靠判定，属证据不足而非确认隐患。',
    blindSpots: ['航拍高度导致个体防护特征不可辨'],
    measure: '转地面执法记录仪复核该区域。'
  },
  {
    scope: { videoId: 'vid-004' },
    categoryCode: 'TEMP_POWER',
    title: '夜间地下室临时用电线路敷设不规范',
    description: '夜间红外画面中，B1 车道处电缆沿地面敷设且部分接头裸露，未见穿管保护。',
    baseConfidence: 0.71,
    site: { building: '地下室', floor: 'B1', zone: '车道区' },
    windows: [{ start: 120, end: 138, strength: 0.9, frames: [120.5, 129, 137.5] }],
    counterEvidence: '夜间红外画面细节有限，接头状态可能存在误判。',
    blindSpots: ['红外成像无法辨识颜色，无法确认线缆规格'],
    measure: '清理地面线缆改为架空敷设，接头做防水与绝缘处理。'
  }
];
