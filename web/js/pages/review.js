/* 安全巡检视频处理 · 告警复核工作台
   三区布局：告警列表 / 原始视频+时间轴+证据帧 / 复核判定
   核心要求：AI 发现的每一条告警，都能一键跳到原始视频对应秒并核对证据。 */
import { api } from '../api.js';
import {
  $, $$, esc, fmtTime, fmtRange, fmtDate, tag, sevTag, reviewTag, sourceTag,
  createPlayer, timelineHtml, bindTimeline, lightbox, toast, emptyState, demoNote,
  SEV_COLOR, REVIEW_MAP, DEVICE_TYPE
} from '../ui.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待复核' },
  { key: 'confirmed', label: '已确认' },
  { key: 'rejected', label: '已排除' },
  { key: 'recurring', label: '重复隐患' }
];

export async function render(root, ctx) {
  const state = {
    filter: 'pending',
    findings: [],
    clusters: [],
    video: null,
    player: null,
    setCursor: null,
    current: null,
    clipEl: null
  };

  root.innerHTML = `
    <div class="grid" style="grid-template-columns: 400px minmax(0,1fr) 400px; gap:14px; align-items:start">
      <!-- 左：告警列表 -->
      <div class="card tight" style="position:sticky;top:78px;max-height:calc(100vh - 100px);display:flex;flex-direction:column">
        <div class="row wrap" style="gap:6px;margin-bottom:10px" id="filters"></div>
        <div class="row" style="gap:6px;margin-bottom:10px">
          <label class="row small" style="gap:6px;cursor:pointer;white-space:nowrap" title="只看当前选中视频的告警，避免不同视频的同类隐患混在一起">
            <input type="checkbox" id="f-onlycur" style="width:auto"> 限当前视频
          </label>
          <select id="f-type" style="flex:1"><option value="">全部隐患类型</option></select>
          <select id="f-sev" style="width:104px">
            <option value="">全部等级</option><option>重大</option><option>较大</option><option>一般</option><option>提示</option>
          </select>
        </div>
        <div class="scroll-y" style="flex:1;min-height:0;margin:-4px -4px 0;padding:4px" id="f-list"></div>
      </div>

      <!-- 中：原始视频 + 证据 -->
      <div class="stack" style="gap:14px" id="center"></div>

      <!-- 右：复核判定 -->
      <div class="stack" style="gap:14px" id="right"></div>
    </div>
  `;

  /* ---------------- 过滤器 ---------------- */
  const filtersEl = $('#filters', root);
  filtersEl.innerHTML = FILTERS.map((f) =>
    `<button class="btn sm ${f.key === state.filter ? 'primary' : 'ghost'}" data-f="${f.key}">${f.label}</button>`).join('');
  filtersEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    state.filter = b.dataset.f;
    $$('#filters .btn', root).forEach((n) => n.classList.toggle('primary', n.dataset.f === state.filter));
    loadList();
  });
  $('#f-sev', root).addEventListener('change', loadList);
  $('#f-type', root).addEventListener('change', loadList);
  $('#f-onlycur', root).addEventListener('change', loadList);

  /* ---------------- 列表 ---------------- */
  async function loadList() {
    const filter = {};
    if (['pending', 'confirmed', 'rejected'].includes(state.filter)) filter.reviewStatus = state.filter;
    const sev = $('#f-sev', root).value; if (sev) filter.severity = sev;
    const type = $('#f-type', root).value; if (type) filter.categoryCode = type;
    // 限当前视频：勾选后只保留当前选中告警所属视频的条目
    if ($('#f-onlycur', root).checked && state.current?.videoId) filter.videoId = state.current.videoId;
    const { findings, clusters } = await api.findings(filter);
    state.clusters = clusters;
    state.findings = state.filter === 'recurring' ? findings.filter((f) => f.recurrence?.recurring) : findings;

    // 类型下拉
    const sel = $('#f-type', root);
    const cur = sel.value;
    sel.innerHTML = `<option value="">全部隐患类型</option>` +
      clusters.map((c) => `<option value="${esc(c.categoryCode)}">${esc(c.name)}（${c.count}）</option>`).join('');
    sel.value = cur;

    renderList();
  }

  function renderList() {
    const host = $('#f-list', root);
    if (!state.findings.length) {
      host.innerHTML = emptyState('该筛选条件下没有告警', '✓');
      return;
    }
    host.innerHTML = state.findings.map((f) => `
      <div class="finding ${state.current?.id === f.id ? 'sel' : ''}" data-fid="${esc(f.id)}"
           style="grid-template-columns:82px 1fr;margin-bottom:7px;padding:9px">
        ${f.evidence?.frames?.[0]?.src
          ? `<img class="thumb" style="width:82px;height:50px" src="/${esc(f.evidence.frames[0].src)}" alt="">`
          : `<div class="thumb" style="width:82px;height:50px"></div>`}
        <div class="ft">
          <b style="font-size:12.8px">${esc(f.title)}</b>
          <div class="meta" style="margin-top:5px;gap:5px">
            ${sevTag(f.severity)}
            <span class="tag gray mono">${fmtTime(f.start)}</span>
            ${f.recurrence?.recurring ? tag('🔁', 'red') : ''}
            ${f.needsHumanReview && f.reviewStatus === 'pending' ? tag('需复核', 'amber') : reviewTag(f.reviewStatus)}
          </div>
          <!-- 来源视频必须可见：不同视频会检出同类隐患，不显示来源会让人误以为是重复条目 -->
          <div class="tiny muted" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${DEVICE_TYPE[f.video?.source]?.ic || '📼'} ${esc(f.video?.title || '未知视频')}
            <span style="opacity:.7">· 置信 ${(f.confidence * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>`).join('');

    host.querySelectorAll('.finding[data-fid]').forEach((n) => {
      n.addEventListener('click', () => select(n.dataset.fid));
    });
  }

  /* ---------------- 选中一条告警 ---------------- */
  async function select(findingId) {
    const { finding: f, audit } = await api.finding(findingId);
    state.current = f;

    // 切换视频源
    if (!state.video || state.video.id !== f.videoId) {
      state.video = await api.video(f.videoId);
      renderCenter();
      mountPlayer();
    } else {
      renderCenter();
    }
    renderRight(f, audit);
    renderList();

    // 精确跳到证据起始秒并播放
    if (state.player) state.player.playRange(f.start, Math.min(8, f.end - f.start), { loop: false });
    const tl = $('#tl-host', root);
    if (tl) tl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ---------------- 中区：播放器 + 时间轴 + 证据帧 ---------------- */
  function renderCenter() {
    const v = state.video;
    const host = $('#center', root);
    if (!v) { host.innerHTML = emptyState('请选择左侧一条告警'); return; }

    // 事件段：优先取该视频最近一次分析任务，否则用服务端预计算的事件段
    const segments = v.segments || v.run?.segments || [];
    const src = v.assetPath ? `/${v.assetPath}` : null;

    host.innerHTML = `
      <div class="card tight">
        <div class="row wrap" style="gap:10px;margin-bottom:10px;align-items:flex-start">
          <div style="min-width:0;flex:1 1 240px">
            <div style="font-weight:640;font-size:14px">${esc(v.title)}</div>
            <div class="tiny muted">
              ${esc(v.site)} · ${esc(v.operator || '')} · ${fmtDate(v.recordedAt)} ·
              ${v.duration ? `${fmtTime(v.duration)}` : ''} · ${v.width}×${v.height}
            </div>
          </div>
          <div class="row wrap" style="gap:6px;flex:0 0 auto;justify-content:flex-end">
            ${sourceTag(v.source)}
            ${v.device ? tag(`${DEVICE_TYPE[v.device.type]?.ic || ''} ${esc(v.device.name)}`, 'gray') : ''}
            <button class="btn sm" id="exp-rectify" title="按当前视频的隐患生成整改通知单">📄 整改单</button>
            <button class="btn sm" id="exp-record" title="生成安全巡检记录表">📋 记录表</button>
            <button class="btn sm" id="exp-excel" title="导出隐患明细 Excel">📊 Excel</button>
          </div>
        </div>

        ${src ? `
        <div class="video-wrap">
          <div class="vtag" id="vtag">原始素材 · ${esc(v.assetPath)}</div>
          <video id="player" controls preload="metadata" ${v.poster ? `poster="/${esc(v.poster)}"` : ''}></video>
        </div>` : `<div class="empty" style="border:1px solid var(--line);border-radius:10px"><span class="big">📼</span>该视频为演示台账数据，未挂载真实媒体文件。<br><span class="tiny">真实素材：2号楼 12层 二次结构巡检（vid-002）可完整播放与切片。</span></div>`}

        <div id="tl-host" style="margin-top:12px">
          ${segments.length ? `
            ${timelineHtml(segments, (v.findings || []), v.duration || 180, { playerId: 'tl' })}
            <div class="timeline-legend">
              <span><i style="background:rgba(43,179,255,.35)"></i>AI 切分的事件段（${segments.length} 段${v.segmentsPrecomputed ? '，预计算' : ''}）</span>
              <span><i style="background:${SEV_COLOR['重大']}"></i>重大</span>
              <span><i style="background:${SEV_COLOR['较大']}"></i>较大</span>
              <span><i style="background:${SEV_COLOR['一般']}"></i>一般</span>
              <span><i style="background:${SEV_COLOR['提示']}"></i>提示</span>
              <span class="muted">点击时间轴可跳转；点击色块可定位到该告警</span>
            </div>` : `<div class="tiny muted">该视频尚未执行 AI 分析，暂无事件段与告警标记。可到「视频分析」页发起分析。</div>`}
        </div>
      </div>

      ${renderEvidenceCard(state.current)}
    `;

    if (src) {
      const vEl = $('#player', root);
      state.player = createPlayer(vEl, {
        onTime: (t) => state.setCursor?.(t)
      });
      state.player.load(src, v.poster ? `/${v.poster}` : null);
      if (segments.length) {
        state.setCursor = bindTimeline(root, v.duration || 180,
          (t) => state.player.seek(t),
          (fid) => select(fid));
      }
    } else {
      state.player = null;
    }

    // 导出正式文书（按当前视频的全部打标结果）
    const bindExport = (id, kind, label) => {
      const b = $(id, root);
      if (!b) return;
      b.addEventListener('click', async () => {
        b.disabled = true;
        const old = b.textContent;
        b.textContent = '生成中…';
        try {
          const r = await api.exportReport(kind, { videoId: v.id });
          toast(`${label}已生成：${r.name}（${(r.size / 1024).toFixed(1)} KB）`);
        } catch (e) {
          toast(`导出失败：${e.message}`, 'err');
        } finally {
          b.disabled = false; b.textContent = old;
        }
      });
    };
    bindExport('#exp-rectify', 'rectify', '隐患整改通知单');
    bindExport('#exp-record', 'record', '安全巡检记录表');
    bindExport('#exp-excel', 'excel', '隐患明细表');

    // 跳到当前告警位置
    if (state.current && state.player) {
      setTimeout(() => state.player.playRange(state.current.start, Math.min(8, state.current.end - state.current.start)), 420);
    }
  }

  function renderEvidenceCard(f) {
    if (!f) return '';
    const frames = f.evidence?.frames || [];
    return `
      <div class="card">
        <div class="card-head">
          <h3>证据核对</h3>
          <span class="hint">AI 判定所依据的原始画面 · 点击可放大</span>
          <div class="right">
            <button class="btn sm" id="play-full" ${f.evidence?.clip ? '' : 'disabled'}>▶ 播放证据片段 ${f.evidence?.clipDuration ? `(${f.evidence.clipDuration.toFixed(1)}s)` : ''}</button>
            <button class="btn sm" id="play-3s" ${f.evidence?.clip3s ? '' : 'disabled'}>▶ 3 秒片段</button>
          </div>
        </div>
        <div class="shots">
          ${frames.length ? frames.map((fr, i) => `
            <div class="shot">
              <img src="/${esc(fr.src)}" data-src="/${esc(fr.src)}" data-t="${fr.t}" alt="证据帧 ${i + 1}">
              <span class="t">${fmtTime(fr.t)}</span>
            </div>`).join('') : `<div class="empty" style="grid-column:1/-1">该告警未生成证据帧</div>`}
        </div>
        ${f.evidence?.clip ? `
          <div class="hr"></div>
          <div class="grid g2" style="gap:12px">
            <div>
              <div class="tiny muted" style="margin-bottom:5px">证据片段（含前后文，${f.evidence.clipDuration?.toFixed(1)} 秒）</div>
              <video id="clip" controls preload="metadata" src="/${esc(f.evidence.clip)}" style="border-radius:8px;border:1px solid var(--line)"></video>
            </div>
            <div class="stack" style="gap:9px">
              <div class="evi"><b>判定依据</b>${esc(f.description)}</div>
              <div class="evi counter"><b>⚠ 反证（可能误报的原因）</b>${esc(f.counterEvidence || '无')}</div>
              <div class="evi blind"><b>👁 盲区声明</b>${(f.blindSpots || []).map(esc).join('；') || '无'}</div>
            </div>
          </div>` : ''}
      </div>`;
  }

  function mountPlayer() { /* 由 renderCenter 内联挂载 */ }

  /* ---------------- 右区：复核判定 ---------------- */
  function renderRight(f, audit) {
    const host = $('#right', root);
    if (!f) { host.innerHTML = `<div class="card">${emptyState('请选择左侧一条告警进行复核')}</div>`; return; }
    const rc = f.recurrence || {};

    host.innerHTML = `
      <div class="card" style="position:sticky;top:78px">
        <div class="row" style="gap:7px;margin-bottom:9px">
          ${sevTag(f.severity)} ${reviewTag(f.reviewStatus)}
          ${f.needsHumanReview && f.reviewStatus === 'pending' ? tag('⚠ 需人工确认', 'amber') : ''}
        </div>
        <h3 style="margin:0 0 7px;font-size:15px;line-height:1.45">${esc(f.title)}</h3>
        <div class="tiny muted" style="margin-bottom:11px">
          <span class="mono">${esc(f.id)}</span> ·
          ${esc(f.site?.building || '')} ${esc(f.site?.floor || '')} · ${esc(f.site?.zone || '')} ·
          时间码 <b class="mono" style="color:var(--brand-2)">${fmtRange(f.start, f.end)}</b>
        </div>

        <div class="grid g3" style="gap:9px;margin-bottom:12px">
          <div><div class="tiny muted">AI 置信度</div><div style="font-size:17px;font-weight:700;color:${f.confidence >= 0.75 ? 'var(--ok)' : f.confidence >= 0.6 ? 'var(--accent)' : 'var(--warn)'}">${(f.confidence * 100).toFixed(0)}%</div></div>
          <div><div class="tiny muted">检出阶段</div><div style="font-size:17px;font-weight:700">${esc(f.detection?.stage || '—')}</div></div>
          <div><div class="tiny muted">扫描帧数</div><div style="font-size:17px;font-weight:700">${f.detection?.framesScanned ?? '—'}</div></div>
        </div>

        ${rc.recurring ? `
          <div class="evi counter" style="margin-bottom:12px">
            <b>🔁 重复隐患 · 同一部位已出现 ${rc.count} 次</b>
            ${rc.history.map((h) => `<div class="small" style="margin-top:3px">${esc(h.inspectedAt)}｜${esc(h.status === 'closed' ? '已闭环' : h.status)}｜${esc(h.note || '')}</div>`).join('')}
          </div>` : ''}

        <div class="stack" style="gap:9px;margin-bottom:13px">
          <div class="evi"><b>规范依据</b>${(f.basis || []).map((b) => `${esc(b.code)} ${esc(b.clause)}：${esc(b.text)}`).join('<br>') || '未匹配到条款'}</div>
          <div class="evi"><b>建议整改措施</b>${esc(f.measure || '—')}</div>
        </div>

        <div class="field">
          <label class="fld">复核意见（可选，将进入审计痕迹并回流校准）</label>
          <textarea id="rv-note" rows="2" placeholder="例如：现场核查为作业中临时放置，不认定为隐患"></textarea>
        </div>

        <div class="row" style="gap:7px;flex-wrap:wrap">
          <button class="btn primary" id="rv-confirm">✓ 确认隐患</button>
          <button class="btn danger" id="rv-reject">✕ 排除误报</button>
          <button class="btn" id="rv-revise">✎ 修正定级/类型</button>
          ${f.reviewStatus !== 'pending' ? `<button class="btn ghost" id="rv-reopen">↺ 重新打开</button>` : ''}
        </div>

        ${audit?.length ? `
          <div class="hr"></div>
          <div class="tiny muted" style="margin-bottom:6px">复核痕迹（${audit.length} 条）</div>
          <div class="stack" style="gap:7px">
            ${audit.map((a) => `
              <div class="tiny" style="border-left:2px solid var(--line);padding-left:9px">
                <b>${esc(REVIEW_MAP[a.after?.reviewStatus]?.label || a.action)}</b>
                · ${esc(a.reviewer)} · ${esc(a.at)}
                ${a.note ? `<div class="muted" style="margin-top:2px">${esc(a.note)}</div>` : ''}
                ${a.before?.severity !== a.after?.severity ? `<div class="muted">等级 ${esc(a.before?.severity)} → ${esc(a.after?.severity)}</div>` : ''}
              </div>`).join('')}
          </div>` : ''}
      </div>`;

    // 事件绑定
    $('#rv-confirm', host).addEventListener('click', () => doReview(f.id, 'confirm'));
    $('#rv-reject', host).addEventListener('click', () => doReview(f.id, 'reject'));
    $('#rv-reopen', host)?.addEventListener('click', () => doReview(f.id, 'reopen'));
    $('#rv-revise', host).addEventListener('click', () => reviseModal(f));

    // 证据帧放大
    $$('#center .shot img', root).forEach((img) =>
      img.addEventListener('click', () => lightbox(img.dataset.src, `证据帧 · ${fmtTime(Number(img.dataset.t))}（${f.title}）`)));
    $('#play-full', root)?.addEventListener('click', () => playEvidenceClip(f, 'clip'));
    $('#play-3s', root)?.addEventListener('click', () => playEvidenceClip(f, 'clip3s'));
  }

  /** 证据小播放器：点击后在原地播放并自动暂停 */
  function playEvidenceClip(f, which) {
    const box = $('#clip', root);
    if (!box) { toast('该告警未生成证据片段', 'warn'); return; }
    const start = which === 'clip3s' ? f.evidence.clip3sStart : f.evidence.clipStart;
    const dur = which === 'clip3s' ? 3 : f.evidence.clipDuration;
    box.currentTime = 0;
    box.play().catch(() => {});
    toast(`播放${which === 'clip3s' ? ' 3 秒' : ''}证据片段：原始视频 ${fmtTime(start)} 起 ${dur?.toFixed?.(1) ?? dur} 秒`);
  }

  function reviseModal(f) {
    const cats = state.clusters.map((c) => ({ code: c.categoryCode, name: c.name }));
    const m = document.createElement('div');
    m.className = 'modal-bg';
    m.innerHTML = `
      <div class="modal" style="width:460px">
        <div class="modal-head"><h3>修正定级 / 隐患类型</h3><button class="btn sm modal-close" style="margin-left:auto">✕</button></div>
        <div class="modal-body">
          <div class="field"><label class="fld">隐患类型</label>
            <select id="rv-cat">${cats.map((c) => `<option value="${esc(c.code)}" ${c.code === f.categoryCode ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          </div>
          <div class="field"><label class="fld">隐患等级</label>
            <select id="rv-sev">${['重大', '较大', '一般', '提示'].map((s) => `<option ${s === f.severity ? 'selected' : ''}>${s}</option>`).join('')}</select>
          </div>
          <div class="field"><label class="fld">修正说明</label>
            <textarea id="rv-rnote" rows="3" placeholder="说明为什么要修正，便于后续追溯与模型校准"></textarea>
          </div>
          <div class="row"><button class="btn primary" id="rv-rok">提交修正</button><button class="btn modal-close">取消</button></div>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', () => m.remove()));
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    $('#rv-rok', m).addEventListener('click', async () => {
      const payload = {
        action: 'revise',
        categoryCode: $('#rv-cat', m).value,
        severity: $('#rv-sev', m).value,
        note: $('#rv-rnote', m).value || '人工修正定级/类型'
      };
      m.remove();
      await doReview(f.id, 'revise', payload);
    });
  }

  async function doReview(findingId, action, extra = {}) {
    const noteEl = $('#rv-note', root);
    const payload = { action, reviewer: '张建国（安全管理人员）', note: extra.note ?? noteEl?.value ?? '', ...extra };
    try {
      const r = await api.review(findingId, payload);
      const label = { confirm: '已确认隐患', reject: '已排除为误报', revise: '已修正并记录', reopen: '已重新打开' }[action];
      toast(`${r.finding.id} ${label}`);
      await loadList();
      await select(findingId);
    } catch (e) {
      toast(`复核失败：${e.message}`, 'err');
    }
  }

  /* ---------------- 初始化 ---------------- */
  await loadList();
  if (ctx.params?.findingId) await select(ctx.params.findingId);
  else if (state.findings.length) await select(state.findings[0].id);
  else renderCenter();
  renderRight(state.current, []);
}
