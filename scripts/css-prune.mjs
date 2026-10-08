/**
 * 样式表裁剪（默认只预览，`--apply` 才写文件）
 *
 * 判据只有一条，且是**可证的**：
 *   同一条选择器串（含所在 @-容器链）在文件里出现多次时，
 *   后面那条规则会压住前面那条的**同名属性**（特异性相同、位置更后），
 *   所以前面那条同名声明**永不生效** —— 删掉它不可能改变渲染结果。
 *
 * 反面判据（一律不删，交给人工）：
 *   · 选择器串不同、只是"看起来重复"的（比如 .a 与 .b .a）；
 *   · 后面的那条带 !important 而前面也带（谁赢不只看位置）；
 *   · 前面的带 !important、后面的不带（前者反而赢）；
 *   · 后面那条的值是空的（浏览器会丢弃它，于是前面那条又生效了）；
 *   · 同一块内重复的属性（笔误候选）—— 只报告，不自动删。
 *
 * 用法：
 *   node scripts/css-prune.mjs            # 预览：列出将要删除的每一行
 *   node scripts/css-prune.mjs --apply    # 真删（先备份，再自校验）
 *   node scripts/css-prune.mjs --file=dev-data/styles-before-prune.css   # 只分析某一份（如备份），绝不写
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCss } from './lib/css-parse.mjs';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FILE_ARG = (argv.find((a) => a.startsWith('--file=')) || '').split('=')[1] || '';
/* --file= 只用于"回看某一份历史文件"，此时强制不写 */
const CSS_PATH = FILE_ARG
  ? path.resolve(ROOT, FILE_ARG)
  : path.join(ROOT, 'src', 'renderer', 'src', 'styles.css');
const READ_ONLY = APPLY && FILE_ARG !== '';

const original = fs.readFileSync(CSS_PATH, 'utf8');
const { rules } = parseCss(original);

/* ── 1. 找出"永不生效"的声明 ─────────────────────────────────────────── */

const bySelector = new Map();
for (const r of rules) {
  const key = `${r.at.join(' > ')}||${r.selectorText}`;
  if (!bySelector.has(key)) bySelector.set(key, []);
  bySelector.get(key).push(r);
}

const doomed = [];        // { rule, decl, why }
const skipped = [];       // 被反面判据挡下的
for (const [, list] of bySelector) {
  if (list.length < 2) continue;
  for (let i = 0; i < list.length - 1; i += 1) {
    const rule = list[i];
    const laterRules = list.slice(i + 1);
    for (const decl of rule.decls) {
      const laterSame = laterRules
        .flatMap((r) => r.decls.map((d) => ({ d, r })))
        .filter((x) => x.d.prop === decl.prop);
      if (!laterSame.length) continue;

      const imp = (v) => /!important/i.test(v);
      // 前面这条带 !important 而后面全都不带 → 前面赢，不能删
      if (imp(decl.value) && laterSame.every((x) => !imp(x.d.value))) {
        skipped.push({ decl, why: '本条 !important 且后面的都不带 → 本条反而生效' });
        continue;
      }
      // 后面那条的值是空的 → 浏览器丢弃它，本条又生效了
      const effective = laterSame.filter((x) => x.d.value.trim() !== '');
      if (!effective.length) {
        skipped.push({ decl, why: '后面同名属性的值是空的（会被浏览器丢弃）' });
        continue;
      }
      // 后面那条带 !important 且本条不带 → 后面赢
      doomed.push({ rule, decl, why: `L${effective[effective.length - 1].r.line} 之后同名属性覆盖` });
    }
  }
}

/* ── 2. 顺带（只报告）同块内重复属性 = 笔误候选 ───────────────────────── */

const sameBlockDupes = [];
for (const r of rules) {
  const seen = new Map();
  for (const d of r.decls) {
    if (seen.has(d.prop)) {
      sameBlockDupes.push({
        selector: r.selectorText, line: r.line,
        prop: d.prop, earlier: seen.get(d.prop), later: d,
      });
    } else seen.set(d.prop, d);
  }
}

/* ── 3. 计算删除范围（按行清理，避免留下空行）────────────────────────── */

const lineStartOf = (off) => original.lastIndexOf('\n', off - 1) + 1;
const lineEndOf = (off) => {
  const k = original.indexOf('\n', off);
  return k < 0 ? original.length : k;
};

function rangeFor(decl) {
  let s = decl.start;
  let e = decl.end;
  // 带上紧跟的分号
  let k = e;
  while (k < original.length && (original[k] === ' ' || original[k] === '\t')) k += 1;
  if (original[k] === ';') e = k + 1;
  // 若这条声明独占它所在的整行，就连整行一起删（含缩进与换行）
  const lineS = lineStartOf(s);
  const lineE = lineEndOf(e);
  const before = original.slice(lineS, s);
  const after = original.slice(e, lineE);
  if (before.trim() === '' && after.trim() === '') {
    return { start: lineS, end: lineE < original.length ? lineE + 1 : lineE, wholeLine: true };
  }
  return { start: s, end: e, wholeLine: false };
}

// 只删除"整行"型；行内型（一行多条声明）列出来让人工处理 —— 少动总比多动好
const ranges = [];
const manual = [];
for (const d of doomed) {
  const r = rangeFor(d.decl);
  if (r.wholeLine) ranges.push({ ...r, item: d });
  else manual.push(d);
}

ranges.sort((a, b) => b.start - a.start);
let pruned = original;
for (const r of ranges) pruned = pruned.slice(0, r.start) + pruned.slice(r.end);

/* ── 4. 自校验：删完必须仍然括号平衡、且活声明一条没少 ─────────────────── */

const before = parseCss(original);
const after = parseCss(pruned);
const countDecls = (parsed) => parsed.rules.reduce((a, r) => a + r.decls.length, 0);
const braces = (t) => (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
const checks = {
  括号平衡: braces(pruned) === 0,
  规则数不变: after.rules.length === before.rules.length,
  声明数减少: countDecls(before) - countDecls(after) === ranges.length,
  注释成对: (pruned.match(/\/\*/g) ?? []).length === (pruned.match(/\*\//g) ?? []).length,
  UTF8无损: Buffer.from(pruned, 'utf8').toString('utf8') === pruned,
};
const allOk = Object.values(checks).every(Boolean);

/* ── 5. 输出 ─────────────────────────────────────────────────────────── */

console.log('[css-prune] 待删"永不生效"声明 :', doomed.length);
console.log('[css-prune] 其中可整行删除     :', ranges.length, '· 行内需人工 :', manual.length);
console.log('[css-prune] 被反面判据挡下     :', skipped.length);
for (const s of skipped.slice(0, 10)) {
  console.log(`   ↳ 保留 ${s.decl.prop}: ${s.decl.value}   （${s.why}）`);
}
console.log('');
console.log('── 将删除的行（按选择器分组，便于逐项复核）──');
{
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let curSel = null;
  for (const r of sorted) {
    const sel = r.item.rule.selectorText;
    const at = r.item.rule.at.join(' > ');
    const key = `${at}||${sel}`;
    if (key !== curSel) {
      curSel = key;
      console.log(`  ◆ ${at ? at + ' ' : ''}${sel}   （规则在 L${r.item.rule.line}）`);
    }
    const line = original.slice(r.start, r.end).replace(/\n$/, '').trim();
    console.log(`      − ${line}      ⟵ ${r.item.why}`);
  }
}
if (manual.length) {
  console.log('');
  console.log('── 行内声明（一行多条，脚本不动，需人工）──');
  for (const m of manual) {
    console.log(`  ${m.rule.selectorText}  →  ${m.decl.raw}      ⟵ ${m.why}`);
  }
}
if (sameBlockDupes.length) {
  console.log('');
  console.log(`── 同块内重复属性（笔误候选，共 ${sameBlockDupes.length} 处，一律不自动删）──`);
  for (const d of sameBlockDupes) {
    console.log(`  L${d.line} ${d.selector}  →  ${d.prop}: ${d.later.value}  （前面还有一条 ${d.prop}: ${d.earlier.value}，后者胜）`);
  }
}
console.log('');
console.log('[css-prune] 自校验:', checks);
console.log('[css-prune] 结论  :', allOk ? '全部通过 ✅' : '未通过 ❌ 不写文件');

if (!APPLY) {
  console.log('[css-prune] 预览模式（未写文件）。确认无误后加 --apply。');
  process.exit(allOk ? 0 : 1);
}
if (READ_ONLY) {
  console.log('[css-prune] 指定了 --file=<其它文件>，只分析、不写入。');
  process.exit(allOk ? 0 : 1);
}
if (!allOk) process.exit(1);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `${CSS_PATH}.bak-prune-${stamp}`;
fs.copyFileSync(CSS_PATH, bak);
fs.writeFileSync(CSS_PATH, pruned);
console.log('[css-prune] 已备份 ->', path.relative(ROOT, bak));
console.log('[css-prune] 已写入 ->', path.relative(ROOT, CSS_PATH),
  `（${Buffer.byteLength(original, 'utf8')} → ${Buffer.byteLength(pruned, 'utf8')} 字节，`
  + `−${Buffer.byteLength(original, 'utf8') - Buffer.byteLength(pruned, 'utf8')}）`);
console.log('[css-prune] 接着必须跑：npm run typecheck && npm run smoke');
