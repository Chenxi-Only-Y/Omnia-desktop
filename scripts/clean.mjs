/** 清空构建产物（跨平台，不依赖 shell 命令） */
import fs from 'node:fs';
import path from 'node:path';

const targets = ['dist', 'release'];

for (const t of targets) {
  const p = path.join(process.cwd(), t);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log('[clean] 已删除', t);
  }
}
