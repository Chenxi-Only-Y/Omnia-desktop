/**
 * 成员名单 CSV/TSV 的解析与导出。
 *
 * 实现已移到 `@shared/tableText`（主进程与渲染层共用同一份列名映射），
 * 这里只做转发，保持既有引用不变。
 */
export { parseTableText, toCsv } from '@shared/tableText';
