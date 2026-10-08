# 万象·Omnia — DESIGN-APP.md（应用界面设计规范）

> **这份文件管整个应用；`DESIGN.md` 只管首页。**
> `DESIGN.md` 是从 ByteDance Seedance 2.0 发布页手写的近似规范，它是**首页（剧场语域）的唯一视觉依据**。
> 但本应用有 6 个工具页（排表 / 看板 / 成员主档 / 对局 / 报名 / 设置），
> 那套"低密度 + 大留白 + 不用重阴影"的规范套不上去 —— 工具页**就是**高密度表格。
> 所以真实体系是**两套语域 + 一套共享骨架**。本文件把它写清楚，并补上 `DESIGN.md` 完全没写的部分：
> **玻璃纵深、全量 token、圆角多档、自绘控件、Motion 两档、组件前缀清单**。
>
> 所有数字都是**脚本数出来的**（不是抄的）：
> `npm run css:stats` · `npm run css:audit`（源码见 `scripts/css-audit.mjs`）。
> 最后核对：2026-10-08，对应 `styles.css` 672 条规则 / 833 个选择器项 / 2717 条声明。

---

## 一、两套语域（改 UI 前先判这一条）

| 语域 | 长什么样 | 用在哪 | 判定信号 |
|---|---|---|---|
| **A · 剧场（Dark）** | 近黑底 + 巨型标题 + 大留白 + 克制光晕 | 总览首页 · 成员主页（成员详情）· 帮会卡片/成员卡片的**深色态** | 出现 `clamp(40px,6vw,72px)` 这种大标题、光晕、整屏媒体 |
| **B · 工作台（Light，`.theme-light`）** | 白底卡片 + 1px 描边 + **11~13px 小字** + 药丸按钮 + 大量玻璃浮层 | 排表 · 数据看板 · 成员主档 · 对局与战报 · 报名 · 设置 · 规则 | 出现密集表格 / 表单 / 自绘下拉 |
| **桥（两者共用）** | 同一套语义色 · 同一套 BEM 前缀 · 同一套动效时长 | — | — |

**为什么不是一份规范**：`DESIGN.md` 的 Don't 里写着"❌ 不做密集表格样式的展示区（那是工具，不是宣传页）"——
可工具页**就是**密集表格。所以那不是"规范被违反"，而是**规范只管宣传语域**。
这也解释了"首页与排表页为什么像两个产品"：它们本来就该像两个产品。

**语域开关**：`.theme-light` 是 B 的唯一开关。
⚠️ **它同时提高特异性** —— 覆盖 B 的规则必须**带上同样的前缀**，
只写单个类名 + `!important` 是压不住的（README「两条样式陷阱」第 1 条）。

---

## 二、Token（`:root` 实测 51 个变量）

### 底色 / 面
| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#0B0B0D` | 页面底（近黑） |
| `--surface` / `--bg-panel` | `#131317` | 卡片 / 抬升面 |
| `--surface-2` / `--surface-3` / `--bg-panel-2` | `#1C1C22` | 卡内嵌套（托盘、徽章底） |
| `--hover` / `--bg-hover` | `#1F1F26` | 悬停底 |
| `--bg-glass` | `rgba(19,19,23,.72)` | 悬浮条 / 模态（配模糊） |

### 描边 / 文字
| token | 值 | 用途 |
|---|---|---|
| `--line` / `--border` | `#26262E` | 1px 描边、分隔 |
| `--line-strong` / `--border-strong` | `#3B3B46` | hover 时的描边 |
| `--text` / `--fg` | `#FFFFFF` | 标题与主文 |
| `--text-dim` | `#A8A8B4` | 次级说明 |
| `--text-faint` | `#6E6E7A` | 眉题 / 占位 / 弱文 |

### 主色 / 语义色
| token | 值 | 备注 |
|---|---|---|
| `--accent` | `#6E7BFF`（蓝紫） | ⚠️ 与 `DESIGN.md` 的 `#FFFFFF` 不一致，见第九节 |
| `--accent-soft` | `rgba(110,123,255,.2)` | 主色淡底 |
| `--ok` / `--ok-soft` | `#3FD68C` / 14% | 成功 |
| `--warn` / `--warn-soft` | `#F2C94C` / 14% | 提醒 |
| `--danger` / `--danger-soft` | `#FF6B6B` / 14% | 危险、删除 |
| `--orange` / `--orange-soft` | `#F0A44A` / 18% | 橙武等 |
| `--kind-defend` / `--kind-attack` | `#3A5C8A` / `#8A5630` | 防守组 / 进攻组 |

### 职业色（12 个，另有 `--on-class` = 职业色上的字色）
`--c-素问 #EF949F` `--c-妙音 #A4D663` `--c-惊鸿 #F0BC06` `--c-九灵 #B086D7` `--c-神相 #4470C8` `--c-玄机 #97965F`
`--c-血河 #E35569` `--c-铁衣 #F98B1F` `--c-龙吟 #32CC97` `--c-碎梦 #27C3CD` `--c-沧澜 #91AADF` `--c-潮光 #2BCBFF`

### 圆角 / 阴影 / 玻璃 / 图标托盘
| token | 值 |
|---|---|
| `--radius` | `18px`（卡片档） |
| `--radius-sm` | `5px`（小件档） |
| `--shadow` | `0 1px 2px rgba(0,0,0,.3), 0 2px 12px rgba(0,0,0,.24)` |
| `--shadow-lift` | `0 10px 32px rgba(0,0,0,.48)` |
| `--bg-glass` | `rgba(19,19,23,.72)` |
| `--icon-plate` / `--icon-plate-bg` / `--ink-on-class` | 职业图标托盘与字色（默认透明） |
| `--wallpaper-image` / `--wallpaper-fallback` | 全局壁纸层（第二个 `:root` 块） |

> ⚠️ **改 token 名要全库搜**：`--bg-panel` `--bg-panel-2` `--bg-hover` `--border` `--border-strong`
> 是历史别名，仍在被引用；`--surface-2` 与 `--surface-3` 值相同但语义不同（一个是"嵌套面"，一个是"第三级面"），别合并。

---

## 三、排版（实测分布，不是抄的）

**工具语域的铁证**：`font-size` 出现次数最高的三档是
**`11px`×28 · `12px`×27 · `13px`×17（另有 `13px!important`×4，合计 21）**。
`clamp(40px,6vw,72px)` 只属于剧场语域。

**字栈**
- 中文：`Microsoft YaHei UI, Microsoft YaHei, PingFang SC, -apple-system, Segoe UI, sans-serif`（`body` 实测值）
- 英文/数字：`Inter, SF Pro Display, Segoe UI` 在中文字栈之前
- 等宽：`JetBrains Mono, SF Mono, monospace`（技术标签）

**层级表**

| 角色 | size | weight | line-height | letter-spacing |
|---|---|---|---|---|
| Display（首屏大标题） | `clamp(40px, 6vw, 72px)` | 700 | 1.05 | `-0.025em` |
| H2（章节标题） | `clamp(28px, 3.4vw, 44px)` | 650 | 1.18 | `-0.015em` |
| H3（卡片标题） | `20–24px` | 600 | 1.3 | `-0.005em` |
| Body | `15–16px` | 400 | 1.75 | `0` |
| Small（工具页主文） | `12–13px` | 400 | 1.5~1.7 | `0` |
| Eyebrow（眉题） | `11px` | 500 | 1.2 | `0.08em` |
| Micro（徽章内） | `10–11px` | 500 | 1 | `0.01em` |

规则：**标题重、紧、负字距；正文轻、松、0 字距**。说明文限宽 `640px`。

---

## 四、圆角与纵深

### 圆角是**多档**体系（`DESIGN.md` 只写了 3 档，实测 14 档）

`999px`×10（药丸）· `6px`×12 · `12px`×10 · `10px`×7 · `var(--radius-sm)`(5px)×6 · `4px`×6 · `16px`×6 · `8px`×6 · `0`×5 · `3px`×4 · `14px`×4 · `var(--radius)`(18px)×3 · `50%`×2

取用口径：**药丸（999）只给按钮与 chip；卡片 16–18px；输入/托盘/下拉 10–12px；徽章/极小件 3–6px**。
新写样式优先用 `var(--radius)` / `var(--radius-sm)`，不要新增第 15 档。

### 纵深的真正主角是**玻璃**，不是阴影

- `backdrop-filter` **46 处** —— `DESIGN.md` 一个字都没提，但它是本应用纵深的主要手段
- `box-shadow` **50 处**（含 `text-shadow` / `drop-shadow` 等相关声明共 65 处）
- `DESIGN.md` 说"不用重阴影" ✓ 实现只有轻阴影 ✗ 字面（不违反精神，见第九节）

**三层卡片**：一级磨砂半透明 → 二级白色半透明 → 三级纯白。
**弹层层级**（实测）：侧栏 `40` < 下拉 `150` < 模态 `300` < 确认框 `400`。

⚠️ **自绘弹层所在的那一层必须抬层级**，否则会被后面的行盖住（表现为"下拉是白的、点了没反应"）。
用 `:has(.sel[open])` 抬 —— **不要写成 `:has(> .sel[open])`**（直接子代匹配不上嵌套控件）。

### 壁纸
全局背景层，非卡片区域透出壁纸；mp4/gif/webp/png，mp4 首次使用经 ffmpeg 转码缓存。
本地文件**必须经 `omnia://` 特权协议**（`lib/localFile.ts` 的 `localUrl()`），
不要用 `file://`：开发态页面来源是 `http://127.0.0.1:5173`，Chromium 禁止 http 源读 `file://`，
**CSP 放不开** —— 会出现"打包能用、开发不能用"的假象。CSP 里已显式放行 `img-src` / `media-src` 的 `omnia:`。

---

## 五、组件清单（按 `.block__element` 前缀，数字=选择器出现次数）

| 前缀 | 数 | 是什么 | 代表选择器 | 实现 |
|---|---|---|---|---|
| `mcard` | 46 | 成员卡片（主档网格里的卡） | `.mcard-grid` `.mcard__media` `.mcard--drop-before` | `RosterPage.tsx` |
| `sel` | 46 | **自绘下拉**（替换原生 `<select>`） | `.sel__btn` `.sel__txt` `.sel__list` | `components/Select.tsx` |
| `dp` | 33 | **自绘日期选择器** | `.dp__native` `.dp__btn` `.dp__pop` | `components/DatePicker.tsx` |
| `pcard` | 32 | 排表页的"人卡"（可拖拽） | `.pcard__id` `.pcard--dragging` `.pcard__cls--edit` | `components/LineupBoard.tsx` |
| `drawer` | 20 | 侧边抽屉（成员设置等） | `.drawer-mask` `.drawer__form` `.drawer__alias` | `RosterPage.tsx` |
| `gcard` | 14 | 帮会卡片（选择页） | `.gcard-row` `.gcard__cover` `.gcard--new` | `GuildPage.tsx` |
| `board` | 14 | 数据看板 | `.board__head` `.board__stat` `.board__scroll` | `pages/BoardPage.tsx` |
| `squadrow` | 10 | 小队行（防守/进攻组） | `.squadrow--defend` `.squadrow--attack` `.squadrow__head` | `LineupBoard.tsx` |
| `trend` | 8 | 趋势柱状图 | `.trend__col` `.trend__bar--dmg` | `PlayerDetailPage.tsx` |
| `modal` | 8 | 模态框 | `.modal__box` `.modal__box--wide` | 各页 |
| `cfm` | 8 | **自绘确认框**（替换 `window.confirm`） | `.cfm__box` `.cfm__msg` `.cfm__foot` | `components/Confirm.tsx` |
| `half` `cs` `kv` `hero` `gstat` `cellpick` `pop` | 7 / 7 / 3 / 3 / 3 / 2 / 1 | 半栏 · 职业条 · 键值对 · 首屏 · 帮会统计 · 空格位添加 · 气泡 | `.hero-cover.home-cover` `.gstat__v` `.cellpick__add` | 各页 |

### 自绘控件三件套（原生弹层 OS 绘制，CSS 改不了 → 必须自绘）
`<select>` → `Select.tsx`（`sel`）· `<input type="date">` → `DatePicker.tsx`（`dp`）· `window.confirm` → `Confirm.tsx`（`cfm`）
三者共用同一套展开/收起动画（`unfold` / `fold` 关键帧，`clip-path` 驱动），**两个方向都有过渡**。

### 复用最多的伪类（说明交互密度）
`:hover`×57 · `:has`×13 · `:before`×10 · `:focus`×9 · `:after`×8 · `:active`×8 · `:disabled`×6 · `::placeholder`×5 · `:nth-child`×5 · `:not`×4 · `:focus-visible`×2 · `:is`×2

媒体查询只有两条（`max-width:1240px` / `max-width:1000px`）—— 这是**桌面端**应用，不做移动端适配。

---

## 六、Motion

**两档 + 若干专用**

| 档 | 值 | 用在哪 |
|---|---|---|
| 入场 | `420ms cubic-bezier(.2,.7,.2,1)`，同级交错 `60ms` | 章节/卡片入场 |
| 交互 | `150ms ease` | hover / 按下 |
| 页间补间 | `650ms` 锁 + easeOutCubic | 页面切换 |
| 成员主页飞行 | `.42~.45s`（共享元素克隆） | 成员卡片 → 详情页 |
| 呼吸（环境） | `home-breathe 7.5s`（首屏）/ `3.2s` / `mcard-breathe 2.2s` | 光晕 |

**实测时长分布**：`.18s`×14 · `.16s`×11 · `.3s`×5 · `.22s`×5 · `4.5s`×3 · `.42s`×3 · `.15s`×2 · `.2s`×2 · `.12s`×2 · `220ms`×2
**实测缓动分布**：`ease`×27 · `cubic-bezier(.22,1,.36,1)`×7 · `ease-in-out`×4 · `ease-out`×3 · `cubic-bezier(.4,0,1,1)`×3 · `cubic-bezier(.22,.61,.36,1)`×3

规则：
- **一律尊重 `@media (prefers-reduced-motion: reduce)`**；
- 不做弹跳、不做大位移、不做连续炫技动画；
- ⚠️ 涉及"两层渐变必须同步点亮"的场景（如飞行遮罩），**不要放在 `requestAnimationFrame` 里** ——
  窗口失焦会被节流，动画停在 `opacity:0`，表现就是"渐变没了 + 一条分割线"（本项目踩过）。

---

## 七、Do / Don't

**A · 剧场语域**
- ✅ 大字重对比 + 大留白，让"一句话"当主角
- ✅ 明度层级造纵深：近黑底 → 深灰卡 → 浅灰描边 → 白字
- ✅ 光晕克制：半径大、边缘极柔，只在首屏/章节头
- ✅ 彩色只出现在职业图标、图片、视频卡里
- ❌ 不用彩色块铺大面积背景 · ❌ 不用重投影/粗边框 · ❌ 不在同一屏塞多个大标题

**B · 工作台语域**
- ✅ 信息密度优先：`11–13px` 小字 + 1px 描边 + 紧凑行高
- ✅ 纵深靠**玻璃**（`backdrop-filter`）+ 极轻阴影
- ✅ 弹层按层级表取值：下拉 150 / 模态 300 / 确认 400
- ❌ 不要在工具页塞巨型标题或大留白（会把一屏能看的信息挤成三屏）
- ❌ 不要新增圆角档位 / 不要绕开自绘控件去用原生弹层

**两边都适用**
- ❌ 不改 `:root` 里已有 token 的**名字**（全库在引用）
- ❌ 不做 CSS 批量删除：**必须按逗号拆分选择器、逐项判死**（本项目误删过 `:root` 变量块 / `.home-dark` / `.modal__box--wide`）
- ❌ 改注释前先确认 `/*` 与 `*/` 成对（只替换跨行注释的**开头**会把后面整段 CSS 吞掉）

---

## 八、改 UI 前的检查清单

```bash
npm run typecheck     # 改完立刻跑
npm run css:audit     # 只报告：重复选择器组 / 候选死选择器
npm run css:stats     # 实测 token 与分布（改完对照本文档）
npm run css:prune     # 预览"永不生效的旧声明"（--apply 才写，带自校验 + 备份）
npm run smoke         # 全量探针（约 3 分钟）：几何/落位/首屏钉住/CSP/图标 都会被验
```
- **改样式必须跑 smoke**：探针里有几何与落位断言（`.home-card` 首屏高度、卡片落位、图标加载），
  样式写坏会直接变红，不用靠肉眼看。
- ⚠️ **给"某一页"写的隐藏/拍平规则，必须带页面前缀**：`.gpage` 是**所有帮会页共用的外壳**。
  2026-10-08 的事故：为成员主页写的 `.gpage :has(> button.tab){display:none!important}` 漏了
  `.content.md-snap`，把「对局与战报 → 某场」整排页签（含**报名 / 请假**）全藏了 → 用户点不到报名。
  **凡是 `.gpage` / `.theme-light` / `.page-fill` 开头的新规则，先问一句"这会不会命中别的页"。**
- ⚠️ **"看得见"要单独断言**：探针用 `el.click()` 点按钮，**隐藏元素照样能点**，所以"点得到"≠"看得见"
  （上面那次事故就是这样一路 PASS 的）。要查可见性就用真实尺寸 + `display`：
  `getBoundingClientRect().width/height > 0 && getComputedStyle(el).display !== 'none'`。
- 要**看真实观感**：`OMNIA_SMOKE_SHOTS=<目录> npm run smoke` 会把界面截图写出来。
- 运行时验证：`OMNIA_DEBUG_PORT=9222` → CDP `Runtime.evaluate` 读计算样式/几何。
  ⚠️ 截图有 ~300ms 延迟，飞行动画抓不准 —— 用页内 `setInterval` 采样。

---

## 九、与 `DESIGN.md` 的三处已知偏差（**未处理，均为口径问题**）

1. **`--accent` 不一致**：实现是 `#6E7BFF`（蓝紫），`DESIGN.md` 写 `#FFFFFF`（白底黑字按钮）。
   → 现状：**只有当页主按钮走白底**（`.sel__btn` 那套是浅色玻璃），深色按钮仍是蓝紫。
   → 要统一得先定口径：**首页按规范走白，工具页保留蓝紫？还是全改白？**（需产品拍板）
2. **光晕 token 已消失**：`DESIGN.md` 的 `--glow-cool` / `--glow-warm` / `--glow-cyan`
   在清死变量时按"无引用"被删了，于是规范里的"光晕"**没有 token 支撑** ——
   首页光晕现在直接把 `rgba(110,123,255,.12)` 写死在 `.hero.home-hero:after` 里。
   → 待办：要么把三个 token 加回 `:root` 并替换写死的颜色，要么把 `DESIGN.md` 相应段落改掉。
3. **"不用重阴影" vs 实测 50 处 `box-shadow`**：都是 1–2 层极轻投影或柔光环，
   **不违反精神，只偏离字面** → 建议在 `DESIGN.md` 里补一句"工具语域允许轻阴影"。

> 另有历史遗留：`--icon-plate` / `--icon-plate-bg` 为 `transparent`，
> 职业图标托盘的实际底色走的是 `--surface-2`，改托盘底色别只改这两个 token。

---

## 十、相关文件

| 文件 | 管什么 |
|---|---|
| `DESIGN.md` | **首页（剧场语域）**的唯一视觉依据 |
| `DESIGN-APP.md` | 本文件：两语域边界 + 全量 token + 组件 + Motion |
| `README.md` → 界面体系 | 自绘控件、视觉分层、两条样式陷阱、壁纸、图标 |
| `HANDOFF.md` → 设计语言 | 快速版摘要 + 实测特征速查 |
| `scripts/css-audit.mjs` · `scripts/css-prune.mjs` | 上面所有数字的来源；改样式前先跑 |
