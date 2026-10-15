/* 安全巡检视频处理 · 智能检索
   自然语言 → 检索条件 → 与原始视频对应的 3 秒片段 */
import { api } from '../api.js';
import {
  $, $$, esc, fmtTime, fmtRange, tag, sevTag, reviewTag, toast, emptyState, demoNote
} from '../ui.js';

export async function render(root, ctx) {
  const { suggestions } = await api.suggest();
  const state = { result: null, videos: [] };

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>自然语言检索视频片段</h3>
        <span class="hint">用日常说法描述你要找的画面，系统会解析成检索条件并返回对应片段</span>
      </div>
      <div class="row" style="gap:9px">
        <input id="q" placeholder="例如：帮我找到视频里没戴安全帽的告警片段，每一个片段3秒内即可" style="flex:1">
        <button class="btn primary" id="go">🔍 检索</button>
      </div>
      <div class="row wrap" style="gap:6px;margin-top:11px">
        <span class="tiny muted" style="align-self:center">示例：</span>
        ${suggestions.map((s) => `<button class="btn sm ghost" data-q="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>
      <div class="hr"></div>
      <div class="row wrap" style="gap:12px">
        <div class="row" style="gap:6px">
          <span class="tiny muted">片段长度</span>
          <select id="clip" style="width:96px">
            <option value="3" selected>3 秒</option><option value="5">5 秒</option>
            <option value="8">8 秒</option><option value="10">10 秒</option>
          </select>
        </div>
        <div class="row" style="gap:6px">
          <span class="tiny muted">范围</span>
          <select id="scope" style="width:190px"><option value="">全部设备与上传视频</option></select>
        </div>
        <label class="row small" style="gap:6px;cursor:pointer">
          <input type="checkbox" id="pendingOnly" style="width:auto"> 只看待复核
        </label>
      </div>
    </div>

    <div id="out" style="margin-top:14px"></div>
  `;

  // 视频范围
  const { videos } = await api.videos();
  state.videos = videos;
  $('#scope', root).innerHTML = `<option value="">全部设备与上传视频</option>` +
    videos.map((v) => `<option value="${esc(v.id)}">${esc(v.title)}（${v.findingCount} 项）</option>`).join('');

  root.querySelectorAll('[data-q]').forEach((b) =>
    b.addEventListener('click', () => { $('#q', root).value = b.dataset.q; run(); }));
  $('#go', root).addEventListener('click', run);
  $('#q', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  ['clip', 'scope', 'pendingOnly'].forEach((id) =>
    $('#' + id, root).addEventListener('change', () => state.result && run()));

  async function run() {
    const q = $('#q', root).value.trim();
    if (!q) { toast('请输入检索内容', 'warn'); return; }
    const out = $('#out', root);
    out.innerHTML = `<div class="card"><div class="row"><span class="muted small">正在检索…</span></div></div>`;
    try {
      const r = await api.search(q, {
        clipSeconds: Number($('#clip', root).value),
        videoId: $('#scope', root).value || undefined,
        onlyPending: $('#pendingOnly', root).checked ? true : undefined
      });
      state.result = r;
      renderResult(r);
    } catch (e) {
      out.innerHTML = `<div class="card">${emptyState(`检索失败：${e.message}`, '⚠')}</div>`;
    }
  }

  function renderResult(r) {
    const out = $('#out', root);
    const it = r.intent;

    const chips = [
      it.categories.length
        ? tag(`隐患类型：${r.groups.map((g) => g.name).join('、')}`, 'blue')
        : tag('未识别到具体隐患类型，按全文相似度检索', 'gray'),
      it.severity.length ? tag(`等级：${it.severity.join('/')}`, 'amber') : '',
      it.deviceType ? tag(`来源：${{ bodycam: '执法记录仪', drone: '无人机', robot: '机器狗' }[it.deviceType]}`, 'purple') : '',
      it.siteKeyword ? tag(`部位：${it.siteKeyword}`, 'gray') : '',
      it.pendingOnly === true ? tag('仅待复核', 'amber') : '',
      tag(`片段长度：${r.clipSeconds} 秒`, 'gray')
    ].filter(Boolean).join(' ');

    out.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <h3>检索解析</h3>
          <span class="hint">${esc(it.matchReason)}</span>
          <div class="right"><span class="small muted">命中 <b style="color:var(--brand)">${r.total}</b> 个片段${r.filteredOut ? ` · 已按相关度过滤 ${r.filteredOut} 条` : ''}</span></div>
        </div>
        <div class="row wrap" style="gap:7px">${chips}</div>
      </div>

      ${r.total === 0 ? `<div class="card">${emptyState('没有找到匹配的片段，试试换个说法，或缩短描述', '🔍')}</div>` : `
        <div class="stack" style="gap:14px">
          ${r.groups.map((g) => `
            <div class="card">
              <div class="card-head">
                <h3 style="display:flex;align-items:center;gap:8px">
                  <i style="width:9px;height:9px;border-radius:2px;background:${g.color};display:inline-block"></i>
                  ${esc(g.name)}
                  <span class="tag blue">${g.count} 个片段</span>
                </h3>
                <span class="hint">同一类型隐患聚类展示 · 每个片段可直接播放</span>
              </div>
              <div class="grid g4" style="gap:12px">
                ${g.items.map((it2) => `
                  <div class="clipcard">
                    ${it2.clip.src
                      ? `<video preload="metadata" muted playsinline data-src="/${esc(it2.clip.src)}" data-start="${it2.clip.start}" data-dur="${it2.clip.duration}"></video>`
                      : (it2.poster
                        ? `<img class="fallback" src="/${esc(it2.poster)}" alt="">`
                        : `<div class="fallback" style="display:grid;place-items:center;color:var(--text-mute);font-size:12px;text-align:center;padding:10px">演示台账数据<br>未挂载真实媒体</div>`)}
                    <div class="cc-body">
                      <div class="cc-title">${esc(it2.title)}</div>
                      <div class="cc-meta">
                        ${sevTag(it2.severity)} ${reviewTag(it2.reviewStatus)}
                        <span class="tag gray mono">${esc(it2.clip.label)}</span>
                      </div>
                      <div class="tiny muted">${esc(it2.videoTitle)} · ${esc(it2.site?.zone || '')}</div>
                      ${it2.recurrence?.recurring ? `<div class="tiny" style="color:#ff8f88">🔁 同一部位重复 ${it2.recurrence.count} 次</div>` : ''}
                      <div class="row" style="gap:6px;margin-top:auto;padding-top:7px">
                        <button class="btn sm primary" data-play="${esc(it2.findingId)}">▶ 播放 3 秒</button>
                        <button class="btn sm" data-open="${esc(it2.findingId)}">查看证据</button>
                        <span class="tiny muted" style="margin-left:auto">置信 ${(it2.confidence * 100).toFixed(0)}%</span>
                      </div>
                    </div>
                  </div>`).join('')}
              </div>
            </div>`).join('')}
        </div>`}
    `;

    // 片段播放：加载 src 后只播 [start, start+dur]
    $$('video[data-src]', out).forEach((v) => {
      v.src = v.dataset.src;
      const start = Number(v.dataset.start);
      const dur = Number(v.dataset.dur);
      const playOnce = () => { v.currentTime = 0; v.play().catch(() => {}); };
      v.addEventListener('loadeddata', () => {
        // 片段文件已按起始秒切好，本地时间 0 即对应原始 video 的 start 秒
        v.poster = v.poster || '';
      });
      v.addEventListener('timeupdate', () => {
        if (dur && v.currentTime >= dur) { v.pause(); v.currentTime = 0; }
      });
      v.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
      v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
      v.addEventListener('click', playOnce);
    });

    $$('[data-play]', out).forEach((b) =>
      b.addEventListener('click', () => ctx.navigate('review', { findingId: b.dataset.play })));
    $$('[data-open]', out).forEach((b) =>
      b.addEventListener('click', () => ctx.navigate('review', { findingId: b.dataset.open })));
  }

  // 默认先跑一条示例，让页面一打开就有内容
  $('#q', root).value = '帮我找到视频里没戴安全帽的告警片段';
  await run();
}
