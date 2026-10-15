/* 安全巡检视频处理 · API 客户端 */

const BASE = '';

async function req(path, { method = 'GET', body, headers = {} } = {}) {
  const opt = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob || body instanceof File) {
      opt.body = body;
    } else {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
  }
  const r = await fetch(BASE + path, opt);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export const api = {
  health: () => req('/api/health'),
  dashboard: () => req('/api/dashboard'),
  categories: () => req('/api/categories'),

  videos: () => req('/api/videos'),
  video: (id) => req(`/api/videos/${encodeURIComponent(id)}`),

  /** 上传本地视频（人工上传来源）
   *  文件名等元数据走查询参数：实测 Node 在流式 body + duplex:'half' 下会丢自定义请求头，
   *  只依赖 header 会把文件名退化成默认值。请求头作为兜底同时发送。 */
  upload: (file, meta = {}, onProgress) => {
    const qs = new URLSearchParams({ fileName: file.name });
    for (const [k, v] of Object.entries(meta)) if (v != null) qs.set(k, String(v));
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/videos/upload?${qs.toString()}`);
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      for (const [k, v] of Object.entries(meta)) {
        if (v != null) xhr.setRequestHeader(`x-${k}`, encodeURIComponent(String(v)));
      }
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || `HTTP ${xhr.status}`));
        } catch (e) { reject(e); }
      };
      xhr.onerror = () => reject(new Error('上传失败：网络错误'));
      xhr.send(file);
    });
  },

  analyze: (videoId) => req('/api/analyze', { method: 'POST', body: { videoId } }),
  task: (runId) => req(`/api/tasks/${encodeURIComponent(runId)}`),

  findings: (filter = {}) => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v != null && v !== '')).toString();
    return req(`/api/findings${qs ? `?${qs}` : ''}`);
  },
  finding: (id) => req(`/api/findings/${encodeURIComponent(id)}`),
  review: (id, payload) => req(`/api/findings/${encodeURIComponent(id)}/review`, { method: 'POST', body: payload }),
  clusters: (videoId) => req(`/api/clusters${videoId ? `?videoId=${encodeURIComponent(videoId)}` : ''}`),

  search: (query, opts = {}) => req('/api/search', { method: 'POST', body: { query, ...opts } }),
  suggest: () => req('/api/search/suggest'),

  devices: (filter = {}) => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v != null && v !== '')).toString();
    return req(`/api/devices${qs ? `?${qs}` : ''}`);
  },
  device: (id) => req(`/api/devices/${encodeURIComponent(id)}`),
  deviceCommand: (id, action, payload = {}) =>
    req(`/api/devices/${encodeURIComponent(id)}/command`, { method: 'POST', body: { action, ...payload } }),

  alerts: (filter = {}) => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v != null && v !== '')).toString();
    return req(`/api/alerts${qs ? `?${qs}` : ''}`);
  },
  ackAlert: (id) => req(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' }),

  history: () => req('/api/history'),

  /** 生成正式文书并触发下载：kind = rectify | record | excel */
  exportReport: async (kind, { videoId } = {}) => {
    const qs = new URLSearchParams({ kind, ...(videoId ? { videoId } : {}) });
    const r = await fetch(`/api/export?${qs}`);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error || msg; } catch { /* 非 JSON 响应 */ }
      throw new Error(msg);
    }
    const blob = await r.blob();
    // 文件名优先取服务端 Content-Disposition，回退到前端拼装
    let name = EXPORT_NAME[kind] || '导出文件';
    const cd = r.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { /* 保留默认名 */ } }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { name, size: blob.size };
  }
};

const EXPORT_NAME = {
  rectify: '隐患整改通知单.html',
  record: '安全巡检记录表.html',
  excel: '隐患明细表.xls'
};
