import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readZip, readXlsx } = require_('../dist/main/xlsx.js');

const buf = fs.readFileSync(path.resolve(process.cwd(), '..', 'work', 'LIS_v1.0.xlsx'));
const zip = readZip(buf);

// 复刻 readXlsx 里的 colToIndex / ATTR
const ATTR = (chunk, name) => {
  const m = chunk.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};
const colToIndex = (ref) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
console.log('colToIndex 自检: A5->', colToIndex('A5'), ' C5->', colToIndex('C5'),
  ' E5->', colToIndex('E5'), ' AA1->', colToIndex('AA1'));
console.log('ATTR 自检:', JSON.stringify(ATTR(' r="C5" s="332" t="s"', 'r')));

// 手工解析 sheet3 第 5 行
const xml = zip.get('xl/worksheets/sheet3.xml').toString('utf8');
const rowRe = /<row([^>]*)>([\s\S]*?)<\/row>/g;
let rm, found = 0;
while ((rm = rowRe.exec(xml))) {
  const decl = Number(ATTR(rm[1] ?? '', 'r'));
  if (decl !== 5 && decl !== 6) continue;
  found++;
  console.log(`\n=== <row r="${decl}"> 属性串 = ${JSON.stringify(rm[1])} ===`);
  const cellRe = /<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let cm;
  while ((cm = cellRe.exec(rm[2]))) {
    const attrs = cm[1] ?? '';
    const ref = ATTR(attrs, 'r');
    if (!ref) continue;
    const ci = colToIndex(ref);
    if (ci > 8) continue;
    const type = ATTR(attrs, 't') ?? '';
    const v = (cm[2] ?? '').match(/<v>([\s\S]*?)<\/v>/)?.[1];
    console.log(`  ${ref} -> 列索引 ${ci}, t=${type || '(无)'}, v=${v ?? '(无)'}`);
  }
}
console.log('\n匹配到的行数', found);
