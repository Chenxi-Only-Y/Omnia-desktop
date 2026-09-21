import { useMemo, useState } from 'react';
import type { ParticipationRow, SignupRow } from '@shared/types';
import type { PageProps } from '../App';
import ClassChip from './ClassChip';

/**
 * 点击看板格子后的选人面板
 *
 * 用户口径：候选只列「成员主档有 **且** 本场报名请假有」的人；
 * 参加 / 请假都显示状态，请假默认折叠。已经在别的小队的人会被移动过来
 * （同一场里一人只能在一个小队）。
 */
export default function CellPicker({
  squad, candidates, rows, classMap, onAssign, onClose,
}: {
  squad: string;
  /** 本场已报名的人（signup.board 里 signup !== null 的） */
  candidates: SignupRow[];
  rows: ParticipationRow[];
  classMap: PageProps['classMap'];
  onAssign: (playerId: number, squad: string, subClass: string) => Promise<void>;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [showLeave, setShowLeave] = useState(false);
  const byId = new Map(rows.map((r) => [r.playerId, r]));

  const { joins, leaves } = useMemo(() => {
    const key = q.trim().toLowerCase();
    const list = candidates
      .map((r) => ({ r, cur: byId.get(r.playerId) }))
      .filter(({ r, cur }) => {
        if (cur?.squad === squad) return false;        // 已在本小队
        if (!key) return true;
        return r.gameId.toLowerCase().includes(key)
          || r.mainClass.toLowerCase().includes(key)
          || r.subClass.toLowerCase().includes(key);
      })
      .sort((a, b) => {
        // 未分配的排前面，其次按入帮序
        const ua = a.cur?.squad ? 1 : 0;
        const ub = b.cur?.squad ? 1 : 0;
        if (ua !== ub) return ua - ub;
        return (a.r.joinedOrder ?? 9999) - (b.r.joinedOrder ?? 9999);
      });
    return {
      joins: list.filter((x) => x.r.signup === 'JOIN'),
      leaves: list.filter((x) => x.r.signup !== 'JOIN'),
    };
  }, [candidates, byId, q, squad]);

  const item = ({ r, cur }: { r: SignupRow; cur: ParticipationRow | undefined }) => (
    <button key={r.playerId} className="picker-item"
            onClick={() => void onAssign(r.playerId, squad, r.subClass)}>
      <span className="nm">{r.gameId}</span>
      <ClassChip name={r.mainClass} classMap={classMap} />
      {r.subClass && <span className="picker-item__where">二职 {r.subClass}</span>}
      {cur?.squad && <span className="picker-item__where">{cur.squad}</span>}
    </button>
  );

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>放入「{squad}」</h3>
          <button className="btn sm ghost" onClick={onClose}>关闭</button>
        </div>
        <input className="input" style={{ width: '100%', marginBottom: 8 }}
               placeholder="搜索 ID / 职业" value={q} autoFocus
               onChange={(e) => setQ(e.target.value)} />
        <div className="picker-grid" style={{ maxHeight: 320 }}>
          {joins.length === 0 && <span className="hint">没有可放入的队员（本场没报名的人不在此列）</span>}
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
        <div className="hint" style={{ marginTop: 8 }}>
          只列出本场已报名的人；已经在别的小队里的人会被移动过来（同一场里一人只能在一个小队）。
        </div>
      </div>
    </div>
  );
}
