/**
 * 渲染层的 window.omnia 类型声明。
 *
 * ⚠️ 这里**只声明"窗口上挂着什么"**，方法签名一律复用 `@shared/types` 的 `OmniaApi`。
 * 历史教训：这个文件曾经手抄了一份 82 行的完整接口，于是契约变成三份
 * （types.ts 的 OmniaApi / preload.ts 的实现 / 这里的手写副本），
 * 结果手抄副本悄悄漂移 —— 引用了 4 个根本没 import 的类型（listWallpapers 等方法的
 * 返回类型退化成 any），而 tsconfig 的 skipLibCheck 让类型检查完全看不见。
 *
 * 现在：改契约只改 types.ts 的 OmniaApi（preload 用 satisfies 兜住实现），
 * 渲染层这边自动跟着走。
 */
import type { OmniaApi } from '@shared/types';

declare global {
  interface Window {
    /** 预加载脚本注入的桥（见 src/preload/preload.ts） */
    omnia: OmniaApi;
  }
}
