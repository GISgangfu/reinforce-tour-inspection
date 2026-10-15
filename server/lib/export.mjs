/**
 * 安全巡检视频处理 · 报告导出
 * ------------------------------------------------------------------
 * 安全管理人员最终要交出去的不是界面截图，而是三类正式文书：
 *   1. 隐患整改通知单（最常用，需要签字与闭环跟踪）
 *   2. 巡检记录表（台账留档）
 *   3. 隐患明细表（Excel，供后续统计与上报）
 *
 * 实现说明：
 *  - HTML 报告带打印样式，浏览器直接「打印 → 另存为 PDF」即可，不引入 PDF 库。
 *  - Excel 采用 SpreadsheetML 2003（XML）格式，Excel 可直接打开，
 *    避免引入 xlsx 依赖；UTF-8 中文正常。
 *  - 所有导出都强制带「证据时间码」，无时间码的条目不允许出现在正式文书里。
 */
import { CATEGORY_BY_CODE, SEVERITY_ORDER, isRiskCategory, isPositiveCategory } from './taxonomy.mjs';

/* ============================ 公共工具 ============================ */

const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
};
const x = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 筛选出可进入正式文书的条目：必须确认过或至少有待复核状态且有证据时间码 */
function selectFindings(findings, opts = {}) {
  let arr = [...findings];
  if (!opts.includeRejected) arr = arr.filter((f) => f.reviewStatus !== 'rejected');
  if (opts.onlyConfirmed) arr = arr.filter((f) => f.reviewStatus === 'confirmed');
  if (opts.excludePositive) arr = arr.filter((f) => isRiskCategory(f.categoryCode));
  // 硬约束：没有证据时间码与帧的条目不允许进正式文书
  arr = arr.filter((f) => Number.isFinite(f.start) && (f.evidence?.frames?.length || 0) > 0);
  arr.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.start - b.start);
  return arr;
}

const SEV_CLS = { 重大: 'sev-critical', 较大: 'sev-major', 一般: 'sev-normal', 提示: 'sev-info' };
const REVIEW_TEXT = { pending: '待复核', confirmed: '已确认', rejected: '已排除', revised: '已修正' };

function evidenceHtml(f) {
  const frames = f.evidence?.frames || [];
  return `<div class="ev">${frames.slice(0, 3).map((fr) =>
    `<figure><img src="/${x(fr.src)}" alt="证据帧"><figcaption>${fmtTime(fr.t)}</figcaption></figure>`).join('')}</div>`;
}

function baseCss() {
  return `
  *{box-sizing:border-box}
  body{font:13.5px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#111;margin:0;padding:26px 30px;background:#fff}
  h1{font-size:21px;margin:0 0 4px;text-align:center;letter-spacing:2px}
  .sub{text-align:center;color:#666;font-size:12px;margin-bottom:18px}
  .doc-meta{display:flex;justify-content:space-between;font-size:12px;color:#444;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12.5px}
  th,td{border:1px solid #999;padding:6px 8px;vertical-align:top;text-align:left}
  th{background:#f0f2f5;font-weight:600;white-space:nowrap}
  .kv td:first-child{background:#f7f8fa;width:110px;white-space:nowrap;color:#333}
  .finding{border:1px solid #bbb;border-radius:4px;padding:11px 13px;margin-bottom:12px;page-break-inside:avoid}
  .f-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px}
  .f-no{background:#111;color:#fff;font-weight:700;padding:1px 8px;border-radius:3px;font-size:12px}
  .f-title{font-weight:700;font-size:14px}
  .tag{font-size:11.5px;padding:1px 7px;border-radius:10px;border:1px solid #999;color:#333}
  .sev-critical{background:#ffe5e3;border-color:#d33;color:#a11}
  .sev-major{background:#fff2e0;border-color:#e80;color:#a50}
  .sev-normal{background:#fffbe0;border-color:#ca0;color:#860}
  .sev-info{background:#e8f2ff;border-color:#48a;color:#246}
  .mono{font-family:Consolas,monospace}
  .ev{display:flex;gap:8px;margin:8px 0}
  .ev figure{margin:0;flex:1}
  .ev img{width:100%;border:1px solid #999;border-radius:3px;display:block}
  .ev figcaption{font-size:11px;color:#666;text-align:center;margin-top:2px;font-family:Consolas,monospace}
  .box{border-left:3px solid #666;background:#f7f8fa;padding:7px 10px;margin:6px 0;font-size:12.5px}
  .box.counter{border-left-color:#e80;background:#fff8ee}
  .box.blind{border-left-color:#c60;background:#fffaf0}
  .box b{display:block;font-size:11.5px;color:#555;margin-bottom:2px}
  .summary{border:1px solid #bbb;background:#fafbfc;padding:11px 13px;border-radius:4px;margin:12px 0;line-height:1.85}
  .sign{display:flex;gap:40px;margin-top:26px;font-size:13px}
  .sign div{flex:1;border-top:1px solid #333;padding-top:6px;color:#444}
  .foot{margin-top:20px;font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:8px;display:flex;justify-content:space-between}
  .notice{margin:14px 0;line-height:2}
  .notice td{height:26px}
  @media print{body{padding:0} .noprint{display:none} @page{margin:14mm}}
  `;
}

function docShell({ title, subtitle, meta, body, generatedAt }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${x(title)}</title><style>${baseCss()}</style></head><body>
<h1>${x(title)}</h1>
<div class="sub">${x(subtitle || '')}</div>
<div class="doc-meta"><span>${meta}</span><span>生成时间 ${x(generatedAt)}</span></div>
${body}
<div class="foot">
  <span>安全巡检视频处理 · 安全巡检视频智能分析平台</span>
  <span>本文件由系统根据巡检视频 AI 打标结果生成，所有条目均可回溯至原始视频时间码</span>
</div>
</body></html>`;
}

/* ==================== 1. 隐患整改通知单 ==================== */

export function buildRectificationOrder({ video, device, findings, summary, history, generatedAt, issuedBy = '项目安全部' }) {
  const items = selectFindings(findings, { excludePositive: true });
  if (!items.length) {
    return docShell({
      title: '隐患整改通知单',
      subtitle: '本次巡检未发现需整改的安全隐患',
      meta: '', generatedAt,
      body: `<div class="summary">本次影像巡检未发现需整改的安全隐患，特此说明。如需留档，可导出巡检记录表。</div>`
    });
  }

  const major = items.filter((f) => f.severity === '重大' || f.severity === '较大');
  const deadline = deadlineText(major.length ? '较大' : '一般');

  const body = `
  <table class="kv">
    <tr><td>工程名称</td><td>${x(video?.site || '—')}</td><td>巡检部位</td><td>${x(siteText(items))}</td></tr>
    <tr><td>巡检方式</td><td>${x(sourceText(video?.source))}${device ? `（${x(device.name)}）` : ''}</td><td>巡检时间</td><td>${x(video?.recordedAt || '—')}</td></tr>
    <tr><td>巡检人</td><td>${x(video?.operator || '—')}</td><td>视频时长</td><td>${fmtTime(video?.duration)}（${x(video?.title || '')}）</td></tr>
    <tr><td>发现问题数</td><td colspan="3">共 <b>${items.length}</b> 项，其中较大及以上 <b>${major.length}</b> 项</td></tr>
  </table>

  <p style="margin:12px 0 6px;font-weight:600">经影像巡检发现下列安全隐患，请责任单位按期限完成整改并报安全部复查：</p>

  ${items.map((f, i) => `
    <div class="finding">
      <div class="f-head">
        <span class="f-no">${String(i + 1).padStart(2, '0')}</span>
        <span class="f-title">${x(f.title)}</span>
        <span class="tag ${SEV_CLS[f.severity] || ''}">${x(f.severity)}隐患</span>
        <span class="tag mono">原始视频 ${fmtTime(f.start)}–${fmtTime(f.end)}</span>
        ${f.recurrence?.recurring ? `<span class="tag sev-critical">重复隐患（第 ${f.recurrence.count} 次）</span>` : ''}
        <span class="tag">${x(REVIEW_TEXT[f.reviewStatus] || f.reviewStatus)}</span>
      </div>
      <table class="kv" style="margin:0 0 8px">
        <tr><td>隐患部位</td><td>${x(siteOf(f))}</td><td>隐患类别</td><td>${x(f.categoryName || f.categoryCode)}</td></tr>
        <tr><td>规范依据</td><td colspan="3">${(f.basis || []).map((b) => `${x(b.code)} ${x(b.clause)}：${x(b.text)}`).join('；') || '—'}</td></tr>
        <tr><td>整改要求</td><td colspan="3">${x(f.measure || '—')}</td></tr>
        ${f.reviewNote ? `<tr><td>复核意见</td><td colspan="3">${x(f.reviewNote)}（${x(f.reviewedBy || '')} ${x(f.reviewedAt || '')}）</td></tr>` : ''}
      </table>
      <div class="box"><b>AI 判定依据</b>${x(f.description)}</div>
      <div class="box counter"><b>反证（可能误报的原因）</b>${x(f.counterEvidence || '无')}</div>
      <div class="box blind"><b>盲区声明</b>${(f.blindSpots || []).map(x).join('；') || '无'}</div>
      ${evidenceHtml(f)}
      <div style="font-size:11.5px;color:#666">证据来源：原始视频 <span class="mono">${x(video?.assetPath || '')}</span> 第 ${fmtTime(f.start)} 秒处${f.evidence?.clip ? `；证据片段 <span class="mono">${x(f.evidence.clip)}</span>` : ''}</div>
      ${f.recurrence?.recurring ? `<div class="box counter" style="margin-top:8px"><b>历史重复情况</b>${f.recurrence.history.map((h) => `${x(h.inspectedAt)}｜${x(h.note || '')}`).join('<br>')}</div>` : ''}
    </div>`).join('')}

  <table class="notice">
    <tr><td style="width:110px;background:#f7f8fa">整改责任单位</td><td></td><td style="width:96px;background:#f7f8fa">责任人</td><td></td></tr>
    <tr><td style="background:#f7f8fa">整改期限</td><td>${x(deadline)}</td><td style="background:#f7f8fa">复查人</td><td></td></tr>
    <tr><td style="background:#f7f8fa">整改要求</td><td colspan="3">按上述整改要求逐项落实，整改完成后通知安全部现场复查，复查合格后予以闭环。</td></tr>
  </table>

  <div class="sign">
    <div>签发单位（盖章）：${x(issuedBy)}<br><br>签发人：<br><br>日期：　　年　　月　　日</div>
    <div>接收单位（签收）：<br><br>签收人：<br><br>日期：　　年　　月　　日</div>
  </div>`;

  return docShell({
    title: '隐患整改通知单',
    subtitle: `${video?.site || ''} 影像巡检专项`,
    meta: `巡检视频：${x(video?.title || '')}｜共 ${items.length} 项隐患`,
    generatedAt,
    body
  });
}

function deadlineText(sev) {
  const d = new Date();
  d.setDate(d.getDate() + (sev === '较大' ? 1 : 3));
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 前`;
}

/* ==================== 2. 巡检记录表 ==================== */

export function buildInspectionRecord({ video, device, findings, summary, generatedAt }) {
  const all = [...findings].sort((a, b) => a.start - b.start);
  const risk = all.filter((f) => isRiskCategory(f.categoryCode));
  const positive = all.filter((f) => isPositiveCategory(f.categoryCode));

  const body = `
  <table class="kv">
    <tr><td>工程名称</td><td>${x(video?.site || '—')}</td><td>巡检日期</td><td>${x((video?.recordedAt || '').slice(0, 10) || '—')}</td></tr>
    <tr><td>巡检设备</td><td>${x(sourceText(video?.source))}${device ? `｜${x(device.name)}（${x(device.id)}）` : ''}</td><td>巡检人</td><td>${x(video?.operator || '—')}</td></tr>
    <tr><td>视频时长</td><td>${fmtTime(video?.duration)}</td><td>画面规格</td><td>${video?.width || '—'}×${video?.height || '—'} / ${video?.fps || '—'}fps</td></tr>
    <tr><td>AI 打标总数</td><td>${all.length} 条</td><td>其中安全隐患</td><td>${risk.length} 条</td></tr>
  </table>

  ${summary?.text ? `<div class="summary"><b>安全问题总结</b><br>${x(summary.text)}</div>` : ''}

  <p style="font-weight:600;margin:14px 0 4px">一、发现的安全隐患（按风险等级排序）</p>
  <table>
    <thead><tr>
      <th style="width:36px">序号</th><th style="width:78px">时间码</th><th style="width:52px">等级</th>
      <th style="width:136px">隐患类别</th><th style="width:220px">问题描述</th><th style="width:190px">规范依据</th>
      <th style="width:56px">置信度</th><th style="width:60px">复核状态</th>
    </tr></thead>
    <tbody>
      ${risk.length ? risk.map((f, i) => `
        <tr>
          <td>${i + 1}</td>
          <td class="mono">${fmtTime(f.start)}–${fmtTime(f.end)}</td>
          <td>${x(f.severity)}</td>
          <td>${x(f.categoryName || f.categoryCode)}${f.recurrence?.recurring ? '<br><span style="color:#a11">重复隐患</span>' : ''}</td>
          <td>${x(f.title)}<br><span style="color:#666;font-size:11.5px">${x(siteOf(f))}</span></td>
          <td style="font-size:11.5px">${(f.basis || []).map((b) => `${x(b.code)} ${x(b.clause)}`).join('<br>') || '—'}</td>
          <td class="mono">${((f.confidence || 0) * 100).toFixed(0)}%</td>
          <td>${x(REVIEW_TEXT[f.reviewStatus] || '')}</td>
        </tr>`).join('') : `<tr><td colspan="8" style="text-align:center;color:#666">未发现安全隐患</td></tr>`}
    </tbody>
  </table>

  ${risk.length ? `<p style="font-size:11.5px;color:#555;margin:4px 0 0">规范依据条款全文：<br>${risk.flatMap((f) => (f.basis || []).map((b) => `${x(b.code)} ${x(b.clause)}：${x(b.text)}`)).filter((v, i, a) => a.indexOf(v) === i).join('<br>')}</p>` : ''}

  <p style="font-weight:600;margin:16px 0 4px">二、防护到位情况（正向记录）</p>
  <table>
    <thead><tr><th style="width:36px">序号</th><th style="width:78px">时间码</th><th style="width:150px">类别</th><th>情况说明</th></tr></thead>
    <tbody>
      ${positive.length ? positive.map((f, i) => `
        <tr><td>${i + 1}</td><td class="mono">${fmtTime(f.start)}–${fmtTime(f.end)}</td>
        <td>${x(f.categoryName || '')}</td><td>${x(f.title)}</td></tr>`).join('')
        : `<tr><td colspan="4" style="text-align:center;color:#666">无正向记录</td></tr>`}
    </tbody>
  </table>

  <p style="font-weight:600;margin:16px 0 4px">三、隐患类型聚类统计</p>
  <table>
    <thead><tr><th style="width:190px">隐患类别</th><th style="width:70px">数量</th><th style="width:110px">等级</th><th>涉及时间码</th></tr></thead>
    <tbody>
      ${clusterRows(risk)}
    </tbody>
  </table>

  <div class="sign">
    <div>巡检人签字：<br><br>日期：　　年　　月　　日</div>
    <div>安全负责人审核：<br><br>日期：　　年　　月　　日</div>
  </div>`;

  return docShell({
    title: '安全巡检记录表',
    subtitle: `${video?.site || ''} · 影像巡检`,
    meta: `巡检视频：${x(video?.title || '')}｜打标 ${all.length} 条（隐患 ${risk.length} 条）`,
    generatedAt,
    body
  });
}

function clusterRows(risk) {
  const m = new Map();
  for (const f of risk) {
    if (!m.has(f.categoryCode)) m.set(f.categoryCode, { name: f.categoryName, sev: f.severity, times: [], n: 0 });
    const g = m.get(f.categoryCode);
    g.n++; g.times.push(fmtTime(f.start));
  }
  if (!m.size) return `<tr><td colspan="4" style="text-align:center;color:#666">无</td></tr>`;
  return [...m.values()].map((g) => `<tr>
    <td>${x(g.name)}</td><td>${g.n}</td><td>${x(g.sev)}</td>
    <td class="mono">${g.times.join('、')}</td></tr>`).join('');
}

/* ==================== 3. Excel（SpreadsheetML 2003） ==================== */

export function buildFindingsExcel({ video, device, findings, generatedAt }) {
  const rows = [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.start - b.start);
  const cols = ['隐患编号', '视频名称', '来源设备', '部位', '楼层', '区域', '隐患类别', '隐患等级',
    '问题描述', '起始时间码', '结束时间码', '起始秒', '置信度', '复核状态', '复核人', '复核时间', '复核意见',
    '规范依据', '整改建议', '反证', '盲区', '是否重复隐患', '重复次数', '证据片段', '证据帧数'];

  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return `<Cell><Data ss:Type="String">${x(s)}</Data></Cell>`;
  };

  const body = [
    `<Row>${cols.map((c) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${x(c)}</Data></Cell>`).join('')}</Row>`,
    ...rows.map((f) => `<Row>${[
      f.id, video?.title || '', device?.name || video?.operator || '', f.site?.building || '', f.site?.floor || '', f.site?.zone || '',
      f.categoryName || f.categoryCode, f.severity, f.title, fmtTime(f.start), fmtTime(f.end), f.start,
      `${((f.confidence || 0) * 100).toFixed(0)}%`, REVIEW_TEXT[f.reviewStatus] || '', f.reviewedBy || '', f.reviewedAt || '', f.reviewNote || '',
      (f.basis || []).map((b) => `${b.code} ${b.clause}`).join('；'), f.measure || '', f.counterEvidence || '',
      (f.blindSpots || []).join('；'), f.recurrence?.recurring ? '是' : '否', f.recurrence?.count || 0,
      f.evidence?.clip || '', (f.evidence?.frames || []).length
    ].map(cell).join('')}</Row>`)
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#DCE6F1" ss:Pattern="Solid"/></Style>
 </Styles>
 <Worksheet ss:Name="隐患明细">
  <Table>
   <Column ss:Width="88"/><Column ss:Width="150"/><Column ss:Width="130"/><Column ss:Width="70"/>
   <Column ss:Width="52"/><Column ss:Width="130"/><Column ss:Width="130"/><Column ss:Width="56"/>
   <Column ss:Width="240"/><Column ss:Width="76"/><Column ss:Width="76"/><Column ss:Width="62"/>
   <Column ss:Width="56"/><Column ss:Width="66"/><Column ss:Width="72"/><Column ss:Width="110"/>
   <Column ss:Width="180"/><Column ss:Width="180"/><Column ss:Width="200"/><Column ss:Width="200"/>
   <Column ss:Width="180"/><Column ss:Width="72"/><Column ss:Width="56"/><Column ss:Width="200"/><Column ss:Width="62"/>
   ${body}
  </Table>
 </Worksheet>
</Workbook>`;
}

/* ============================ 辅助 ============================ */

function sourceText(s) {
  return { bodycam: '执法记录仪', drone: '无人机航拍', robot: '巡检机器狗', upload: '人工上传' }[s] || '设备回传';
}
function siteOf(f) {
  const s = f.site || {};
  return [s.building, s.floor, s.zone].filter(Boolean).join(' ') || '未标注';
}
function siteText(items) {
  const set = new Set(items.map(siteOf));
  return [...set].slice(0, 4).join('；') + (set.size > 4 ? ` 等 ${set.size} 处` : '');
}

export { selectFindings, CATEGORY_BY_CODE };
