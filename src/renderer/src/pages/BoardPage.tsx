import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardData } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import { MATCH_RESULT_LABEL } from '@shared/domain';

type Tab = 'attendance' | 'completeness' | 'lineup';

export default function BoardPage(_props: PageProps) {
  // 不再用 classMap：出勤明细里的职业列已按用户口径移除（职业只在单场视图显示）
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('attendance');
  const [sortKey, setSortKey] = useState<'plays' | 'rate' | 'leaves' | 'filled'>('plays');

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard.data());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const attendance = useMemo(() => {
    const rows = [...(data?.attendance ?? [])];
    rows.sort((a, b) => {
      if (sortKey === 'rate') return b.rate - a.rate || b.plays - a.plays;
      if (sortKey === 'leaves') return b.leaves - a.leaves || b.plays - a.plays;
      if (sortKey === 'filled') return b.filled - a.filled || b.plays - a.plays;
      return b.plays - a.plays;
    });
    return rows;
  }, [data, sortKey]);

  if (error) return <div className="msg error">{error}</div>;
  if (!data) return <div className="card"><div className="hint">统计中…</div></div>;

  const t = data.totals;
  const maxPlays = Math.max(1, ...data.classPlayCount.map((c) => c.plays));

  return (
    <>
      <div className="stat-grid">
        <div className="stat"><div className="k">对局总数</div><div className="v">{t.matches}</div></div>
        <div className="stat"><div className="k">成员总数</div><div className="v">{t.players}</div></div>
        <div className="stat">
          <div className="k">战报完整度</div>
          <div className="v" style={{ color: t.statRate >= 0.95 ? 'var(--ok)' : t.statRate > 0 ? 'var(--warn)' : undefined }}>
            {Math.round(t.statRate * 100)}<small> % （{t.statFilled}/{t.statSlots}）</small>
          </div>
        </div>
        <div className="stat"><div className="k">场均上场</div>
          <div className="v">{t.avgLineup.toFixed(1)}<small> 人</small></div>
        </div>
      </div>

      <div className="tabs">
        {([['attendance', '出勤'], ['completeness', '数据完整度'], ['lineup', '阵容与职业']] as const)
          .map(([k, label]) => (
            <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
      </div>

      {tab === 'attendance' && (
        <div className="card">
          <div className="toolbar">
            <h3 style={{ margin: 0 }}>出勤明细（{attendance.length} 人）</h3>
            <div className="spacer grow" />
            <label className="field"><span>排序</span>
              <select className="select" value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as typeof sortKey)}>
                <option value="plays">上场次数</option>
                <option value="rate">出勤率</option>
                <option value="leaves">请假次数</option>
                <option value="filled">战报填写数</option>
              </select>
            </label>
            <button className="btn ghost" onClick={() => void load()}>刷新</button>
          </div>
          <div className="table-wrap" style={{ maxHeight: '56vh' }}>
            <table className="grid">
              <thead>
                <tr>
                  <th className="num" style={{ width: 50 }}>#</th>
                  <th>成员</th>
                  {/* 职业不在这里显示 —— 用户口径：职业只在**看单场数据**时出现，
                      而且要显示该场报名表里上传的那个职业。这里是跨场汇总，没有"哪个职业"一说。 */}
                  <th style={{ width: 90 }}>备注角色</th>
                  <th className="num" style={{ width: 70 }}>场次</th>
                  <th className="num" style={{ width: 70 }}>上场</th>
                  <th className="num" style={{ width: 70 }}>替补</th>
                  <th className="num" style={{ width: 70 }}>请假</th>
                  <th className="num" style={{ width: 110 }}>出勤率</th>
                  <th className="num" style={{ width: 110 }}>战报已填</th>
                </tr>
              </thead>
              <tbody>
                {attendance.length === 0 && (
                  <tr><td className="empty" colSpan={9}>还没有成员或对局数据</td></tr>
                )}
                {attendance.map((r, i) => (
                  <tr key={r.playerId}>
                    <td className="num">{i + 1}</td>
                    <td>
                      {r.name}
                      {r.gameId !== r.name && <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{r.gameId}</span>}
                      {r.status !== 'active' && (
                        <span className="badge-state inactive" style={{ marginLeft: 6 }}>
                          {r.status === 'left' ? '离队' : '暂离'}
                        </span>
                      )}
                    </td>
                    <td>{r.noteRole ? <span className="badge-note">{r.noteRole}</span> : '—'}</td>
                    <td className="num">{r.matches}</td>
                    <td className="num" style={{ color: r.plays ? 'var(--text)' : 'var(--text-faint)' }}>{r.plays}</td>
                    <td className="num" style={{ color: r.benches ? 'var(--text-dim)' : 'var(--text-faint)' }}>{r.benches}</td>
                    <td className="num" style={{ color: r.leaves ? 'var(--warn)' : 'var(--text-faint)' }}>{r.leaves}</td>
                    <td className="num">
                      <span style={{ color: r.rate >= 0.8 ? 'var(--ok)' : r.rate >= 0.5 ? 'var(--text)' : 'var(--warn)' }}>
                        {Math.round(r.rate * 100)}%
                      </span>
                      <span className="ratebar"><i style={{ width: `${Math.round(r.rate * 100)}%` }} /></span>
                    </td>
                    <td className="num">{r.filled} / {r.plays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint">
            出勤率 = 上场次数 / 有记录的场次。请假次数偏高的人可在排表时优先错开。
          </div>
        </div>
      )}

      {tab === 'completeness' && (
        <>
          <div className="card">
            <h3>近期对局（上场人数 / 战报完整度）</h3>
            <div className="table-wrap" style={{ maxHeight: '34vh' }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>场次</th>
                    <th style={{ width: 70 }}>结果</th>
                    <th>对手</th>
                    <th className="num" style={{ width: 90 }}>上场</th>
                    <th className="num" style={{ width: 90 }}>已填战报</th>
                    <th style={{ width: 160 }}>完整度</th>
                  </tr>
                </thead>
                <tbody>
                  {data.matches.length === 0 && <tr><td className="empty" colSpan={6}>还没有对局</td></tr>}
                  {data.matches.map((m) => {
                    const rate = m.ourCount > 0 ? m.statFilled / m.ourCount : 0;
                    return (
                      <tr key={m.matchId}>
                        <td>{m.label}</td>
                        <td style={{ color: m.result === 'WIN' ? 'var(--ok)' : m.result === 'LOSE' ? 'var(--danger)' : 'var(--text-dim)' }}>
                          {MATCH_RESULT_LABEL[m.result as 'WIN' | 'LOSE' | 'DRAW'] ?? m.result}
                        </td>
                        <td>{m.oppSide}</td>
                        <td className="num">{m.ourCount}</td>
                        <td className="num">{m.statFilled}</td>
                        <td>
                          <span className="ratebar ratebar--wide"><i style={{
                            width: `${Math.round(rate * 100)}%`,
                            background: rate >= 0.95 ? 'var(--ok)' : 'var(--warn)',
                          }} /></span>
                          <span style={{ marginLeft: 6, color: 'var(--text-dim)' }}>{Math.round(rate * 100)}%</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>战报各维度覆盖（非零人数 / 上场人次）</h3>
            <div style={{ display: 'grid', gap: 6 }}>
              {data.metricCoverage.map((m) => {
                const rate = m.total > 0 ? m.nonZero / m.total : 0;
                return (
                  <div key={m.key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 130px', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{m.label}</span>
                    <div className="ratebar ratebar--wide"><i style={{
                      width: `${Math.round(rate * 100)}%`,
                      background: rate > 0 ? 'var(--fg)' : 'var(--line-strong)',
                    }} /></div>
                    <span className="num" style={{ textAlign: 'right', color: 'var(--text-dim)' }}>
                      {m.nonZero} / {m.total}（{Math.round(rate * 100)}%）
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="hint">
              某维度覆盖极低通常意味着「这一列整列没填」或「该职业本就不产生该指标」（如治疗职业的击败、非潮光的清泉），
              可据此判断原始战报是否录全。
            </div>
          </div>
        </>
      )}

      {tab === 'lineup' && (
        <>
          <div className="card">
            <h3>职业出场次数</h3>
            {data.classPlayCount.length === 0 ? (
              <div className="hint">还没有上场记录</div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {data.classPlayCount.map((c) => (
                  <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 70px', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: c.color, fontSize: 12 }}>{c.name}</span>
                    <div className="ratebar ratebar--wide"><i style={{ width: `${(c.plays / maxPlays) * 100}%`, background: c.color }} /></div>
                    <span className="num" style={{ textAlign: 'right' }}>{c.plays}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>小队使用次数</h3>
            <div className="table-wrap" style={{ maxHeight: '40vh' }}>
              <table className="grid">
                <thead>
                  <tr><th>小队</th><th style={{ width: 110 }}>战斗组</th><th style={{ width: 80 }}>类别</th><th className="num" style={{ width: 90 }}>上场人次</th></tr>
                </thead>
                <tbody>
                  {data.squadUsage.length === 0 && <tr><td className="empty" colSpan={4}>还没有排入小队的记录</td></tr>}
                  {data.squadUsage.map((s) => (
                    <tr key={s.squad}>
                      <td>{s.squad}</td>
                      <td style={{ color: 'var(--text-dim)' }}>{s.group || '—'}</td>
                      <td style={{ color: s.kind === 'defend' ? 'var(--kind-defend)' : s.kind === 'attack' ? 'var(--kind-attack)' : 'var(--text-faint)' }}>
                        {s.kind === 'defend' ? '防守' : s.kind === 'attack' ? '进攻' : '—'}
                      </td>
                      <td className="num">{s.plays}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="card">
        <div className="hint" style={{ margin: 0 }}>
          本页只统计「录入了什么」，不含评分。战绩榜、贡献雷达、胜率与对位差等需要评分口径的指标，
          等你定下算法（M1/M4）后会加到这一页。
        </div>
      </div>
    </>
  );
}
