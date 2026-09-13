/**
 * 表格文本解析 / 序列化（纯函数，双端共用）
 *
 * 从渲染层 lib/importer.ts 提到 shared：主进程的自检也要用同一套列名映射，
 * 避免"界面能导、自检用另一份逻辑"的偏差。
 *
 * 旧表列名映射依据逆向识别结果：
 *   信息数据库 A5:AC91 → 入帮排序 / 角色ID / 填表 / 出战 / 麦 / 备注 / 需校准ID / 总分 / 各场评分
 * 这里只取与成员主档相关的列。
 */
import type { PlayerInput } from './types';

type RawRow = Record<string, string>;

/** 分隔符探测：优先 Tab（Excel 直接粘贴），其次逗号，最后分号 */
function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts: [string, number][] = [
    ['\t', (head.match(/\t/g) ?? []).length],
    [',', (head.match(/,/g) ?? []).length],
    [';', (head.match(/;/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : '\t';
}

/** 处理带引号的 CSV 字段 */
function splitLine(line: string, delim: string): string[] {
  if (delim === '\t') return line.split('\t');
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuote = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// 列名 → 标准字段。键统一去空格后匹配。
const HEADER_MAP: Record<string, keyof PlayerInput> = {
  '角色id': 'gameId', '角色ID': 'gameId', 'gameid': 'gameId', 'id': 'gameId', '游戏id': 'gameId',
  '玩家名字': 'name', '名字': 'name', '昵称': 'name', 'name': 'name', '显示名': 'name',
  '入帮排序': 'joinedOrder', '入帮序': 'joinedOrder', '排序': 'joinedOrder', 'joinedorder': 'joinedOrder',
  '麦': 'mic', '麦克风': 'mic', '有无麦克风（必填）': 'mic', '有无麦克风': 'mic', 'mic': 'mic',
  '备注': 'remark', '备注(角色)': 'noteRole', 'remark': 'remark',
  '主职业': 'mainClass', '主职业(能打联赛)（必填）': 'mainClass', '主职业(能打联赛)': 'mainClass',
  '职业': 'mainClass', 'mainclass': 'mainClass',
  '副职': 'subClass', '副职(能打联赛)': 'subClass', 'subclass': 'subClass',
  '状态': 'status', 'status': 'status',
};

const NOTE_ROLES = ['指挥', '统战', 'K龙', '替补指挥', '长期请假'];

function normHeader(h: string): string {
  return h.replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '').trim();
}

/**
 * 旧表里有些列**没有列标题**（信息数据库的 D 列存主职业但表头为空），
 * 这时按位置兜底：信息数据库布局是 A 入帮排序 / B 空 / C 角色ID / D 职业 / E 填表 …
 * 不兜底的话「网格→TSV→解析」这条链路会把主职业整列丢掉。
 */
const POSITION_FALLBACK: Record<number, keyof PlayerInput> = {
  0: 'joinedOrder',
  2: 'gameId',
  3: 'mainClass',
};

function mapHeader(h: string, index: number): keyof PlayerInput | null {
  const n = normHeader(h);
  if (!n) return POSITION_FALLBACK[index] ?? null;
  return HEADER_MAP[n] ?? HEADER_MAP[n.toLowerCase()] ?? null;
}

/** 从「备注」列里识别备注角色（旧表 L 列存放 指挥/统战/K龙…） */
function extractNoteRole(remark: string): PlayerInput['noteRole'] | null {
  for (const r of NOTE_ROLES) if (remark.includes(r)) return r as PlayerInput['noteRole'];
  return null;
}

/**
 * 解析 CSV / TSV 文本为成员记录。
 * 有表头则按列名映射；无表头时按旧表列顺序兜底（角色ID, 名字, 主职业, 副职, 麦克风, 备注）。
 */
export function parseTableText(text: string): PlayerInput[] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];

  const delim = detectDelimiter(clean);
  const headerCells = splitLine(lines[0], delim);
  const mapped = headerCells.map((h, i) => mapHeader(h, i));
  const hasHeader = mapped.filter(Boolean).length >= 2;

  const rows: RawRow[] = [];
  const bodyLines = hasHeader ? lines.slice(1) : lines;
  for (const line of bodyLines) {
    const cells = splitLine(line, delim);
    const rec: RawRow = {};
    if (hasHeader) {
      mapped.forEach((field, i) => {
        if (field) rec[field] = (cells[i] ?? '').trim();
      });
    } else {
      const fallback: (keyof PlayerInput)[] = ['gameId', 'name', 'mainClass', 'subClass', 'mic', 'remark'];
      fallback.forEach((f, i) => { rec[f] = (cells[i] ?? '').trim(); });
    }
    rows.push(rec);
  }

  const out: PlayerInput[] = [];
  for (const r of rows) {
    const gameId = (r.gameId ?? '').trim();
    const name = (r.name ?? '').trim();
    if (!gameId && !name) continue;
    const remark = (r.remark ?? '').trim();
    const note = (r.noteRole ?? '').trim() || extractNoteRole(remark) || '';
    const joinedRaw = (r.joinedOrder ?? '').trim();
    const joined = joinedRaw === '' ? null : Number(joinedRaw);
    const micRaw = (r.mic ?? '').trim();
    const mic = micRaw.includes('无') && !micRaw.includes('无需') ? '无'
      : micRaw.includes('无需') ? '无需作答'
      : micRaw.includes('有') ? '有' : '';
    out.push({
      gameId: gameId || name,
      name: name || gameId,
      joinedOrder: joined !== null && Number.isFinite(joined) ? joined : null,
      mainClass: (r.mainClass ?? '').trim(),
      subClass: (r.subClass ?? '').trim(),
      mic,
      noteRole: note as PlayerInput['noteRole'],
      status: (r.status ?? '').trim() || 'active',
      remark,
    });
  }
  return out;
}

const EXPORT_HEADERS: { key: keyof PlayerInput; label: string }[] = [
  { key: 'joinedOrder', label: '入帮排序' },
  { key: 'gameId', label: '角色ID' },
  { key: 'name', label: '玩家名字' },
  { key: 'mainClass', label: '主职业' },
  { key: 'subClass', label: '副职' },
  { key: 'mic', label: '麦克风' },
  { key: 'noteRole', label: '备注角色' },
  { key: 'status', label: '状态' },
  { key: 'remark', label: '备注' },
];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出为带 BOM 的 CSV，Excel 双击不乱码 */
export function toCsv(rows: PlayerInput[]): string {
  const head = EXPORT_HEADERS.map((h) => h.label).join(',');
  const body = rows.map((r) => EXPORT_HEADERS.map((h) => cell(r[h.key])).join(','));
  return '\uFEFF' + [head, ...body].join('\r\n');
}
