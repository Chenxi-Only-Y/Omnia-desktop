import { useState } from 'react';
import type { ParticipationRow, Player } from '@shared/types';
import type { PageProps } from '../App';
import ClassChip from './ClassChip';

/**
 * 点击看板格子后的选人面板（M5）
 * 已在别的小队的人会被移动过来（同一场里一人只能在一个小队）。
 */
export default function CellPicker({
  squad, roster, rows, classMap, onAssign, onClose,
}: {
  squad: string;
  roster: Player[];
  rows: ParticipationRow[];
  classMap: PageProps['classMap'];
  onAssign: (playerId: number, squad: string) => Promise<void>;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const byId = new Map(rows.map((r) => [r.playerId, r]));
  const key = q.trim().toLowerCase();

  const list = roster
    .map((p) => ({ p, cur: byId.get(p.id) }))
    .filter(({ p, cur }) => {
      if (cur?.squad === squad) return false;        // 已在本小队
      if (!key) return true;
      return p.name.toLowerCase().includes(key) || p.gameId.toLowerCase().includes(key)
        || p.mainClass.includes(q.trim());
    })
    .sort((a, b) => {
      // 未分配的排前面，其次按入帮序
      const ua = a.cur?.squad ? 1 : 0;
      const ub = b.cur?.squad ? 1 : 0;
      if (ua !== ub) return ua - ub;
      return (a.p.joinedOrder ?? 9999) - (b.p.joinedOrder ?? 9999);
    });

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>放入「{squad}」</h3>
          <button className="btn sm ghost" onClick={onClose}>关闭</button>
        </div>
        <input className="input" style={{ width: '100%', marginBottom: 8 }}
               placeholder="搜索名字 / 角色 ID / 职业" value={q} autoFocus
               onChange={(e) => setQ(e.target.value)} />
        <div className="picker-grid" style={{ maxHeight: 320 }}>
          {list.length === 0 && <span className="hint">没有可放入的队员</span>}
          {list.map(({ p, cur }) => (
            <button key={p.id} className="picker-item" onClick={() => void onAssign(p.id, squad)}>
              <span className="nm">{p.name}</span>
              <ClassChip name={p.mainClass} classMap={classMap} />
              {cur?.squad && <span className="picker-item__where">{cur.squad}</span>}
            </button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          已经在别的小队里的人会被移动过来（同一场里一人只能在一个小队）。
        </div>
      </div>
    </div>
  );
}
