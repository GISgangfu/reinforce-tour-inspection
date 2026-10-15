/**
 * 安全巡检视频处理 · 前台守护进程
 * ==================================================================
 * 为什么需要它：
 * 由 AI 会话启动的进程会被环境回收（detached 独立进程也逃不掉）。
 * 因此服务必须由"用户自己的窗口"来运行。本脚本就是那个窗口里跑的守护进程：
 *   · 前台运行，窗口关掉即停止
 *   · 服务崩溃或被杀，5 秒后自动重启
 *   · 短时间内连续快速退出（多半是端口被占用）会停止并给出指引，不无限刷屏
 *
 * 用法（一般由 serve-forever.cmd 调用）：
 *   node scripts/supervise.mjs [--port 8899]
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'server', 'index.mjs');
const RUNTIME = resolve(ROOT, 'runs', '_runtime');
const SUP_LOG = resolve(RUNTIME, 'supervisor.log');

const argv = process.argv.slice(2);
const portArgIdx = argv.findIndex((a) => a === '--port' || a === '-p');
const PORT = portArgIdx >= 0 && argv[portArgIdx + 1] ? Number(argv[portArgIdx + 1]) : Number(process.env.PORT) || 8899;
const HOST = '127.0.0.1';

mkdirSync(RUNTIME, { recursive: true });

const log = (msg) => {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  try { appendFileSync(SUP_LOG, line + '\n', 'utf8'); } catch { /* 日志失败不影响运行 */ }
};

function canConnect(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: HOST });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('');
console.log('  ══════════════════════════════════════════════════════════');
console.log('   安全巡检视频处理 · 安全巡检视频智能分析平台');
console.log('  ══════════════════════════════════════════════════════════');
console.log(`   访问地址 : http://${HOST}:${PORT}`);
console.log('   停止服务 : 直接关闭本窗口（或按 Ctrl+C）');
console.log('   崩溃重启 : 已开启（5 秒后自动重试）');
console.log('  ══════════════════════════════════════════════════════════');
console.log('');

/* 启动前先看端口是否已被本平台占用，避免"重复启动"造成困惑 */
if (await canConnect(PORT)) {
  log(`端口 ${PORT} 上已有服务在响应。`);
  console.log('');
  console.log('  这说明安全巡检视频处理可能已经在运行了，请直接访问：');
  console.log(`      http://${HOST}:${PORT}`);
  console.log('');
  console.log('  如果你想强制重启，请先关闭正在运行的那个窗口，');
  console.log(`  或改用其它端口： serve-forever.cmd ${PORT + 1}`);
  console.log('');
  process.exit(0);
}

let quickFails = 0;
let shuttingDown = false;
let current = null;

/* Ctrl+C / 关窗口：把子进程一起带走，避免留下孤儿 */
const shutdown = (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${sig}，正在停止服务...`);
  try { current?.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    try { current?.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(0);
  }, 1500);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* 主循环：前台守护 */
// eslint-disable-next-line no-constant-condition
while (!shuttingDown) {
  log(`正在启动服务（端口 ${PORT}）...`);
  const startedAt = Date.now();
  current = spawn(process.execPath, [ENTRY, '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'inherit',        // 服务的日志直接打到本窗口，便于你看到端口自检结果
    windowsHide: false
  });

  const code = await new Promise((resolve) => {
    current.once('exit', (c, sig) => resolve(sig ? `signal:${sig}` : c));
    current.once('error', (e) => resolve(`error:${e.code || e.message}`));
  });

  const lived = Date.now() - startedAt;
  if (shuttingDown) break;

  log(`服务已退出（${code}），本次运行 ${(lived / 1000).toFixed(1)} 秒。`);

  // 正常运行到退出码 0 视为用户主动结束，不再重启
  if (code === 0) {
    log('服务正常退出（退出码 0），守护结束。');
    break;
  }

  // 启动后很快就退出：多半是端口被占用或配置错误
  const portBusy = await canConnect(PORT);
  if (lived < 8000) {
    quickFails++;
  } else {
    quickFails = 0;
  }

  if (portBusy) {
    log(`检测到端口 ${PORT} 上已有服务在正常响应，无需重启。`);
    console.log('');
    console.log(`  请直接访问： http://${HOST}:${PORT}`);
    console.log('');
    break;
  }

  if (quickFails >= 3) {
    console.log('');
    log(`连续 ${quickFails} 次启动后立即退出，已停止自动重启。`);
    console.log('');
    console.log('  常见原因与处理：');
    console.log(`    1) 端口 ${PORT} 被其它程序占用`);
    console.log('       · 查看端口情况：  node scripts\\serve.mjs --status');
    console.log(`       · 换端口启动：    关闭本窗口后执行  serve-forever.cmd ${PORT + 1}`);
    console.log('    2) 运行环境或依赖路径异常');
    console.log(`       · 体检：          node scripts\\doctor.mjs ${PORT}`);
    console.log('       · 错误日志：      runs\\_runtime\\server.err.log');
    console.log('');
    break;
  }

  log('5 秒后自动重启...（按 Ctrl+C 可停止）');
  await sleep(5000);
}

console.log('');
console.log('  服务已停止。');
