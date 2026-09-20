import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CombatStat, Match, ParticipationRow, Player, SquadCatalog,
} from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import ClassChip from '../components/ClassChip';
import LineupBoard from '../components/LineupBoard';
import CellPicker from '../components/CellPicker';
import AddPlayerPicker from '../components/AddPlayerPicker';
import StatImportPanel from '../components/StatImportPanel';
import ScoringPanel from '../components/ScoringPanel';
import SignupPage from './SignupPage';
import {
  BENCH_SQUADS, TOTAL_TOWERS_PER_SIDE, deriveEffective,
} from '@shared/domain';

interface Props extends PageProps {
  matchId: number;
  onBack: () => void;
  onChanged: () => void;
}

type TabKey = 'lineup' | 'stats' | 'import' | 'signup' | 'score';

/** 小队下拉选项来自建制（组件内用 catalog 计算） */

/** 战报网格里展示的列（顺序对齐原表 / 录入习惯） */
const GRID_FIELDS: { key: keyof CombatStat; label: string }[] = [
  { key: 'kills', label: '击败' },
  { key: 'fountainKills', label: '清泉' },
  { key: 'assists', label: '助攻' },
  { key: 'dmgPlayer', label: '对玩家伤害' },
  { key: 'dmgPlayerArmor', label: '人伤卸甲' },
  { key: 'dmgBuilding', label: '对建筑伤害' },
  { key: 'dmgBuildingArmor', label: '破塔卸甲' },
  { key: 'healing', label: '治疗值' },
  { key: 'damageTaken', label: '承受伤害' },
  { key: 'deaths', label: '重伤' },
  { key: 'revives', label: '复活' },
  { key: 'boneBurn', label: '焚骨' },
  { key: 'resource', label: '资源' },
];

export default function MatchDetail({ matchId, classes, classMap, onBack, onChanged }: Props) {
  const [match, setMatch] = useState<Match | null>(null);
  const [rows, setRows] = useState<ParticipationRow[]>([]);
  const [roster, setRoster] = useState<Player[]>([]);
  const [tab, setTab] = useState<TabKey>('lineup');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, CombatStat>>({});
  const [dirty, setDirty] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  /** 看板上被点开的小队槽位（空字符串表示未打开） */
  const [cellPick, setCellPick] = useState<string | null>(null);
  /** 战斗组 / 小队建制（数据驱动，可新增） */
  const [catalog, setCatalog] = useState<SquadCatalog | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, ps, pl, cat] = await Promise.all([
        api.match.get(matchId),
        api.match.participations(matchId),
        api.player.list(),
        api.meta.squads(),
      ]);
      setMatch(m);
      setRows(ps);
      setRoster(pl);
      setCatalog(cat);
      setDrafts({});
      setDirty(new Set());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [matchId]);

  useEffect(() => { void load(); }, [load]);

  const our = useMemo(() => rows.filter((r) => r.side === 'our'), [rows]);
  const playing = useMemo(() => our.filter((r) => r.state === 'PLAY'), [our]);
  const stats = useMemo(() => {
    const filled = playing.filter((r) => r.statFilled).length;
    const assigned = playing.filter((r) => r.squad && r.squad !== '替补' && r.squad !== '请假').length;
    const squadCounts = new Map<string, number>();
    for (const r of playing) {
      if (r.squad) squadCounts.set(r.squad, (squadCounts.get(r.squad) ?? 0) + 1);
    }
    const missingClass = playing.filter((r) => !r.classUsed).length;
    return { filled, assigned, squadCounts, missingClass };
  }, [playing]);

  async function patchMatch(patch: Partial<Match>) {
    if (!match) return;
    try {
      const next = await api.match.update(match.id, {
        date: patch.date, ourSide: patch.ourSide, oppSide: patch.oppSide,
        result: patch.result, ourTowersLeft: patch.ourTowersLeft,
        oppTowersLeft: patch.oppTowersLeft, state: patch.state, remark: patch.remark,
      });
      setMatch(next);
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function setSquad(row: ParticipationRow, squad: string) {
    try {
      await api.match.upsertParticipation({
        matchId,
        playerId: row.playerId,
        classUsed: row.classUsed,
        squad,
        state: squad === '请假' ? 'LEAVE' : squad === '替补' ? 'BENCH' : 'PLAY',
      });
      setError(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function setClass(row: ParticipationRow, classUsed: string) {
    try {
      await api.match.upsertParticipation({
        matchId, playerId: row.playerId, classUsed, squad: row.squad, state: row.state,
      });
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function addPlayer(playerId: number) {
    try {
      await api.match.upsertParticipation({ matchId, playerId, state: 'PLAY' });
      setError(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function removeRow(row: ParticipationRow) {
    if (!window.confirm(`从本场移除「${row.name}」？`)) return;
    try {
      await api.match.removeParticipation(row.id);
      setError(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  /** 把某人放进指定小队（看板点格子后的落点） */
  async function addPlayerToSquad(playerId: number, squad: string) {
    try {
      await api.match.upsertParticipation({ matchId, playerId, squad, state: 'PLAY' });
      setError(null);
      await load();
      onChanged();
      setNotice(`已把队员放入「${squad}」`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function editStat(row: ParticipationRow, key: keyof CombatStat, value: string) {
    const base = drafts[row.id] ?? row.stat;
    const num = value === '' ? 0 : Math.max(0, Math.round(Number(value) || 0));
    setDrafts({ ...drafts, [row.id]: { ...base, [key]: num } });
    setDirty(new Set(dirty).add(row.id));
  }

  async function saveAll() {
    if (dirty.size === 0) { setNotice('没有需要保存的改动'); return; }
    setSaving(true);
    try {
      for (const id of dirty) {
        await api.match.saveStat(id, drafts[id]);
      }
      setNotice(`已保存 ${dirty.size} 人的战报`);
      setError(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!match) {
    return (
      <div className="card">
        {error ? <div className="msg error">{error}</div> : <div className="hint">加载中…</div>}
        <button className="btn" onClick={onBack}>返回列表</button>
      </div>
    );
  }

  const missingSlots = our.filter((r) => r.state === 'PLAY' && !r.squad).length;
  /** 建制容量与下拉选项全部来自数据库，不硬编码 */
  const squadOptions = [...(catalog?.squads ?? []).map((s) => s.name), ...BENCH_SQUADS];
  const capacityHint = catalog?.capacity ?? 0;

  return (
    <>
      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg ok">{notice}</div>}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={onBack}>← 对局列表</button>
          <h3 style={{ margin: 0 }}>
            {match.date} 第 {match.indexInDay} 场 · {match.ourSide} vs {match.oppSide}
          </h3>
          <div className="spacer grow" />
          <span className="meta">
            上场 {playing.length} · 已排小队 {stats.assigned} · 已录战报 {stats.filled}
          </span>
        </div>

        <div className="toolbar" style={{ marginBottom: 0 }}>
          <label className="field"><span>胜负</span>
            <select className="select" value={match.result}
                    onChange={(e) => void patchMatch({ result: e.target.value as Match['result'] })}>
              <option value="WIN">胜</option><option value="LOSE">负</option><option value="DRAW">平</option>
            </select>
          </label>
          <label className="field"><span>我方剩余塔</span>
            <input className="input" style={{ width: 64 }} type="number" min={0} max={TOTAL_TOWERS_PER_SIDE}
                   defaultValue={match.ourTowersLeft}
                   onBlur={(e) => void patchMatch({ ourTowersLeft: Number(e.target.value) })} />
          </label>
          <label className="field"><span>敌方剩余塔</span>
            <input className="input" style={{ width: 64 }} type="number" min={0} max={TOTAL_TOWERS_PER_SIDE}
                   defaultValue={match.oppTowersLeft}
                   onBlur={(e) => void patchMatch({ oppTowersLeft: Number(e.target.value) })} />
          </label>
          <label className="field"><span>我方联盟</span>
            <input className="input" style={{ width: 110 }} defaultValue={match.ourSide}
                   onBlur={(e) => void patchMatch({ ourSide: e.target.value })} />
          </label>
          <label className="field"><span>对手</span>
            <input className="input" style={{ width: 130 }} defaultValue={match.oppSide}
                   onBlur={(e) => void patchMatch({ oppSide: e.target.value })} />
          </label>
          <label className="field"><span>状态</span>
            <select className="select" value={match.state} onChange={(e) => void patchMatch({ state: e.target.value })}>
              <option value="draft">草稿</option>
              <option value="playing">进行中</option>
              <option value="settled">已结算</option>
            </select>
          </label>
        </div>
      </div>

      <div className="tabs">
        {([['lineup', `阵容编排（${stats.assigned}/60）`], ['stats', `战报录入（${stats.filled}/${playing.length}）`], ['signup', '报名 / 请假'], ['score', '本场评分'], ['import', '批量导入战报']] as const)
          .map(([k, label]) => (
            <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
      </div>

      {tab === 'lineup' && (
        <>
          <div className="card" style={{ padding: '12px 14px' }}>
            <LineupBoard
              classes={classes}
              classMap={classMap}
              rows={our}
              catalog={catalog}
              onPickSlot={(squad) => setCellPick(squad)}
              onAssign={async (playerIds, squad) => {
                try {
                  const res = await api.match.assignBulk({ matchId, playerIds, squad, allowOverfill: true });
                  setError(null);
                  setNotice(`已把 ${res.moved} 名队员移到「${squad}」`);
                  await load();
                  onChanged();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : String(err));
                }
              }}
              onUnassign={async (playerId) => {
                try {
                  await api.match.unassign(matchId, playerId);
                  setError(null);
                  await load();
                  onChanged();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : String(err));
                }
              }}
              onRemoveRow={(id) => {
                const row = our.find((r) => r.id === id);
                if (row) void removeRow(row);
              }}
            />
            <div className="hint" style={{ marginTop: 8 }}>
              拖动姓名可换小队、拖到下方「未分配」区可移出小队；点击职业色块也能选人入队，点击姓名移出本场。
              版式对齐原表「排表」页：每小队 6 人 × 5 行（职业 / 备注 / 姓名 / 战术 / 角色 ID）。
            </div>
          </div>

          {cellPick && (
            <CellPicker
              squad={cellPick}
              roster={roster}
              rows={our}
              classMap={classMap}
              onClose={() => setCellPick(null)}
              onAssign={async (playerId, targetSquad) => {
                await addPlayerToSquad(playerId, targetSquad);
                setCellPick(null);
              }}
            />
          )}

          <div className="card">
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <button className="btn primary" onClick={() => setShowAdd(!showAdd)}>
                {showAdd ? '收起' : '添加队员'}
              </button>
              <span className="hint" style={{ margin: 0 }}>
                也可用下方表格逐项调整（小队共 {capacityHint} 个上场槽位）
                {missingSlots > 0 ? ` · 还空 ${missingSlots} 个` : ' · 已排满'}
              </span>
            </div>
            {showAdd && (
              <AddPlayerPicker
                roster={roster}
                existing={new Set(our.map((r) => r.playerId))}
                classMap={classMap}
                onPick={(id) => { void addPlayer(id); }}
              />
            )}
          </div>

          <div className="card">
            <h3>我方参战明细（{our.length}）</h3>
            <div className="table-wrap" style={{ maxHeight: '50vh' }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>队员</th>
                    <th style={{ width: 110 }}>本场职业</th>
                    <th style={{ width: 130 }}>小队</th>
                    <th style={{ width: 90 }}>战术</th>
                    <th style={{ width: 90 }}>状态</th>
                    <th style={{ width: 70 }}>麦</th>
                    <th>备注角色</th>
                    <th style={{ width: 80 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {our.length === 0 && (
                    <tr><td className="empty" colSpan={8}>本场还没有队员，用「添加队员」加入，或新建对局时自动继承上一场阵容。</td></tr>
                  )}
                  {our.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}<span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{r.gameId !== r.name ? r.gameId : ''}</span></td>
                      <td>
                        <select className="select" value={r.classUsed}
                                onChange={(e) => void setClass(r, e.target.value)}>
                          <option value="">未定</option>
                          {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="select" value={r.squad}
                                onChange={(e) => void setSquad(r, e.target.value)}>
                          <option value="">未分配</option>
                          {squadOptions.map((s) => (
                            <option key={s} value={s}>
                              {s}{stats.squadCounts.get(s) ? `（${stats.squadCounts.get(s)}）` : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ color: 'var(--text-dim)' }}>{r.tactic || '—'}</td>
                      <td>
                        <span className={`badge-state ${r.state === 'PLAY' ? 'active' : r.state === 'LEAVE' ? 'left' : 'inactive'}`}>
                          {r.state === 'PLAY' ? '上场' : r.state === 'BENCH' ? '替补' : '请假'}
                        </span>
                      </td>
                      <td><span className="badge-mic">{r.mic || '—'}</span></td>
                      <td>{r.noteRole ? <span className="badge-note">{r.noteRole}</span> : <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                      <td className="actions">
                        <button className="btn sm danger" onClick={() => void removeRow(r)}>移除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'stats' && (
        <div className="card">
          <div className="toolbar">
            <button className="btn primary" onClick={() => void saveAll()} disabled={saving || dirty.size === 0}>
              保存全部改动{dirty.size ? `（${dirty.size}）` : ''}
            </button>
            <span className="hint" style={{ margin: 0 }}>
              有效人伤 = 对玩家伤害 + 人伤卸甲；有效塔伤 = 对建筑伤害 + 破塔卸甲；
              「清泉」单列（潮光计入个人分），「复活」仅素问/妙音计入。
            </span>
          </div>
          <div className="table-wrap" style={{ maxHeight: '56vh' }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>队员</th>
                  <th style={{ width: 88 }}>职业</th>
                  {GRID_FIELDS.map((f) => <th key={f.key} className="num" style={{ minWidth: 76 }}>{f.label}</th>)}
                  <th className="num" style={{ minWidth: 90 }}>有效人伤</th>
                  <th className="num" style={{ minWidth: 90 }}>有效塔伤</th>
                </tr>
              </thead>
              <tbody>
                {playing.length === 0 && (
                  <tr><td className="empty" colSpan={GRID_FIELDS.length + 4}>先在上一个页签里把人排进小队。</td></tr>
                )}
                {playing.map((r) => {
                  const st = drafts[r.id] ?? r.stat;
                  const isDirty = dirty.has(r.id);
                  const eff = deriveEffective(st);
                  return (
                    <tr key={r.id} style={isDirty ? { background: 'var(--accent-soft)' } : undefined}>
                      <td>
                        {r.name}
                        {isDirty && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>•</span>}
                      </td>
                      <td><ClassChip name={r.classUsed || r.mainClass} classMap={classMap} showIcon={false} /></td>
                      {GRID_FIELDS.map((f) => (
                        <td key={f.key} className="num">
                          <input
                            className="input cell-num"
                            type="text"
                            inputMode="numeric"
                            value={st[f.key] === 0 ? '' : String(st[f.key])}
                            placeholder="0"
                            onChange={(e) => editStat(r, f.key, e.target.value)}
                          />
                        </td>
                      ))}
                      <td className="num" style={{ color: 'var(--text-dim)' }}>{eff.effDmg.toLocaleString()}</td>
                      <td className="num" style={{ color: 'var(--text-dim)' }}>{eff.effTower.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hint">
            数字留空按 0 处理。提示：原表里「击败/清泉」是复合列，这里已拆成两列 —— 治疗职业的「击败」若不为 0，多半是把清泉填错了位置。
          </div>
        </div>
      )}

      {tab === 'signup' && (
        <SignupPage
          classes={classes}
          classMap={classMap}
          matchId={matchId}
          matchLabel={match ? `${match.date} 第 ${match.indexInDay} 场` : ''}
          onBack={() => setTab('lineup')}
          onChanged={() => { void load(); onChanged(); }}
        />
      )}

      {tab === 'score' && <ScoringPanel matchId={matchId} playerCount={playing.length} />}

      {tab === 'import' && (
        <StatImportPanel
          matchId={matchId}
          classes={classes}
          classMap={classMap}
          matchLabel={match ? `${match.date} 第 ${match.indexInDay} 场` : ''}
          onDone={() => { void load(); onChanged(); }}
        />
      )}
    </>
  );
}
