import { useState } from 'react';
import type { Player } from '@shared/types';
import type { PageProps } from '../App';
import ClassChip from './ClassChip';

/** 添加队员选择器（M5）：只列出还没进本场的人 */
export default function AddPlayerPicker({
  roster, existing, classMap, onPick,
}: {
  roster: Player[];
  existing: Set<number>;
  classMap: PageProps['classMap'];
  onPick: (id: number) => void;
}) {
  const [q, setQ] = useState('');
  const available = roster.filter((p) => {
    if (existing.has(p.id)) return false;
    const key = q.trim().toLowerCase();
    if (!key) return true;
    return p.name.toLowerCase().includes(key) || p.gameId.toLowerCase().includes(key)
      || p.mainClass.includes(q.trim());
  });
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <input className="input" style={{ width: 260, marginBottom: 8 }} placeholder="搜索名字 / 角色 ID / 职业"
             value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-grid">
        {available.length === 0 && <span className="hint">没有可添加的队员（已在场或搜索无结果）</span>}
        {available.map((p) => (
          <button key={p.id} className="picker-item" onClick={() => onPick(p.id)} title={`加入本场：${p.name}`}>
            <span className="nm">{p.name}</span>
            <ClassChip name={p.mainClass} classMap={classMap} />
            {p.noteRole && <span className="badge-note">{p.noteRole}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
