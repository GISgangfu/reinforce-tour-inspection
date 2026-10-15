/* 安全巡检视频处理 · 应用外壳与路由 */
import { api } from './api.js';
import { $, esc, toast, demoNote } from './ui.js';

const ROUTES = {
  dashboard: { title: '总览看板', sub: '巡检态势 · 隐患统计 · 硬件状态', ic: '📊', load: () => import('./pages/dashboard.js') },
  review: { title: '告警复核', sub: 'AI 发现的隐患与原始画面逐条核对', ic: '🚨', load: () => import('./pages/review.js'), badge: 'pending' },
  analyze: { title: '视频智能分析', sub: '设备回传 / 本地上传 → 自动识别与总结', ic: '⚡', load: () => import('./pages/analyze.js') },
  search: { title: '智能检索', sub: '自然语言查找视频片段', ic: '🔍', load: () => import('./pages/search.js') },
  videos: { title: '录像与告警', sub: '录像库 · 硬件告警处理', ic: '📼', load: () => import('./pages/videos.js'), badge: 'alerts' },
  devices: { title: '硬件管理', sub: '在离线 · 电量 · OTA · 实时画面', ic: '📡', load: () => import('./pages/devices.js'), badge: 'devices' }
};

const ctx = {
  params: {},
  navigate(route, params = {}) {
    const qs = new URLSearchParams(params).toString();
    location.hash = `#/${route}${qs ? `?${qs}` : ''}`;
  }
};

let currentRoute = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const [route] = path.split('/');
  return { route: ROUTES[route] ? route : 'dashboard', params: Object.fromEntries(new URLSearchParams(query || '')) };
}

function shell() {
  return `
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">智巡</div>
        <div class="brand-text"><b>安全巡检视频处理</b><span>VIDEO SAFETY INSPECTION</span></div>
      </div>
      <div class="nav-group">
        <div class="nav-label">安全管理</div>
        ${['dashboard', 'review', 'analyze', 'search', 'videos', 'devices'].map((r) => {
          const it = ROUTES[r];
          return `<div class="nav-item" data-route="${r}">
            <span class="ic">${it.ic}</span><span class="txt">${it.title}</span>
            <span class="badge" data-badge="${it.badge || ''}" style="display:none"></span>
          </div>`;
        }).join('')}
      </div>
      <div class="nav-group">
        <div class="nav-label">系统</div>
        <div class="nav-item" data-action="docs"><span class="ic">📘</span><span class="txt">实施说明</span></div>
        <div class="nav-item" data-action="refresh"><span class="ic">↻</span><span class="txt">刷新数据</span></div>
      </div>
      <div class="sidebar-foot">
        <div><span class="dot" id="mode-dot"></span><span id="mode-text">连接中…</span></div>
        <!-- 后端地址动态取当前访问地址：换端口、走内网 IP、或经隧道访问时都能正确显示 -->
        <div style="margin-top:6px">后端 ${location.origin}</div>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <div>
          <h1 id="page-title">总览看板</h1>
          <div class="sub" id="page-sub"></div>
        </div>
        <div class="topbar-actions">
          <span class="tag amber" id="kpi-pending" style="display:none"></span>
          <span class="tag red" id="kpi-alerts" style="display:none"></span>
          <button class="btn sm" id="btn-upload">＋ 上传视频</button>
        </div>
      </div>
      <div class="content" id="view"></div>
    </div>
  </div>
  <div class="toasts"></div>`;
}

async function boot() {
  document.body.innerHTML = shell();

  document.querySelector('.sidebar').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-route]');
    if (nav) { ctx.navigate(nav.dataset.route); return; }
    const act = e.target.closest('[data-action]');
    if (act) {
      if (act.dataset.action === 'refresh') { route(); toast('已刷新'); }
      if (act.dataset.action === 'docs') showDocs();
    }
  });
  $('#btn-upload').addEventListener('click', () => ctx.navigate('analyze'));

  window.addEventListener('hashchange', route);
  await refreshBadges();
  setInterval(refreshBadges, 20000);
  await route();
}

async function refreshBadges() {
  try {
    const d = await api.dashboard();
    const set = (sel, text, show) => {
      const n = $(sel);
      if (!n) return;
      n.textContent = text;
      n.style.display = show ? '' : 'none';
    };
    set('#kpi-pending', `⏳ 待复核 ${d.kpi.pendingReview}`, d.kpi.pendingReview > 0);
    set('#kpi-alerts', `🔔 告警 ${d.kpi.openAlerts}`, d.kpi.openAlerts > 0);
    const nb = document.querySelector('[data-badge="pending"]');
    if (nb) { nb.textContent = d.kpi.pendingReview; nb.style.display = d.kpi.pendingReview ? '' : 'none'; }
    const na = document.querySelector('[data-badge="alerts"]');
    if (na) { na.textContent = d.kpi.openAlerts; na.style.display = d.kpi.openAlerts ? '' : 'none'; }
    const nd = document.querySelector('[data-badge="devices"]');
    if (nd) { nd.textContent = d.kpi.devicesOffline; nd.style.display = d.kpi.devicesOffline ? '' : 'none'; }
  } catch { /* 后端未就绪时静默 */ }
}

async function refreshMode() {
  try {
    const h = await api.health();
    const dot = $('#mode-dot'), txt = $('#mode-text');
    if (!dot) return;
    dot.style.background = h.vision.mode === 'demo-rule' ? 'var(--accent)' : 'var(--ok)';
    txt.textContent = h.vision.mode === 'demo-rule' ? '视觉适配器：演示规则版' : '视觉适配器：已接入模型';
  } catch {
    const txt = $('#mode-text');
    if (txt) txt.textContent = '后端未连接';
  }
}

async function route() {
  const { route: r, params } = parseHash();
  const it = ROUTES[r];
  ctx.params = params;
  currentRoute = r;

  document.querySelectorAll('.nav-item[data-route]').forEach((n) =>
    n.classList.toggle('active', n.dataset.route === r));
  $('#page-title').textContent = it.title;
  $('#page-sub').textContent = it.sub;

  const view = $('#view');
  view.innerHTML = `<div class="card"><div class="row"><span class="muted small">加载中…</span></div></div>`;

  try {
    const mod = await it.load();
    await mod.render(view, ctx);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card">${demoNote(`页面加载失败：${esc(e.message)}`)}</div>`;
  }
  await refreshMode();
  await refreshBadges();
}

function showDocs() {
  const m = document.createElement('div');
  m.className = 'modal-bg';
  m.innerHTML = `
    <div class="modal" style="width:820px">
      <div class="modal-head"><h3>安全巡检视频处理 · 实施说明</h3><button class="btn sm modal-close" style="margin-left:auto">✕</button></div>
      <div class="modal-body" style="line-height:1.85;font-size:13.5px">
        <h4 style="margin-top:0">当前版本覆盖的能力</h4>
        <ul style="margin:6px 0 14px;padding-left:20px;color:var(--text-dim)">
          <li><b>告警复核闭环</b>：AI 发现的每条隐患都有时间码、证据帧、3 秒片段，可一键跳回原始视频核对，支持确认 / 排除 / 修正定级与类型，全部操作留审计痕迹并回流反馈集。</li>
          <li><b>硬件管理</b>：在离线、电量、信号、存储、编号命名、绑定对象、OTA 升级（含进度）、实时画面手动触发、历史录像关联、硬件告警处理。</li>
          <li><b>智能检索</b>：自然语言解析为检索条件（隐患类型 / 等级 / 设备来源 / 部位 / 复核状态 / 片段长度），返回与原始视频对应的 3 秒片段并按类型聚类。</li>
          <li><b>视频分析</b>：设备回传与人工本地上传同一条链路；输出问题总结、精确时间码、证据帧与片段，并按隐患类型聚类。</li>
          <li><b>复发识别</b>：部位归一化 + 历史基线比对，同一部位同类问题重复出现时自动预警。</li>
        </ul>

        <h4>关于数据真实性（重要）</h4>
        <div class="demo-note" style="margin-bottom:10px"><span class="i">⚠</span><span>
          本版的<b>媒体证据全部为真实文件</b>：源视频为真实执法记录仪素材（3 分 00 秒），所有证据帧与片段均由 ffmpeg 按时间码从该视频真实切出，可逐帧核对。<br>
          但<b>视觉识别本身是规则化适配器</b>（vision.mjs 的 demo-rule 模式），识别结果来自对这段素材的逐帧人工核对后形成的检测结果库，<b>不代表真实模型的精度指标</b>。
        </span></div>

        <h4>如何接入真实视觉模型</h4>
        <ol style="margin:6px 0 14px;padding-left:20px;color:var(--text-dim)">
          <li>替换 <span class="mono">server/lib/vision.mjs</span> 中的 <span class="mono">detectCandidates()</span> 与复核阶段：抽帧 → 关键帧拼图/局部裁剪放大 → 调用 VLM 返回结构化 JSON → 多帧一致性投票。</li>
          <li>接口签名（<span class="mono">probe / segment / detectCandidates / buildSummary</span>）保持不变，下游的分段、判定、证据打包、报告、复核闭环<b>无需改动</b>。</li>
          <li>把 <span class="mono">DEMO_LIBRARY</span> 转为回归测试标注集，用于计算召回率与误报率。</li>
          <li>启动时设置 <span class="mono">YZX_VISION=live</span> 即切换为真实模型模式。</li>
        </ol>

        <h4>接入真实硬件</h4>
        <ul style="margin:6px 0 0;padding-left:20px;color:var(--text-dim)">
          <li>实时画面：把 <span class="mono">live_start</span> 返回的 <span class="mono">streamAsset</span> 换成 GB28181 / RTSP 转 HLS/WebRTC 的播放地址。</li>
          <li>OTA：把 <span class="mono">otaTick</span> 的本地进度模拟换成厂商 OTA 服务回调。</li>
          <li>设备状态：把 <span class="mono">seed.mjs</span> 的台账换成设备接入网关的心跳与遥测数据。</li>
        </ul>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', () => m.remove()));
  m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
}

/* 供页面模块跨页联动使用 */
window.__yzx = { navigate: ctx.navigate };

boot();
