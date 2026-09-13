import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Player, PlayerInput } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import ClassChip from '../components/ClassChip';
import { parseTableText, toCsv } from '../lib/importer';

interface Props extends PageProps {
  onCount: (n: number) => void;
}

interface Draft {
  gameId: string;
  name: string;
  joinedOrder: string;
  mainClass: string;
  subClass: string;
  mic: Player['mic'];
  noteRole: Player['noteRole'];
  status: string;
  remark: string;
}

const EMPTY_DRAFT: Draft = {
  gameId: '', name: '', joinedOrder: '', mainClass: '', subClass: '',
  mic: '', noteRole: '', status: 'active', remark: '',
};

const STATUS_LABEL: Record<string, string> = { active: '在队', inactive: '暂离', left: '离队' };

export default function RosterPage({ classes, classMap, onCount }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
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

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    return players.filter((p) => {
      if (filterClass && p.mainClass !== filterClass && p.subClass !== filterClass) return false;
      if (filterStatus && p.status !== filterStatus) return false;
      if (!key) return true;
      return (
        p.gameId.toLowerCase().includes(key) ||
        p.name.toLowerCase().includes(key) ||
        p.mainClass.toLowerCase().includes(key) ||
        p.remark.toLowerCase().includes(key)
      );
    });
  }, [players, q, filterClass, filterStatus]);

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    let noMain = 0;
    let noMic = 0;
    for (const p of players) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      if (p.mainClass) byClass[p.mainClass] = (byClass[p.mainClass] ?? 0) + 1;
      else noMain++;
      if (!p.mic) noMic++;
    }
    return { byStatus, byClass, noMain, noMic };
  }, [players]);

  async function handleCreate() {
    if (!draft.gameId.trim()) { setError('角色 ID 必填'); return; }
    try {
      await api.player.create({
        gameId: draft.gameId.trim(),
        name: draft.name.trim() || draft.gameId.trim(),
        joinedOrder: draft.joinedOrder === '' ? null : Number(draft.joinedOrder),
        mainClass: draft.mainClass,
        subClass: draft.subClass,
        mic: draft.mic,
        noteRole: draft.noteRole,
        status: draft.status,
        remark: draft.remark,
      });
      setDraft(EMPTY_DRAFT);
      setError(null);
      setNotice(`已添加 ${draft.gameId.trim()}`);
      await load();
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function startEdit(p: Player) {
    setEditId(p.id);
    setEditDraft({
      gameId: p.gameId, name: p.name,
      joinedOrder: p.joinedOrder === null ? '' : String(p.joinedOrder),
      mainClass: p.mainClass, subClass: p.subClass,
      mic: p.mic, noteRole: p.noteRole, status: p.status, remark: p.remark,
    });
  }

  async function saveEdit() {
    if (editId === null) return;
    try {
      await api.player.update(editId, {
        gameId: editDraft.gameId.trim(),
        name: editDraft.name.trim(),
        joinedOrder: editDraft.joinedOrder === '' ? null : Number(editDraft.joinedOrder),
        mainClass: editDraft.mainClass,
        subClass: editDraft.subClass,
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
    if (!window.confirm(`确认删除成员「${p.name}」（${p.gameId}）？`)) return;
    try {
      await api.player.remove(p.id);
      setError(null);
      setNotice(`已删除 ${p.name}`);
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
        <div className="stat"><div className="k">缺主职业</div>
          <div className="v" style={{ color: stats.noMain ? 'var(--warn)' : undefined }}>{stats.noMain}</div>
        </div>
        <div className="stat"><div className="k">缺麦克风信息</div>
          <div className="v" style={{ color: stats.noMic ? 'var(--warn)' : undefined }}>{stats.noMic}</div>
        </div>
      </div>

      <div className="card">
        <h3>新增成员</h3>
        <div className="toolbar">
          <input className="input" placeholder="角色 ID *" style={{ width: 150 }}
                 value={draft.gameId} onChange={(e) => setDraft({ ...draft, gameId: e.target.value })} />
          <input className="input" placeholder="显示名" style={{ width: 130 }}
                 value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <select className="select" value={draft.mainClass}
                  onChange={(e) => setDraft({ ...draft, mainClass: e.target.value })}>
            <option value="">主职业</option>
            {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <select className="select" value={draft.subClass}
                  onChange={(e) => setDraft({ ...draft, subClass: e.target.value })}>
            <option value="">副职业</option>
            {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
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
          <input className="input grow" placeholder="搜索角色 ID / 名字 / 职业 / 备注"
                 value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" value={filterClass} onChange={(e) => setFilterClass(e.target.value)}>
            <option value="">全部职业</option>
            {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <select className="select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="active">在队</option><option value="inactive">暂离</option><option value="left">离队</option>
          </select>
          <input ref={fileRef} type="file" accept=".csv,.txt,.json" style={{ display: 'none' }}
                 onChange={(e) => void handleFile(e.target.files?.[0])} />
          <button className="btn" onClick={() => fileRef.current?.click()}>导入 CSV / JSON</button>
          <button className="btn" onClick={handleExport} disabled={!players.length}>导出 CSV</button>
          <button className="btn ghost" onClick={() => void load()}>刷新</button>
        </div>
        <div className="hint">
          导入按「角色 ID」幂等合并：新 ID 新增，已有 ID 只覆盖非空字段。
          CSV 需带表头，支持列名：角色ID / 玩家名字 / 主职业 / 副职 / 入帮排序 / 麦克风 / 备注 等。
        </div>
      </div>

      <div className="card">
        <h3>成员列表（{filtered.length} / {players.length}）</h3>
        <div className="table-wrap" style={{ maxHeight: '52vh' }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 56 }}>序</th>
                <th>角色 ID</th>
                <th>显示名</th>
                <th>主职业</th>
                <th>副职</th>
                <th>麦克风</th>
                <th>备注角色</th>
                <th>状态</th>
                <th>备注</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td className="empty" colSpan={10}>加载中…</td></tr>}
              {!loading && filtered.length === 0 && (
                <tr><td className="empty" colSpan={10}>
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
                        <td><input className="input" style={{ width: 120 }} value={editDraft.gameId}
                                   onChange={(e) => setEditDraft({ ...editDraft, gameId: e.target.value })} /></td>
                        <td><input className="input" style={{ width: 110 }} value={editDraft.name}
                                   onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} /></td>
                        <td>
                          <select className="select" value={editDraft.mainClass}
                                  onChange={(e) => setEditDraft({ ...editDraft, mainClass: e.target.value })}>
                            <option value="">—</option>
                            {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                          </select>
                        </td>
                        <td>
                          <select className="select" value={editDraft.subClass}
                                  onChange={(e) => setEditDraft({ ...editDraft, subClass: e.target.value })}>
                            <option value="">—</option>
                            {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                          </select>
                        </td>
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
                        <td>{p.gameId}</td>
                        <td>{p.name}</td>
                        <td><ClassChip name={p.mainClass} classMap={classMap} /></td>
                        <td>{p.subClass ? <ClassChip name={p.subClass} classMap={classMap} /> : <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                        <td><span className="badge-mic">{p.mic || '—'}</span></td>
                        <td>{p.noteRole ? <span className="badge-note">{p.noteRole}</span> : <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                        <td><span className={`badge-state ${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span></td>
                        <td style={{ color: 'var(--text-dim)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.remark || '—'}</td>
                        <td className="actions">
                          <div className="row-edit" style={{ justifyContent: 'flex-end' }}>
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
