import { useCallback, useEffect, useState } from 'react';
import type { MatchSummary, SeasonSummary } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';

interface Props extends PageProps {
  /** 切换赛季后让上层刷新（总览页等依赖当前赛季） */
  onSeasonChanged?: () => void;
}

const EMPTY = { name: '', startedAt: '', endedAt: '', remark: '' };

export default function SeasonsPage({ onSeasonChanged }: Props) {
  const [list, setList] = useState<SeasonSummary[]>([]);
  const [active, setActive] = useState<SeasonSummary | null>(null);
  const [orphans, setOrphans] = useState<MatchSummary[]>([]);
  const [draft, setDraft] = useState(EMPTY);
  /** 正在编辑的赛季 id；编辑内容单独存，避免直接改列表对象造成 React 看不到变化 */
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const seasons = await api.season.list();
      setList(seasons);
      setActive(seasons.find((s) => s.active) ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    try {
      await fn();
      setError(null);
      setNotice(okMsg);
      await load();
      onSeasonChanged?.();
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function scanOrphans() {
    try {
      const matches = await api.match.list();
      setOrphans(matches.filter((m) => !m.seasonId));
      setNotice(`扫描完成：${matches.length} 场对局，其中 ${matches.filter((m) => !m.seasonId).length} 场未归档`);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg ok">{notice}</div>}

      <div className="card">
        <h3>当前赛季</h3>
        {active ? (
          <div className="stat-grid">
            <div className="stat">
              <div className="k">赛季</div>
              <div className="v" style={{ fontSize: 18 }}>{active.name}</div>
            </div>
            <div className="stat">
              <div className="k">起止</div>
              <div className="v" style={{ fontSize: 14 }}>
                {active.startedAt || '—'} <small>→</small> {active.endedAt || '—'}
              </div>
            </div>
            <div className="stat">
              <div className="k">对局</div>
              <div className="v">{active.matchCount}<small> 场</small></div>
            </div>
            <div className="stat">
              <div className="k">规则集</div>
              <div className="v">{active.ruleSetCount}<small> 套</small></div>
            </div>
            <div className="stat">
              <div className="k">数据区间</div>
              <div className="v" style={{ fontSize: 14 }}>
                {active.firstDate || '—'} <small>→</small> {active.lastDate || '—'}
              </div>
            </div>
          </div>
        ) : <div className="empty">还没有赛季</div>}
        <div className="hint">
          赛季只给「对局」和「规则集」打标；成员主档与战斗组建制是跨赛季的长期资产，不随赛季切换。
        </div>
      </div>

      <div className="card">
        <h3>赛季列表</h3>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 60 }}>状态</th>
                <th style={{ width: 180 }}>名称</th>
                <th style={{ width: 230 }}>起止</th>
                <th style={{ width: 80 }}>对局</th>
                <th style={{ width: 80 }}>规则集</th>
                <th style={{ width: 200 }}>数据区间</th>
                <th>备注</th>
                <th style={{ width: 210 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td className="empty" colSpan={8}>还没有赛季</td></tr>}
              {list.map((s) => (
                <tr key={s.id}>
                  <td>{s.active
                    ? <span style={{ color: 'var(--ok)', fontWeight: 600 }}>● 当前</span>
                    : <span style={{ color: 'var(--text-dim)' }}>○</span>}</td>
                  <td>{s.name}</td>
                  <td style={{ color: 'var(--text-dim)' }}>
                    {s.startedAt || '—'} → {s.endedAt || '—'}
                  </td>
                  <td className="num">{s.matchCount}</td>
                  <td className="num">{s.ruleSetCount}</td>
                  <td style={{ color: 'var(--text-dim)' }}>
                    {s.firstDate ? `${s.firstDate} → ${s.lastDate}` : '—'}
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{s.remark || '—'}</td>
                  <td className="actions">
                    <div className="row-edit" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" disabled={s.active}
                              title={s.active ? '已经是当前赛季' : '切换为当前赛季'}
                              onClick={() => void run(() => api.season.setActive(s.id), `已切换到「${s.name}」`)}>
                        设为当前
                      </button>
                      <button className="btn sm" onClick={() => {
                        if (editing === s.id) { setEditing(null); return; }
                        setEditing(s.id);
                        setEditDraft({
                          name: s.name, startedAt: s.startedAt, endedAt: s.endedAt, remark: s.remark,
                        });
                      }}>
                        {editing === s.id ? '收起' : '编辑'}
                      </button>
                      <button className="btn sm danger" disabled={s.active || list.length <= 1}
                              title={s.active ? '不能删除当前赛季' : list.length <= 1 ? '至少要保留一个赛季' : '删除赛季（对局与规则集保留，仅解除归属）'}
                              onClick={() => void run(() => api.season.remove(s.id), `已删除「${s.name}」（对局与规则集已保留，解除归属）`)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {editing !== null && list.some((x) => x.id === editing) && (
                  <tr key={`edit-${editing}`} className="edit-row">
                    <td colSpan={8}>
                      <div className="row-edit">
                        <label className="field"><span>名称</span>
                          <input className="input" style={{ width: 160 }} value={editDraft.name}
                                 onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
                        </label>
                        <label className="field"><span>开始</span>
                          <input className="input" style={{ width: 130 }} placeholder="2025-01-01"
                                 value={editDraft.startedAt}
                                 onChange={(e) => setEditDraft({ ...editDraft, startedAt: e.target.value })} />
                        </label>
                        <label className="field"><span>结束</span>
                          <input className="input" style={{ width: 130 }} placeholder="2025-03-31"
                                 value={editDraft.endedAt}
                                 onChange={(e) => setEditDraft({ ...editDraft, endedAt: e.target.value })} />
                        </label>
                        <label className="field"><span>备注</span>
                          <input className="input" style={{ width: 220 }} value={editDraft.remark}
                                 onChange={(e) => setEditDraft({ ...editDraft, remark: e.target.value })} />
                        </label>
                        <button className="btn primary sm" disabled={!editDraft.name.trim()} onClick={() => void run(
                          () => api.season.update(editing, editDraft),
                          `已保存「${editDraft.name.trim()}」`,
                        ).then(() => setEditing(null))}>
                          保存
                        </button>
                      </div>
                    </td>
                  </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="toolbar" style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <input className="input" style={{ width: 160 }} placeholder="新赛季名称，如 S3"
                 value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <label className="field"><span>开始</span>
            <input className="input" style={{ width: 130 }} placeholder="2025-01-01"
                   value={draft.startedAt} onChange={(e) => setDraft({ ...draft, startedAt: e.target.value })} />
          </label>
          <label className="field"><span>结束</span>
            <input className="input" style={{ width: 130 }} placeholder="2025-03-31"
                   value={draft.endedAt} onChange={(e) => setDraft({ ...draft, endedAt: e.target.value })} />
          </label>
          <input className="input" style={{ width: 200 }} placeholder="备注（可空）"
                 value={draft.remark} onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
          <button className="btn primary" disabled={!draft.name.trim()} onClick={() => void run(
            () => api.season.create(draft),
            `已新建赛季「${draft.name.trim()}」`,
          ).then(() => setDraft(EMPTY))}>
            新建赛季
          </button>
        </div>
      </div>

      <div className="card">
        <h3>历史对局归档</h3>
        <div className="toolbar">
          <button className="btn" onClick={() => void scanOrphans()}>扫描未归档对局</button>
          <button className="btn primary" disabled={!orphans.length || !active}
                  onClick={() => void run(
                    () => api.season.assignMatches(active!.id, orphans.map((m) => m.id)),
                    `已把 ${orphans.length} 场对局归档到「${active!.name}」`,
                  ).then(() => setOrphans([]))}>
            全部归档到当前赛季
          </button>
          <span className="hint" style={{ margin: 0 }}>
            {orphans.length ? `${orphans.length} 场对局没有赛季归属` : '新建的对局会自动登记到当前赛季，这里只处理历史数据'}
          </span>
        </div>
        {orphans.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: '32vh' }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>日期</th>
                  <th style={{ width: 150 }}>我方</th>
                  <th style={{ width: 160 }}>对手</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {orphans.map((m) => (
                  <tr key={m.id}>
                    <td>{m.date}</td>
                    <td style={{ color: 'var(--text-dim)' }}>{m.ourSide || '—'}</td>
                    <td>{m.oppSide || '—'}</td>
                    <td style={{ color: 'var(--text-dim)' }}>{m.remark || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint">
          新建对局会自动登记到「当前赛季」，所以正常情况下这里扫不出东西；真正的用途是把旧表导进来的历史对局补上赛季归属。
          归档只改对局归属，不动已算出的分数 —— 同一场对局的分数永远属于创建它的那个赛季，避免历史成绩被后来的口径改写。
          删除赛季时该赛季的对局不会被删，只会变回「无赛季归属」，可以在这里重新归档。
        </div>
      </div>
    </>
  );
}
