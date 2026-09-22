import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * 自绘日期选择器。
 *
 * 为什么要自写：原生 <input type="date"> 的日历弹层由**浏览器/系统绘制**，
 * 和 <option> 一样无法用 CSS 改（用户截图里那套蓝色高亮改不掉）。
 *
 * API 与原生对齐：value(YYYY-MM-DD) / onChange({target:{value}}) / className / style / title，
 * 所以调用点把 <input type="date"> 换成 <DatePicker> 即可，onChange 一行不用改。
 * 内部保留一个隐藏的原生 date 输入，兼容「set value + dispatch change」的调用方。
 */

const WD = ['一', '二', '三', '四', '五', '六', '日'];
const pad = (n: number) => String(n).padStart(2, '0');
const toStr = (y: number, m: number, d: number) => y + '-' + pad(m + 1) + '-' + pad(d);

export default function DatePicker({
  value, onChange, className, style, title,
}: {
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  // 与 Select 同理：过滤掉 input / select 这类**原生控件类名**，
  // 否则外层 <div> 会拿到 .input 的底色+描边，和里面的 .dp__btn 形成双框（用户截图）。
  const cls = String(className ?? '')
    .split(/\s+/)
    .filter((c) => c && c !== 'input' && c !== 'select')
    .join(' ');
  const v = String(value ?? '');
  const [open, setOpen] = useState(false);
  const [ym, setYm] = useState(() => {
    const m = /^(\d{4})-(\d{2})/.exec(v);
    const now = new Date();
    return m ? { y: Number(m[1]), mo: Number(m[2]) - 1 } : { y: now.getFullYear(), mo: now.getMonth() };
  });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const lead = (new Date(ym.y, ym.mo, 1).getDay() + 6) % 7;   // 周一为第一列
  const days = new Date(ym.y, ym.mo + 1, 0).getDate();
  const prevDays = new Date(ym.y, ym.mo, 0).getDate();
  const cells: { d: number; cur: boolean; str: string }[] = [];
  for (let i = lead - 1; i >= 0; i -= 1) cells.push({ d: prevDays - i, cur: false, str: '' });
  for (let d = 1; d <= days; d += 1) cells.push({ d, cur: true, str: toStr(ym.y, ym.mo, d) });
  let nx = 1;
  while (cells.length % 7 !== 0) { cells.push({ d: nx, cur: false, str: '' }); nx += 1; }

  const shift = (n: number) => setYm((s) => {
    const d = new Date(s.y, s.mo + n, 1);
    return { y: d.getFullYear(), mo: d.getMonth() };
  });
  const pick = (s: string) => { onChange?.({ target: { value: s } }); setOpen(false); };
  const now = new Date();
  const todayStr = toStr(now.getFullYear(), now.getMonth(), now.getDate());

  return (
    <div className={'dp' + (cls ? ' ' + cls : '')} style={style} ref={box}>
      <button type="button" className="dp__btn" title={title} onClick={() => setOpen((o) => !o)}>
        <span className="dp__txt">{v ? v.replace(/-/g, '/') : '选择日期'}</span>
      </button>
      <input className="dp__native" type="date" value={v} tabIndex={-1} aria-hidden
             onChange={(e) => onChange?.({ target: { value: e.target.value } })} />
      {open && (
        <div className="dp__pop">
          <div className="dp__head">
            <span className="dp__month">{ym.y}年{pad(ym.mo + 1)}月</span>
            <span className="dp__sp" />
            <button type="button" className="dp__nav" title="上个月" onClick={() => shift(-1)}>&uarr;</button>
            <button type="button" className="dp__nav" title="下个月" onClick={() => shift(1)}>&darr;</button>
          </div>
          <div className="dp__wd">{WD.map((w) => <span key={w}>{w}</span>)}</div>
          <div className="dp__grid">
            {cells.map((c, i) => (
              <button key={i} type="button" disabled={!c.cur}
                      className={'dp__d' + (c.cur ? '' : ' dp__d--out')
                        + (c.cur && c.str === v ? ' on' : '')
                        + (c.cur && c.str === todayStr ? ' today' : '')}
                      onClick={() => pick(c.str)}>{c.d}</button>
            ))}
          </div>
          <div className="dp__foot">
            <button type="button" className="dp__lnk"
                    onClick={() => { onChange?.({ target: { value: '' } }); setOpen(false); }}>清除</button>
            <button type="button" className="dp__lnk" onClick={() => pick(todayStr)}>今天</button>
          </div>
        </div>
      )}
    </div>
  );
}
