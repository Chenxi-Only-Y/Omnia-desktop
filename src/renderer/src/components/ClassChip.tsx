import type { ClassInfo } from '@shared/types';
import { classIconSrc } from '../lib/assets';

interface Props {
  name: string;
  classMap: Map<string, ClassInfo>;
  fallbackColor?: string;
  /** 是否显示职业图标（图标缺失时自动退回色点） */
  showIcon?: boolean;
}

/** 职业标签：颜色与图标来自 class 表（原表「下滑预选」色板 + DISPIMG 图标） */
export default function ClassChip({ name, classMap, fallbackColor = '#6b7383', showIcon = true }: Props) {
  if (!name) return <span className="chip" style={{ color: 'var(--text-faint)' }}>—</span>;
  const cls = classMap.get(name);
  const color = cls?.color ?? fallbackColor;
  const unknown = !cls;
  const icon = showIcon ? classIconSrc(name) : null;
  return (
    <span
      className="chip class"
      style={{ color }}
      title={unknown ? '未登记在 12 职业表内' : `平衡系数 ${cls?.coef}${icon ? '' : ' · 无图标素材'}`}
    >
      {icon
        ? <img className="chip-icon" src={icon} alt="" />
        : <span className="dot" style={{ background: color }} />}
      {name}
      {unknown && <span style={{ color: 'var(--warn)' }}>?</span>}
    </span>
  );
}
