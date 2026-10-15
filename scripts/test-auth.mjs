/**
 * 验证对外访问的访问控制是否真的拦得住、又放得通。
 * 用法： node scripts/test-auth.mjs [port] [token]
 */
const PORT = Number(process.argv[2]) || 8899;
const TOKEN = process.argv[3] || process.env.YZX_TOKEN || '';
const BASE = `http://127.0.0.1:${PORT}`;

let fail = 0;
const ok = (n, c, d = '') => { if (!c) fail++; console.log(`${c ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`); };

const req = async (path, opts = {}) => {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opts });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, headers: r.headers, text, json };
};

console.log(`访问控制验证  ${BASE}   访问码: ${TOKEN ? TOKEN.slice(0, 6) + '…' : '（未提供）'}`);
console.log('─'.repeat(52));

if (!TOKEN) {
  console.log('未提供访问码，只做"未启用访问控制"的验证。');
  const r = await req('/api/dashboard');
  ok('未启用时本机可直接访问', r.status === 200, `HTTP ${r.status}`);
  console.log(`\n${fail ? '✗ 存在失败项' : '✓ 通过'}`);
  process.exit(fail ? 1 : 0);
}

/* 1. 无凭据访问：必须被拦住 */
{
  const r = await req('/api/dashboard');
  ok('无访问码访问 API 被拒绝', r.status === 401, `HTTP ${r.status}`);
  ok('被拒绝时返回明确提示', !!(r.json?.error), r.json?.error || '');
}
{
  const r = await req('/');
  ok('无访问码访问首页返回登录页', r.status === 200 && r.text.includes('访问验证'), `HTTP ${r.status}`);
  // 登录页只能是"壳"，不得泄露任何业务内容（用一个只属于主界面的文案做哨兵）
  ok('登录页不含业务数据', !r.text.includes('总览看板') && !r.text.includes('告警复核'), '');
}

/* 2. 错误访问码：必须被拦住，且不能泄露任何数据 */
{
  const r = await req('/api/dashboard', { headers: { 'x-yzx-token': 'wrong-token-123456' } });
  ok('错误访问码被拒绝', r.status === 401, `HTTP ${r.status}`);
}
{
  const r = await req('/?token=wrong-token-123456');
  ok('错误访问码返回登录页并提示错误', r.text.includes('访问码不正确'));
}

/* 3. 正确访问码：必须放行 */
let cookie = '';
{
  const r = await req(`/?token=${TOKEN}`);
  ok('URL 带正确访问码可进入', r.status === 200 && r.text.includes('安全巡检视频处理'), `HTTP ${r.status}`);
  const sc = r.headers.get('set-cookie') || '';
  ok('进入后下发 Cookie（便于刷新免带码）', sc.includes('yzx_token') && sc.includes('HttpOnly'), sc.split(';')[0]);
  cookie = sc.split(';')[0];
}
{
  const r = await req('/api/dashboard', { headers: { 'x-yzx-token': TOKEN } });
  ok('请求头带访问码可访问 API', r.status === 200 && r.json?.kpi, `HTTP ${r.status}`);
}
{
  const r = await req('/api/dashboard', { headers: { cookie } });
  ok('仅凭 Cookie 可访问 API（刷新不失效）', r.status === 200 && r.json?.kpi, `HTTP ${r.status}`);
}
{
  const r = await req(`/api/health?token=${TOKEN}`);
  ok('查询参数带访问码可访问 API', r.status === 200, `HTTP ${r.status}`);
}

/* 4. 设备指令接口必须同样受保护（这是最关键的） */
{
  const r = await req('/api/devices/CAM-BC-0007/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reboot' })
  });
  ok('设备指令接口在无凭据时被拒绝', r.status === 401, `HTTP ${r.status}`);
}
{
  const r = await req('/api/devices/CAM-BC-0007/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yzx-token': TOKEN },
    body: JSON.stringify({ action: 'reboot' })
  });
  ok('设备指令接口在有凭据时可用', r.status === 200, `HTTP ${r.status}`);
}

/* 5. 静态资源也不应绕过（否则能直接拿到前端与媒体） */
{
  const r = await req('/web/js/main.js');
  ok('静态 JS 在无凭据时被拦截', r.status === 401 || r.text.includes('访问验证'), `HTTP ${r.status}`);
}
{
  const r = await req('/assets/video/2.mp4');
  ok('视频文件在无凭据时被拦截', r.status === 401 || r.text.includes('访问验证'), `HTTP ${r.status}`);
}
{
  const r = await req('/favicon.ico');
  ok('图标白名单可访问（登录页需要）', r.status === 200, `HTTP ${r.status}`);
}

console.log('─'.repeat(52));
console.log(fail ? `✗ ${fail} 项失败` : '✓ 全部通过：访问控制拦得住、也放得通');
process.exit(fail ? 1 : 0);
