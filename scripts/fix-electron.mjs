/**
 * 万象·Omnia —— 修复 Electron 二进制安装（npm 11 拦截 postinstall 时的必备步骤）
 *
 * 背景：npm 11 默认不执行依赖的 install/postinstall 脚本，导致 electron 包里的
 * dist/electron.exe 从未被下载展开，运行时报 "Electron failed to install correctly"。
 * 另外本环境下 electron 自带的 extract-zip 会静默失败（只解出 locales/ 就退出），
 * 所以这里用系统自带的解压能力兜底。
 *
 * 用法：node scripts/fix-electron.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const isWin = process.platform === 'win32';
const electronDir = path.join(ROOT, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const exeName = isWin ? 'electron.exe' : 'electron';
const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

if (!fs.existsSync(electronDir)) {
  console.error('[fix] 未找到 node_modules/electron，请先执行 npm install');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf-8')).version;
console.log('[fix] Electron 版本:', version);

if (fs.existsSync(path.join(distDir, exeName))) {
  console.log('[fix] 二进制已存在，无需修复:', path.join(distDir, exeName));
  ensurePathTxt();
  process.exit(0);
}

// 步骤 1：让官方安装脚本尝试下载（缓存缺失时会走镜像）
console.log('[fix] 尝试官方安装脚本 …');
const r = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: MIRROR },
});
if (fs.existsSync(path.join(distDir, exeName))) {
  console.log('[fix] 官方脚本成功');
  ensurePathTxt();
  process.exit(0);
}
console.log('[fix] 官方脚本未产出可执行文件（exit=%s），改用缓存 zip 手动展开', r.status);

// 步骤 2：从缓存里找 zip
const cacheRoot = path.join(process.env.LOCALAPPDATA || process.env.HOME || '', 'electron', 'Cache');
if (!fs.existsSync(cacheRoot)) {
  console.error('[fix] 找不到 Electron 缓存目录:', cacheRoot);
  console.error('[fix] 请手动下载 https://npmmirror.com/mirrors/electron/v%s/electron-v%s-%s-%s.zip',
    version, version, process.platform, process.arch);
  process.exit(1);
}

const zips = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.zip') && e.name.includes(`${process.platform}-${process.arch}`)) zips.push(p);
  }
})(cacheRoot);

if (!zips.length) {
  console.error('[fix] 缓存中没有匹配 %s-%s 的 zip', process.platform, process.arch);
  process.exit(1);
}

const zip = zips.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
console.log('[fix] 使用 zip:', zip, `(${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

if (isWin) {
  // PowerShell 的 Expand-Archive 在本环境可用；tar 在 Win10+ 也自带，作兜底
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${distDir}' -Force`,
    ], { stdio: 'inherit' });
  } catch {
    console.log('[fix] Expand-Archive 失败，改用 tar …');
    execFileSync('tar', ['-xf', zip, '-C', distDir], { stdio: 'inherit' });
  }
} else {
  execFileSync('unzip', ['-o', zip, '-d', distDir], { stdio: 'inherit' });
}

if (!fs.existsSync(path.join(distDir, exeName))) {
  console.error('[fix] 展开后仍找不到', exeName);
  process.exit(1);
}
ensurePathTxt();
console.log('[fix] 完成 ✅  ' + path.join(distDir, exeName));

/** electron/index.js 通过 path.txt 定位可执行文件 */
function ensurePathTxt() {
  const pathTxt = path.join(electronDir, 'path.txt');
  const rel = isWin
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron';
  fs.writeFileSync(pathTxt, rel, 'ascii');
  console.log('[fix] 写入 path.txt =', rel);
}
