#!/usr/bin/env node
/**
 * 满量程参考值标定（按职业 12 个）
 *
 * 口径（关键）：用**去掉职业系数后**的 FN 中位数标定，否则参考值会把系数影响吃掉 ✗
 *   ratio  = 该职业 FN(去系数)中位 ÷ 同定位中位
 *   shrink = n ÷ (n + 5)                     ← 样本少就向定位值收缩，防过拟合
 *   ref    = ref_定位 × (1 + (ratio − 1) × shrink)
 * 目标：每个职业"中位水平"≈ 个人分 13 分（等价于 FO≈0.5 再乘系数^γ）
 *
 * 数据源：scripts/fixtures/score-spec-v1.json（60 条）+ 任意多的真实战报 CSV
 * 用法：
 *   npm run score:refcal -- --csv "C:\...\20261024_xxx.csv"
 *   npm run score:refcal -- --csv a.csv --csv b.csv --apply   （--apply 才打印写回指引）
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { scoreMatch } = require(join(root, 'dist/shared/scoreEngine.js'));
const { DEFAULT_RULE_SET, buildClassPersonalRef } = require(join(root, 'dist/main/repositories/ruleSetRepo.js'));
const { CLASSES } = require(join(root, 'dist/shared/domain.js'));
/* 鸿音→妙音/惊鸿 的分流口径，复用项目唯一实现（>500 万治疗按妙音） */
const { resolveHongyin } = require(join(root, 'dist/shared/statImport.js'));

const ROLE = Object.fromEntries(CLASSES.map((c) => [c.name, c.role]));
/* 职业别名（鸿音→惊鸿 等）：战报里写的是游戏内的形态名，个人权重/参考值都按主名归口 */
const ALIAS = new Map();
for (const c of CLASSES) {
  ALIAS.set(c.name, c.name);
  for (const a of (c.aliases ?? [])) ALIAS.set(a, c.name);
}
const canon = (cls) => ALIAS.get(String(cls ?? '').trim()) ?? '';
const COEF = Object.fromEntries(CLASSES.map((c) => [c.name, c.coef]));
const ROLE_REF = { DPS: 0.175, T: 0.075, HEAL: 0.2 };
const SHRINK_K = 5;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const st = (r) => ({ kills: r.kill - r.fountain, fountainKills: r.fountain, assists: r.assist, resource: r.resource ?? 0,
  dmgPlayer: r.dmg, dmgPlayerArmor: 0, dmgBuilding: r.tower, dmgBuildingArmor: 0,
  healing: r.heal, damageTaken: r.taken, deaths: r.death, revives: r.revive, boneBurn: r.bone });
const roleOf = (c) => (c === '铁衣' ? 'T' : (c === '素问' || c === '妙音' ? 'HEAL' : 'DPS'));

/* ── 1. 夹具 ── */
const samples = [];
const fx = JSON.parse(readFileSync(join(here, 'fixtures/score-spec-v1.json'), 'utf8'));
const RF = { DPS: 'DPS', T: 'T', '治疗': 'HEAL' };
const outFx = scoreMatch({
  matchId: 1, ourTowersLeft: fx.match.ourTowersLeft, oppTowersLeft: fx.match.oppTowersLeft, result: fx.match.result,
  rows: fx.rows.map((r, i) => ({ participationId: i + 1, playerId: i + 1, playerName: r.name, classUsed: r.cls,
    role: RF[r.role] ?? 'DPS', squad: r.squad, tactic: r.tactic, teamRole: '', noteRole: r.note, state: 'PLAY', stat: st(r) })),
}, { ...DEFAULT_RULE_SET, id: 0, version: 0, active: true, createdAt: '' });
outFx.lines.forEach((l, i) => samples.push({ cls: fx.rows[i].cls, fn: Number(l.detail['个人原始加权']) }));
console.log(`夹具: ${fx.rows.length} 条`);

/* ── 2. 追加的真实战报 CSV（数据导入格式，取第一段=我方） ── */
const csvs = process.argv.slice(2).reduce((acc, a, i, arr) => (a === '--csv' ? acc.concat(arr[i + 1] ?? []) : acc), []);
for (const p of csvs) {
  const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  const h = lines.findIndex((l) => l.includes('玩家名字'));
  const cells = (line) => {
    const o = []; let c = ''; let q = false;
    for (const ch of line) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { o.push(c); c = ''; continue; } c += ch; }
    o.push(c); return o.map((x) => x.trim());
  };
  const rows = [];
  for (const line of lines.slice(h + 1)) {
    if (!line.trim()) break;
    const c = cells(line);
    if (!c[0]) continue;
    const [k, f] = String(c[2] ?? '0/0').split('/');
    rows.push({ name: c[0], cls: c[1] || '', kill: +k || 0, fountain: +f || 0, assist: +c[3] || 0, resource: +c[4] || 0,
      dmg: +c[5] || 0, heal: +c[9] || 0, taken: +c[10] || 0, death: +c[11] || 0, revive: +c[12] || 0,
      tower: +c[7] || 0, towerArmor: +c[8] || 0, bone: +c[13] || 0, dmgArmor: +c[6] || 0 });
  }
  /* 只用来算 FN：凑一个人造对局（塔数/胜负取中性值，不影响 FN 的口径） */
  const fake = scoreMatch({
    matchId: 2, ourTowersLeft: 5, oppTowersLeft: 4, result: 'WIN',
    rows: rows.map((r, i) => {
      /* 鸿音先按奶量分流，再归口到主名（权重/参考值都按主名配） */
      const resolved = canon(resolveHongyin(String(r.cls ?? '').trim(), r.heal));
      return { participationId: i + 1, playerId: i + 1, playerName: r.name, classUsed: resolved,
        role: roleOf(resolved), squad: `s${i % 6}`, tactic: '塔后拆', teamRole: '', noteRole: '', state: 'PLAY', stat: st(r) };
    }),
  }, { ...DEFAULT_RULE_SET, id: 0, version: 0, active: true, createdAt: '' });
  let skipped = 0;
  fake.lines.forEach((l, i) => {
    const cls = canon(resolveHongyin(String(rows[i].cls ?? '').trim(), rows[i].heal));
    if (!cls) { skipped += 1; return; }
    samples.push({ cls, fn: Number(l.detail['个人原始加权']) });
  });
  if (skipped) console.log(`  ⚠ ${p}: 有 ${skipped} 人的职业不在字典里，已跳过`);
  console.log(`${p}: ${rows.length} 条`);
}

/* ── 3. 去系数 + 收缩标定 ── */
const byCls = new Map();
const byRole = new Map();
for (const s of samples) {
  const fn0 = s.fn / (COEF[s.cls] || 1);
  if (!byCls.has(s.cls)) byCls.set(s.cls, []);
  byCls.get(s.cls).push(fn0);
  const r = ROLE[s.cls];
  if (!byRole.has(r)) byRole.set(r, []);
  byRole.get(r).push(fn0);
}
const ref = {};
console.log('\n职业  定位  样本  FN中位(去系数)  同定位中位  比值  收缩  → 参考值');
for (const c of CLASSES) {
  const list = byCls.get(c.name) ?? [];
  if (!list.length) { ref[c.name] = ROLE_REF[c.role]; console.log(`  ${c.name.padEnd(4)}${c.role.padEnd(5)} 0     —（回落到定位值 ${ROLE_REF[c.role]}）`); continue; }
  const mc = median(list);
  const mr = median(byRole.get(c.role));
  const ratio = mr > 0 ? mc / mr : 1;
  const shrink = list.length / (list.length + SHRINK_K);
  const v = ROLE_REF[c.role] * (1 + (ratio - 1) * shrink);
  ref[c.name] = +v.toFixed(4);
  console.log(`  ${c.name.padEnd(4)}${c.role.padEnd(5)} ${String(list.length).padStart(2)}  ${mc.toFixed(4).padStart(10)}  ${mr.toFixed(4).padStart(10)}  ${ratio.toFixed(2).padStart(5)}  ${(shrink * 100).toFixed(0).padStart(3)}%  → ${v.toFixed(4)}`);
}
console.log('\n当前生效值: ' + JSON.stringify(buildClassPersonalRef()));
console.log('新标定值  : ' + JSON.stringify(ref));
if (process.argv.includes('--apply')) {
  console.log('\n── 写回 src/main/repositories/ruleSetRepo.ts 的 CLASS_PERSONAL_REF ──');
  const keys = Object.keys(ref);
  for (let i = 0; i < keys.length; i += 4) {
    console.log('  ' + keys.slice(i, i + 4).map((k) => `${k}: ${ref[k]}`).join(', ') + ',');
  }
}


