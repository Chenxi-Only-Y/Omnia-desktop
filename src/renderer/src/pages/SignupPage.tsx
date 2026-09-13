import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SignupBoard, SignupStatus } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import ClassChip from '../components/ClassChip';
import { SIGNUP_LABEL } from '@shared/types';
import { PART_STATE_LABEL } from '@shared/domain';

interface Props extends PageProps {
  matchId: number;
  matchLabel: string;
  onBack: () => void;
  onChanged?: () => void;
}

type Filter = 'all' | 'pending' | 'joined' | 'leave' | 'bench';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '未报名' },
  { key: 'joined', label: '参加' },
  { key: 'leave', label: '请假' },
  { key: 'bench', label: '替补' },
];

const STATUS_ORDER: SignupStatus[] = ['JOIN', 'BENCH', 'LEAVE'];

/**
 * 报名 / 请假面板
 *
 * 与原表的区别：旧表这块靠 WPS 在线表单（定义名已全 #REF!，功能已死），
 * 这里是库内实体。报名（意愿）与上场名单（排表结果）分开显示，允许不一致。
 */
export default function SignupPage({ matchId, matchLabel, classMap, onBack, onChanged }: Props) {
  const [board, setBoard] = useState<SignupBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      setBoard(await api.signup.board(matchId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [matchId]);

  useEffect(() => { void load(); }, [load]);

  async function setStatus(playerId: number, status: SignupStatus) {
    try {
      await api.signup.set({ matchId, playerId, status });
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  /** 一键给所有"在队但未报名"的人标成参加（线下确认过的情况很常见） */
  async function markAllPendingJoin() {
    if (!board) return;
    const pending = board.rows.filter((r) => r.status === 'active' && r.signup === null);
    if (!pending.length) { setNotice('没有未报名的在队成员'); return; }
    if (!window.confirm(`把 ${pending.length} 名未报名的在队成员标为「参加」？`)) return;
    try {
      for (const r of pending) await api.signup.set({ matchId, playerId: r.playerId, status: 'JOIN' });
      setNotice(`已标记 ${pending.length} 人为参加`);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function applyToLineup() {
    if (!board) return;
    const marked = board.rows.filter((r) => r.signup !== null).length;
    if (!marked) { setNotice('还没有任何报名记录'); return; }
    if (!window.confirm(`按报名结果更新上场名单？\n参加 → 上场（保留已排小队）\n替补 → 替补\n请假 → 请假\n涉及 ${marked} 人。`)) return;
    try {
      const res = await api.signup.apply(matchId, []);
      setNotice(`已按报名结果更新 ${res.applied} 人的上场状态`);
      setError(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const rows = useMemo(() => {
    if (!board) return [];
    const key = q.trim().toLowerCase();
    return board.rows.filter((r) => {
      if (filter === 'pending' && r.signup !== null) return false;
      if (filter === 'joined' && r.signup !== 'JOIN') return false;
      if (filter === 'leave' && r.signup !== 'LEAVE') return false;
      if (filter === 'bench' && r.signup !== 'BENCH') return false;
      if (!key) return true;
      return r.name.toLowerCase().includes(key) || r.gameId.toLowerCase().includes(key)
        || r.mainClass.includes(q.trim());
    });
  }, [board, filter, q]);

  if (error) return <div className="msg error">{error}</div>;
  if (!board) return <div className="card"><div className="hint">加载中…</div></div>;

  const s = board.stats;

  return (
    <>
      {notice && <div className="msg ok">{notice}</div>}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="btn" onClick={onBack}>← 返回对局</button>
          <h3 style={{ margin: 0 }}>报名 / 请假 · {matchLabel}</h3>
          <div className="spacer grow" />
          <button className="btn" onClick={() => void markAllPendingJoin()}>
            未报名者全部标为参加
          </button>
          <button className="btn primary" onClick={() => void applyToLineup()}>
            按报名更新上场名单
          </button>
        </div>
      </div>

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <div className="stat"><div className="k">成员总数</div><div className="v">{s.roster}</div></div>
        <div className="stat"><div className="k">参加</div>
          <div className="v" style={{ color: 'var(--ok)' }}>{s.joined}</div></div>
        <div className="stat"><div className="k">替补</div>
          <div className="v" style={{ color: 'var(--text-dim)' }}>{s.bench}</div></div>
        <div className="stat"><div className="k">请假</div>
          <div className="v" style={{ color: 'var(--warn)' }}>{s.leave}</div></div>
        <div className="stat"><div className="k">未报名</div>
          <div className="v" style={{ color: s.none ? 'var(--warn)' : 'var(--text-faint)' }}>{s.none}</div>
          <div className="hint" style={{ marginTop: 4 }}>其中在队 {s.pending} 人</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="toolbar">
          {FILTERS.map((f) => (
            <button key={f.key}
                    className={`btn sm${filter === f.key ? ' primary' : ''}`}
                    onClick={() => setFilter(f.key)}>
              {f.label}
              {f.key === 'pending' && s.none > 0 ? `（${s.none}）` : ''}
            </button>
          ))}
          <div className="spacer grow" />
          <input className="input" style={{ width: 220 }} placeholder="搜索名字 / 角色 ID / 职业"
                 value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn ghost" onClick={() => void load()}>刷新</button>
        </div>

        <div className="table-wrap" style={{ maxHeight: '58vh' }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 50 }}>序</th>
                <th>成员</th>
                <th style={{ width: 90 }}>主职业</th>
                <th style={{ width: 90 }}>备注角色</th>
                <th style={{ width: 70 }}>麦</th>
                <th style={{ width: 250 }}>报名</th>
                <th style={{ width: 150 }}>上场名单</th>
                <th style={{ width: 130 }}>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td className="empty" colSpan={8}>没有符合条件的成员</td></tr>}
              {rows.map((r, i) => (
                <tr key={r.playerId} style={r.status !== 'active' ? { opacity: .6 } : undefined}>
                  <td className="num">{r.joinedOrder ?? i + 1}</td>
                  <td>
                    {r.name}
                    {r.gameId !== r.name && (
                      <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{r.gameId}</span>
                    )}
                    {r.status !== 'active' && (
                      <span className="badge-state inactive" style={{ marginLeft: 6 }}>
                        {r.status === 'left' ? '离队' : '暂离'}
                      </span>
                    )}
                  </td>
                  <td><ClassChip name={r.mainClass} classMap={classMap} /></td>
                  <td>{r.noteRole ? <span className="badge-note">{r.noteRole}</span> : '—'}</td>
                  <td><span className="badge-mic">{r.mic || '—'}</span></td>
                  <td>
                    <div className="row-edit">
                      {STATUS_ORDER.map((st) => (
                        <button
                          key={st}
                          className={`btn sm${r.signup === st ? ' primary' : ''}`}
                          onClick={() => void setStatus(r.playerId, st)}
                          title={`标为${SIGNUP_LABEL[st]}`}
                        >
                          {SIGNUP_LABEL[st]}
                        </button>
                      ))}
                      <button
                        className={`btn sm${r.signup === null ? ' primary' : ' ghost'}`}
                        onClick={() => void setStatus(r.playerId, 'NONE')}
                        title="清除报名（回到未报名）"
                      >
                        撤回
                      </button>
                    </div>
                  </td>
                  <td>
                    {r.lineupState ? (
                      <span className={`badge-state ${r.lineupState === 'PLAY' ? 'active' : r.lineupState === 'LEAVE' ? 'left' : 'inactive'}`}>
                        {PART_STATE_LABEL[r.lineupState]}
                      </span>
                    ) : <span style={{ color: 'var(--text-faint)' }}>未在名单</span>}
                    {r.squad && <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>{r.squad}</span>}
                  </td>
                  <td style={{ color: 'var(--text-faint)', fontSize: 11 }}>{r.signupAt || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hint">
          「报名」是意愿，「上场名单」是排表结果 —— 两者允许不一致（人工调阵容时会出现差异）。
          「按报名更新上场名单」只改状态：参加的人保留已排的小队，替补/请假会清空小队。
        </div>
      </div>
    </>
  );
}
