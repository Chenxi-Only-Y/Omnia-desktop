import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readZip, readXlsx } = require_('../dist/main/xlsx.js');

const PATH = 'D:/AI/ds.5/work/LIS_original.xlsx';
const buf = fs.readFileSync(PATH);

// ① 用 readZip 拿 sst，按 readXlsx 完全相同的方式构建
const zip = readZip(buf);
const sstXml = zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
const sstA = [];
{
  const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(sstXml))) {
    let out = '';
    const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tre.exec(m[1]))) out += tm[1];
    sstA.push(out);
  }
}
console.log('① readZip 路径：si 总数 =', sstA.length, ' sst[104] =', JSON.stringify(sstA[104]));

// ② 同一个 buf 走 readXlsx
const g = readXlsx(buf, { sheet: '信息数据库' });
console.log('② readXlsx 路径：row5[0..4] =', JSON.stringify(g[4].slice(0, 5)));

// ③ 直接按字节查 sheet3 里 C5 的类型属性
const sheet3 = zip.get('xl/worksheets/sheet3.xml').toString('utf8');
const c5 = sheet3.match(/<c r="C5"[^>]*>/)?.[0];
console.log('③ 原始 C5 标签 =', JSON.stringify(c5));

// ④ 把 readXlsx 内部逻辑逐行手抄一遍（用同一个 zip 对象）
const relsXml = zip.get('xl/_rels/workbook.xml.rels').toString('utf8');
const relMap = new Map();
for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap.set(m[1], m[2]);
const wb = zip.get('xl/workbook.xml').toString('utf8');
const tags = [...wb.matchAll(/<sheet[^>]*\/>/g)].map((m) => m[0]);
console.log('④ sheet 标签数 =', tags.length, ' 第3个 =', tags[2]);
const rid = tags[2].match(/\sr:id="([^"]+)"/)?.[1];
console.log('   r:id =', rid, ' → relMap =', relMap.get(rid));
console.log('   sst count 属性 =', sstXml.match(/count="(\d+)"/)?.[1], ' uniqueCount =', sstXml.match(/uniqueCount="(\d+)"/)?.[1]);
