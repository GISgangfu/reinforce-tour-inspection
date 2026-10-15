// 验证导出三类文书：整改通知单 / 巡检记录表 / 隐患明细 Excel
const BASE = process.env.YZX_BASE || 'http://127.0.0.1:8899';

const checks = [];
const ok = (name, cond, detail = '') => { checks.push({ name, cond, detail }); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`); };

async function get(url) {
  const r = await fetch(url);
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, headers: r.headers };
}

for (const kind of ['rectify', 'record', 'excel']) {
  console.log(`\n=========== kind=${kind} ===========`);
  const r = await get(`${BASE}/api/export?kind=${kind}&videoId=vid-002`);
  ok(`HTTP 200`, r.ok, `status=${r.status}`);
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const filename = m ? decodeURIComponent(m[1]) : '(无)';
  ok('返回下载文件名', !!m, filename);
  console.log(`  Content-Type : ${r.headers.get('content-type')}`);
  console.log(`  大小         : ${(Buffer.byteLength(r.text, 'utf8') / 1024).toFixed(1)} KB`);

  if (kind === 'excel') {
    ok('是 XML 工作簿', r.text.startsWith('<?xml') && r.text.includes('<Workbook'));
    ok('含表头列', r.text.includes('隐患等级') && r.text.includes('起始时间码'));
    ok('含真实时间码', /\d\d:\d\d/.test(r.text), (r.text.match(/\d\d:\d\d/g) || []).slice(0, 4).join(' '));
    ok('表头单元格数=25', (r.text.match(/ss:StyleID="hdr"/g) || []).length === 25, String((r.text.match(/ss:StyleID="hdr"/g) || []).length));
  } else {
    ok('是完整 HTML', r.text.includes('<!DOCTYPE html>') && r.text.includes('</html>'));
    ok('含证据时间码', /原始视频 \d\d:\d\d–\d\d:\d\d/.test(r.text) || /\d\d:\d\d–\d\d:\d\d/.test(r.text));
    ok('含规范依据', r.text.includes('JGJ'));
    ok('含签字栏', r.text.includes('签字') || r.text.includes('签收'));
    if (kind === 'rectify') {
      // 整改单是逐项文书：必须带证据图、反证、盲区、整改期限
      ok('含证据图片引用', r.text.includes('/assets/shots/') || r.text.includes('runs/'));
      ok('含反证与盲区', r.text.includes('反证') && r.text.includes('盲区声明'));
      ok('含整改期限', r.text.includes('整改期限'));
      ok('含隐患项编号', r.text.includes('f-no'));
      ok('排除正向记录', !r.text.includes('正向记录'), '整改单不应包含"防护到位"类条目');
    }
    if (kind === 'record') {
      // 记录表是汇总文书：三类分区 + AI 总结 + 聚类统计，不要求逐项证据块
      ok('含三类分区', r.text.includes('发现的安全隐患') && r.text.includes('防护到位情况') && r.text.includes('隐患类型聚类统计'));
      ok('含 AI 总结', r.text.includes('安全问题总结'), '必须能现场生成总结');
      ok('含等级与复核状态列', r.text.includes('等级') && r.text.includes('复核状态'));
      ok('含聚类统计行', r.text.includes('隐患类别') && r.text.includes('涉及时间码'));
    }
    // HTML 里出现的图片 src 必须都能访问
    const srcs = [...r.text.matchAll(/src="\/([^"]+)"/g)].map((m2) => m2[1]);
    let bad = 0;
    for (const s of srcs) { const ir = await fetch(`${BASE}/${s}`, { method: 'HEAD' }); if (!ir.ok) bad++; }
    ok(`证据图片全部可访问（${srcs.length} 张）`, bad === 0, bad ? `${bad} 张失效` : '');
  }
}

console.log('\n=========== 无视频参数（全库导出） ===========');
const all = await get(`${BASE}/api/export?kind=rectify`);
ok('全库导出可用', all.ok && all.text.includes('隐患整改通知单'));

console.log('\n=========== 异常入参 ===========');
const bad1 = await get(`${BASE}/api/export?kind=nope`);
ok('未知 kind 返回 400', bad1.status === 400, `status=${bad1.status}`);
const bad2 = await get(`${BASE}/api/export?kind=rectify&videoId=not-exist`);
ok('不存在的 videoId 返回 400', bad2.status === 400, `status=${bad2.status}`);

const failed = checks.filter((c) => !c.cond);
console.log(`\n===== 导出验证：${checks.length - failed.length}/${checks.length} 项通过 ${failed.length ? '✗' : '✓'} =====`);
if (failed.length) { failed.forEach((f) => console.log(`  失败: ${f.name}`)); process.exit(1); }
