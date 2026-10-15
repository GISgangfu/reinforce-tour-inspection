/**
 * 判断并移除"英文名别名链接"（目录联接）
 * ==================================================================
 * 为什么不用 Node 的内置判断：
 *   fs.lstatSync(p).isSymbolicLink() 对 Windows 目录联接（mklink /J）
 *   返回 **false**，fs.readlinkSync 报 EINVAL —— 实测确认，Node 认不出联接。
 * 为什么不用 `dir /a:l | findstr JUNCTION`：
 *   输出随系统界面语言/代码页变化，实测在当前环境误判为"真实目录"。
 *
 * 可靠判据：文件属性含 ReparsePoint，且 LinkType 为 Junction/SymbolicLink。
 * 这里借 PowerShell 读取属性（它不受界面语言影响），再由本脚本执行删除。
 *
 * 安全约束：只删"确定是链接"的对象；真实目录一律不删（无论空与否）。
 *
 * 用法： node scripts/remove-alias-link.mjs <路径>
 * 输出： REMOVED_LINK | NOT_EXISTS | REAL_DIR | REAL_FILE | REMOVE_FAILED:<code> | UNKNOWN
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('用法： node scripts/remove-alias-link.mjs <路径>');
  process.exit(2);
}
const target = resolve(arg);

if (!existsSync(target)) { console.log('NOT_EXISTS'); process.exit(0); }

/** 用 PowerShell 读取 LinkType / 属性里的 ReparsePoint */
function probeLink(p) {
  const ps = [
    '$ErrorActionPreference="Stop"',
    `$i = Get-Item -LiteralPath '${p.replace(/'/g, "''")}' -Force`,
    '$lt = ""',
    'try { $lt = [string]$i.LinkType } catch {}',
    '$rp = ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0',
    'Write-Output ("LINKTYPE=" + $lt)',
    'Write-Output ("REPARSE=" + $rp)'
  ].join('; ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const lt = (/LINKTYPE=(.*)/.exec(out)?.[1] || '').trim();
    const rp = (/REPARSE=(True|False)/i.exec(out)?.[1] || '').toLowerCase() === 'true';
    return { linkType: lt, reparse: rp };
  } catch (e) {
    return { linkType: '', reparse: false, error: e.code || e.message };
  }
}

const info = probeLink(target);
const isLink = info.reparse || /Junction|SymbolicLink/i.test(info.linkType);

if (!isLink) {
  let isDir = false;
  try { isDir = lstatSync(target).isDirectory(); } catch { /* ignore */ }
  console.log(isDir ? 'REAL_DIR' : 'REAL_FILE');
  process.exit(0);
}

// 是链接：目录联接用 rmdirSync（不递归，绝不会删掉目标里的内容）
try {
  let isDir = false;
  try { isDir = lstatSync(target).isDirectory(); } catch { /* ignore */ }
  if (isDir) rmdirSync(target); else unlinkSync(target);
  console.log('REMOVED_LINK');
  process.exit(0);
} catch (e) {
  console.log(`REMOVE_FAILED:${e.code || e.message}`);
  process.exit(1);
}
