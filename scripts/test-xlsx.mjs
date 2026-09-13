/**
 * xlsx 模块自测：
 *  1) 读取真实的旧表 `LIS 联赛集成系统v1.0.xlsx`（8.3MB、含图片与大量共享字符串），
 *     确认自写解析器能正确还原「信息数据库」成员名单与「数据导入」战报表头；
 *  2) 写入 → 读回 往返一致（含中文、大数字、空单元格）。
 *
 * 用法：node scripts/test-xlsx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { readXlsx, readXlsxTable, listSheets, writeXlsx } = require_('../dist/main/xlsx.js');

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

// ── 1) 读真实旧表 ────────────────────────────────────────────────
const CANDIDATES = [
  path.resolve(process.cwd(), '..', 'work', 'LIS_v1.0.xlsx'),
  path.resolve(process.cwd(), '..', 'LIS 联赛集成系统v1.0.xlsx'),
];
const sample = CANDIDATES.find((p) => fs.existsSync(p));

console.log('【1】读取真实旧表');
if (!sample) {
  console.log('  ⏭  找不到样本文件，跳过（可把旧表放到 work/LIS_v1.0.xlsx）');
} else {
  const t0 = Date.now();
  const buf = fs.readFileSync(sample);
  const sheets = listSheets(buf);
  console.log(`  文件 ${(buf.length / 1048576).toFixed(1)}MB，解析耗时 ${Date.now() - t0}ms`);
  console.log('  工作表：', sheets.map((s) => s.name).join(' / '));
  check('识别出 10 张工作表', sheets.length === 10, `实际 ${sheets.length}`);
  check('含「信息数据库」', sheets.some((s) => s.name === '信息数据库'));
  check('含「数据导入」', sheets.some((s) => s.name === '数据导入'));

  // 信息数据库：A5 入帮排序 / C5 角色ID，数据从第 6 行开始
  const info = readXlsx(buf, { sheet: '信息数据库' });
  check('信息数据库行数 ≥ 90', info.length >= 90, `实际 ${info.length}`);
  check('A5 = 入帮排序', info[4]?.[0] === '入帮排序', `实际「${info[4]?.[0]}」`);
  check('C5 = 角色ID', info[4]?.[2] === '角色ID', `实际「${info[4]?.[2]}」`);
  check('A6 = 1', info[5]?.[0] === '1', `实际「${info[5]?.[0]}」`);
  check('C6 是非空姓名', !!info[5]?.[2], `实际「${info[5]?.[2]}」`);

  const names = info.slice(5).map((r) => (r[2] ?? '').trim()).filter(Boolean);
  console.log(`  解析出成员 ${names.length} 人，前 3 个：${names.slice(0, 3).join('、')}`);
  check('成员数 ≥ 79', names.length >= 79, `实际 ${names.length}`);

  // 战报：第 5 行是旧表的杂项，第 6 行才是表头，第 7 行起是数据
  // （列从 B 开始：B=玩家名字, C=职业, D=击败/清泉 … O=焚骨）
  const table = readXlsxTable(buf, { sheet: '数据导入', maxRows: 8, headerRow: 6 });
  console.log('  数据导入表头：', table.headers.filter(Boolean).slice(0, 16).join(' | '));
  check('表头含「玩家名字」', table.headers.includes('玩家名字'));
  check('表头含「击败/清泉」', table.headers.includes('击败/清泉'));
  check('表头含「焚骨」', table.headers.includes('焚骨'));
  check('表头含「对建筑伤害」', table.headers.includes('对建筑伤害'));

  const grid = readXlsx(buf, { sheet: '数据导入', maxRows: 8 });
  check('B5 = 霜序客（旧表杂项行）', (grid[4]?.[1] ?? '') === '霜序客', `实际「${grid[4]?.[1]}」`);
  check('B6 = 玩家名字（表头行）', (grid[5]?.[1] ?? '') === '玩家名字', `实际「${grid[5]?.[1]}」`);
  check('B7 是玩家名', !!(grid[6]?.[1] ?? ''), `实际「${grid[6]?.[1]}」`);
  check('C7 是职业', (grid[6]?.[2] ?? '').length > 0, `实际「${grid[6]?.[2]}」`);
  check('D7 形如 25/1', /^\s*\d+\s*\/\s*\d+\s*$/.test(grid[6]?.[3] ?? ''), `实际「${grid[6]?.[3]}」`);
  check('R5 = 提交时间（自动）', (grid[4]?.[17] ?? '') === '提交时间（自动）', `实际「${grid[4]?.[17]}」`);
}

// ── 2) 写入 → 读回 ──────────────────────────────────────────────
console.log('\n【2】写入 → 读回 往返');
const payload = {
  name: '成员主档',
  headers: ['入帮排序', '角色ID', '玩家名字', '主职业', '麦克风', '备注'],
  rows: [
    [1, '10001', '测试甲', '神相', '有', '指挥'],
    [2, '10002', '测试乙-带,逗号与"引号"', '素问', '无', ''],
    [3, '', '测试丙', '潮光', '有', '含\n换行'],
    [4, '10004', '大数字', '碎梦', '有', 12345678901],
  ],
  widths: [10, 12, 24, 10, 8, 20],
};
const out = writeXlsx(payload);
fs.mkdirSync(path.resolve(process.cwd(), 'dev-data'), { recursive: true });
const outPath = path.resolve(process.cwd(), 'dev-data', 'xlsx-roundtrip.xlsx');
fs.writeFileSync(outPath, out);
console.log(`  生成 ${outPath}（${(out.length / 1024).toFixed(1)}KB）`);

const back = readXlsxTable(out, { sheet: '成员主档' });
check('工作表名保留', listSheets(out)[0].name === '成员主档');
check('表头一致', JSON.stringify(back.headers) === JSON.stringify(payload.headers),
  back.headers.join(','));
check('行数一致', back.rows.length === payload.rows.length, `实际 ${back.rows.length}`);
check('中文往返正确', back.rows[0]['玩家名字'] === '测试甲');
check('含逗号引号往返正确', back.rows[1]['玩家名字'] === '测试乙-带,逗号与"引号"',
  `实际「${back.rows[1]['玩家名字']}」`);
check('含换行往返正确', back.rows[2]['备注'] === '含\n换行', JSON.stringify(back.rows[2]['备注']));
check('空单元格为空串', back.rows[2]['角色ID'] === '', `实际「${back.rows[2]['角色ID']}」`);
check('大数字往返正确', back.rows[3]['备注'] === '12345678901', `实际「${back.rows[3]['备注']}」`);
check('数字列保持数字', back.rows[0]['入帮排序'] === '1', `实际「${back.rows[0]['入帮排序']}」`);

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
