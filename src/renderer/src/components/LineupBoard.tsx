/**
 * 排表看板（LineupBoard）—— 卡片版
 *
 * 依据用户口径重构（原是照抄原表「排表」页的 5 行小表）：
 *   · 一队从左到右铺满，小队横向排列，便于观察与改动；一页不要求显示完，
 *     可以上下滑（队内 6 人）也能左右拉（小队多时）。
 *   · 卡片**底色 = 该队员职业的颜色**，与职业色板一致。
 *   · 卡片内容三行：
 *       标题   → 角色 ID 名（游戏 ID）
 *       第一行 → 职业
 *       第二行 → 技能备注（可直接改动填写）
 *
 * 建制仍完全数据驱动：战斗组与小队的名称、归属、战术、人数都来自数据库。
 */
import { useMemo, useRef, useState } from 'react';
import type { ParticipationRow, SquadCatalog, SquadRow } from '@shared/types';
import type { PageProps } from '../App';
import { classIconSrc } from '../lib/assets';

interface Props extends PageProps {
  rows: ParticipationRow[];
  catalog: SquadCatalog | null;
  onPickSlot: (squadName: string, slotIndex: number) => void;
  onRemoveRow: (rowId: number) => void;
  /** 拖拽落点：把一批队员放进该小队 */
  onAssign?: (playerIds: number[], squad: string) => void;
  /** 拖到「未分配」区：移出小队但保留在名单 */
  onUnassign?: (playerId: number) => void;
  /** 卡片上直接填写技能备注（人 × 场） */
  onSkillNote?: (playerId: number, note: string) => void;
  /** 给某组再加一队（每组队数不固定，按需加） */
  onAddSquad?: (groupId: number) => void;
  /** 删掉某一队（有历史记录时后端会拒绝） */
  onRemoveSquad?: (squadId: number, name: string) => void;
}

/** 拖拽携带的数据格式（自定义 MIME，避免和外部拖入的文件混淆） */
const DRAG_MIME = 'application/x-omnia-player';

interface DragPayload {
  playerIds: number[];
  label: string;
}

function readDrag(ev: React.DragEvent): DragPayload | null {
  const raw = ev.dataTransfer.getData(DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DragPayload;
    if (Array.isArray(parsed.playerIds) && parsed.playerIds.length) return parsed;
  } catch { /* 不是我们的格式（可能是外部文件） */ }
  return null;
}

export default function LineupBoard({
  rows, catalog, classMap, onPickSlot, onRemoveRow, onAssign, onUnassign, onSkillNote,
  onAddSquad, onRemoveSquad,
}: Props) {
  // 上场的都看得到：只排除明确"替补/请假"的。
  // 注意不能写成 state === 'PLAY' —— 参战记录的 state 可能是空串（历史数据/未设置），
  // 那样整条记录会被静默排除，看板上就"人不见了"（踩过一次）。
  const playing = useMemo(
    () => rows.filter((r) => r.side === 'our' && r.state !== 'BENCH' && r.state !== 'LEAVE'),
    [rows],
  );
  /** 正在拖拽的队员 ID（用于弱化原位置显示） */
  const dragIds = useRef<number[]>([]);
  /** 当前悬停的小队名 / 是否悬停在未分配区 */
  const [hoverSquad, setHoverSquad] = useState<string | null>(null);
  const [hoverUnassign, setHoverUnassign] = useState(false);

  /** 小队名 → 已排入的队员（按加入顺序） */
  const bySquad = useMemo(() => {
    const m = new Map<string, ParticipationRow[]>();
    for (const r of playing) {
      if (!r.squad) continue;
      if (!m.has(r.squad)) m.set(r.squad, []);
      m.get(r.squad)!.push(r);
    }
    return m;
  }, [playing]);

  const unassigned = playing.filter((r) => !r.squad);

  const groups = catalog?.groups ?? [];
  const squads = catalog?.squads ?? [];

  const defendGroups = groups.filter((g) => g.kind === 'defend');
  const attackGroups = groups.filter((g) => g.kind === 'attack');

  /** 拖拽中：记录被拖的队员，拖完清理高亮 */
  const dragProps = (playerIds: number[], label: string) => ({
    draggable: true,
    onDragStart: (ev: React.DragEvent) => {
      dragIds.current = playerIds;
      ev.dataTransfer.setData(DRAG_MIME, JSON.stringify({ playerIds, label } satisfies DragPayload));
      ev.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => {
      dragIds.current = [];
      setHoverSquad(null);
      setHoverUnassign(false);
    },
  });

  const dropProps = (squad: string) => ({
    onDragOver: (ev: React.DragEvent) => {
      if (!onAssign) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      setHoverSquad(squad);
    },
    onDragLeave: () => setHoverSquad((cur) => (cur === squad ? null : cur)),
    onDrop: (ev: React.DragEvent) => {
      ev.preventDefault();
      setHoverSquad(null);
      const payload = readDrag(ev);
      if (!payload || !onAssign) return;
      onAssign(payload.playerIds, squad);
    },
  });

  return (
    <div className="board">
      {/* 只留功能区：槽位计数与拖拽结果就地反映，说明性文字一律不要 */}
      {unassigned.length > 0 && (
        <div className="board__head">
          <span className="board__stat" style={{ color: 'var(--warn)' }}>
            {unassigned.length} 人未分配
          </span>
        </div>
      )}

      <div className="board__scroll">
        <div className="board__halves">
          {defendGroups.length > 0 && (
            <Half title="防守半区" groups={defendGroups} squads={squads} bySquad={bySquad}
                  classMap={classMap} onPickSlot={onPickSlot} onRemoveRow={onRemoveRow}
                  onSkillNote={onSkillNote}
                  onAddSquad={onAddSquad} onRemoveSquad={onRemoveSquad}
                  dragProps={dragProps} dropProps={dropProps} hoverSquad={hoverSquad}
                  draggingIds={dragIds.current} />
          )}
          <div className="board__divider" aria-hidden="true">
            <span className="board__calligraphy">万象</span>
          </div>
          {attackGroups.length > 0 && (
            <Half title="进攻半区" groups={attackGroups} squads={squads} bySquad={bySquad}
                  classMap={classMap} onPickSlot={onPickSlot} onRemoveRow={onRemoveRow}
                  onSkillNote={onSkillNote}
                  onAddSquad={onAddSquad} onRemoveSquad={onRemoveSquad}
                  dragProps={dragProps} dropProps={dropProps} hoverSquad={hoverSquad}
                  draggingIds={dragIds.current} />
          )}
        </div>
      </div>

      {unassigned.length > 0 && (
        <div
          className={`board__unassigned${hoverUnassign ? ' board__unassigned--hover' : ''}`}
          onDragOver={(ev) => { if (!onUnassign) return; ev.preventDefault(); setHoverUnassign(true); }}
          onDragLeave={() => setHoverUnassign(false)}
          onDrop={(ev) => {
            ev.preventDefault();
            setHoverUnassign(false);
            const payload = readDrag(ev);
            if (!payload || !onUnassign) return;
            for (const id of payload.playerIds) onUnassign(id);
          }}
        >
          <span className="board__unassigned-title">
            未分配小队（{unassigned.length}）{hoverUnassign ? ' —— 松手即移出小队' : ''}
          </span>
          {unassigned.map((r) => (
            <button
              key={r.id}
              className="board__chip"
              {...dragProps([r.playerId], r.name)}
              onClick={() => onRemoveRow(r.id)}
              title="拖动可放入小队；点击移出本场"
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Half({
  title, groups, squads, bySquad, classMap, onPickSlot, onRemoveRow, onSkillNote,
  dragProps, dropProps, hoverSquad, draggingIds, onAddSquad, onRemoveSquad,
}: {
  title: string;
  groups: SquadCatalog['groups'];
  squads: SquadRow[];
  bySquad: Map<string, ParticipationRow[]>;
  classMap: PageProps['classMap'];
  onPickSlot: (squadName: string, slotIndex: number) => void;
  onRemoveRow: (rowId: number) => void;
  onSkillNote?: (playerId: number, note: string) => void;
  dragProps: (playerIds: number[], label: string) => Record<string, unknown>;
  dropProps: (squad: string) => Record<string, unknown>;
  hoverSquad: string | null;
  draggingIds: number[];
  /** 给该组再加一队（队数不固定，按需加） */
  onAddSquad?: (groupId: number) => void;
  /** 删掉某一队（有历史记录的会被后端拒绝） */
  onRemoveSquad?: (squadId: number, name: string) => void;
}) {
  return (
    <div className="half">
      <div className="half__title">{title}</div>
      {groups.map((g) => {
        const list = squads.filter((s) => s.groupId === g.id);
        return (
          <div className="half__group" key={g.id}>
            <div className="half__groupname">
              {g.name}
              <span className="half__groupcount">{list.length} 队</span>
              {onAddSquad && (
                <button className="btn sm ghost half__addbtn" onClick={() => onAddSquad(g.id)}
                        title={`给「${g.name}」再加一队（第 ${list.length + 1} 队）`}>
                  ＋ 加一队
                </button>
              )}
            </div>
            {list.length === 0 && <div className="half__emptygroup">该战斗组下还没有小队</div>}
            <div className="half__row">
              {list.map((s) => (
                <SquadRowView key={s.id} squad={s} members={bySquad.get(s.name) ?? []}
                              classMap={classMap} onPickSlot={onPickSlot} onRemoveRow={onRemoveRow}
                              onSkillNote={onSkillNote} onRemoveSquad={onRemoveSquad}
                              dragProps={dragProps} dropProps={dropProps}
                              hovered={hoverSquad === s.name} draggingIds={draggingIds} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 一支小队 = 一整行：队名 + 6 张卡片横排铺开 */
function SquadRowView({
  squad, members, classMap, onPickSlot, onRemoveRow, onSkillNote,
  dragProps, dropProps, hovered, draggingIds, onRemoveSquad,
}: {
  squad: SquadRow;
  members: ParticipationRow[];
  classMap: PageProps['classMap'];
  onPickSlot: (squadName: string, slotIndex: number) => void;
  onRemoveRow: (rowId: number) => void;
  onSkillNote?: (playerId: number, note: string) => void;
  dragProps: (playerIds: number[], label: string) => Record<string, unknown>;
  dropProps: (squad: string) => Record<string, unknown>;
  hovered: boolean;
  draggingIds: number[];
  onRemoveSquad?: (squadId: number, name: string) => void;
}) {
  // 真正按格子落座：谁在第几格就渲染在第几格，**中间的空格留空**。
  // 只按槽号排序是不够的 —— 那样人还是会从 0 号位连续铺开，
  // 点第 5 格的人显示上仍被挤到前面（踩过一次）。
  const ordered: (ParticipationRow | null)[] = new Array(squad.size).fill(null);
  const noSlot: ParticipationRow[] = [];
  for (const m of members) {
    const s = m.slotNo ?? -1;
    if (s >= 0 && s < squad.size && ordered[s] === null) ordered[s] = m;
    else noSlot.push(m);      // 未指定格号 / 越界 / 同格冲突 → 顺次补进空格
  }
  let cursor = 0;
  for (const m of noSlot) {
    while (cursor < squad.size && ordered[cursor] !== null) cursor += 1;
    if (cursor < squad.size) ordered[cursor] = m;
  }
  const tone = squad.kind === 'defend' ? 'defend' : 'attack';

  return (
    <div
      className={`squadrow squadrow--${tone}${hovered ? ' squadrow--drop' : ''}`}
      data-squad={squad.name}
      {...dropProps(squad.name)}
    >
      <div className="squadrow__head">
        <span>{squad.name}</span>
        <span className="squadrow__count">{members.length}/{squad.size}</span>
        {squad.tactic && <span className="squadrow__tactic">{squad.tactic}</span>}
        {onRemoveSquad && (
          <button className="squadrow__del" title={`删掉「${squad.name}」这一队（有历史记录时会被拒绝）`}
                  onClick={(e) => { e.stopPropagation(); onRemoveSquad(squad.id, squad.name); }}>
            ×
          </button>
        )}
      </div>
      <div className="squadrow__cards">
        {ordered.map((r, i) => (
          <PlayerCard key={i} row={r} slotIndex={i} squad={squad} classMap={classMap}
                      onPickSlot={onPickSlot} onRemoveRow={onRemoveRow} onSkillNote={onSkillNote}
                      dragProps={dragProps} dragging={!!r && draggingIds.includes(r.playerId)} />
        ))}
      </div>
    </div>
  );
}

/** 一张队员卡片：标题=角色 ID 名 / 第一行=职业 / 第二行=技能备注（可编辑） */
function PlayerCard({
  row, slotIndex, squad, classMap, onPickSlot, onRemoveRow, onSkillNote, dragProps, dragging,
}: {
  row: ParticipationRow | null;
  slotIndex: number;
  squad: SquadRow;
  classMap: PageProps['classMap'];
  onPickSlot: (squadName: string, slotIndex: number) => void;
  onRemoveRow: (rowId: number) => void;
  onSkillNote?: (playerId: number, note: string) => void;
  dragProps: (playerIds: number[], label: string) => Record<string, unknown>;
  dragging: boolean;
}) {
  // 卡片是受控输入的本地草稿：边打字边存会让光标跳，所以失焦/回车才提交
  const [note, setNote] = useState(row?.skillNote ?? '');
  const [noteFor, setNoteFor] = useState<number | null>(row?.playerId ?? null);
  // 外部数据刷新后同步（同一张卡换了人，或备注被别处改动）
  if ((row?.playerId ?? null) !== noteFor) {
    setNoteFor(row?.playerId ?? null);
    setNote(row?.skillNote ?? '');
  }

  if (!row) {
    return (
      <button className="pcard pcard--empty" onClick={() => onPickSlot(squad.name, slotIndex)}
              title="空位 · 点击放入队员">
        <span className="pcard__empty">＋ 空位</span>
      </button>
    );
  }

  const cls = row.classUsed || row.mainClass || '';
  const def = classMap.get(cls);
  const icon = cls ? classIconSrc(cls) : null;
  const commit = () => {
    if (onSkillNote && note !== row.skillNote) onSkillNote(row.playerId, note);
  };

  return (
    <div
      className={`pcard${dragging ? ' pcard--dragging' : ''}${def ? '' : ' pcard--noclass'}`}
      /* 卡片底色 = 职业色；文字统一白色（用户口径），
         浅色职业底由 CSS 的压暗层保证可读 */
      style={def ? { background: def.color } : undefined}
      title={`${cls || '未登记职业'} · 拖动可换小队`}
      {...dragProps([row.playerId], row.name)}
    >
      {/* 只留三行：ID 名 / 职业 / 技能备注（用户口径，不要多余东西） */}
      <div className="pcard__id" onClick={() => onRemoveRow(row.id)}
           title={`${row.name}（ID: ${row.gameId}）· 点击移出本场`}>
        {row.gameId || row.name}
      </div>
      <div className="pcard__cls" onClick={() => onPickSlot(squad.name, slotIndex)}
           title="点击换人 / 放入队员">
        {icon && <img className="pcard__icon" src={icon} alt="" />}
        {cls || '未登记职业'}
      </div>
      {/* 技能备注：单行、无框，看起来就是一行普通文字（用户口径） */}
      <input
        className="pcard__note"
        value={note}
        placeholder="技能备注"
        disabled={!onSkillNote}
        title="本场技能备注（每人每场各自保存，回车保存）"
        onChange={(e) => setNote(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') setNote(row.skillNote ?? '');
        }}
        // 卡片本身可拖拽，输入框里要能正常选中文字
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  );
}
