import { useState } from 'react';
import type { ClassInfo, ParticipationRow, SignupRow } from '@shared/types';
import type { PageProps } from '../App';
import CandidateList from './CandidateList';
import ManualAddPlayer from './ManualAddPlayer';

/**
 * 点击看板格子后的选人面板
 *
 * 用户口径（2026-09 修正）：
 *  - **只要已排进战斗小队，就从候选里消失**，而不是列出来并标注「在哪个队」。
 *    原先靠调用方过滤，结果只有排表页过滤了、对局详情没过滤 ——
 *    同一个人在两处表现不一致（对局详情里被排过的人还留在列表里，旁边挂个黄色队名）。
 *    现在把过滤收进本组件：它本来就拿到了 rows，不必依赖调用方记得传干净数据。
 *  - 因此 `renderExtra`（那个黄色「在哪里」标记）**整体删掉**，不再有这种标记。
 *
 * 2026-09 追加（用户口径：「这个地方增加个添加成员」「和报名那个同步」）：
 *  底部多一个「＋ 添加成员」—— 展开就是报名页那个**同一个** ManualAddPlayer 表单。
 *  临时来的人没在候选里（没报名/没建档）时，可以就地建档 + 写本场报名 + 直接放进这一格。
 */
export default function CellPicker({
  squad, candidates, rows, classMap, onAssign, onClose,
  matchId, classes, onAdded,
}: {
  squad: string;
  candidates: SignupRow[];
  rows: ParticipationRow[];
  classMap: PageProps['classMap'];
  onAssign: (playerId: number, squad: string, subClass: string) => Promise<void>;
  onClose: () => void;
  /** 手动加人要用：本场 id 与职业表 */
  matchId: number;
  classes: ClassInfo[];
  /** 建档/写报名的结果（用于给用户一句回执） */
  onAdded?: (msg: string) => void;
}) {
  /** 已经在某个小队里（含替补/请假）的人 → 不再出现在候选 */
  const takenIds = new Set(rows.filter((r) => r.squad).map((r) => String(r.playerId)));
  const free = candidates.filter((r) => !takenIds.has(String(r.playerId)));
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>放入「{squad}」</h3>
          <button className="btn sm ghost" onClick={onClose}>关闭</button>
        </div>
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <CandidateList
            candidates={free}
            classMap={classMap}
            onPick={(playerId, subClass) => void onAssign(playerId, squad, subClass)}
            emptyHint="没有可放入的队员（本场没报名、或都已排进小队的人不在此列）"
          />
        </div>
        {/* 手动加人：与报名页共用同一个组件，字段/行为完全一致 */}
        <div className="cellpick__add">
          <button className="btn sm" onClick={() => setAddOpen((v) => !v)}>
            {addOpen ? '收起' : '＋ 添加成员'}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            没报名/还没建档的人，在这里加完会直接放进这一格
          </span>
        </div>
        {addOpen && (
          <ManualAddPlayer
            matchId={matchId}
            classes={classes}
            autoFocus
            submitLabel="建档并放入"
            onAdded={(playerId, info) => {
              onAdded?.(`${info.created ? `已建档「${info.gameId}」` : `已把「${info.gameId}」`}放入「${squad}」`);
              setAddOpen(false);
              void onAssign(playerId, squad, info.subClass);
            }}
          />
        )}
      </div>
    </div>
  );
}
