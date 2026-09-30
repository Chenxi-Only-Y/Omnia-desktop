import { useMemo } from 'react';
import type { ParticipationRow } from '@shared/types';
import ClassChip from './ClassChip';
import type { PageProps } from '../App';

/**
 * 本场「我方 vs 对方」对比（用户口径 2026-09：对方数据「不纳入评分机制，纯数据对比」）。
 *
 * 两条口径决定了这里怎么算：
 *   ① **按职业对齐** —— 双方人数不一样（59 : 61），比总量没意义，所以看**人均**；
 *   ② **只统计真有战报的人**（statFilled）—— 我方常有人只排进小队没录战报，
 *      把他们算进分母会把人均拉低，看起来像"我们打得更差"，那是统计口径的问题不是战力问题。
 */
interface Metric {
  key: string;
  label: string;
  pick: (r: ParticipationRow) => number;
  fmt?: (v: number) => string;
}

const METRICS: Metric[] = [
  { key: 'dmg', label: '有效人伤', pick: (r) => r.stat.dmgPlayer + r.stat.dmgPlayerArmor },
  { key: 'tower', label: '有效塔伤', pick: (r) => r.stat.dmgBuilding + r.stat.dmgBuildingArmor },
  { key: 'kill', label: '有效击杀', pick: (r) => r.stat.kills + r.stat.fountainKills },
  { key: 'heal', label: '治疗值', pick: (r) => r.stat.healing },
  { key: 'taken', label: '承受伤害', pick: (r) => r.stat.damageTaken },
  { key: 'death', label: '重伤', pick: (r) => r.stat.deaths, fmt: (v) => v.toFixed(2) },
];

const num = (v: number): string => Math.round(v).toLocaleString();

export default function OppCompare({
  rows, classMap,
}: {
  rows: ParticipationRow[];
  classMap: PageProps['classMap'];
}) {
  const data = useMemo(() => {
    const ours = rows.filter((r) => r.side === 'our' && r.statFilled);
    const opps = rows.filter((r) => r.side === 'opp' && r.statFilled);

    const avg = (list: ParticipationRow[], pick: Metric['pick']): number =>
      list.length ? list.reduce((n, r) => n + pick(r), 0) / list.length : 0;
    const sum = (list: ParticipationRow[], pick: Metric['pick']): number =>
      list.reduce((n, r) => n + pick(r), 0);

    const team = METRICS.map((m) => ({
      ...m,
      our: avg(ours, m.pick),
      opp: avg(opps, m.pick),
      ourSum: sum(ours, m.pick),
      oppSum: sum(opps, m.pick),
    }));

    /* 按职业对齐：取两边出现过的职业，按我方人数降序（我方没有的职业排后面）。
       `classUsed` 为空的行归到「未登记职业」一档，不丢数据。 */
    const keyOf = (r: ParticipationRow): string => r.classUsed || '（未登记职业）';
    const classes = new Set<string>();
    for (const r of [...ours, ...opps]) classes.add(keyOf(r));
    const byClass = [...classes].map((cls) => {
      const o = ours.filter((r) => keyOf(r) === cls);
      const p = opps.filter((r) => keyOf(r) === cls);
      return {
        cls,
        ourCount: o.length,
        oppCount: p.length,
        ourDmg: avg(o, METRICS[0].pick),
        oppDmg: avg(p, METRICS[0].pick),
        ourTower: avg(o, METRICS[1].pick),
        oppTower: avg(p, METRICS[1].pick),
        ourHeal: avg(o, METRICS[3].pick),
        oppHeal: avg(p, METRICS[3].pick),
      };
    }).sort((a, b) => (b.ourCount - a.ourCount) || (b.oppCount - a.oppCount) || a.cls.localeCompare(b.cls));

    return { ours, opps, team, byClass };
  }, [rows]);

  const delta = (our: number, opp: number): { text: string; tone: 'ok' | 'bad' | 'flat' } => {
    if (!our && !opp) return { text: '—', tone: 'flat' };
    const d = our - opp;
    if (Math.abs(d) < 1e-6) return { text: '持平', tone: 'flat' };
    const pct = opp ? (d / opp) * 100 : 0;
    return {
      text: `${d > 0 ? '+' : ''}${num(d)}${opp ? `（${pct > 0 ? '+' : ''}${pct.toFixed(0)}%）` : ''}`,
      tone: d > 0 ? 'ok' : 'bad',
    };
  };

  if (!data.opps.length) {
    return (
      <div className="hint" style={{ marginBottom: 10 }}>
        本场还没有对方数据 —— 导入战报时勾选「存下对方数据」后，这里会给出本帮 vs 对方的对比。
      </div>
    );
  }

  return (
    <>
      <h3 style={{ fontSize: 12, marginTop: 0 }}>团队对比（人均，只算已录战报的人）</h3>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 110 }}>指标</th>
              <th className="num">我方人均</th>
              <th className="num">对方人均</th>
              <th className="num" style={{ width: 150 }}>差值</th>
              <th className="num">我方合计</th>
              <th className="num">对方合计</th>
            </tr>
          </thead>
          <tbody>
            {data.team.map((m) => {
              const d = delta(m.our, m.opp);
              return (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className="num">{m.fmt ? m.fmt(m.our) : num(m.our)}</td>
                  <td className="num">{m.fmt ? m.fmt(m.opp) : num(m.opp)}</td>
                  <td className="num" style={{ color: d.tone === 'ok' ? 'var(--ok)' : d.tone === 'bad' ? 'var(--danger)' : 'var(--text-faint)' }}>
                    {d.text}
                  </td>
                  <td className="num" style={{ color: 'var(--text-dim)' }}>{m.fmt ? m.fmt(m.ourSum) : num(m.ourSum)}</td>
                  <td className="num" style={{ color: 'var(--text-dim)' }}>{m.fmt ? m.fmt(m.oppSum) : num(m.oppSum)}</td>
                </tr>
              );
            })}
            <tr>
              <td>计入人数</td>
              <td className="num">{data.ours.length}</td>
              <td className="num">{data.opps.length}</td>
              <td className="num" style={{ color: 'var(--text-faint)' }}>
                {data.ours.length - data.opps.length >= 0 ? '+' : ''}{data.ours.length - data.opps.length} 人
              </td>
              <td className="num" style={{ color: 'var(--text-faint)' }} colSpan={2}>（只统计已录战报的人）</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 12, marginTop: 14 }}>按职业对齐</h3>
      <div className="table-wrap" style={{ maxHeight: '40vh' }}>
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 130 }}>职业</th>
              <th className="num">我方人数</th>
              <th className="num">我方人均人伤</th>
              <th className="num">对方人数</th>
              <th className="num">对方人均人伤</th>
              <th className="num" style={{ width: 140 }}>人伤差值</th>
              <th className="num">我方人均塔伤</th>
              <th className="num">对方人均塔伤</th>
              <th className="num">我方人均治疗</th>
              <th className="num">对方人均治疗</th>
            </tr>
          </thead>
          <tbody>
            {data.byClass.map((c) => {
              const d = delta(c.ourDmg, c.oppDmg);
              return (
                <tr key={c.cls}>
                  <td><ClassChip name={c.cls === '（未登记职业）' ? '' : c.cls} classMap={classMap} showIcon={false} /></td>
                  <td className="num">{c.ourCount}</td>
                  <td className="num">{num(c.ourDmg)}</td>
                  <td className="num">{c.oppCount}</td>
                  <td className="num">{num(c.oppDmg)}</td>
                  <td className="num" style={{ color: d.tone === 'ok' ? 'var(--ok)' : d.tone === 'bad' ? 'var(--danger)' : 'var(--text-faint)' }}>
                    {d.text}
                  </td>
                  <td className="num">{num(c.ourTower)}</td>
                  <td className="num">{num(c.oppTower)}</td>
                  <td className="num">{num(c.ourHeal)}</td>
                  <td className="num">{num(c.oppHeal)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        差值 = 我方人均 − 对方人均（绿色 = 我们更高）。对方数据只作对比，不参与评分。
      </div>
    </>
  );
}
