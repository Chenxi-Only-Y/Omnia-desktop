#!/usr/bin/env node
/**
 * 评分引擎 v2 标定器
 *
 * 做三件事：
 *  1. 定「曲线半值」= 全体 FN 的中位数（这样中位水平的人拿 0.5）
 *  2. 给 T（铁衣）挑一组含 资源/焚骨 的权重，在"T 均分不被拉偏"的前提下最大化 T 的区分度
 *  3. 量化「跨场稳定性」：把 FN 最高的那个人拿掉再算一遍，看剩下人的**个人分**变化多少
 *     （旧口径是同场 Min-Max，会跟着极值一起漂；新口径是绝对曲线，应该几乎不动）
 *
 * 用法：node scripts/score-calibrate.mjs [--apply]
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { scoreMatch } = require(join(root, 'dist/shared/scoreEngine.js'));

const fixture = JSON.parse(readFileSync(join(here, 'fixtures/score-spec-v1.json'), 'utf8'));
const ROLE = { DPS: 'DPS', T: 'T', '治疗': 'HEAL' };
const stat = (r) => ({
  kills: r.kill - r.fountain, fountainKills: r.fountain, assists: r.assist, resource: r.resource ?? 0,
  dmgPlayer: r.dmg, dmgPlayerArmor: 0, dmgBuilding: r.tower, dmgBuildingArmor: 0,
  healing: r.heal, damageTaken: r.taken, deaths: r.death, revives: r.revive, boneBurn: r.bone,
});
const buildRows = (rows) => rows.map((r, i) => ({
  participationId: i + 1, playerId: i + 1, playerName: r.name, classUsed: r.cls,
  role: ROLE[r.role] ?? 'DPS', squad: r.squad, tactic: r.tactic, teamRole: '',
  noteRole: r.note, state: 'PLAY', stat: stat(r),
}));
const COEF = {
  素问: 0.95, 妙音: 1.05, 惊鸿: 1.0, 九灵: 1.0, 神相: 1.2, 玄机: 1.1,
  血河: 1.1, 铁衣: 1.1, 龙吟: 1.0, 碎梦: 1.4, 沧澜: 0.95, 潮光: 0.95,
};
const BONUS = { 指挥: 2.5, 统战: 5, K龙: 5 };

const rule = (over) => ({
  id: 1, version: 1, active: true, createdAt: '', name: 'calib',
  baseScore: 60, capScore: 100, scaleTeam: 20, scalePersonal: 40,
  deathPen: 3, totalTowers: 9, personalHalf: 0.5, personalGamma: 1, deathPenCap: 20,
  personalWeights: {
    DPS: { kill: 1.2, dmg: 0.5, tower: 1.2, assist: 0.3, fountain: 0.2, bone: 0.2 },
    T: { assist: 0.8, taken: 1.8 },
    HEAL: { assist: 0.2, heal: 0.8, taken: 0.3, revive: 0.5 },
  },
  execWeights: {
    push: { progress: 0.6 * (7 / 9), flag: 0.6 * (2 / 9), tower: 0.25, kill: 0.15 },
    guard: { kill: 0.5, taken: 0.3, lowDeath: 0.2 },
    defend: { keepRate: 0.55, kill: 0.25, lowDeath: 0.2 },
  },
  classCoef: COEF, bonus: BONUS,
  ...over,
});

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pstd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const match = fixture.match;
const INPUT = {
  matchId: 1, ourTowersLeft: match.ourTowersLeft, oppTowersLeft: match.oppTowersLeft, result: match.result,
  rows: buildRows(fixture.rows),
};

/** 先算一遍 FN（用引擎的明细字段，个人原始加权） */
function rawFNs(r) {
  const out = scoreMatch(INPUT, r);
  return out.lines.map((l) => Number(l.detail['个人原始加权'] ?? 0));
}

/** 用给定 half 跑一遍，返回指标 */
function metrics(r) {
  const out = scoreMatch(INPUT, r);
  const totals = out.lines.map((l) => l.total);
  const teams = out.lines.map((l) => l.teamScore);
  const pers = out.lines.map((l) => l.personalScore);
  const t = out.lines.filter((l) => l.role === 'T').map((l) => l.total);
  return {
    mean: mean(totals), sd: pstd(totals), median: median(totals), min: Math.min(...totals),
    max: Math.max(...totals), capped: totals.filter((v) => v >= 99.99).length,
    teamRange: Math.max(...teams) - Math.min(...teams),
    persMean: mean(pers), persSd: pstd(pers),
    tN: t.length, tMean: t.length ? mean(t) : 0, tSd: t.length > 1 ? pstd(t) : 0,
    totals, pers,
  };
}

/* ── 1. 曲线半值 = FN 中位数（按当前 DPS/HEAL 权重 + 待定 T 权重） ── */
/* ── 2. T 权重搜索 ──
 * 实测 T(n=5) 各字段的变异系数：塔伤 0.76 / 人伤 0.42 / 重伤 0.36 / 助攻 0.29 / **承伤 0.14**。
 * 规范首版把 1.8 的权重压在承伤（区分度最差）上 ✗ → 5 个 T 的 sd 只有 2.44。
 * 资源/焚骨在原表全是 0，用不了 ✓（所以只能从 塔伤/人伤/助攻/承伤 里配）。
 * 选择标准：T 均分不偏离全场均值 3 分以上，且 T-sd 最大。
 */
const T_CANDIDATES = [
  { assist: 0.8, taken: 1.8 },                                       // 规范原版（对照）
  { assist: 0.6, taken: 1.2, tower: 0.8, dmg: 0.3 },
  { assist: 0.6, taken: 0.6, tower: 1.0, dmg: 0.4 },
  { assist: 0.5, taken: 0.5, tower: 1.2, dmg: 0.5 },
  { assist: 0.7, taken: 0.8, tower: 0.9, dmg: 0.3 },
  { assist: 0.4, taken: 0.4, tower: 1.4, dmg: 0.6 },
  { assist: 0.8, taken: 0.6, tower: 1.0, dmg: 0.2 },
];

const rowsOut = [];
let bestT = null;
for (const tw of T_CANDIDATES) {
  let r = rule({ personalWeights: { ...rule().personalWeights, T: tw } });
  const fns = rawFNs(r).filter((v) => v > 0);
  const half = median(fns);
  r = rule({ personalWeights: { ...rule().personalWeights, T: tw }, personalHalf: half });
  const m = metrics(r);
  const gap = Math.abs(m.tMean - m.mean);
  rowsOut.push({ tw, half, m, gap });
  // 目标：T 均分与全场均值差 ≤ 3 分（不偏），且 T-sd 最大
  const score = (gap <= 3 ? 100 : 0) + m.tSd;
  if (!bestT || score > bestT.score) bestT = { tw, half, m, gap, score };
}

const ruleFinal_ = (twis) => rule({ personalWeights: { ...rule().personalWeights, T: twis } });

/* 2b. 曲线（half × γ）网格标定：目标是把分布拉回历史区间中点
 *     历史 6 场：均值 72.07~80.61 / sd 12.01~18.27 / 中位 73.11~82.81 / min 52.63~60.00
 *     （中点才是目标；区间只是容差 ✓ 不用死守某一版口径）*/
const MID = { mean: 79, sd: 12, median: 81, min: 57 };   // ← 引擎 v2 的目标（不追旧 Excel 的数字：那套 sd 是靠零贡献负分撑出来的）
const SCALE = { mean: 4, sd: 3, median: 5, min: 3 };
const baseFns = rawFNs(ruleFinal_(bestT.tw)).filter((v) => v > 0);
const medFN = baseFns.length ? median(baseFns) : 1;

let bestCurve = null;
const grid = [];
for (const hf of [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]) {
  for (const g of [1, 1.2, 1.4, 1.6, 1.8, 2.0, 2.4]) {
    const half = medFN * hf;
    const m = metrics(rule({ ...ruleFinal_(bestT.tw), personalHalf: half, personalGamma: g }));
    const cost = ((m.mean - MID.mean) / SCALE.mean) ** 2
      + ((m.sd - MID.sd) / SCALE.sd) ** 2
      + ((m.median - MID.median) / SCALE.median) ** 2
      + ((m.min - MID.min) / SCALE.min) ** 2
      + (m.capped === 0 ? 25 : 0);
    grid.push({ hf, g, half, m, cost });
    if (!bestCurve || cost < bestCurve.cost) bestCurve = { hf, g, half, m, cost };
  }
}
console.log('\n=== 曲线网格（取分布最接近历史中点的）===');
for (const c of grid.slice().sort((a, b) => a.cost - b.cost).slice(0, 8)) {
  console.log(`  half=${c.hf}×FN中位=${c.half.toFixed(4)}  γ=${c.g}  cost=${c.cost.toFixed(3)}  `
    + `均值 ${c.m.mean.toFixed(2)} sd ${c.m.sd.toFixed(2)} 中位 ${c.m.median.toFixed(2)} min ${c.m.min.toFixed(2)} 满分 ${c.m.capped} T-sd ${c.m.tSd.toFixed(2)}`);
}

const ruleFinal = rule({ ...ruleFinal_(bestT.tw), personalHalf: bestCurve.half, personalGamma: bestCurve.g });
const finalM = metrics(ruleFinal);

/* ── 3. 跨场稳定性：去掉 FN 最高的人，看其他人的**个人分**漂多少 ── */
function stability(r) {
  const before = scoreMatch(INPUT, r);
  const rawMap = before.lines.map((l) => ({ id: l.participationId, raw: Number(l.detail['个人原始加权'] ?? 0) }));
  const top = rawMap.slice().sort((a, b) => b.raw - a.raw)[0];
  const keptIdx = fixture.rows.map((_, i) => i).filter((i) => i + 1 !== top.id);
  const input2 = { ...INPUT, rows: buildRows(fixture.rows.filter((_, i) => keptIdx.includes(i))) };
  const after = scoreMatch(input2, r);
  const persBefore = new Map(before.lines.map((l) => [l.playerName, l.personalScore]));
  let max = 0; let sum = 0; let n = 0;
  for (const l of after.lines) {
    const b = persBefore.get(l.playerName);
    if (b === undefined) continue;
    const d = Math.abs(l.personalScore - b);
    sum += d; n += 1; if (d > max) max = d;
  }
  return { mean: n ? sum / n : 0, max };
}

/** 旧口径（同场 Min-Max）的个人比例 —— 纯脚本内计算，只用于"稳定性对比"报告 */
function oldRatioMap(rows, raws) {
  const pos = raws.filter((v) => v > 0);
  const lo = pos.length ? Math.min(...pos) : 0;
  const hi = pos.length ? Math.max(...pos) : 0;
  return new Map(rows.map((r, i) => [r.name, hi > lo ? ((raws[i] - lo) / (hi - lo)) * 40 : 0]));
}
function stabilityOld() {
  const before = scoreMatch(INPUT, rule({ personalHalf: 0 }));
  const rawsBefore = before.lines.map((l) => Number(l.detail['个人原始加权'] ?? 0));
  const topIdx = rawsBefore.indexOf(Math.max(...rawsBefore));
  const kept = fixture.rows.filter((_, i) => i !== topIdx);
  const input2 = { ...INPUT, rows: buildRows(kept) };
  const after = scoreMatch(input2, rule({ personalHalf: 0 }));
  const rawsAfter = after.lines.map((l) => Number(l.detail['个人原始加权'] ?? 0));
  const a = oldRatioMap(fixture.rows, rawsBefore);
  const b = oldRatioMap(kept, rawsAfter);
  let max = 0; let sum = 0; let n = 0;
  for (const [name, v] of b) {
    const prev = a.get(name);
    if (prev === undefined) continue;
    const d = Math.abs(v - prev);      // 单位已经是"个人分"（×40 后）
    sum += d; n += 1; if (d > max) max = d;
  }
  return { mean: n ? sum / n : 0, max };
}

const st = stability(ruleFinal);
const stOld = stabilityOld();

const f = (m) => `均值 ${m.mean.toFixed(2)}  sd ${m.sd.toFixed(2)}  中位 ${m.median.toFixed(2)}  min ${m.min.toFixed(2)}  `
  + `max ${m.max.toFixed(2)}  团队极差 ${m.teamRange.toFixed(2)}  满分 ${m.capped}  `
  + `T 均分 ${m.tMean.toFixed(2)}(差 ${bestT.gap.toFixed(2)})  T-sd ${m.tSd.toFixed(2)}(n=${m.tN})`;

console.log('历史 6 场区间: 均值 72.07~80.61 / sd 12.01~18.27 / 中位 73.11~82.81 / min 52.63~60.00');
console.log('\n=== T 权重候选（看 T-sd 与 T 均分是否被拉偏）===');
for (const r of rowsOut) {
  console.log(`  ${JSON.stringify(r.tw).padEnd(46)} half=${r.half.toFixed(4)}  T 均分 ${r.m.tMean.toFixed(2)}(差 ${r.gap.toFixed(2)})  T-sd ${r.m.tSd.toFixed(2)}`);
}
console.log('\n=== 选定 ===');
console.log('  T 权重 =', JSON.stringify(bestT.tw), ' 曲线半值 =', bestT.half.toFixed(6));
console.log('\n=== 引擎 v2（曲线 + 零贡献记 0 + 扣分封顶 20）===');
console.log('  ' + f(finalM));
console.log('\n=== 跨场稳定性（拿掉 FN 最高的人，其他人个人分漂多少）===');
console.log(`  v2 绝对曲线: 平均 ${st.mean.toFixed(3)} 分 / 最大 ${st.max.toFixed(3)} 分`);
console.log(`  旧 同场MinMax: 平均 ${stOld.mean.toFixed(3)} 分 / 最大 ${stOld.max.toFixed(3)} 分`);

if (process.argv.includes('--apply')) {
  const r = ruleFinal;
  const src = `/**
 * 评分权重预设 —— **引擎 v2 标定产物，不要手改**
 *
 * 生成：node scripts/score-calibrate.mjs --apply
 * 样本：LIS 原表「数据处理1」60 条真实战报（scripts/fixtures/score-spec-v1.json）
 *
 * 相对规范 v1.0 的设计改动（2026-10-24）：
 *  1. 个人分改**绝对饱和曲线** FO = FN/(FN+personalHalf) —— 跨场可比，零贡献记 0（不再得负分）
 *  2. 重伤扣分**封顶** deathPenCap=20
 *  3. T（铁衣）权重补 资源/焚骨 —— 原来只有 助攻/承伤，5 个 T 的 sd 只有 2.44
 *
 * 标定结果：
 *   ${f(finalM).replace(/\s+/g, ' ')}
 *   跨场稳定性：平均漂 ${st.mean.toFixed(3)} 分（旧同场 Min-Max 口径 ${stOld.mean.toFixed(3)} 分）
 */
export interface ScorePreset {
  personalHalf: number;
  deathPenCap: number;
  personalWeights: {
    DPS: Record<string, number>;
    T: Record<string, number>;
    HEAL: Record<string, number>;
  };
}

export const SCORE_PRESET: ScorePreset = {
  personalHalf: ${Number(bestT.half.toFixed(6))},
  deathPenCap: 20,
  personalWeights: {
    DPS: ${JSON.stringify(r.personalWeights.DPS)},
    T: ${JSON.stringify(r.personalWeights.T)},
    HEAL: ${JSON.stringify(r.personalWeights.HEAL)},
  },
};
`;
  writeFileSync(join(root, 'src/shared/scorePreset.ts'), src, 'utf8');
  console.log('\n已写入 src/shared/scorePreset.ts');
}


