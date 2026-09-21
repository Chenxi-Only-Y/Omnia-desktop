import { useMemo, useState } from 'react';
import type { SignupRow } from '@shared/types';
import type { PageProps } from '../App';
import ClassChip from './ClassChip';

/**
 * 添加队员选择器
 *
 * 用户口径：候选只列「成员主档有 **且** 本场报名请假有」的人；
 * 参加 / 请假都显示状态，但**请假默认折叠**，展开后才可选。
 */
export default function AddPlayerPicker({
  candidates, existing, classMap, onPick,
}: {
  /** 本场已报名的人（来自 signup.board，只有 signup !== null 的才应传进来） */
  candidates: SignupRow[];
  existing: Set<number>;
  classMap: PageProps['classMap'];
  onPick: (id: number, subClass: string) => void;
}) {
  const [q, setQ] = useState('');
  const [showLeave, setShowLeave] = useState(false);

  const { joins, leaves } = useMemo(() => {
    const key = q.trim().toLowerCase();
    const free = candidates.filter((r) => !existing.has(r.playerId));
    const hit = (r: SignupRow) => !key
      || r.gameId.toLowerCase().includes(key)
      || r.mainClass.toLowerCase().includes(key)
      || r.subClass.toLowerCase().includes(key);
    return {
      joins: free.filter((r) => r.signup === 'JOIN' && hit(r)),
      leaves: free.filter((r) => r.signup !== 'JOIN' && hit(r)),
    };
  }, [candidates, existing, q]);

  const item = (r: SignupRow) => (
    <button key={r.playerId} className="picker-item"
            onClick={() => onPick(r.playerId, r.subClass)}
            title={`加入本场：${r.gameId}${r.subClass ? `（二职 ${r.subClass}）` : ''}`}>
      <span className="nm">{r.gameId}</span>
      <ClassChip name={r.mainClass} classMap={classMap} />
      {r.subClass && <span className="picker-item__where">二职 {r.subClass}</span>}
    </button>
  );

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <input className="input" style={{ width: 260, marginBottom: 8 }} placeholder="搜索 ID / 职业"
             value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-grid">
        {joins.length === 0 && <span className="hint">没有可添加的队员（可能都已在本场，或本场还没导入报名）</span>}
        {joins.map(item)}
      </div>
      {leaves.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="btn sm ghost" onClick={() => setShowLeave((v) => !v)}>
            {showLeave ? '收起请假者' : `展开请假者（${leaves.length}）`}
          </button>
          {showLeave && <div className="picker-grid" style={{ marginTop: 6 }}>{leaves.map(item)}</div>}
        </div>
      )}
    </div>
  );
}
