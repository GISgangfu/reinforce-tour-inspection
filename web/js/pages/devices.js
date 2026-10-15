/* 安全巡检视频处理 · 硬件管理
   设备台账 / 在离线 / 电量 / 信号 / OTA / 实时画面手动触发 / 历史录像 / 硬件告警 */
import { api } from '../api.js';
import {
  $, $$, esc, fmtTime, fmtDate, relTime, tag, sourceTag, battHtml, devStatusHtml,
  toast, emptyState, drawer, bar, DEVICE_TYPE, ALERT_TYPE, demoNote
} from '../ui.js';

const TYPES = [
  ['', '全部类型'],
  ['bodycam', '执法记录仪'],
  ['drone', '无人机'],
  ['robot', '机器狗']
];
const STATUS = [['', '全部状态'], ['online', '在线'], ['offline', '离线'], ['charging', '充电中']];

export async function render(root, ctx) {
  const state = { devices: [], summary: null, filter: { type: '', status: '', q: '' }, openId: null };

  root.innerHTML = `
    <div class="grid g5" id="summary" style="margin-bottom:14px"></div>

    <div class="card" style="margin-bottom:14px">
      <div class="row wrap" style="gap:10px">
        <input id="q" placeholder="搜索设备编号 / 名称 / 型号 / 绑定人 / 部位" style="flex:1;min-width:240px">
        <select id="type" style="width:150px">${TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <select id="status" style="width:130px">${STATUS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <button class="btn" id="refresh">↻ 刷新</button>
      </div>
    </div>

    <div id="grid"></div>
  `;

  /* ---------------- 数据加载 ---------------- */
  async function load() {
    const { devices, summary } = await api.devices(state.filter);
    state.devices = devices;
    state.summary = summary;
    renderSummary();
    renderGrid();
  }

  function renderSummary() {
    const s = state.summary || {};
    const byType = s.byType || {};
    $('#summary', root).innerHTML = `
      <div class="card kpi"><div class="label">📦 设备总数</div><div class="value">${s.total ?? 0}<small>台</small></div>
        <div class="delta">${Object.entries(byType).map(([k, v]) => `${DEVICE_TYPE[k]?.short || k} ${v.total}`).join(' · ')}</div></div>
      <div class="card kpi ok"><div class="label">🟢 在线</div><div class="value">${s.online ?? 0}<small>台</small></div>
        <div class="delta">离线 ${s.offline ?? 0} · 充电中 ${s.charging ?? 0}</div></div>
      <div class="card kpi ${(s.lowBattery ?? 0) > 0 ? 'danger' : 'ok'}"><div class="label">🔋 低电量告警</div><div class="value">${s.lowBattery ?? 0}<small>台</small></div>
        <div class="delta">阈值 ≤ 20%</div></div>
      <div class="card kpi accent"><div class="label">⬆️ 固件可升级</div><div class="value">${s.otaAvailable ?? 0}<small>台</small></div>
        <div class="delta">升级中 ${s.upgrading ?? 0} 台</div></div>
      <div class="card kpi info"><div class="label">📹 已归档录像</div><div class="value">${devices0VideoCount()}<small>段</small></div>
        <div class="delta">与设备关联的历史视频片段</div></div>
    `;
  }
  const devices0VideoCount = () => state.devices.reduce((n, d) => n + (d.recentVideos?.length || 0), 0);

  /* ---------------- 设备卡片 ---------------- */
  function renderGrid() {
    const host = $('#grid', root);
    if (!state.devices.length) { host.innerHTML = `<div class="card">${emptyState('没有符合条件的设备')}</div>`; return; }
    host.innerHTML = `<div class="grid g3" style="gap:14px">${state.devices.map(devCard).join('')}</div>`;

    host.querySelectorAll('[data-dev]').forEach((n) => n.addEventListener('click', () => openDrawer(n.dataset.dev)));
  }

  function devCard(d) {
    const dt = DEVICE_TYPE[d.type] || DEVICE_TYPE.device;
    const ota = d.otaState === 'upgrading'
      ? `<div style="margin-top:9px"><div class="row" style="justify-content:space-between"><span class="tiny" style="color:var(--info)">固件升级中 ${d.otaProgress}%</span><span class="tiny muted">${esc(d.firmware)} → ${esc(d.latestFirmware)}</span></div><div style="margin-top:5px">${bar(d.otaProgress)}</div></div>`
      : d.otaState === 'available'
        ? `<div class="row" style="margin-top:9px;gap:6px">${tag(`⬆️ 可升级 ${d.latestFirmware}`, 'blue')}</div>`
        : `<div class="row" style="margin-top:9px;gap:6px">${tag('固件已最新', 'gray')}</div>`;

    return `
      <div class="dev ${state.openId === d.id ? 'sel' : ''}" data-dev="${esc(d.id)}">
        <div class="dev-head">
          <div class="dev-ic">${dt.ic}</div>
          <div style="min-width:0;flex:1">
            <b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</b>
            <div class="id">${esc(d.id)} · ${esc(d.model)}</div>
          </div>
          <div style="text-align:right">
            ${devStatusHtml(d.status)}
            <div class="tiny muted" style="margin-top:4px">${relTime(d.lastSeen)}</div>
          </div>
        </div>
        <div class="row wrap" style="gap:6px;margin-top:10px">
          ${tag(dt.label, 'gray')}
          ${d.alarmCount ? tag(`⚠ ${d.alarmCount} 条告警`, 'red') : ''}
          ${d.battery <= 20 ? tag('低电量', 'orange') : ''}
        </div>
        <div class="dev-stats">
          <div>电量<b>${battHtml(d.battery, d.charging)}</b></div>
          <div>信号<b style="font-size:13px">${ { strong: '强', medium: '中', weak: '弱', none: '无' }[d.signal] || '—' }</b></div>
          <div>录像<b>${d.videoCount}<span class="tiny muted"> 段</span></b></div>
        </div>
        ${ota}
      </div>`;
  }

  /* ---------------- 设备详情抽屉 ---------------- */
  async function openDrawer(id) {
    state.openId = id;
    renderGrid();
    const { device: d, alerts } = await api.device(id);
    const dt = DEVICE_TYPE[d.type] || DEVICE_TYPE.device;

    const dr = drawer({
      title: `${dt.ic} ${d.name}`,
      bodyHtml: `
        <div class="stack" style="gap:14px">
          <div class="row" style="gap:10px">
            ${devStatusHtml(d.status)}
            <span class="tiny muted">ID ${esc(d.id)} · SN ${esc(d.serial)}</span>
            <span class="spacer"></span>
            <button class="btn sm" id="d-reboot">↻ 远程重启</button>
          </div>

          <!-- 电量与状态 -->
          <div class="card tight">
            <div class="card-head"><h3 style="font-size:13px">电量监控</h3></div>
            <div class="row" style="gap:16px">
              <div style="flex:1">
                <div class="row" style="justify-content:space-between;margin-bottom:6px">
                  ${battHtml(d.battery, d.charging)}
                  <span class="tiny muted">${d.charging ? '正在充电' : (d.battery <= 20 ? '低于告警阈值' : '正常')}</span>
                </div>
                ${bar(d.battery, d.battery <= 20)}
                <div class="tiny muted" style="margin-top:7px">
                  信号 ${ { strong: '强', medium: '中', weak: '弱', none: '无' }[d.signal] || '—' } ·
                  存储 ${d.storageUsedGB} / ${d.storageTotalGB} GB ·
                  最后在线 ${fmtDate(d.lastSeen)}
                </div>
              </div>
            </div>
          </div>

          <!-- 实时画面 -->
          <div class="card tight">
            <div class="card-head">
              <h3 style="font-size:13px">实时画面（手动触发）</h3>
              <div class="right"><button class="btn sm primary" id="d-live">👁 触发实时查看</button></div>
            </div>
            <div id="live-host">
              <div class="empty" style="padding:16px"><span class="big">📡</span>未触发实时画面</div>
            </div>
          </div>

          <!-- OTA -->
          <div class="card tight">
            <div class="card-head"><h3 style="font-size:13px">固件 OTA 升级</h3>
              <div class="right">${d.otaState === 'latest' ? tag('已是最新', 'green') : tag('可升级', 'blue')}</div>
            </div>
            <div class="row" style="gap:12px;margin-bottom:9px">
              <div><div class="tiny muted">当前版本</div><b class="mono">${esc(d.firmware)}</b></div>
              <div><div class="tiny muted">最新版本</div><b class="mono" style="color:var(--brand-2)">${esc(d.latestFirmware)}</b></div>
            </div>
            <div id="ota-host"></div>
            <div class="row" style="gap:7px;margin-top:9px">
              <button class="btn sm primary" id="d-ota" ${d.otaState === 'latest' || d.otaState === 'upgrading' ? 'disabled' : ''}>⬆️ 开始升级</button>
              <button class="btn sm ghost" id="d-ota-cancel" ${d.otaState === 'upgrading' ? '' : 'disabled'}>取消</button>
            </div>
          </div>

          <!-- 命名与绑定 -->
          <div class="card tight">
            <div class="card-head"><h3 style="font-size:13px">编号与命名</h3></div>
            <div class="field"><label class="fld">设备名称</label><input id="d-name" value="${esc(d.name)}"></div>
            <div class="field"><label class="fld">绑定对象 / 位置</label><input id="d-bound" value="${esc(d.boundTo)}"></div>
            <button class="btn sm primary" id="d-save">保存</button>
          </div>

          <!-- 历史录像 -->
          <div class="card tight">
            <div class="card-head"><h3 style="font-size:13px">历史录像片段（${d.recentVideos.length}）</h3></div>
            <div class="stack" style="gap:8px">
              ${d.recentVideos.length ? d.recentVideos.map((v) => `
                <div class="row clickable" data-vid="${esc(v.id)}" style="gap:10px;padding:8px;border-radius:8px;background:rgba(43,179,255,.05)">
                  ${v.poster ? `<img src="/${esc(v.poster)}" style="width:62px;height:36px;object-fit:cover;border-radius:5px">` : `<div style="width:62px;height:36px;border-radius:5px;background:#0d1626"></div>`}
                  <div style="min-width:0;flex:1">
                    <div class="small" style="font-weight:600">${esc(v.title)}</div>
                    <div class="tiny muted">${fmtTime(v.duration)} · ${fmtDate(v.recordedAt)} · ${esc(v.runStatus)}</div>
                  </div>
                  <span class="tiny" style="color:var(--brand-2)">分析 →</span>
                </div>`).join('') : `<div class="tiny muted">该设备暂无归档录像</div>`}
            </div>
          </div>

          <!-- 硬件告警 -->
          <div class="card tight">
            <div class="card-head"><h3 style="font-size:13px">硬件告警（${alerts.length}）</h3></div>
            <div class="stack" style="gap:8px">
              ${alerts.length ? alerts.map((a) => {
                const m = ALERT_TYPE[a.type] || ALERT_TYPE.config;
                return `<div class="row" style="gap:9px;align-items:flex-start;${a.status === 'closed' ? 'opacity:.5' : ''}">
                  <span>${m.ic}</span>
                  <div style="flex:1;min-width:0">
                    <div class="small">${esc(a.message)}</div>
                    <div class="tiny muted">${esc(a.createdAt)} · ${a.status === 'open' ? '未处理' : '已处理'}</div>
                  </div>
                  ${a.status === 'open' ? `<button class="btn sm ghost" data-ack="${esc(a.id)}">标记处理</button>` : tag('已处理', 'green')}
                </div>`;
              }).join('') : `<div class="tiny muted">暂无告警</div>`}
            </div>
          </div>
        </div>`,
      onMount: (panel, close) => {
        // ---- 实时画面手动触发 ----
        const liveHost = $('#live-host', panel);
        let session = null;
        $('#d-live', panel).addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          if (!session) {
            btn.disabled = true;
            try {
              const r = await api.deviceCommand(d.id, 'live_start', { by: '张建国（安全管理人员）' });
              session = r.session;
              btn.textContent = '⏹ 停止查看';
              liveHost.innerHTML = `
                <div class="video-wrap">
                  <div class="vtag">· LIVE 手动触发 · ${esc(session.id)}</div>
                  ${r.streamAsset
                    ? `<video id="live-v" controls autoplay muted playsinline src="/${esc(r.streamAsset)}"></video>`
                    : `<div class="empty" style="padding:26px"><span class="big">📵</span>该设备未绑定任何录像，无法取流</div>`}
                </div>
                <div class="demo-note" style="margin-top:8px"><span class="i">⚠</span><span>${esc(r.note)}</span></div>
                <div class="tiny muted" style="margin-top:6px">触发人 张建国 · 触发时间 ${esc(session.startedAt)}</div>`;
            } catch (err) { toast(`触发失败：${err.message}`, 'err'); }
            finally { btn.disabled = false; }
          } else {
            btn.disabled = true;
            try {
              await api.deviceCommand(d.id, 'live_stop', { sessionId: session.id });
              session = null;
              btn.textContent = '👁 触发实时查看';
              liveHost.innerHTML = `<div class="empty" style="padding:16px"><span class="big">📡</span>已停止实时画面</div>`;
            } finally { btn.disabled = false; }
          }
        });

        // ---- OTA ----
        const otaHost = $('#ota-host', panel);
        const paintOta = (dev) => {
          if (dev.otaState === 'upgrading') {
            otaHost.innerHTML = `<div class="row" style="justify-content:space-between"><span class="tiny" style="color:var(--info)">升级中 ${dev.otaProgress}%</span><span class="tiny muted">请勿断电</span></div><div style="margin-top:6px">${bar(dev.otaProgress)}</div>`;
          } else if (dev.otaState === 'latest') {
            otaHost.innerHTML = `<div class="tiny" style="color:var(--ok)">✓ 当前已是 ${esc(dev.firmware)}，无需升级</div>`;
          } else {
            otaHost.innerHTML = `<div class="tiny muted">可升级到 ${esc(dev.latestFirmware)}，升级期间设备将短暂离线</div>`;
          }
        };
        paintOta(d);

        $('#d-ota', panel).addEventListener('click', async () => {
          const r = await api.deviceCommand(d.id, 'ota_start');
          if (r.error) return toast(r.error, 'warn');
          toast(r.message);
          $('#d-ota', panel).disabled = true;
          $('#d-ota-cancel', panel).disabled = false;
          const timer = setInterval(async () => {
            const { device: cur } = await api.device(d.id);
            paintOta(cur);
            if (cur.otaState !== 'upgrading') {
              clearInterval(timer);
              toast(`固件升级完成：${cur.firmware}`);
              $('#d-ota', panel).disabled = cur.otaState === 'latest';
              $('#d-ota-cancel', panel).disabled = true;
              load();
            }
          }, 1200);
        });
        $('#d-ota-cancel', panel).addEventListener('click', async () => {
          await api.deviceCommand(d.id, 'ota_cancel');
          toast('已取消升级', 'warn');
          close();
          load();
        });

        // ---- 命名保存 ----
        $('#d-save', panel).addEventListener('click', async () => {
          await api.deviceCommand(d.id, 'rename', { name: $('#d-name', panel).value });
          await api.deviceCommand(d.id, 'bind', { boundTo: $('#d-bound', panel).value });
          toast('设备信息已保存');
          close();
          load();
        });

        $('#d-reboot', panel).addEventListener('click', async () => {
          const r = await api.deviceCommand(d.id, 'reboot');
          toast(r.message || '指令已下发');
        });

        // ---- 告警处理 ----
        panel.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
          await api.ackAlert(b.dataset.ack);
          toast('已标记处理');
          close();
          load();
        }));

        // ---- 跳到录像分析 ----
        panel.querySelectorAll('[data-vid]').forEach((n) => n.addEventListener('click', () => {
          close();
          ctx.navigate('analyze');
        }));
      }
    });
  }

  /* ---------------- 事件 ---------------- */
  let debounce = null;
  $('#q', root).addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.filter.q = e.target.value; load(); }, 220);
  });
  $('#type', root).addEventListener('change', (e) => { state.filter.type = e.target.value; load(); });
  $('#status', root).addEventListener('change', (e) => { state.filter.status = e.target.value; load(); });
  $('#refresh', root).addEventListener('click', async () => { await load(); toast('设备状态已刷新'); });

  await load();
}
