import { Children, isValidElement, useLayoutEffect, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';

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
  placeholder,
}: {
  value?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
  /** 透传点击（有的调用点会 stopPropagation） */
  onClick?: (e: ReactMouseEvent) => void;
  /** 职业下拉用：左侧图标 */
  icon?: string;
  /** 职业下拉用：文字与图标配额色（职业色） */
  color?: string;
  /** 有占位项时置 true：占位项（value 为空）照旧决定按钮文字，但**不出现在展开列表里** */
  placeholder?: boolean;
  children?: ReactNode;
}) {
  // 递归收集 <option>：调用点常写成 <>{list.map(...)}</>（Fragment）或包一层组件，
  // 而 Children.toArray **不会摊平 Fragment** —— 只认直接子元素的话选项会被全部过滤掉，
  // 下拉就变成一个空盒子（用户截图：白色空格子，看不到东西）。
  const opts: { value: string; label: ReactNode; disabled: boolean }[] = [];
  const collect = (node: ReactNode) => {
    Children.forEach(node, (c) => {
      if (!isValidElement(c)) return;
      if (c.type === 'option') {
        const p = (c as unknown as { props: OptProps }).props;
        opts.push({ value: String(p.value ?? ''), label: p.children, disabled: !!p.disabled });
        return;
      }
      const kids = (c as unknown as { props?: { children?: ReactNode } }).props?.children;
      if (kids !== undefined) collect(kids);
    });
  };
  collect(children);
  // 过滤掉 select / input 这类**原生控件类名**：它们自带底色+描边+内边距，
  // 套在外层 <details> 上就会和里面的 .sel__btn 形成"双框套娃"（用户反馈：太丑了）。
  // 盒子统一由 .sel__btn 提供，外层只做定位。
  const cls = String(className ?? '')
    .split(/\s+/)
    .filter((c) => c && c !== 'select' && c !== 'input')
    .join(' ');
  /* 受控开合：<details> 关闭时内容立刻被浏览器隐藏，纯 CSS 做不出收起动画，
     所以改成受控 —— open 用状态，关闭时**保持挂载** 180ms 播反向动画。
     注意：外层 div 仍渲染 `open` 属性（React 会把未知小写属性透传），
     这样所有既有的 .sel[open] 样式（含 :has(.sel[open]) 抬层级）都不用改。 */
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  /* 展开方向与可用高度：选项列表是**真实内容高度**（职业下拉 13 项 ≈ 450px），
     靠近窗口底部打开时会被切掉一半 —— 所以开之前量一下上下空间：
       · 下面装得下 → 照旧向下；
       · 下面装不下、上面更宽裕 → 翻到上面（.sel--up）；
       · 上下都紧张 → 仍然向下，但把 max-height 收到可用高度（列表自己滚动）。
     高度用 px 内联写死，而不是只靠 CSS，才能保证面板永远落在窗口里。 */
  const [up, setUp] = useState(false);
  const [maxH, setMaxH] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const close = () => {
    setOpen(false);
    setClosing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setClosing(false), 180);
  };
  // 把开合状态写到 DOM 属性上：既有的 .sel[open] 样式与 :has(.sel[open]) 抬层级
  // 全部继续生效；同时避开 React 不认 div 的 open 属性的类型问题。
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (open || closing) el.setAttribute('open', ''); else el.removeAttribute('open');
  }, [open, closing]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDoc);
    /* ⚠️ 这里**不能**顺手 clearTimeout(timer.current)：
       open 变 false 时这个清理函数正好会跑，而 close() 刚刚才排了一个 180ms 的
       "收起动画结束 → setClosing(false)"，一清就永远不会执行 —— closing 卡在 true，
       面板以 opacity:0 / clip-path 全裁的样子**常驻 DOM**（幽灵节点，实测抓到过）。 */
    return () => { document.removeEventListener('mousedown', onDoc); };
  }, [open]);

  // 定时器只在组件真正卸载时清
  useEffect(() => () => window.clearTimeout(timer.current), []);

  /* 量一次：列表要在 open 之后、绘制之前决定方向与高度，所以用 useLayoutEffect（不会闪一下再翻）。
     ⚠️ 关键：可用空间要按**最近的裁剪容器**算，不能只按窗口算 ——
     报名表的 `.table-wrap` 是 overflow:auto、`table.grid` 又 overflow:hidden，
     面板伸出去的部分会被直接切掉，看起来就是"下拉被下面的行/卡片盖住了"（用户反馈：被覆盖了）。
     所以：边界 = min(窗口, 裁剪容器)，高度不超过边界，装不下就翻到另一侧，再装不下就自己滚动。 */
  useLayoutEffect(() => {
    if (!open) { setUp(false); setMaxH(null); return; }
    const el = box.current;
    const list = el?.querySelector('.sel__list') as HTMLElement | null;
    if (!el || !list) return;
    const r = el.getBoundingClientRect();
    let clipTop = 0;
    let clipBottom = window.innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(cs.overflowY) || /(auto|scroll|hidden)/.test(cs.overflowX)) {
        const cr = p.getBoundingClientRect();
        clipTop = Math.max(clipTop, cr.top);
        clipBottom = Math.min(clipBottom, cr.bottom);
        break;   // 最近的一个就够了（更外层的窗口已经夹过一次）
      }
    }
    const natural = list.scrollHeight;              // 未受 max-height 限制时的内容高度
    const roomBelow = clipBottom - r.bottom - 10;
    const roomAbove = r.top - clipTop - 10;
    const flip = natural > roomBelow && roomAbove > roomBelow;
    setUp(flip);
    const room = flip ? roomAbove : roomBelow;
    setMaxH(natural > room ? Math.max(110, Math.round(room)) : null);
  }, [open]);

  const curVal = String(value ?? '');
  /* 值不在选项里时的兜底 —— **不能退回第一个选项**：
     比如旧数据 mic='无需作答' 而下拉只留了「有 / 无」，退回第一个就会把
     「无需作答」显示成「有」，用户保存一次就把数据改错了（历史值还可能是被删掉的职业名等）。
     所以：非空值原样显示；空值显示 placeholder 文案（没有就显示空）。 */
  const cur = opts.find((o) => o.value === curVal)
    ?? (curVal ? { value: curVal, label: curVal, disabled: false } : opts[0]);

  return (
    <div ref={box} className={'sel' + (cls ? ' ' + cls : '') + (up ? ' sel--up' : '')} style={style} onClick={onClick}>
      <button type="button" className="sel__btn" title={title} disabled={disabled}
              onClick={() => (open ? close() : setOpen(true))}>
        {icon && <img className="sel__ico" src={icon} alt="" />}
        <span className="sel__txt" style={color ? { color } : undefined}>{cur ? cur.label : ''}</span>
      </button>
      {/* 隐藏的原生 select：只为兼容「set value + dispatch change」的调用方（自检探针等） */}
      <select className="sel__native" value={curVal} tabIndex={-1} aria-hidden
              onChange={(e) => onChange?.({ target: { value: e.target.value } })}>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {(open || closing) && (
      <div className={'sel__list' + (open ? ' sel__list--in' : ' sel__list--out')}
           style={maxH ? { maxHeight: `${maxH}px` } : undefined}>
        {(placeholder ? opts.filter((o) => o.value !== '') : opts).map((o) => (
          <button key={o.value} type="button"
                  className={'sel__opt' + (o.value === curVal ? ' on' : '')}
                  disabled={o.disabled || disabled}
                  onClick={() => { onChange?.({ target: { value: o.value } }); close(); }}>
            {o.label}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}
