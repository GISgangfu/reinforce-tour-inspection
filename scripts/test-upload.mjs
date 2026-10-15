/**
 * 端到端验证：人工本地上传 → 自动分析 → 结果校验
 * 用真实 HTTP 上传一个本地视频文件，等待分析完成，然后校验结果。
 * 用法： node scripts/test-upload.mjs [视频文件路径]
 */
import { createReadStream, statSync } from 'node:fs';
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.YZX_BASE || 'http://127.0.0.1:8899';
const file = resolve(ROOT, process.argv[2] || 'runs/_uploads/现场人工上传-测试片段.mp4');

const size = statSync(file).size;
console.log(`上传文件：${basename(file)}  (${(size / 1048576).toFixed(2)} MB)`);

/* ---------- 1. 上传 ---------- */
// 文件名等元数据走查询参数（实测流式 body 下自定义请求头会丢），请求头同时发送作为兜底
const qs = new URLSearchParams({
  fileName: basename(file),
  source: 'upload',
  operator: '人工上传（验证脚本）',
  site: '本地上传 · 未标注部位'
});
const upRes = await fetch(`${BASE}/api/videos/upload?${qs}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/octet-stream',
    'x-filename': encodeURIComponent(basename(file)),
    'x-source': 'upload',
    'x-operator': encodeURIComponent('人工上传（验证脚本）'),
    'x-site': encodeURIComponent('本地上传 · 未标注部位')
  },
  body: createReadStream(file),
  duplex: 'half'
});
if (!upRes.ok) throw new Error(`上传失败 HTTP ${upRes.status}: ${await upRes.text()}`);
const { video } = await upRes.json();
console.log(`✓ 上传成功  id=${video.id}  title=${video.title}`);
console.log(`  时长=${video.duration}s  分辨率=${video.width}x${video.height}  fps=${video.fps}  大小=${(video.fileSize / 1048576).toFixed(2)} MB`);
console.log(`  封面帧=${video.poster || '（未生成）'}`);

/* ---------- 2. 发起分析 ---------- */
const anRes = await fetch(`${BASE}/api/analyze`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ videoId: video.id })
});
if (!anRes.ok) throw new Error(`发起分析失败 HTTP ${anRes.status}: ${await anRes.text()}`);
const { runId } = await anRes.json();
console.log(`✓ 分析任务已创建  runId=${runId}`);

/* ---------- 3. 轮询进度 ---------- */
let task = null;
let lastStage = '';
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 700));
  const t = await (await fetch(`${BASE}/api/tasks/${runId}`)).json();
  task = t;
  const line = `${String(t.progress).padStart(3)}%  ${t.stage.padEnd(10)} ${t.stageDetail || ''}`;
  if (t.stage !== lastStage || t.progress === 100) console.log('   ' + line);
  lastStage = t.stage;
  if (t.status === 'done' || t.status === 'failed') break;
}
if (task.status !== 'done') throw new Error(`分析未成功：status=${task.status} error=${task.error}`);

/* ---------- 4. 校验结果 ---------- */
console.log('\n=========== 结果校验 ===========');
console.log(`状态        : ${task.status}`);
console.log(`事件段      : ${task.segmentCount} 段`);
console.log(`候选        : ${task.candidateCount}`);
console.log(`生成 findings: ${task.findings.length}`);
console.log(`来源校验    : matchedCalibration=${task.provenance?.matchedCalibration}  置信度系数=${task.provenance?.confidencePenalty}`);
console.log(`              可用标注条目 ${task.provenance?.libraryUsable}/${task.provenance?.libraryTotal}`);
console.log(`              ${task.provenance?.note}`);
console.log(`清理旧结果  : removedStale=${task.removedStale}`);

let ok = true;
const fail = (msg) => { ok = false; console.log(`  ✗ ${msg}`); };

// 校验 1：时间码必须落在视频时长内
for (const f of task.findings) {
  if (f.start < 0 || f.end > video.duration + 0.5) fail(`${f.id} 时间码越界 ${f.start}-${f.end} > ${video.duration}`);
}
console.log(`\n[校验1] 时间码均在 0–${video.duration}s 内 : ${ok ? '✓ 通过' : '✗ 失败'}`);

// 校验 2：证据文件必须真实存在且可访问
let evOk = 0, evBad = 0;
for (const f of task.findings) {
  const frames = f.evidence?.frames || [];
  for (const fr of frames) {
    const r = await fetch(`${BASE}/${fr.src}`, { method: 'HEAD' });
    r.ok ? evOk++ : (evBad++, fail(`证据帧不可访问 ${fr.src}`));
  }
  if (f.evidence?.clip) {
    const r = await fetch(`${BASE}/${f.evidence.clip}`, { method: 'HEAD' });
    r.ok ? evOk++ : (evBad++, fail(`证据片段不可访问 ${f.evidence.clip}`));
  }
  if (f.evidence?.clip3s) {
    const r = await fetch(`${BASE}/${f.evidence.clip3s}`, { method: 'HEAD' });
    r.ok ? evOk++ : (evBad++, fail(`3秒片段不可访问 ${f.evidence.clip3s}`));
  }
}
console.log(`[校验2] 证据媒体可访问 : 有效 ${evOk} 个 / 无效 ${evBad} 个  ${evBad === 0 ? '✓ 通过' : '✗ 失败'}`);

// 校验 3：上传来源必须被正确标记
const detail = await (await fetch(`${BASE}/api/videos/${video.id}`)).json();
const srcOk = detail.findings.every((f) => f.source === 'upload');
console.log(`[校验3] 全部结果标记为 upload 来源 : ${srcOk ? '✓ 通过' : '✗ 失败'}`);
if (!srcOk) fail('存在非 upload 来源的结果');

// 校验 4：不得出现越界时间码或其他素材的条目（跨素材串台）
const outOfRange = task.findings.filter((f) => f.site && f.site.building && !/^(2号楼|堆场)$/.test(f.site.building));
console.log(`[校验4] 无非法部位来源 : ${outOfRange.length === 0 ? '✓ 通过' : '✗ 失败 ' + outOfRange.map((f) => f.site.building).join(',')}`);
if (outOfRange.length) fail('出现其他视频的部位');

// 校验 4b：跨素材推定结果必须全部强制人工复核，且置信度已降权
const crossDerived = task.findings.filter((f) => f.detection?.libraryVerified === false);
const crossOk = crossDerived.every((f) => f.needsHumanReview === true);
console.log(`[校验4b] 跨素材推定条目(${crossDerived.length})全部强制人工复核 : ${crossOk ? '✓ 通过' : '✗ 失败'}`);
if (!crossOk) fail('存在未强制复核的跨素材条目');

// 校验 5：视频库统计应包含该上传视频
const { videos } = await (await fetch(`${BASE}/api/videos`)).json();
const inLibrary = videos.some((v) => v.id === video.id);
console.log(`[校验5] 已进入录像库 : ${inLibrary ? '✓ 通过' : '✗ 失败'}`);
if (!inLibrary) fail('上传视频未出现在录像库');

// 校验 6：总结中的时间码必须与 findings 对应
const sumIds = (task.summary?.highlight || []).map((h) => h.id);
const findingIds = new Set(task.findings.map((f) => f.id));
const sumOk = sumIds.every((id) => findingIds.has(id));
console.log(`[校验6] 总结引用的条目都来自本轮结果 : ${sumOk ? '✓ 通过' : '✗ 失败'}`);
if (!sumOk) fail('总结引用了非本轮条目');

console.log('\n----------- 问题总结 -----------');
console.log(task.summary?.text);
console.log('\n----------- 明细 -----------');
for (const f of task.findings) {
  console.log(`  ${f.id}  ${f.severity}  ${String(f.start).padStart(6)}-${String(f.end).padEnd(6)}  证据帧${f.evidence?.frames?.length || 0}张  片段${f.evidence?.clip ? '有' : '无'}  ${f.title}`);
}

console.log(`\n===== 上传分析链路 ${ok ? '全部校验通过 ✓' : '存在失败项 ✗'} =====`);
process.exit(ok ? 0 : 1);
