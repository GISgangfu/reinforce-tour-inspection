// 语法校验：用 vm.SourceTextModule 直接解析 UTF-8 源码（不执行、不解析依赖）
// 运行： node --experimental-vm-modules scripts/check.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'server/config.mjs',
  'server/index.mjs', 'server/lib/app.mjs', 'server/lib/vision.mjs',
  'server/lib/query.mjs', 'server/lib/taxonomy.mjs', 'server/lib/seed.mjs',
  'server/lib/export.mjs',
  'web/js/main.js', 'web/js/ui.js', 'web/js/api.js',
  'web/js/pages/dashboard.js', 'web/js/pages/review.js', 'web/js/pages/analyze.js',
  'web/js/pages/search.js', 'web/js/pages/devices.js', 'web/js/pages/videos.js',
  'scripts/extract-evidence.mjs', 'scripts/test-upload.mjs'
];

let bad = 0;
for (const f of files) {
  const src = readFileSync(resolve(ROOT, f), 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: f });
    console.log(`OK     ${f}  (${(src.length / 1024).toFixed(1)} KB · ${src.split('\n').length} 行)`);
  } catch (e) {
    bad++;
    console.log(`FAIL   ${f}\n       ${e.message}`);
  }
}
console.log(bad ? `\n✗ ${bad} 个文件存在语法错误` : `\n✓ 全部 ${files.length} 个文件语法校验通过`);
process.exit(bad ? 1 : 0);
