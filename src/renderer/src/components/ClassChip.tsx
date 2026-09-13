import type { ClassInfo } from '@shared/types';
import { classIconUrl } from '@shared/domain';

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
  const icon = showIcon ? classIconUrl(name) : null;
  // 用绝对路径拼接：打包后页面是 file://.../dist/renderer/index.html，
  // 图标在 dist/renderer/class-icons/（public 原样拷贝），两者同在根目录下。
  const iconSrc = icon ? `${import.meta.env.BASE_URL}${icon.replace(/^\.\//, '')}` : null;
  return (
    <span
      className="chip class"
      style={{ color }}
      title={unknown ? '未登记在 12 职业表内' : `平衡系数 ${cls?.coef}${icon ? '' : ' · 无图标素材'}`}
    >
      {iconSrc
        ? <img className="chip-icon" src={iconSrc} alt="" />
        : <span className="dot" style={{ background: color }} />}
      {name}
      {unknown && <span style={{ color: 'var(--warn)' }}>?</span>}
    </span>
  );
}
