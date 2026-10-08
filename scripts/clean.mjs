/**
 * 清空构建产物（跨平台，不依赖 shell 命令）
 *
 * ⚠️ `release/` **默认不删**（2026-10-08 修）：
 *   它里面是已经打好、要往 GitHub Release 上传的 `Omnia-Setup-<版本>.exe`（约 110 MB），
 *   而 `release/` 在 .gitignore 里 —— 删掉就**找不回来**，只能重新跑一遍 `npm run dist`。
 *   原先 `npm run build`（以及 `npm run smoke`）都会顺手把它删掉，
 *   本项目已经因此丢过一次安装包。所以：
 *     · `npm run build` / `npm run smoke` → 只清 `dist`（默认行为）
 *     · 打完包要重来 → `npm run clean:release`
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const withRelease = args.includes('--release') || args.includes('--all');

const targets = withRelease ? ['dist', 'release'] : ['dist'];

for (const t of targets) {
  const p = path.join(process.cwd(), t);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log('[clean] 已删除', t);
  }
}

if (!withRelease) {
  const rel = path.join(process.cwd(), 'release');
  if (fs.existsSync(rel)) {
    console.log('[clean] 保留 release/（安装包在这里；要一起删用 npm run clean:release）');
  }
}
