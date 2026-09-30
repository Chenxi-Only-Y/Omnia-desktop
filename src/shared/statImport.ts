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
  /**
   * 历史用名（用户口径 2026-09）。
   * 战报里可能写着玩家改名前的旧名 —— 不查这一列就会「认不出人」，
   * 而 mode='roster' 下认不出会直接**阻止入库**。
   */
  aliases?: string[];
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
    errors.push({ level: 'error', code: 'HEADER_NOT_FOUND', row: 0, player: '', message: '内容不足两行（需要表头 + 数据）' });
    return { rows: [], errors };
  }

  const delim = detectDelimiter(clean);
  /* 表头**不一定在第一行**（用户口径 2026-09：「这个是我从游戏里导出来的，你看看怎么兼容」）：
     游戏导出的 CSV 第一行是元信息，例如
         "霜序客","60"
         "玩家名字","职业","击败/清泉",...
     以前写死 lines[0] 当表头 → 找不到「玩家名字」列 → 整份导不进去。
     现在在前 12 行里找"看起来像表头"的那一行：既要有姓名/职业列，
     也要至少有一个战报列（这样 "霜序客","60" 不会被误判）。 */
  const looksLikeHeader = (line: string) => {
    const h = splitLine(line, delim).map(normHeader);
    const hasName = h.some((x) => NAME_KEYS.some((k) => x.toLowerCase() === k.toLowerCase()));
    const hasStat = h.some((x) => HEADER_MAP[x] !== undefined);
    return hasName && hasStat ? h : null;
  };
  let headerIdx = -1;
  let header: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 12); i += 1) {
    const h = looksLikeHeader(lines[i]);
    if (h) { headerIdx = i; header = h; break; }
  }
  if (headerIdx < 0) {
    // 兜底：仍然用第一行，报原来那条错（保持既有提示不变）
    header = splitLine(lines[0], delim).map(normHeader);
    headerIdx = 0;
  }

  // 定位姓名列与职业列
  const nameIdx = header.findIndex((h) => NAME_KEYS.some((k) => h.toLowerCase() === k.toLowerCase()));
  const classIdx = header.findIndex((h) => CLASS_KEYS.some((k) => h.toLowerCase() === k.toLowerCase()));
  if (nameIdx < 0) {
    errors.push({ level: 'error', code: 'HEADER_NOT_FOUND', row: headerIdx + 1, player: '', message: '表头里找不到「玩家名字 / 角色ID」列' });
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
    errors.push({ level: 'error', code: 'HEADER_NOT_FOUND', row: headerIdx + 1, player: '', message: '表头里找不到任何战报列（击败/助攻/伤害…）' });
    return { rows: [], errors };
  }

  const rows: RawRow[] = [];
  /* 数据从**表头行的下一行**开始；行号按原文件的行号报（表头不在第一行也对得上）。
     ⚠️ 游戏导出的 CSV 里可能**有多段**：每段都是「公会名,人数」+ 表头 + 该段的数据，
     例如 霜序客 一段、朝歌夜弦 一段（用户给的样本就是两段）。
     所以循环里还要把这两类行跳过，否则它们会被当成数据：
       · 又一行"表头"（重复表头）→ 它的"击败/清泉"这类文字会被数值校验判成错误；
       · 「公会名,60」这种只有 1~2 个非空格的元信息行 → 会变成"不在主档"的错。
     跳过的条数记在 skipped 里，供上层显示。 */
  let skipped = 0;
  lines.slice(headerIdx + 1).forEach((line, i) => {
    const cells = splitLine(line, delim);
    const nonEmpty = cells.filter((c) => (c ?? '').trim() !== '').length;
    if (looksLikeHeader(line)) { skipped += 1; return; }
    const name = (cells[nameIdx] ?? '').trim();
    const cls = classIdx >= 0 ? (cells[classIdx] ?? '').trim() : '';
    if (!name && !cls) return; // 空行
    if (nonEmpty <= 2) { skipped += 1; return; }   // 「公会名,60」这类分段元信息

    const rec: RawRow = { __row: String(headerIdx + startRow + i), __name: name, __class: cls };
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

/** 匹配结果：命中的主档成员 + 靠哪条线索命中（id / 当前名 / 历史用名） */
export interface RosterMatch {
  entry: RosterEntry;
  via: 'id' | 'name' | 'alias';
}

/**
 * 「鸿音」按奶量分流（用户口径 2026-09）：
 *   「鸿音奶量大于 500w 以上的按妙音，低于的按惊鸿」。
 * 也就是 鸿音 其实是**门派名**，它有两个流派：妙音（奶）与惊鸿（输出），
 * 靠本场治疗量是否大于 500 万来判定。这样它不会再被当成"不在 12 职业表内"的未知职业，
 * 职业色 / 图标 / 评分里的职业系数也都按真正的职业走。
 */
export const HONGYIN = '鸿音';
export const HONGYIN_HEAL_THRESHOLD = 5_000_000;
export function resolveHongyin(name: string, healing: number): string {
  if (name !== HONGYIN) return name;
  return healing > HONGYIN_HEAL_THRESHOLD ? '妙音' : '惊鸿';
}

/**
 * 姓名/ID → 主档成员的匹配。
 * 优先级：角色 ID → 当前姓名 → **历史用名**（改名后旧战报仍能认人）。
 * 同一个键命中多人时标记为歧义（null），继续走下一级线索。
 */
export function matchRoster(rows: RawRow[], roster: RosterEntry[]): Map<number, RosterMatch | null> {
  const byId = new Map<string, RosterEntry | null>();
  const byName = new Map<string, RosterEntry | null>();
  const byAlias = new Map<string, RosterEntry | null>();
  const put = (m: Map<string, RosterEntry | null>, raw: string | undefined, r: RosterEntry) => {
    const key = (raw ?? '').trim();
    if (!key) return;
    if (m.has(key)) m.set(key, null); // 撞键 → 歧义
    else m.set(key, r);
  };
  for (const r of roster) {
    put(byId, r.gameId, r);
    put(byName, r.name, r);
    for (const a of r.aliases ?? []) put(byAlias, a, r);
  }
  const out = new Map<number, RosterMatch | null>();
  rows.forEach((r, i) => {
    const key = (r.__name ?? '').trim();
    if (!key) { out.set(i, null); return; }
    const asId = byId.get(key);
    if (asId) { out.set(i, { entry: asId, via: 'id' }); return; }
    const asName = byName.get(key);
    if (asName) { out.set(i, { entry: asName, via: 'name' }); return; }
    const asAlias = byAlias.get(key);
    out.set(i, asAlias ? { entry: asAlias, via: 'alias' } : null);
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
    } else if (cls !== HONGYIN && !known.has(cls) && !findClass(cls)) {
      rowIssues.push({
        level: 'warn', code: 'UNKNOWN_CLASS', row: rowNo, player: name,
        message: `职业「${cls}」不在 12 职业表内，且无别名映射`,
      });
    }

    // ── 2. 名单校验 ──
    const matched = matches.get(i) ?? null;
    const hit = matched?.entry ?? null;
    if (!hit) {
      rowIssues.push({
        level: mode === 'roster' ? 'error' : 'warn',
        code: 'NOT_IN_ROSTER', row: rowNo, player: name,
        message: mode === 'roster'
          ? `「${name}」不在成员主档里；请先建档，或改用「完整名单」模式`
          : `「${name}」不在成员主档里，将跳过建档直接入库（建议后续补档）`,
      });
    } else if (matched?.via === 'alias') {
      // 战报里写的是改名前的老名字：认得出人，但要让用户知道归到谁头上了
      rowIssues.push({
        level: 'warn', code: 'ALIAS_MATCH', row: rowNo, player: name,
        message: `「${name}」是主档成员「${hit.name}」的历史用名，本条已归到「${hit.name}」（主档名保持不变）`,
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
    /* 鸿音按奶量分流成 妙音 / 惊鸿（用户口径：>500w 妙音，否则惊鸿）——
       必须在语义校验与 classUsed 之前算出来，治疗职业的"有击杀"提醒才对得上。 */
    const clsFinal = resolveHongyin(cls, stat.healing);
    const effClass = findClass(clsFinal)?.name ?? clsFinal ?? hit?.mainClass ?? '';
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
      classUsed: findClass(clsFinal)?.name ?? clsFinal ?? hit?.mainClass ?? '',
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
