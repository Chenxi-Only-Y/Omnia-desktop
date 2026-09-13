import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readZip } = require_('../dist/main/xlsx.js');

const zip = readZip(fs.readFileSync('D:/AI/ds.5/work/LIS_original.xlsx'));
const x = zip.get('xl/worksheets/sheet3.xml').toString('utf8');
console.log('sheet3 长度', x.length);

const marker = '<row r="5"';
const i = x.indexOf(marker);
console.log('row5 位置', i);
console.log('--- 原始 row5 片段（900 字符）---');
console.log(x.slice(i, i + 900));

const b5 = (x.match(/r="B5"/g) || []).length;
const c5 = (x.match(/r="C5"/g) || []).length;
console.log(`\nr="B5" 出现 ${b5} 次, r="C5" 出现 ${c5} 次`);

// 关键对照：A5 后面紧跟的是 B5 还是 C5
const seg = x.slice(i, i + 300);
console.log('\nA5 之后的前 3 个 cell 引用：',
  JSON.stringify([...seg.matchAll(/r="([A-Z]+\d+)"/g)].map((m) => m[1]).slice(0, 5)));
