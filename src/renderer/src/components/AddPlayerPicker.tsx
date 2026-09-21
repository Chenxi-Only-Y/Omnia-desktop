import type { SignupRow } from '@shared/types';
import type { PageProps } from '../App';
import CandidateList from './CandidateList';

/**
 * 添加队员选择器
 *
 * 候选只列「成员主档有 **且** 本场报名请假有」的人；
 * 参加 / 请假都显示状态，请假默认折叠。按职业分组、二职带图标 ——
 * 具体渲染交给 CandidateList（与看板点格子的选择器共用，避免两处走样）。
 */
export default function AddPlayerPicker({
  candidates, existing, classMap, onPick,
}: {
  candidates: SignupRow[];
  existing: Set<number>;
  classMap: PageProps['classMap'];
  onPick: (id: number, subClass: string) => void;
}) {
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <CandidateList
        candidates={candidates}
        excludeIds={existing}
        classMap={classMap}
        onPick={onPick}
        emptyHint="没有可添加的队员（可能都已在本场，或本场还没导入报名）"
      />
    </div>
  );
}
