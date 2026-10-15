/**
 * 安全巡检视频处理 · 运行时配置
 * ------------------------------------------------------------------
 * 端口选择说明：8787 已被「实时股票监控与智能投资建议」应用占用，
 * 本平台改用 8899。如需再次更换，只需设置环境变量 PORT 或用 --port 参数：
 *
 *     node server/index.mjs                 # 默认 8899
 *     $env:PORT=9001; node server/index.mjs # 临时换端口
 *     node server/index.mjs --port 9001     # 同上，命令行优先
 *
 * 启动时会检测端口占用，被占用则直接报错退出并给出可用的替代端口，
 * 绝不静默失败（否则会误连到别的服务上，本项目开发期确实踩过这个坑）。
 */
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

export const DEFAULT_PORT = 8899;
export const DEFAULT_HOST = '127.0.0.1';

/**
 * 服务身份标识（唯一来源）。
 * 用途：确认某个端口上响应的"确实是本平台"，而不是恰好占用了该端口的其它服务。
 * 这是本项目踩过的坑——8787 被股票应用占用时，健康检查曾把它的响应当成自己。
 * 注意：这是**内部标识**，与界面上的产品显示名解耦，不要随品牌改名而改动，
 *      否则升级后新旧进程会互相认不出对方。
 */
export const SERVICE_ID = 'yufan-tech-inspection';

/** 界面与横幅上显示的产品名 */
export const PRODUCT_NAME = '安全巡检视频处理';

export function resolvePort(argv = process.argv.slice(2)) {
  const argIdx = argv.findIndex((a) => a === '--port' || a === '-p');
  if (argIdx >= 0 && argv[argIdx + 1]) {
    const n = Number(argv[argIdx + 1]);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  const env = Number(process.env.PORT);
  if (Number.isFinite(env) && env > 0 && env < 65536) return env;
  return DEFAULT_PORT;
}

export function resolveHost(argv = process.argv.slice(2)) {
  const argIdx = argv.findIndex((a) => a === '--host');
  if (argIdx >= 0 && argv[argIdx + 1]) return argv[argIdx + 1];
  return process.env.HOST || DEFAULT_HOST;
}

/**
 * 端口是否已被占用。
 *
 * 关键经验（Windows）：当别的进程已监听 `0.0.0.0:PORT` 时，
 * 再绑定 `127.0.0.1:PORT` 在 Windows 上返回的是 **EACCES**（而不是 EADDRINUSE），
 * 且不带 host 绑定有时甚至能"成功"。因此只探测单一地址、只判断 EADDRINUSE，
 * 会把"已被占用"误判为"空闲"——这正是本项目开发期误连到另一个服务的根因。
 *
 * 这里改为：对 127.0.0.1 / 0.0.0.0 / 不指定 host 三种方式各探测一次，
 * 只要任意一种不是干净的成功，就判定为占用。
 */
export async function isPortTaken(port, host = DEFAULT_HOST) {
  const probes = [host, '0.0.0.0', null];
  const seen = new Set();
  for (const h of probes) {
    const key = h === null ? '*' : h;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await probeBind(port, h);
    if (r !== 'free') return true;
  }
  return false;
}

function probeBind(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    srv.once('error', () => done('taken'));
    srv.once('listening', () => srv.close(() => done('free')));
    try {
      if (host) srv.listen(port, host);
      else srv.listen(port);
    } catch {
      done('taken');
    }
    setTimeout(() => { try { srv.close(); } catch { /* ignore */ } done('taken'); }, 2500);
  });
}

/** 在候选端口里挑一个空闲的，用于打印"可改用这些端口"的提示 */
export async function suggestFreePorts(count = 3, start = DEFAULT_PORT, host = DEFAULT_HOST) {
  const out = [];
  for (let p = start; p < start + 200 && out.length < count; p++) {
    if (!(await isPortTaken(p, host))) out.push(p);
  }
  return out;
}

/* ==================================================================
   对外访问相关配置
   ================================================================== */

/** 是否声明"要对外提供访问"（影响安全默认值与提示语） */
export function isPublicIntent(argv = process.argv.slice(2)) {
  return argv.includes('--public') || process.env.YZX_PUBLIC === '1';
}

/** 访问码：--token 参数 > 环境变量 YZX_TOKEN */
export function resolveToken(argv = process.argv.slice(2)) {
  const i = argv.findIndex((a) => a === '--token');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.YZX_TOKEN || '';
}

/**
 * 对外暴露时的安全闸门。
 *
 * 本平台含设备指令接口（OTA/远程重启/实时画面），裸奔到公网等于把设备控制权交出去。
 * 因此只要绑定地址不是本机（即真的对外了），就必须有访问码：
 *   · 未提供      → 自动生成一个 32 位随机码并打印出来（宁可让你抄一次，也不裸奔）
 *   · 提供了但太短 → 直接拒绝启动
 */
export function enforceAccessToken({ host, token, publicIntent }) {
  const exposed = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  const reallyExposed = exposed || publicIntent;

  if (!reallyExposed) {
    return { token, generated: false, exposed: false, ok: true };
  }

  if (!token) {
    const generated = randomBytes(16).toString('hex');
    return { token: generated, generated: true, exposed: true, ok: true };
  }

  if (token.length < 8) {
    return { token, generated: false, exposed: true, ok: false, error: `访问码过短（${token.length} 位），至少 8 位，建议 16 位以上` };
  }

  return { token, generated: false, exposed: true, ok: true };
}

/** 取本机所有可用内网 IPv4，用于打印"同事在自己电脑上可访问"的地址 */
export function localIPv4() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}
