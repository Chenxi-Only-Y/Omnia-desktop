import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Match, PartState, Player, PlayerInput, SignupStatus } from '@shared/types';
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
  /** 橙武（空 = 没有） */
  orangeWeapon: string;
  status: string;
  remark: string;
}

const EMPTY_DRAFT: Draft = {
  id: '', joinedOrder: '', mic: '', noteRole: '', orangeWeapon: '', status: 'active', remark: '',
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
  /**
   * playerId → 本场排表状态。
   * 用户口径：「排表里有就显示在队」—— 即状态列以**排表**为准，
   * 而不是主档里那个基本没人维护的状态字段。
   */
  const [lineupOf, setLineupOf] = useState<Map<number, PartState>>(new Map());
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [wizard, setWizard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 拖拽换位：正在拖的、以及当前悬停的目标 */
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  /** 「序」的内联草稿（失焦/回车才提交，避免边打字边存导致光标跳） */
  const [orderDraft, setOrderDraftState] = useState<Record<number, string>>({});

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

  // 拉该场的报名状态与排表状态：「未填表 / 参加 / 请假」以及「在队」都按本场判定
  useEffect(() => {
    if (matchId === null) { setSignupOf(new Map()); setLineupOf(new Map()); return; }
    void api.signup.board(matchId).then((b) => {
      setSignupOf(new Map(b.rows.map((r) => [r.playerId, r.signup])));
    }).catch(() => setSignupOf(new Map()));
    void api.match.participations(matchId).then((parts) => {
      setLineupOf(new Map(
        parts.filter((r) => r.side === 'our').map((r) => [r.playerId, r.state]),
      ));
    }).catch(() => setLineupOf(new Map()));
  }, [matchId]);

  /**
   * 状态列的显示值。
   * 用户口径「排表里有就显示在队」：已选场次时以**该场排表**为准 ——
   *   排表里上场 → 在队；替补 → 替补；请假 → 请假；没进排表 → 未排表。
   * 未选场次时退回主档里存的状态（在队/暂离/离队）。
   */
  function statusOf(p: Player): { label: string; kind: string } {
    if (matchId === null) {
      return { label: STATUS_LABEL[p.status] ?? p.status, kind: p.status };
    }
    const st = lineupOf.get(p.id);
    if (st === 'PLAY') return { label: '在队', kind: 'active' };
    if (st === 'BENCH') return { label: '替补', kind: 'inactive' };
    if (st === 'LEAVE') return { label: '请假', kind: 'left' };
    return { label: '未排表', kind: 'none' };
  }

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    return players.filter((p) => {
      if (filterStatus && p.status !== filterStatus) return false;
      if (!key) return true;
      return p.gameId.toLowerCase().includes(key) || p.remark.toLowerCase().includes(key)
        || (p.orangeWeapon ?? '').toLowerCase().includes(key);
    });
  }, [players, q, filterStatus]);

  /** 列表顺序：按「序」排（没填序的排最后），同序按 id —— 改序 / 拖拽都立刻反映在这里 */
  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    const oa = a.joinedOrder ?? Number.MAX_SAFE_INTEGER;
    const ob = b.joinedOrder ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.id - b.id;
  }), [filtered]);

  function setOrderDraft(id: number, v: string) {
    setOrderDraftState((d) => ({ ...d, [id]: v }));
  }

  /** 提交「序」：空值 = 清除（排到最后） */
  async function commitOrder(p: Player) {
    const raw = orderDraft[p.id];
    if (raw === undefined) return;
    const next = raw.trim() === '' ? null : Number(raw);
    if (next !== null && !Number.isFinite(next)) return;
    if (next === (p.joinedOrder ?? null)) { setOrderDraftState((d) => { const n = { ...d }; delete n[p.id]; return n; }); return; }
    try {
      await api.player.update(p.id, { joinedOrder: next });
      setOrderDraftState((d) => { const n = { ...d }; delete n[p.id]; return n; });
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  /**
   * 拖拽换位：把 fromId 挪到 toId 的位置，然后整批写回「序」。
   * 只用当前**列表顺序**（sorted）算新顺序，所以拖完立即与界面一致。
   */
  async function moveTo(fromId: number, toId: number) {
    const ids = sorted.map((x) => x.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    try {
      await api.player.reorder(ids);
      setError(null);
      setNotice(`已按新顺序保存（${ids.length} 人）`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

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
        orangeWeapon: draft.orangeWeapon,
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
      mic: p.mic, noteRole: p.noteRole,
      orangeWeapon: p.orangeWeapon ?? '', status: p.status, remark: p.remark,
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
        orangeWeapon: editDraft.orangeWeapon,
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
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>成员列表（{filtered.length} / {players.length}）</h3>
          <div className="spacer grow" />
          <span className="hint" style={{ margin: 0 }}>
            拖动卡片可换位；「序」也可直接改，列表按序排列
          </span>
        </div>

        <div className="roster-cards">
          {loading && <div className="hint">加载中…</div>}
          {!loading && filtered.length === 0 && (
            <div className="hint">暂无成员。可以用上面的表单添加，或导入旧表的成员主档。</div>
          )}
          {/* 表头：用与卡片完全相同的列宽，所以标题与内容逐列对齐
              （改成卡片时曾把表头漏掉，每列是什么只能靠猜） */}
          {!loading && filtered.length > 0 && (
            <div className="roster-cards__head">
              <span />
              <span>序</span>
              <span>ID</span>
              <span>本场报名</span>
              <span>状态</span>
              <span>麦克风</span>
              <span>备注角色</span>
              <span>橙武</span>
              <span>备注</span>
              <span style={{ textAlign: 'right' }}>操作</span>
            </div>
          )}
          {!loading && sorted.map((p, idx) => {
            const st = statusOf(p);
            const dragOver = dragOverId === p.id && dragId !== null && dragId !== p.id;
            return (
              <div
                key={p.id}
                className={`roster-card${dragId === p.id ? ' roster-card--dragging' : ''}${dragOver ? ' roster-card--over' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDragId(p.id);
                  e.dataTransfer.effectAllowed = 'move';
                  // 某些环境必须 setData 才会触发后续 dragOver
                  e.dataTransfer.setData('text/plain', String(p.id));
                }}
                onDragOver={(e) => { e.preventDefault(); setDragOverId(p.id); }}
                onDragLeave={() => setDragOverId((cur) => (cur === p.id ? null : cur))}
                onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const fromId = Number(e.dataTransfer.getData('text/plain')) || dragId;
                  setDragId(null);
                  setDragOverId(null);
                  if (fromId && fromId !== p.id) void moveTo(fromId, p.id);
                }}
              >
                <span className="roster-card__handle" title="拖动换位">⠿</span>
                {/* 序：可直接改，改完列表按序重排 */}
                <input
                  className="input roster-card__order"
                  type="number"
                  title="序（改完按序排列）"
                  value={p.joinedOrder ?? ''}
                  placeholder={String(idx + 1)}
                  onChange={(e) => setOrderDraft(p.id, e.target.value)}
                  onBlur={() => void commitOrder(p)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitOrder(p); }}
                />
                <button className="roster-card__id" onClick={() => onOpenDetail(p.id)}
                        title="查看个人详情">{p.gameId}</button>

                <span className={`badge-state ${signupOf.get(p.id) === 'JOIN' ? 'active' : signupOf.get(p.id) === 'LEAVE' ? 'left' : 'inactive'}`}>
                  {matchId === null ? '—'
                    : signupOf.get(p.id) === 'JOIN' ? '参加'
                      : signupOf.get(p.id) === 'LEAVE' ? '请假'
                        : signupOf.get(p.id) === 'BENCH' ? '替补' : '未填表'}
                </span>
                <span className={`badge-state ${st.kind}`}>{st.label}</span>

                <span className="roster-card__meta">
                  <span>麦克风 <b>{p.mic || '—'}</b></span>
                  <span>备注角色 <b>{p.noteRole || '—'}</b></span>
                  {/* 橙武只有有/无（默认无）：有 → 这一项直接显示橙色「橙武」；
                      没有 → 显示「-」。设置入口在「编辑」里，卡片上不放输入框。 */}
                  {p.orangeWeapon === '有'
                    ? <b className="roster-orange--yes" title="有橙武">橙武</b>
                    : <b style={{ color: 'var(--text-faint)', fontWeight: 400 }} title="无橙武">-</b>}
                  <span>备注 <b>{p.remark || '—'}</b></span>
                </span>

                <span className="roster-card__actions">
                  <button className="btn sm" onClick={() => onOpenDetail(p.id)}>详情</button>
                  <button className="btn sm" onClick={() => startEdit(p)}>编辑</button>
                  <button className="btn sm danger" onClick={() => void handleRemove(p)}>删除</button>
                </span>

                {editId === p.id && (
                  <div className="roster-card__edit">
                    <span className="hint">编辑模式：改 ID / 麦克风 / 备注角色 / 序 / 备注 / 橙武</span>
                    <input className="input" style={{ width: 160 }} value={editDraft.id}
                           onChange={(e) => setEditDraft({ ...editDraft, id: e.target.value })} />
                    <select className="select" value={editDraft.mic}
                            onChange={(e) => setEditDraft({ ...editDraft, mic: e.target.value as Player['mic'] })}>
                      <option value="">—</option>
                      <option value="有">有</option><option value="无">无</option><option value="无需作答">无需作答</option>
                    </select>
                    <select className="select" value={editDraft.noteRole}
                            onChange={(e) => setEditDraft({ ...editDraft, noteRole: e.target.value as Player['noteRole'] })}>
                      <option value="">—</option>
                      {['指挥', '统战', 'K龙', '替补指挥', '长期请假'].map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <input className="input" style={{ width: 76 }} placeholder="序" value={editDraft.joinedOrder}
                           onChange={(e) => setEditDraft({ ...editDraft, joinedOrder: e.target.value })} />
                    <select className="select" value={editDraft.orangeWeapon}
                            title="橙武：有 / 无"
                            onChange={(e) => setEditDraft({ ...editDraft, orangeWeapon: e.target.value })}>
                      <option value="">无</option>
                      <option value="有">有</option>
                    </select>
                    {/* 状态：之前改造时漏掉了这个下拉，导致编辑里改不了在队状态 */}
                    <select className="select" value={editDraft.status}
                            onChange={(e) => setEditDraft({ ...editDraft, status: e.target.value })}>
                      <option value="active">在队</option>
                      <option value="inactive">暂离</option>
                      <option value="left">离队</option>
                    </select>
                    <input className="input" style={{ width: 160 }} placeholder="备注"
                           value={editDraft.remark}
                           onChange={(e) => setEditDraft({ ...editDraft, remark: e.target.value })} />
                    <button className="btn sm primary" onClick={() => void saveEdit()}>保存</button>
                    <button className="btn sm ghost" onClick={() => setEditId(null)}>取消</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </>
  );
}
