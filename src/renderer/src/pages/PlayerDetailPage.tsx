import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlayerDetail, PlayerMatchRow } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import ClassChip from '../components/ClassChip';
import RadarChart from '../components/RadarChart';
import { PART_STATE_LABEL } from '@shared/domain';

interface Props extends PageProps {
  playerId: number;
  onBack: () => void;
}

type Tab = 'overview' | 'matches';

const num = (v: number): string => (v === 0 ? '—' : v.toLocaleString());

export default function PlayerDetailPage({ playerId, classMap, onBack }: Props) {
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [onlyFilled, setOnlyFilled] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.player.detail(playerId);
      setDetail(d);
      // 逐场得分：按参与记录 id 关联（分数按规则集分开存，这里取该场当前分数）
      const pairs = await Promise.all(d.matches.map(async (m) => {
        const s = await api.match.scores(m.matchId);
        return [m.matchId, s] as const;
      }));
      const map: Record<number, number> = {};
      for (const [matchId, list] of pairs) {
        const hit = list.find((x) => x.playerId === playerId);
        if (hit) map[matchId] = hit.total;
      }
      setScores(map);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [playerId]);

  useEffect(() => { void load(); }, [load]);

  /** 趋势：按日期正序（画线用），只取有战报的上场场次 */
  const trend = useMemo(() => {
    if (!detail) return [];
    return detail.matches
      .filter((m) => m.state === 'PLAY' && m.statFilled)
      .slice()
      .reverse();
  }, [detail]);

  const maxTrend = useMemo(() => {
    const vals = trend.flatMap((m) => [m.effDmg, m.effTower]);
    return Math.max(1, ...vals);
  }, [trend]);

  if (error) return <div className="msg error">{error}</div>;
  if (!detail) return <div className="card"><div className="hint">加载中…</div></div>;

  const { player, totals, radar, teamAverage } = detail;
  const clsColor = classMap.get(player.mainClass)?.color ?? '#2BCBFF';
  const listRows = onlyFilled
    ? detail.matches.filter((m) => m.statFilled)
    : detail.matches;
  /** 有分数的场次（用于均分与趋势） */
  const scoredRows = detail.matches.filter((m) => scores[m.matchId] !== undefined);
  const avgScore = scoredRows.length
    ? scoredRows.reduce((n, m) => n + scores[m.matchId], 0) / scoredRows.length
    : null;

  const cell = (v: number, extra?: string) => (
    <td className="num" style={v === 0 ? { color: 'var(--text-faint)' } : undefined}>
      {v === 0 ? '—' : v.toLocaleString()}{extra}
    </td>
  );

  return (
    <>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={onBack}>← 成员主档</button>
          <h3 style={{ margin: 0 }}>
            {player.name}
            {player.gameId !== player.name && (
              <span style={{ color: 'var(--text-faint)', marginLeft: 8, fontSize: 12 }}>{player.gameId}</span>
            )}
          </h3>
          <ClassChip name={player.mainClass} classMap={classMap} />
          {player.subClass && <ClassChip name={player.subClass} classMap={classMap} />}
          {player.noteRole && <span className="badge-note">{player.noteRole}</span>}
          <span className={`badge-state ${player.status}`}>
            {player.status === 'active' ? '在队' : player.status === 'left' ? '离队' : '暂离'}
          </span>
          <div className="spacer grow" />
          <span className="meta">入帮序 {player.joinedOrder ?? '—'} · 麦 {player.mic || '—'}</span>
        </div>
        {player.remark && <div className="hint">备注：{player.remark}</div>}
      </div>

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <div className="stat"><div className="k">有记录场次</div><div className="v">{totals.matches}</div>
          <div className="hint" style={{ marginTop: 4 }}>
            上场 {totals.plays} · 替补 {totals.benches} · 请假 {totals.leaves}
          </div>
        </div>
        <div className="stat">
          <div className="k">战报完整度</div>
          <div className="v" style={{ color: totals.statFilled === totals.plays ? 'var(--ok)' : 'var(--warn)' }}>
            {totals.statFilled}<small> / {totals.plays} 场</small>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>只有填了战报的场次才计入下方数值</div>
        </div>
        <div className="stat"><div className="k">有效击杀（含清泉）</div><div className="v">{num(totals.effKills)}</div></div>
        <div className="stat"><div className="k">有效人伤</div>
          <div className="v" style={{ fontSize: 18 }}>{totals.effDmg.toLocaleString()}</div></div>
        <div className="stat"><div className="k">有效塔伤</div>
          <div className="v" style={{ fontSize: 18 }}>{totals.effTower.toLocaleString()}</div></div>
        <div className="stat"><div className="k">治疗 / 承伤</div>
          <div className="v" style={{ fontSize: 16 }}>
            {totals.healing.toLocaleString()}<small> / {totals.taken.toLocaleString()}</small>
          </div>
        </div>
        <div className="stat"><div className="k">重伤 / 复活</div>
          <div className="v" style={{ fontSize: 18 }}>{totals.deaths}<small> / {totals.revives}</small></div>
          <div className="hint" style={{ marginTop: 4 }}>
            场均重伤 {totals.statFilled ? (totals.deaths / totals.statFilled).toFixed(2) : '—'}
          </div>
        </div>
        <div className="stat"><div className="k">已有评分的场次</div>
          <div className="v">{scoredRows.length}<small> 场</small></div>
          <div className="hint" style={{ marginTop: 4 }}>
            {avgScore === null
              ? '还没算过分（去对局的「本场评分」页签计算）'
              : `平均 ${avgScore.toFixed(1)} 分`}
          </div>
        </div>
      </div>

      <div className="tabs">
        {([['overview', '能力对比与趋势'], ['matches', `逐场明细（${listRows.length}）`]] as const)
          .map(([k, label]) => (
            <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="card">
            <h3>六维对比（个人场均 vs 球队人均）</h3>
            {totals.statFilled === 0 ? (
              <div className="hint">这个人还没有填写过战报，无法做能力对比。</div>
            ) : (
              <div className="radar-wrap">
                <RadarChart axes={radar} color={clsColor} size={300} />
                <div className="radar-legend">
                  <div className="radar-legend__row">
                    <span className="lg" style={{ background: clsColor }} />
                    <b>{player.name}</b> 场均
                  </div>
                  <div className="radar-legend__row">
                    <span className="lg lg--base" />
                    球队人均（虚线基准圈 = 1.0）
                  </div>
                  <div className="radar-legend__hint">
                    最外圈 = 球队人均的 2 倍。比值越靠外，说明这项相对队内越突出。
                  </div>
                  <table className="grid" style={{ marginTop: 8 }}>
                    <thead>
                      <tr><th>维度</th><th className="num">本人场均</th><th className="num">球队人均</th><th className="num">比值</th></tr>
                    </thead>
                    <tbody>
                      {radar.map((a) => (
                        <tr key={a.key}>
                          <td>{a.label}</td>
                          <td className="num">{Math.round(a.self).toLocaleString()}</td>
                          <td className="num" style={{ color: 'var(--text-dim)' }}>{Math.round(a.teamAvg).toLocaleString()}</td>
                          <td className="num" style={{
                            color: a.ratio >= 1.15 ? 'var(--ok)' : a.ratio >= 0.85 ? 'var(--text)' : 'var(--warn)',
                          }}>
                            {a.teamAvg > 0 ? a.ratio.toFixed(2) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h3>逐场趋势（有效人伤 / 有效塔伤）</h3>
            {trend.length < 2 ? (
              <div className="hint">至少需要 2 场有战报的记录才能画趋势（当前 {trend.length} 场）。</div>
            ) : (
              <div className="trend">
                {trend.map((m) => (
                  <div className="trend__col" key={m.matchId} title={`${m.matchLabel} ${m.oppSide}`}>
                    <div className="trend__bars">
                      <span className="trend__bar trend__bar--dmg"
                            style={{ height: `${Math.max(2, (m.effDmg / maxTrend) * 100)}%` }} />
                      <span className="trend__bar trend__bar--tower"
                            style={{ height: `${Math.max(2, (m.effTower / maxTrend) * 100)}%` }} />
                    </div>
                    <div className="trend__label">{m.date.slice(5)}<br />-{m.indexInDay}</div>
                  </div>
                ))}
                <div className="trend__legend">
                  <span className="lg lg--dmg" />有效人伤
                  <span className="lg lg--tower" style={{ marginLeft: 10 }} />有效塔伤
                  <div style={{ color: 'var(--text-faint)', marginTop: 4 }}>柱高按本人最大值归一</div>
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h3>球队基准（所有我方上场记录的人均）</h3>
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>有效击杀</th><th>助攻</th><th>有效人伤</th><th>有效塔伤</th>
                    <th>治疗量</th><th>承伤</th><th>重伤</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="num">{Math.round(teamAverage.effKills).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.assists).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.effDmg).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.effTower).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.healing).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.taken).toLocaleString()}</td>
                    <td className="num">{teamAverage.deaths.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'matches' && (
        <div className="card">
          <div className="toolbar">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} />
              只看已填战报的场次
            </label>
            <div className="spacer grow" />
            <button className="btn ghost" onClick={() => void load()}>刷新</button>
          </div>
          <div className="table-wrap" style={{ maxHeight: '56vh' }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 120 }}>场次</th>
                  <th style={{ width: 60 }}>结果</th>
                  <th>对手</th>
                  <th style={{ width: 100 }}>小队</th>
                  <th style={{ width: 80 }}>职业</th>
                  <th style={{ width: 70 }}>状态</th>
                  <th className="num" style={{ width: 80 }}>总分</th>
                  <th className="num">有效击杀</th>
                  <th className="num">助攻</th>
                  <th className="num">有效人伤</th>
                  <th className="num">有效塔伤</th>
                  <th className="num">治疗</th>
                  <th className="num">承伤</th>
                  <th className="num">重伤</th>
                  <th className="num">复活</th>
                </tr>
              </thead>
              <tbody>
                {listRows.length === 0 && (
                  <tr><td className="empty" colSpan={14}>没有记录</td></tr>
                )}
                {listRows.map((m: PlayerMatchRow) => (
                  <tr key={m.matchId} style={m.state !== 'PLAY' ? { opacity: .6 } : undefined}>
                    <td>{m.matchLabel}</td>
                    <td style={{ color: m.result === 'WIN' ? 'var(--ok)' : m.result === 'LOSE' ? 'var(--danger)' : 'var(--text-dim)' }}>
                      {m.result === 'WIN' ? '胜' : m.result === 'LOSE' ? '负' : '平'}
                    </td>
                    <td>{m.oppSide}</td>
                    <td>{m.squad || <span style={{ color: 'var(--text-faint)' }}>未分配</span>}</td>
                    <td><ClassChip name={m.classUsed} classMap={classMap} showIcon={false} /></td>
                    <td>
                      <span className={`badge-state ${m.state === 'PLAY' ? 'active' : m.state === 'LEAVE' ? 'left' : 'inactive'}`}>
                        {PART_STATE_LABEL[m.state]}
                      </span>
                    </td>
                    {m.statFilled ? (
                      <>
                        <td className="num" style={{ fontWeight: 600, color: scores[m.matchId] !== undefined ? 'var(--text)' : 'var(--text-faint)' }}>
                          {scores[m.matchId] !== undefined ? scores[m.matchId].toFixed(2) : '未算'}
                        </td>
                        {cell(m.effKills)}{cell(m.assists)}
                        {cell(m.effDmg)}{cell(m.effTower)}
                        {cell(m.healing)}{cell(m.taken)}
                        {cell(m.deaths)}{cell(m.revives)}
                      </>
                    ) : (
                      <td colSpan={9} style={{ color: 'var(--text-faint)' }}>未填战报</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint">
            有效人伤 = 对玩家伤害 + 人伤卸甲；有效塔伤 = 对建筑伤害 + 破塔卸甲；
            「有效击杀」含清泉（对应原表「击败/清泉」）。替补与请假场次不参与数值汇总。
          </div>
        </div>
      )}
    </>
  );
}
