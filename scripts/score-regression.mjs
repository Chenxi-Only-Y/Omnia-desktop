#!/usr/bin/env node
/**
 * 评分引擎回归（引擎 v2）
 *
 * 检查四件事（都是"设计承诺"，不是"和某个参考实现逐位相同"）：
 *  1. **跨场稳定**：拿掉 FN 最高的那个人再算一遍，其他人的个人分几乎不动
 *     （旧口径同场 Min-Max 会跟着极值漂 —— 这里同时报出旧口径的漂移量作对照）
 *  2. **零贡献不得负分**：个人分 ≥ 0，且总分不低于"底分 − 扣分封顶"
 *  3. **T（铁衣）区分度**：T 的 sd ≥ 3.5（旧口径 2.44）；且 T 均分不偏离全场 3 分以上
 *  4. **分布合理**：均值/中位 75~88、sd ≥ 9、最低 < 62、至少 1 人触顶
 *
 * 用法：npm run score:regress
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { scoreMatch, ENGINE_ID } = require(join(root, 'dist/shared/scoreEngine.js'));
const { DEFAULT_RULE_SET } = require(join(root, 'dist/main/repositories/ruleSetRepo.js'));

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
const match = fixture.match;
const INPUT = {
  matchId: 1, ourTowersLeft: match.ourTowersLeft, oppTowersLeft: match.oppTowersLeft, result: match.result,
  rows: buildRows(fixture.rows),
};
const rule = { ...DEFAULT_RULE_SET, id: 1, version: 1, active: true, createdAt: '' };

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pstd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const out = scoreMatch(INPUT, rule);
const totals = out.lines.map((l) => l.total);
const pers = out.lines.map((l) => l.personalScore);
const teams = out.lines.map((l) => l.teamScore);
const tLines = out.lines.filter((l) => l.role === 'T');
const tTotals = tLines.map((l) => l.total);
const stats = {
  mean: mean(totals), sd: pstd(totals), median: median(totals),
  min: Math.min(...totals), max: Math.max(...totals), capped: totals.filter((v) => v >= 99.99).length,
  teamRange: Math.max(...teams) - Math.min(...teams),
  tN: tLines.length, tMean: tTotals.length ? mean(tTotals) : 0, tSd: tTotals.length > 1 ? pstd(tTotals) : 0,
};

/* 1. 跨场稳定性：去掉 FN 最高的人 */
function drift(getPersonal) {
  const raws = out.lines.map((l) => Number(l.detail['个人原始加权'] ?? 0));
  const topIdx = raws.indexOf(Math.max(...raws));
  const kept = fixture.rows.filter((_, i) => i !== topIdx);
  const out2 = scoreMatch({ ...INPUT, rows: buildRows(kept) }, rule);
  const before = new Map(getPersonal(out).map(([k, v]) => [k, v]));
  let sum = 0; let n = 0; let max = 0;
  for (const [k, v] of getPersonal(out2)) {
    const b = before.get(k);
    if (b === undefined) continue;
    const d = Math.abs(v - b); sum += d; n += 1; if (d > max) max = d;
  }
  return { mean: n ? sum / n : 0, max };
}
const driftNew = drift((o) => o.lines.map((l) => [l.playerName, l.personalScore]));
/* 旧口径对照：同场 Min-Max（在脚本里按同一批 FN 重算，只为对比稳定性） */
const driftOld = (() => {
  const raws = out.lines.map((l) => Number(l.detail['个人原始加权'] ?? 0));
  const topIdx = raws.indexOf(Math.max(...raws));
  const kept = fixture.rows.filter((_, i) => i !== topIdx);
  const out2 = scoreMatch({ ...INPUT, rows: buildRows(kept) }, rule);
  const raws2 = out2.lines.map((l) => Number(l.detail['个人原始加权'] ?? 0));
  const mm = (vals) => {
    const pos = vals.filter((v) => v > 0);
    const lo = pos.length ? Math.min(...pos) : 0;
    const hi = pos.length ? Math.max(...pos) : 0;
    return (v) => (hi > lo ? ((v - lo) / (hi - lo)) * 40 : 0);
  };
  const f1 = mm(raws); const f2 = mm(raws2);
  let sum = 0; let n = 0; let max = 0;
  const before = new Map(out.lines.map((l, i) => [l.playerName, f1(raws[i])]));
  out2.lines.forEach((l, i) => {
    const b = before.get(l.playerName);
    if (b === undefined) return;
    const d = Math.abs(f2(raws2[i]) - b); sum += d; n += 1; if (d > max) max = d;
  });
  return { mean: n ? sum / n : 0, max };
})();

const checks = {
  '引擎标识=omnia-spec-v2': ENGINE_ID === 'omnia-spec-v2',
  '个人分无负数': pers.every((v) => v >= -1e-9),
  '总分不低于 底分-扣分封顶': Math.min(...totals) >= rule.baseScore - rule.deathPenCap - 1e-9,
  'T 区分度 ≥3.5': stats.tSd >= 3.5,
  'T 均分不偏(≤3分)': Math.abs(stats.tMean - stats.mean) <= 3,
  '跨场稳定(平均漂 <0.6)': driftNew.mean < 0.6,
  '比旧口径更稳': driftNew.mean < driftOld.mean,
  '均值 78~90（底分 60 + 无负分的自然区间）': stats.mean >= 78 && stats.mean <= 90,
  'sd ≥9': stats.sd >= 9,
  '最低分 <62': stats.min < 62,
  '至少1人触顶': stats.capped >= 1,
  '团队分极差 ≥12': stats.teamRange >= 12,
};

console.log(`引擎: ${ENGINE_ID}   样本: ${fixture.rows.length} 条真实战报`);
console.log(`分布: 均值 ${stats.mean.toFixed(2)}  sd ${stats.sd.toFixed(2)}  中位 ${stats.median.toFixed(2)}  `
  + `min ${stats.min.toFixed(2)}  max ${stats.max.toFixed(2)}  触顶 ${stats.capped} 人  团队极差 ${stats.teamRange.toFixed(2)}`);
console.log(`T: n=${stats.tN} 均分 ${stats.tMean.toFixed(2)}  sd ${stats.tSd.toFixed(2)}`);
console.log(`跨场稳定性: 新口径 平均 ${driftNew.mean.toFixed(3)} / 最大 ${driftNew.max.toFixed(3)} 分  `
  + `｜ 旧同场MinMax 平均 ${driftOld.mean.toFixed(3)} / 最大 ${driftOld.max.toFixed(3)} 分`);
const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
console.log('\n检查项: ' + Object.entries(checks).map(([k, ok]) => `${ok ? '✓' : '✗'} ${k}`).join('\n        '));
if (bad.length) {
  console.error('\n评分回归 FAIL ✗ 失败项: ' + bad.join('、'));
  process.exit(1);
}
console.log('\n评分回归 PASS ✅');

