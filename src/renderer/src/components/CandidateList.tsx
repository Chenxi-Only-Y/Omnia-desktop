import { useMemo, useState } from 'react';
import type { SignupRow } from '@shared/types';
import type { PageProps } from '../App';
import { CLASSES } from '@shared/domain';
import ClassChip from './ClassChip';

/**
 * 报名候选列表（排表选人用）
 *
 * 用户口径：
 *  - 只列「成员主档有 **且** 本场报名有」的人（由调用方过滤好传进来）；
 *  - 主职与**二职都显示职业图标**（二职带「二职」前缀，图标与主职同源）；
 *  - **可按职业分组**，分组顺序跟随 12 职业表的固定顺序；
 *  - 请假者默认折叠，展开后才可选。
 */
const CLASS_ORDER = CLASSES.map((c) => c.name);
const UNKNOWN = '未登记职业';

function groupByClass(rows: SignupRow[]): [string, SignupRow[]][] {
  const map = new Map<string, SignupRow[]>();
  for (const r of rows) {
    const k = r.mainClass || UNKNOWN;
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  return [...map.entries()].sort((a, b) => {
    const ia = CLASS_ORDER.indexOf(a[0]);
    const ib = CLASS_ORDER.indexOf(b[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
}

export default function CandidateList({
  candidates, excludeIds, classMap, onPick, emptyHint, renderExtra,
}: {
  /** 本场已报名的人（调用方已过滤） */
  candidates: SignupRow[];
  /** 不再列出的（如已在别的小队） */
  excludeIds?: Set<number>;
  classMap: PageProps['classMap'];
  onPick: (playerId: number, subClass: string) => void;
  emptyHint: string;
  /** 每个条目右侧的额外标记（例如"已在某小队"） */
  renderExtra?: (r: SignupRow) => React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [showLeave, setShowLeave] = useState(false);

  const { joins, leaves } = useMemo(() => {
    const key = q.trim().toLowerCase();
    const free = candidates.filter((r) => !excludeIds?.has(r.playerId));
    const hit = (r: SignupRow) => !key
      || r.gameId.toLowerCase().includes(key)
      || r.mainClass.toLowerCase().includes(key)
      || r.subClass.toLowerCase().includes(key);
    return {
      joins: free.filter((r) => r.signup === 'JOIN' && hit(r)),
      leaves: free.filter((r) => r.signup !== 'JOIN' && hit(r)),
    };
  }, [candidates, excludeIds, q]);

  /**
   * 一个候选条目。**两个点击目标**：
   *   点名字/第一个职业标签 → 按主职放入；点第二个职业标签 → 按二职放入。
   * 用户要求不加「二职」文字，所以两者靠**图标**区分，
   * 并给第二个标签加虚线边表示"这是副职"（不加任何文字说明）。
   * （用 div 包两个 button，避免 button 嵌套 button 的非法结构）
   */
  const item = (r: SignupRow) => {
    // 主职与副职相同时只显示一个 —— 报名表里确实有人两栏填同一个职业
    // （样本里 心一 血河/血河、观青山 潮光/潮光 等），重复显示没有意义
    const sub = r.subClass && r.subClass !== r.mainClass ? r.subClass : '';
    return (
      <div key={r.playerId} className="picker-item picker-item--split">
        <button className="picker-item__main" onClick={() => onPick(r.playerId, '')}
                title={`按主职 ${r.mainClass || '（未登记）'} 放入`}>
          <span className="nm">{r.gameId}</span>
          <ClassChip name={r.mainClass} classMap={classMap} />
        </button>
        {/* 副职固定占第二列（没有副职时也占位），这样每一行的主职标签都对齐 */}
        {sub ? (
          <button className="picker-item__sub" onClick={() => onPick(r.playerId, sub)}
                  title={`按副职 ${sub} 放入`}>
            <ClassChip name={sub} classMap={classMap} />
          </button>
        ) : <span className="picker-item__sub picker-item__sub--empty" />}
        {renderExtra?.(r)}
      </div>
    );
  };

  const renderList = (rows: SignupRow[]) => {
    if (!grouped) return <div className="picker-grid">{rows.map(item)}</div>;
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        {groupByClass(rows).map(([cls, group]) => (
          <div key={cls} className="picker-group">
            <div className="picker-group__head">
              <ClassChip name={cls === UNKNOWN ? '' : cls} classMap={classMap} />
              <span className="picker-group__count">{group.length}</span>
            </div>
            <div className="picker-grid">{group.map(item)}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <input className="input grow" placeholder="搜索 ID / 职业" value={q}
               onChange={(e) => setQ(e.target.value)} />
        <button className={`btn sm${grouped ? ' primary' : ''}`}
                title="按主职业分组显示"
                onClick={() => setGrouped((v) => !v)}>
          按职业分组
        </button>
      </div>
      {joins.length === 0
        ? <span className="hint">{emptyHint}</span>
        : renderList(joins)}
      {leaves.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="btn sm ghost" onClick={() => setShowLeave((v) => !v)}>
            {showLeave ? '收起请假者' : `展开请假者（${leaves.length}）`}
          </button>
          {showLeave && <div style={{ marginTop: 6 }}>{renderList(leaves)}</div>}
        </div>
      )}
    </>
  );
}
