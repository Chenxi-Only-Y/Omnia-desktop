/**
 * 排表看板（LineupBoard）
 *
 * 版式对齐原表「排表」页（依据用户提供的原表截图）：
 *   每个「小队」是一个 5 行 × 6 人的小表：
 *     ro1  职业色块（按职业色铺底 + 职业图标）
 *     ro2  技能标签 / 备注角色
 *     ro3  玩家名 + 麦克风标记
 *     ro4  战术类型
 *     ro5  角色 ID
 *   小队右侧有 "总计 / 小队名" 两列；小队之间留空隙；
 *   左右两个半区（防守 / 进攻）用中缝分隔。
 *
 * 建制完全数据驱动：战斗组与小队的名称、归属、战术、人数都来自数据库
 * （用户口径：10 个战斗队 × 6 人，划归到 4 个战斗组，可新增）。
 */
import { useMemo } from 'react';
import type { ParticipationRow, SquadCatalog, SquadRow } from '@shared/types';
import type { PageProps } from '../App';
import { classIconSrc } from '../lib/assets';

interface Props extends PageProps {
  rows: ParticipationRow[];
  catalog: SquadCatalog | null;
  onPickSlot: (squadName: string, slotIndex: number) => void;
  onRemoveRow: (rowId: number) => void;
}

interface Cell {
  row: ParticipationRow | null;
  index: number;
}

export default function LineupBoard({ rows, catalog, classMap, onPickSlot, onRemoveRow }: Props) {
  const playing = useMemo(() => rows.filter((r) => r.side === 'our' && r.state === 'PLAY'), [rows]);

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
  const capacity = catalog?.capacity ?? 0;
  const filled = playing.filter((r) => r.squad).length;

  const squadsOf = (groupId: number): SquadRow[] => squads.filter((s) => s.groupId === groupId);

  const defendGroups = groups.filter((g) => g.kind === 'defend');
  const attackGroups = groups.filter((g) => g.kind === 'attack');

  return (
    <div className="board">
      <div className="board__head">
        <span className="board__title">阵容看板</span>
        <span className="board__stat">
          已排 <b>{filled}</b> / {capacity} 个槽位
          {unassigned.length > 0 && (
            <span style={{ color: 'var(--warn)' }}> · {unassigned.length} 人未分配</span>
          )}
        </span>
        <span className="board__legend">
          <span className="lg lg--defend" />防守
          <span className="lg lg--attack" />进攻
        </span>
      </div>

      <div className="board__scroll">
        <div className="board__halves">
          {defendGroups.length > 0 && (
            <Half title="防守半区" groups={defendGroups} squadsOf={squadsOf} bySquad={bySquad}
                  classMap={classMap} onPickSlot={onPickSlot} onRemoveRow={onRemoveRow} />
          )}
          <div className="board__divider" aria-hidden="true">
            <span className="board__calligraphy">万象</span>
          </div>
          {attackGroups.length > 0 && (
            <Half title="进攻半区" groups={attackGroups} squadsOf={squadsOf} bySquad={bySquad}
                  classMap={classMap} onPickSlot={onPickSlot} onRemoveRow={onRemoveRow} />
          )}
        </div>
      </div>

      {unassigned.length > 0 && (
        <div className="board__unassigned">
          <span className="board__unassigned-title">未分配小队（{unassigned.length}）</span>
          {unassigned.map((r) => (
            <button key={r.id} className="board__chip" onClick={() => onRemoveRow(r.id)}
                    title="点击移出本场">
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Half({
  title, groups, squadsOf, bySquad, classMap, onPickSlot, onRemoveRow,
}: {
  title: string;
  groups: SquadCatalog['groups'];
  squadsOf: (groupId: number) => SquadRow[];
  bySquad: Map<string, ParticipationRow[]>;
  classMap: PageProps['classMap'];
  onPickSlot: (squadName: string, slotIndex: number) => void;
  onRemoveRow: (rowId: number) => void;
}) {
  return (
    <div className="half">
      <div className="half__title">{title}</div>
      {groups.map((g) => {
        const list = squadsOf(g.id);
        // 每 3 支小队排成一行（与原表一区块 3 列一致）；组内不足 3 支也照常渲染
        const rowsOfBlocks: SquadRow[][] = [];
        for (let i = 0; i < list.length; i += 3) rowsOfBlocks.push(list.slice(i, i + 3));
        return (
          <div className="half__group" key={g.id}>
            <div className="half__groupname">{g.name}</div>
            {rowsOfBlocks.length === 0 && (
              <div className="half__emptygroup">该战斗组下还没有小队</div>
            )}
            {rowsOfBlocks.map((chunk, ci) => (
              <div className="half__row" key={ci}>
                {chunk.map((s) => (
                  <BlockView key={s.id} squad={s} members={bySquad.get(s.name) ?? []}
                             classMap={classMap} onPickSlot={onPickSlot} onRemoveRow={onRemoveRow} />
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function BlockView({
  squad, members, classMap, onPickSlot, onRemoveRow,
}: {
  squad: SquadRow;
  members: ParticipationRow[];
  classMap: PageProps['classMap'];
  onPickSlot: (squadName: string, slotIndex: number) => void;
  onRemoveRow: (rowId: number) => void;
}) {
  const cells: Cell[] = [];
  for (let i = 0; i < squad.size; i++) cells.push({ row: members[i] ?? null, index: i });
  const tone = squad.kind === 'defend' ? 'defend' : 'attack';

  return (
    <div className={`blk blk--${tone}`}>
      <table className="blk__table">
        <tbody>
          <tr className="blk__cls">
            {cells.map((c) => {
              const cls = c.row?.classUsed || c.row?.mainClass || '';
              const def = classMap.get(cls);
              const iconSrc = cls ? classIconSrc(cls) : null;
              return (
                <td key={c.index}
                    style={def ? { background: def.color, color: '#10121a' } : undefined}
                    title={cls ? `${cls} · 点击放入队员` : '空位 · 点击放入队员'}
                    onClick={() => onPickSlot(squad.name, c.index)}>
                  {iconSrc
                    ? <img src={iconSrc} alt={cls} className="blk__icon" />
                    : <span className="blk__clsname">{cls || '+'}</span>}
                </td>
              );
            })}
            <td className="blk__total">{members.length || ''}</td>
          </tr>
          <tr className="blk__skill">
            {cells.map((c) => (
              <td key={c.index}>{c.row?.noteRole ?? ''}</td>
            ))}
            <td className="blk__teamname" rowSpan={4}>{squad.name}</td>
          </tr>
          <tr className="blk__name">
            {cells.map((c) => (
              <td key={c.index}
                  title={c.row ? `${c.row.gameId}${c.row.mic ? ' · 麦:' + c.row.mic : ''}` : '空位 · 点击放入队员'}
                  onClick={() => (c.row ? onRemoveRow(c.row.id) : onPickSlot(squad.name, c.index))}>
                {c.row ? (
                  <>
                    <span className="blk__pname">{c.row.name}</span>
                    {c.row.mic === '有' && <span className="blk__mic blk__mic--on" title="有麦">◉</span>}
                    {c.row.mic === '无' && <span className="blk__mic blk__mic--off" title="无麦">○</span>}
                  </>
                ) : <span className="blk__empty">空位</span>}
              </td>
            ))}
          </tr>
          <tr className="blk__score">
            {cells.map((c) => (
              <td key={c.index}>{c.row?.tactic || ''}</td>
            ))}
          </tr>
          <tr className="blk__id">
            {cells.map((c) => (
              <td key={c.index} title={c.row?.gameId ?? ''}>{c.row?.gameId ?? ''}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
