import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readXlsx } = require_('../dist/main/xlsx.js');

const buf = fs.readFileSync(path.resolve(process.cwd(), '..', 'work', 'LIS_v1.0.xlsx'));
const g = readXlsx(buf, { sheet: '信息数据库' });
console.log('总行数', g.length, '总列数', g[0].length);

for (const ri of [4, 5, 6, 84, 85]) {
  const row = g[ri] ?? [];
  console.log(`\n--- 工作表第 ${ri + 1} 行 ---`);
  const nonEmpty = row.map((v, i) => [i, v]).filter(([, v]) => v !== '');
  console.log('非空单元格数', nonEmpty.length);
  console.log(JSON.stringify(nonEmpty.slice(0, 12)));
}

// 独立统计：A 列与 C 列的非空数量
let a = 0, c = 0;
for (let r = 5; r < g.length; r++) {
  if ((g[r]?.[0] ?? '') !== '') a++;
  if ((g[r]?.[2] ?? '') !== '') c++;
}
console.log('\nA 列(索引0) 非空行数(从第6行起)', a, ' C 列(索引2) 非空行数', c);
console.log('第6行的前 12 列：', JSON.stringify((g[5] ?? []).slice(0, 12)));
