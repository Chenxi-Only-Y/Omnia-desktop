/**
 * 样式表静态审计（只读，不改任何文件）
 *
 * 为什么要有它：`styles.css` 的清理必须**按逗号拆分选择器、逐项判死**。
 * 上一轮靠人肉 + 正则批量删，误删过 `:root` 变量块 / `.home-dark` /
 * `.modal__box--wide` / 一条 `.app`（见 HANDOFF 血泪教训 5）。
 * 那就把"逐项判死"交给脚本，输出可复核的证据，人只负责点头。
 *
 * 分工：
 *   · 本脚本 = **A 重复选择器组** 与 **C 候选死选择器**（只报告）
 *   · `scripts/css-prune.mjs` = **B 永不生效的旧声明**（可 --apply 删，带自校验）
 *   两者共用 `scripts/lib/css-parse.mjs`，判据不会各写一份。
 *
 * 用法：
 *   node scripts/css-audit.mjs            # 打印汇总
 *   node scripts/css-audit.mjs --json     # 机器可读全量
 *   node scripts/css-audit.mjs --only=dup # 只看重复选择器
 *   node scripts/css-audit.mjs --only=dead# 只看候选死选择器
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCss } from './lib/css-parse.mjs';

const ROOT = process.cwd();
const CSS_PATH = path.join(ROOT, 'src', 'renderer', 'src', 'styles.css');
const SRC_DIRS = [path.join(ROOT, 'src', 'renderer'), path.join(ROOT, 'src', 'shared')];

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const css = fs.readFileSync(CSS_PATH, 'utf8');
const { rules } = parseCss(css);

/* ── 1. 引用扫描：渲染层源码里出现过的标识符 ───────────────────────────── */

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'public') walk(p, acc); continue; }
    if (/\.(tsx?|jsx?|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const srcFiles = SRC_DIRS.flatMap((d) => (fs.existsSync(d) ? walk(d, []) : []));
const refText = srcFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/* 源码里所有"长得像标识符"的词。保守：宁可多，不可少 —— 多一个词只会让候选死类
   少一条（更安全），少一个词就会误删活类。 */
const refTokens = new Set();
for (const m of refText.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) refTokens.add(m[0]);
/* 模板字符串里的前缀拼接（`mcard__${x}` / `tab-${x}-on`）：
   把字符串字面量里以 - 或 _ 结尾的片段也当引用，覆盖动态拼类名的情况。 */
const dynPrefixes = new Set();
for (const m of refText.matchAll(/['"`]([A-Za-z][A-Za-z0-9_-]*[-_])/g)) dynPrefixes.add(m[1]);

/** 选择器里出现的所有类名 / ID（去掉伪类、属性选择器内部） */
function tokensOf(selector) {
  const bare = selector
    .replace(/:{1,2}[A-Za-z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '') // 伪类/伪元素
    .replace(/\[[^\]]*\]/g, '');                                   // 属性选择器
  const out = [];
  for (const m of bare.matchAll(/[.#]([A-Za-z_][A-Za-z0-9_-]*)/g)) out.push(m[1]);
  return out;
}

function isReferenced(name) {
  if (refTokens.has(name)) return true;
  for (const p of dynPrefixes) if (name.startsWith(p)) return true;
  return false;
}

/* ── 2. A：重复选择器组 ───────────────────────────────────────────────── */

const bySelector = new Map();
for (const r of rules) {
  const key = `${r.at.join(' > ')}||${r.selectorText}`;
  if (!bySelector.has(key)) bySelector.set(key, []);
  bySelector.get(key).push(r);
}

const dupGroups = [];
for (const [key, list] of bySelector) {
  if (list.length < 2) continue;
  const [atTxt, selTxt] = key.split('||');
  dupGroups.push({
    at: atTxt,
    selector: selTxt,
    count: list.length,
    lines: list.map((r) => r.line),
    declCounts: list.map((r) => r.decls.length),
  });
}
dupGroups.sort((a, b) => a.lines[0] - b.lines[0]);

/* ── 3. C：候选死选择器（**必要条件**，需人工确认）────────────────────── */

const KEEP = /:root|^html|^body|^\*|:hover|:focus|:active|::|:has\(|:is\(|:where\(|:not\(|\[/;
const deadSelectors = [];
for (const r of rules) {
  for (const s of r.selectors) {
    if (KEEP.test(s)) continue;                 // 结构性/交互性选择器一律保留
    const toks = tokensOf(s);
    if (!toks.length) continue;                 // 纯标签选择器，交给人工
    if (toks.every((t) => !isReferenced(t))) {
      deadSelectors.push({ selector: s, line: r.line, at: r.at.join(' > '), tokens: toks });
    }
  }
}

/* ── 4. 实测统计（--stats）：给 DESIGN-APP.md 提供"数出来的"数字 ──────── */

function stats() {
  const hist = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  const fontSize = new Map();
  const radius = new Map();
  const duration = new Map();
  const easing = new Map();
  const prefix = new Map();
  let backdrop = 0;
  let shadow = 0;
  let shadowAny = 0;
  let rootVars = 0;
  const atRules = new Map();
  const pseudo = new Map();

  for (const r of rules) {
    for (const a of r.at) bump(atRules, a.split(/\s+/)[0]);
    for (const s of r.selectors) {
      for (const m of s.matchAll(/:{1,2}([a-z-]+)/g)) bump(pseudo, m[0]);
      for (const m of s.matchAll(/\.([a-z][a-z0-9_]*)__/g)) bump(prefix, m[1]);
    }
    for (const d of r.decls) {
      if (d.prop === 'font-size' || d.prop === 'font') bump(fontSize, d.value);
      if (d.prop === 'border-radius') bump(radius, d.value);
      if (d.prop === 'backdrop-filter' || d.prop === '-webkit-backdrop-filter') backdrop += 1;
      if (d.prop === 'box-shadow') shadow += 1;
      if (/shadow/.test(d.prop) || /drop-shadow|box-shadow/.test(d.value)) shadowAny += 1;
      if (d.prop === 'transition' || d.prop === 'animation' || d.prop === 'transition-duration') {
        // `.15s` / `150ms` / `1.2s` 都要能取到：允许小数点开头
        for (const m of d.value.matchAll(/(\d*\.?\d+)\s*(ms|s)\b/g)) bump(duration, `${m[1]}${m[2]}`);
      }
      if (d.prop === 'transition' || d.prop === 'animation' || d.prop === 'transition-timing-function') {
        for (const m of d.value.matchAll(/cubic-bezier\([^)]*\)|\b(?:ease-in-out|ease-out|ease-in|ease|linear|steps\([^)]*\))\b/g)) {
          bump(easing, m[0]);
        }
      }
      if (r.selectorText.includes(':root') && d.prop.startsWith('--')) rootVars += 1;
    }
  }

  return {
    rootVars,
    backdrop,
    shadow,
    shadowAny,
    topFontSizes: hist(fontSize).slice(0, 12),
    topRadius: hist(radius).slice(0, 14),
    topDurations: hist(duration).slice(0, 10),
    topEasing: hist(easing).slice(0, 8),
    atRules: hist(atRules),
    topPrefixes: hist(prefix).slice(0, 24),
    topPseudo: hist(pseudo).slice(0, 16),
  };
}

if (ONLY === 'stats') {
  const s = stats();
  console.log('[css-audit] :root 变量数       :', s.rootVars);
  console.log('[css-audit] backdrop-filter    :', s.backdrop, '处');
  console.log('[css-audit] box-shadow         :', s.shadow, '处（含任何 shadow/drop-shadow 相关声明共', s.shadowAny, '处）');
  console.log('[css-audit] 字号分布           :', s.topFontSizes.map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('[css-audit] 圆角分布           :', s.topRadius.map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('[css-audit] 动效时长           :', s.topDurations.map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('[css-audit] 缓动函数           :', s.topEasing.map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('[css-audit] @-规则             :', s.atRules.map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('[css-audit] 组件前缀(block__)  :', s.topPrefixes.map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('[css-audit] 伪类             :', s.topPseudo.map(([k, v]) => `${k}×${v}`).join(' '));
  process.exit(0);
}

/* ── 5. 输出 ─────────────────────────────────────────────────────────── */

const summary = {
  rules: rules.length,
  selectorItems: rules.reduce((a, r) => a + r.selectors.length, 0),
  declarations: rules.reduce((a, r) => a + r.decls.length, 0),
  duplicateGroups: dupGroups.length,
  duplicateRulesWasted: dupGroups.reduce((a, g) => a + g.count - 1, 0),
  deadSelectorCandidates: deadSelectors.length,
  scannedSourceFiles: srcFiles.length,
  referenceTokens: refTokens.size,
  dynamicPrefixes: [...dynPrefixes].sort(),
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, dupGroups, deadSelectors }, null, 2));
  process.exit(0);
}

console.log('[css-audit] 文件           :', path.relative(ROOT, CSS_PATH));
console.log('[css-audit] 规则/选择器项  :', summary.rules, '/', summary.selectorItems, '· 声明', summary.declarations);
console.log('[css-audit] 扫描源码文件   :', summary.scannedSourceFiles, '· 引用词', summary.referenceTokens);
console.log('');

if (!ONLY || ONLY === 'dup') {
  console.log(`── A 重复选择器组 ${dupGroups.length} 组（同串规则 ${summary.duplicateRulesWasted} 条是多余的）──`);
  for (const g of dupGroups.slice(0, 60)) {
    console.log(`  L${g.lines.join(',L')}  ×${g.count}  声明数[${g.declCounts.join(' ')}]  ${g.at ? g.at + ' ' : ''}${g.selector}`);
  }
  if (dupGroups.length > 60) console.log(`  …其余 ${dupGroups.length - 60} 组见 --json`);
  console.log('  提示：同串规则的**同名属性**里，前面那条永不生效 —— 用 css-prune.mjs 处理。');
  console.log('');
}

if (!ONLY || ONLY === 'dead') {
  console.log(`── C 候选死选择器 ${deadSelectors.length} 条（必要条件，必须人工确认后再删）──`);
  for (const d of deadSelectors.slice(0, 60)) {
    console.log(`  L${d.line}  ${d.at ? d.at + ' ' : ''}${d.selector}   [类: ${d.tokens.join(' ')}]`);
  }
  if (deadSelectors.length > 60) console.log(`  …其余 ${deadSelectors.length - 60} 条见 --json`);
  console.log('  ⚠️ 扫不到引用 ≠ 可以删：`.home-card` 这类由 JS 动态拼出来的名字也会扫不到。');
  console.log('');
}

console.log('[css-audit] 提示：本脚本只报告，不删任何东西。删之前先跑 npm run smoke。');
