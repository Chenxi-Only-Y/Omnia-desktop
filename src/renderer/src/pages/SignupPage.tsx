import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SignupBoard, SignupImportPreview, SignupReview, SignupStatus } from '@shared/types';
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
  /** 导入预览（确认后才入库） */
  const [preview, setPreview] = useState<SignupImportPreview | null>(null);
  /** 交叉核对：本场未填表 / 报名有主档没有 */
  const [review, setReview] = useState<SignupReview | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const b = await api.signup.board(matchId);
      setBoard(b);
      setReview(await api.signup.review(matchId));
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

  /** 选报名表 xlsx → 解析出预览（不入库） */
  async function handleSignupFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const pv = await api.signup.parse(matchId, data);
      setPreview(pv);
      setError(null);
      setNotice(null);
    } catch (err) {
      setPreview(null);
      setError(`解析报名表失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /** 确认导入 */
  async function commitImport() {
    if (!preview) return;
    if (preview.duplicates.length) {
      setError('还有重复报名未处理，不能导入');
      return;
    }
    setBusy(true);
    try {
      const res = await api.signup.importRows(matchId, preview.rows);
      setPreview(null);
      setNotice(
        `已导入 ${res.imported} 条报名`
        + (res.unmatched.length ? `；其中 ${new Set(res.unmatched).size} 个 ID 不在成员主档，已在下方列出` : ''),
      );
      setError(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** 补建「报名有、主档没有」的成员 */
  async function createMissing() {
    if (!review?.signedNotInRoster.length) return;
    const ids = review.signedNotInRoster.map((r) => r.gameId);
    if (!window.confirm(`把 ${ids.length} 个 ID 补建为成员主档，并写入本场报名？`)) return;
    setBusy(true);
    try {
      const res = await api.signup.createMissing(matchId, ids);
      setNotice(`已补建 ${res.created} 名成员，写入 ${res.signups} 条报名`);
      setError(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
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
      return r.gameId.toLowerCase().includes(key) || r.mainClass.includes(q.trim())
        || r.subClass.includes(q.trim());
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
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }}
                 onChange={(e) => void handleSignupFile(e.target.files?.[0])} />
          <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? '处理中…' : '导入报名表 xlsx'}
          </button>
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
                <th>ID</th>
                <th style={{ width: 90 }}>主职业</th>
                <th style={{ width: 90 }}>副职</th>
                <th style={{ width: 90 }}>备注角色</th>
                <th style={{ width: 70 }}>麦</th>
                <th style={{ width: 250 }}>报名</th>
                <th style={{ width: 150 }}>上场名单</th>
                <th style={{ width: 130 }}>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td className="empty" colSpan={9}>没有符合条件的成员</td></tr>}
              {rows.map((r, i) => (
                <tr key={r.playerId} style={r.status !== 'active' ? { opacity: .6 } : undefined}>
                  <td className="num">{r.joinedOrder ?? i + 1}</td>
                  <td>
                    {r.gameId}
                    {r.status !== 'active' && (
                      <span className="badge-state inactive" style={{ marginLeft: 6 }}>
                        {r.status === 'left' ? '离队' : '暂离'}
                      </span>
                    )}
                    {matchId && r.signup === null && (
                      <span className="badge-flag" style={{ marginLeft: 6 }}>未填表</span>
                    )}
                  </td>
                  <td><ClassChip name={r.mainClass} classMap={classMap} /></td>
                  <td>{r.subClass
                    ? <ClassChip name={r.subClass} classMap={classMap} />
                    : <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
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

      {/* 报名表导入预览：先让用户审查，确认后才入库 */}
      {preview && (
        <div className="modal" onClick={() => setPreview(null)}>
          <div className="modal__box modal__box--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h3>报名表预览 · 共 {preview.rows.length} 条</h3>
              <button className="btn sm ghost" onClick={() => setPreview(null)}>关闭</button>
            </div>

            {preview.duplicates.length > 0 && (
              <div className="msg error">
                有 {preview.duplicates.length} 个 ID 重复报名，请回 Excel 处理后重新导入：{' '}
                {preview.duplicates.slice(0, 6).map((d) => `${d.gameId}（第 ${d.lines.join('、')} 行）`).join('；')}
                {preview.duplicates.length > 6 ? ' …' : ''}
              </div>
            )}
            {preview.invalid.length > 0 && (
              <div className="msg warn">
                {preview.invalid.length} 行无法识别（将被跳过）：
                {preview.invalid.slice(0, 6).map((x) => `第 ${x.line} 行 ${x.reason}`).join('；')}
                {preview.invalid.length > 6 ? ' …' : ''}
              </div>
            )}
            {preview.unmatched.length > 0 && (
              <div className="msg warn">
                有 {preview.unmatched.length} 个 ID 不在成员主档（导入后可在下方审查并补建）：
                {preview.unmatched.slice(0, 8).join('、')}
                {preview.unmatched.length > 8 ? ' …' : ''}
              </div>
            )}

            <div className="table-wrap" style={{ maxHeight: '46vh' }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 64 }}>行</th>
                    <th>ID</th>
                    <th style={{ width: 84 }}>参加/请假</th>
                    <th style={{ width: 60 }}>麦</th>
                    <th style={{ width: 90 }}>主职业</th>
                    <th style={{ width: 90 }}>副职</th>
                    <th style={{ width: 80 }}>在主档</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={`${r.line}-${r.gameId}`}>
                      <td className="num">{r.line}</td>
                      <td>{r.gameId}</td>
                      <td>{r.status === 'JOIN' ? '参加' : '请假'}</td>
                      <td>{r.mic || '—'}</td>
                      <td>{r.mainClass || '—'}</td>
                      <td>{r.subClass || '—'}</td>
                      <td>{preview.unmatched.includes(r.gameId)
                        ? <span className="badge-flag">缺档</span>
                        : <span style={{ color: 'var(--text-faint)' }}>是</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
              <span className="hint" style={{ margin: 0 }}>
                识别到的列：{preview.headers.filter(Boolean).join(' / ')}
              </span>
              <div className="spacer grow" />
              <button className="btn ghost" onClick={() => setPreview(null)}>取消</button>
              <button className="btn primary" disabled={busy || preview.duplicates.length > 0}
                      onClick={() => void commitImport()}>
                {busy ? '导入中…' : `确认导入 ${preview.rows.length} 条`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 交叉核对：两侧不一致的人 */}
      <div className="card" style={{ marginTop: 12 }}>
        <h3>交叉核对</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <div className="k" style={{ marginBottom: 4 }}>
              主档有、本场未填表（{review?.inRosterNotSigned.length ?? 0}）
            </div>
            {review?.inRosterNotSigned.length
              ? (
                <div className="chip-row">
                  {review.inRosterNotSigned.slice(0, 60).map((r) => (
                    <span key={r.playerId} className="badge-flag">{r.gameId}</span>
                  ))}
                  {review.inRosterNotSigned.length > 60
                    && <span className="hint">… 等 {review.inRosterNotSigned.length} 人</span>}
                </div>
              )
              : <span className="hint">没有遗漏 —— 在队成员都已填表</span>}
          </div>

          <div>
            <div className="k" style={{ marginBottom: 4 }}>
              报名有、主档没有（{review?.signedNotInRoster.length ?? 0}）
            </div>
            {review?.signedNotInRoster.length
              ? (
                <>
                  <div className="chip-row">
                    {review.signedNotInRoster.map((r) => (
                      <span key={r.gameId} className="badge-flag"
                            title={`报名：${r.status === 'JOIN' ? '参加' : '请假'}`}>
                        {r.gameId}
                      </span>
                    ))}
                  </div>
                  <div className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
                    <button className="btn" disabled={busy} onClick={() => void createMissing()}>
                      补建为成员主档（{review.signedNotInRoster.length} 个）
                    </button>
                    <span className="hint" style={{ margin: 0 }}>
                      补建只写 ID 与麦克风，职业仍从报名表来
                    </span>
                  </div>
                </>
              )
              : <span className="hint">没有孤儿报名 —— 报名表里的 ID 都在主档里</span>}
          </div>
        </div>
      </div>
    </>
  );
}
