import { useEffect, useMemo, useState } from 'react';
import type { Match, ParticipationRow, RuleSet, SavedScore } from '@shared/types';
import { api, errText } from '../api';

/**
 * 评分页（独立页签，用户 2026-10-24：「帮会首页那栏单独加个评分页」）
 *
 * 内容：选一场 → 看这场已保存的分数（团队 / 个人 / 附加 / 扣分 / 总分）→ 一键按当前规则重算。
 * 评分口径见仓库根目录 ALGORITHM.md。
 */
export default function ScorePage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [rules, setRules] = useState<RuleSet[]>([]);
  const [matchId, setMatchId] = useState<number | null>(null);
  const [scores, setScores] = useState<SavedScore[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  /* 手动赋分（K龙 / 阵容问题）：直接写回参战记录，重算后进总分 */
  const [parts, setParts] = useState<ParticipationRow[]>([]);
  const [draft, setDraft] = useState<Record<number, { points: string; reason: string }>>({});

  const activeRule = useMemo(() => rules.find((r) => r.active) ?? null, [rules]);

  useEffect(() => {
    void (async () => {
      try {
        const [m, r] = await Promise.all([api.match.list(), api.rules.list()]);
        setMatches(m);
        setRules(r);
        const first = m[0];
        if (first) setMatchId(first.id);
      } catch (e) { setError(errText(e)); }
    })();
  }, []);

  useEffect(() => {
    if (matchId == null) return;
    void (async () => {
      try {
        setScores(await api.match.scores(matchId));
        setError(null);
      } catch (e) { setError(errText(e)); }
    })();
  }, [matchId]);

  const current = matches.find((m) => m.id === matchId) ?? null;

  const recompute = async (): Promise<void> => {
    if (matchId == null) return;
    setBusy(true); setMsg(null); setError(null);
    try {
      const r = await api.match.runScore(matchId);
      setMsg(`已重算 ${r.scored} 人（规则：${r.ruleSetName} · 引擎 ${r.engine}）`);
      setScores(await api.match.scores(matchId));
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const doClear = async (): Promise<void> => {
    if (matchId == null) return;
    setBusy(true); setMsg(null); setError(null);
    try {
      const n = await api.match.clearScores(matchId);
      setMsg(`已删除本场评分 ${n} 条（战报数据保留）`);
      setScores([]);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); setConfirmClear(false); }
  };

  const saveManual = async (p: ParticipationRow): Promise<void> => {
    const d = draft[p.id];
    const pts = Number(d?.points ?? p.manualBonus ?? 0) || 0;
    const reason = d?.reason ?? p.manualReason ?? '';
    try {
      await api.match.setManualBonus(p.id, pts, reason);
      setParts((prev) => prev.map((x) => (x.id === p.id ? { ...x, manualBonus: pts, manualReason: reason } : x)));
      setMsg('手动赋分已保存（记得点「按当前规则重算」才进总分）');
    } catch (e) { setError(errText(e)); }
  };

  const sum = scores.reduce((s, x) => s + x.total, 0);
  const avg = scores.length ? sum / scores.length : 0;
  const teamAvg = scores.length ? scores.reduce((s, x) => s + x.teamScore, 0) / scores.length : 0;
  const persAvg = scores.length ? scores.reduce((s, x) => s + x.personalScore, 0) / scores.length : 0;

  return (
    <>
      <div className="card">
        <div className="row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>评分</h3>
          <select className="input" style={{ minWidth: 260 }} value={matchId ?? ''}
                  onChange={(e) => setMatchId(Number(e.target.value))}>
            {matches.length === 0 && <option value="">（还没有对局）</option>}
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.date} 第{m.indexInDay}场 · {m.ourSide} vs {m.oppSide}（{m.result === 'WIN' ? '胜' : m.result === 'LOSE' ? '负' : '平'}）
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy || matchId == null} onClick={() => void recompute()}>
            {busy ? '计算中…' : '按当前规则重算'}
          </button>
          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
            生效规则：{activeRule ? `${activeRule.name} v${activeRule.version}` : '（无）'}
          </span>
          {/* 删除本场评分：两步确认，防止误点（用户 2026-10-24） */}
          {scores.length > 0 && (
            confirmClear ? (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--warn)', fontSize: 12 }}>确定删除本场 {scores.length} 条评分？</span>
                <button className="btn" disabled={busy} onClick={() => void doClear()}>确认删除</button>
                <button className="btn" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button>
              </span>
            ) : (
              <button className="btn" disabled={busy} onClick={() => setConfirmClear(true)}>删除本场评分</button>
            )
          )}
        </div>
        {msg && <div className="msg" style={{ marginTop: 8 }}>{msg}</div>}
        {error && <div className="msg error" style={{ marginTop: 8 }}>{error}</div>}
        {current && (
          <div className="hint" style={{ marginTop: 8 }}>
            塔 {current.ourTowersLeft}/{current.oppTowersLeft} · 已评分 {scores.length} 人
            {scores.length > 0 && ` · 均分 ${avg.toFixed(2)}（团队 ${teamAvg.toFixed(2)} ｜ 个人 ${persAvg.toFixed(2)}）`}
          </div>
        )}
      </div>

      <div className="card">
        <h3>分数明细{scores.length === 0 && '（这场还没算过，点上面的「按当前规则重算」）'}</h3>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>玩家</th><th>小队</th>
                <th className="num">团队分</th><th className="num">个人分</th>
                <th className="num">附加</th><th className="num">重伤扣分</th>
                <th className="num">总分</th>
              </tr>
            </thead>
            <tbody>
              {scores.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-faint)' }}>暂无数据</td></tr>
              )}
              {scores.map((s) => (
                <tr key={s.participationId}>
                  <td>{s.playerName}</td>
                  <td>{s.squad || '—'}</td>
                  <td className="num">{s.teamScore.toFixed(2)}</td>
                  <td className="num">{s.personalScore.toFixed(2)}</td>
                  <td className="num">{s.bonus.toFixed(1)}</td>
                  <td className="num">{s.deathPenalty.toFixed(2)}</td>
                  <td className="num"><b>{s.total.toFixed(2)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h3>手动赋分（K龙 / 阵容问题）</h3>
        <div className="hint" style={{ marginBottom: 8 }}>
          正负均可（例如 +2 或 −1.5）。保存后要点上面的「按当前规则重算」才会进总分 ——
          这笔分会加到「附加」里，与备注角色的规则加分分开记。
        </div>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>玩家</th><th>小队</th><th className="num">已存</th>
                <th className="num" style={{ width: 110 }}>本次</th>
                <th style={{ width: 220 }}>原因</th><th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {parts.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-faint)' }}>选一场对局后显示上场名单</td></tr>
              )}
              {parts.map((p) => {
                const d = draft[p.id] ?? { points: String(p.manualBonus ?? 0), reason: p.manualReason ?? '' };
                return (
                  <tr key={p.id}>
                    <td>{p.gameId || p.name}</td>
                    <td>{p.squad || '—'}</td>
                    <td className="num" style={{ color: (p.manualBonus ?? 0) !== 0 ? 'var(--warn)' : 'var(--text-faint)' }}>
                      {(p.manualBonus ?? 0).toFixed(1)}
                    </td>
                    <td>
                      <input className="input cell-num" type="number" step="0.5" value={d.points}
                             onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, points: e.target.value } })} />
                    </td>
                    <td>
                      <input className="input" list="manual-reasons" placeholder="K龙 / 阵容问题 / 其他"
                             value={d.reason}
                             onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, reason: e.target.value } })} />
                    </td>
                    <td>
                      <button className="btn" onClick={() => void saveManual(p)}>保存</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="manual-reasons">
          <option value="K龙" /><option value="阵容问题" /><option value="替补补位" /><option value="其他" />
        </datalist>
      </div>
    </>
  );
}



