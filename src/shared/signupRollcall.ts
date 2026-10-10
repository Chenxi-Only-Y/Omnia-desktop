/**
 * 「接龙」报名文本解析（微信群 / QQ 群的接龙消息，用户口径 2026-10-10）
 *
 * 为什么单独一个解析器：报名有两个来源 —— 表单向导导出的 **xlsx**（`signupImport.ts`）
 * 和群里直接发的**接龙**。接龙不是表格，是一行一条的自由文本，而且写法很脏。
 *
 * 样本（真实，10.10 联赛报名，67 条）：
 *   #接龙
 *   为避免消息提醒过多造成干扰，本群可开免打扰
 *
 *   10.10联赛报名
 *   不接龙不默认请假！！
 *   例 参加/请假+ID+报名职业+报名副职业
 *
 *   1. 参加 秋丶 玄机
 *   4. 参加小雯子九零潮光          ← 状态/名字/职业全粘在一起
 *   21. ￰￰￰参加  兮瞳90            ← 名字前面有隐形字符；90 = 九灵
 *   47. 参加 顷歌 白龙吟            ← 把外观名当职业写
 *   65. 参加 素爻 妙音
 *
 * 脏点清单（都能处理，处理不了的一律进 `warnings` **不静默吞掉**）：
 *   ① 头部噪声：`#接龙` / 群公告 / `10.10联赛报名`（**长得像 `10.` 条目**）
 *   ② 状态与名字之间常常没有空格：`参加小雯子…`
 *   ③ 名字与职业粘在一起：`大乃霸丶素问` / `小雯子九零潮光` / `兮瞳90`
 *   ④ 两个职业粘在一起：`潮光素问` / `素问潮光`；分隔符五花八门（空格、`，`、`-`、`—`）
 *   ⑤ 简称：`90`/`九零` → 九灵、`素`→素问、`玄`→玄机、`沧`→沧澜 …
 *   ⑥ 隐形字符（U+FFF0 之类）混在状态词前面
 *   ⑦ 「鸿」带上下文：**同一条里另一个职业是奶 → 妙音，否则 → 惊鸿**；
 *      但 `奶鸿` 两个字是**一个**职业（妙音）
 *
 * 输出与 xlsx 解析**同一个** `SignupImportPreview` 结构 —— 因此
 * 「预览 → 逐行可编辑 → 入库 → 未匹配补建」整条链路一行都不用改（用户口径：
 * 「导入过后可以检查修改」）。会员匹配（ID/姓名/历史用名）仍然由主进程查库完成，
 * 这个文件是**纯函数**，不认识主档。
 */
import { CLASSES, findClass } from './domain';
import type { SignupImportPreview, SignupImportRow } from './types';

/** 接龙里出现的写法 → 正名。带上下文/外观名的那些放这儿，不进 domain 的全局别名表 */
const ROLLCALL_ALIAS: Record<string, string> = {
  // 数字与单字俗称（用户口径 2026-10-10）
  '90': '九灵', 九零: '九灵', 九〇: '九灵',
  素: '素问', 玄: '玄机', 沧: '沧澜', 血: '血河',
  铁: '铁衣', 龙: '龙吟', 碎: '碎梦', 潮: '潮光', 神: '神相', 妙: '妙音',
  // 「奶鸿」两个字 = 一个职业（妙音）—— 必须比单字「鸿」先匹配
  奶鸿: '妙音',
  // 把外观名当职业写（样本第 47 条「白龙吟」）
  白龙吟: '龙吟',
  // 样本第 66 条「d鸿」；该成员库里历史主职就是惊鸿
  d鸿: '惊鸿',
};

/** 键的种类：正职业 / 待定的「鸿」 / 修饰词（吃掉不算职业，如「奶」） */
type Key = { text: string; kind: 'class' | 'hong' | 'drop'; name?: string };

/**
 * 切出来的片段：**必须保序**。
 * 用户口径给的期望是保序的：`鸿潮 → 惊鸿 + 潮光`、`鸿素奶 → 妙音 + 素问`
 * （而 `沧鸿 → 沧澜 + 惊鸿` 只是碰巧鸿在尾巴上）。
 * 早期版本把待定的「鸿」统一追加到末尾 → `鸿潮` 会变成「潮光 + 惊鸿」顺序反了 ✗
 */
type Part = { kind: 'class'; name: string } | { kind: 'hong' } | { kind: 'unknown'; raw: string };

function buildKeys(extraAliases: Record<string, string>): Key[] {
  const m = new Map<string, Key>();
  const put = (text: string, k: Key) => { if (text && !m.has(text)) m.set(text, k); };
  // 1) 12 正名 + domain 里的全局别名
  for (const c of CLASSES) {
    put(c.name, { text: c.name, kind: 'class', name: c.name });
    for (const a of c.aliases) put(a, { text: a, kind: 'class', name: c.name });
  }
  // 2) 接龙专有写法
  for (const [k, v] of Object.entries(ROLLCALL_ALIAS)) put(k, { text: k, kind: 'class', name: v });
  // 3) 库里「职业字典」自定义的别名（用户在设置页加的优先不了内置的，但不冲突时能用）
  for (const [k, v] of Object.entries(extraAliases)) put(k, { text: k, kind: 'class', name: v });
  // 4) 待定的「鸿」；「奶」是修饰词
  put('鸿', { text: '鸿', kind: 'hong' });
  put('奶', { text: '奶', kind: 'drop' });
  // 长的先匹配（奶鸿 要先于 奶 / 鸿；白龙吟 要先于 龙吟 / 龙）
  return [...m.values()].sort((a, b) => b.text.length - a.text.length);
}

/** 全角 → 半角、去掉 BOM 与隐形字符、统一换行 */
function normalize(text: string): string {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    // 隐形字符：U+FFF0..U+FFF8、零宽字符、BOM
    .replace(/[\uFFF0-\uFFF8\u200B-\u200D\uFEFF]/g, '')
    // 全角数字与全角标点
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\uFF0E/g, '.')
    .replace(/\uFF1A/g, ':');
}

/** 从**尾部**剥职业：左边必须还剩东西（保证不会把名字剥空）。**保序** */
function stripFromEnd(token: string, keys: Key[]): { name: string; parts: Part[] } {
  const picked: Key[] = [];
  let i = token.length;
  let moved = true;
  while (moved && i > 0) {
    moved = false;
    for (const k of keys) {
      if (k.kind === 'drop') continue;
      if (i - k.text.length > 0 && token.slice(i - k.text.length, i) === k.text) {
        picked.unshift(k);
        i -= k.text.length;
        moved = true;
        break;
      }
    }
  }
  return {
    name: token.slice(0, i),
    parts: picked.map((k) => (k.kind === 'class'
      ? { kind: 'class', name: k.name as string } as Part
      : { kind: 'hong' } as Part)),
  };
}

/** 一段里贪心切出所有职业（允许两个职业粘在一起，也允许顺便吃掉修饰词）。**保序** */
function segmentToken(token: string, keys: Key[]): { parts: Part[]; unknown: string } {
  const parts: Part[] = [];
  let i = 0;
  while (i < token.length) {
    const hit = keys.find((k) => token.startsWith(k.text, i));
    if (!hit) break;
    if (hit.kind === 'class') parts.push({ kind: 'class', name: hit.name as string });
    else if (hit.kind === 'hong') parts.push({ kind: 'hong' });
    i += hit.text.length;
  }
  return { parts, unknown: token.slice(i) };
}

/**
 * 把片段解析成职业名（**保序**）。
 * 「鸿」是待定写法（用户口径 2026-10-10）：同一条里另一个职业是奶 → 妙音，否则 → 惊鸿。
 */
function resolveParts(parts: Part[], warn: (reason: string) => void): string[] {
  const hongCount = parts.filter((p) => p.kind === 'hong').length;
  if (!hongCount) return parts.filter((p): p is { kind: 'class'; name: string } => p.kind === 'class').map((p) => p.name);
  const named = parts.filter((p): p is { kind: 'class'; name: string } => p.kind === 'class').map((p) => p.name);
  const healer = named.find((n) => findClass(n)?.role === 'HEAL');
  const hong = healer ? '妙音' : '惊鸿';
  warn(healer
    ? `「鸿」按口径记作妙音（同条里有奶妈职业「${healer}」）`
    : '「鸿」按口径记作惊鸿（同条里没有奶妈职业；若其实是奶，请写「奶鸿」）');
  return parts
    .filter((p) => p.kind !== 'unknown')
    .map((p) => (p.kind === 'hong' ? hong : (p as { kind: 'class'; name: string }).name));
}

/**
 * 解析接龙文本 → 报名导入预览（不入库）。
 * @param extraAliases 库里「职业字典」的别名（`class.aliases`），让用户在设置页加的写法也能用上
 */
export function parseSignupRollcall(
  text: string,
  extraAliases: Record<string, string> = {},
): SignupImportPreview {
  const keys = buildKeys(extraAliases);
  const rows: SignupImportRow[] = [];
  const warnings: { line: number; reason: string }[] = [];
  const invalid: { line: number; reason: string }[] = [];
  const seen = new Map<string, number[]>();
  const lines = normalize(text).split('\n');

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.trim();
    if (!line) return;

    const head = line.match(/^(\d+)\s*[.、)）]\s*(.*)$/);
    const st = head ? head[2].match(/^(参加|请假)/) : null;
    if (!head || !st) {
      /* 编号后面不是「参加/请假」：多半是标题行（如 `10.10联赛报名`）。
         它**长得就像 10. 号条目**，所以这里必须显式记一条提示，不能静默丢。 */
      if (head) warnings.push({ line: lineNo, reason: `跳过（编号后不是「参加 / 请假」）：${head[2].slice(0, 20)}` });
      return;
    }

    const status: 'JOIN' | 'LEAVE' = st[1] === '参加' ? 'JOIN' : 'LEAVE';
    const bodyRaw = head[2].slice(st[1].length);
    const gluedToStatus = bodyRaw.length > 0 && !/^\s/.test(bodyRaw);
    const tokens = bodyRaw
      .split(/[\s,，、/|]+|[-—–－]+/u)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tokens.length) {
      invalid.push({ line: lineNo, reason: '只有「参加 / 请假」，没有名字' });
      return;
    }

    let name = tokens[0];
    const parts: Part[] = [];
    const unknownTokens: string[] = [];
    const warn = (reason: string) => warnings.push({ line: lineNo, reason });

    // 第一个 token：可能是纯名字，也可能是「名字+职业」粘连 → 从尾部剥
    if (tokens.length === 1) {
      const r = stripFromEnd(tokens[0], keys);
      if (r.parts.length) {
        name = r.name;
        parts.push(...r.parts);
        if (r.name) warn(`名字与职业粘连：「${tokens[0]}」→ 名字「${name}」`);
        else warn(`这一行只有职业、没有名字：「${tokens[0]}」`);
      } else {
        const seg = segmentToken(tokens[0], keys);
        if (seg.parts.length) {
          name = '';
          parts.push(...seg.parts);
          warn(`这一行只有职业、没有名字：「${tokens[0]}」`);
        }
      }
    } else {
      const r = stripFromEnd(tokens[0], keys);
      name = r.name || tokens[0];
      parts.push(...r.parts);
      if (r.parts.length) warn(`名字与职业粘连：「${tokens[0]}」→ 名字「${name}」`);
      for (const t of tokens.slice(1)) {
        const seg = segmentToken(t, keys);
        parts.push(...seg.parts);
        if (seg.unknown) unknownTokens.push(seg.unknown);
      }
    }

    /* 「鸿」按用户口径解析（同条里另一个职业是奶 → 妙音，否则 → 惊鸿），**保序** */
    const resolved = resolveParts(parts, warn);
    if (unknownTokens.length) {
      warnings.push({ line: lineNo, reason: `认不出的职业写法：${unknownTokens.join(' / ')}（请在预览里改）` });
    }
    if (gluedToStatus) {
      warnings.push({ line: lineNo, reason: '状态与名字之间没有空格（已按位置切开）' });
    }
    if (resolved.length > 2) {
      warnings.push({ line: lineNo, reason: `写了 ${resolved.length} 个职业，只取前两个：${resolved.join(' / ')}` });
    }
    if (resolved.length === 2 && resolved[0] === resolved[1]) {
      warnings.push({ line: lineNo, reason: `主职与副职写的是同一个（${resolved[0]}）` });
    }
    if (status === 'JOIN' && resolved.length === 0) {
      warnings.push({ line: lineNo, reason: '参加但没写职业（预览里可以补）' });
    }
    if (status === 'LEAVE' && resolved.length > 0) {
      /* 与 xlsx 那条链路保持一致：请假行不记职业与麦克风（表单约定）。
         原来写的职业放在提示里，免得用户以为被吃掉了。 */
      warnings.push({ line: lineNo, reason: `请假行写了职业（${resolved.join(' / ')}），按现有约定不记职业` });
    }

    const join = status === 'JOIN';
    rows.push({
      line: lineNo,
      gameId: name,
      status,
      mic: '',
      mainClass: join ? (resolved[0] ?? '') : '',
      subClass: join ? (resolved[1] ?? '') : '',
      submittedAt: '',
    });
    const arr = seen.get(name) ?? [];
    arr.push(lineNo);
    seen.set(name, arr);
  });

  const duplicates = [...seen.entries()]
    .filter(([, ls]) => ls.length > 1)
    .map(([gameId, ls]) => ({ gameId, lines: ls }));

  if (!rows.length && !invalid.length) {
    invalid.push({
      line: 0,
      reason: '没解析出任何一条报名。接龙每条应形如「1. 参加 名字 职业」——'
        + '请确认复制的是接龙正文（含编号），而不是只有标题那几行',
    });
  }

  return {
    rows, duplicates, invalid, unmatched: [], headers: [], headerRow: 0,
    warnings,
  };
}
