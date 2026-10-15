/**
 * 安全巡检视频处理 · 公网隧道启动（Cloudflare Tunnel 快速模式）
 * ==================================================================
 * 作用：把本机服务映射成一个公网的 HTTPS 地址，别人在自己电脑上就能打开。
 *      不需要公网 IP，不需要动路由器，只需要能上外网。
 *
 * 前置：
 *   1) 服务已在运行（serve-forever.cmd）
 *   2) 已下载 cloudflared（node scripts/get-cloudflared.mjs）
 *
 * 用法：
 *   node scripts/tunnel.mjs
 *   node scripts/tunnel.mjs --port 8899 --token 你的访问码
 *
 * 注意：快速模式的地址是临时的，关掉本窗口即失效。
 *      请务必配合访问码使用——本平台含设备指令接口，见 docs/DEPLOY.md。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CF = resolve(ROOT, 'tools', 'bin', 'cloudflared.exe');
const RUNTIME = resolve(ROOT, 'runs', '_runtime');
const LOG = resolve(RUNTIME, 'tunnel.log');

const argv = process.argv.slice(2);
const argVal = (name) => { const i = argv.findIndex((a) => a === name); return i >= 0 ? argv[i + 1] : ''; };
const PORT = Number(argVal('--port') || process.env.PORT || 8899);
const TOKEN = argVal('--token') || process.env.YZX_TOKEN || '';
const HOST = '127.0.0.1';

mkdirSync(RUNTIME, { recursive: true });
const log = (m) => { const l = `[${new Date().toLocaleString('zh-CN')}] ${m}`; try { appendFileSync(LOG, l + '\n', 'utf8'); } catch { /* ignore */ } };

console.log('');
console.log('  ══════════════════════════════════════════════════════════');
console.log('   安全巡检视频处理 · 公网隧道（Cloudflare Tunnel 快速模式）');
console.log('  ══════════════════════════════════════════════════════════');
console.log('');

/* ---- 前置检查 1：cloudflared 是否就绪 ---- */
if (!existsSync(CF)) {
  console.error(`  ✗ 未找到 cloudflared：${CF}`);
  console.error('');
  console.error('    请先执行： node scripts/get-cloudflared.mjs');
  console.error('    若下载失败，见 docs/DEPLOY.md 的手动下载说明。');
  process.exit(1);
}

/* ---- 前置检查 2：本机服务是否在跑 ---- */
const portOpen = await new Promise((res) => {
  const s = createConnection({ port: PORT, host: HOST });
  let done = false;
  const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch { /* ignore */ } res(v); } };
  s.setTimeout(1500);
  s.once('connect', () => fin(true));
  s.once('timeout', () => fin(false));
  s.once('error', () => fin(false));
});

if (!portOpen) {
  console.error(`  ✗ 本机 ${HOST}:${PORT} 上没有服务在监听。`);
  console.error('');
  console.error('    请先启动平台（另开一个窗口，保持开着）：');
  console.error(`      serve-forever.cmd ${PORT}`);
  process.exit(1);
}

/* ---- 安全检查：没有访问码就明确警告 ---- */
if (!TOKEN) {
  console.log('  ⚠ 未提供访问码（--token）。');
  console.log('    本平台含设备指令接口（OTA / 远程重启 / 实时画面）。');
  console.log('    挂到公网后，任何拿到链接的人都能下发指令。');
  console.log('');
  console.log('    强烈建议：先用带访问码的方式重启服务，再开隧道：');
  console.log(`      serve-forever.cmd ${PORT}     然后带上 --token 运行本脚本`);
  console.log('');
  console.log('    若服务端已配置访问码，请这样运行本脚本：');
  console.log('      node scripts/tunnel.mjs --token 你的访问码');
  console.log('');
}

console.log(`  本机服务   http://${HOST}:${PORT}  ✓ 可连接`);
console.log(`  客户端     ${CF}`);
console.log('');
console.log('  正在建立隧道，请稍候（首次需要十几秒）...');
console.log('');

/* ---- 启动 cloudflared ---- */
const child = spawn(CF, ['tunnel', '--url', `http://${HOST}:${PORT}`, '--no-autoupdate'], {
  cwd: ROOT,
  windowsHide: false
});

let publicUrl = '';
let printed = false;

const onChunk = (buf) => {
  const text = buf.toString();
  try { appendFileSync(LOG, text); } catch { /* ignore */ }

  // cloudflared 把访问地址打在 stderr 上，形如 https://xxx-yyy.trycloudflare.com
  if (!publicUrl) {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (m) {
      publicUrl = m[0];
      printShare();
    }
  }
};

function printShare() {
  if (printed) return;
  printed = true;
  const share = TOKEN ? `${publicUrl}/?token=${encodeURIComponent(TOKEN)}` : publicUrl;
  console.log('');
  console.log('  ══════════════════════════════════════════════════════════');
  console.log('   ✓ 隧道已建立，公网地址：');
  console.log('');
  console.log(`     ${publicUrl}`);
  console.log('');
  if (TOKEN) {
    console.log('   把下面这条完整链接发给对方（含访问码，打开即可用）：');
    console.log('');
    console.log(`     ${share}`);
  } else {
    console.log('   ⚠ 未附加访问码。若服务端启用了访问控制，对方需要在登录页输入访问码。');
  }
  console.log('');
  console.log('  ══════════════════════════════════════════════════════════');
  console.log('   注意事项：');
  console.log('     · 该地址是临时的，关闭本窗口即失效，重启后会变');
  console.log('     · 请勿把链接发到公开群；演示结束后建议更换访问码');
  console.log('     · 保持本窗口和服务窗口都开着，关掉任一个都会断');
  console.log('  ══════════════════════════════════════════════════════════');
  console.log('');
  console.log('   按 Ctrl+C 或关闭本窗口即可停止隧道。');
  console.log('');
  log(`隧道已建立：${publicUrl}`);
}

child.stdout?.on('data', onChunk);
child.stderr?.on('data', onChunk);

child.once('error', (e) => {
  console.error(`  ✗ 无法启动 cloudflared：${e.message}`);
  console.error('    若提示权限或损坏，请删除后重新下载： tools\\bin\\cloudflared.exe');
  process.exit(1);
});

child.once('exit', (code, sig) => {
  if (!printed) {
    console.error('');
    console.error(`  ✗ cloudflared 已退出（${sig || code}），未能建立隧道。`);
    console.error(`    请查看日志：${LOG}`);
    console.error('    常见原因：网络无法连到 Cloudflare（可能需要代理）。');
    console.error('    可尝试设置代理后重试，例如：');
    console.error('      $env:HTTPS_PROXY="http://127.0.0.1:7897"; node scripts/tunnel.mjs');
  } else {
    console.log('  隧道已关闭。');
  }
  log(`cloudflared 退出：${sig || code}`);
  process.exit(0);
});

/* Ctrl+C 时把子进程一起带走，避免留下孤立的 cloudflared */
const bye = () => {
  console.log('');
  console.log('  正在关闭隧道...');
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } process.exit(0); }, 1500);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
