/**
 * 自检脚本：构建后启动应用，跑一遍 renderer→preload→IPC→SQLite 全链路探针，
 * 并验证写操作（增/改/删）与重复 ID 拦截，最后按退出码报告结果。
 *
 * 用途：在没有人盯着窗口的情况下确认应用是真的能跑，而不是只看"编译通过"。
 * 用法：npm run smoke
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const isWin = process.platform === 'win32';
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', isWin ? 'electron.exe' : 'electron');

if (!fs.existsSync(electronBin)) {
  console.error('[smoke] 找不到 Electron 可执行文件：', electronBin);
  console.error('[smoke] 请先运行 `node scripts/fix-electron.mjs`（见 README 的安装说明）');
  process.exit(1);
}

const dataDir = path.join(ROOT, 'dev-data');
fs.mkdirSync(dataDir, { recursive: true });
// 每次自检都用全新库，避免上一轮探针数据影响断言
const dbFile = path.join(dataDir, 'smoke.db');
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(dbFile + suffix, { force: true });
}

const child = spawn(electronBin, ['.'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, OMNIA_SMOKE: '1', OMNIA_DB_PATH: dbFile },
});

let out = '';
child.stdout.on('data', (d) => { out += String(d); process.stdout.write(d); });
child.stderr.on('data', (d) => {
  const s = String(d);
  if (!s.includes('ExperimentalWarning') && !s.includes('--trace-warnings')) process.stderr.write(d);
});

child.on('exit', (code) => {
  const pass = code === 0 && out.includes('[smoke] 结果                : PASS');
  console.log('\n[smoke]', pass ? '全部通过 ✅' : `失败 ❌ (exit=${code})`);
  process.exit(pass ? 0 : 1);
});
