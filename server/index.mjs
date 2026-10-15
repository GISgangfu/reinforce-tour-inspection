/**
 * 安全巡检视频处理 · HTTP 服务（零第三方依赖）
 * ------------------------------------------------------------------
 * 启动： node server/index.mjs            （默认 127.0.0.1:8899）
 *        node server/index.mjs --port 9001
 * 环境变量： PORT / HOST 可覆盖；YZX_VISION=live 切换真实模型适配器
 *
 * 注意：8787 已被「实时股票监控与智能投资建议」应用占用，本平台默认改用 8899。
 * 端口被占用时服务会显式报错退出并给出替代端口，不静默失败。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.mjs';
import { DEMO_LIBRARY, VISION_MODE } from './lib/vision.mjs';
import { createAuth } from './lib/auth.mjs';
import {
  resolvePort, resolveHost, suggestFreePorts, resolveToken,
  isPublicIntent, enforceAccessToken, localIPv4, SERVICE_ID
} from './config.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');
const PORT = resolvePort();
const HOST = resolveHost();

/* ---------- 对外访问安全闸门：真的对外就必须有访问码 ---------- */
const gate = enforceAccessToken({ host: HOST, token: resolveToken(), publicIntent: isPublicIntent() });
if (!gate.ok) {
  console.error('');
  console.error(`  ✗ ${gate.error}`);
  console.error('    设置方式： node server/index.mjs --host 0.0.0.0 --token 你的访问码');
  console.error('');
  process.exit(1);
}
const auth = createAuth({ token: gate.token });

const app = createApp({ root: ROOT, ffmpeg: resolve(ROOT, '..', 'tools', 'pyff', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v7.1.exe') });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2'
};

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const jsonSafe = (v) => {
  try { return JSON.parse(v); } catch { return null; }
};

/** 静态文件服务，支持 Range（视频拖动/seeking 必需） */
function serveStatic(req, res, relPath) {
  const safeRel = normalize(relPath).replace(/^([.][.][/\\])+/, '');
  const abs = resolve(ROOT, safeRel);
  if (!abs.startsWith(ROOT) || !existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 not found');
  }
  const stat = statSync(abs);
  const ext = extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  // 代码与页面一律不缓存：否则改动前端后浏览器仍执行旧脚本，
  // 会出现"代码已更新但界面没变"的假象（本项目开发期确实被这个问题误导过）。
  // 媒体与图片可长缓存，它们内容稳定且体积大。
  const codeExt = ['.js', '.mjs', '.html', '.css'];
  const cacheControl = codeExt.includes(ext) ? 'no-store, must-revalidate' : 'public, max-age=3600';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl
    });
    return createReadStream(abs, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl
  });
  createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = decodeURIComponent(url.pathname);
  const q = url.searchParams;

  /* ---------------------- 访问控制（最先执行） ----------------------
   * 注意顺序：必须在任何业务处理之前拦下，否则设备指令接口会被直接调用。
   * 放行时若访问码是通过 URL 带进来的，换成 Cookie，避免一直挂在地址栏上。
   */
  const authz = auth.check(req, url);
  if (!authz.allowed) {
    if (p.startsWith('/api/')) {
      return sendJson(res, {
        error: authz.reason === 'bad-token' ? '访问码不正确' : '需要访问码',
        hint: '请在浏览器打开根地址，输入访问码；或在 URL 上带 ?token=你的访问码'
      }, 401);
    }
    const html = auth.loginPage({ reason: authz.reason });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (authz.setCookie) res.setHeader('set-cookie', auth.cookieHeader());

  // ------------------------------ API ------------------------------
  if (p.startsWith('/api/')) {
    try {
      if (p === '/api/health') {
        /* 健康检查分两级：
         *  · 无凭据 → 最小存活证明（仅服务身份与适配器模式），供运维自检工具确认端口归属
         *  · 有凭据 → 完整信息（含业务数据规模）
         * 这样启用访问控制后，doctor/serve 等自检工具仍然可用，
         * 而对外暴露时也不会泄露业务数据。 */
        const withDetail = auth.hasValidCredentials(req, url);
        const payload = {
          ok: true, service: SERVICE_ID, mode: VISION_MODE, time: new Date().toISOString(),
          vision: {
            mode: VISION_MODE,
            note: VISION_MODE === 'demo-rule'
              ? '视觉模型为可替换适配器的规则化实现，结果用于演示界面与流程，不代表真实模型精度'
              : '已接入真实模型'
          },
          authenticated: withDetail
        };
        if (withDetail) {
          payload.counts = {
            videos: app.state.videos.size, findings: app.state.findings.length,
            devices: app.state.devices.size, alerts: app.state.alerts.length
          };
        }
        return sendJson(res, payload);
      }
      if (p === '/api/dashboard') return sendJson(res, app.dashboard());
      if (p === '/api/categories') return sendJson(res, { categories: app.categories, visionMode: VISION_MODE });

      // ---- 视频 ----
      if (p === '/api/videos' && req.method === 'GET') return sendJson(res, { videos: app.listVideos() });
      if (p === '/api/videos/upload' && req.method === 'POST') {
        const video = await app.handleUpload(req, req.headers, {
          fileName: q.get('fileName') || '',
          title: q.get('title') || ''
        });
        return sendJson(res, { video }, 201);
      }
      const vm = /^\/api\/videos\/([^/]+)$/.exec(p);
      if (vm && req.method === 'GET') {
        const v = app.videoDetail(vm[1]);
        return v ? sendJson(res, v) : sendJson(res, { error: 'video not found' }, 404);
      }

      // ---- 分析任务 ----
      if (p === '/api/analyze' && req.method === 'POST') {
        const body = jsonSafe(await readBody(req)) || {};
        const video = body.videoId ? app.state.videos.get(body.videoId) : null;
        if (!video) return sendJson(res, { error: 'videoId required and must exist' }, 400);
        const task = app.startRun({
          videoId: video.id,
          deviceId: video.deviceId,
          filename: video.title,
          source: video.source === 'upload' ? 'upload' : 'device',
          meta: { sceneLabel: undefined }
        });
        return sendJson(res, { runId: task.runId, status: task.status }, 202);
      }
      const tm = /^\/api\/tasks\/([^/]+)$/.exec(p);
      if (tm) {
        const t = app.taskStatus(tm[1]);
        return t ? sendJson(res, t) : sendJson(res, { error: 'task not found' }, 404);
      }

      // ---- 隐患发现 ----
      if (p === '/api/findings' && req.method === 'GET') {
        const filter = {
          videoId: q.get('videoId') || undefined,
          categoryCode: q.get('categoryCode') || undefined,
          categoryGroup: q.get('categoryGroup') || undefined,
          severity: q.get('severity') || undefined,
          reviewStatus: q.get('reviewStatus') || undefined,
          source: q.get('source') || undefined,
          deviceType: q.get('deviceType') || undefined,
          q: q.get('q') || undefined
        };
        return sendJson(res, { findings: app.listFindings(filter), clusters: app.clusters(filter) });
      }
      const fm = /^\/api\/findings\/([^/]+)$/.exec(p);
      if (fm && req.method === 'GET') {
        const f = app.getFinding(fm[1]);
        return f ? sendJson(res, { finding: f, audit: app.auditTrail(fm[1]) }) : sendJson(res, { error: 'finding not found' }, 404);
      }
      const rm = /^\/api\/findings\/([^/]+)\/review$/.exec(p);
      if (rm && req.method === 'POST') {
        const body = jsonSafe(await readBody(req)) || {};
        const r = app.review(rm[1], body);
        return r.error ? sendJson(res, r, 400) : sendJson(res, r);
      }

      // ---- 聚类 ----
      if (p === '/api/clusters') {
        return sendJson(res, { clusters: app.clusters({ videoId: q.get('videoId') || undefined }) });
      }

      // ---- 自然语言检索 ----
      if (p === '/api/search' && req.method === 'POST') {
        const body = jsonSafe(await readBody(req)) || {};
        if (!body.query) return sendJson(res, { error: 'query required' }, 400);
        const out = app.search(body.query, {
          videoId: body.videoId, source: body.source,
          clipSeconds: body.clipSeconds, onlyPending: body.onlyPending
        });
        return sendJson(res, out);
      }
      if (p === '/api/search/suggest') {
        return sendJson(res, { suggestions: SUGGESTIONS });
      }

      // ---- 设备 ----
      if (p === '/api/devices' && req.method === 'GET') {
        return sendJson(res, {
          devices: app.listDevices({
            type: q.get('type') || undefined, status: q.get('status') || undefined, q: q.get('q') || undefined
          }),
          summary: summarizeDevices()
        });
      }
      const dm = /^\/api\/devices\/([^/]+)$/.exec(p);
      if (dm && req.method === 'GET') {
        const list = app.listDevices({});
        const d = list.find((x) => x.id === dm[1]);
        return d ? sendJson(res, { device: d, alerts: app.listAlerts({ deviceId: d.id }) }) : sendJson(res, { error: 'device not found' }, 404);
      }
      const cm = /^\/api\/devices\/([^/]+)\/command$/.exec(p);
      if (cm && req.method === 'POST') {
        const body = jsonSafe(await readBody(req)) || {};
        const r = app.deviceCommand(cm[1], body.action, body);
        return r.error ? sendJson(res, r, 400) : sendJson(res, r);
      }

      // ---- 硬件告警 ----
      if (p === '/api/alerts' && req.method === 'GET') {
        return sendJson(res, {
          alerts: app.listAlerts({
            deviceId: q.get('deviceId') || undefined, status: q.get('status') || undefined,
            type: q.get('type') || undefined, level: q.get('level') || undefined
          })
        });
      }
      const am = /^\/api\/alerts\/([^/]+)\/ack$/.exec(p);
      if (am && req.method === 'POST') {
        const r = app.ackAlert(am[1]);
        return r.error ? sendJson(res, r, 404) : sendJson(res, r);
      }

      // ---- 历史 / 复发 ----
      if (p === '/api/history') return sendJson(res, { history: app.history });

      // ---- 报告导出 ----
      if (p === '/api/export' && req.method === 'GET') {
        const kind = q.get('kind') || 'rectify';
        const videoId = q.get('videoId') || null;
        const r = app.exportReport(kind, { videoId });
        if (r.error) return sendJson(res, { error: r.error }, 400);
        const buf = Buffer.from(r.body, 'utf8');
        res.writeHead(200, {
          'content-type': r.contentType,
          'content-length': buf.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
          'cache-control': 'no-store'
        });
        return res.end(buf);
      }

      return sendJson(res, { error: `no such api: ${p}` }, 404);
    } catch (err) {
      console.error('[api error]', p, err);
      return sendJson(res, { error: String(err?.message || err) }, 500);
    }
  }

  // --------------------------- 静态资源 ---------------------------
  if (p === '/' || p === '/index.html') return serveStatic(req, res, 'web/index.html');
  if (p.startsWith('/assets/')) return serveStatic(req, res, p.slice(1));
  if (p.startsWith('/runs/')) return serveStatic(req, res, p.slice(1));
  if (p.startsWith('/web/')) return serveStatic(req, res, p.slice(1));
  if (p === '/favicon.ico') return serveStatic(req, res, 'web/favicon.svg');

  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<h1>404</h1>');
});

function summarizeDevices() {
  const list = app.listDevices({});
  const byType = {};
  for (const d of list) {
    byType[d.type] = byType[d.type] || { total: 0, online: 0, offline: 0, charging: 0, lowBattery: 0, otaAvailable: 0 };
    const b = byType[d.type];
    b.total++;
    if (d.status === 'online') b.online++;
    if (d.status === 'offline') b.offline++;
    if (d.charging) b.charging++;
    if (d.battery <= 20) b.lowBattery++;
    if (d.otaState === 'available') b.otaAvailable++;
  }
  return {
    total: list.length,
    online: list.filter((d) => d.status === 'online').length,
    offline: list.filter((d) => d.status === 'offline').length,
    charging: list.filter((d) => d.status === 'charging').length,
    lowBattery: list.filter((d) => d.battery <= 20).length,
    otaAvailable: list.filter((d) => d.otaState === 'available').length,
    upgrading: list.filter((d) => d.otaState === 'upgrading').length,
    byType
  };
}

const SUGGESTIONS = [
  '帮我找到视频里没戴安全帽的告警片段',
  '找楼板洞口没有盖板和栏杆的片段',
  '临边堆放材料、贴靠栏杆的画面',
  '电缆拖地横穿通道的隐患',
  '移动式脚手架上有人作业的片段',
  '把无人机拍到的隐患片段找出来',
  '只要较大等级的、还没复核的隐患',
  '楼梯湿滑、地面有积水的片段',
  '防护到位的正向记录',
  '钢管扣件散乱堆放、未分类码放的片段'
];

/* ---------------------------- 启动 ---------------------------- */
/**
 * 端口冲突必须显式失败。
 * 教训：本项目开发期曾在端口已被别的服务占用的情况下重启，
 * 结果新的服务进程绑定失败，而健康检查请求被那个服务接走了，
 * 造成"服务正常"的假象。因此这里先探测端口，再监听，并监听 error 事件。
 */
server.on('error', async (err) => {
  // 端口冲突在 Windows 上可能报 EADDRINUSE，也可能报 EACCES（被更宽的绑定遮挡时）
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    console.error('');
    console.error(`  ✗ 端口 ${PORT} 不可用（${err.code}），安全巡检视频处理未能启动。`);
    console.error(`    该端口可能已被「实时股票监控与智能投资建议」等其它服务占用。`);
    const free = await suggestFreePorts(3, PORT + 1, HOST);
    if (free.length) {
      console.error(`    可改用空闲端口：${free.join('、')}`);
      console.error(`    启动示例：node server/index.mjs --port ${free[0]}`);
    } else {
      console.error(`    未找到邻近空闲端口，请用 --port 指定其它端口。`);
    }
    console.error('');
  } else {
    console.error(`  ✗ 服务启动失败：${err.code || ''} ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const lan = localIPv4();
  const exposed = HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1';

  console.log('');
  console.log('  安全巡检视频处理 · 安全巡检视频智能分析平台');
  console.log('  ────────────────────────────────────────────');

  if (exposed) {
    // 对外监听：给出同事可直接打开的地址
    if (lan.length) {
      console.log('  本机访问   http://127.0.0.1:' + PORT);
      for (const ip of lan) console.log(`  局域网访问 http://${ip}:${PORT}`);
    } else {
      console.log(`  监听地址   ${HOST}:${PORT}（未检测到内网 IPv4）`);
    }
  } else {
    console.log(`  访问地址   http://${HOST}:${PORT}`);
    console.log('  提示       当前仅本机可访问。要让同事打开，请用：');
    console.log(`             node server/index.mjs --host 0.0.0.0 --token 你的访问码`);
  }

  console.log(`  视觉适配器 ${VISION_MODE}${VISION_MODE === 'demo-rule' ? '（规则化实现，界面会显式标注）' : ''}`);
  console.log(`  数据目录   ${app.paths.RUNS_DIR}`);
  console.log(`  知识库     ${DEMO_LIBRARY.length} 个检查项模板 / ${app.categories.length} 类隐患检查表`);

  /* ---- 访问控制状态：这是对外分享时最需要看到的信息 ---- */
  if (auth.enabled) {
    console.log('');
    console.log('  ── 访问控制已启用 ─────────────────────────');
    console.log(`  访问码     ${auth.token}`);
    if (exposed && lan.length) {
      console.log('  分享链接   ' + `http://${lan[0]}:${PORT}/?token=${auth.token}`);
      console.log('             （对方打开后会自动换成 Cookie，刷新不再需要带码）');
    }
    if (gate.generated) {
      console.log('  ⚠ 该访问码是自动生成的（因为你对外监听但没提供访问码）。');
      console.log('    请记录下来；下次启动请显式指定： --token <你的访问码>');
    }
    console.log('  ──────────────────────────────────────────');
  } else if (!exposed) {
    console.log('');
    console.log('  访问控制   未启用（仅本机可访问，无需访问码）');
  }

  console.log('');
  // 自检：确认端口上响应的确实是本服务（防止误连其它应用）
  setTimeout(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        headers: auth.enabled ? { 'x-yzx-token': auth.token } : {}
      });
      const j = await r.json();
      const isSelf = j?.vision?.mode === VISION_MODE && j?.counts;
      console.log(isSelf
        ? `  ✓ 端口自检通过：${HOST}:${PORT} 上响应的确为安全巡检视频处理`
        : `  ✗ 端口自检异常：该端口响应的是其它服务，请更换端口`);
      if (auth.enabled && r.status === 401) {
        console.log('  ✗ 自检异常：访问控制拦住了自检请求，请检查 auth 模块');
      }
    } catch (e) {
      console.log(`  ✗ 端口自检失败：${e.message}`);
    }
  }, 400);
});

export { server, app };
