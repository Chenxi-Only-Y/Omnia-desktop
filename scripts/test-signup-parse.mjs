/** 用真实报名样本验证解析器（readXlsx → parseSignupGrid）。 */
import fs from 'node:fs';
import { readXlsx } from '../dist/main/xlsx.js';
import { parseSignupGrid } from '../dist/shared/signupImport.js';

const file = process.argv[2] ?? 'dev-data/报名样本.xlsx';
const grid = readXlsx(fs.readFileSync(file));
const p = parseSignupGrid(grid);

console.log('表头行索引:', p.headerRow);
console.log('识别列:', p.headers.join(' | '));
console.log('有效行数:', p.rows.length);
console.log('无效行:', JSON.stringify(p.invalid));
console.log('重复报名:', JSON.stringify(p.duplicates));

const join = p.rows.filter((r) => r.status === 'JOIN').length;
const leave = p.rows.filter((r) => r.status === 'LEAVE').length;
console.log('参加:', join, ' 请假:', leave);

console.log('\n前 8 条:');
for (const r of p.rows.slice(0, 8)) {
  console.log(`  行${String(r.line).padStart(3)} ${r.gameId.padEnd(14)} ${r.status.padEnd(5)} 麦=${r.mic || '—'} 主=${r.mainClass || '—'} 副=${r.subClass || '—'}`);
}

// 抽查特殊 ID 与请假行
const odd = p.rows.filter((r) => /[（）！]/.test(r.gameId));
console.log('\n含全角括号/感叹号的 ID:', odd.map((r) => r.gameId).join(' / '));
const leaveRows = p.rows.filter((r) => r.status === 'LEAVE');
console.log('请假行（职业应为空）:', leaveRows.map((r) => `${r.gameId}[${r.mainClass}|${r.subClass}|${r.mic}]`).join(' '));

// 单调性断言
const problems = [];
if (p.headerRow !== 0) problems.push('表头行索引应为 0（0 基）');
if (p.rows.length !== 68) problems.push(`有效行应为 68，实际 ${p.rows.length}`);
if (join + leave !== p.rows.length) problems.push('参加+请假 != 总数');
if (leaveRows.some((r) => r.mainClass || r.subClass)) problems.push('请假行不该有职业');
if (p.duplicates.length) problems.push('样本不该有重复报名');
console.log('\n判定:', problems.length ? 'FAIL ' + problems.join('；') : 'PASS');
process.exit(problems.length ? 1 : 0);
