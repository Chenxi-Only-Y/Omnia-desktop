/**
 * 战报导入：解析 + 校验（M3）
 *
 * 纯函数，主进程与渲染层可共用。校验规则来自逆向识别出的真实数据问题：
 *   1. 职业列混入等级数字（原表 e.g. C69="59"）
 *   2. 职业名不在 12 职业表内（原表出现「鸿音」）
 *   3. 队伍名单与主档不一致（原表 121 人 vs 主档 79 人）
 *   4. 姓名做主键导致错配，这里改为角色 ID 优先、姓名兜底匹配
 *   5. 数值列必须是数字且非负
 */
import {
  COMBAT_FIELDS, EMPTY_COMBAT_STAT, findClass,
  type CombatStat,
} from './domain';
import type {
  ImportPreview, ImportPreviewRow, ValidationIssue,
} from './types';

export interface RosterEntry {
  id: number;
  gameId: string;
  name: string;
  mainClass: string;
}

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

/** 表头名 → 战报字段。兼容原表「击败/清泉」「复活/清泉」这类复合列名。 */
const HEADER_MAP: Record<string, keyof CombatStat> = {
  玩家名字: 'kills', // 占位：由外层剔除，这里只为识别表头
  名字: 'kills',
  职业: 'kills',
  '击败': 'kills', '击杀': 'kills', '击败/清泉': 'kills', '击败清泉': 'kills',
  '清泉': 'fountainKills',
  '助攻': 'assists',
  '资源': 'resource',
  '对玩家伤害': 'dmgPlayer', '人伤': 'dmgPlayer',
  '人伤卸甲': 'dmgPlayerArmor',
  '对建筑伤害': 'dmgBuilding', '塔伤': 'dmgBuilding',
  '破塔卸甲': 'dmgBuildingArmor',
  '治疗值': 'healing', '治疗': 'healing', '治疗量': 'healing',
  '承受伤害': 'damageTaken', '承伤': 'damageTaken',
  '重伤': 'deaths', '死亡': 'deaths',
  '复活': 'revives', '复活/清泉': 'revives', '复活清泉': 'revives',
  '焚骨': 'boneBurn',
};

const NAME_KEYS = ['玩家名字', '名字', '角色id', '角色ID', 'gameid', 'name'];
const CLASS_KEYS = ['职业', '主职业', 'class'];

function normHeader(h: string): string {
  return h.replace(/\s+/g, '').trim();
}

/** 「击败/清泉」形如 " 32/0" → kills=32, 清泉值单独返回 */
function parseComposite(v: string): { first: number; second: number } | null {
  const m = v.trim().match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (!m) return null;
  return { first: Number(m[1]), second: Number(m[2]) };
}

export interface ParseResult {
  rows: RawRow[];
  errors: ValidationIssue[];
}

/** 解析战报文本为原始行（表头映射后的字符串字典） */
export function parseStatText(text: string, startRow = 2): ParseResult {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim() !== '');
  const errors: ValidationIssue[] = [];
  if (lines.length < 2) {
    errors.push({ level: 'error', code: 'INVALID_NUMBER', row: 0, player: '', message: '内容不足两行（需要表头 + 数据）' });
    return { rows: [], errors };
  }

  const delim = detectDelimiter(clean);
  const header = splitLine(lines[0], delim).map(normHeader);

  // 定位姓名列与职业列
  const nameIdx = header.findIndex((h) => NAME_KEYS.some((k) => h.toLowerCase() === k.toLowerCase()));
  const classIdx = header.findIndex((h) => CLASS_KEYS.some((k) => h.toLowerCase() === k.toLowerCase()));
  if (nameIdx < 0) {
    errors.push({ level: 'error', code: 'INVALID_NUMBER', row: 1, player: '', message: '表头里找不到「玩家名字 / 角色ID」列' });
    return { rows: [], errors };
  }

  // 定位战报列（跳过姓名与职业）
  const statCols: { idx: number; field: keyof CombatStat; composite: boolean }[] = [];
  header.forEach((h, i) => {
    if (i === nameIdx || i === classIdx) return;
    const field = HEADER_MAP[h];
    if (!field) return;
    if (field === 'kills' && h.includes('清泉') && h.includes('击败')) {
      statCols.push({ idx: i, field: 'kills', composite: true });
      return;
    }
    statCols.push({ idx: i, field, composite: false });
  });
  if (!statCols.length) {
    errors.push({ level: 'error', code: 'INVALID_NUMBER', row: 1, player: '', message: '表头里找不到任何战报列（击败/助攻/伤害…）' });
    return { rows: [], errors };
  }

  const rows: RawRow[] = [];
  lines.slice(1).forEach((line, i) => {
    const cells = splitLine(line, delim);
    const name = (cells[nameIdx] ?? '').trim();
    const cls = classIdx >= 0 ? (cells[classIdx] ?? '').trim() : '';
    if (!name && !cls) return; // 空行

    const rec: RawRow = { __row: String(startRow + i), __name: name, __class: cls };
    for (const { idx, field, composite } of statCols) {
      const raw = (cells[idx] ?? '').trim();
      if (composite) {
        const parsed = parseComposite(raw);
        if (parsed) {
          rec[field] = String(parsed.first);
          rec.fountainKills = String(parsed.second);
        } else {
          rec[field] = raw; // 让后续数值校验报错
        }
      } else {
        rec[field] = raw;
      }
    }
    rows.push(rec);
  });

  return { rows, errors };
}

/** 姓名/ID → 主档成员的匹配（角色 ID 优先，姓名兜底） */
export function matchRoster(rows: RawRow[], roster: RosterEntry[]): Map<number, RosterEntry | null> {
  const byId = new Map(roster.map((r) => [r.gameId, r]));
  const byName = new Map<string, RosterEntry | null>();
  for (const r of roster) {
    if (byName.has(r.name)) byName.set(r.name, null); // 重名标记为歧义
    else byName.set(r.name, r);
  }
  const out = new Map<number, RosterEntry | null>();
  rows.forEach((r, i) => {
    const key = r.__name ?? '';
    const hit = byId.get(key) ?? byName.get(key) ?? null;
    out.set(i, hit);
  });
  return out;
}

/**
 * 校验并生成导入预览。
 * mode='roster' 时未匹配到主档的行报 error 并阻止入库；mode='full' 时降级为 warn。
 */
export function buildPreview(
  text: string,
  roster: RosterEntry[],
  knownClasses: string[],
  mode: 'roster' | 'full' = 'roster',
): ImportPreview {
  const parsed = parseStatText(text);
  const issues: ValidationIssue[] = [...parsed.errors];
  const matches = matchRoster(parsed.rows, roster);
  const known = new Set(knownClasses);
  const rows: ImportPreviewRow[] = [];
  const seen = new Map<string, number>();

  parsed.rows.forEach((raw, i) => {
    const rowNo = Number(raw.__row ?? i + 2);
    const name = raw.__name ?? '';
    const cls = raw.__class ?? '';
    const rowIssues: ValidationIssue[] = [];

    // ── 1. 职业校验 ──
    if (!cls) {
      rowIssues.push({
        level: 'warn', code: 'MISSING_CLASS', row: rowNo, player: name,
        message: '职业列为空，将按主档主职业处理',
      });
    } else if (/^\d+$/.test(cls)) {
      rowIssues.push({
        level: 'warn', code: 'CLASS_LEVEL_MISMATCH', row: rowNo, player: name,
        message: `职业列填的是数字「${cls}」，疑似等级串位；请核对原始战报列顺序`,
      });
    } else if (!known.has(cls) && !findClass(cls)) {
      rowIssues.push({
        level: 'warn', code: 'UNKNOWN_CLASS', row: rowNo, player: name,
        message: `职业「${cls}」不在 12 职业表内，且无别名映射`,
      });
    }

    // ── 2. 名单校验 ──
    const hit = matches.get(i) ?? null;
    if (!hit) {
      rowIssues.push({
        level: mode === 'roster' ? 'error' : 'warn',
        code: 'NOT_IN_ROSTER', row: rowNo, player: name,
        message: mode === 'roster'
          ? `「${name}」不在成员主档里；请先建档，或改用「完整名单」模式`
          : `「${name}」不在成员主档里，将跳过建档直接入库（建议后续补档）`,
      });
    } else if (hit.name && name && hit.name !== name && hit.gameId === name) {
      rowIssues.push({
        level: 'warn', code: 'NAME_MISMATCH', row: rowNo, player: name,
        message: `匹配到主档成员「${hit.name}」（角色 ID = ${hit.gameId}），与行内名字不一致`,
      });
    }

    // ── 3. 重复校验 ──
    const key = hit ? `id:${hit.id}` : `name:${name}`;
    if (seen.has(key)) {
      rowIssues.push({
        level: 'error', code: 'DUPLICATE_IN_MATCH', row: rowNo, player: name,
        message: `与第 ${seen.get(key)} 行重复（同一场里同一人只能有一条战报）`,
      });
    } else {
      seen.set(key, rowNo);
    }

    // ── 4. 数值校验 ──
    const stat: CombatStat = { ...EMPTY_COMBAT_STAT };
    for (const f of COMBAT_FIELDS) {
      const v = raw[f.key];
      if (v === undefined || v === '') continue;
      const num = Number(String(v).replace(/[,\s]/g, ''));
      if (!Number.isFinite(num)) {
        rowIssues.push({
          level: 'error', code: 'INVALID_NUMBER', row: rowNo, player: name,
          message: `「${f.label}」不是数字：${v}`,
        });
        continue;
      }
      if (num < 0) {
        rowIssues.push({
          level: 'error', code: 'NEGATIVE_VALUE', row: rowNo, player: name,
          message: `「${f.label}」为负数：${num}`,
        });
        continue;
      }
      stat[f.key] = Math.round(num);
    }

    // ── 5. 语义校验 ──
    if (stat.deaths > 0 && stat.kills + stat.fountainKills === 0 && stat.assists === 0
        && stat.dmgPlayer === 0 && stat.healing === 0) {
      rowIssues.push({
        level: 'warn', code: 'DEATH_WITH_ZERO_KILLS', row: rowNo, player: name,
        message: '有重伤但击杀/助攻/伤害/治疗全为 0，疑似漏填或串列',
      });
    }
    const effClass = findClass(cls)?.name ?? hit?.mainClass ?? '';
    const role = findClass(effClass)?.role;
    if (role === 'HEAL' && stat.kills + stat.fountainKills > 0) {
      rowIssues.push({
        level: 'warn', code: 'HEALER_WITH_KILLS', row: rowNo, player: name,
        message: `治疗职业「${effClass}」却有 ${stat.kills + stat.fountainKills} 次击杀，请确认「击败/清泉」列是否填的是清泉值`,
      });
    }

    issues.push(...rowIssues);
    rows.push({
      row: rowNo,
      playerId: hit?.id ?? null,
      gameId: hit?.gameId ?? name,
      name: hit?.name ?? name,
      classUsed: findClass(cls)?.name ?? cls ?? hit?.mainClass ?? '',
      squad: '',
      stat,
      issues: rowIssues,
    });
  });

  const errors = issues.filter((x) => x.level === 'error').length;
  const warnings = issues.filter((x) => x.level === 'warn').length;
  return {
    rows,
    issues,
    summary: {
      total: rows.length,
      matched: rows.filter((r) => r.playerId !== null).length,
      unmatched: rows.filter((r) => r.playerId === null).length,
      errors,
      warnings,
    },
  };
}
