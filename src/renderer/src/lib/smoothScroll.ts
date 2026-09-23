/**
 * 滚轮平滑（惯性 lerp）。两处用途：
 *   ① 下拉列表内部：.sel__list / .dp__pop 选项多时，上下滚动要丝滑；
 *   ② 页面主体：其余情况下的页面滚动也丝滑（用户口径：所有页面都要）。
 *
 * 做法一致：拦下 wheel，把目标位置记在 target 上，再用 rAF 逐帧逼近
 *     el.scrollTop += (target - el.scrollTop) * 0.18
 * 这是"滚轮驱动的平滑"，不虚拟滚动、不改 DOM、不改布局。
 *
 * 边界
 *   · 只接管滚轮；键盘 / 滚动条拖动 / 触摸板 pinch 保持原生；
 *   · 内容不够滚时不接管（避免无意义拦截）；
 *   · 下拉列表命中时 **stopPropagation**，免得列表滚到底还连带滚页面；
 *   · 首屏吸附过渡区让位给 OverviewPage 的吸附 handler（两边同时改 scrollTop 会打架，
 *     之前的"抖动"就是这类问题）。
 */

const state = new WeakMap<HTMLElement, { target: number; raf: number }>();

function glide(el: HTMLElement, delta: number): void {
  const max = el.scrollHeight - el.clientHeight;
  let st = state.get(el);
  if (!st) {
    st = { target: el.scrollTop, raf: 0 };
    state.set(el, st);
  }
  st.target = Math.max(0, Math.min(max, st.target + delta));
  if (st.raf) return;
  const step = (): void => {
    const cur = state.get(el);
    if (!cur) return;
    const diff = cur.target - el.scrollTop;
    if (Math.abs(diff) < 0.6) {
      el.scrollTop = cur.target;
      cur.raf = 0;
      return;
    }
    el.scrollTop += diff * 0.18;
    cur.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}

let bound = false;

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey) return;
  const el = e.target as HTMLElement | null;
  // ① 下拉 / 日期弹层内部：优先接管，且不让事件冒泡去滚页面
  const inner = el && el.closest ? (el.closest('.sel__list, .dp__pop') as HTMLElement | null) : null;
  if (inner && inner.scrollHeight > inner.clientHeight + 2) {
    e.preventDefault();
    e.stopPropagation();
    glide(inner, e.deltaY);
    return;
  }
  // ② 页面主体：**不接管**（用户口径：全站页面滚动不要平滑，改回原生）。
  //    只保留上面那段"下拉/日期弹层内部"的平滑。
  //    pickScroller / inHomeSnapZone 保留给将来需要时用，这里不再调用。
}

export function installSmoothScroll(): void {
  if (bound) return;
  bound = true;
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
}
