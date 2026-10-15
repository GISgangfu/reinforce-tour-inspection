/* 安全巡检视频处理 · 录像与告警中心
   录像库（含设备回传 + 本地上传）+ 硬件告警处理 */
import { api } from '../api.js';
import {
  $, $$, esc, fmtTime, fmtRange, fmtDate, relTime, tag, sevTag, reviewTag, sourceTag,
  toast, emptyState, modal, createPlayer, timelineHtml, bindTimeline, DEVICE_TYPE, ALERT_TYPE, SEV_COLOR
} from '../ui.js';

export async function render(root, ctx) {
  let tab = ctx.params?.tab || 'videos';

  root.innerHTML = `
    <div class="row" style="gap:8px;margin-bottom:14px">
      <button class="btn ${tab === 'videos' ? 'primary' : 'ghost'}" data-tab="videos">📼 录像库</button>
      <button class="btn ${tab === 'alerts' ? 'primary' : 'ghost'}" data-tab="alerts">🔔 硬件告警</button>
      <span class="spacer"></span>
      <span class="tiny muted" id="meta"></span>
    </div>
    <div id="host"></div>
  `;

  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('primary', x.dataset.tab === tab));
    root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('ghost', x.dataset.tab !== tab));
    paint();
  }));

  async function paint() { tab === 'videos' ? renderVideos() : renderAlerts(); }

  /* ============================ 录像库 ============================ */
  async function renderVideos() {
    const host = $('#host', root);
    const { videos } = await api.videos();
    const { summary } = await api.devices({});
    $('#meta', root).textContent = `共 ${videos.length} 段视频 · ${summary.total} 台设备 · 累计 ${videos.reduce((s, v) => s + v.duration, 0) / 60 | 0} 分钟`;

    host.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>巡检录像库</h3>
          <span class="hint">设备回传与人工上传统一入库，按录制时间倒序</span>
          <div class="right"><button class="btn sm primary" id="to-upload">＋ 上传本地视频</button></div>
        </div>
        <table class="tbl">
          <thead><tr>
            <th style="width:210px">标题</th><th>来源</th><th>采集设备</th><th>部位</th>
            <th>录制时间</th><th>时长</th><th>AI 打标</th><th>状态</th><th></th>
          </tr></thead>
          <tbody>
            ${videos.map((v) => `
              <tr data-vid="${esc(v.id)}">
                <td><b>${esc(v.title)}</b>${v.realFootage ? ` <span class="tag green" style="margin-left:4px">真实素材</span>` : ''}</td>
                <td>${sourceTag(v.source)}</td>
                <td class="small dim">${esc(v.device?.name || v.operator || '—')}</td>
                <td class="small dim">${esc(v.site)}</td>
                <td class="small mono">${fmtDate(v.recordedAt)}</td>
                <td class="mono">${fmtTime(v.duration)}</td>
                <td>${v.riskCount ? tag(`隐患 ${v.riskCount}`, 'orange') : ''} ${v.pendingCount ? tag(`待复核 ${v.pendingCount}`, 'amber') : ''} ${!v.riskCount && v.runStatus === 'done' ? tag('未发现', 'green') : ''}</td>
                <td>${v.runStatus === 'done' ? tag('已分析', 'green') : v.runStatus === 'analyzing' ? tag('分析中', 'blue') : tag('待分析', 'gray')}</td>
                <td class="nowrap">
                  <button class="btn sm" data-play="${esc(v.id)}" ${v.assetPath ? '' : 'disabled'}>▶ 播放</button>
                  <button class="btn sm" data-analyze="${esc(v.id)}" ${v.assetPath ? '' : 'disabled'}>⚡ 分析</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    host.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); openVideo(b.dataset.play, videos);
    }));
    host.querySelectorAll('[data-analyze]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); ctx.navigate('analyze');
    }));
    host.querySelectorAll('tr[data-vid]').forEach((tr) => tr.addEventListener('click', () => openVideo(tr.dataset.vid, videos)));
    $('#to-upload', host).addEventListener('click', () => ctx.navigate('analyze'));
  }

  /** 播放器弹层：视频 + 事件段时间轴 + 该视频的告警清单 */
  async function openVideo(id, list) {
    const v = list.find((x) => x.id === id);
    if (!v) return;
    const detail = await api.video(id);
    const findings = detail.findings || [];
    const segments = detail.segments || detail.run?.segments || [];
    const duration = v.duration || 1;

    modal({
      title: `${v.title} · 原始录像回放`,
      width: '1120px',
      bodyHtml: `
        <div class="grid" style="grid-template-columns: 1.4fr 1fr; gap:16px">
          <div>
            <div class="video-wrap">
              <div class="vtag" id="vt">${esc(v.assetPath || '无媒体文件')} · ${fmtTime(duration)} · ${v.width}×${v.height}</div>
              ${v.assetPath ? `<video id="pv" controls preload="metadata" ${v.poster ? `poster="/${esc(v.poster)}"` : ''}></video>`
                : `<div class="empty" style="padding:60px"><span class="big">📼</span>演示台账数据，未挂载真实媒体</div>`}
            </div>
            <div style="margin-top:12px">
              ${segments.length ? timelineHtml(segments, findings, duration, { playerId: 'tl2' }) : `<div class="tiny muted">该视频尚未分析，暂无事件段</div>`}
            </div>
            <div class="row wrap" style="gap:12px;margin-top:10px">
              <div><div class="tiny muted">来源</div>${sourceTag(v.source)}</div>
              <div><div class="tiny muted">采集设备</div><div class="small">${esc(v.device?.name || '—')}</div></div>
              <div><div class="tiny muted">巡检人</div><div class="small">${esc(v.operator || '—')}</div></div>
              <div><div class="tiny muted">录制</div><div class="small mono">${fmtDate(v.recordedAt)}</div></div>
            </div>
          </div>
          <div>
            <div class="card-head" style="margin-bottom:9px">
              <h3 style="font-size:13.5px">该录像的 AI 打标结果（${findings.length}）</h3>
              <div class="right">
                <button class="btn sm" data-exp="rectify">📄 整改单</button>
                <button class="btn sm" data-exp="record">📋 记录表</button>
                <button class="btn sm" data-exp="excel">📊 Excel</button>
              </div>
            </div>
            <div class="stack scroll-y" style="gap:8px;max-height:60vh">
              ${findings.length ? findings.map((f) => `
                <div class="finding" data-jump="${f.start}" style="grid-template-columns:74px 1fr;padding:8px">
                  ${f.evidence?.frames?.[0]?.src ? `<img class="thumb" style="width:74px;height:44px" src="/${esc(f.evidence.frames[0].src)}">` : `<div class="thumb" style="width:74px;height:44px"></div>`}
                  <div class="ft">
                    <b style="font-size:12.5px">${esc(f.title)}</b>
                    <div class="meta" style="margin-top:5px;gap:5px">
                      ${sevTag(f.severity)} ${reviewTag(f.reviewStatus)}
                      <span class="tag gray mono">${fmtRange(f.start, f.end)}</span>
                    </div>
                  </div>
                </div>`).join('') : emptyState('该录像尚未产生打标结果')}
            </div>
          </div>
        </div>`,
      onMount: (m, close) => {
        const vid = $('#pv', m);
        let player = null;
        if (vid && v.assetPath) {
          player = createPlayer(vid, { onTime: (t) => setCursor?.(t) });
          player.load(`/${v.assetPath}`, v.poster ? `/${v.poster}` : null);
        }
        let setCursor = null;
        if (segments.length) setCursor = bindTimeline(m, duration, (t) => player?.seek(t), (fid) => {
          const f = findings.find((x) => x.id === fid);
          if (f) player?.playRange(f.start, Math.min(8, f.end - f.start));
        });
        m.querySelectorAll('[data-jump]').forEach((n) => n.addEventListener('click', () => {
          player?.playRange(Number(n.dataset.jump), 6);
        }));

        // 导出正式文书
        m.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', async () => {
          const label = { rectify: '隐患整改通知单', record: '安全巡检记录表', excel: '隐患明细表' }[b.dataset.exp];
          b.disabled = true;
          const old = b.textContent;
          b.textContent = '生成中…';
          try {
            const r = await api.exportReport(b.dataset.exp, { videoId: v.id });
            toast(`${label}已生成：${r.name}（${(r.size / 1024).toFixed(1)} KB）`);
          } catch (e) {
            toast(`导出失败：${e.message}`, 'err');
          } finally {
            b.disabled = false; b.textContent = old;
          }
        }));
      }
    });
  }

  /* ============================ 告警中心 ============================ */
  async function renderAlerts() {
    const host = $('#host', root);
    const { alerts } = await api.alerts({});
    $('#meta', root).textContent = `未处理 ${alerts.filter((a) => a.status === 'open' && a.type !== 'battery').length} 条`;

    const groups = {
      high: alerts.filter((a) => a.level === 'high'),
      medium: alerts.filter((a) => a.level === 'medium'),
      info: alerts.filter((a) => a.level === 'info' || a.level === 'ok')
    };
    const levelName = { high: ['🔴 高优先级', 'red'], medium: ['🟠 中优先级', 'orange'], info: ['🔵 提示类', 'blue'] };

    host.innerHTML = `
      <div class="stack" style="gap:14px">
        ${Object.entries(groups).map(([lv, arr]) => !arr.length ? '' : `
          <div class="card">
            <div class="card-head">
              <h3>${levelName[lv][0]}</h3>
              <div class="right">${tag(`${arr.filter((a) => a.status === 'open').length} 条未处理 / 共 ${arr.length}`, levelName[lv][1])}</div>
            </div>
            <table class="tbl">
              <thead><tr><th>类型</th><th>设备</th><th>告警内容</th><th>时间</th><th>状态</th><th></th></tr></thead>
              <tbody>
                ${arr.map((a) => {
                  const m2 = ALERT_TYPE[a.type] || ALERT_TYPE.config;
                  return `<tr>
                    <td>${tag(`${m2.ic} ${m2.label}`, m2.cls)}</td>
                    <td class="small">${esc(a.deviceName)}<div class="tiny muted">${esc(a.deviceId)}</div></td>
                    <td class="small">${esc(a.message)}</td>
                    <td class="small mono nowrap">${fmtDate(a.createdAt)}<div class="tiny muted">${relTime(a.createdAt)}</div></td>
                    <td>${a.status === 'open' ? tag('未处理', 'amber') : tag('已处理', 'green')}</td>
                    <td class="nowrap">
                      ${a.status === 'open' ? `<button class="btn sm primary" data-ack="${esc(a.id)}">标记处理</button>` : ''}
                      <button class="btn sm ghost" data-dev="${esc(a.deviceId)}">设备详情</button>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`).join('')}
      </div>`;

    host.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
      await api.ackAlert(b.dataset.ack);
      toast('已标记处理');
      renderAlerts();
    }));
    host.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => {
      ctx.navigate('devices');
    }));
  }

  await paint();
}
