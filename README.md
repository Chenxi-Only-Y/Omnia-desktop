# 万象·Omnia

> **All leagues. One universe.**
> 万象归一，联赛集成。

联赛集成系统的桌面应用：报名、排表、战报、评分、出勤集中在同一处完成。

- 前身是一份 Excel 工作簿（`LIS 联赛集成系统v1.0`），本项目是对它的完整重做。
- 数据落在本机 SQLite（`node:sqlite`，**不依赖 better-sqlite3**）。
- 界面是 Electron + React，深色玻璃主题；视觉规范见 `DESIGN.md`（**首页/剧场语域**）
  与 `DESIGN-APP.md`（**全应用**：两语域边界 + 全量 token + 组件 + Motion）。

当前版本：**v0.2.0**

---

## 版本变更

### v0.2.0（2026-09-30）

**审计驱动的一轮修复**（四路并行审计：主进程 / 渲染层 / 样式表 / 契约一致性）

数据正确性（会写坏数据的四条）

- 战报导入**不再清空该场排表**、**不再把「请假」改成「上场」**：`squad` 传空串按「没传」处理；`state` 用 `COALESCE(?, state)`，没传就保持原值（此前两个分支都是 `state = excluded.state` 且默认成 `PLAY`）
- 看板**出勤率**分母改用成员自己的场次数（原用全库对局数，只出场 1 次的人会显示 33% 并被标红）
- 看板「阵容与职业」优先取**本场建制** `match_squad`（v13 起建制已按场次独立），取不到再退回全局模板 —— 新增小队不再显示空组名/空类别
- 「提交时间」优先取 `submitted_at`（此前显示的是 `updated_at`，导入行时间不对）

状态一致性

- 拖拽换位改用**完整名单**（`orderedIds()`），不再让另一张表的人撞号
- 排表 / 对局 / 报名改动一律置 `score_stale`（评分页会提示「数据已变，请重算」）
- 删除「当前打开」的帮会后**自动打开**新的活动帮会（修掉 `active()` 有值但 `db()` 抛错的非法状态）
- 战报导入把 `UNKNOWN_CLASS` 一并视为硬错误拦住，避免「写到一半抛错留下半截数据」

自检（`npm run smoke`）可信度

- CRUD 探针改用**真实字段**：原来调用 v10 已删除的 `mainClass/subClass`，日志打出 `class=undefined` 却整轮 PASS（职业完全没被验证）
- CSP 断言改读**页面真实 CSP**（原来比较的是探针里的硬编码字面量，恒真）
- `schemaVersion` 断言从 `>= 10` 收紧到当前最新版本

成员主页与卡片

- 成员卡片统一深色底：**有背景媒体显示静帧**（视频取第一帧、整帧 contain、右对齐），**没有就用半透明黑** `rgba(0,0,0,.45)`，配黑渐变与白色字
- 详情页素材加**左侧渐隐**（`mask-image` 横向遮罩只压左侧），并加宽加深色调层 —— 消除素材左边缘（`left:70%` 处）那条**硬边**
- 飞行动画的两层渐变（`.fly-leftshade` / `.fly-leftdark`）改为**同步点亮**：原来放在 `requestAnimationFrame` 里，窗口失焦时被节流 → 那两层停在 `opacity:0`，看起来就是「黑渐变没了 + 一条分割线」

样式表清理（进行中，按新判据推进）

- 已删：`.nav-current`、`.guild-home__hero/__shade/__head`、`.hero__brand`、`.pcard__cls--edit`、`.app.nav-collapsed`、两个无引用 `@keyframes`、16 个未使用 CSS 变量
- ⚠️ **判据必须是「按逗号拆分选择器、逐项判死」**：整条删的写法会连带删掉含活类的规则（本次因此误删过 `:root` 变量块、`.home-dark`、`.modal__box--wide`、一条 `.app` 层级规则，已回滚）。清理后除括号平衡外，还要检查**注释 `/* */` 成对**并跑一次 `smoke`
## 目录

- [功能一览](#功能一览)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [命令一览](#命令一览)
- [目录结构](#目录结构)
- [数据模型](#数据模型)
- [核心业务口径](#核心业务口径)
- [界面体系](#界面体系)
- [自检](#自检)
- [打包与发布](#打包与发布)
- [已知问题与待办](#已知问题与待办)

---

## 功能一览

| 模块 | 内容 |
|---|---|
| **总览** | 首屏大图 + 快捷入口；下滑显示数据层（成员总数、本场可上阵、每方塔数、比分）。一级页签，保持原样 |
| **帮会** | 一级页签：**一个帮会 = 一套独立数据库**。竖向高卡片向右横滚（有封面用封面，没有就用帮会名当大字底），末尾「＋ 新建帮会」。卡片上**没有任何操作**（用户口径 2026-09-27），只管"看一眼 + 进入" |
| **（帮会内）帮会首页** | 二级页签第一个：封面 + 名称 + 简介 + 速览（成员数 / 场次 / 参战记录 / 战报完整度 / 场均上场） |
| **（帮会内）帮会设置** | 二级页签最后一个：改名 / 简介 / 换封面（先预览、保存才拷进应用目录）/ **删除帮会**（危险区 + 二次确认，连库文件一起删）；并显示当前帮会的库文件路径 |
| **（帮会内）成员主档** | 成员列表（ID / 报名状态 / 在队状态 / 麦克风 / 备注角色 / 橙武 / 备注）；新增 / 编辑 / 删除 / 详情；拖动换序；定位 ID |
| **（帮会内）对局与战报** | 新建对局（含「当天第几场」）；对局列表；战报导入与完整度；战报**录入 / 清空 / 移除**；**对方数据页签**（导入时不在主档的行可存为对方：不评分、不进主档）内含**本场对比**：团队人均（人伤/塔伤/击杀/治疗/承伤/重伤，含合计与差值）+ **按职业对齐**（双方人数、人均人伤/塔伤/治疗与人伤差值） |
| **（帮会内）排表** | 战斗组 → 小队 → 位置格；落位到指定格；跨小队拖拽；主职⇄二职切换；职业来自报名表；橙武卡片特效 |
| **（帮会内）数据看板** | 场次 / 成员 / 参战记录 / 场均上场 / 出勤 / 职业出场 / 小队使用 / 治疗值覆盖 |
| **设置** | 壁纸（动态 / 静态帧 / 关闭，适应方式、静音）、壁纸库地址等；一级页签。**壁纸属于全局设置**，切帮会不变 |

---

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Electron 37 · Node 22 |
| 数据库 | `node:sqlite`（Node 内置，带**版本化迁移**，当前到 **v11**） |
| 界面 | React 19 · TypeScript（strict）· Vite 6 |
| 主进程 | CommonJS |
| 渲染进程 | ESM |
| 共享层 | `src/shared/*` 同时被主进程与渲染进程引用 |
| 表格解析 | 自研 xlsx 解析（`src/main/xlsx.ts`）+ TSV 网格 |
| 视频转码 | `ffmpeg-static`（壁纸 mp4 转码用） |

**IPC 约定**：所有调用走 `window.omnia`（preload 暴露），返回值统一是 `IpcResult<T>` 信封。

---

## 快速开始

```bash
# 1. 安装依赖（国内建议先配镜像，见下）
npm install

# 2. 开发
npm run dev

# 3. 构建 + 启动
npm start
```

### 安装依赖

项目根目录已有 `.npmrc`，默认使用 npmmirror 镜像。若需手动指定：

```bash
npm config set registry https://registry.npmmirror.com
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
```

### ⚠️ 首次安装后若启动报 `Electron failed to install correctly`

npm 的 allow-scripts 策略会拦掉 Electron 的 postinstall 脚本。两种解法：

```bash
npm approve-scripts electron      # 方案 A：批准该脚本
npm run fix:electron              # 方案 B：手动跑修复脚本（已接在 postinstall）
```

`ffmpeg-static` 同理（它也要下载二进制）：`npm approve-scripts ffmpeg-static`

### 环境变量（开发用）

| 变量 | 作用 |
|---|---|
| `OMNIA_DB_PATH` / `LIS_DB_PATH` | 指定**单个**数据库文件（**单库模式**：跳过帮会注册表；自检就用它） |
| `OMNIA_DATA_DIR` / `LIS_DATA_DIR` | 覆盖数据根目录（默认 `%APPDATA%\omnia-desktop`）。测"多帮会 / 首次迁移"时必须用它，避免动到真实数据 |
| `OMNIA_DEBUG_PORT` | 开 CDP 远程调试端口（如 `9222`） |
| `OMNIA_DEV_SERVER_URL` | 开发态连 Vite dev server |
| `OMNIA_SMOKE` / `OMNIA_SMOKE_LOG` / `OMNIA_SMOKE_SHOTS` | 自检开关 / 日志文件 / 截图输出目录 |

默认数据布局（多帮会模式）：

```
%APPDATA%\omnia-desktop\
├─ guilds.json            帮会注册表（清单 + activeId + 跨帮会的全局设置）
├─ guilds\<id>.db         每个帮会一套独立数据
├─ guilds\<id>\cover.png  帮会封面
└─ lis.db.bak-YYYYMMDD    首次迁移后留下的旧库备份（可回滚）
```

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run clean` | 清理构建产物（**只清 `dist`**；`release/` 保留 —— 安装包在那里） |
| `npm run clean:release` | 连 `release/` 一起清（重打包前用） |
| `npm run typecheck` | 类型检查（主进程 + 渲染进程两套 tsconfig） |
| `npm run build:node` | 编译主进程（tsc） |
| `npm run build:renderer` | 构建渲染进程（vite） |
| `npm run build` | clean + tsc + vite |
| `npm start` | build 后直接启动 |
| `npm run start:only` | 不构建，直接启动（用已有产物） |
| `npm run dev` | 开发模式（`scripts/dev.mjs`） |
| `npm run smoke` | **自检**：构建后跑无头自检（`scripts/smoke.mjs`） |
| `npm run css:audit` | 样式表审计（只报告）：重复选择器组 / 候选死选择器 |
| `npm run css:stats` | 样式表实测统计（token 数、字号/圆角分布、玻璃与阴影处数） |
| `npm run css:prune` | 预览「永不生效的旧声明」（`-- --apply` 才写文件，自带校验与备份） |
| `npm run dist` | 打 Windows 安装包（NSIS） |
| `npm run dist:dir` | 只产出免安装目录（`release/win-unpacked`） |

---

## 目录结构

```
lis-desktop/
├─ src/
│  ├─ main/                主进程
│  │  ├─ main.ts           入口：窗口、本地协议、生命周期（~240 行）
│  │  ├─ smoke.ts          自检探针（OMNIA_SMOKE=1 才跑；依赖由 SmokeDeps 注入）
│  │  ├─ ipc.ts            IPC 处理（含壁纸扫描 / 转码）
│  │  ├─ db.ts             版本化迁移（v1…v15）与建表
│  │  ├─ xlsx.ts           xlsx 解析 / 写出
│  │  └─ repositories/     各表的数据访问
│  │     └─ playerLookup.ts  成员解析的**唯一实现**（ID→姓名→历史用名）
│  ├─ preload/preload.ts   window.omnia 桥（用 satisfies OmniaApi 与契约对齐）
│  ├─ renderer/src/        渲染进程
│  │  ├─ pages/            页面
│  │  ├─ components/       组件
│  │  ├─ lib/              wallpaper / smoothScroll / localFile 等
│  │  ├─ assets/           应用内图标（透明底 logo.svg）
│  │  ├─ global.d.ts       只声明 window.omnia: OmniaApi（签名以 shared/types 为准）
│  │  └─ styles.css        全部样式（含设计令牌）
│  └─ shared/              主/渲染共用
│     ├─ types.ts          领域类型 + IPC 通道表 + **OmniaApi（唯一契约）**
│     ├─ domain.ts         职业/战术/权重等常量
│     ├─ scoreEngine.ts    评分引擎
│     ├─ signupImport.ts   报名表导入（xlsx 表单）
│     ├─ signupRollcall.ts 报名接龙导入（群文本；与 xlsx 输出同一个预览结构）
│     ├─ statImport.ts     战报导入
│     └─ tableText.ts      表格文本处理
├─ build/                  打包资源
│  ├─ icon.svg             图标矢量源（**黑底圆角**，应用外用）
│  └─ icon.png             512×512（electron-builder 自动生成多尺寸 .ico）
├─ docs/                   打包后自检日志等
├─ scripts/                clean / dev / fix-electron / smoke / css-audit / css-prune 等
│  └─ lib/css-parse.mjs    css-audit 与 css-prune 共用的解析器
├─ DESIGN.md               设计规范 —— **首页（剧场语域）的唯一依据**
├─ DESIGN-APP.md           设计规范 —— **全应用**（两语域 / 全 token / 组件 / Motion）
└─ release/                打包产物（**已在 .gitignore 中**）
```

### 契约只写一份

`window.omnia` 的签名**只在 `src/shared/types.ts` 的 `OmniaApi` 里写一遍**：

- 渲染层：`renderer/src/global.d.ts` 只写 `interface Window { omnia: OmniaApi }`；
- 主进程侧：`preload/preload.ts` 的对象用 `satisfies OmniaApi`，方法漏了/参数对不上会在 `npm run typecheck` 当场报错。

历史教训：这三处曾经各写一份，手抄的那份悄悄漂移（引用了没 import 的类型、`captureRect` 重复声明），而 `skipLibCheck` 让类型检查看不见。

---

## 数据模型

SQLite，**版本化迁移**（`src/main/db.ts`，当前最高 **v15**）。17 张表：

```
rule_set          class             player            player_alias
match             match_side       participation     combat_stat
squad_score       score            app_setting       combat_group
squad             signup           match_squad       schema_migration
```

几个**关键口径**（都是踩过坑之后定下来的）：

| 点 | 说明 |
|---|---|
| **成员只有一个 ID 字段** | ID 与昵称已合并，不再分列 |
| **职业不在主档** | `player` **不持有职业**；职业只来自各场**报名表**，排表时的本场职业写在 `participation.class_used` |
| **落位槽号** | `participation.slot_no`（INTEGER，`-1` = 未指定，按加入顺序排）。落位语义是「点到哪个空位就是哪个」，不是从左往右补 |
| **空 class_used 回退主职** | 查询用 `COALESCE(NULLIF(p.class_used,''), sg.main_class, '')` |
| **橙武判据** | 必须 `=== '有'`；早期写成 `!== ''` 时，「无」会被误判成有橙武 |
| **历史用名** | 改名 = 改 `player.game_id`，旧名进 `player_alias`；战报/报名导入按 `game_id → name → 历史用名` 三级解析，所以改名不会让旧数据"认不出人"。**这条规则的实现只有一处**：`repositories/playerLookup.ts` |
| **对方帮会数据** | `player.is_opp=1`（迁移 v15）+ `participation.side='opp'`：存下来只作对比，不进主档/报名/出勤，也不评分（评分与排表的查询本来就带 `side='our'`） |
| **事务不能嵌套** | `node:sqlite` 里 `BEGIN` 套 `BEGIN` 会抛 `cannot start a transaction within a transaction`（导入流程就踩过）。仓储内部的写操作要用 `SAVEPOINT` 包（见 `PlayerRepo` 的 `private sp()`） |
| **局部更新载荷** | 改字段时**必须把该字段放进更新载荷**——漏字段会「改了不生效且不报错」（`indexInDay` 就栽过） |

---

## 核心业务口径

这些是使用中的实际规则，不是猜测：

- **报名 / 请假导入**：已存在的跳过，缺的自动创建；未填的给提醒；主档里不写职业。
  **两种来源**：表单工具导出的 **xlsx**（`shared/signupImport.ts`）与群里的**接龙**文本
  （`shared/signupRollcall.ts`）—— 两者输出**同一个**预览结构，所以后面「逐行可编辑 → 入库 → 未匹配补建」
  完全是同一条链路。接龙那侧要处理：标题行（`10.10联赛报名` 长得就像第 10 条）、
  状态/名字/职业全粘在一起、隐形字符、职业简称（`90`/`素`/`玄`/`沧`…），
  以及带上下文的「鸿」（同条里另一个职业是奶 → 妙音，否则 → 惊鸿；`奶鸿` 两个字算一个职业＝妙音）。
  拿不准的一律进**预览里的提示清单**，不静默猜（用户口径：导入过后可以检查修改）。
- **历史用名**：成员主档里每人可记多个旧名。改了 ID 时旧 ID **自动进历史用名**；战报/报名表里写旧名一样能对上人（战报会标 `ALIAS_MATCH` 提示）。名单导入时若文件名命中某人的历史用名，视为「他又改名了」→ 自动把当前 ID 升到导入文件里的名字，旧名留档。
- **候选规则**：主档有 → 报名有 → 才显示状态；两者都没有则不显示。孤儿 ID 进复核列表，支持一键补建。
- **二职（副职）**：一个成员可以同时有主职与二职，排表时二者都能选；卡片上点职业就在两者间切换（只有一个职业时只轻微抖动，不弹选择器）。
- **排表落位**：点空格子 → 弹选择器 → 落到**被点的那一格**。
- **跨小队拖拽**：拖到别的小队时，落点 = **离松手位置最近的那个格子**。
- **拖动换序**：编号恒为连续的 1…N，改序走「插入语义」，不会撞号。
- **「当天第几场」**：新建对局时**留空 = 自动取当天已有场次的最大值 + 1**。
- **评分快照会失效**：战报被改/被清、参战记录被删之后，本场已保存的分数就是**旧快照**了。
  实现：迁移 v16 给 `match` 加 `score_stale`，写战报的入口置 1、算分时清零；
  评分页看到就提示「数据已变，请重算」并给一键重算。**不自动重算** —— 录一半就重算会刷出一堆没意义的分。
- **对方数据只作对比**：不进成员主档 / 报名 / 出勤，也不参与评分；
  对比一律看**人均**（双方人数常不一样）且**只统计已录战报的人**（否则我方没录战报的人会把人均拉低）。

### 多帮会（一帮会一个独立库）

用户口径 2026-09：「点击什么帮会才能进入某帮会整个数据库」「不同帮会的数据库独立存放（排表 / 个人 / 战局等信息）」。

**存储**

```
<userData>/guilds.json                 帮会注册表（名称 / 封面 / 备注 / 库文件名 / 创建时间 / activeId）
<userData>/guilds/<id>.db              该帮会的整套数据（成员、对局、排表、战报、评分…）
<userData>/guilds/<id>/cover.png       封面图（本地选图后**拷贝**进来，原图删了也不影响）
```

- 现有库（`<userData>/lis.db`）在首次启动时**整体迁移**成名为「霜序客」的第一个帮会，原文件留一份 `.bak` 保底。
- `OMNIA_DB_PATH` 仍然直连单库（自检 / 开发用），**不走帮会注册表**。

**导航（用户口径 2026-09-27）**

- 一级页签 3 个：`总览`（维持现状）· `帮会` · `设置`
- `帮会` 页 = 帮会选择：**竖向高卡片、向右横向滚动**，末尾一张 `＋ 新建帮会`；封面图没有就用帮会名的大字底
- **点进某个帮会**才有 5 个二级页签：`帮会首页（介绍）` · `成员主档` · `对局与战报` · `排表` · `数据看板`
- 切帮会**不重启应用**：仓储通过"当前库提供者"拿连接，切换时只换句柄

---

## 界面体系

### 自绘控件（替换原生）

原生 `<select>` / `<input type="date">` / `window.confirm` 的弹层由**操作系统绘制**，CSS 改不了，因此三者都已自绘：

| 原生 | 替代 | 位置 |
|---|---|---|
| `<select>` | `components/Select.tsx` | 全站 25 处 |
| `<input type="date">` | `components/DatePicker.tsx` | 对局相关表单 |
| `window.confirm` | `components/Confirm.tsx` | 7 处 |

三者共用同一套**展开/收起动画**（`unfold` / `fold` 关键帧，`clip-path` 驱动），展开与收起**两个方向都有过渡**。

### 视觉分层

- **三层卡片**：一级磨砂半透明 → 二级白色半透明 → 三级纯白
- **弹层层级**：`.modal` 300 / `.cfm` 400 / 下拉 150（都高于侧栏 40）
- **侧栏**：覆盖式收起，只动 `transform`（合成器属性），保持 60fps

### ⚠️ 两条样式陷阱（改样式前务必知道）

1. **主题前缀会提高特异性**：`.theme-light` / `.page-fill` 这类前缀让规则更具体，覆盖它们必须**带同样的前缀**，只写单个类名 + `!important` 是压不住的。
2. **自绘弹层所在的那一层必须抬层级**：否则会被后面的行盖住，表现为「下拉是白的、点了没反应」。用 `:has(.sel[open])` 抬——**不要写成 `:has(> .sel[open])`**（直接子代匹配不上嵌套的控件）。

### 壁纸

全页面背景，非卡片区域为壁纸。支持动态（mp4 / gif / webp / png）与静态；可从本机壁纸库扫描（默认取 Wallpaper Engine 工坊目录）；渲染模式（动态 / 静态帧 / 关闭）、声音（默认静音）、适应方式（铺满裁剪 / 完整缩放 / 拉伸铺满）。mp4 首次使用会用 ffmpeg 转码缓存到 `userData/wallpaper-cache`。

### 图标（两份资源，别搞混）

| 用途 | 文件 | 形态 |
|---|---|---|
| **应用内**（侧边导航等） | `src/renderer/src/assets/logo.svg` | **透明底** + 白描边（浅色主题下靠细描边保证可见） |
| **应用外**（exe / 任务栏 / 安装包） | `build/icon.svg` → `build/icon.png` | **黑底圆角** `rx=18` |

> 开发模式下任务栏图标取自 `build/icon.png`（主进程的 `DEV_ICON`）；打包后由 exe 的嵌入图标负责。

---

## 自检

```bash
npm run smoke
```

`scripts/smoke.mjs` 会启动无头 Electron，逐项验证：数据库迁移、报名导入、排表落位、战报、评分引擎、看板、首页主视觉与钉住、图标加载、主题色等。**构建产物会被真实验证**，不是纯逻辑测试。

- 探针代码是**纯 JS**（通过 `executeJavaScript` 注入），**不参与类型检查**——里面不能写 TS 语法或模板字符串。
- 个别项（如「截取图片」「评分引擎」）历史上**偶发失败**，复跑即过；连续失败才算真问题。

---

## 打包与发布

```bash
# 需要镜像（否则 electron-builder 下载会超时）
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'

npm run dist
```

产物：`release/Omnia-Setup-<version>.exe`（NSIS，装到当前用户，可自选目录）。

### 发布

安装包**不要提交进 git**（`release/` 已在 `.gitignore`；且 GitHub 单文件上限 100 MB，收紧后约 110 MB 会被直接拒绝）。

正确做法是走 **GitHub Releases**：建 tag（如 `v0.2.0`），把 `Omnia-Setup-0.2.0.exe` 作为 release asset 附上。

---

## 已知问题与待办

- **安装包尚未在干净机器上端到端装过**（会写注册表 + 开始菜单，装到当前用户）。
- **自检偶发**：个别探针项会随机失败一次，复跑通过。
- **Windows 会缓存任务栏图标**：换了图标后若没更新，把旧图标取消固定再固定一次。

### 待办（用户口径，按顺序推进）

1. **跨帮会：不同帮会的数据各自独立存放**（排表 / 个人 / 战局等）—— 用户 2026-09 明确说"后续开发"。
   进度（选项 A，已落地）：
   - 一次对局导出里混着两个帮会时，能对上主档的行走**我方**（`participation.side='our'`）；
     对不上的行按导入面板的勾选**存为对方**：`player.is_opp=1` + `side='opp'`（迁移 v15）。
   - 对方数据"只是躺着"：不进成员主档 / 报名表 / 出勤统计，也不参与评分
     （评分、排表、出勤的查询本来就带 `side='our'`），导入面板与 xlsx 向导默认勾选"存下对方数据"。
   - 对方按**名字跨场次复用**同一条记录（`PlayerRepo.upsertOpponent`），便于后续横向对比。
   ⚠️ 仍缺**对比视图**（本帮 vs 对方同位置/同职业的战报对比），以及"每个帮会一套独立数据库"。
   将来要按帮会分库时，`player.is_opp` 就是迁移到 `guild_id` 的现成依据。
2. **职业「鸿音」按奶量分流** —— 已实现（`statImport.resolveHongyin`）：
   本场治疗值 > 500 万 → 妙音，否则 → 惊鸿。字段/阈值常量在同文件顶部，要调只改一处。
3. 排表页每个小队的**人数上限 UI 入口**（后端 `setSquadSize` + IPC 都已就绪，只差界面）。

### 上一轮残留 —— 2026-10-08 已处理

| 原残留 | 处理 |
|---|---|
| 战报导入的**行循环无事务** | ✅ 循环收进仓储层：`MatchRepo.importStats()` 用一个 SAVEPOINT 事务包住整批，任一行写失败 → 整批回滚。自检新增 **M3c 原子性探针**（中途失败后库里必须一条不剩） |
| 自检里**目录穿越探针恒真** | ✅ 原来字面 `..` 被 URL 解析器归一化，实际指向一个**不存在**的目录 → 删掉守卫也照样 PASS。改用 `%2e%2e%2f`（斜杠一起编码，解析器不会折叠），并且要求"若不拦就会命中一张真实存在的图"，探针才不再是空转 |
| 样式表里 49 组重复选择器 + 永不生效的旧声明 | ✅ 判据脚本化：`npm run css:audit`（重复选择器组 / 候选死选择器）+ `npm run css:prune`（永不生效声明，逐条列出、`--apply` 才写、自带括号/注释/声明数自校验与备份）。**逐条判死，不做批量删** |

### 仍在的残留

- **`npm run build` 曾会连 `release/` 一起删**（安装包在 `release/`，而它在 .gitignore 里 → 删了找不回）。
  2026-10-08 已修：`clean` 默认只清 `dist`，要清 `release` 用 `npm run clean:release`（`dist` 脚本已接上）。
- 样式表里仍有约 4 组「笔误候选」需要人拍板才能删（脚本只报告不删）：
  `.mcard__media` 重复 `background`（后者胜，可删前一条）·
  `.md-bg video, .md-bg img` 重复两条 `mask-image`（后者胜 = 现在的"黑区旋钮"，可删前一条）·
  ~~`.mcard__body{position:relative}` 吃掉 4 处 `absolute`~~ → **2026-10-10 已修**：
  那条规则连带把 `.mcard__order/__tri/__more/__quick` 改成 relative，行内 span 宽高归零
  → 卡片上的状态 / 麦克风三角标整块消失（用户截图报障）。现在只给 `.mcard__body` 加定位。
  `.sel__btn` 的磨砂被后一条改回不透明（要恢复磨砂得改后面的）
- 安装包尚未在干净机器上端到端装过；自检个别项偶发失败，复跑即过。

### 本项目的编码经验（省时间用）

- `node -e` 里带中文 / 花括号 / 反斜杠，在 PowerShell 下容易被转义搞坏；**写成 `.cjs` 文件再 `node` 执行**更稳。
- PowerShell here-string 的结束标记是 `'@`，所以脚本里**不能有以 `'@` 开头的行**（例如 CSS 的 `@keyframes`）。
- 竞态类问题（"偶发、时好时坏"）**不要用"事后补一次"去修**：先把并发的两条路径合并到同一次提交里。
- ⚠️ **绝对不能对含中文的源文件用 `Set-Content` / `Out-File` 覆盖写**。
  Windows PowerShell 5.1 的默认编码是 ANSI(CP936)，用它改写 UTF-8 源码会把中文
  变成 `鈹€` 这类**双重编码乱码**，而且过程**有损**（部分字节被替换成 `?`，无解回不去）。
  本项目实际栽过：`styles.css` 被整文件写坏，只能从 git 取原版 + 重打改动才恢复。
  正确做法（任选其一）：
  - 用编辑工具改文件，不要用 shell 覆盖写；
  - 必须用 shell 写时走 .NET 且显式指定编码：
    `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`；
  - 写完后**必须验证**：`New-Object System.Text.UTF8Encoding($false,$true)` 严格解码一次，
    通不过就说明文件已坏。
- 用 .NET 静态方法（`[System.IO.File]::ReadAllBytes` 之类）时，**相对路径以进程工作目录为准**，
  不是 `cd` 之后的目录；一律传绝对路径，否则会得到"找不到路径"的假报错。

---

## 个人主页（成员详情）重构规格 —— 待实现

用户口径 2026-09-27（逐条累积，实现时按此为准）：

### 背景媒体
- 每个成员可上传一段 **mp4** 或一张**图片**（成员设置/侧边抽屉里选）
- 文件拷进 `guilds/<帮会>/players/<成员>/bg.<ext>`（单库模式落 `userData/media/players/<id>/`），库里只记绝对路径
- **没设置就用默认背景**（= 全局壁纸层透出来）
- 除顶部导航栏外，整页背景都是这个图/视频

### 第 1 屏（与首屏同一套语言）
- 全屏播放背景媒体 + **渐变黑**（与首屏同黑值）
- 左下角：**大字号 ID**
- 其上：**自定义介绍**（`player.intro`）—— **固定 3 行排版、字号最小（12px）**
- 其上：**个性签名**（`player.signature`）—— 单独一段
- 最上：**橙武标**（仅橙武=有时显示；字号 = 介绍 **+2px（14px）**，金色渐变 + 细描边 + 柔光，**显眼、有高级感**）
- 职业 / 状态 / 麦克风 / 备注角色 / 入帮序 **不放第 1 屏**，放后面的屏

### 第 2 屏起
- **多屏 + 滚动翻页吸附**（scroll-snap，一屏一屏翻）
- 内容：属性行（职业/状态/麦克风/备注角色/入帮序）· 雷达对比 · 团队人均 · 逐场明细
- **不要卡片**：内容直接铺在背景上；**不要分割线**；靠留白 / 字号层级 / 渐变压暗分区，左对齐、边距合理

### 色调
- 第 1 屏 → 第 2 屏起是**连续渐变**（越往下越暗，用一层整页渐变覆盖），**不做硬切**，因此也不会出现分界线

### 数据字段（已实现）
| 字段 | 迁移 | 说明 |
|---|---|---|
| `player.bg_media` | v17 | 背景媒体绝对路径，空 = 默认背景 |
| `player.signature` | v18 | 个性签名 |
| `player.intro` | v19 | 自定义介绍（第 1 屏 3 行小字） |

IPC：`player:pick-bg` / `player:set-bg` / `player:clear-bg`（已进 types → preload → api）
