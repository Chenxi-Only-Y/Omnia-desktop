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
│  │  ├─ src/lib/importer.ts  成员名单 CSV/TSV 解析与导出（含旧表列名映射）
│  │  ├─ src/pages/            总览 / 成员主档 / 对局与战报 / 待接入页
│  │  │                        MatchDetail.tsx = 阵容编排 + 战报网格 + 批量导入
│  │  └─ src/styles.css        主题与 12 职业色令牌
│  └─ shared/                  双端共享
│     ├─ domain.ts             领域常量（职业/小队/对局/战报字段/权重）
│     ├─ types.ts              实体类型 + IPC 契约
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
| **M8 视觉资产** | ✅ 11 个职业图标已接入界面（惊鸿缺素材）；首页立绘与 13 张攻略图仍待接入 |
| M5 阵容编排 | 🔶 小队结构与分配已可用（在「对局与战报 → 阵容编排」页签内），独立拖拽式编排器待做 |
| M6 数据看板 | ⬜ 待评分算法确定 |
| M7 与旧 xlsx 双向互通 | 🔶 CSV/TSV 导入导出已完成，xlsx 直读待做 |
| M1/M4 评分引擎与规则中心 | ⬜ **算法由用户后续决定**；`ScoreEngine` 接口与 `rule_set` 表已预留 |

### 自检覆盖范围（`npm run smoke`）

- 全链路：renderer → preload（`window.omnia`）→ IPC → SQLite
- 成员主档：create / update / remove / 列表计数一致 / 重复角色 ID 被拦
- 对局与战报：建对局 → 粘贴导入解析 → 严格模式校验（不在档 + 重复行报错）→ 有错误时拒绝入库 → 完整模式自动建档入库 → 读回校验数值 → 对局列表统计
- 视觉资产：职业图标在 `file://` 下真实加载（校验 `naturalWidth`）且页面上有渲染

### 关键设计文档

- `../LIS设计基准v2.md` —— 18 项决策日志 + 评分算法规范 + 数据模型
- `../LIS系统识别报告v2.md` —— 原表的完整逆向识别（含算法与缺陷清单）
