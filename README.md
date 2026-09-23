# 万象·Omnia

> **All leagues. One universe.**
> 万象归一，联赛集成。

联赛集成系统的桌面应用：报名、排表、战报、评分、出勤集中在同一处完成。

- 前身是一份 Excel 工作簿（`LIS 联赛集成系统v1.0`），本项目是对它的完整重做。
- 数据落在本机 SQLite（`node:sqlite`，**不依赖 better-sqlite3**）。
- 界面是 Electron + React，深色玻璃主题；视觉规范见根目录 `DESIGN.md`。

当前版本：**v0.1.1**

---

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
| **总览** | 首屏大图 + 快捷入口；下滑显示数据层（成员总数、本场可上阵、每方塔数、比分） |
| **成员主档** | 成员列表（ID / 报名状态 / 在队状态 / 麦克风 / 备注角色 / 橙武 / 备注）；新增 / 编辑 / 删除 / 详情；拖动换序；定位 ID |
| **报名与请假** | 从报名表导入；候选规则；未填表提醒；孤儿 ID 一键补建；请假者折叠展示 |
| **排表** | 战斗组 → 小队 → 位置格；落位到指定格；跨小队拖拽；主职⇄二职切换；职业来自报名表；橙武卡片特效 |
| **对局与战报** | 新建对局（含「当天第几场」）；对局列表；战报导入与完整度 |
| **评分** | 评分引擎（`src/shared/scoreEngine.ts`）与评分面板 |
| **数据看板** | 场次 / 成员 / 参战记录 / 场均上场 / 出勤 / 职业出场 / 小队使用 / 治疗值覆盖 |
| **赛季与规则** | 赛季模块、权重与规则 |
| **设置** | 壁纸（动态 / 静态帧 / 关闭，适应方式、静音）、壁纸库地址、战斗组与小队 |

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
| `OMNIA_DB_PATH` / `LIS_DB_PATH` | 指定数据库文件路径（自检与多库测试用） |

实际数据库默认落在 `%APPDATA%\omnia-desktop\lis.db`。

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run clean` | 清理构建产物 |
| `npm run typecheck` | 类型检查（主进程 + 渲染进程两套 tsconfig） |
| `npm run build:node` | 编译主进程（tsc） |
| `npm run build:renderer` | 构建渲染进程（vite） |
| `npm run build` | clean + tsc + vite |
| `npm start` | build 后直接启动 |
| `npm run start:only` | 不构建，直接启动（用已有产物） |
| `npm run dev` | 开发模式（`scripts/dev.mjs`） |
| `npm run smoke` | **自检**：构建后跑无头自检（`scripts/smoke.mjs`） |
| `npm run dist` | 打 Windows 安装包（NSIS） |
| `npm run dist:dir` | 只产出免安装目录（`release/win-unpacked`） |

---

## 目录结构

```
lis-desktop/
├─ src/
│  ├─ main/                主进程
│  │  ├─ main.ts           窗口、生命周期、自检探针
│  │  ├─ ipc.ts            IPC 处理（含壁纸扫描 / 转码）
│  │  ├─ db.ts             版本化迁移（v1…v11）与建表
│  │  ├─ xlsx.ts           xlsx 解析
│  │  └─ repositories/     各表的数据访问
│  ├─ preload/preload.ts   window.omnia 桥
│  ├─ renderer/src/        渲染进程
│  │  ├─ pages/            12 个页面
│  │  ├─ components/       14 个组件
│  │  ├─ lib/              wallpaper / smoothScroll 等
│  │  ├─ assets/           应用内图标（透明底 logo.svg）
│  │  └─ styles.css        全部样式（含设计令牌）
│  └─ shared/              主/渲染共用
│     ├─ types.ts · domain.ts
│     ├─ scoreEngine.ts    评分引擎
│     ├─ signupImport.ts   报名表导入
│     ├─ statImport.ts     战报导入
│     └─ tableText.ts      表格文本处理
├─ build/                  打包资源
│  ├─ icon.svg             图标矢量源（**黑底圆角**，应用外用）
│  └─ icon.png             512×512（electron-builder 自动生成多尺寸 .ico）
├─ docs/                   打包后自检日志等
├─ scripts/                clean / dev / fix-electron / smoke 等
├─ DESIGN.md               设计规范
└─ release/                打包产物（**已在 .gitignore 中**）
```

---

## 数据模型

SQLite，**版本化迁移**（`src/main/db.ts`，当前最高 **v11**）。16 张表：

```
season            rule_set         class             player
match             match_side       participation     combat_stat
squad_score       score            app_setting       combat_group
squad             signup           squad_alias       schema_migration
```

几个**关键口径**（都是踩过坑之后定下来的）：

| 点 | 说明 |
|---|---|
| **成员只有一个 ID 字段** | ID 与昵称已合并，不再分列 |
| **职业不在主档** | `player` **不持有职业**；职业只来自各场**报名表**，排表时的本场职业写在 `participation.class_used` |
| **落位槽号** | `participation.slot_no`（INTEGER，`-1` = 未指定，按加入顺序排）。落位语义是「点到哪个空位就是哪个」，不是从左往右补 |
| **空 class_used 回退主职** | 查询用 `COALESCE(NULLIF(p.class_used,''), sg.main_class, '')` |
| **橙武判据** | 必须 `=== '有'`；早期写成 `!== ''` 时，「无」会被误判成有橙武 |
| **局部更新载荷** | 改字段时**必须把该字段放进更新载荷**——漏字段会「改了不生效且不报错」（`indexInDay` 就栽过） |

---

## 核心业务口径

这些是使用中的实际规则，不是猜测：

- **报名 / 请假导入**：已存在的跳过，缺的自动创建；未填的给提醒；主档里不写职业。
- **候选规则**：主档有 → 报名有 → 才显示状态；两者都没有则不显示。孤儿 ID 进复核列表，支持一键补建。
- **二职（副职）**：一个成员可以同时有主职与二职，排表时二者都能选；卡片上点职业就在两者间切换（只有一个职业时只轻微抖动，不弹选择器）。
- **排表落位**：点空格子 → 弹选择器 → 落到**被点的那一格**。
- **跨小队拖拽**：拖到别的小队时，落点 = **离松手位置最近的那个格子**。
- **拖动换序**：编号恒为连续的 1…N，改序走「插入语义」，不会撞号。
- **「当天第几场」**：新建对局时**留空 = 自动取当天已有场次的最大值 + 1**。

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

正确做法是走 **GitHub Releases**：建 tag（如 `v0.1.1`），把 `Omnia-Setup-0.1.1.exe` 作为 release asset 附上。

---

## 已知问题与待办

- **安装包尚未在干净机器上端到端装过**（会写注册表 + 开始菜单，装到当前用户）。
- **自检偶发**：个别探针项会随机失败一次，复跑通过。
- **Windows 会缓存任务栏图标**：换了图标后若没更新，把旧图标取消固定再固定一次。

### 本项目的编码经验（省时间用）

- `node -e` 里带中文 / 花括号 / 反斜杠，在 PowerShell 下容易被转义搞坏；**写成 `.cjs` 文件再 `node` 执行**更稳。
- PowerShell here-string 的结束标记是 `'@`，所以脚本里**不能有以 `'@` 开头的行**（例如 CSS 的 `@keyframes`）。
- 竞态类问题（"偶发、时好时坏"）**不要用"事后补一次"去修**：先把并发的两条路径合并到同一次提交里。
