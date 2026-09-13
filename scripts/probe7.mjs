import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readXlsx } = require_('../dist/main/xlsx.js');

const buf = fs.readFileSync('D:/AI/ds.5/work/LIS_original.xlsx');
const g = readXlsx(buf, { sheet: '信息数据库' });

console.log('总行数', g.length);
const row5 = g[4];
console.log('row5 长度', row5.length);
console.log('\nrow5 全部非空（索引: 字符码: 值）:');
row5.forEach((v, i) => {
  if (v !== '') console.log(`  [${i}] codes=${[...v].map((c) => c.charCodeAt(0)).join(',')} value=${JSON.stringify(v)}`);
});

console.log('\nrow6 全部非空:');
(g[5] ?? []).forEach((v, i) => {
  if (v !== '') console.log(`  [${i}] value=${JSON.stringify(v)}`);
});
