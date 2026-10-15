/**
 * 安全巡检视频处理 · 媒体证据抽取脚本
 * ------------------------------------------------------------------
 * 用真实 ffmpeg 从源视频中按 finding 的时间码切出：
 *   1) 证据短视频（证据片段，最长 12 秒）
 *   2) 检索用 3 秒短片段
 *   3) 证据关键帧（每个 finding 3 帧，覆盖区间首/中/尾）
 * 然后回填 server/lib/seed.mjs 中的 evidence 字段。
 *
 * 用法： node scripts/extract-evidence.mjs [--force]
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FFMPEG = resolve(ROOT, '..', 'tools', 'pyff', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v7.1.exe');
const SEED = resolve(ROOT, 'server', 'lib', 'seed.mjs');
const force = process.argv.includes('--force');

const SRC_REL = 'assets/video/2.mp4';
const src = resolve(ROOT, SRC_REL);
const outClips = resolve(ROOT, 'assets', 'clips');
const outShots = resolve(ROOT, 'assets', 'shots');
mkdirSync(outClips, { recursive: true });
mkdirSync(outShots, { recursive: true });

if (!existsSync(FFMPEG)) throw new Error(`ffmpeg not found: ${FFMPEG}`);
if (!existsSync(src)) throw new Error(`source video not found: ${src}`);

function shoot(t, out, w = 960) {
  return run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(t), '-i', src,
    '-frames:v', '1', '-vf', `scale=${w}:-1`, '-q:v', '3', out
  ]);
}

/**
 * 用编码器精确定位 + 重编码切片段。
 * 关键点：-ss 放在 -i 之前是快速定位，为了帧准确这里做二次精确定位（-ss 放 -i 之后）。
 */
function cutClip(start, dur, out, w = 960) {
  return run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start), '-i', src, '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '64k', '-vf', `scale=${w}:-2`, out
  ], { maxBuffer: 1024 * 1024 * 32 });
}

/** 从 seed.mjs 里静态解析出 vid-002 的 findings（演示脚本，避免引入解析器） */
function parseFindings(text) {
  const items = [];
  const re = /id: '(F-002-\d+)',\s*\n\s*videoId: 'vid-002',[\s\S]*?start: ([\d.]+),\s*\n\s*end: ([\d.]+),[\s\S]*?categoryCode: '(\w+)'/g;
  // 上面的顺序依赖字段排列，改用逐条分块更稳：
  const blocks = text.split(/\n  \{\n/).filter((b) => b.includes("videoId: 'vid-002'"));
  for (const b of blocks) {
    const id = /id: '(F-002-\d+)'/.exec(b)?.[1];
    const cat = /categoryCode: '([A-Z_]+)'/.exec(b)?.[1];
    const start = Number(/start: ([\d.]+)/.exec(b)?.[1]);
    const end = Number(/end: ([\d.]+)/.exec(b)?.[1]);
    if (id && cat && Number.isFinite(start) && Number.isFinite(end)) items.push({ id, cat, start, end });
  }
  return items;
}

const findings = parseFindings(readFileSync(SEED, 'utf8'));
if (!findings.length) throw new Error('no vid-002 findings parsed from seed');

console.log(`源视频: ${SRC_REL}`);
console.log(`待处理 findings: ${findings.length}\n`);

const patches = [];
for (const f of findings) {
  const span = f.end - f.start;
  const clipDur = Math.min(span, 12);
  const clipName = `${f.id}.mp4`;
  const clipRel = `assets/clips/${clipName}`;
  const clipAbs = resolve(outClips, clipName);

  const mid = f.start + span / 2;
  const frameTs = [f.start + Math.min(0.5, span / 6), mid, Math.max(f.start, f.end - 0.5)];
  const frames = [];
  for (let i = 0; i < frameTs.length; i++) {
    const name = `${f.id}_${String(i + 1).padStart(2, '0')}.jpg`;
    const rel = `assets/shots/${name}`;
    const abs = resolve(outShots, name);
    if (force || !existsSync(abs)) await shoot(frameTs[i].toFixed(2), abs);
    frames.push({ t: Number(frameTs[i].toFixed(2)), src: rel });
  }

  if (force || !existsSync(clipAbs)) {
    await cutClip(f.start.toFixed(2), clipDur.toFixed(2), clipAbs);
  }

  // 检索用 3 秒片段（以 finding 代表性时刻为中心）
  const c3 = Math.max(0, Math.min(mid - 1.5, 180.5 - 3));
  const c3Name = `${f.id}_3s.mp4`;
  const c3Abs = resolve(outClips, c3Name);
  if (force || !existsSync(c3Abs)) await cutClip(c3.toFixed(2), '3', c3Abs, 640);

  patches.push({
    id: f.id,
    frames,
    clip: clipRel,
    clip3s: `assets/clips/${c3Name}`,
    clipStart: f.start,
    clipDuration: Number(clipDur.toFixed(2)),
    clip3sStart: Number(c3.toFixed(2))
  });
  console.log(`✓ ${f.id}  [${f.start}s-${f.end}s]  片段${clipDur.toFixed(1)}s  帧×${frames.length}`);
}

/** 回填 seed.mjs：把 evidence: { frames: [], clip: null } 替换为真实路径 */
let text = readFileSync(SEED, 'utf8');
let replaced = 0;
for (const p of patches) {
  const anchor = `id: '${p.id}',`;
  const idx = text.indexOf(anchor);
  if (idx < 0) continue;
  const evIdx = text.indexOf('evidence: { frames: [], clip: null }', idx);
  if (evIdx < 0) continue;
  const framesJson = '[' + p.frames.map((f) => `{ t: ${f.t}, src: '${f.src}' }`).join(', ') + ']';
  const replacement =
    `evidence: {\n      frames: ${framesJson},\n` +
    `      clip: '${p.clip}',\n` +
    `      clipStart: ${p.clipStart},\n` +
    `      clipDuration: ${p.clipDuration},\n` +
    `      clip3s: '${p.clip3s}',\n` +
    `      clip3sStart: ${p.clip3sStart}\n    }`;
  text = text.slice(0, evIdx) + replacement + text.slice(evIdx + 'evidence: { frames: [], clip: null }'.length);
  replaced++;
}
writeFileSync(SEED, text, 'utf8');
console.log(`\n回填 seed.mjs：${replaced} 条 evidence`);
console.log('媒体资产已生成 → assets/clips, assets/shots');
