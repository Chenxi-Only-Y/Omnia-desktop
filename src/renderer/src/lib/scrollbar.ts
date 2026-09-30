/**
 * 自绘滚动条浮层
 *
 * 为什么需要它（用户口径）：「把滑块拉到导航栏上部」。
 * 原生滚动条属于它的滚动容器，而本项目的滚动容器是 `.content` ——
 * 顶部导航栏占 52px 布局高度，`.content` 只能从 y=52 开始，
 * 所以**原生滑块永远画不到**窗口最顶那一段（滚动条不能超出所属容器的盒子）。
 *
 * 做法：隐藏原生滚动条，在 body 上挂一条 `position: fixed` 的轨道
 * （覆盖整个窗口高度，含导航栏那条），滑块位置按滚动比例换算。
 *
 * ⚠️ 性能（第一版卡顿的根因，务必别再犯）：
 *   第一版在 `requestAnimationFrame` 里**每帧读** scrollHeight / clientHeight /
 *   getBoundingClientRect —— 这些都会强制同步布局（layout thrashing），
 *   滚动时每帧一次必然卡。现在改为：
 *     · 几何只在"内容或尺寸变了"时**量一次**并缓存（measure()）；
 *     · 滚动/拖动期间只写 `transform`，**零布局读取**；
 *     · 不用 setInterval 轮询（改成 ResizeObserver + MutationObserver 按需刷新）；
 *     · 不听 transitionend（首屏渐变在呼吸，会不停触发）。
 */
const INSET = 2;           // 轨道上下内缩
const MIN_THUMB = 28;      // 滑块最小高度，内容极长时也还能抓住

let installed = false;
let track: HTMLDivElement | null = null;
let thumb: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let raf = 0;

/** 缓存的几何：只在 measure() 里更新 */
const geo = {
  clientH: 0,
  scrollH: 0,
  maxScroll: 0,
  trackH: 0,
  thumbH: 0,
  maxTop: 0,
  valid: false,
};

function pickTarget(): HTMLElement | null {
  const c = document.querySelector<HTMLElement>('.content');
  if (c && c.scrollHeight > c.clientHeight + 1) return c;
  const de = document.scrollingElement as HTMLElement | null;
  if (de && de.scrollHeight > de.clientHeight + 1) return de;
  return c ?? null;
}

/** 只在需要时调用：量一次几何并缓存（这是唯一会触发布局的地方） */
function measure(): void {
  if (!track || !thumb) return;
  if (!target || !target.isConnected) bind(pickTarget());
  if (!target) { track.style.opacity = '0'; geo.valid = false; return; }

  const clientH = target.clientHeight;
  const scrollH = target.scrollHeight;
  const maxScroll = scrollH - clientH;
  if (maxScroll <= 1) { track.style.opacity = '0'; geo.valid = false; return; }
  track.style.opacity = '1';

  const trackH = window.innerHeight - INSET * 2;
  const thumbH = Math.max(MIN_THUMB, Math.round(trackH * (clientH / scrollH)));
  geo.clientH = clientH;
  geo.scrollH = scrollH;
  geo.maxScroll = maxScroll;
  geo.trackH = trackH;
  geo.thumbH = thumbH;
  geo.maxTop = Math.max(0, trackH - thumbH);
  geo.valid = true;

  thumb.style.height = thumbH + 'px';
  paint();
}

/** 只写 transform —— 不读任何布局属性 */
function paint(): void {
  if (!thumb || !target || !geo.valid) return;
  const pos = geo.maxScroll > 0 ? target.scrollTop / geo.maxScroll : 0;
  thumb.style.transform = `translateY(${Math.round(geo.maxTop * pos)}px)`;
}

function scheduleMeasure(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; measure(); });
}

function bind(el: HTMLElement | null): void {
  if (!el || el === target) return;
  target?.removeEventListener('scroll', paint);
  target = el;
  // 滚动只重绘滑块位置，不重量几何
  target.addEventListener('scroll', paint, { passive: true });
  scheduleMeasure();
}

export function installScrollbar(): void {
  if (installed) return;
  installed = true;

  const boot = () => {
    track = document.createElement('div');
    track.className = 'sb-track';
    thumb = document.createElement('div');
    thumb.className = 'sb-thumb';
    track.appendChild(thumb);
    document.body.appendChild(track);

    let dragging = false;
    let startY = 0;
    let startScroll = 0;

    thumb.addEventListener('pointerdown', (ev) => {
      if (!target) return;
      // 拖动开始前量一次，之后整个拖动过程都不再读布局
      measure();
      if (!geo.valid) return;
      dragging = true;
      startY = ev.clientY;
      startScroll = target.scrollTop;
      thumb!.setPointerCapture(ev.pointerId);
      document.body.classList.add('sb-dragging');
      ev.preventDefault();
    });
    thumb.addEventListener('pointermove', (ev) => {
      if (!dragging || !target || !geo.valid || geo.maxTop <= 0) return;
      const delta = (ev.clientY - startY) * (geo.maxScroll / geo.maxTop);
      target.scrollTop = startScroll + delta;   // 写滚动位置（不读布局）
      paint();
    });
    const end = (ev: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { thumb!.releasePointerCapture(ev.pointerId); } catch { /* 已释放 */ }
      document.body.classList.remove('sb-dragging');
      paint();
    };
    thumb.addEventListener('pointerup', end);
    thumb.addEventListener('pointercancel', end);

    // 点轨道空白：翻页（原生行为）
    track.addEventListener('pointerdown', (ev) => {
      if (ev.target === thumb || !target || !geo.valid || !thumb) return;
      // 滑块中心的视口 y：轨道顶(INSET) + 当前位移 + 半高。
      // 位移从已写入的 transform 里取（不读布局，避免又变成每帧强制布局）。
      const m = /translateY\((-?[\d.]+)px\)/.exec(thumb.style.transform || '');
      const offsetY = m ? Number(m[1]) : 0;
      const thumbCenter = INSET + offsetY + geo.thumbH / 2;
      const forward = ev.clientY > thumbCenter;
      target.scrollTop += (forward ? 1 : -1) * geo.clientH * 0.9;
      ev.preventDefault();
      paint();
    });

    bind(pickTarget());
    window.addEventListener('resize', scheduleMeasure);

    /* 内容高度会变（切页、数据刷新、行展开）→ 按需重量几何。
       ⚠️ 不监听整棵 DOM 树：React 每次渲染都会产生大量 mutation，
          对整树做 subtree 观察会让"量几何"变成高频操作（第一版卡顿的来源之一）。
       这里只观察 .content 的**直接子节点**（切页 = 换子节点），并且加防抖 ——
       页面内部的数据刷新由下面的低频校验兜底。 */
    let pendingTimer = 0;
    const debounced = () => {
      window.clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(scheduleMeasure, 150);
    };
    const mo = new MutationObserver(debounced);
    const startObserving = () => {
      const c = document.querySelector('.content');
      if (c) mo.observe(c, { childList: true });   // 不递归：只抓"换页"
    };
    startObserving();
    // 换页时 .content 本身不会重建，所以子节点变化即可被上面抓到；
    // 另用 ResizeObserver 兜住"同一页内容变高/变矮"（如表格行变化）。
    const ro = new ResizeObserver(debounced);
    ro.observe(document.body);
    const roContent = new ResizeObserver(debounced);
    const attachContentRo = () => {
      const c = document.querySelector('.content');
      if (c) roContent.observe(c);
    };
    attachContentRo();
    // 低频兜底：万一上面两条都没覆盖到（例如目标容器被替换），1.5s 校一次，代价可忽略
    window.setInterval(() => {
      if (!target || !target.isConnected) { bind(pickTarget()); startObserving(); attachContentRo(); }
      scheduleMeasure();
    }, 1500);
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
}
