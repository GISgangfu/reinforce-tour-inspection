/* 安全巡检视频处理 · 总览看板 */
import { api } from '../api.js';
import {
  $, esc, fmtTime, fmtDate, relTime, tag, sevTag, reviewTag, sourceTag,
  battHtml, devStatusHtml, DEVICE_TYPE, ALERT_TYPE, SEV_COLOR, emptyState, demoNote
} from '../ui.js';

export async function render(root, ctx) {
  const [d, health] = await Promise.all([api.dashboard(), api.health()]);
  const k = d.kpi;

  const trendMax = Math.max(1, ...d.trend.map((t) => t.risk));

  root.innerHTML = `
    ${health.vision.mode === 'demo-rule' ? demoNote(`当前视觉适配器为 <b>${esc(health.vision.mode)}</b>（规则化实现）。界面上所有时间码、证据帧、3 秒片段均为真实媒体，可直接核验；模型精度指标需接入真实视觉模型后重新评估。`) : ''}

    <div class="grid g5" style="margin:14px 0">
      <div class="card kpi info">
        <div class="label">📹 已接入巡检视频</div>
        <div class="value">${k.videos}<small>段</small></div>
        <div class="delta">累计时长 ${k.videoMinutes} 分钟 · 已分析 ${k.runs} 次</div>
      </div>
      <div class="card kpi accent">
        <div class="label">🔍 AI 发现隐患</div>
        <div class="value">${k.riskFindings}<small>项</small></div>
        <div class="delta">合计打标 ${k.findings} 条（含正向记录）</div>
      </div>
      <div class="card kpi danger">
        <div class="label">⏳ 待人工复核</div>
        <div class="value">${k.pendingReview}<small>项</small></div>
        <div class="delta">已确认 ${k.confirmed} · 已排除 ${k.rejected}</div>
      </div>
      <div class="card kpi ${k.recurring > 0 ? 'danger' : 'ok'}">
        <div class="label">🔁 历史重复隐患</div>
        <div class="value">${k.recurring}<small>项</small></div>
        <div class="delta">同一部位同类问题再次出现</div>
      </div>
      <div class="card kpi ok">
        <div class="label">📡 硬件在线</div>
        <div class="value">${k.devicesOnline}<small>/ ${k.devices}</small></div>
        <div class="delta">离线 ${k.devicesOffline} · 待处理告警 ${k.openAlerts}</div>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 1.55fr 1fr; gap:14px">
      <div class="card">
        <div class="card-head">
          <h3>近 7 日隐患发现趋势</h3>
          <span class="hint">按视频录制日期聚合 · 柱高为隐患项数</span>
          <div class="right">
            <span class="small muted">人工复核节省预估 <b style="color:var(--brand)">${d.efficiency.savedMinutes}</b> 分钟</span>
          </div>
        </div>
        <div style="display:flex;align-items:flex-end;gap:10px;height:168px;padding:6px 2px 0">
          ${d.trend.map((t) => `
            <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;height:100%">
              <div class="tiny" style="color:var(--text-dim)">${t.risk || ''}</div>
              <div title="${t.date}｜隐患 ${t.risk} 项｜视频 ${t.videos} 段｜${t.minutes} 分钟"
                   style="width:100%;max-width:44px;height:${Math.max(3, (t.risk / trendMax) * 108)}px;
                          background:linear-gradient(180deg,var(--accent),rgba(255,159,67,.35));border-radius:5px 5px 2px 2px"></div>
              <div class="tiny muted">${t.label}</div>
            </div>`).join('')}
        </div>
        <div class="hr"></div>
        <div class="grid g3">
          <div><div class="tiny muted">自动确认率</div><div style="font-size:19px;font-weight:700;color:var(--ok)">${d.efficiency.autoCorrectRate ?? '—'}${d.efficiency.autoCorrectRate != null ? '%' : ''}</div></div>
          <div><div class="tiny muted">人工排除率（误报）</div><div style="font-size:19px;font-weight:700;color:var(--warn)">${d.efficiency.rejectedRate ?? '—'}${d.efficiency.rejectedRate != null ? '%' : ''}</div></div>
          <div><div class="tiny muted">累计巡检视频</div><div style="font-size:19px;font-weight:700">${d.efficiency.totalMinutes} <span class="small muted">分钟</span></div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>隐患类型分布</h3><span class="hint">按检查表聚类</span></div>
        <div class="stack" style="gap:11px">
          ${d.byType.length ? d.byType.map((t) => `
            <div>
              <div class="row" style="justify-content:space-between;margin-bottom:4px">
                <span class="small" style="display:flex;align-items:center;gap:7px">
                  <i style="width:8px;height:8px;border-radius:2px;background:${t.color};display:inline-block"></i>${esc(t.name)}
                </span>
                <span class="small mono">${t.count}${t.pending ? ` <span class="muted">/ 待复核 ${t.pending}</span>` : ''}</span>
              </div>
              <div class="bar"><i style="width:${(t.count / Math.max(1, d.byType[0].count)) * 100}%;background:${t.color}"></i></div>
            </div>`).join('') : emptyState('暂无打标数据')}
        </div>
        <div class="hr"></div>
        <div class="row wrap" style="gap:8px">
          ${d.bySource.map((s) => tag(`${DEVICE_TYPE[s.source]?.ic || ''} ${s.label} ${s.count}`, 'gray')).join('')}
        </div>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 1.55fr 1fr; gap:14px; margin-top:14px">
      <div class="card">
        <div class="card-head">
          <h3>最近发现的安全隐患</h3>
          <div class="right"><button class="btn sm" id="go-review">进入告警复核 →</button></div>
        </div>
        <div class="stack" style="gap:8px">
          ${d.recentFindings.length ? d.recentFindings.map((f) => `
            <div class="finding" data-fid="${esc(f.id)}" data-vid="${esc(f.videoId)}">
              ${f.evidence?.frames?.[0]?.src
                ? `<img class="thumb" src="/${esc(f.evidence.frames[0].src)}" alt="">`
                : `<div class="thumb" style="display:grid;place-items:center;color:var(--text-mute)">无帧</div>`}
              <div class="ft">
                <b>${esc(f.title)}</b>
                <p>${esc(f.description)}</p>
                <div class="meta">
                  ${sevTag(f.severity)} ${reviewTag(f.reviewStatus)}
                  <span class="tag gray mono">${fmtTime(f.start)}–${fmtTime(f.end)}</span>
                  <span class="tag gray">${esc(f.site?.building || '')} ${esc(f.site?.floor || '')} ${esc(f.site?.zone || '')}</span>
                  ${f.recurrence?.recurring ? tag(`🔁 重复 ${f.recurrence.count} 次`, 'red') : ''}
                </div>
              </div>
              <div class="fr">
                <span class="tiny muted">置信度</span>
                <b style="font-size:15px;color:${f.confidence >= 0.75 ? 'var(--ok)' : f.confidence >= 0.6 ? 'var(--accent)' : 'var(--warn)'}">${(f.confidence * 100).toFixed(0)}%</b>
                <span class="tiny muted">${esc(f.video?.title || '')}</span>
              </div>
            </div>`).join('') : emptyState('暂无隐患发现')}
        </div>
      </div>

      <div class="stack" style="gap:14px">
        <div class="card">
          <div class="card-head"><h3>硬件状态</h3><div class="right"><button class="btn sm" id="go-devices">设备管理 →</button></div></div>
          <div class="stack" style="gap:9px">
            ${d.recentAlerts.filter((a) => a.type !== 'battery').slice(0, 5).map((a) => {
              const m = ALERT_TYPE[a.type] || ALERT_TYPE.config;
              return `<div class="row" style="gap:9px;align-items:flex-start">
                <span style="font-size:15px">${m.ic}</span>
                <div style="min-width:0;flex:1">
                  <div class="small" style="font-weight:600">${esc(a.deviceName)}</div>
                  <div class="tiny muted">${esc(a.message)}</div>
                </div>
                <span class="tiny muted nowrap">${relTime(a.createdAt)}</span>
              </div>`;
            }).join('') || emptyState('无未处理告警', '✓')}
          </div>
        </div>

        ${d.recurringTop.length ? `
        <div class="card" style="border-color:rgba(255,95,86,.35)">
          <div class="card-head"><h3 style="color:#ff8f88">🔁 重复隐患预警</h3></div>
          <div class="stack" style="gap:10px">
            ${d.recurringTop.map((r) => `
              <div>
                <div class="small" style="font-weight:600">${esc(r.title)}</div>
                <div class="tiny muted">同类问题在同一部位已出现 ${r.recurrence.count} 次 · 最近一次 ${esc(r.recurrence.latest?.inspectedAt || '')}</div>
                <div class="tiny" style="color:var(--text-dim);margin-top:3px">${esc(r.recurrence.latest?.note || '')}</div>
              </div>`).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>
  `;

  $('#go-review', root)?.addEventListener('click', () => ctx.navigate('review'));
  $('#go-devices', root)?.addEventListener('click', () => ctx.navigate('devices'));
  root.querySelectorAll('.finding[data-fid]').forEach((n) =>
    n.addEventListener('click', () => ctx.navigate('review', { findingId: n.dataset.fid })));
}
