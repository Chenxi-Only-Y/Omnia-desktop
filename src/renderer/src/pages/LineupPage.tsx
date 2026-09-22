import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { MatchSummary, ParticipationRow, SignupRow, SquadCatalog } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import { BENCH_SQUADS } from '@shared/domain';
import LineupBoard from '../components/LineupBoard';
import CellPicker from '../components/CellPicker';
import AddPlayerPicker from '../components/AddPlayerPicker';

interface Props extends PageProps {
  /** 从别处跳过来时预选的对局（如对局列表点「排表」） */
  initialMatchId?: number | null;
}

/**
 * 排表页（独立成页）
 *
 * 排表看板原本只长在「对局与战报 → 某场 → 阵容编排」页签里，要改一场阵容得先点进对局。
 * 排表是每场比赛前最频繁的动作，所以单独提一页：顶部选场次，下面直接拖。
 * 看板本身与对局详情里用的是同一个组件，版式与落库行为完全一致，不存在两套逻辑。
 *
 * 这一页只做「排上场名单」这一件事；战报录入、报名、评分仍在对局详情里。
 */
export default function LineupPage({ classes, classMap, initialMatchId = null }: Props) {
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [matchId, setMatchId] = useState<number | null>(initialMatchId);
  const [rows, setRows] = useState<ParticipationRow[]>([]);
  /** 本场已报名的人（主档有 + 本场报名有）；排表候选只看这个 */
  const [signupRows, setSignupRows] = useState<SignupRow[]>([]);
  const [catalog, setCatalog] = useState<SquadCatalog | null>(null);
  const [cellPick, setCellPick] = useState<{ squad: string; slotIndex: number } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  const [loading, setLoading] = useState(true);

  const loadMatches = useCallback(async () => {
    try {
      const list = await api.match.list();
      setMatches(list);
      setMatchId((cur) => cur ?? (list.length ? list[0].id : null));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const [parts, board, cat] = await Promise.all([
        api.match.participations(id),
        api.signup.board(id),
        api.meta.squads(),
      ]);
      setRows(parts);
      // 只留「本场填过报名表」的人：主档有但没填表的不进候选
      setSignupRows(board.rows.filter((r) => r.signup !== null));
      setCatalog(cat);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await loadMatches();
      setLoading(false);
    })();
  }, [loadMatches]);

  useEffect(() => {
    if (matchId === null) { setRows([]); return; }
    void loadDetail(matchId);
  }, [matchId, loadDetail]);

  /** 我方参战（含替补/请假槽位），看板需要全量才知道谁是替补 */
  const our = useMemo(() => rows.filter((r) => r.side === 'our'), [rows]);

  const capacity = catalog?.capacity ?? 0;
  const assigned = useMemo(
    () => our.filter((r) => r.squad && !(BENCH_SQUADS as readonly string[]).includes(r.squad)).length,
    [our],
  );
  const missingSlots = Math.max(0, capacity - assigned);

  async function run(fn: () => Promise<unknown>, okMsg?: string) {
    try {
      await fn();
      setError(null);
      if (okMsg) setNotice(okMsg);
      if (matchId !== null) await loadDetail(matchId);
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function assign(playerIds: number[], squad: string, slotIndex?: number) {
    if (matchId === null) return;
    await run(async () => {
      const res = await api.match.assignBulk({ matchId, playerIds, squad, allowOverfill: true, slotIndex });
      setNotice(slotIndex === undefined
        ? `已把 ${res.moved} 名队员移到「${squad}」`
        : `已把 ${res.moved} 名队员放到「${squad}」第 ${slotIndex + 1} 格`);
    });
  }

  async function unassign(playerId: number) {
    if (matchId === null) return;
    await run(() => api.match.unassign(matchId, playerId));
  }

  async function addPlayer(playerId: number, subClass = '') {
    if (matchId === null) return;
    const r = signupRows.find((x) => x.playerId === playerId);
    if (!r) return;
    // 二职选择：传了副职就用副职，否则用主职业
    const cls = subClass || r.mainClass;
    await run(async () => {
      await api.match.upsertParticipation({
        matchId, playerId, classUsed: cls, state: 'PLAY',
      });
      setNotice(`已把 ${r.gameId} 加入本场（${cls || '未定职业'}，未分配小队）`);
    });
  }

  async function removeRow(row: ParticipationRow) {
    if (matchId === null) return;
    await run(() => api.match.removeParticipation(row.id), `已把 ${row.name} 移出本场`);
  }

  /** 就地改本场职业（主职 / 二职）：只改 classUsed，不动小队与状态 */
  async function changeClass(playerId: number, cls: string) {
    if (matchId === null) return;
    await run(async () => {
      await api.match.upsertParticipation({ matchId, playerId, classUsed: cls });
      setNotice(`本场职业已改为「${cls}」`);
    });
  }

  /** 把整个排表功能区截成 PNG（主进程 capturePage + 保存对话框） */
  async function captureBoard() {
    try {
      const res = await api.meta.captureBoard();
      setError(null);
      setNotice(res.path ? `已保存截图：${res.path}` : '已取消截图');
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (loading) return <div className="card"><div className="empty">正在读取对局…</div></div>;

  if (!matches.length) {
    return (
      <div className="card">
        <div className="placeholder">
          <div className="big">⚔</div>
          <div>还没有对局，排表需要先有一场比赛</div>
          <div className="hint">去「对局与战报」新建一场，再回来排阵容。</div>
        </div>
      </div>
    );
  }

  return (
    // page-fill：让排表看板那张卡撑满内容区高度（否则会缩在上半部分）
    <div className="page-fill">
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <label className="field">
            <span>选择场次</span>
            <select className="select" style={{ minWidth: 320 }}
                    value={matchId ?? ''}
                    onChange={(e) => { setNotice(null); setMatchId(Number(e.target.value)); }}>
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.date} 第 {m.indexInDay} 场 · {m.ourSide} vs {m.oppSide}
                </option>
              ))}
            </select>
          </label>
          <div className="board__stat" style={{ marginLeft: 6 }}>
            已排 <b>{assigned}</b> / {capacity} 槽
            {missingSlots > 0 ? ` · 还空 ${missingSlots}` : ' · 已排满'}
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? '收起' : '添加队员'}
          </button>
          <button className="btn" title="把整个排表功能区截成 PNG 图片" onClick={() => void captureBoard()}>
            截取图片
          </button>
          <button className="btn" onClick={() => void loadMatches()}>刷新场次</button>
        </div>
        {showAdd && (
          <AddPlayerPicker
            candidates={signupRows}
            existing={new Set(our.map((r) => r.playerId))}
            classMap={classMap}
            onPick={(id, subClass) => { void addPlayer(id, subClass); }}
          />
        )}
      </div>

      <div className="card card--fill" style={{ padding: '12px 14px' }}>
        <LineupBoard
          classes={classes}
          classMap={classMap}
          rows={our}
          catalog={catalog}
          onPickSlot={(squad, slotIndex) => setCellPick({ squad, slotIndex })}
          onAssign={(playerIds, squad) => void assign(playerIds, squad)}
          onUnassign={(playerId) => void unassign(playerId)}
          onRemoveRow={(id) => {
            const row = our.find((r) => r.id === id);
            if (row) void removeRow(row);
          }}
          onSkillNote={(playerId, note) => {
            if (matchId === null) return;
            void run(() => api.match.setSkillNote(matchId, playerId, note));
          }}
          onAddSquad={(groupId) => void run(async () => {
            const s = await api.meta.appendSquad(groupId);
            setNotice(`已加一队「${s.name}」`);
          })}
          onRemoveSquad={(squadId, name) => void run(
            () => api.meta.removeSquad(squadId), `已删掉「${name}」`,
          )}
          onChangeTactic={(squadId, tactic) => void run(
            () => api.meta.setSquadTactic(squadId, tactic), `战术已改为「${tactic || '未定'}」`,
          )}
          onChangeClass={(playerId, cls) => void changeClass(playerId, cls)}
        />
      </div>

      {cellPick && (
        <CellPicker
          squad={cellPick.squad}
          candidates={signupRows}
          rows={our}
          classMap={classMap}
          onClose={() => setCellPick(null)}
          onAssign={async (playerId, targetSquad, subClass) => {
            // 点的是第几格就放第几格 —— 不再总是挤到最左边
            await assign([playerId], targetSquad, cellPick.slotIndex);
            // 选了二职就同时把本场职业换成它
            if (subClass && matchId !== null) {
              await run(() => api.match.upsertParticipation({
                matchId, playerId, classUsed: subClass,
              }));
            }
            setCellPick(null);
          }}
        />
      )}
    </div>
  );
}
