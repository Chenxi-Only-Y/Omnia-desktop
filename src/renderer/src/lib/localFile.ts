/**
 * 本地文件 → 可加载 URL。
 *
 * 为什么不用 `file://`：
 * `npm run dev` 时页面来源是 `http://127.0.0.1:5173`，而 Chromium **禁止 http 源
 * 读取 file:// 资源**——这是安全模型，**CSP 放不开**。实测对照：
 *
 *   http 源 + img-src 加 file:   → 仍然 BLOCKED
 *   file 源 + 同一张图           → PASS（所以打包形态看着正常，开发形态全空）
 *
 * 于是壁纸预览、缩略图、全局壁纸层在开发模式下集体失效，而 `npm run smoke` 跑的是
 * 打包产物（file 源）却是绿的 —— 这就是「自检通过、开发里壁纸库打不开」的根因。
 *
 * 统一走主进程注册的 `omnia://` 特权协议（见 main.ts 的 registerLocalProtocol）：
 * 该协议在 http / file 两种来源下都能加载，且**仍受 CSP 管控**
 * （index.html 的 img-src / media-src 里显式放行了 `omnia:`）。
 *
 * ⚠️ 反斜杠必须先归一：`omnia://local/D:\a\b.jpg` 里的反斜杠不构成路径分隔，
 * 主进程解析出的 pathname 会带上整串，从而 403。按 / 或 \ 切开再拼。
 */
export const LOCAL_SCHEME = 'omnia';

/** 绝对路径 → `omnia://local/…`；空输入返回空串（调用方用它判空） */
export function localUrl(absPath: string | null | undefined): string {
  const norm = String(absPath ?? '').split(/[\\/]+/).filter(Boolean).join('/');
  return norm ? `${LOCAL_SCHEME}://local/${norm}` : '';
}
