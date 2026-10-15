/* 安全巡检视频处理 · UI 工具库 */

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtTime = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};
export const fmtTimeMs = (sec) => {
  const s = Math.max(0, Number(sec) || 0);
  return `${fmtTime(s)}.${String(Math.floor((s % 1) * 10))}`;
};
export const fmtRange = (a, b) => `${fmtTime(a)} – ${fmtTime(b)}`;

export const fmtDate = (str) => {
  if (!str) return '—';
  const d = new Date(String(str).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(str);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const relTime = (str) => {
  if (!str) return '—';
  const d = new Date(String(str).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return str;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
};

/* ------------------------------ 枚举映射 ------------------------------ */
export const SEVERITY_CLASS = { 重大: 'red', 较大: 'orange', 一般: 'amber', 提示: 'blue' };
export const REVIEW_MAP = {
  pending: { label: '待复核', cls: 'amber', ic: '○' },
  confirmed: { label: '已确认', cls: 'green', ic: '✓' },
  rejected: { label: '已排除', cls: 'gray', ic: '✕' },
  revised: { label: '已修正', cls: 'purple', ic: '✎' }
};
export const DEVICE_TYPE = {
  bodycam: { label: '执法记录仪', ic: '🎥', short: '记录仪' },
  drone: { label: '无人机', ic: '🛩️', short: '无人机' },
  robot: { label: '巡检机器狗', ic: '🐕', short: '机器狗' },
  upload: { label: '本地上传', ic: '📁', short: '上传' },
  device: { label: '设备回传', ic: '📡', short: '设备' }
};
export const ALERT_TYPE = {
  offline: { label: '离线告警', ic: '📵', cls: 'red' },
  low_battery: { label: '低电量', ic: '🔋', cls: 'orange' },
  battery: { label: '电量正常', ic: '🔋', cls: 'green' },
  ota: { label: 'OTA 升级', ic: '⬆️', cls: 'blue' },
  signal_weak: { label: '信号弱', ic: '📶', cls: 'orange' },
  storage: { label: '存储告警', ic: '💾', cls: 'amber' },
  live: { label: '实时查看', ic: '👁️', cls: 'purple' },
  config: { label: '配置变更', ic: '⚙️', cls: 'gray' }
};

export const tag = (text, cls = 'gray', { dot = false } = {}) =>
  `<span class="tag ${cls}${dot ? ' dot' : ''}">${esc(text)}</span>`;

export const sevTag = (s) => tag(s, SEVERITY_CLASS[s] || 'gray');
export const reviewTag = (status, extra = '') => {
  const m = REVIEW_MAP[status] || REVIEW_MAP.pending;
  return tag(`${m.ic} ${m.label}${extra}`, m.cls);
};
export const sourceTag = (src) => {
  const d = DEVICE_TYPE[src] || DEVICE_TYPE.device;
  return tag(`${d.ic} ${d.label}`, 'gray');
};

export const battHtml = (pct, charging) => {
  const cls = charging ? 'charging' : pct <= 15 ? 'crit' : pct <= 30 ? 'low' : '';
  const label = charging ? `${pct}% 充电中` : `${pct}%`;
  return `<span class="batt ${cls}" title="电量 ${pct}%${charging ? '（充电中）' : ''}">
    <span class="shell"><span class="fill" style="width:${Math.max(3, Math.min(100, pct))}%"></span></span>${label}</span>`;
};

export const devStatusHtml = (status) => {
  const map = { online: ['online', '在线'], offline: ['offline', '离线'], charging: ['charging', '充电中'] };
  const [cls, label] = map[status] || ['offline', status];
  return `<span class="st ${cls}">${label}</span>`;
};

export const bar = (pct, warn = false) =>
  `<div class="bar${warn ? ' warn' : ''}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;

/* ------------------------------ Toast ------------------------------ */
export function toast(msg, type = '') {
  let host = $('.toasts');
  if (!host) { host = el('div', { class: 'toasts' }); document.body.appendChild(host); }
  const t = el('div', { class: `toast ${type}` }, esc(msg));
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3200);
}

/* ------------------------------ DOM 构造 ------------------------------ */
export function el(tagName, attrs = {}, html = '') {
  const n = document.createElement(tagName);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  if (html) n.innerHTML = html;
  return n;
}

export function modal({ title, bodyHtml, width, onMount, footerHtml = '' }) {
  const bg = el('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  const m = el('div', { class: 'modal', style: width ? `width:${width}` : '' });
  m.innerHTML = `
    <div class="modal-head">
      <h3>${esc(title)}</h3>
      <button class="btn sm modal-close">关闭 ✕</button>
    </div>
    <div class="modal-body">${bodyHtml}</div>
    ${footerHtml ? `<div class="modal-body" style="border-top:1px solid var(--line);padding-top:12px">${footerHtml}</div>` : ''}`;
  m.querySelector('.modal-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.appendChild(m);
  document.body.appendChild(bg);
  onMount?.(m, close);
  return { el: m, close };
}

export function drawer({ title, bodyHtml, onMount }) {
  const bg = el('div', { class: 'modal-bg', style: 'background:rgba(4,8,15,.5);backdrop-filter:none;display:block;padding:0' });
  const d = el('div', { class: 'drawer' });
  d.innerHTML = `
    <div class="drawer-head">
      <h3 style="margin:0;font-size:15px">${esc(title)}</h3>
      <button class="btn sm modal-close" style="margin-left:auto">关闭 ✕</button>
    </div>
    <div class="drawer-body">${bodyHtml}</div>`;
  const close = () => bg.remove();
  d.querySelector('.modal-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.appendChild(d);
  document.body.appendChild(bg);
  onMount?.(d, close);
  return { el: d, close };
}

export function lightbox(src, caption = '') {
  const lb = el('div', { class: 'lightbox' }, `<figure style="margin:0;text-align:center"><img src="${esc(src)}"><figcaption class="muted small" style="margin-top:8px">${esc(caption)}</figcaption></figure>`);
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

/* ------------------------------ 播放器 ------------------------------ */
/**
 * 共享播放器：页面里只需放一个 <video>，通过此对象控制跳转与片段播放。
 * 关键在于「告警 ↔ 原始画面」的对应关系必须精确到秒。
 */
export function createPlayer(videoEl, { onTime } = {}) {
  let clipTimer = null;
  const clearClip = () => { if (clipTimer) { clearInterval(clipTimer); clipTimer = null; } };

  videoEl.addEventListener('timeupdate', () => onTime?.(videoEl.currentTime, videoEl.duration || 0));

  return {
    el: videoEl,
    load(src, poster) {
      videoEl.src = src;
      if (poster) videoEl.poster = poster;
      videoEl.load();
    },
    seek(t, { play = true } = {}) {
      clearClip();
      const target = Math.max(0, Number(t) || 0);
      const apply = () => { try { videoEl.currentTime = target; } catch { /* 元数据未就绪 */ } };
      if (videoEl.readyState >= 1) apply();
      else videoEl.addEventListener('loadedmetadata', apply, { once: true });
      if (play) videoEl.play().catch(() => {});
    },
    /** 播放 [start, start+dur] 这一段，播完自动暂停 —— 对应"3秒片段" */
    playRange(start, dur, { loop = false } = {}) {
      clearClip();
      const from = Math.max(0, Number(start) || 0);
      const to = from + Math.max(0.3, Number(dur) || 3);
      const go = () => {
        videoEl.currentTime = from;
        videoEl.play().catch(() => {});
        clipTimer = setInterval(() => {
          if (videoEl.currentTime >= to || videoEl.paused) {
            videoEl.pause();
            if (loop && videoEl.currentTime >= to) { videoEl.currentTime = from; videoEl.play().catch(() => {}); return; }
            clearClip();
          }
        }, 80);
      };
      if (videoEl.readyState >= 1) go();
      else videoEl.addEventListener('loadedmetadata', go, { once: true });
    },
    pause() { clearClip(); videoEl.pause(); }
  };
}

/* ------------------------------ 时间轴 ------------------------------ */
/**
 * 巡检时间轴：事件段 + 告警标记 + 播放游标。
 * 这是把"视频时间"和"告警"绑在一起的核心可视化部件。
 */
export function timelineHtml(segments, findings, duration, { playerId = 'tl' } = {}) {
  const segs = (segments || []).map((s) =>
    `<div class="tl-seg" style="left:${(s.start / duration * 100).toFixed(3)}%;width:${((s.end - s.start) / duration * 100).toFixed(3)}%" title="事件段 ${s.index + 1}｜${esc(s.scene)}｜${fmtTime(s.start)}-${fmtTime(s.end)}"></div>`
  ).join('');
  const marks = (findings || []).map((f) => {
    const left = (f.start / duration * 100).toFixed(3);
    const w = Math.max(0.5, ((f.end - f.start) / duration * 100)).toFixed(3);
    const color = SEV_COLOR[f.severity] || '#4aa8ff';
    return `<div class="tl-finding" data-fid="${esc(f.id)}" style="left:${left}%;width:${w}%;background:${color};opacity:${f.reviewStatus === 'rejected' ? '.35' : '.9'}" title="${esc(f.title)}｜${fmtRange(f.start, f.end)}｜${f.severity}｜${esc(f.categoryName || '')}"></div>`;
  }).join('');
  return `<div class="timeline" id="${playerId}"><div class="tl-track">${segs}${marks}</div><div class="tl-play" style="left:0%"></div></div>`;
}

const SEV_COLOR = { 重大: '#ff5f56', 较大: '#ff9f43', 一般: '#ffb020', 提示: '#4aa8ff' };
export { SEV_COLOR };

/** 把时间轴上的点击转换为秒数 */
export function bindTimeline(root, duration, onSeek, onFinding) {
  const tl = root.querySelector('.timeline');
  if (!tl) return;
  tl.addEventListener('click', (e) => {
    const mark = e.target.closest('.tl-finding');
    const rect = tl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (mark && onFinding) return onFinding(mark.dataset.fid);
    onSeek?.(ratio * duration);
  });
  const play = tl.querySelector('.tl-play');
  return (t) => { if (play) play.style.left = `${(t / duration * 100).toFixed(3)}%`; };
}

/* ------------------------------ 其他 ------------------------------ */
export function emptyState(text, big = '◌') {
  return `<div class="empty"><span class="big">${big}</span>${esc(text)}</div>`;
}

export function demoNote(text) {
  return `<div class="demo-note"><span class="i">⚠</span><span>${text}</span></div>`;
}

export const pct = (n, total) => (total ? (n / total) * 100 : 0);
