import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { MatchSummary, ParticipationRow, SignupRow, SquadCatalog } from '@shared/types';
import { api, errText } from '../api';
import type { PageProps } from '../App';
import { BENCH_SQUADS } from '@shared/domain';
import LineupBoard from '../components/LineupBoard';
import CellPicker from '../components/CellPicker';
import AddPlayerPicker from '../components/AddPlayerPicker';
import Select from '../components/Select';

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
  /** 「沿用其它场次…」：选一场把它的排表套到本场 */
  const [showInherit, setShowInherit] = useState(false);
  const [inheritFrom, setInheritFrom] = useState<number | ''>('');
  const [overwrite, setOverwrite] = useState(true);
  /** 场次多了要能找：搜索词 + 只看已排表的 */
  const [inheritQuery, setInheritQuery] = useState('');
  const [onlyAssigned, setOnlyAssigned] = useState(true);
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
      setError(errText(err));
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const [parts, board, cat] = await Promise.all([
        api.match.participations(id),
        api.signup.board(id),
        api.meta.squads(id),
      ]);
      setRows(parts);
      // 只留「本场填过报名表」的人：主档有但没填表的不进候选
      setSignupRows(board.rows.filter((r) => r.signup !== null));
      setCatalog(cat);
      setError(null);
    } catch (err) {
      setError(errText(err));
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

  /** 「沿用其它场次」的候选：排除本场 → 可选只看已排表的 → 关键词过滤（日期 / 对手） */
  const inheritCandidates = useMemo(() => {
    const q = inheritQuery.trim().toLowerCase();
    return matches
      .filter((m) => m.id !== matchId)
      .filter((m) => (onlyAssigned ? m.ourAssigned > 0 : true))
      .filter((m) => !q
        || `${m.date} 第${m.indexInDay}场 ${m.ourSide} ${m.oppSide}`.toLowerCase().includes(q));
  }, [matches, matchId, inheritQuery, onlyAssigned]);

  /** 沿用另一场的排表（只搬排表：小队 / 落位 / 职业 / 队内角色） */
  const applyInherit = useCallback(async (from: number) => {
    if (matchId === null || !from) return;
    try {
      const res = await api.match.copyLineup(from, matchId, overwrite);
      setShowInherit(false);
      setError(null);
      setNotice(`已沿用排表：${res.copied} 人落位`
        + (res.skipped ? `，${res.skipped} 人本场已有（未覆盖）` : '')
        + (res.squadsAdded ? `，补了 ${res.squadsAdded} 个小队` : '')
        + '（本场评分已标记为待重算）');
      await loadDetail(matchId);
    } catch (err) {
      setError(errText(err));
    }
  }, [matchId, overwrite, loadDetail]);

  /** 我方参战（含替补/请假槽位），看板需要全量才知道谁是替补 */
  const our = useMemo(() => rows.filter((r) => r.side === 'our'), [rows]);

  const capacity = catalog?.capacity ?? 0;
  const assigned = useMemo(
    () => our.filter((r) => r.squad && !(BENCH_SQUADS as readonly string[]).includes(r.squad)).length,
    [our],
  );
  const missingSlots = Math.max(0, capacity - assigned);

  /** 已排进小队的人（用户口径：选过之后要从候选里**同步消失**） */
  const placedIds = useMemo(
    () => new Set(
      our.filter((r) => r.squad && !(BENCH_SQUADS as readonly string[]).includes(r.squad))
        .map((r) => String(r.playerId)),   // 用字符串：报名行与参与行的 id 类型可能不一致，
                                           // 数字/字符串混用时 Set.has 永远不命中 → 一个都过滤不掉
    ),
    [our],
  );
  /** 候选 = 本场报名里**还没排进小队**的。原来直接把全部报名丢给选择器，
      于是被排过的人还留在列表里（只显示所在队伍），没排过的却因为别的原因消失，
      表现不一致 —— 现在统一：排进小队即从候选移除。 */
  const candidates = useMemo(
    () => signupRows.filter((r) => !placedIds.has(String(r.playerId))),
    [signupRows, placedIds],
  );

  /**
   * 自愈：在队但没有格号（slotNo = -1）的人，补一个固定格号并落库。
   * 不补的话，看板对 -1 的人是「从最左的空位补位」——
   * 删掉左边的人时，他就会往前跳一格，看起来就是「右边的往左移」。
   * 实测复现：欠囚(slotNo=-1) 在心一丶(第0格) 被删后从 x=507 跳到 x=333。
   */
  useEffect(() => {
    if (matchId === null) return;
    const isBench = (q: string) => (BENCH_SQUADS as readonly string[]).includes(q);
    const need = our.filter((r) => r.squad && !isBench(r.squad) && (r.slotNo ?? -1) < 0);
    if (!need.length) return;
    const used = new Map<string, number[]>();
    for (const r of our) {
      if (!r.squad || isBench(r.squad)) continue;
      const arr = used.get(r.squad) ?? [];
      if ((r.slotNo ?? -1) >= 0) arr.push(r.slotNo);
      used.set(r.squad, arr);
    }
    void (async () => {
      try {
        for (const r of need) {
          const arr = used.get(r.squad) ?? [];
          let slot = 0;
          while (arr.includes(slot)) slot += 1;
          arr.push(slot);
          used.set(r.squad, arr);
          await api.match.assignBulk({
            matchId, playerIds: [r.playerId], squad: r.squad, allowOverfill: true, slotIndex: slot,
          });
        }
        await loadDetail(matchId);
      } catch { /* 补不上就算了，不打断正常使用 */ }
    })();
    // 依赖 our：补完会重新加载，新的 our 里没有 -1，自然终止，不会循环
  }, [our, matchId, loadDetail]);

  async function run(fn: () => Promise<unknown>, okMsg?: string) {
    try {
      await fn();
      setError(null);
      if (okMsg) setNotice(okMsg);
      if (matchId !== null) await loadDetail(matchId);
    } catch (err) {
      setNotice(null);
      setError(errText(err));
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
      // squad / state 不必再手动带上：仓储层已保证「没传的字段一律不动」
      // （原来这里必须多传一个 squad 来绕过 ON CONFLICT 无条件覆盖的坑）。
      await api.match.upsertParticipation({
        matchId, playerId, classUsed: cls,
        squad: our.find((r) => r.playerId === playerId)?.squad ?? '',
        state: our.find((r) => r.playerId === playerId)?.state ?? 'PLAY',
      });
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
      setError(errText(err));
    }
  }

  /* 下面这批看板回调一律用 useCallback 固定引用。
     原因（性能，用户反馈"排表反应慢"）：看板挂在 54+ 张卡片上，而拖动时每次
     dragover 都会 setHoverSquad 触发一次渲染。回调若是内联箭头函数，每次渲染
     身份都变 → 卡片的 memo 全部失效 → 一次 hover 就让整板 60 张卡重渲染。
     引用稳定后，拖动时只有"高亮变化的那两行"会重渲染。 */
  const handlePickSlot = useCallback((squad: string, slotIndex: number) => {
    setCellPick({ squad, slotIndex });
  }, []);
  const handleAssign = useCallback((playerIds: number[], squad: string, slotIndex?: number) => {
    void assign(playerIds, squad, slotIndex);
    // assign 每次渲染都是新函数，故只依赖 matchId（它变了才需要换引用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);
  const handleUnassign = useCallback((playerId: number) => {
    void unassign(playerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);
  const handleRemoveRow = useCallback((id: number) => {
    const row = our.find((r) => r.id === id);
    if (row) void removeRow(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [our]);
  const handleSkillNote = useCallback((playerId: number, note: string) => {
    if (matchId === null) return;
    void run(() => api.match.setSkillNote(matchId, playerId, note));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);
  /* 建制回调：全部带上 matchId —— 建制已按场次独立，
     改一场不会影响其它场（用户口径）。 */
  const handleAddSquad = useCallback((groupName: string) => {
    if (matchId === null) return;
    void run(async () => {
      const s = await api.meta.appendSquad(matchId, groupName);
      setNotice(`已在本场「${groupName}」加一队：${s.name}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);
  const handleRemoveSquad = useCallback((squadName: string) => {
    if (matchId === null) return;
    void run(() => api.meta.removeSquad(matchId, squadName), `已在本场删掉「${squadName}」`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);
  const handleChangeTactic = useCallback((squadName: string, tactic: string) => {
    if (matchId === null) return;
    void run(() => api.meta.setSquadTactic(matchId, squadName, tactic),
      `本场「${squadName}」战术已改为「${tactic || '未定'}」`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);
  const handleChangeClass = useCallback((playerId: number, cls: string) => {
    void changeClass(playerId, cls);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, our]);

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
    // theme-light：排表功能区保持原样（用户口径），全局切深色后这里显式回到浅色
    <div className="page-fill theme-light">
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <label className="field">
            <span>选择场次</span>
            <Select className="select" style={{ minWidth: 320 }}
                    value={matchId ?? ''}
                    onChange={(e) => { setNotice(null); setMatchId(Number(e.target.value)); }}>
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.date} 第 {m.indexInDay} 场 · {m.ourSide} vs {m.oppSide}
                </option>
              ))}
            </Select>
          </label>
          <button className="btn" disabled={matchId === null}
                  title={matches.length < 2
                    ? '这个帮会还没有别的场次：先在「对局与战报」里建第二场'
                    : '把另一场的排表（小队 / 落位 / 职业）套到本场'}
                  onClick={() => {
                    setError(null);
                    /* 场次不足时**不要**给一个灰按钮（用户反馈"点不动"，看不出原因），
                       直接把原因写在提示条里。 */
                    if (matches.length < 2) {
                      setNotice('这个帮会还没有别的场次可以沿用 —— 先去「对局与战报」建第二场，再回来套用排表');
                      return;
                    }
                    /* 默认选中"最近一场有排表的" —— 等于一键沿用上一场，最常见的用法 */
                    setInheritQuery('');
                    const cands = matches.filter((m) => m.id !== matchId && m.ourAssigned > 0);
                    /* 智能默认：只有当"确实存在有排表的场次"时才默认过滤，
                       否则列表会空掉（用户看到"没有符合条件的场次"会以为坏了）。 */
                    setOnlyAssigned(cands.length > 0);
                    setInheritFrom(cands.length ? cands[0].id : '');
                    setShowInherit(true);
                  }}>
            沿用其它场次…
          </button>
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
            candidates={candidates}
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
          onPickSlot={handlePickSlot}
          onAssign={handleAssign}
          onUnassign={handleUnassign}
          onRemoveRow={handleRemoveRow}
          onSkillNote={handleSkillNote}
          onAddSquad={handleAddSquad}
          onRemoveSquad={handleRemoveSquad}
          onChangeTactic={handleChangeTactic}
          onChangeClass={handleChangeClass}
        />
      </div>

      {cellPick && matchId !== null && (
        <CellPicker
          squad={cellPick.squad}
          candidates={candidates}
          rows={our}
          classMap={classMap}
          matchId={matchId}
          classes={classes}
          onAdded={(msg) => setNotice(msg)}
          onClose={() => setCellPick(null)}
          onAssign={async (playerId, targetSquad, subClass) => {
            // 点的是第几格就放第几格 —— 不再总是挤到最左边
            await assign([playerId], targetSquad, cellPick.slotIndex);
            // 选了二职：落位之后再写职业。
            // 这里仍显式带上 squad，但**不再依赖它**来防丢 —— 仓储层已改成
            // 「没传的字段不动」（原来不带 squad 会被写成空串，人立刻被踢出小队，
            //  对局详情那两处就是这么坏的）。
            if (subClass && matchId !== null) {
              await run(() => api.match.upsertParticipation({
                matchId, playerId, classUsed: subClass, squad: targetSquad, state: 'PLAY',
              }));
            }
            setCellPick(null);
          }}
        />
      )}

      {showInherit && matchId !== null && (
        <div className="modal" onClick={() => setShowInherit(false)}>
          <div className="modal__box" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head"><h3>沿用其它场次的排表</h3></div>
            <div className="hint" style={{ marginBottom: 8 }}>
              只搬排表（小队 / 落位 / 职业 / 队内角色）：战报数值、评分、对方数据都不会带过来。
            </div>
            {/* 场次会越来越多：搜索 + 只看已排表的 + 只渲染最近 50 场 */}
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <input className="input" style={{ minWidth: 220 }} placeholder="搜索日期或对手…"
                     value={inheritQuery} onChange={(e) => setInheritQuery(e.target.value)} />
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={onlyAssigned}
                       onChange={(e) => setOnlyAssigned(e.target.checked)} />
                <span>只显示已排表的场次</span>
              </label>
              <div className="spacer grow" />
              <span className="hint" style={{ margin: 0 }}>共 {inheritCandidates.length} 场可选</span>
            </div>
            <div style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {inheritCandidates.length === 0 && (
                <div className="hint">没有符合条件的场次（换个关键词，或取消上面的勾选）</div>
              )}
              {inheritCandidates.slice(0, 50).map((m) => (
                <label key={m.id} className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <input type="radio" name="inherit-from" checked={inheritFrom === m.id}
                         onChange={() => setInheritFrom(m.id)} />
                  <span>{m.date} 第 {m.indexInDay} 场 · {m.ourSide} vs {m.oppSide}</span>
                  <div className="spacer grow" />
                  <span className="hint" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                    {m.ourAssigned ? `已排 ${m.ourAssigned} 人 · ${m.squadsUsed} 个小队` : '空排表'}
                  </span>
                </label>
              ))}
              {inheritCandidates.length > 50 && (
                <div className="hint">只显示最近 50 场 —— 用上面的搜索或勾选缩小范围</div>
              )}
            </div>
            <label className="field" style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              <span>覆盖本场已有排表（不勾选 = 只补齐本场还没有的人）</span>
            </label>
            <div className="toolbar" style={{ marginTop: 6, marginBottom: 0 }}>
              {inheritFrom === '' && (
                <span className="hint" style={{ margin: 0 }}>↑ 先在上面选一场，「套用排表」才会亮</span>
              )}
              <div className="spacer grow" />
              <button className="btn" onClick={() => setShowInherit(false)}>取消</button>
              <button className="btn primary" disabled={inheritFrom === ''}
                      onClick={() => void applyInherit(Number(inheritFrom))}>
                套用排表
              </button>
            </div>
            {error && <div className="msg error" style={{ marginTop: 8 }}>{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
