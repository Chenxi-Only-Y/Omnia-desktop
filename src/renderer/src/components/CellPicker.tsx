import type { ParticipationRow, SignupRow } from '@shared/types';
import type { PageProps } from '../App';
import CandidateList from './CandidateList';

/**
 * 点击看板格子后的选人面板
 *
 * 候选只列「成员主档有 **且** 本场报名请假有」的人；按职业分组、二职带图标；
 * 已经在别的小队的人会被移动过来（同一场里一人只能在一个小队）。
 */
export default function CellPicker({
  squad, candidates, rows, classMap, onAssign, onClose,
}: {
  squad: string;
  candidates: SignupRow[];
  rows: ParticipationRow[];
  classMap: PageProps['classMap'];
  onAssign: (playerId: number, squad: string, subClass: string) => Promise<void>;
  onClose: () => void;
}) {
  // 已在本小队的排除掉；在别的队里的仍然列出（选中会移动过来）
  const inThisSquad = new Set(
    rows.filter((r) => r.squad === squad).map((r) => r.playerId),
  );
  const squadOf = new Map(rows.map((r) => [r.playerId, r.squad]));

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>放入「{squad}」</h3>
          <button className="btn sm ghost" onClick={onClose}>关闭</button>
        </div>
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <CandidateList
            candidates={candidates}
            excludeIds={inThisSquad}
            classMap={classMap}
            onPick={(playerId, subClass) => void onAssign(playerId, squad, subClass)}
            emptyHint="没有可放入的队员（本场没报名的人不在此列）"
            renderExtra={(r) => {
              const where = squadOf.get(r.playerId);
              return where ? <span className="picker-item__where">{where}</span> : null;
            }}
          />
        </div>
        
      </div>
    </div>
  );
}
