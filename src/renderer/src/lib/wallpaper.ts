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
// 渲染模式：dynamic=动态 / static=静态帧 / off=关闭壁纸；适应方式决定 background-size
let mode: string = 'dynamic';
let fit: string = 'cover';

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
  if (kind === 'video' && url && mode === 'dynamic') {
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
      // 解码自检：能读元数据 ≠ 能解画面（HEVC 读得到 metadata 但解不出帧）。
      // 解不出来就把 <video> 藏掉，露出下面的 preview 动图 —— 否则黑画面会盖住预览。
      video.onloadeddata = () => {
        // videoWidth 来自容器元数据（HEVC 没解码器也读得到），不能用它判断。
        // requestVideoFrameCallback 只在**真解出一帧**时才回调；2.5 秒没出帧 = 解不了。
        let gotFrame = false;
        try { video!.requestVideoFrameCallback(() => { gotFrame = true; }); } catch { gotFrame = true; }
        setTimeout(() => {
          if (gotFrame) return;
          video!.style.display = 'none';
          window.dispatchEvent(new CustomEvent('omnia:wallpaper-error', {
            detail: '该视频解不出帧（HEVC/H.265 本机无解码器），正在转码为 H.264…',
          }));
          void (async () => {
            try {
              const out = await api.player.wallpaperTranscode();
              video!.src = 'file:///' + out.replace(/[\\/]+/g, '/');
              video!.style.display = '';
              video!.onloadeddata = null;
              video!.onerror = null;
              void video!.play();
              window.dispatchEvent(new CustomEvent('omnia:wallpaper-error', {
                detail: '转码完成，已用 H.264 播放（已缓存，下次秒开）',
              }));
            } catch (err) {
              window.dispatchEvent(new CustomEvent('omnia:wallpaper-error', {
                detail: '转码失败，保持预览动图：' + String(err).slice(0, 80),
              }));
            }
          })();
        }, 2500);
      };
      video.onerror = () => {
        video!.style.display = 'none';
        window.dispatchEvent(new CustomEvent('omnia:wallpaper-error', {
          detail: '视频加载失败，已改用预览动图：' + url.split('/').pop(),
        }));
      };
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
  // 动态壁纸（.mp4 等）当 CSS 背景必然加载失败 → 改用同目录 preview 图当背景：
  // WE 创意工坊每个作品都带 preview.jpg/gif，实测能正常加载（诊断：18 张缩略图全 complete）。
  // <video> 仍叠在上面播：能解码就动起来，解不了也至少是张图，绝不再是黑。
  // 动态壁纸：背景用同目录 preview 的**多层兜底**（gif 是动图 → 不解码视频也能动）：
  //   url(preview.gif)  ← 动图，能加载就显示它（保证「动态」）
  //   url(preview.jpg)  ← gif 没有就用 jpg（保证「不黑」）
  //   url(preview.png)  ← 再兜一层
  //   + CSS 里的渐变兜底（最后一层）
  // 加载成功的层会盖住下面的，失败的层不绘制 —— 缺哪个都不黑。
  let bgLayers = url ? 'url("' + url + '")' : '';
  if (isVideo && url) {
    const dir = url.slice(0, url.lastIndexOf('/'));
    bgLayers = ['preview.gif', 'preview.jpg', 'preview.png']
      .map(nm => 'url("file:///' + dir + '/' + nm + '")').join(', ');
  }
  // 渲染模式：关闭壁纸 → 全清；静态帧 → 只用静态图（gif 换成 jpg、视频不播）
  let image = bgLayers || 'none';
  if (mode === 'off') { image = 'none'; }
  else if (mode === 'static' && isVideo && url) {
    const dir = url.slice(0, url.lastIndexOf('/'));
    image = ['preview.jpg', 'preview.png'].map(nm => 'url("file:///' + dir + '/' + nm + '")').join(', ');
  }
  // 内联样式优先级最高：逐个元素写死，任何 CSS 规则都压不过它
  const targets: HTMLElement[] = [document.documentElement, document.body,
    ...Array.from(document.querySelectorAll<HTMLElement>('.app, .content, .main'))];
  for (const t of targets) {
    const st = t.style;
    st.setProperty('background-image', image, 'important');
    st.setProperty('background-size', fit, 'important');
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
  if (url && !isVideo) {
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
  if (url && isVideo) {
    // 视频用 <video> 探测：能读到 duration 就算加载成功（<img> 加载 mp4 必然失败）
    const vprobe = document.createElement('video');
    vprobe.preload = 'metadata';
    vprobe.onloadedmetadata = () => {
      window.dispatchEvent(new CustomEvent('omnia:wallpaper-error', {
        detail: '动态壁纸已就绪：' + url.split('/').pop(),
      }));
    };
    vprobe.onerror = () => {
      for (const t of [document.documentElement, document.body]) t.style.removeProperty('background-image');
      window.dispatchEvent(new CustomEvent('omnia:wallpaper-error', {
        detail: '视频加载失败（编解码或文件不存在）：' + url,
      }));
    };
    vprobe.src = url;
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
  // 渲染模式 / 适应方式改动后用记住的那张壁纸重新应用
  window.addEventListener('omnia:wallpaper-mode', (e) => {
    mode = (e as CustomEvent<string>).detail || 'dynamic';
    const [k, f] = current.split('|');
    current = '';
    if (f) apply(k || 'image', f);
  });
  window.addEventListener('omnia:wallpaper-fit', (e) => {
    fit = (e as CustomEvent<string>).detail || 'cover';
    const [k, f] = current.split('|');
    current = '';
    if (f) apply(k || 'image', f);
  });
}

installWallpaper();
