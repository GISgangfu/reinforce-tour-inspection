/**
 * 诊断脚本：确认服务真的可用（不是"端口有响应"就算数）
 * 用法： node scripts/doctor.mjs [port]
 *
 * 说明：启用访问控制后，/api/health 无凭据只返回最小存活证明。
 * 想连业务统计一起体检，请带上访问码：
 *   $env:YZX_TOKEN="你的访问码"; node scripts/doctor.mjs 8899
 * 其它接口（dashboard/videos/...）必须有凭据才能检查。
 */
import { SERVICE_ID } from '../server/config.mjs';

const PORT = Number(process.argv[2]) || 8899;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = process.argv[3] || process.env.YZX_TOKEN || '';
const authHeaders = TOKEN ? { 'x-yzx-token': TOKEN } : {};
let fail = 0;
const ok = (n, c, d = '') => { if (!c) fail++; console.log(`${c ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`); };

console.log(`安全巡检视频处理 · 可用性诊断  ${BASE}${TOKEN ? '  （已带访问码）' : ''}`);
console.log('─'.repeat(46));

/* 1. 健康检查 + 身份校验：必须确认是本平台，而不是别的服务占了端口 */
let health = null;
try {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000), headers: authHeaders });
  health = await r.json();
  ok('HTTP /api/health 可达', r.ok, `HTTP ${r.status}`);
  ok('端口身份正确（是本平台，不是其它服务）',
    health?.service === SERVICE_ID && health?.vision?.mode != null,
    health?.service ? `该端口服务标识：${health.service}${health.service === SERVICE_ID ? '' : ' ← 不是本平台'}` : '缺少 service 字段');
} catch (e) {
  ok('HTTP /api/health 可达', false, e.message);
  console.log('\n服务未响应。可能原因：');
  console.log('  · 进程已退出 —— 执行 node scripts/serve.mjs --status 查看');
  console.log('  · 端口被别的服务占用 —— 换端口： node scripts/serve.mjs --port 9001');
  process.exit(1);
}

/* 2. 前端资源 */
for (const [label, path] of [['入口页面', '/'], ['主脚本', '/web/js/main.js'], ['样式表', '/web/styles.css'], ['图标', '/web/favicon.svg']]) {
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(4000), headers: authHeaders });
    const t = await r.text();
    // 未带访问码时，页面/脚本会被换成登录页，这属于"访问控制生效"而非故障
    const gated = !TOKEN && r.status === 200 && t.includes('访问验证');
    let extra = '';
    if (gated) extra = '访问控制生效（未带访问码，返回登录页）';
    else if (path === '/web/js/main.js') extra = t.includes('ROUTES') ? '内容校验通过' : '内容异常';
    ok(`${label} ${path}`, gated || (r.ok && t.length > 0), extra);
  } catch (e) { ok(`${label} ${path}`, false, e.message); }
}

/* 3. 关键接口（启用访问控制后必须带凭据） */
const apis = ['/api/dashboard', '/api/videos', '/api/findings', '/api/devices', '/api/alerts', '/api/categories'];
if (!TOKEN) {
  console.log('○ 跳过业务接口检查：未提供访问码（设置 YZX_TOKEN 或作为第 3 个参数传入访问码）');
} else {
  for (const p of apis) {
    try {
      const r = await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(6000), headers: authHeaders });
      const j = await r.json();
      ok(`接口 ${p}`, r.ok && j && typeof j === 'object', `HTTP ${r.status}`);
    } catch (e) { ok(`接口 ${p}`, false, e.message); }
  }
}

/* 4. 视频 Range 请求（浏览器拖动进度条依赖） */
try {
  const r = await fetch(`${BASE}/assets/video/2.mp4`, { headers: { ...authHeaders, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(6000) });
  const buf = await r.arrayBuffer();
  if (!TOKEN && r.status === 200) {
    ok('视频 Range 请求（进度条拖动依赖）', true, '未带访问码被拦到登录页（预期行为）');
  } else {
    ok('视频 Range 请求（进度条拖动依赖）', r.status === 206 && buf.byteLength === 1024,
      `HTTP ${r.status} 返回 ${buf.byteLength} 字节`);
  }
} catch (e) { ok('视频 Range 请求', false, e.message); }

/* 5. 真实媒体文件是否存在 */
const media = ['/assets/video/2.mp4', '/assets/clips/F-002-001_3s.mp4', '/assets/shots/F-002-001_01.jpg'];
if (!TOKEN) {
  console.log('○ 跳过媒体文件检查：未提供访问码');
} else {
  for (const p of media) {
    try {
      const r = await fetch(`${BASE}${p}`, { method: 'HEAD', signal: AbortSignal.timeout(5000), headers: authHeaders });
      ok(`媒体 ${p}`, r.ok, `HTTP ${r.status}`);
    } catch (e) { ok(`媒体 ${p}`, false, e.message); }
  }
}

/* 6. 导出文书 */
try {
  const r = await fetch(`${BASE}/api/export?kind=rectify&videoId=vid-002`, { signal: AbortSignal.timeout(8000), headers: authHeaders });
  if (!TOKEN && r.status === 401) {
    ok('导出整改单', true, '未带访问码返回 401（预期行为）');
  } else {
    const t = await r.text();
    ok('导出整改单', r.ok && t.includes('隐患整改通知单'), `${(Buffer.byteLength(t) / 1024).toFixed(1)} KB`);
  }
} catch (e) { ok('导出整改单', false, e.message); }

console.log('─'.repeat(46));
if (health?.counts) {
  console.log(`数据：视频 ${health.counts.videos} / 打标 ${health.counts.findings} / 设备 ${health.counts.devices} / 告警 ${health.counts.alerts}`);
} else if (!TOKEN) {
  console.log('数据：未带访问码，仅有最小存活证明（带 YZX_TOKEN 可查看业务统计）');
}
console.log(`适配器：${health?.vision?.mode}`);
console.log(fail ? `\n✗ ${fail} 项异常，请查看日志 runs/_runtime/server.err.log` : `\n✓ 全部检查通过，可直接在浏览器打开 ${BASE}`);
process.exit(fail ? 1 : 0);
