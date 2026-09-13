/**
 * 把 xlsx 网格转成 TSV。
 *
 * 这样就能复用已有的两套解析/校验：
 *   - 成员主档：lib/importer.ts 的 parseTableText（中文列名映射到此已实现）
 *   - 战报：shared/statImport.ts 的 buildPreview（复合列、四类校验）
 * 避免为 xlsx 再写一份列映射。
 */

/** 单元格里的制表/换行会破坏 TSV 结构，转成空格 */
function sanitize(v: string): string {
  return (v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

export function gridToTsv(headers: string[], rows: { cells: string[] }[]): string {
  // 空列名必须原样保留（不能删列也不能替换成占位符）：
  // 旧表有"无标题但存数据"的列（如信息数据库的主职业列），
  // 解析侧靠列位置兜底识别它；一旦位置错位就会整列失配。
  const head = headers.map((h) => sanitize(h)).join('\t');
  const body = rows
    .map((r) => r.cells.map(sanitize).join('\t'))
    // 整行空白的数据行丢掉（旧表里大量空行）
    .filter((line) => line.replace(/\t/g, '').trim() !== '');
  return [head, ...body].join('\n');
}

/** 预览用：网格是否为"空行" */
export function isEmptyRow(cells: string[]): boolean {
  return cells.every((c) => (c ?? '').trim() === '');
}
