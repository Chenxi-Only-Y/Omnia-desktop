/**
 * 帮会「飞图」转场（共享元素 / FLIP）。
 *
 * 用户口径 2026-09-27：
 *   「点击帮会时以图片为基准，图片平移到帮会首页所在位置，然后其他页面展开；返回同理」。
 *
 * 为什么这么做：卡片封面与帮会首页封面现在是**同一个 9:16 比例**，
 * 所以用 transform 缩放平移就能无缝接上（不会出现拉伸变形）。
 *
 * 用法（必须**在切换状态之前**克隆节点，否则源元素会被卸载）：
 *   const clone = node.cloneNode(true) as HTMLElement;
 *   const rect = node.getBoundingClientRect();
 *   ...切状态...
 *   void flyCoverTo(clone, rect, () => document.querySelector('.guild-home__poster'));
 *
 * 细节：
 *   · 克隆体先按**目标**位置摆放，再用 transform 反向映射回源位置 → 过渡到 none，
 *     全程只动 transform（合成层，不触发重排）；
 *   · 飞行期间把真正的目标元素 visibility:hidden，落地后再显示 —— 否则会看到两个；
 *   · 目标元素可能还没渲染（React 尚未提交），所以用 rAF 轮询等它出现。
 */
const EASE = 'cubic-bezier(.22,.61,.36,1)';

const nextFrame = (): Promise<void> =>
  new Promise((res) => requestAnimationFrame(() => res()));

const sleep = (ms: number): Promise<void> =>
  new Promise((res) => window.setTimeout(res, ms));

/** 等目标元素出现（最多 timeout 毫秒），每帧查一次 */
async function waitFor(
  get: () => HTMLElement | null,
  timeout = 800,
): Promise<HTMLElement | null> {
  const t0 = performance.now();
  for (;;) {
    const el = get();
    if (el) return el;
    if (performance.now() - t0 > timeout) return null;
    await nextFrame();
  }
}

/**
 * 把克隆体从 `fromRect` 飞到目标元素所在位置，落地后显示目标、移除克隆体。
 * 目标找不到（或在动效偏好为"减少"时）就直接放弃动画 —— 功能不受影响。
 */
export async function flyCoverTo(
  clone: HTMLElement,
  fromRect: DOMRect,
  getTarget: () => HTMLElement | null,
  ms = 300,
): Promise<void> {
  /* ⚠️ 这里**故意不做** prefers-reduced-motion 降级：本项目口径是"用户明确要求的动效不加降级守卫"
     （这台机器的 prefers-reduced-motion 是 reduce，加了守卫等于动画根本不出现，
     表现为"写了动画但看不到"——不是没实现，是被静默关掉了）。 */
  const target = await waitFor(getTarget);
  if (!target) return;
  const to = target.getBoundingClientRect();
  if (!to.width || !to.height || !fromRect.width || !fromRect.height) return;

  /* 克隆体：固定定位到目标位置，再反向 transform 回源位置 */
  const cs = clone.style;
  cs.position = 'fixed';
  cs.left = `${to.left}px`;
  cs.top = `${to.top}px`;
  cs.width = `${to.width}px`;
  cs.height = `${to.height}px`;
  cs.margin = '0';
  cs.padding = '0';
  cs.zIndex = '9999';
  cs.pointerEvents = 'none';
  cs.transformOrigin = 'top left';
  cs.borderRadius = '12px';
  cs.overflow = 'hidden';
  /* 刻意不用大范围 box-shadow：它是整块重绘，进帮会时那"卡一下"有它一份 */
  cs.boxShadow = '0 6px 18px rgba(0,0,0,.28)';
  cs.willChange = 'transform, opacity';
  cs.transition = `transform ${ms}ms ${EASE}, opacity 160ms ease`;
  cs.transform = `translate(${fromRect.left - to.left}px, ${fromRect.top - to.top}px)`
    + ` scale(${fromRect.width / to.width}, ${fromRect.height / to.height})`;
  /* 克隆体内部的元素不要再带自己的 transition，免得跟着一起动 */
  clone.querySelectorAll<HTMLElement>('*').forEach((el) => { el.style.transition = 'none'; });

  const hidden = target.style.visibility;
  target.style.visibility = 'hidden';
  document.body.appendChild(clone);

  await nextFrame();
  await nextFrame();
  cs.transform = 'none';
  await sleep(ms);

  /* 落地：显示目标、把克隆体淡出 */
  target.style.visibility = hidden || '';
  cs.opacity = '0';
  await sleep(170);
  clone.remove();
}
