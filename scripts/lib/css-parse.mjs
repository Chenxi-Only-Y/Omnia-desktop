/**
 * 极小的 CSS 解析器（只读，供 css-audit / css-prune 共用）
 *
 * 为什么不用现成的包：本项目 `node_modules` 里没有 postcss，
 * 而这两个脚本只在开发期用，不值得为它加依赖。
 *
 * 设计要点（都是踩过的坑）：
 *   · 注释 / 字符串用状态机跳过，绝不用正则去切 —— `content: "a,b"` 里的逗号
 *     不能被当成选择器分隔符，URL 里的 `//` 也不是注释；
 *   · `@keyframes` 整块跳过：里面的 `0%` / `from` / `to` 不是选择器；
 *   · 每条声明都记下**绝对偏移**，这样裁剪脚本能按段删除，
 *     而不是"整文件重排"（README 记着样式表被整文件写坏过一次，别再犯）。
 */
import fs from 'node:fs';

/** 按**顶层**逗号拆选择器（圆括号 / 方括号 / 引号里的逗号不算） */
export function splitSelectors(sel) {
  const out = [];
  let cur = '';
  let paren = 0; let brack = 0; let quote = '';
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += sel[i + 1] ?? ''; i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (c === '[') brack += 1;
    else if (c === ']') brack -= 1;
    else if (c === ',' && paren === 0 && brack === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

/**
 * @returns {{rules: Array, keyframes: Array}}
 * rule = { selectors, selectorText, at, decls, open, close, line }
 * decl = { prop, value, raw, start, end }   // start/end 为**已 trim** 的绝对偏移
 */
export function parseCss(text) {
  const rules = [];
  const keyframes = [];
  const stack = [];
  let buf = '';
  let i = 0;
  const n = text.length;

  /** 把 `{...}` 里的声明逐条切出来，并记录绝对偏移 */
  const parseDecls = (bodyStart, body) => {
    const decls = [];
    let j = 0;
    let segStart = 0;
    const flush = (endExclusive) => {
      const rawSeg = body.slice(segStart, endExclusive);
      const lead = rawSeg.length - rawSeg.trimStart().length;
      const trail = rawSeg.length - rawSeg.trimEnd().length;
      const start = bodyStart + segStart + lead;
      const end = bodyStart + endExclusive - trail;
      if (end <= start) return;
      const raw = text.slice(start, end);
      const k = raw.indexOf(':');
      if (k < 0) return;
      const prop = raw.slice(0, k).trim().toLowerCase();
      if (!prop) return;
      decls.push({ prop, value: raw.slice(k + 1).trim(), raw, start, end });
    };
    while (j < body.length) {
      const c = body[j];
      if (c === '/' && body[j + 1] === '*') {
        const e = body.indexOf('*/', j + 2);
        const stop = e < 0 ? body.length : e + 2;
        // 注释若独占一段，直接跳过；否则并入当前段（保留在原文里）
        if (!body.slice(segStart, j).trim()) { segStart = stop; }
        j = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c; j += 1;
        while (j < body.length) {
          if (body[j] === '\\') { j += 2; continue; }
          if (body[j] === q) { j += 1; break; }
          j += 1;
        }
        continue;
      }
      if (c === ';') { flush(j); segStart = j + 1; j += 1; continue; }
      j += 1;
    }
    flush(body.length);
    return decls;
  };

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; buf += c; i += 1;
      while (i < n) {
        buf += text[i];
        if (text[i] === '\\') { buf += text[i + 1] ?? ''; i += 2; continue; }
        if (text[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '{') {
      const head = buf.trim();
      buf = '';
      const open = i;
      let depth = 1;
      let j = i + 1;
      let body = '';
      while (j < n && depth > 0) {
        const cc = text[j];
        if (cc === '/' && text[j + 1] === '*') {
          const e = text.indexOf('*/', j + 2);
          const stop = e < 0 ? n : e + 2;
          body += text.slice(j, stop);
          j = stop;
          continue;
        }
        if (cc === '"' || cc === "'") {
          const q = cc; body += cc; j += 1;
          while (j < n) {
            body += text[j];
            if (text[j] === '\\') { body += text[j + 1] ?? ''; j += 2; continue; }
            if (text[j] === q) { j += 1; break; }
            j += 1;
          }
          continue;
        }
        if (cc === '{') depth += 1;
        else if (cc === '}') { depth -= 1; if (depth === 0) break; }
        body += cc;
        j += 1;
      }
      const close = j;

      if (head.startsWith('@')) {
        const name = head.split(/\s+/)[0].toLowerCase();
        if (name === '@keyframes' || name === '@-webkit-keyframes') {
          keyframes.push({ name: head, open, close, line: lineOf(text, open) });
        } else if (name === '@font-face' || name === '@page' || name === '@property'
                   || name === '@counter-style' || name === '@viewport') {
          // 无选择器的块：不进 rules（没有选择器可判死）
        } else {
          stack.push(head);
          i = open + 1;
          continue;
        }
        i = close + 1;
        continue;
      }
      const selectors = splitSelectors(head).map((s) => s.trim()).filter(Boolean);
      if (selectors.length) {
        rules.push({
          selectorText: head,
          selectors,
          at: stack.slice(),
          decls: parseDecls(open + 1, body),
          open,
          close,
          bodyStart: open + 1,
          bodyEnd: close,
          line: lineOf(text, open),
        });
      }
      i = close + 1;
      continue;
    }
    if (c === '}') { stack.pop(); i += 1; buf = ''; continue; }
    buf += c;
    i += 1;
  }
  return { rules, keyframes };
}

export function readCss(file) {
  return parseCss(fs.readFileSync(file, 'utf8'));
}
