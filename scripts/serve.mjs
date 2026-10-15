/**
 * 安全巡检视频处理 · 独立启动器
 * ==================================================================
 * 为什么需要单独的启动器：
 * 早期版本用会话后台任务托管服务，任务一旦回收，服务进程就随之退出，
 * 表现为"页面突然打不开"。这里改为启动一个**脱离当前会话的独立进程**，
 * 并做完整的可用性验证与日志留档。
 *
 * 用法：
 *   node scripts/serve.mjs              # 启动（默认 8899）
 *   node scripts/serve.mjs --port 9001
 *   node scripts/serve.mjs --stop       # 停止本平台（只杀记录在案的 PID）
 *   node scripts/serve.mjs --status     # 查看状态
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_ID } from '../server/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = resolve(ROOT, 'runs', '_runtime');
const PID_FILE = resolve(RUNTIME, 'server.pid.json');
const OUT_LOG = resolve(RUNTIME, 'server.out.log');
const ERR_LOG = resolve(RUNTIME, 'server.err.log');
const ENTRY = resolve(ROOT, 'server', 'index.mjs');

const argv = process.argv.slice(2);
const argPort = (() => {
  const i = argv.findIndex((a) => a === '--port' || a === '-p');
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : Number(process.env.PORT) || 8899;
})();
const HOST = process.env.HOST || '127.0.0.1';

mkdirSync(RUNTIME, { recursive: true });

/* ---------------------------- 工具 ---------------------------- */

function probeBind(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    srv.once('error', () => done('taken'));
    srv.once('listening', () => srv.close(() => done('free')));
    try { host ? srv.listen(port, host) : srv.listen(port); } catch { done('taken'); }
    setTimeout(() => { try { srv.close(); } catch { /* ignore */ } done('taken'); }, 2500);
  });
}

/** 与 server/config.mjs 同样的三地址探测，规避 Windows 上 EACCES 误判 */
async function isPortTaken(port) {
  for (const h of [HOST, '0.0.0.0', null]) {
    if ((await probeBind(port, h)) !== 'free') return true;
  }
  return false;
}

async function isYzxHealthy(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    // 带上访问码（若已配置）：健康检查接口在无凭据时只返回最小存活证明，
    // 带凭据才能拿到完整统计。没有访问码时也能通过服务身份校验。
    const headers = process.env.YZX_TOKEN ? { 'x-yzx-token': process.env.YZX_TOKEN } : {};
    const r = await fetch(`http://${HOST}:${port}/api/health`, { signal: ctrl.signal, headers });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j = await r.json();
    // 必须确认是"本平台"，不能只看端口有响应（否则会误认成别的服务）
    if (j?.service && j.service !== SERVICE_ID) return { ok: false, reason: `该端口上是其它服务：${j.service}` };
    if (!j?.vision?.mode) return { ok: false, reason: '响应不是安全巡检视频处理的格式' };
    return { ok: true, info: j };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  try { return JSON.parse(readFileSync(PID_FILE, 'utf8')); } catch { return null; }
}

/**
 * 进程存活判断。
 *
 * 注意两个踩过的坑：
 *  1) 不能只用 `process.kill(pid, 0)`：在受限环境（沙箱）下拿不到别的进程句柄，
 *     会抛 EPERM 被误判成"进程不存在"，而服务其实活得好好的。
 *  2) 也不能靠 netstat 查监听 PID：`execFileSync('netstat')` 在受限环境下直接
 *     抛 EPERM（子进程管道被拒）。
 * 所以统一改用**纯 TCP 连接探测**：能连上端口就说明有服务在监听。
 * 这不需要任何子进程，也不依赖进程句柄。
 */
function canConnect(port, host = HOST, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 该端口上是否有服务在监听 */
async function isListening(port) {
  if (!port) return false;
  return (await canConnect(port, HOST)) || (await canConnect(port, '127.0.0.1'));
}

/** 进程是否存活：端口在监听，或 PID 句柄可用 */
async function isAlive(pid, port) {
  if (await isListening(port)) return true;
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitHealthy(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await isYzxHealthy(port);
    if (h.ok) return h;
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, reason: '等待超时' };
}

/* ---------------------------- 命令 ---------------------------- */

async function stop() {
  const rec = readPid();
  if (!rec) { console.log('没有记录在案的运行实例（可能从未启动，或记录已清理）。'); return; }

  if (!(await isAlive(rec.pid, rec.port))) {
    console.log(`端口 ${rec.port} 上没有服务在监听，进程应已退出；清理记录。`);
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }

  console.log(`正在停止安全巡检视频处理（PID ${rec.pid}，端口 ${rec.port}）...`);
  let killed = false;
  try { process.kill(rec.pid, 'SIGTERM'); killed = true; } catch (e) { console.log(`发送停止信号失败：${e.code || e.message}`); }

  for (let i = 0; i < 30; i++) {
    if (!(await isListening(rec.port))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (await isListening(rec.port)) {
    console.log('进程未响应停止信号，尝试强制结束。');
    try { process.kill(rec.pid, 'SIGKILL'); } catch { /* ignore */ }
    for (let i = 0; i < 15; i++) {
      if (!(await isListening(rec.port))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (await isListening(rec.port)) {
    console.log('');
    console.log(`⚠ 端口 ${rec.port} 仍在监听，服务未能停止。`);
    console.log(`  当前运行环境可能不允许本进程结束别的进程。请手动执行：`);
    console.log(`    taskkill /PID ${rec.pid} /F`);
    if (!killed) console.log('  （提示：连停止信号都发不出去，通常是环境权限限制）');
    return;
  }
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  console.log('已停止。');
}

async function status() {
  const rec = readPid();
  console.log('安全巡检视频处理 · 运行状态');
  console.log('──────────────────────────────');
  const port = rec?.port || argPort;
  const listening = await isListening(port);
  const h = await isYzxHealthy(port);

  console.log(rec
    ? `记录实例  PID ${rec.pid}  端口 ${rec.port}  启动于 ${rec.startedAt}`
    : '记录实例  无');
  console.log(`端口监听  ${listening ? `是（${HOST}:${port} 可连接）` : '否'}`);
  console.log(`HTTP 健康 http://${HOST}:${port}/api/health -> ${h.ok ? '正常' : '异常（' + h.reason + '）'}`);
  if (h.ok) {
    console.log(`数据      视频 ${h.info.counts.videos} / 打标 ${h.info.counts.findings} / 设备 ${h.info.counts.devices}`);
    console.log(`适配器    ${h.info.vision.mode}`);
  }
  console.log(`日志      ${OUT_LOG}`);

  if (!rec && listening) {
    console.log('提示      端口有服务在监听，但没有启动记录；可能是手动启动的实例。');
  }
  if (rec && !listening) {
    console.log('提示      记录中的实例已不在运行。重新启动： node scripts/serve.mjs');
  }
}

async function start() {
  const port = argPort;

  // 已经在跑？
  const existing = readPid();
  if (existing && await isAlive(existing.pid, existing.port)) {
    const h = await isYzxHealthy(existing.port);
    if (h.ok) {
      console.log(`安全巡检视频处理已在运行：http://${HOST}:${existing.port}  (PID ${existing.pid})`);
      console.log('如需重启，先执行： node scripts/serve.mjs --stop');
      return;
    }
    console.log(`记录的进程 ${existing.pid} 存活但健康检查失败，将先停止它。`);
    await stop();
  }

  // 端口冲突：必须显式失败，不静默换端口
  if (await isPortTaken(port)) {
    console.error(`✗ 端口 ${port} 已被占用，无法启动安全巡检视频处理。`);
    console.error('  提示：8787 通常是「实时股票监控与智能投资建议」应用在用。');
    const free = [];
    for (let p = port + 1; p < port + 60 && free.length < 3; p++) {
      if (!(await isPortTaken(p))) free.push(p);
    }
    if (free.length) console.error(`  可改用空闲端口：${free.join('、')}   例如： node scripts/serve.mjs --port ${free[0]}`);
    process.exit(1);
  }

  console.log(`正在以独立后台进程启动安全巡检视频处理（端口 ${port}）...`);
  const out = openSync(OUT_LOG, 'a');
  const err = openSync(ERR_LOG, 'a');

  // detached + unref + stdio 重定向到文件：
  // 这样进程不依附于当前会话，会话结束/任务回收都不会把它带走。
  const child = spawn(process.execPath, [ENTRY, '--port', String(port)], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err]
  });
  child.unref();

  const rec = { pid: child.pid, port, startedAt: new Date().toISOString(), entry: ENTRY, logs: { out: OUT_LOG, err: ERR_LOG } };
  writeFileSync(PID_FILE, JSON.stringify(rec, null, 2), 'utf8');

  const h = await waitHealthy(port);
  if (h.ok) {
    console.log('');
    console.log(`  ✓ 安全巡检视频处理已启动并自检通过`);
    console.log(`    访问地址  http://${HOST}:${port}`);
    console.log(`    进程 PID  ${child.pid}   端口 ${port}`);
    console.log(`    视觉适配器 ${h.info.vision.mode}`);
    console.log(`    数据      视频 ${h.info.counts.videos} / 打标 ${h.info.counts.findings} / 设备 ${h.info.counts.devices}`);
    console.log(`    日志      ${OUT_LOG}`);
    console.log('');
    console.log('  该进程独立于当前会话，会话结束也会继续运行。');
    console.log('  停止： node scripts/serve.mjs --stop');
  } else {
    console.error(`✗ 启动后健康检查失败：${h.reason}`);
    console.error(`  请查看日志：${ERR_LOG}`);
    try {
      const tail = existsSync(ERR_LOG) ? readFileSync(ERR_LOG, 'utf8').split('\n').slice(-15).join('\n') : '';
      if (tail.trim()) console.error('  错误日志末尾：\n' + tail);
    } catch { /* ignore */ }
    process.exit(1);
  }
}

/* ---------------------------- 入口 ---------------------------- */
const cmd = argv.find((a) => ['--stop', '--status', '--restart'].includes(a));
try {
  if (cmd === '--stop') await stop();
  else if (cmd === '--status') await status();
  else if (cmd === '--restart') { await stop(); await start(); }
  else await start();
} catch (e) {
  console.error('执行失败：' + (e?.stack || e));
  process.exit(1);
}
