#!/usr/bin/env node
/**
 * 评分算法回归：用 LIS 原表里的 **60 条真实战报**跑一遍 TS 引擎，
 * 逐人对比「规范 v1.0」参考实现（work/spec_v1.py）算出的期望分。
 *
 * 为什么需要它：M1 计算引擎的验收标准就是这条（设计基准 v2 第四部分），
 * 而且历史教训是"参数对了但公式口径错了" —— 这类错不会崩、只会让分数悄悄偏掉，
 * 只有拿真实样本逐人比对才看得出来。
 *
 * 用法：npm run score:regress        （内部会先 build:node）
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
const TOL = 0.006;          // 期望值是参考实现保留 6 位后回写的，比对容差取 0.006（打印两位小数的量级）

/** 参考实现的 role → 本项目的 RoleKey */
const ROLE = { DPS: 'DPS', T: 'T', '治疗': 'HEAL' };

/** 夹具里的有效值 → CombatStat（反解出原始字段，好让 deriveEffective 还原成同样的有效值） */
const stat = (r) => ({
  kills: r.kill - r.fountain,        // 击败 = 有效击杀 − 清泉
  fountainKills: r.fountain,
  assists: r.assist,
  resource: 0,
  dmgPlayer: r.dmg,                  // 有效人伤 = 对玩家伤害 + 人伤卸甲
  dmgPlayerArmor: 0,
  dmgBuilding: r.tower,              // 有效塔伤 = 对建筑伤害 + 破塔卸甲
  dmgBuildingArmor: 0,
  healing: r.heal,
  damageTaken: r.taken,
  deaths: r.death,
  revives: r.revive,
  boneBurn: r.bone,
});

const input = {
  matchId: 1,
  ourTowersLeft: fixture.match.ourTowersLeft,
  oppTowersLeft: fixture.match.oppTowersLeft,
  result: fixture.match.result,
  rows: fixture.rows.map((r, i) => ({
    participationId: i + 1,
    playerId: i + 1,
    playerName: r.name,
    classUsed: r.cls,
    role: ROLE[r.role] ?? 'DPS',
    squad: r.squad,
    tactic: r.tactic,
    teamRole: '',
    noteRole: r.note,
    state: 'PLAY',
    stat: stat(r),
  })),
};

const rule = { ...DEFAULT_RULE_SET, id: 1, version: 1, active: true, createdAt: '' };
const out = scoreMatch(input, rule);

const byId = new Map(out.lines.map((l) => [l.participationId, l]));
let bad = 0;
const rows = [];
for (let i = 0; i < fixture.rows.length; i += 1) {
  const exp = fixture.rows[i].expected;
  const got = byId.get(i + 1);
  const diffs = {
    team: got.teamScore - exp.team,
    pers: got.personalScore - exp.pers,
    bonus: got.bonus - exp.bonus,
    pen: got.deathPenalty - exp.pen,
    total: got.total - exp.total,
  };
  const over = Object.entries(diffs).filter(([, d]) => Math.abs(d) > TOL);
  if (over.length) {
    bad += 1;
    rows.push(`  ✗ ${fixture.rows[i].name}(${fixture.rows[i].cls}/${fixture.rows[i].squad})`
      + ` 期望 total=${exp.total.toFixed(2)} 实得 ${got.total.toFixed(2)}`
      + ` ｜偏差 ${over.map(([k, d]) => `${k} ${d.toFixed(4)}`).join(', ')}`);
  }
}

// 分布指标也要对得上（规范 §2.8 的验收口径）
const totals = out.lines.map((l) => l.total);
const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length);
const sorted = [...totals].sort((a, b) => a - b);
const median = sorted.length % 2
  ? sorted[(sorted.length - 1) / 2]
  : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
const teamMin = Math.min(...out.lines.map((l) => l.teamScore));
const teamMax = Math.max(...out.lines.map((l) => l.teamScore));
const capped = totals.filter((v) => v >= 99.99).length;

const statOk = Math.abs(mean - fixture.stats.mean) < 0.02
  && Math.abs(sd - fixture.stats.sd) < 0.02
  && Math.abs(median - fixture.stats.median) < 0.02
  && Math.abs(Math.min(...totals) - fixture.stats.min) < 0.02
  && Math.abs(teamMin - fixture.stats.teamMin) < 0.02
  && Math.abs(teamMax - fixture.stats.teamMax) < 0.02
  && capped === fixture.stats.capped;

console.log(`引擎: ${ENGINE_ID}   样本: ${fixture.rows.length} 条真实战报`);
console.log(`逐人比对: ${fixture.rows.length - bad}/${fixture.rows.length} 一致`
  + (bad ? `（${bad} 条超出 ${TOL} 容差）` : ' ✓'));
if (rows.length) console.log(rows.join('\n'));
console.log(`分布: 均值=${mean.toFixed(2)}(期望 ${fixture.stats.mean}) sd=${sd.toFixed(2)}(期望 ${fixture.stats.sd})`
  + ` 中位=${median.toFixed(2)}(期望 ${fixture.stats.median}) min=${Math.min(...totals).toFixed(2)}(期望 ${fixture.stats.min})`);
console.log(`团队分: ${teamMin.toFixed(2)}~${teamMax.toFixed(2)}(期望 ${fixture.stats.teamMin}~${fixture.stats.teamMax})`
  + ` 极差 ${(teamMax - teamMin).toFixed(2)}   满分 ${capped} 人(期望 ${fixture.stats.capped})`);
console.log(statOk ? '分布指标 ✓' : '分布指标 ✗');

if (bad || !statOk) {
  console.error('\n评分回归 FAIL ✗');
  process.exit(1);
}
console.log('\n评分回归 PASS ✅');
