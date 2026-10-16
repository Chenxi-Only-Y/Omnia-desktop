import { Children, isValidElement, useCallback, useLayoutEffect, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  /* 面板的定位：**portal 到 body + position:fixed**。
     为什么不能留在原地：它是 absolute，会被**最近的滚动容器**裁掉 —— 报名表搜索后只剩一行时
     `.table-wrap` 只有 75px 高（实测），13 个职业用户只看得见 1 个（2026-10-16 用户报障「看不到了」）。
     挂到 body 之后没有任何祖先能裁它，边界改用**窗口**，装不下就在窗口内滚动。
     坐标/宽度/高度都内联写死（面板宽度是 max-content → 必须先渲染一帧量出来，见 measure）。 */
  const [pos, setPos] = useState<{
    left: number; top: number; minW: number; maxW: number; maxH: number | null; origin: string;
  } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
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
      const t = e.target as Node;
      // 面板已经 portal 到 body、不在 box 里 —— 必须一起放行，
      // 否则点选项会被当成「点了外面」先 close()，选项就白点了
      if (box.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
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

  /* 量一次并算好坐标：面板现在挂在 body 上，边界就是**窗口**（不再看滚动容器 —— 看不住，
     容器该裁还是会裁）。用 useLayoutEffect 是为了在浏览器绘制前就把 pos 定下来，不会闪。
     ⚠️ 面板宽度是 max-content：第一帧先以自然宽度渲染出来量一次，同一帧内 setPos，
     React 会在绘制前重渲染 → 用户看不到中间态。 */
  const measure = useCallback(() => {
    const el = box.current;
    const panel = listRef.current;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const naturalH = panel.scrollHeight;            // 未受 max-height 限制时的内容高度
    const roomBelow = vh - r.bottom - 12;
    const roomAbove = r.top - 12;
    // 下面装不下、上面更宽裕 → 翻到上面
    const flip = naturalH > roomBelow && roomAbove > roomBelow;
    const room = flip ? roomAbove : roomBelow;
    /* 限高**不许超过可用空间**。原来是 Math.max(110, room)：那个 110px 下限会让面板比
       可用空间更高，多出来的部分被容器直接裁掉 —— 正是 "13 个职业只看得见 1 个" 的根因 ✗ */
    const capped = naturalH > room;
    const maxH = capped ? Math.max(72, Math.round(room)) : null;
    const h = maxH ?? naturalH;
    // 左对齐；`.sel.menu` 那套是右对齐（原来靠 CSS 的 right:0）。再整体夹进窗口
    const menu = el.classList.contains('menu');
    let left = menu ? r.right - pr.width : r.left;
    left = Math.max(8, Math.min(left, vw - 8 - pr.width));
    let top = flip ? r.top - 4 - h : r.bottom + 4;
    top = Math.max(8, Math.min(top, vh - 8 - h));
    setPos({
      left, top, minW: Math.max(r.width, menu ? 168 : 0), maxW: vw - 16, maxH,
      origin: flip ? 'bottom center' : 'top center',
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    measure();
  }, [open, measure]);

  /* 面板开着时跟着触发器走：表格内部滚动 / 窗口缩放都要重新定位，否则面板会脱节 */
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, measure]);

  const curVal = String(value ?? '');
  /* 值不在选项里时的兜底 —— **不能退回第一个选项**：
     比如旧数据 mic='无需作答' 而下拉只留了「有 / 无」，退回第一个就会把
     「无需作答」显示成「有」，用户保存一次就把数据改错了（历史值还可能是被删掉的职业名等）。
     所以：非空值原样显示；空值显示 placeholder 文案（没有就显示空）。 */
  const cur = opts.find((o) => o.value === curVal)
    ?? (curVal ? { value: curVal, label: curVal, disabled: false } : opts[0]);

  return (
    <div ref={box} className={'sel' + (cls ? ' ' + cls : '')} style={style} onClick={onClick}>
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
      {/* 面板 portal 到 body：这样任何滚动容器（.table-wrap / table.grid）都裁不到它。
          坐标、宽度、限高都由 measure() 内联给出；.sel__list--fixed 只负责定位方式与层级。 */}
      {(open || closing) && createPortal(
      <div ref={listRef}
           className={'sel__list sel__list--fixed' + (open ? ' sel__list--in' : ' sel__list--out')}
           style={pos ? {
             left: pos.left, top: pos.top,
             minWidth: pos.minW, maxWidth: pos.maxW,
             maxHeight: pos.maxH ? pos.maxH + 'px' : undefined,
             transformOrigin: pos.origin,
           } : undefined}>
        {(placeholder ? opts.filter((o) => o.value !== '') : opts).map((o) => (
          <button key={o.value} type="button"
                  className={'sel__opt' + (o.value === curVal ? ' on' : '')}
                  disabled={o.disabled || disabled}
                  onClick={() => { onChange?.({ target: { value: o.value } }); close(); }}>
            {o.label}
          </button>
        ))}
      </div>, document.body)}
    </div>
  );
}
