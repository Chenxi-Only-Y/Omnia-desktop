# 万象·Omnia

**All leagues. One universe.**
**万象归一，联赛集成。**

联赛集成系统 · 桌面端。前身是 `LIS 联赛集成系统 v1.0`（WPS 表格），现重建为 Electron + 本地 SQLite 的原生应用。

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 外壳 | Electron 37 | 单实例锁、contextIsolation、外链走系统浏览器 |
| 数据库 | **`node:sqlite`（Electron 内置）** | 刻意不用 `better-sqlite3`：原生模块需为 Electron ABI 重编译并依赖 VS Build Tools，是部署链上最大的不确定因素。仓储层已隔离，换实现只改 `src/main/db.ts` 的 `loadSqlite()` |
| 界面 | React 19 + Vite 6 | 暗色主题，12 职业色板取自原表「下滑预选」 |
| 语言 | TypeScript 5（strict） | 主进程 CommonJS，渲染层 ESM，共享层 `src/shared` 双端复用 |

---

## 快速开始

```bash
npm install
npm run dev      # 开发：Vite HMR + Electron
npm start        # 生产：构建后启动
npm run smoke    # 自检：跑通 renderer→preload→IPC→SQLite 全链路并验证增删改
```

### ⚠️ 首次安装后如果启动报 “Electron failed to install correctly”

npm 11 **默认不执行依赖的 postinstall 脚本**，且本环境下 Electron 自带的 `extract-zip` 会静默失败（只解出 `locales/` 就退出），导致 `node_modules/electron/dist/electron.exe` 不存在。

`npm install` 的 `postinstall` 会自动修复。若被拦截，手动执行：

```bash
npm run fix:electron
```

该脚本会：查缓存 zip → 用系统解压能力展开到 `node_modules/electron/dist` → 写入 `path.txt`。
若缓存也没有 zip，先设镜像再执行：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules\electron\install.js   # 只下载到缓存
npm run fix:electron                    # 再展开
```

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式（Vite 5173 + Electron） |
| `npm run build` | 清理并构建主进程 / 预加载 / 渲染层 |
| `npm start` | 构建并启动 |
| `npm run typecheck` | 两套 tsconfig 全量类型检查 |
| `npm run smoke` | 端到端自检（含 DB 写入往返、重复 ID 拦截） |
| `npm run dist` | 打包 Windows 安装包（NSIS）到 `release/` |

### 环境变量（开发用）

| 变量 | 作用 |
|---|---|
| `OMNIA_DB_PATH` | 指定数据库文件路径（默认 `<userData>/lis.db`） |
| `OMNIA_DEV_SERVER_URL` | 连 Vite dev server |
| `OMNIA_SMOKE=1` | 自检模式：加载完成后探针全链路并退出 |

> 旧的 `LIS_*` 前缀仍兼容（`LIS_DB_PATH` / `LIS_DEV_SERVER_URL` / `LIS_SMOKE`）。

---

## 目录结构

```
lis-desktop/
├─ src/
│  ├─ main/                    主进程
│  │  ├─ main.ts               入口：窗口、单实例、自检模式
│  │  ├─ db.ts                 node:sqlite 封装 + 版本化迁移
│  │  ├─ ipc.ts                IPC 契约实现（统一 IpcResult 包装）
│  │  └─ repositories/
│  │     └─ playerRepo.ts      成员主档仓储（按 game_id 幂等导入）
│  ├─ preload/preload.ts       暴露 window.omnia
│  ├─ renderer/                React 界面
│  │  ├─ public/class-icons/   11 个职业图标（原表 DISPIMG 导出，public 原样拷贝）
│  │  ├─ src/App.tsx           导航外壳
│  │  ├─ src/api.ts            IpcResult 解包封装
│  │  ├─ src/components/       可复用组件
│  │  │   LineupBoard.tsx      排表看板（含原生拖拽排表）
│  │  │   ImportWizard.tsx     xlsx 导入向导（选表/探表头/预览）
│  │  │   StatImportPanel.tsx  战报批量导入（粘贴/CSV/校验）
│  │  │   CellPicker / AddPlayerPicker / ClassChip
│  │  ├─ src/lib/              importer / sheet / assets
│  │  ├─ src/pages/            总览 / 成员主档 / 对局与战报 / 数据看板 / 设置
│  │  └─ src/styles.css        主题与 12 职业色令牌
│  └─ shared/                  双端共享
│     ├─ domain.ts             领域常量（职业/对局/战报字段/权重）
│     ├─ types.ts              实体类型 + IPC 契约
│     ├─ tableText.ts          成员名单列名映射与 CSV 导出
│     └─ statImport.ts         战报解析与校验（纯函数，可单测）
└─ scripts/                    clean / dev / smoke / fix-electron
```

---

## 当前进度

| 模块 | 状态 |
|---|---|
| **M0 骨架**（窗口 / 数据库 / 迁移 / IPC / 主题令牌） | ✅ 完成，自检 PASS |
| **M2 成员主档**（增删改查 / 导入导出 / 职业字典与别名映射） | ✅ 完成 |
| **M3 对局与战报**（对局 5 字段 + 单人 14 字段 + 粘贴导入 + 校验） | ✅ 完成，自检 PASS |
| **M5 阵容编排（排表看板）** | ✅ 版式对齐原表「排表」页：每小队 6 人 × 5 行、职业色块+图标、组间留隙、左右半区中缝；**支持拖拽排表**（拖姓名换小队、拖到「未分配」区移出，落库为单事务）；建制数据驱动（战斗组可新增，组内第 N 队自动命名 `组名-N`） |
| **M6 数据看板** | ✅ 出勤明细（上场/替补/请假/出勤率）、战报完整度（逐场 + 逐维度覆盖）、职业出场与小隊使用 —— **不含评分**（等算法） |
| **M8 职业图标** | ✅ 11 个图标接入界面（惊鸿缺素材） |
| **攻略图库** | ✅ 13 张原表攻略图接入：分类筛选（配装总览 2 / 装备选择 7 / 加点方案 2 / 流派立绘 2）、点击放大灯箱、装备卡速查表（装等/装评照抄卡面）、4 组文字要点；首页用三职业立绘卡做视觉 |
| **设置页** | ✅ 战斗组与小队增删（组下有小队时禁止删组）、建制容量、数据库路径 |
| **成员详情页** | ✅ 个人汇总（上场/替补/请假、战报完整度、有效击杀/人伤/塔伤、治疗/承伤、重伤/复活）、**六维雷达**（个人场均 vs 球队人均，虚线基准圈=1.0）、逐场趋势柱、逐场明细 |
| **报名 / 请假** | ✅ 报名与上场名单分离（意愿 vs 排表结果，允许不一致）、逐人标记参加/替补/请假/撤回、未报名清单与批量标参加、一键按报名更新上场名单 |
| **权重与规则中心** | ✅ 规则集版本化（新建/另存/切换使用中/删除保护）、分制常数、个人权重（按定位）、战术权重（按类型）、12 职业系数、附加分，**带实时校验**（权重和≠1、封顶<基础、系数为负等分级提示）与导出 JSON。**只做参数管理，未接评分** |
| M7 与旧 xlsx 互通 | ✅ **xlsx 直读/直写 + 应用内导入向导**（自写 OOXML 解析，无第三方依赖）；成员与战报都能直接选旧表文件导入 |
| **M1 评分引擎** | ✅ 可插拔纯函数引擎：口径全部读「使用中」的规则集，不写死参数；战术执行分按类型分别计算并只在同类型小队间归一；中间量全部落库可审计；支持重算、按规则集并存、幂等。**口径为可标定实现，等你给正式算法或直接改规则** |
| 打包发布 | ✅ NSIS 安装包（88.8MB）已产出，**打包后 9 项自检全 PASS**（asar + `node:sqlite` + 图标资源） |
| 首页主视觉 | 🔶 用户要求「大图/立绘为主视觉」；原表首页大图实测为空图，现用渐变+品牌字+职业图标阵占位，拿到立绘后填 `HERO_IMAGE` 即切换 |

### 建制结构（用户口径，非猜测）

```
10 个战斗队 × 6 人 = 60 个上场槽位
划归 4 个战斗组：防守一 / 防守二 / 进攻一 / 进攻二（可新增）
组内第 N 队命名 = 组名-N，例：防守二有 3 队 → 防守二-1 / -2 / -3
替补 / 请假 = 状态（三选一），不占战斗组
```

> 迁移脚本当前预置 12 支小队（4 组 × 3 队 = 72 槽位）。若实际只有 10 队，
> 可在「设置 → 战斗组与小队」删掉多余的 2 支，或在下一轮直接把种子改成 10 队。

### 自检覆盖（`npm run smoke`）

- 全链路：renderer → preload（`window.omnia`）→ IPC → SQLite
- M2：create / update / remove / 列表计数一致 / 重复角色 ID 被拦
- M3：建对局 → 粘贴导入解析 → 严格模式校验（不在档 + 重复行报错）→ 有错误拒绝入库 → 完整模式自动建档入库 → 读回校验数值
- M5：建制读取（组/队/容量）→ 新增战斗组与小队的自动命名 → 排表看板真实渲染（方块数、小队名、职业图标）→ **用原生拖拽事件驱动看板，验证队员真的换了小队且战术自动推导**
- M6：造 2 场对局 3 名成员 → 校验统计口径（上场人次、战报完整度、出勤率、职业出场、小队使用）→ 首页主视觉与看板页/设置页真实渲染
- M7：用真实旧表走「列工作表 → 探测表头行 → 网格 → TSV → 列名映射」全链路（无样本时该项 SKIP）
- M8：职业图标在 `file://` 下真实加载（校验 `naturalWidth`）并在页面上渲染
- 成员详情：造 2 场对局验证汇总口径（有效击杀 33 / 有效人伤 2300 / 有效塔伤 500）、
  未填战报的场次只计出勤不计数值、雷达轴计算与 SVG 渲染（2 个多边形 + 6 个轴标签）
- 评分引擎：6 人实测（区间 71.81~94.39、互不相同、分解合计=总分）、幂等重算、行数不变、
  **改规则会改分**（死亡扣分 3→15 时 71.81→29.81）、两套规则分数并存、评分页渲染与明细展开

### 用旧表验证导入（可选）

```powershell
$env:OMNIA_SAMPLE_XLSX='D:\AI\ds.5\work\LIS_original.xlsx'   # 指向旧表
npm run smoke
```

不设该变量时 M7 会 SKIP；设了就断言：10 张工作表、79 名成员、成员表表头在第 5 行、
战报表头在第 6 行、`击败/清泉` 复合列与 `焚骨` 能识别、不存在的表名必须报错。

> **实测事实（重要）**：旧表的「信息数据库」**不含职业列**（D 列 79 行全空），
> 职业信息只存在于「数据导入」战报表。因此从该表导入成员后主职业为空是**预期行为**，
> 需要靠战报导入或手工补齐。成员表实际可用列：C 角色ID(79) / I 麦(73) / L 备注角色(11)。

---

## 打包与安装验证

```powershell
npm run dist          # 出 NSIS 安装包 → release/Omnia-Setup-<version>.exe
npm run dist:dir      # 只出免安装目录 → release/win-unpacked/
```

打包后**必须再跑一次自检**（验证 asar 路径、`node:sqlite` 与渲染资源）：

```powershell
$env:OMNIA_SMOKE='1'
$env:OMNIA_DB_PATH="$PWD\dev-data\packaged.db"
$env:OMNIA_SMOKE_LOG="$PWD\dev-data\packaged-smoke.log"
& 'release\win-unpacked\万象Omnia.exe' -Wait
Get-Content .\dev-data\packaged-smoke.log
```

> 打包后的 Windows 程序没有控制台，stdout 拿不到日志，所以自检会把全部输出写进
> `OMNIA_SMOKE_LOG`（默认 `<数据库同目录>/omnia-smoke.log`）。
> 仓库里留了一份历次通过的证据：`docs/packaged-smoke.log`。

实测结论（0.1.0）：安装包 88.8MB；打包后 9 项自检全 PASS；
`M8 图标 base = .../app.asar/dist/renderer/` 说明资源与内置 `node:sqlite` 在打包环境下均正常。

### xlsx 模块自测

```bash
node scripts/test-xlsx.mjs   # 读真实旧表 + 写入读回往返
```

覆盖真实旧表的坑：稀疏行（首行是第 5 行）、自闭合单元格、共享字符串、复合列（`击败/清泉`）、表头不在第一行（`headerRow`）。

### 关键设计文档

- `../LIS设计基准v2.md` —— 18 项决策日志 + 评分算法规范 + 数据模型
- `../LIS系统识别报告v2.md` —— 原表的完整逆向识别（含算法与缺陷清单）
