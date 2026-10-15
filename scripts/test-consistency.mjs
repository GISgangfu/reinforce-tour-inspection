// 校验隐患口径一致性：看板 / 视频列表 / 分析总结 / 导出文书 必须是同一个数字
const BASE = process.env.YZX_BASE || 'http://127.0.0.1:8899';
const get = async (u) => (await fetch(BASE + u)).json();

const checks = [];
const ok = (n, c, d = '') => { checks.push({ n, c }); console.log(`${c ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`); };

const dash = await get('/api/dashboard');
const { videos } = await get('/api/videos');
const v2 = videos.find((v) => v.id === 'vid-002');
const detail = await get('/api/videos/vid-002');

// 各处的隐患条数
const dashVideoRisk = v2.riskCount;
const detailRisk = detail.findings.filter((f) => f.categoryCode !== 'SAFE_PRACTICE' && f.categoryCode !== 'FIRE_EQUIP').length;
const positiveCount = detail.findings.filter((f) => f.categoryCode === 'SAFE_PRACTICE' || f.categoryCode === 'FIRE_EQUIP').length;

console.log('=== 隐患口径核对（vid-002）===');
console.log(`  视频列表 riskCount      : ${dashVideoRisk}`);
console.log(`  视频详情 隐患条数        : ${detailRisk}`);
console.log(`  正向记录条数             : ${positiveCount}`);
console.log(`  全部打标                 : ${detail.findings.length}`);

ok('视频列表与详情的隐患数一致', dashVideoRisk === detailRisk, `${dashVideoRisk} vs ${detailRisk}`);
ok('隐患数 + 正向记录数 = 打标总数', dashVideoRisk + positiveCount === detail.findings.length,
  `${dashVideoRisk}+${positiveCount}=${dashVideoRisk + positiveCount} vs ${detail.findings.length}`);

// 巡检记录表：隐患行数必须等于 riskCount，且正向记录单独成区
const rec = await (await fetch(`${BASE}/api/export?kind=record&videoId=vid-002`)).text();
const riskRows = (rec.match(/原始视频|\d\d:\d\d–\d\d:\d\d/g) || []).length;
const positiveSection = rec.includes('防护到位情况（正向记录）');
const fireInRiskTable = /消防器材配置状态[\s\S]{0,400}?<\/table>/.test(rec);

console.log('\n=== 巡检记录表 ===');
ok('含正向记录分区', positiveSection);
// 统计"一、发现的安全隐患"表格里的数据行数
const riskTable = rec.split('一、发现的安全隐患')[1]?.split('</table>')[0] || '';
const riskRowCount = (riskTable.match(/<tr>\s*<td>\d+<\/td>/g) || []).length;
ok('记录表隐患行数 = 隐患条数', riskRowCount === detailRisk, `表格 ${riskRowCount} 行 vs 隐患 ${detailRisk} 条`);

// 整改单：不能含正向记录，行数也必须一致
const rect = await (await fetch(`${BASE}/api/export?kind=rectify&videoId=vid-002`)).text();
const rectNo = (rect.match(/class="f-no"/g) || []).length;
console.log('\n=== 隐患整改通知单 ===');
ok('整改单项数 = 隐患条数', rectNo === detailRisk, `${rectNo} 项 vs ${detailRisk} 条`);
ok('整改单不含消防正向记录', !rect.includes('灭火器已配置') && !rect.includes('消防棚'));
ok('整改单不含正向记录字样', !rect.includes('防护到位'));

// 分析总结口径
const { videos: vs2 } = await get('/api/videos');
console.log('\n=== 全库汇总 ===');
console.log(`  看板隐患总数(riskFindings) : ${dash.kpi.riskFindings}`);
const totalRisk = videos.reduce((n, v) => n + v.riskCount, 0);
ok('看板隐患总数 = 各视频隐患之和', dash.kpi.riskFindings === totalRisk, `${dash.kpi.riskFindings} vs ${totalRisk}`);

const failed = checks.filter((c) => !c.c);
console.log(`\n===== 口径一致性：${checks.length - failed.length}/${checks.length} 项通过 ${failed.length ? '✗' : '✓'} =====`);
if (failed.length) { failed.forEach((f) => console.log('  失败: ' + f.n)); process.exit(1); }
