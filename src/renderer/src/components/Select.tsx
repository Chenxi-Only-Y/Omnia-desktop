import { Children, isValidElement, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

/**
 * 原生 <select> 的替身：样式可控的下拉。
 *
 * 为什么要替：<option> 的样式**浏览器不认** —— 展开列表由操作系统绘制，
 * 系统那套蓝色高亮改不掉（用户反馈「怎么还是」）。
 *
 * API 与原生对齐，便于全站机械替换：
 *   value / onChange / className / title / disabled / style / children(<option>)
 * onChange 内部合成 { target: { value } }，所以原有写法
 *   onChange={(e) => setX(e.target.value)} 一行都不用改。
 */
interface OptProps { value?: string | number; children?: ReactNode; disabled?: boolean }

export default function Select({
  value, onChange, className, title, disabled, style, onClick, icon, color, children,
}: {
  value?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
  /** 透传点击（有的调用点会 stopPropagation） */
  onClick?: (e: MouseEvent) => void;
  /** 职业下拉用：左侧图标 */
  icon?: string;
  /** 职业下拉用：文字与图标配额色（职业色） */
  color?: string;
  children?: ReactNode;
}) {
  const opts = Children.toArray(children)
    .filter((c) => isValidElement(c) && c.type === 'option')
    .map((c) => {
      const p = (c as unknown as { props: OptProps }).props;
      return { value: String(p.value ?? ''), label: p.children, disabled: !!p.disabled };
    });
  const curVal = String(value ?? '');
  const cur = opts.find((o) => o.value === curVal) ?? opts[0];

  return (
    <details className={'sel' + (className ? ' ' + className : '')} style={style} onClick={onClick}>
      <summary className="sel__btn" title={title} aria-disabled={disabled || undefined}>
        {icon && <img className="sel__ico" src={icon} alt="" />}
        <span className="sel__txt" style={color ? { color } : undefined}>{cur ? cur.label : ''}</span>
      </summary>
      {/* 隐藏的原生 select：只为兼容「set value + dispatch change」的调用方（自检探针等） */}
      <select className="sel__native" value={curVal} tabIndex={-1} aria-hidden
              onChange={(e) => onChange?.({ target: { value: e.target.value } })}>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div className="sel__list">
        {opts.map((o) => (
          <button key={o.value} type="button"
                  className={'sel__opt' + (o.value === curVal ? ' on' : '')}
                  disabled={o.disabled || disabled}
                  onClick={() => onChange?.({ target: { value: o.value } })}>
            {o.label}
          </button>
        ))}
      </div>
    </details>
  );
}
