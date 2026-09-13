/**
 * 开发启动器（万象·Omnia）：先起 Vite dev server，等它就绪后再拉起 Electron。
 * 子进程一律 stdio: 'inherit'，避免受限环境下管道 EPERM。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const URL = 'http://127.0.0.1:5173';
const isWin = process.platform === 'win32';

const electronBin = path.join(
  ROOT, 'node_modules', 'electron', 'dist',
  isWin ? 'electron.exe' : 'electron',
);
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** node 内置 fetch（Node 18+），失败重试直到超时 */
async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

console.log('[dev] 启动 Vite dev server …');
const vite = spawn(process.execPath, [viteBin], {
  cwd: ROOT, stdio: 'inherit', env: process.env,
});
vite.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error('[dev] Vite 退出，code =', code);
    process.exit(code);
  }
});

const ready = await waitForServer(URL);
if (!ready) {
  console.error(`[dev] Vite 未在超时时间内就绪：${URL}`);
  vite.kill();
  process.exit(1);
}
console.log('[dev] Vite 就绪，启动 Electron …');

const electron = spawn(electronBin, ['.'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, OMNIA_DEV_SERVER_URL: URL },
});

const shutdown = () => {
  try { electron.kill(); } catch { /* ignore */ }
  try { vite.kill(); } catch { /* ignore */ }
};
electron.on('exit', (code) => {
  shutdown();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
