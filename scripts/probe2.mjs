import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readXlsx, listSheets } = require_('../dist/main/xlsx.js');

const p = path.resolve(process.cwd(), '..', 'work', 'LIS_v1.0.xlsx');
const buf = fs.readFileSync(p);

console.log('listSheets:', JSON.stringify(listSheets(buf), null, 0));

for (const name of ['信息数据库', '数据导入']) {
  try {
    const g = readXlsx(buf, { sheet: name, maxRows: 7 });
    console.log(`\n[${name}] 行数=${g.length} 列数=${g[0]?.length}`);
    g.forEach((r, i) => console.log(`  r${i + 1}:`, JSON.stringify(r.slice(0, 6))));
  } catch (e) {
    console.log(`\n[${name}] 抛错: ${e.message}`);
  }
}

// 直接按序号读，确认 sheet3 内容
const g3 = readXlsx(buf, { sheet: 2, maxRows: 7 });
console.log('\n[序号 2 = 第 3 张表] 行数=', g3.length);
g3.forEach((r, i) => console.log(`  r${i + 1}:`, JSON.stringify(r.slice(0, 6))));
