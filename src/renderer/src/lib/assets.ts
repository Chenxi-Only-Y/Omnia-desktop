/**
 * 资源路径辅助。
 *
 * 打包后页面通过 file:// 加载，图标位于 dist/renderer/class-icons/，
 * 与 index.html 同级；这里统一用 BASE_URL 拼接，避免相对路径在不同层级下失效。
 */
import { classIconUrl } from '@shared/domain';

/** 职业图标在页面里的可直接使用地址；该职业没有素材时返回 null */
export function classIconSrc(name: string | null | undefined): string | null {
  const rel = classIconUrl(name);
  if (!rel) return null;
  const base = import.meta.env.BASE_URL || './';
  return `${base}${rel.replace(/^\.\//, '')}`;
}
