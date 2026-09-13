import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readZip } = require_('../dist/main/xlsx.js');

const p = path.resolve(process.cwd(), '..', 'work', 'LIS_v1.0.xlsx');
const buf = fs.readFileSync(p);
const zip = readZip(buf);

console.log('=== zip 条目（xl 下） ===');
for (const k of zip.keys()) if (k.startsWith('xl/') && !k.includes('media')) console.log(' ', k, zip.get(k).length);

const wb = zip.get('xl/workbook.xml').toString('utf8');
const rels = zip.get('xl/_rels/workbook.xml.rels').toString('utf8');

console.log('\n=== workbook.xml 前 1200 字 ===');
console.log(wb.slice(0, 1200));
console.log('\n=== rels 全部 Relationship ===');
for (const m of rels.matchAll(/<Relationship[^>]*\/>/g)) console.log(' ', m[0]);

console.log('\n=== 各 sheet xml 的 A5/C5/D5 附近的 shared 索引 ===');
for (const f of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml', 'xl/worksheets/sheet4.xml']) {
  const x = zip.get(f)?.toString('utf8') ?? '(缺失)';
  if (x === '(缺失)') { console.log(' ', f, x); continue; }
  // 抓第 5 行
  const rowMatch = x.match(/<row[^>]*r="5"[^>]*>([\s\S]*?)<\/row>/);
  console.log(' ', f, 'dimension=', x.match(/<dimension ref="([^"]+)"/)?.[1]);
  console.log('    row5 =', (rowMatch?.[1] ?? '').slice(0, 300));
}

console.log('\n=== sharedStrings 前 8 条 ===');
const sst = zip.get('xl/sharedStrings.xml').toString('utf8');
const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
let m2, i = 0;
while ((m2 = re.exec(sst)) && i < 8) {
  const t = [...m2[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
  console.log(`  [${i}] ${t}`);
  i++;
}
console.log('  si 总数 =', [...sst.matchAll(/<si[^>]*>/g)].length);
