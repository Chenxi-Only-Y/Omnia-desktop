import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Match, Player, PlayerInput, SignupStatus } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import ImportWizard from '../components/ImportWizard';
import { parseTableText, toCsv } from '../lib/importer';

interface Props extends PageProps {
  onCount: (n: number) => void;
  /** 打开成员详情 */
  onOpenDetail: (playerId: number) => void;
}

interface Draft {
  /** 「ID名」与「昵称」已合并为单一字段 ID */
  id: string;
  joinedOrder: string;
  mic: Player['mic'];
  noteRole: Player['noteRole'];
  status: string;
  remark: string;
}

const EMPTY_DRAFT: Draft = {
  id: '', joinedOrder: '', mic: '', noteRole: '', status: 'active', remark: '',
};

const STATUS_LABEL: Record<string, string> = { active: '在队', inactive: '暂离', left: '离队' };

export default function RosterPage({ classes, classMap, onCount, onOpenDetail }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  /** 当前场次：用于判定「未填表」（报名表是分场次的） */
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchId, setMatchId] = useState<number | null>(null);
  /** playerId → 本场报名状态（null 表示未填表） */
  const [signupOf, setSignupOf] = useState<Map<number, SignupStatus | null>>(new Map());
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [wizard, setWizard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.player.list();
      setPlayers(rows);
      onCount(rows.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onCount]);

  useEffect(() => { void load(); }, [load]);

  // 场次列表：默认选最新一场（报名表是按场次导入的）
  useEffect(() => {
    void api.match.list().then((ms) => {
      setMatches(ms);
      setMatchId((cur) => cur ?? (ms.length ? ms[0].id : null));
    }).catch(() => { /* 没有场次时保持空 */ });
  }, []);

  // 拉该场的报名状态，供「未填表 / 参加 / 请假」标记
  useEffect(() => {
    if (matchId === null) { setSignupOf(new Map()); return; }
    void api.signup.board(matchId).then((b) => {
      setSignupOf(new Map(b.rows.map((r) => [r.playerId, r.signup])));
    }).catch(() => setSignupOf(new Map()));
  }, [matchId]);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    return players.filter((p) => {
      if (filterStatus && p.status !== filterStatus) return false;
      if (!key) return true;
      return p.gameId.toLowerCase().includes(key) || p.remark.toLowerCase().includes(key);
    });
  }, [players, q, filterStatus]);

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let noMic = 0;
    for (const p of players) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      if (!p.mic) noMic++;
    }
    // 「未填表」= 在队但本场没有报名记录（报名表是分场次的）
    const active = players.filter((p) => p.status === 'active');
    const notFilled = matchId === null
      ? 0
      : active.filter((p) => (signupOf.get(p.id) ?? null) === null).length;
    const joined = active.filter((p) => signupOf.get(p.id) === 'JOIN').length;
    const leave = active.filter((p) => signupOf.get(p.id) === 'LEAVE').length;
    return { byStatus, noMic, notFilled, joined, leave };
  }, [players, signupOf, matchId]);

  async function handleCreate() {
    const id = draft.id.trim();
    if (!id) { setError('ID 必填'); return; }
    try {
      await api.player.create({
        gameId: id,
        name: id,   // ID 名与昵称已合并，两处同值
        joinedOrder: draft.joinedOrder === '' ? null : Number(draft.joinedOrder),
        mic: draft.mic,
        noteRole: draft.noteRole,
        status: draft.status,
        remark: draft.remark,
      });
      setDraft(EMPTY_DRAFT);
      setError(null);
      setNotice(`已添加 ${id}`);
      await load();
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function startEdit(p: Player) {
    setEditId(p.id);
    setEditDraft({
      id: p.gameId,
      joinedOrder: p.joinedOrder === null ? '' : String(p.joinedOrder),
      mic: p.mic, noteRole: p.noteRole, status: p.status, remark: p.remark,
    });
  }

  async function saveEdit() {
    if (editId === null) return;
    try {
      const id = editDraft.id.trim();
      await api.player.update(editId, {
        gameId: id,
        name: id,
        joinedOrder: editDraft.joinedOrder === '' ? null : Number(editDraft.joinedOrder),
        mic: editDraft.mic,
        noteRole: editDraft.noteRole,
        status: editDraft.status,
        remark: editDraft.remark,
      });
      setEditId(null);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleRemove(p: Player) {
    if (!window.confirm(`确认删除成员「${p.gameId}」？`)) return;
    try {
      await api.player.remove(p.id);
      setError(null);
      setNotice(`已删除 ${p.gameId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      const rows: PlayerInput[] = file.name.toLowerCase().endsWith('.json')
        ? (JSON.parse(text) as PlayerInput[])
        : parseTableText(text);
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('文件里没有解析出任何记录');
      const res = await api.player.import(rows);
      setError(null);
      setNotice(
        `导入完成：新增 ${res.inserted}，更新 ${res.updated}，跳过 ${res.skipped}` +
        (res.errors.length ? `；提示 ${res.errors.length} 条（见控制台）` : ''),
      );
      if (res.errors.length) console.warn('[import] 提示:', res.errors);
      await load();
    } catch (err) {
      setNotice(null);
      setError(`导入失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleExport() {
    try {
      const rows = await api.player.export();
      const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `万象Omnia_成员主档_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${rows.length} 条记录`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg ok">{notice}</div>}

      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <div className="stat"><div className="k">成员总数</div><div className="v">{players.length}</div></div>
        <div className="stat"><div className="k">在队 / 暂离 / 离队</div>
          <div className="v">{stats.byStatus.active ?? 0}<small> / {stats.byStatus.inactive ?? 0} / {stats.byStatus.left ?? 0}</small></div>
        </div>
        <div className="stat"><div className="k">本场未填表</div>
          <div className="v" style={{ color: stats.notFilled ? 'var(--warn)' : undefined }}>{stats.notFilled}</div>
        </div>
        <div className="stat"><div className="k">本场参加 / 请假</div>
          <div className="v">{stats.joined}<small> / {stats.leave}</small></div>
        </div>
        <div className="stat"><div className="k">缺麦克风信息</div>
          <div className="v" style={{ color: stats.noMic ? 'var(--warn)' : undefined }}>{stats.noMic}</div>
        </div>
      </div>

      <div className="card">
        <h3>新增成员</h3>
        <div className="toolbar">
          <input className="input" placeholder="ID *" style={{ width: 200 }}
                 value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
          <select className="select" value={draft.mic}
                  onChange={(e) => setDraft({ ...draft, mic: e.target.value as Player['mic'] })}>
            <option value="">麦克风</option>
            <option value="有">有</option><option value="无">无</option><option value="无需作答">无需作答</option>
          </select>
          <select className="select" value={draft.noteRole}
                  onChange={(e) => setDraft({ ...draft, noteRole: e.target.value as Player['noteRole'] })}>
            <option value="">备注角色</option>
            {['指挥', '统战', 'K龙', '替补指挥', '长期请假'].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <input className="input" placeholder="入帮序" style={{ width: 76 }}
                 value={draft.joinedOrder} onChange={(e) => setDraft({ ...draft, joinedOrder: e.target.value })} />
          <input className="input" placeholder="备注（技能/装备标签）" style={{ width: 200 }}
                 value={draft.remark} onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
          <button className="btn primary" onClick={handleCreate}>添加</button>
        </div>

        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input className="input grow" placeholder="搜索 ID / 备注"
                 value={q} onChange={(e) => setQ(e.target.value)} />
          {/* 「未填表」是相对某一场的报名表而言，所以这里必须选场次 */}
          <select className="select" value={matchId ?? ''}
                  onChange={(e) => setMatchId(e.target.value === '' ? null : Number(e.target.value))}
                  title="选择场次：用于判定成员是否已填报名表">
            <option value="">（不比对场次）</option>
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.date} 第 {m.indexInDay} 场 · {m.oppSide}
              </option>
            ))}
          </select>
          <select className="select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="active">在队</option><option value="inactive">暂离</option><option value="left">离队</option>
          </select>
          <input ref={fileRef} type="file" accept=".csv,.txt,.json" style={{ display: 'none' }}
                 onChange={(e) => void handleFile(e.target.files?.[0])} />
          <button className="btn primary" onClick={() => setWizard(true)}>从 xlsx 导入</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>导入 CSV / JSON</button>
          <button className="btn" onClick={handleExport} disabled={!players.length}>导出 CSV</button>
          <button className="btn ghost" onClick={() => void load()}>刷新</button>
        </div>
        <div className="hint">
          导入按「角色 ID」幂等合并：新 ID 新增，已有 ID 只覆盖非空字段。
          xlsx 导入会自动列出工作表并探测表头行（旧表的表头在第 5~6 行也能认）；
          CSV 需带表头，支持列名：角色ID / 玩家名字 / 主职业 / 副职 / 入帮排序 / 麦克风 / 备注 等。
        </div>
      </div>

      {wizard && (
        <ImportWizard
          classes={classes}
          classMap={classMap}
          mode="player"
          onClose={() => setWizard(false)}
          onDone={(msg) => { setNotice(msg); void load(); }}
        />
      )}

      <div className="card">
        <h3>成员列表（{filtered.length} / {players.length}）</h3>
        <div className="table-wrap" style={{ maxHeight: '52vh' }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 56 }}>序</th>
                <th>ID</th>
                <th>本场报名</th>
                <th>麦克风</th>
                <th>备注角色</th>
                <th>状态</th>
                <th>备注</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td className="empty" colSpan={8}>加载中…</td></tr>}
              {!loading && filtered.length === 0 && (
                <tr><td className="empty" colSpan={8}>
                  暂无成员。可以用上面的表单添加，或导入旧表的成员主档。
                </td></tr>
              )}
              {!loading && filtered.map((p) => {
                const editing = editId === p.id;
                return (
                  <tr key={p.id}>
                    <td className="num">{p.joinedOrder ?? '—'}</td>
                    {editing ? (
                      <>
                        <td><input className="input" style={{ width: 180 }} value={editDraft.id}
                                   onChange={(e) => setEditDraft({ ...editDraft, id: e.target.value })} /></td>
                        <td style={{ color: 'var(--text-faint)' }}>—</td>
                        <td>
                          <select className="select" value={editDraft.mic}
                                  onChange={(e) => setEditDraft({ ...editDraft, mic: e.target.value as Player['mic'] })}>
                            <option value="">—</option>
                            <option value="有">有</option><option value="无">无</option><option value="无需作答">无需作答</option>
                          </select>
                        </td>
                        <td>
                          <select className="select" value={editDraft.noteRole}
                                  onChange={(e) => setEditDraft({ ...editDraft, noteRole: e.target.value as Player['noteRole'] })}>
                            <option value="">—</option>
                            {['指挥', '统战', 'K龙', '替补指挥', '长期请假'].map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </td>
                        <td>
                          <select className="select" value={editDraft.status}
                                  onChange={(e) => setEditDraft({ ...editDraft, status: e.target.value })}>
                            <option value="active">在队</option><option value="inactive">暂离</option><option value="left">离队</option>
                          </select>
                        </td>
                        <td><input className="input" style={{ width: 140 }} value={editDraft.remark}
                                   onChange={(e) => setEditDraft({ ...editDraft, remark: e.target.value })} /></td>
                        <td className="actions">
                          <div className="row-edit" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn sm primary" onClick={() => void saveEdit()}>保存</button>
                            <button className="btn sm ghost" onClick={() => setEditId(null)}>取消</button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>
                          <span className="roster-name-link" role="button" tabIndex={0}
                                title="查看个人详情"
                                onClick={() => onOpenDetail(p.id)}
                                onKeyDown={(e) => { if (e.key === 'Enter') onOpenDetail(p.id); }}>
                            {p.gameId}
                          </span>
                        </td>
                        <td>{(() => {
                          const st = signupOf.get(p.id) ?? null;
                          if (matchId === null) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
                          if (st === 'JOIN') return <span className="badge-state active">参加</span>;
                          if (st === 'LEAVE') return <span className="badge-state left">请假</span>;
                          if (st === 'BENCH') return <span className="badge-state inactive">替补</span>;
                          return <span className="badge-flag">未填表</span>;
                        })()}</td>
                        <td><span className="badge-mic">{p.mic || '—'}</span></td>
                        <td>{p.noteRole ? <span className="badge-note">{p.noteRole}</span> : <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                        <td><span className={`badge-state ${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span></td>
                        <td style={{ color: 'var(--text-dim)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.remark || '—'}</td>
                        <td className="actions">
                          <div className="row-edit" style={{ justifyContent: 'flex-end' }}>
                            <button className="btn sm" onClick={() => onOpenDetail(p.id)}>详情</button>
                            <button className="btn sm" onClick={() => startEdit(p)}>编辑</button>
                            <button className="btn sm danger" onClick={() => void handleRemove(p)}>删除</button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
