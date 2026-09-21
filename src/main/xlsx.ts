/**
 * 极简 xlsx 读写（自行解析 OOXML，不引第三方依赖）
 *
 * 为什么自己写：只用到「读一个工作表成二维字符串数组」「把二维数组写成 xlsx」两件事，
 * 而 exceljs / xlsx 都带一坨依赖与历史安全问题；用 Node 内置 zlib 处理 zip 即可。
 *
 * 支持范围（够用且明确）：
 *  读：共享字符串 / inlineStr / 数字 / 布尔 / 公式单元格的缓存值
 *  写：单工作表、字符串与数字、列宽
 * 不支持（明确不装作支持）：样式、公式、多表写入、图表、加密
 */
import zlib from 'node:zlib';

// ── zip 读取 ─────────────────────────────────────────────────────
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export type ZipEntries = Map<string, Buffer>;

/** 解析 zip 的中央目录并解出所有文件（Store / Deflate） */
export function readZip(buf: Buffer): ZipEntries {
  let eocd = -1;
  const lower = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= lower; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/xlsx：找不到中央目录');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out: ZipEntries = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // 本地文件头：30 字节 + 文件名 + 扩展区
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    try {
      out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    } catch {
      // 个别工具写的 zip 尺寸字段不规范，跳过坏项而不是整体失败
    }
  }
  return out;
}

// ── zip 写入 ─────────────────────────────────────────────────────
/** CRC32（Node 22+ 有 zlib.crc32，老版本回退到本地实现） */
function crc32(buf: Buffer): number {
  const z = zlib as unknown as { crc32?: (b: Buffer) => number };
  if (typeof z.crc32 === 'function') return z.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

export interface ZipInput { name: string; data: Buffer | string }

export function writeZip(files: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    lh.writeUInt16LE(8, 8);           // deflate
    lh.writeUInt16LE(0, 10);          // time
    lh.writeUInt16LE(0x2100, 12);     // date（1980-01-01 的合法编码）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CEN_SIG, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x2100, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── XML 辅助 ─────────────────────────────────────────────────────
function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const ATTR = (chunk: string, name: string): string | null => {
  const m = chunk.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};

function textOf(fragment: string): string {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += unescapeXml(m[1]);
  return out;
}

function colToIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── 读 xlsx ──────────────────────────────────────────────────────
export interface SheetInfo { name: string; index: number }

export interface ReadOptions {
  /** 工作表名或 0 基序号；默认第一个 */
  sheet?: string | number;
  /** 只读前 N 行（0 表示不限） */
  maxRows?: number;
  /** 表头所在行（1 基，默认 1）。真实导出文件里表头常在第 5、6 行。 */
  headerRow?: number;
}

export function listSheets(buf: Buffer): SheetInfo[] {
  const zip = readZip(buf);
  const wb = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const names = [...wb.matchAll(/<sheet[^>]*\sname="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
  return names.map((name, index) => ({ name, index }));
}

/**
 * 探测表头行（1 基）。
 *
 * 启发式：在前 20 行里找「非空单元格最多、且文本多于数字」的一行。
 * 旧表里表头常在第 5~6 行（上面是标题/说明），直接假设第 1 行会读错。
 */
export function detectHeaderRow(grid: string[][], scanRows = 20): number {
  let best = 1;
  let bestScore = -1;
  const limit = Math.min(scanRows, grid.length);
  for (let i = 0; i < limit; i++) {
    const row = grid[i] ?? [];
    const filled = row.filter((c) => c !== '').length;
    if (filled < 2) continue;
    const texty = row.filter((c) => c !== '' && !/^-?\d+(\.\d+)?$/.test(c)).length;
    // 文本列越多越像表头；纯数字行（数据行）会被 texty 压低
    const score = texty * 2 + filled - (filled - texty) * 2;
    if (score > bestScore) { bestScore = score; best = i + 1; }
  }
  return best;
}

/** 读成二维字符串数组（空单元格为 ''，行/列按需要补齐） */
export function readXlsx(buf: Buffer, opts: ReadOptions = {}): string[][] {
  const zip = readZip(buf);

  // 共享字符串
  const sst: string[] = [];
  const sstXml = zip.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sstXml) {
    const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sstXml))) sst.push(textOf(m[1]));
  }

  // 工作表清单与关系
  const wb = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const relsXml = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map<string, string>();
  // 注意：**不能假设属性顺序**。实测「霜序客联赛报名」导出的关系文件写成
  //   <Relationship Target="worksheets/sheet1.xml" Type="..." Id="rId3"/>
  // 即 Target 在前、Id 在后；早前用 /Id=...Target=.../ 一条正则匹配，
  // 遇到这种顺序就全部落空 → 找不到工作表（真实报名表读不进来）。
  // 改为先切出每个 <Relationship .../> 标签，再分别取两个属性。
  for (const tag of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = ATTR(tag[0], 'Id');
    const target = ATTR(tag[0], 'Target');
    if (id && target) relMap.set(id, target);
  }
  const sheetTags = [...wb.matchAll(/<sheet[^>]*\/>/g)].map((m) => m[0]);
  const sheetList = sheetTags.map((tag, index) => {
    const rid = ATTR(tag, 'r:id') ?? '';
    let target = relMap.get(rid) ?? '';
    if (target && !target.startsWith('xl/')) target = 'xl/' + target.replace(/^\/?/, '');
    return { name: ATTR(tag, 'name') ?? `Sheet${index + 1}`, index, path: target };
  });

  let path: string;
  if (typeof opts.sheet === 'number') {
    const hit = sheetList[opts.sheet];
    if (!hit) {
      throw new Error(`xlsx 没有第 ${opts.sheet} 张表（共 ${sheetList.length} 张：${sheetList.map((s) => s.name).join('、')}）`);
    }
    path = hit.path;
  } else if (typeof opts.sheet === 'string') {
    const hit = sheetList.find((s) => s.name === opts.sheet);
    if (!hit) {
      throw new Error(`xlsx 里找不到工作表「${opts.sheet}」（实际有：${sheetList.map((s) => s.name).join('、')}）`);
    }
    path = hit.path;
  } else {
    path = sheetList[0]?.path ?? '';
  }
  // 明确报错，绝不静默回退到第一张表（否则会读到完全不相关的数据）
  if (!path) throw new Error('xlsx 的 workbook.xml 里没有可用工作表');

  const sheetXml = zip.get(path)?.toString('utf8');
  if (!sheetXml) throw new Error(`xlsx 里找不到工作表：${path}`);

  const rows: string[][] = [];
  const rowRe = /<row([^>]*)>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml))) {
    // 行号必须取自 r 属性：真实工作表是稀疏的（可能从第 5 行开始、中间跳号），
    // 按顺序 push 会把 A5 错当成第 1 行。
    const declared = Number(ATTR(rm[1] ?? '', 'r'));
    let rowIndex = Number.isFinite(declared) && declared > 0 ? declared - 1 : rows.length;
    if (rowIndex > 500_000) throw new Error(`工作表行号异常：${declared}`);

    const cells: string[] = [];
    // 注意：必须先匹配自闭合（`/>`），再匹配成对标签。
    // 写成 `(?:/>|>([\s\S]*?)<\/c>)` 会因为回溯把自闭合标签的 `/` 当成 `>` 分支的字符，
    // 结果把下一个单元格的值挂到当前单元格上（整行错列一格）。
    const cellRe = /<c([^>]*?)\/>|<c([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[2]))) {
      const attrs = cm[1] ?? cm[2] ?? '';
      const body = cm[1] !== undefined ? '' : (cm[3] ?? '');
      const ref = ATTR(attrs, 'r') ?? '';
      const type = ATTR(attrs, 't') ?? '';
      const idx = ref ? colToIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const vm = body.match(/<v>([\s\S]*?)<\/v>/);
        const si = vm ? Number(unescapeXml(vm[1])) : -1;
        value = Number.isFinite(si) && si >= 0 ? (sst[si] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        const vm = body.match(/<v>([\s\S]*?)<\/v>/);
        value = vm ? unescapeXml(vm[1]) : '';
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }

    // 补齐跳过的行（保持行号与工作表一致）
    while (rows.length < rowIndex) rows.push([]);
    const existed = rows[rowIndex];
    if (!existed || existed.length === 0) rows[rowIndex] = cells;

    if (opts.maxRows && rows.length >= opts.maxRows) break;
  }

  // 行列对齐，避免下游 undefined
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => {
    const out = r.slice();
    while (out.length < width) out.push('');
    return out;
  });
}

// ── 读 xlsx（表头 + 行对象）─────────────────────────────────────
export interface TableData {
  headers: string[];
  rows: Record<string, string>[];
}

export function readXlsxTable(buf: Buffer, opts: ReadOptions = {}): TableData {
  const grid = readXlsx(buf, opts);
  if (!grid.length) return { headers: [], rows: [] };
  const headerIdx = Math.max(0, (opts.headerRow ?? 1) - 1);
  const headers = (grid[headerIdx] ?? []).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (const r of grid.slice(headerIdx + 1)) {
    if (r.every((c) => c === '')) continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) rec[h] = (r[i] ?? '').trim(); });
    rows.push(rec);
  }
  return { headers, rows };
}

// ── 写 xlsx ──────────────────────────────────────────────────────
export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
  /** 各列字符宽度（可选） */
  widths?: number[];
}

export function writeXlsx(sheet: XlsxSheet): Buffer {
  const cols = sheet.headers.map((_, i) => {
    const w = sheet.widths?.[i];
    if (w) return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    return '';
  }).join('');

  const cell = (v: string | number | null | undefined, ref: string): string => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) {
      return `<c r="${ref}"><v>${v}</v></c>`;
    }
    const s = String(v);
    if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 15) {
      return `<c r="${ref}"><v>${s}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(s)}</t></is></c>`;
  };

  const headerCells = sheet.headers.map((h, i) => cell(h, `${indexToCol(i)}1`)).join('');
  const bodyRows = sheet.rows.map((r, ri) => {
    const cells = r.map((v, ci) => cell(v, `${indexToCol(ci)}${ri + 2}`)).join('');
    return `<row r="${ri + 2}">${cells}</row>`;
  }).join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData>` +
    `</worksheet>`;

  const files: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${escapeXml(sheet.name)}" sheetId="1" r:id="rId1"/></sheets>` +
        `</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ];

  return writeZip(files);
}
