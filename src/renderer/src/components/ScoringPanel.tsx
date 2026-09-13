import { useCallback, useEffect, useState } from 'react';
import type { RuleSet, SavedScore, ScoreRunSummary } from '@shared/types';
import { api, ApiError } from '../api';

/**
 * 本场评分面板（M1）
 *
 * 引擎口径全部来自「权重与规则」里使用中的规则集，所以这里只负责：
 * 触发重算 → 显示总分与分解 → 让人看得出「为什么是这个分」。
 * 每条分数都能展开看中间量（有效值、个人原始加权、归一、职业系数、小队执行分）。
 */
export default function ScoringPanel({ matchId, playerCount }: { matchId: number; playerCount: number }) {
  const [rule, setRule] = useState<RuleSet | null>(null);
  const [summary, setSummary] = useState<ScoreRunSummary | null>(null);
  const [scores, setScores] = useState<SavedScore[]>([]);
  const [engine, setEngine] = useState<string>('');
  const [computedAt, setComputedAt] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.rules.active(), api.match.scores(matchId)]);
      setRule(r);
      // 分数按规则集分开保存，同一人可能有多套规则的历史分。
      // 列表里每人只显示最新一次计算（否则会出现重复行）。
      const byPlayer = new Map<number, SavedScore>();
      for (const x of s) {
        const cur = byPlayer.get(x.participationId);
        if (!cur || x.computedAt >= cur.computedAt) byPlayer.set(x.participationId, x);
      }
      const latest = [...byPlayer.values()].sort((a, b) => b.total - a.total);
      setScores(latest);
      setEngine(latest[0]?.engine ?? '');
      setComputedAt(latest[0]?.computedAt ?? '');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [matchId]);

  useEffect(() => { void load(); }, [load]);

  async function run() {
    setBusy(true);
    try {
      const res = await api.match.runScore(matchId, rule?.id);
      setSummary(res);
      setNotice(`已按「${res.ruleSetName}」算出 ${res.scored} 人分数`);
      setError(null);
      await load();
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const lineOf = (playerName: string, detail: boolean) => {
    const l = summary?.lines.find((x) => x.playerName === playerName);
    return detail ? l?.detail : undefined;
  };

  return (
    <div className="card" data-scores={scores.length} data-rule-id={rule?.id ?? ''}
         data-engine={engine} data-error={error ?? ''}>
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>本场评分</h3>
        <span className="hint" style={{ margin: 0 }}>
          {rule
            ? <>规则集「{rule.name}」v{rule.version} · 基础 {rule.baseScore} · 封顶 {rule.capScore} · 团队×{rule.scaleTeam} · 个人×{rule.scalePersonal}</>
            : '没有可用规则集'}
        </span>
        <div className="spacer grow" />
        <button className="btn primary" onClick={() => void run()} disabled={busy || !rule}>
          {busy ? '计算中…' : scores.length ? '按当前规则重算' : '计算本场分数'}
        </button>
        <button className="btn ghost" onClick={() => void load()} disabled={busy}>刷新</button>
      </div>

      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg ok">{notice}</div>}

      <div className="hint">
        引擎 <code>{engine || '未运行'}</code>
        {computedAt && <> · 上次计算 {computedAt}</>}
        {' · '}该口径为可标定实现，参数改动后点「重算」即可，历史分数按规则集分开保存。
      </div>

      {summary && (
        <div className="stat-grid" style={{ marginTop: 10 }}>
          <div className="stat"><div className="k">参与评分人数</div><div className="v">{summary.scored}
            <small> / {playerCount} 上场</small></div></div>
          <div className="stat"><div className="k">均分</div><div className="v">{summary.stats.avg.toFixed(1)}</div></div>
          <div className="stat"><div className="k">最低 / 最高</div>
            <div className="v" style={{ fontSize: 18 }}>{summary.stats.min.toFixed(1)}
              <small> / {summary.stats.max.toFixed(1)}</small></div></div>
          <div className="stat"><div className="k">触顶人数</div>
            <div className="v" style={{ color: summary.stats.capped ? 'var(--warn)' : undefined }}>
              {summary.stats.capped}
            </div>
            <div className="hint" style={{ marginTop: 4 }}>达到封顶分 {rule?.capScore}</div>
          </div>
        </div>
      )}

      {scores.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12, maxHeight: '52vh' }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th>队员</th>
                <th style={{ width: 110 }}>小队</th>
                <th className="num" style={{ width: 90 }}>团队分</th>
                <th className="num" style={{ width: 90 }}>个人分</th>
                <th className="num" style={{ width: 70 }}>附加</th>
                <th className="num" style={{ width: 90 }}>死亡扣分</th>
                <th className="num" style={{ width: 90 }}>总分</th>
                <th style={{ width: 70 }}>明细</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s, i) => (
                <>
                  <tr key={s.participationId}>
                    <td className="num">{i + 1}</td>
                    <td>{s.playerName}</td>
                    <td style={{ color: s.squad ? 'var(--text-dim)' : 'var(--warn)' }}>{s.squad || '未分配'}</td>
                    <td className="num">{s.teamScore.toFixed(2)}</td>
                    <td className="num">{s.personalScore.toFixed(2)}</td>
                    <td className="num">{s.bonus ? s.bonus.toFixed(1) : '—'}</td>
                    <td className="num" style={{ color: s.deathPenalty ? 'var(--danger)' : 'var(--text-faint)' }}>
                      {s.deathPenalty ? `-${s.deathPenalty.toFixed(1)}` : '—'}
                    </td>
                    <td className="num" style={{ fontWeight: 600, color: s.total >= (rule?.capScore ?? 100) - 1e-9 ? 'var(--warn)' : 'var(--text)' }}>
                      {s.total.toFixed(2)}
                    </td>
                    <td className="actions">
                      <button className="btn sm ghost"
                              onClick={() => setOpen(open === s.playerName ? null : s.playerName)}>
                        {open === s.playerName ? '收起' : '展开'}
                      </button>
                    </td>
                  </tr>
                  {open === s.playerName && (
                    <tr key={`${s.participationId}-d`}>
                      <td />
                      <td colSpan={8} style={{ whiteSpace: 'normal' }}>
                        {lineOf(s.playerName, true) ? (
                          <div className="kv">
                            {Object.entries(lineOf(s.playerName, true)!).map(([k, v]) => (
                              <span className="kv__item" key={k}>
                                <i>{k}</i>
                                <b>{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v)}</b>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-faint)' }}>
                            本次会话没有跑过计算（数据来自历史保存），点「按当前规则重算」可展开明细。
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {scores.length === 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          这场还没有算过分。点「计算本场分数」会：排除请假/替补 → 按小队与战术类型算执行分 →
          按定位算个人加权 → Min-Max 归一 → 乘刻度与职业系数 → 加附加分、扣超均死亡 → 封顶。
        </div>
      )}
    </div>
  );
}
