/**
 * 安全巡检视频处理 · 访问控制
 * ==================================================================
 * 为什么必须有这个模块：
 * 本平台包含设备指令接口（OTA 升级、远程重启、触发实时画面）。
 * 一旦通过隧道/端口映射暴露到公网，任何拿到链接的人都能下发指令。
 * 因此在"能上公网"之前，必须先能"拦住人"。
 *
 * 设计取舍：
 *  - 面向"把链接发给同事看一眼"的场景，不做账号体系，只做**访问码**。
 *    安全等级够用：随机 32 位十六进制码 + 常量时间比较 + HttpOnly Cookie。
 *  - 访问码可写在查询参数里（方便直接发链接），校验通过后换成 Cookie，
 *    这样刷新页面、点内部导航都不会再暴露访问码。
 *  - 未配置访问码时：只允许本机访问；绑定了非本机地址则打印醒目警告。
 *
 * 生产环境替换点：接 SSO / 企业微信扫码 / 反向代理自带的 Basic Auth。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'yzx_token';
const COOKIE_MAX_AGE = 60 * 60 * 12; // 12 小时

/** 常量时间字符串比较，避免按字符逐位比较带来的时序泄露 */
function safeEqual(a = '', b = '') {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免"长度即泄露"
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 从请求里取出候选访问码：请求头 > 查询参数 > Cookie */
function extractToken(req, url) {
  const h = req.headers['x-yzx-token'];
  if (h) return String(h);
  const q = url?.searchParams?.get('token') || url?.searchParams?.get('code');
  if (q) return q;
  return parseCookies(req)[COOKIE_NAME] || '';
}

const isLocalRequest = (req) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
};

/**
 * 免鉴权路径。
 * 登录页必须能显示，否则用户连输码的地方都看不到。
 * /api/health 也在这里，但它只返回"最小存活证明"（见 server/index.mjs 的分支处理）：
 * 运维自检工具需要在不持有访问码时确认"端口上是不是本平台"，
 * 而完整的业务统计仍然需要凭据。
 */
const PUBLIC_PATHS = new Set(['/login', '/api/health', '/favicon.ico', '/web/favicon.svg', '/web/login.css']);

export function createAuth({ token = '', allowLocalWithoutToken = true } = {}) {
  const enabled = Boolean(token && token.length >= 8);

  /** 生成一个访问码（未配置时可用来临时启用） */
  const generate = () => randomBytes(16).toString('hex');

  /**
   * 鉴权主流程。返回 { allowed, reason, setCookie }
   * 不直接写响应，便于在测试与其它入口复用。
   */
  function check(req, url) {
    // 未配置访问码：只放行本机，避免"以为安全了其实没有"
    if (!enabled) {
      if (isLocalRequest(req) || !allowLocalWithoutToken) return { allowed: true, mode: 'open-local' };
      return { allowed: false, reason: 'no-token-configured', mode: 'blocked' };
    }

    if (PUBLIC_PATHS.has(url.pathname)) return { allowed: true, mode: 'public' };

    // 已带有效 Cookie 就放行，且不需要重复下发
    const cookies = parseCookies(req);
    if (safeEqual(cookies[COOKIE_NAME], token)) return { allowed: true, mode: 'cookie' };

    const candidate = extractToken(req, url);
    if (candidate && safeEqual(candidate, token)) {
      // 通过查询参数或请求头带进来的码，换成 Cookie，避免一直挂在 URL 上
      const fromQuery = Boolean(url?.searchParams?.get('token') || url?.searchParams?.get('code'));
      return { allowed: true, mode: fromQuery ? 'query' : 'header', setCookie: true };
    }

    if (candidate) return { allowed: false, reason: 'bad-token', mode: 'denied' };
    return { allowed: false, reason: 'missing-token', mode: 'denied' };
  }

  function cookieHeader() {
    // SameSite=Lax：既能跟随普通导航，又能挡住跨站表单提交
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
  }

  /**
   * 独立的凭据判定：只回答"这个请求带没带有效访问码"，不参与放行决策。
   * 用途：/api/health 在白名单里（要让运维自检工具能确认端口归属），
   * 但它需要据此决定返回"最小存活证明"还是"完整信息"。
   * 未启用访问码时视为已认证（此时本机本来就能访问）。
   */
  function hasValidCredentials(req, url) {
    if (!enabled) return true;
    if (safeEqual(parseCookies(req)[COOKIE_NAME], token)) return true;
    const candidate = extractToken(req, url);
    return Boolean(candidate && safeEqual(candidate, token));
  }

  /** 渲染一个极简登录页：不引入任何外部资源，避免额外暴露面 */
  function loginPage({ reason } = {}) {
    const msg = reason === 'bad-token' ? '访问码不正确，请重新输入。'
      : reason === 'no-token-configured' ? '本平台未配置访问码，且当前不是本机访问，已拒绝。请联系管理员。'
        : '请输入访问码后继续。';
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>安全巡检视频处理 · 访问验证</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e8eef7;
     font:14px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;
     background-image:radial-gradient(1200px 600px at 12% -10%,rgba(43,179,255,.10),transparent 60%),
                      radial-gradient(900px 500px at 92% 0%,rgba(61,220,151,.08),transparent 55%)}
.box{width:min(380px,92vw);background:linear-gradient(180deg,#151f33,#131d30);border:1px solid #24324d;
     border-radius:12px;padding:26px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.mark{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-weight:800;color:#05121f;
      background:linear-gradient(135deg,#3ddc97,#2bb3ff);margin-bottom:14px}
h1{font-size:17px;margin:0 0 4px;letter-spacing:.5px}
.sub{font-size:12px;color:#6b7f9c;margin-bottom:18px}
.msg{font-size:12.5px;color:#ffb020;background:rgba(255,176,32,.07);border:1px solid rgba(255,176,32,.22);
     border-radius:7px;padding:8px 11px;margin-bottom:14px}
input{width:100%;background:#0e1729;border:1px solid #24324d;color:#e8eef7;border-radius:7px;
      padding:10px 12px;font:inherit;font-size:14px;letter-spacing:1px}
input:focus{outline:none;border-color:#2bb3ff;box-shadow:0 0 0 3px rgba(43,179,255,.12)}
button{width:100%;margin-top:12px;padding:10px;border:none;border-radius:7px;cursor:pointer;
       font:inherit;font-weight:650;color:#04140c;background:linear-gradient(135deg,#3ddc97,#2fb87f)}
button:hover{filter:brightness(1.07)}
.tip{margin-top:14px;font-size:11.5px;color:#6b7f9c;line-height:1.7}
</style></head><body>
<form class="box" method="GET" action="/">
  <div class="mark">智巡</div>
  <h1>安全巡检视频处理 · 访问验证</h1>
  <div class="sub">SAFETY VIDEO INSPECTION PLATFORM</div>
  <div class="msg">${msg}</div>
  <input name="token" placeholder="请输入访问码" autocomplete="off" autofocus>
  <button type="submit">进入平台</button>
  <div class="tip">访问码由部署者设置（环境变量 YZX_TOKEN）。<br>验证通过后本机浏览器会记住 12 小时。</div>
</form>
</body></html>`;
  }

  return {
    enabled,
    /** 供启动横幅使用：把访问码打印出来，方便直接拼分享链接 */
    token,
    cookieHeader,
    check,
    hasValidCredentials,
    loginPage,
    generate,
    COOKIE_NAME
  };
}
