import { api } from '../api';

/**
 * 全局壁纸层：body 下挂一个 position:fixed 的容器（.home-wallpaper），
 * 静态图走容器背景，动态视频用里面的 <video>。
 *
 * 「切页/下滑不重置」两条保障：
 *  1) 容器挂在 body 上、position:fixed → 永远在可视区、不随滚动移动；
 *  2) <video> 节点**只创建一次**、之后只改 src 不重建 → currentTime 连续。
 */
let installed = false;
let host: HTMLDivElement | null = null;
let video: HTMLVideoElement | null = null;
let lastTime = 0;
let current = '';

function apply(kind: string, file: string) {
  if (!host) return;
  const next = kind + '|' + file;
  if (next === current) return;          // 同一张：什么都不动，绝不打断播放
  // 路径转 URL：按 / 或 \ 切开再用 / 拼。
  // 原来是 file.replace(/\\\\/g, '/') —— 那个正则匹配的是「两个反斜杠」，
  // 单个反斜杠永远换不掉，生成 file:///C:WindowsWeb... 这种非法 URL，
  // 图永远加载不出来（CDP 实测确认，见诊断【5】）。
  const norm = String(file ?? '').split(/[\\\/]+/).filter(Boolean).join('/');
  const url = norm ? 'file:///' + norm : '';
  if (kind === 'video' && url) {
    // 记住当前播放进度，换源后接着播（保证「不重置」）
    const t = video && video.src === url ? video.currentTime : lastTime;
    if (!video) {
      video = document.createElement('video');
      video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
      host.appendChild(video);
    }
    video.style.display = '';
    if (video.src !== url) {
      video.onloadedmetadata = () => { try { video!.currentTime = t; void video!.play(); } catch { /* 自动播放策略 */ } };
      video.src = url;
    } else if (video.paused) { void video.play().catch(() => {}); }
  } else if (video) {
    lastTime = video.currentTime;      // 记住进度，之后切回来还接着放
    video.pause();
    video.style.display = 'none';
  }
  host.style.setProperty('--wall', url ? `url("${url}")` : 'none');
  host.classList.toggle('home-wallpaper--on', !!url);
  // 双保险：静态图直接铺到 body 背景上（body 背景绘制在 z-index:-1 的容器之上，
  // 不会被任何东西盖住）；动态视频仍走容器内的 <video>，body 保持透明。
  const isVideo = kind === 'video' && !!url;
  // 有 url 就铺：视频当 CSS 背景会加载失败，正好露出渐变兜底（绝不纯黑）
  const image = url ? `url("${url}")` : 'none';
  // 内联样式优先级最高：逐个元素写死，任何 CSS 规则都压不过它
  const targets: HTMLElement[] = [document.documentElement, document.body,
    ...Array.from(document.querySelectorAll<HTMLElement>('.app, .content, .main'))];
  for (const t of targets) {
    const st = t.style;
    st.setProperty('background-image', image, 'important');
    st.setProperty('background-size', 'cover', 'important');
    st.setProperty('background-position', 'center', 'important');
    st.setProperty('background-repeat', 'no-repeat', 'important');
    st.setProperty('background-attachment', 'fixed', 'important');
  }
  // 给后续动态插入的容器也带上（React 重建 .content 时不会丢）
  document.documentElement.style.setProperty('--wallpaper-image', image);
  void isVideo;
  // 同一变量铺到 :root，CSS 会给 html / body / .app / .content 都铺上这层
  document.documentElement.style.setProperty('--wallpaper-image',
    !isVideo && url ? `url("${url}")` : 'none');
  // 加载自检：file:// 受限或文件不在时，把原因送出去（不再静默）
  if (url) {
    const probe = new Image();
    probe.onerror = () => {
      // 清掉内联写法即可 —— CSS 的 .home-wallpaper 上还有一层渐变兜底，不会纯黑
      for (const t of [document.documentElement, document.body]) {
        t.style.removeProperty('background-image');
      }
      document.documentElement.style.setProperty('--wallpaper-image', 'none');
      window.dispatchEvent(new CustomEvent('omnia:wallpaper-error', {
        detail: '图片加载失败（file:// 受限或文件不存在）：' + (url || '(空)'),
      }));
    };
    probe.src = url;
  }
  current = next;
}

export function installWallpaper(): void {
  if (installed) return;
  installed = true;
  const boot = () => {
    host = document.createElement('div');
    host.className = 'home-wallpaper';
    document.body.appendChild(host);
    video = document.createElement('video');
    video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
    video.style.display = 'none';
    host.appendChild(video);
    void api.meta.settings().then((s) => {
      apply((s as Record<string, unknown>).wallpaperKind === 'video' ? 'video' : 'image',
        String((s as Record<string, unknown>).wallpaperImage ?? ''));
    }).catch(() => { /* 没设置就用默认渐变 */ });
  };
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
  // 设置页改壁纸后广播过来（同一个 video 节点只换 src）
  window.addEventListener('omnia:wallpaper', (e) => {
    const d = (e as CustomEvent<{ kind: string; file: string }>).detail;
    if (d) apply(d.kind, d.file);
  });
}

installWallpaper();
