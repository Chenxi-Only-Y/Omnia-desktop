# 交接文档 · 万象·Omnia（lis-desktop）

> 给**下一个全新会话**看。读完这份就能直接接手，不需要翻历史。
> 最后更新：2026-09-30 23:05（v0.2.0 发布就绪）

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
npm run smoke        # 全量自检（约 3 分钟，2600+ 行探针）：改完必须跑 ✓
npm run dist         # 打 Windows 安装包 → release/Omnia-Setup-<版本>.exe
```

- 调试口：`OMNIA_DEBUG_PORT=9222` → CDP `Runtime.evaluate` / `Page.captureScreenshot` 可做运行时验证 ✓
- 单库模式：`OMNIA_DB_PATH=<file>`（自检用的模式；此模式下帮会增删改名被禁止）
- **`smoke` 会把应用关掉** ✓ 跑完想看界面要重新 `npm run dev` ✓
- 网络：GitHub 推送偶发 `Connection was reset` ✗ → **重试 1~2 次必通** ✓

---

## 3. 当前状态（v0.2.0 发布就绪）

```
安装包   release\Omnia-Setup-0.2.0.exe   110.5 MB ✓（release/ 在 .gitignore 里，不入库 ✓）
         release\Omnia-Setup-0.2.0.zip   备选（可拖进 GitHub 描述框 ✓）
tag      v0.2.0 → 46a5702 ✓ 已推送 ✓（v0.1.1 也在 ✓）
GitHub   只有 main 一条分支 ✓ 指向最新 ✓
自检     结果: PASS ✓   schema 版本: 19 ✓
typecheck 通过 ✓
```

**还差最后一步（人来点）**：GitHub → Releases → Draft a new release → 选标签 `v0.2.0` →
把 exe 拖到**页面最底部的 "Attach binaries"** 框（**不是**描述框 ✗ 拖描述框会报 "We don't support that file type" ✗）。
装 `gh` CLI 后可代劳：`gh release create v0.2.0 release/Omnia-Setup-0.2.0.exe`。

---

## 4. 已完成（近期）

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

1. **样式表清理（安全版）** —— 判据必须是「**按逗号拆分选择器、逐项判死**」✗ 不能按"含某个死类"整条删 ✓
   - 已删：`.nav-current`、`.guild-home__hero/__shade/__head`、`.hero__brand`、`.pcard__cls--edit`、`.app.nav-collapsed`、2 个无引用 `@keyframes`、16 个死变量
   - 待删：49 组重复选择器、约 20 组"永不生效的旧声明"、12 处"只能删分支"的（`.ico`/`.home-card` 那条**删了会毁首屏** ✗）
   - 4 组"笔误候选"需人确认：`.mcard__media` 重复 `background`（删被吃的那条 ✓）· `.mcard__body…{position:relative}` 吃掉 4 处 `absolute`（**会改观感** ✗）· `.sel__btn` 磨砂被改回不透明 · `.drawer__*` 被压住
   - 每次只删 1 条 → 校验 括号平衡 + **注释 `/* */` 成对** + 跑 `smoke` → 绿了再下一条
2. **战报导入的行循环仍无事务**（已用硬拦缓解）；彻底解 = 收进仓储层开事务
3. **自检里目录穿越探针是恒真的**：字面 `..` 会被 URL 归一化，要改用 `%2e%2e`
4. 动画两层的**淡入是否恢复**（现在是立刻出现 ✓）
5. **黑区旋钮**（用户口径"往右再黑点"）：素材遮罩 `transparent 0 → .55 20% → #000 45%`；色调层 `.92 0% → .88 32% → .45 58% → 0 82%`

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
6. **改完先 `node --check <脚本>` 再执行** ✓；**写完文件先跑 typecheck** ✓
7. **CSV/MD 等中文文件读写用 `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)`** ✓（`Get-Content` 会乱码 ✗）

---

## 8. 备份与产物（都在仓库里，可回退）

```
src/renderer/src/styles.css.bak-deadcode   最初删死类之前
src/renderer/src/styles.css.bak-clean1     两次 CSS 清理之前（= 现在的底子 ✓）
src/renderer/src/styles.css.bak-mask2      "往右再黑点"之前
dev-data/                                  全部临时产物（.gitignore 忽略 ✓）
  ├ dev-data/smoke-*.log                   各轮自检记录
  ├ dev-data/shots/ · captures/            自检截图
  └ dev-data/dev-run.log                   最近一次 dev 日志
```
⚠️ `*.bak-*` 已在 `.gitignore` 里 ✓ 不进 Git ✓ 但**硬盘上还在** ✓ 回退随时可用 ✓

---

## 9. 用户偏好（重要）

- 说**简洁中文**，不要客套；不要问不必要的问题，但**改任何东西前要说清**
- **极度看重"验证"**：不接受"应该可以" ✓ 要看到数字/截图/复现结果
- 反复强调：**失败就回滚** ✓；改完给他看一眼 ✓
- 设计口径以他当场的说法为准（会推翻之前的决定 ✓）；品牌名固定 **万象·Omnia**
- 库里的真实数据只有**一张卡片**有背景媒体（**草莓酱板鸭** ✓ `bg_1790758980475.mp4` 2466×1440）→ 卡片类改动只能在那张上看出来 ✓
