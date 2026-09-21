/**
 * 报名表（WPS/腾讯表单导出的 xlsx）解析
 *
 * 样本格式（「霜序客联赛报名（收集结果）」，表头在第 1 行）：
 *   0 提交时间（自动）  1 角色id（必填）  2 参加/请假（必填）
 *   3 有无麦克风（必填）  4 主职业(能打联赛)（必填）  5 副职(能打联赛)  6 提交者（自动）
 *
 * 列的位置**按表头名字识别**而不是写死下标：表单工具换个版本、多一列
 * 「提交者」的顺序变化都不至于直接读错列。
 */
import type { SignupImportPreview, SignupImportRow } from './types';

/** 表头关键词 → 内部字段 */
const COLUMN_MATCHERS: { field: keyof Omit<SignupImportRow, 'line' | 'note'>; re: RegExp }[] = [
  { field: 'gameId', re: /角色\s*id|角色ID|游戏\s*id|ID名/i },
  { field: 'status', re: /参加\s*\/\s*请假|参加|请假/ },
  { field: 'mic', re: /麦克风/i },
  { field: 'subClass', re: /副职|副职业/ },   // 必须先于主职业判断
  { field: 'mainClass', re: /主职业|主职/ },
  { field: 'submittedAt', re: /提交时间|时间/ },
];

function findHeaderRow(grid: string[][]): number {
  for (let i = 0; i < Math.min(grid.length, 10); i += 1) {
    const joined = (grid[i] ?? []).join('|');
    if (/参加|请假/.test(joined) && /(角色\s*id|ID名)/i.test(joined)) return i;
  }
  return -1;
}

function mapColumns(header: string[]): Partial<Record<string, number>> {
  const map: Partial<Record<string, number>> = {};
  header.forEach((raw, idx) => {
    const h = String(raw ?? '').trim();
    if (!h) return;
    for (const m of COLUMN_MATCHERS) {
      if (map[m.field] !== undefined) continue;
      if (m.re.test(h)) { map[m.field] = idx; return; }
    }
  });
  return map;
}

/**
 * 解析报名表网格，产出预览。
 * 重复报名（同一 角色id 出现多次）按用户口径**不自动取舍，直接标出来让用户处理**。
 */
export function parseSignupGrid(grid: string[][]): SignupImportPreview {
  const headerRow = findHeaderRow(grid);
  if (headerRow < 0) {
    return {
      rows: [], duplicates: [], invalid: [{ line: 0, reason: '没找到表头（需要包含「角色id」与「参加/请假」两列）' }],
      unmatched: [], headers: [], headerRow: -1,
    };
  }
  const headers = (grid[headerRow] ?? []).map((h) => String(h ?? '').trim());
  const col = mapColumns(headers);

  for (const need of ['gameId', 'status'] as const) {
    if (col[need] === undefined) {
      return {
        rows: [], duplicates: [], headers, headerRow,
        invalid: [{ line: headerRow + 1, reason: `表头缺少必要列：${need === 'gameId' ? '角色id' : '参加/请假'}` }],
        unmatched: [],
      };
    }
  }

  const rows: SignupImportRow[] = [];
  const invalid: { line: number; reason: string }[] = [];
  const seen = new Map<string, number[]>();

  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const r = grid[i] ?? [];
    const get = (f: string) => {
      const c = col[f];
      return c === undefined ? '' : String(r[c] ?? '').trim();
    };
    const gameId = get('gameId');
    const statusRaw = get('status');
    if (!gameId && !statusRaw) continue;          // 完全空白行：跳过
    const line = i + 1;
    if (!gameId) { invalid.push({ line, reason: '角色id 为空' }); continue; }
    if (!statusRaw) { invalid.push({ line, reason: `${gameId}：参加/请假 为空` }); continue; }

    const isJoin = /参加|是|Y|JOIN/i.test(statusRaw);
    const isLeave = /请假|否|N|LEAVE/i.test(statusRaw);
    if (!isJoin && !isLeave) {
      invalid.push({ line, reason: `${gameId}：参加/请假 的值无法识别（${statusRaw}）` });
      continue;
    }
    const status = isJoin ? 'JOIN' : 'LEAVE';
    const micRaw = get('mic');
    // 请假行按表单约定不填职业与麦克风；这里不判为错误，只保证为空
    rows.push({
      line,
      gameId,
      status,
      mic: status === 'LEAVE' ? '' : (/有/.test(micRaw) ? '有' : (/无/.test(micRaw) ? '无' : micRaw)),
      mainClass: status === 'LEAVE' ? '' : get('mainClass'),
      subClass: status === 'LEAVE' ? '' : get('subClass'),
      submittedAt: get('submittedAt'),
    });
    const arr = seen.get(gameId) ?? [];
    arr.push(line);
    seen.set(gameId, arr);
  }

  const duplicates = [...seen.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([gameId, lines]) => ({ gameId, lines }));

  return { rows, duplicates, invalid, unmatched: [], headers, headerRow };
}
