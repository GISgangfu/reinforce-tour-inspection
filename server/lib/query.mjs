/**
 * 安全巡检视频处理 · 自然语言检索意图解析
 * ------------------------------------------------------------------
 * 把安全员的口语查询解析成结构化检索条件：
 *   "帮我找视频里没戴安全帽的告警片段，要3秒的"
 *     → { categories: ['PPE_HARDHAT'], source: null, deviceType: null, severity: [], clipSeconds: 3 }
 *
 * 设计要点：不做自由生成，只做「词典 + 规则」映射。
 * 生产环境可在这一层前置一个小模型做意图抽取，但兜底必须仍是规则，
 * 保证检索结果可解释、可复现（安全场景不接受"这次检索对了下次没对"）。
 */
import { CATEGORIES, SYNONYMS, CLIP_SECONDS, SEVERITY_ORDER, isRiskCategory } from './taxonomy.mjs';

const SEVERITY_WORDS = ['重大', '较大', '一般', '提示'];
const DEVICE_WORDS = {
  drone: ['无人机', '航拍', '飞机', '航飞'],
  bodycam: ['执法记录仪', '记录仪', '随身', '安全员', '人工'],
  robot: ['机器狗', '机器人', '狗', '巡逻']
};

/** 明确表达"我要看不合规/隐患"的词 */
const NEGATIVE_HINTS = ['未', '没', '不', '无', '缺', '违规', '隐患', '问题', '不合格', '不合规', '违章', '告警', '异常', '风险'];
/** 明确表达"我要看合规/正向"的词 */
const POSITIVE_HINTS = ['规范', '合规', '到位', '合格', '正确', '良好', '正向', '做得好'];

export function parseQuery(raw, opts = {}) {
  const q = String(raw || '').trim();
  const lower = q.toLowerCase();
  const tokens = tokenize(lower);

  // 1) 检查项匹配：按同义词命中数排序，取最佳
  const scored = CATEGORIES.map((cat) => {
    const syns = SYNONYMS[cat.code] || [];
    let score = 0;
    const hits = [];
    for (const s of syns) {
      if (!s) continue;
      if (lower.includes(s.toLowerCase())) {
        // 长词权重更高（"安全帽" 优于 "帽"）
        score += 1 + s.length * 0.35;
        hits.push(s);
      }
    }
    return { cat, score, hits };
  }).filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const wantsPositive = POSITIVE_HINTS.some((w) => lower.includes(w));
  const wantsNegative = NEGATIVE_HINTS.some((w) => lower.includes(w));

  let categories = [];
  let matchReason = '';

  if (scored.length) {
    if (wantsNegative && !wantsPositive) {
      // 负向查询：排除正向记录类检查项（口径统一走 isRiskCategory）
      const negativeCodes = scored.filter((s) => isRiskCategory(s.cat.code)).map((s) => s.cat.code);
      categories = negativeCodes.length ? negativeCodes : scored.map((s) => s.cat.code);
    } else if (wantsPositive) {
      categories = scored.map((s) => s.cat.code);
    } else {
      categories = scored.map((s) => s.cat.code);
    }
    matchReason = `命中检查项关键词：${scored[0].hits.join('、')}`;
  } else if (wantsNegative) {
    // 只说了"隐患/不合规"，未指定类型 → 返回全部隐患类别，由结果排序决定
    categories = CATEGORIES.filter((c) => isRiskCategory(c.code)).map((c) => c.code);
    matchReason = '未指定隐患类型，返回全部隐患类别';
  } else if (wantsPositive) {
    categories = ['SAFE_PRACTICE', 'FIRE_EQUIP'];
    matchReason = '未指定正向类别，返回正向记录';
  }

  // 2) 等级过滤
  const severity = SEVERITY_WORDS.filter((s) => q.includes(s));

  // 3) 设备类型过滤
  let deviceType = null;
  for (const [type, words] of Object.entries(DEVICE_WORDS)) {
    if (words.some((w) => lower.includes(w.toLowerCase()))) { deviceType = type; break; }
  }

  // 4) 片长：默认 3 秒，可被查询覆盖（3s/3秒/5秒…）
  let clipSeconds = CLIP_SECONDS;
  const secMatch = /(\d{1,2})\s*(?:s|S|秒)/.exec(q);
  if (secMatch) clipSeconds = Math.max(2, Math.min(30, Number(secMatch[1])));

  // 5) 时间窗口："最后5分钟""最近10分钟" 之类只在有实时流时有意义，这里解析出来供上层使用
  let recentMinutes = null;
  const minMatch = /(?:最近|最后|近)\s*(\d{1,3})\s*(?:分钟|min)/.exec(q);
  if (minMatch) recentMinutes = Number(minMatch[1]);

  // 6) 地点/楼栋过滤
  const siteMatch = /(\d+号楼|屋面|地下室|堆场|楼梯间|楼层)/.exec(q);
  const siteKeyword = siteMatch ? siteMatch[1] : null;

  // 7) 复核状态过滤："还没复核""待复核""已确认"
  let pendingOnly = null;
  if (/(没|未|待|尚未).{0,2}复核/.test(q)) pendingOnly = true;
  else if (/(已|已经).{0,2}(确认|复核|核验)/.test(q)) pendingOnly = false;

  return {
    raw: q,
    categories,
    severity,
    deviceType,
    siteKeyword,
    clipSeconds,
    recentMinutes,
    pendingOnly,
    wantsNegative: wantsNegative && !wantsPositive,
    wantsPositive,
    matchReason: matchReason || '未命中检查项关键词，将按全文相似度检索',
    tokens
  };
}

function tokenize(s) {
  // 轻量中文切分：连续中文按 2-gram，英文数字按词
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9]+|[\u4e00-\u9fa5]+/g)) {
    const seg = m[0];
    if (/^[a-z0-9]+$/.test(seg)) { out.add(seg); continue; }
    for (let i = 0; i < seg.length; i++) {
      out.add(seg[i]);
      if (i + 1 < seg.length) out.add(seg.slice(i, i + 2));
    }
  }
  return [...out];
}

/** 对单条 finding 计算与查询的相关度得分（用于排序与兜底检索） */
export function scoreFinding(finding, intent) {
  let score = 0;
  const hay = `${finding.title} ${finding.description} ${finding.site?.zone || ''} ${finding.categoryCode}`.toLowerCase();

  if (intent.categories.includes(finding.categoryCode)) score += 50;

  // 同义词文本命中
  const syns = SYNONYMS[finding.categoryCode] || [];
  for (const s of syns) if (s && intent.raw.toLowerCase().includes(s.toLowerCase())) score += 6;

  // 标题字符重合（兜底）
  const qChars = new Set(intent.raw.replace(/[a-z0-9\s，。？！,.]/gi, ''));
  let overlap = 0;
  for (const ch of new Set(finding.title)) if (qChars.has(ch)) overlap++;
  score += overlap * 1.2;

  if (intent.severity.length) score += intent.severity.includes(finding.severity) ? 12 : -8;
  if (intent.siteKeyword && hay.includes(intent.siteKeyword)) score += 10;
  if (intent.wantsNegative && finding.categoryCode === 'SAFE_PRACTICE') score -= 30;
  if (intent.wantsPositive && finding.categoryCode === 'SAFE_PRACTICE') score += 20;

  // 置信度微调：同分时高置信度优先
  score += (finding.confidence || 0) * 2;
  return score;
}

export { SEVERITY_ORDER };
