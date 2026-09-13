import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { readZip } = require_('../dist/main/xlsx.js');

const zip = readZip(fs.readFileSync('D:/AI/ds.5/work/LIS_original.xlsx'));
const sstXml = zip.get('xl/sharedStrings.xml').toString('utf8');

// 复刻 readXlsx 的 si 正则
const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
const sst = [];
let m;
while ((m = re.exec(sstXml))) {
  let out = '';
  const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let tm;
  while ((tm = tre.exec(m[1]))) out += tm[1];
  sst.push(out);
}
console.log('si 总数 =', sst.length);
console.log('\n索引 100~120 的内容：');
for (let i = 100; i <= 120 && i < sst.length; i++) {
  console.log(`  [${i}] ${JSON.stringify(sst[i])}`);
}

// 那些看起来像"数字"的条目，是不是真的数字
const numeric = sst.map((v, i) => [i, v]).filter(([, v]) => /^\d+$/.test(v));
console.log('\n纯数字条目数 =', numeric.length, ' 前 12 个：', JSON.stringify(numeric.slice(0, 12)));

// 找 '入帮排序' 的真实索引
console.log("\n'入帮排序' 的索引 =", sst.indexOf('入帮排序'));
console.log("'角色ID' 的索引 =", sst.indexOf('角色ID'));
console.log("'填表' 的索引 =", sst.indexOf('填表'));

console.log('\nsharedStrings 原始片段（前 400 字符）：');
console.log(sstXml.slice(0, 400));
