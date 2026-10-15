/**
 * 安全巡检视频处理 · 获取 cloudflared（Cloudflare Tunnel 客户端）
 * ==================================================================
 * 为什么用 Cloudflare Tunnel 而不是端口映射：
 *   · 不需要公网 IP、不需要动路由器（多数家宽没有公网 IP，且运营商封 80/443）
 *   · 只需出站连接，不需要开放任何入站端口
 *   · 自动提供 HTTPS 域名，微信/邮件里发链接不会被拦
 *
 * 本脚本只把 cloudflared 下载到项目目录，不改系统环境变量、不安装系统服务。
 * 具备：多源回退 + 断点续传重试 + 停滞检测（代理不稳时不至于白等）。
 *
 * 用法： node scripts/get-cloudflared.mjs
 */
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = resolve(ROOT, 'tools', 'bin');
const TARGET = resolve(BIN_DIR, 'cloudflared.exe');
const PART = TARGET + '.part';

/* 多个下载源，逐个尝试（国内网络对 GitHub 直连常不稳） */
const SOURCES = [
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
];

const MIN_BYTES = 30 * 1024 * 1024;   // 真实文件约 53MB；小于 30MB 一律视为不完整
const STALL_MS = 20000;               // 20 秒没有新数据视为停滞

mkdirSync(BIN_DIR, { recursive: true });

/**
 * 校验已有文件是否"真的能用"。
 * 教训：只判断文件存在会误判——下载中断会留下一个几 MB 的残文件，
 * 看起来"已存在"，执行时却报"不是有效的应用程序"。
 * 因此必须实际跑一次 --version。
 */
function verifyBinary(path) {
  if (!existsSync(path)) return { ok: false, reason: '文件不存在' };
  const size = statSync(path).size;
  if (size < MIN_BYTES) return { ok: false, reason: `文件过小（${(size / 1048576).toFixed(1)} MB，应为 50 MB 左右），是不完整的残留` };
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const m = /cloudflared version ([0-9.]+)/i.exec(out);
    return { ok: true, version: m ? m[1] : out.trim().split('\n')[0] };
  } catch (e) {
    return { ok: false, reason: `无法执行：${e.code || e.message}` };
  }
}

const existing = verifyBinary(TARGET);
if (existing.ok) {
  console.log(`✓ cloudflared 已就绪：${TARGET}`);
  console.log(`  版本 ${existing.version}  大小 ${(statSync(TARGET).size / 1048576).toFixed(1)} MB`);
  process.exit(0);
}
if (existsSync(TARGET)) {
  console.log(`清理不可用的旧文件：${existing.reason}`);
  try { unlinkSync(TARGET); } catch { /* ignore */ }
}
try { if (existsSync(PART)) unlinkSync(PART); } catch { /* ignore */ }

/** 带停滞检测的下载；返回是否成功 */
async function attempt(url, label) {
  console.log(`\n尝试下载（${label}）`);
  console.log(`  ${url}`);

  const ac = new AbortController();
  let stallTimer = null;
  const bumpStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ac.abort(new Error('连接停滞超过 ' + STALL_MS / 1000 + ' 秒')), STALL_MS);
  };

  try {
    bumpStall();
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length') || 0);

    let got = 0;
    let lastPct = -1;
    const src = Readable.fromWeb(r.body);
    src.on('data', (c) => {
      got += c.length;
      bumpStall();
      if (total) {
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(`\r  进度 ${String(pct).padStart(3)}%  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
          lastPct = pct;
        }
      } else {
        process.stdout.write(`\r  已下载 ${(got / 1048576).toFixed(1)} MB`);
      }
    });

    await pipeline(src, createWriteStream(PART));
    if (stallTimer) clearTimeout(stallTimer);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    const size = statSync(PART).size;
    if (size < MIN_BYTES) throw new Error(`文件不完整（仅 ${(size / 1048576).toFixed(1)} MB，应为 50 MB 左右）`);
    renameSync(PART, TARGET);

    // 下载完成不等于可用：必须实际执行一次
    const v = verifyBinary(TARGET);
    if (!v.ok) throw new Error(`下载的文件无法运行：${v.reason}`);

    console.log(`✓ 下载完成并验证可用：${(size / 1048576).toFixed(1)} MB，版本 ${v.version}`);
    return true;
  } catch (e) {
    if (stallTimer) clearTimeout(stallTimer);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
    console.log(`✗ 失败：${e.message}`);
    try { if (existsSync(PART)) unlinkSync(PART); } catch { /* ignore */ }
    return false;
  }
}

for (let i = 0; i < SOURCES.length; i++) {
  const label = i === 0 ? 'GitHub 直连' : `镜像源 ${i}`;
  if (await attempt(SOURCES[i], label)) {
    console.log('');
    console.log('  下一步： node scripts/tunnel.mjs');
    process.exit(0);
  }
}

console.error('');
console.error('✗ 所有下载源都失败。');
console.error('');
console.error('  处理办法（任选其一）：');
console.error('   1) 确认代理可用后重试。本机系统代理为 127.0.0.1:7897，可显式指定：');
console.error('        $env:HTTPS_PROXY="http://127.0.0.1:7897"; node scripts/get-cloudflared.mjs');
console.error('   2) 用浏览器/下载工具手动下载后，改名为 cloudflared.exe 放到：');
console.error(`        ${TARGET}`);
console.error('      下载地址： ' + SOURCES[0]);
console.error('   3) 改用其它内网穿透工具（ngrok / frp），见 docs/DEPLOY.md');
process.exit(1);
