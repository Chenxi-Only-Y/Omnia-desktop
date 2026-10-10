# 交接文档 · 万象·Omnia（lis-desktop）

> 给**下一个全新会话**看。读完这份就能直接接手，不需要翻历史。
> 最后更新：2026-10-08（第二轮：待办 2/3 已修 + 新增 `DESIGN-APP.md` + 修掉「build 会删掉安装包」）
> 上一轮：2026-10-08 18:10（v0.2.0 已就绪；新增「设计语言」章节 ✓）

---

## 1. 这是什么

逆水寒手游 帮会联赛（联赛/帮战）管理工具，Electron 桌面应用。中文界面，品牌名 **万象·Omnia**。

| 项 | 值 |
|---|---|
| 仓库 | `D:\AI\ds.5\lis-desktop` |
| 远程 | https://github.com/Chenxi-Only-Y/Omnia-desktop |
| 分支 | **`main`**（唯一分支 ✓，本地已跟踪 `origin/main` ✓ 直接 `git push` 即可） |
| 版本 | **0.2.0**（`package.json` + `package-lock.json` ✓） |
| 技术栈 | Electron 37.10.3 + Node 22 + React 19 + TS strict + Vite 6；主进程 CJS（`dist/main/*.js`）；DB 用 `node:sqlite` 的 `DatabaseSync` |
| 真实数据 | `%APPDATA%\omnia-desktop\guilds\xusuanke.db`（霜序客 81 人/4 场）+ 岂曰无衣；原始台账在 `D:\AI\ds.5\work\*.xlsx` —— **两者都在仓库外，天然不入库** ✓ |

---

## 2. 跑起来

```bash
npm run dev          # 开发：Vite(5173) + Electron，渲染层热更新 ✓（改主进程要重启）
npm run build:node   # 只编主进程（改 src/main/** 后必须跑）
npm run typecheck    # tsc node + renderer（改完**立刻**跑，最省时间 ✓）
npm run smoke        # 全量自检（约 3 分钟，2700+ 行探针）：改完必须跑 ✓
npm run css:audit    # 样式表审计（只报告）：重复选择器组 / 候选死选择器
npm run css:stats    # 样式表实测统计（token 数、字号/圆角分布、玻璃与阴影处数）
npm run css:prune    # 预览「永不生效的旧声明」；`npm run css:prune -- --apply` 才写（自带校验+备份）
npm run dist         # 打 Windows 安装包 → release/Omnia-Setup-<版本>.exe
```

⚠️ **`npm run build` / `npm run smoke` 现在只清 `dist/`，会保留 `release/`** ——
安装包在 `release/` 里而它又不在 git 里，删掉就找不回来（2026-10-08 之前就这样丢过一次）。
要连 `release/` 一起清，用 `npm run clean:release`（`npm run dist` 已经接上它）。

⚠️ **跑 `npm run smoke` 之前必须先把应用窗口关掉**：主进程有**单实例锁**
（`main.ts` 的 `requestSingleInstanceLock`），开发窗口开着时自检那个 Electron 实例会**秒退**，
日志里只有构建那几行、最后一行是「`[smoke] 失败 ❌ (exit=0)`」—— 看着像探针失败，
其实是**根本没跑**（2026-10-08 踩到）。`npm run dev` 起的窗口要留着看界面时，
就等看完再跑自检，或者用另一份检出跑。

- 调试口：`OMNIA_DEBUG_PORT=9222` → CDP `Runtime.evaluate` / `Page.captureScreenshot` 可做运行时验证 ✓
- 单库模式：`OMNIA_DB_PATH=<file>`（自检用的模式；此模式下帮会增删改名被禁止）
- **`smoke` 会把应用关掉** ✓ 跑完想看界面要重新 `npm run dev` ✓
- `smoke` 用**全新库** `dev-data/smoke.db`，**不碰真库** ✓；`OMNIA_SMOKE_SHOTS=<目录>` 会把界面截图写出来
- 网络：GitHub 推送偶发 `Connection was reset` ✗ → **重试 1~2 次必通** ✓
- `npm run dist` 偶发 `EPERM: rename release\win-unpacked.tmp`（杀软占着刚解压的目录）→ **直接重跑一次就好** ✓（9/30 与 10/8 各遇到一次，第二次都过）

---

## 3. 当前状态

```
安装包   release\Omnia-Setup-0.2.0.exe   ✓ 已上传到 GitHub Releases（用户 2026-10-08 确认）
         ⚠️ 本地 release/ 被清过一次（见第 7 节第 8 条）；要重建：npm run dist
tag      v0.2.0 → 46a5702 ✓ 已推送 ✓（v0.1.1 也在 ✓）
GitHub   只有 main 一条分支 ✓
自检     结果: PASS ✓   schema 版本: 19 ✓（2026-10-08 复跑，含新增的 M3c 原子性探针）
typecheck 通过 ✓
```

> **GitHub Release 那一步用户已经做完了**（2026-10-08），第 3 节原先留的"还差最后一步"已完成。

---

## 4. 已完成（近期）

**第三轮（2026-10-10）：报名「接龙」导入（用户给的格式与口径）**

用户口径：报名不止 xlsx，群里还有**接龙**；**职业顺序无所谓**；**每场报名单独处理**；
**导入过后可以检查修改**（= 预览表可编辑，所以解析可以"尽力而为 + 把拿不准的列出来"）。

| 项 | 内容 |
|---|---|
| 解析器 | ✅ 新增 `shared/signupRollcall.ts`（纯函数），输出与 xlsx **同一个** `SignupImportPreview` → 预览/编辑/入库/未匹配补建**整条链路复用**，一行没改 |
| 脏点 | ✅ 标题行 `10.10联赛报名`（**长得就像第 10 条**）· 状态/名字/职业粘连 · 隐形字符（U+FFF0）· 两人职业粘一起（`潮光素问`）· 分隔符五花八门（空格/`，`/`-`/`—`）· 简称 `90`/`素`/`玄`/`沧`/`血`/`铁`/`龙`/`碎`/`潮`/`神`/`妙` · 外观名当职业写（`白龙吟`→龙吟） |
| 「鸿」口径 | ✅ **保序**：`奶鸿`＝一个职业妙音；`素鸿`→素问+妙音；`沧鸿`→沧澜+惊鸿；`鸿潮`→**惊鸿**+潮光；`鸿素奶`→**妙音**+素问；`潮鸿`→潮光+惊鸿（规则：同条里另一个职业是奶 → 妙音，否则 → 惊鸿） |
| 提示清单 | ✅ `SignupImportPreview.warnings`：认不出的写法、请假行写了职业、主副职相同、名字只差尾部装饰字（`桃酥`↔主档 `桃酥丿`，**只提示不自动匹配**，免得补建出重复成员）—— IPC 侧对照主档算出来 |
| 入口 | ✅ 报名页工具栏「粘贴接龙」浮层（整条粘进来即可）→ 走同一个预览表 |
| 探针 | ✅ 新增 **探针9b**：18 条样本把上面每种脏点都断言一遍（含 6 条「鸿」的期望值）；报名探针顺带断言「粘贴接龙」入口**看得见**（真实尺寸 + `display`） |
| 真机验证 | ✅ `dev-data/rollcall-verify.cjs`：拿**真实样本 + 真实库**跑 → 67 条（参加 62/请假 5）· 对上主档 **61** · 提示 26；`dev-data/rollcall-report.txt` 是逐条明细 |

**第二轮（2026-10-08，本文件的"后续完成内容"）**

| 项 | 内容 |
|---|---|
| 待办 2 · 战报导入无事务 | ✅ 循环收进 **`MatchRepo.importStats()`**，外面套一个 `db.ts` 的 **`inTransaction()`（SAVEPOINT，可嵌套）**：任一行写失败 → 整批回滚。IPC 只负责"分类"（我方/对方/丢弃）后交计划下去 |
| 待办 2 · 验证 | ✅ 自检新增 **M3c 原子性探针**：手工拼一批"第 1 行合法、第 2 行小队名不存在"的预览 → 写库中途抛错 → 断言**库里一条没剩**（修复前会残留 1 条） |
| 待办 3 · 目录穿越探针恒真 | ✅ 旧探针指向一个**不存在**的目录，删掉守卫也照样 PASS ✗。改用 `%2e%2e%2f`（斜杠一起编码，URL 解析器不折叠），并要求"若不拦就会命中一张真实存在的图" |
| 待办 1 · 样式表清理 | ✅ 判据脚本化 + 已删 54 条"永不生效的旧声明"（`npm run css:prune --apply`，逐条列出、自带自校验与备份）。**不批量删**：只删"同一条选择器串、后面那条同名属性覆盖"的，可证不影响渲染 |
| 新增交付物 | ✅ **`DESIGN-APP.md`**：两语域边界 + 全量 token + 实测字号/圆角/玻璃统计 + 组件前缀清单 + Motion + Do/Don't + 与 `DESIGN.md` 的三处偏差 |
| 工程性修复 | ✅ `npm run clean` 原本**连 `release/` 一起删**（安装包在里面且不在 git 里 → 删了找不回，本项目已丢过一次）→ 现在默认只清 `dist`，要清 release 用 `npm run clean:release` |
| 探针可信度 | ✅ M3e（主档拖动）那条历史偶发项：加了**诊断输出**（rAF 是否在跑 / dragstart 前后几何位移 / 网格列数），命中点从 80% 宽改到 **60%** 宽（余量翻倍；不能用 50%，那样 `below` 会反转、断言就不成立了） |

**三批审计修复（已提交 7b528e7 / 46a5702）**

| 批次 | 内容 |
|---|---|
| 数据正确性 | ① 战报导入**不再清空排表**、**不再把请假改成上场**（`squad` 空串按"没传"；`state` 改 `COALESCE(?, state)`）② 看板出勤率分母改用成员自己的场次 ③ 看板「阵容与职业」优先取 `match_squad`（退回全局模板兜底）④ 「提交时间」优先 `submitted_at` |
| 状态一致性 | 拖拽换位用完整名单 `orderedIds()`；排表/对局/报名改动置 `score_stale`（含 `MatchRepo.markStale` 公开入口）；删当前帮会后自动 `open` 新帮会；导入硬拦 `UNKNOWN_CLASS` |
| 探针可信度 | CRUD 探针改用真实字段（原来调 v10 已删的 `mainClass/subClass`，静默失效）；CSP 断言改读页面真实 CSP；`schemaVersion` 断言收到 19 |

**成员主页背景与卡片**
- 卡片统一深色底：有背景媒体显示**视频第一帧**（整帧 contain、右对齐），**没有就半透明黑** `rgba(0,0,0,.45)`，配黑渐变 + 白字
- 详情页素材**左侧渐隐**（`mask-image` 横向遮罩只压左侧）+ 色调层加宽加深 → 消除素材左边缘那条**硬边**
- 飞行动画两层渐变（`.fly-leftshade`/`.fly-leftdark`）改为**同步点亮**（原来放 `requestAnimationFrame` 里，窗口失焦被节流 → 停在 opacity:0 → "黑渐变没了 + 一条分割线"）

**数据层**：迁移到 **v19**（v17 `player.bg_media`、v18 `signature`、v19 `intro`）

---

## 5. 待办（按优先级）

1. **样式表清理：剩下的部分** —— 判据仍然是「**按逗号拆分选择器、逐项判死**」✗ 不能按"含某个死类"整条删 ✓
   - 已删（第二轮）：54 条"永不生效的旧声明"（脚本可证）。**49 组重复选择器里，多数是"后者重写同名前缀"的覆盖块，不能整组删** —— 只能删被覆盖的那条声明
   - 剩余候选：**4 组"笔误候选"要人拍板**（`npm run css:prune` 的末尾会把它们列出来）：
     `.mcard__media` 重复 `background`（后者胜，可删前一条 ✓）·
     `.md-bg video, .md-bg img` 重复两条 `mask-image`（后者胜 = 现在的"黑区旋钮"，可删前一条 ✓）·
     `.mcard__body{position:relative}` 吃掉 4 处 `absolute`（**会改观感** ✗ 不是笔误）·
     `.sel__btn` 磨砂被后一条改回不透明（要恢复磨砂得改**后面**那条）
   - `npm run css:audit` 还会报"候选死选择器"（必要条件，**必须人工确认**）：
     `.brand` 那一组是活的（首页品牌块），扫不到引用是因为它由 JS 动态拼 —— 别照报告删 ✗
2. **动画两层的淡入是否恢复**（现在是立刻出现 ✓）—— 需用户看观感后拍板
3. **黑区旋钮**（用户口径"往右再黑点"）：素材遮罩 `transparent 0 → .55 20% → #000 45%`；色调层 `.92 0% → .88 32% → .45 58% → 0 82%` —— **已按此实现**，要再调就改这两行
4. 排表页每个小队的**人数上限 UI 入口**（后端 `setSquadSize` + IPC 都就绪，只差界面）
5. `DESIGN.md` 的三处偏差（`--accent` 口径 / 去掉的光晕 token / 轻阴影）—— 见 `DESIGN-APP.md` 第九节，需要产品拍板

---

## 6. 验证方式（**不许只靠肉眼**）

```
typecheck  → 改完立刻跑
smoke      → 全量探针，改动写库/样式后必跑
CDP 探针   → OMNIA_DEBUG_PORT=9222，用 Runtime.evaluate 读计算样式/几何
真机复现   → 关键 bug 写脚本：复制真实库到 %TEMP% → 直接调 dist/ 里编译好的仓储 → 断言
             （例：① 的闭环脚本就是这么做的，临时库用完删除，真库不动 ✓）
```
⚠️ 两个坑：**截图有 ~300ms 延迟**（飞行动画抓不准 ✗ 用页内 `setInterval` 采样 ✓）；
**ESM 的 `import('x?t=...')` 绕不过 CJS 的 require 缓存**（A/B 对照要分两个进程跑 ✓）

---

## 7. 血泪教训（今天踩过的，别再踩）

1. **Hook 别放提前 `return` 之后 / 别放进其它 hook** —— 会白屏（本项目已发生两次）
2. **插代码前先看整块**：箭头函数隐式返回 `=> ({...})` 里插语句 → 语法错；跨行的函数调用中间插 → 语法错
3. **改注释前先确认 `/*` 与 `*/` 成对** —— 只替换跨行注释的**开头**会把后面的 CSS 一起吞掉（首屏高度 831→523 就是这么来的）
4. **脚本自己的注释里别写 `*/`** —— 会把脚本的块注释提前结束 → `SyntaxError`
5. **CSS 批量删**必须按逗号拆分逐项判死 ✗ 否则会连带删掉含活类的规则（本项目误删过 `:root` 变量块 / `.home-dark` / `.modal__box--wide` / 一条 `.app`）
   → 2026-10-08 起有脚本了：`npm run css:audit` / `css:prune`（逐条列出 + 自校验 + 备份），**别再手写正则批量删** ✓
6. **改完先 `node --check <脚本>` 再执行** ✓；**写完文件先跑 typecheck** ✓
7. **CSV/MD 等中文文件读写用 `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)`** ✓（`Get-Content` 会乱码 ✗）
8. ⚠️ **`npm run build` 会跑 `scripts/clean.mjs`，而它原先连 `release/` 一起删** ——
   `release/` 里是打好、要传 GitHub Releases 的安装包，而 `release/` 在 `.gitignore` 里 → **删了找不回**。
   2026-10-08 就这么丢过一次（只能重跑 `npm run dist`）。现在 `clean` 默认**只清 `dist`** ✓，要清 release 用 `npm run clean:release`。
   **教训：凡是"清理产物"的脚本，先看它删哪些目录，尤其删的是不在版本控制里的东西。**
9. ⚠️ **"探针红了"先别急着改代码** —— 本项目探针有两类假红：
   ① **自检偶发**（README 早就写了）：判定标准是**同一份代码连跑两次**，一红一绿就是环境问题；
   ② **恒真/恒假探针**（本轮修掉的那个）：断言本身测不到东西，删掉被测逻辑它照样绿。
   排查手段：给探针加**诊断输出**（本轮给 M3e 加了 rAF 是否在跑 / dragstart 前后几何位移 / 网格列数），
   比对着日志猜快得多。
10. ⚠️ **A/B 对照必须"同一份代码跑两次"才作数**：本轮 M3e 先出现"改 CSS 后 2 连红、改回去 1 连绿"，
    看着像 CSS 的锅 ✗ —— 结果第三跑（**同一份 CSS**）直接 PASS，说明是环境变体（看板 1361x862 ↔ 1351x856 两套布局）。
    **单次对照不算对照** ✓
11. ⚠️ **探针用 `el.click()` 程序化点击 ⇒ 抓不到"元素被藏起来"**：`.click()` 对 `display:none`
    的元素**照样生效**，所以"点得到"不等于"看得见"。2026-10-08 的线上 bug 就是这么漏掉的（见下条）。
    **凡是"用户要能看见 / 点到"的东西，断言里必须查 `getBoundingClientRect()` 的真实尺寸
    加上 `getComputedStyle().display`** —— 报名页签那条探针现在就是这么断言的（`tabsVisible`）。
12. ⚠️ **给某个页面写的"隐藏 / 拍平"规则，一定要带页面限定前缀**：`.gpage` 是**所有帮会页共用的外壳**
    （`App.tsx` 每页都套 `gpage`）。上一轮为成员主页写的
    `.gpage :has(> button.tab) { display:none !important }` **漏了 `.content.md-snap`**，
    于是「对局与战报 → 某场」**整排页签**（阵容编排 / 战报录入 / **报名 / 请假** / 本场评分 / 批量导入战报）
    被整排藏掉 —— 用户点不到「报名」，以为报名数据丢了（2026-10-08 截图报障）。
    同文件里那条 `display:none` 的注释**早就写过这个坑**（"不加 `.content.md-snap` 会把帮会首页一起隐藏"）
    却还是漏了一条 ✗。现在两条都带前缀了 ✓。

---

## 8. 备份与产物（都在仓库里，可回退）

```
src/renderer/src/styles.css.bak-deadcode   最初删死类之前
src/renderer/src/styles.css.bak-clean1     两次 CSS 清理之前（= 现在的底子 ✓）
src/renderer/src/styles.css.bak-mask2      "往右再黑点"之前
src/renderer/src/styles.css.bak-prune-*    第二轮删"永不生效声明"之前（css:prune 自动生成的）
dev-data/                                  全部临时产物（.gitignore 忽略 ✓）
  ├ dev-data/smoke-*.log                   各轮自检记录
  ├ dev-data/shots/ · captures/            自检截图
  ├ dev-data/shots-before-1008/            第二轮改动前的截图（像素对照用）
  ├ dev-data/styles-before-prune.css       裁剪前的那一份（可用 css:prune --file= 回看它删了什么）
  └ dev-data/dev-run.log                   最近一次 dev 日志
```
⚠️ `*.bak-*` 已在 `.gitignore` 里 ✓ 不进 Git ✓ 但**硬盘上还在** ✓ 回退随时可用 ✓

**回退方式（样式表出问题时）**
```bash
git checkout -- src/renderer/src/styles.css            # 回到上一次提交
cp src/renderer/src/styles.css.bak-prune-<时间戳> src/renderer/src/styles.css   # 回到裁剪前
```

---

## 9. 设计语言（改 UI 前必读）

**本质：双 register（两套语域）+ 一套共享骨架** —— 不是一份规范，别硬套 ✗

| 语域 | 用在哪 | 长相 |
|---|---|---|
| **A · 剧场/发布页（Dark）** | 总览首页 · 成员主页 · 卡片深色态 | 近黑底 + 巨型标题 + 大留白 + 光晕；语言取自 **ByteDance Seedance 2.0**「模型发布页」，`DESIGN.md` 是首页的**唯一视觉依据**（不得另起炉灶 ✗） |
| **B · 工作台（Light，`.theme-light`）** | 排表 · 看板 · 成员主档 · 对局 · 设置 | 白底卡片 + 1px 描边 + **11~13px 小字**（高密度）+ 药丸按钮 + 大量玻璃浮层 |
| **桥** | 两者共用 | 同一套语义色 · 同一套 BEM 前缀 · 同一套动效时长 |

> `DESIGN.md` 写着"不做密集表格展示区" ✗，但工具页**就是**密集表格 ✓ → 所以真实体系是**两套语域**：宣传语域克制、工具语域高密度 ✓（这解释了首页与排表页为何像两个产品 ✓）

**Token（`:root` 实测 ✓）**

```
底色/面  --bg #0B0B0D  --surface #131317  --surface-2/-3 #1C1C22  --hover #1F1F26
描边     --line #26262E  --line-strong #3B3B46
文字三级 --fg/--text #FFFFFF  --text-dim #A8A8B4  --text-faint #6E6E7A
主色     --accent #6E7BFF（蓝紫）· --accent-soft rgba(110,123,255,.2)
语义     ok #3FD68C · warn #F2C94C · danger #FF6B6B · orange #F0A44A（各带 14~20% -soft）
组别色   --kind-defend #3A5C8A · --kind-attack #8A5630
圆角     --radius 18px · --radius-sm 5px
阴影     --shadow 0 1px 2px rgba(0,0,0,.3), 0 2px 12px rgba(0,0,0,.24)
玻璃     --bg-glass rgba(19,19,23,.72)
```

**实测特征（数出来的 ✓）**
- 字号主力 **11px×28 · 12px×27 · 13px×21**（工具型 UI 的铁证 ✓）；`clamp(40px,6vw,72px)` 只属剧场语域
- 圆角是**多档**体系：12×10 · 6×9 · 999(药丸)×9 · 10×7 · 4×6 · 16×5 · 5×5 · 18（文档只写了 3 档 ✗）
- **纵深的真正主角是玻璃** ✓：`backdrop-filter` **46 处** · `box-shadow` 61 处（`DESIGN.md` 完全没写玻璃 ✗）
- 命名：`block__element--modifier` + **每功能一个前缀**（`mcard` `home` `sel` `pcard` `md` `picker` `dp` `drawer` `hero` `gcard` `stat` `board` …）
- Motion 两档：入场 `420ms cubic-bezier(.2,.7,.2,1)` + 交错 `60ms`；交互 `150ms ease`；特殊：首屏光晕 6~8s 呼吸 · 成员主页飞行 .42~.45s · 页间补间 650ms 锁 + easeOutCubic；**一律尊重 `prefers-reduced-motion`** ✓

**与 `DESIGN.md` 的三处偏差（已知，未处理 ✗）**
1. `--accent` 实现是 **#6E7BFF 蓝紫** ✗，规范写 `#FFFFFF`（白底黑字按钮）✓ → 口径不一致
2. 规范的光晕三色 `--glow-cool/warm/cyan` **已从 `:root` 移除** ✗（清死变量时按"无引用"删的）→ 规范里的"光晕"目前**无 token 支撑**
3. 规范说"不用重阴影" ✓，实现有 61 处轻阴影 ✗（不违反精神，偏离字面）

**建议下一步**：~~把本节扩写成 `DESIGN-APP.md`~~ ✅ **已完成（2026-10-08）** ——
`DESIGN-APP.md` 已写好：两语域边界清单 + 全量 token + 圆角/玻璃实测 + 组件前缀清单（含自绘控件 `sel`/`dp`/`cfm`）+ Motion 两档 + Do/Don't + 三处偏差 + 改 UI 前的检查清单。
**本节保留为速查摘要**；要改 UI 以 `DESIGN-APP.md` 为准。
数字来源：`npm run css:stats`（`:root` 51 个变量 · `backdrop-filter` 46 处 · `box-shadow` 50 处/含相关 65 处 ·
字号 11px×28 · 12px×27 · 13px×17(+4 important) · 圆角 14 档 · 缓动 `ease`×27）。
> ⚠️ 上一轮记的"`box-shadow` 61 处""13px×21""6~8s 呼吸"是**目测/估算**；实测值分别是 50（相关 65）、17(+4)、7.5s。

---

## 10. 用户偏好（重要）

- 说**简洁中文**，不要客套；不要问不必要的问题，但**改任何东西前要说清**
- **极度看重"验证"**：不接受"应该可以" ✓ 要看到数字/截图/复现结果
- 反复强调：**失败就回滚** ✓；改完给他看一眼 ✓
- 设计口径以他当场的说法为准（会推翻之前的决定 ✓）；品牌名固定 **万象·Omnia**
- 库里的真实数据只有**一张卡片**有背景媒体（**草莓酱板鸭** ✓ `bg_1790758980475.mp4` 2466×1440）→ 卡片类改动只能在那张上看出来 ✓
