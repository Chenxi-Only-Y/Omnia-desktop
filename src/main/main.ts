/**
 * 万象·Omnia —— Electron 主进程入口
 *
 * 数据库位置：<userData>/lis.db（可用 OMNIA_DB_PATH / LIS_DB_PATH 覆盖，便于开发与测试）
 * 渲染层：开发时连 Vite dev server（OMNIA_DEV_SERVER_URL），生产时加载本地文件
 */
import { app, BrowserWindow, dialog, shell, nativeTheme, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { registerIpc } from './ipc';
import { GuildStore } from './guilds';
import { runSmokeTest } from './smoke';

/** 编译后本文件位于 dist/main/main.js，应用根目录是上一级的上一级 */
const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIST = path.join(APP_ROOT, 'dist', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

/* ── 本地文件协议：omnia://local/<绝对路径> ──────────────────────────
 *
 * 为什么必须有它：`npm run dev` 时页面来源是 http://127.0.0.1:5173，
 * 而 Chromium **禁止 http 源读取 file:// 资源 —— 且这不是 CSP 能放的**
 * （实测：http 源下改 CSP 加 `file:` 依然 BLOCKED；file 源下同一张图 PASS）。
 * 于是开发模式下壁纸缩略图与全局壁纸全是空白，而打包后（file 源）却正常，
 * 形成「打包能用、开发不能用」的假象。
 *
 * 修法：把本地文件用一个**自定义特权协议**暴露出去。它仍受页面 CSP 管
 * （`img-src`/`media-src` 必须显式放行 `omnia:`），所以比关掉 webSecurity 安全。
 * 实测：http 源 + CSP 放行 omnia: → 图片 OK 200。
 *
 * 用 omnia: 而不是 app:：`app` 是 Electron 的保留模块名，避免歧义。
 */
const LOCAL_SCHEME = 'omnia';

// 特权协议必须在 app ready 之前声明
protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** 挂上 omnia: 的处理器：只服务本机绝对路径，挡住目录穿越 */
function registerLocalProtocol(): void {
  protocol.handle(LOCAL_SCHEME, (req) => {
    try {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      // 只接受盘符开头的绝对路径（Windows）或 / 开头的绝对路径（其它平台）
      const ok = /^[a-zA-Z]:\//.test(rel) || (process.platform !== 'win32' && rel.startsWith('/'));
      if (!ok || rel.includes('..')) return new Response('forbidden', { status: 403 });
      /* 把请求头（尤其是 Range）转发给 file:// —— <video> 依赖分段读取（206）才肯播放；
         不转发时只能拿到元数据与第一帧，表现就是"背景能显示但停在第一帧"。 */
      return net.fetch(pathToFileURL(rel).toString(), { headers: req.headers });
    } catch (err) {
      return new Response('bad request: ' + String(err), { status: 400 });
    }
  });
}

/** 新变量名优先，兼容旧的 LIS_* 前缀 */
const env = (...names: string[]): string => {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return '';
};

const DEV_SERVER_URL = env('OMNIA_DEV_SERVER_URL', 'LIS_DEV_SERVER_URL');

/**
 * 把数据目录钉死成 %APPDATA%\omnia-desktop，开发态与打包态永远同一个。
 *
 * 为什么必须显式设置：Electron 的 app.getName() **优先取 package.json 的
 * productName**，而本项目打包配置里的 productName 是「万象Omnia」、
 * 开发态的 name 是 omnia-desktop。不钉的话，装完之后数据目录会变成
 * %APPDATA%\万象Omnia\，用户此前所有数据在新包里就"看不见"了
 * （不是丢失，而是去了另一个目录）。必须在 app ready 之前调用。
 */
// 视频壁纸「解码成功但画面黑」：Chromium 走 GPU 硬解 4K60 H.264 时，
// 部分显卡/驱动会解出帧但合成黑屏（帧计数正常、readyState=4）。
// 关掉硬件视频解码 → 改软件解码，这类文件就能正常出画。
// 原生标题栏跟随深色：默认跟随系统（浅色）→ 窗口顶部一条白边。
// 声明 dark 后 Windows 标题栏/边框自动变深，和 app 的深色主题一致。
nativeTheme.themeSource = 'dark';

app.commandLine.appendSwitch('disable-accelerated-video-decode');

/* 可选远程调试端口：OMNIA_DEBUG_PORT=9222 时开放 CDP。
   排障用 —— 例如确认「某个 file:// / omnia:// 资源在真实窗口里到底加载没有」，
   这类问题只看编译输出或自检结论都容易误判，必须能读取真实 DOM。
   默认不开，避免日常运行暴露调试端口。 */
const DEBUG_PORT = env('OMNIA_DEBUG_PORT', 'LIS_DEBUG_PORT');
if (DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', DEBUG_PORT);

/* 数据根目录：默认钉死成 %APPDATA%\omnia-desktop（理由见上）。
   可用 OMNIA_DATA_DIR 覆盖 —— 测试"多帮会/首次迁移"时必须能在**不碰真实数据**的目录里跑。 */
app.setPath('userData', env('OMNIA_DATA_DIR', 'LIS_DATA_DIR')
  || path.join(app.getPath('appData'), 'omnia-desktop'));

let mainWindow: BrowserWindow | null = null;
/** 帮会注册表 + 当前库句柄（多帮会：一个帮会一个库文件） */
let store: GuildStore;
/** 旧的单库句柄变量已并入 GuildStore；这里保留函数是因为日志/报错还要打印路径 */
function dbFile(): string {
  const override = env('OMNIA_DB_PATH', 'LIS_DB_PATH');
  if (override) return override;
  return path.join(app.getPath('userData'), 'lis.db');
}

/* 开发模式（electron.exe .）下任务栏/标题栏图标取自这里。
   打包后由 exe 的嵌入图标负责，而 build/ 不在 asar 里，
   existsSync 为 false 就跳过该选项，不会报错。 */
const DEV_ICON = path.join(__dirname, '../../build/icon.png');
const HAS_DEV_ICON = fs.existsSync(DEV_ICON);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    // 与主题 --bg 一致（背景主色 第 3 个 #E6E1E6），避免启动瞬间闪深色
    backgroundColor: '#E6E1E6',
    title: '万象·Omnia',
    autoHideMenuBar: true,
    ...(HAS_DEV_ICON ? { icon: DEV_ICON } : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外链一律交给系统浏览器，不在应用内开窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * 打开数据库并把 IPC 接上。
 *
 * 多帮会：真正打开的是**当前帮会**的库（`guilds/<id>.db`），
 * 首次启动会把旧的 `lis.db` 迁移成名为「霜序客」的第一个帮会（原文件留 .bak）。
 * `OMNIA_DB_PATH` 存在时走单库模式：就用那一个文件、不碰注册表（自检与开发都靠它）。
 */
function bootDatabase(): boolean {
  try {
    const override = env('OMNIA_DB_PATH', 'LIS_DB_PATH');
    const baseDir = override ? path.dirname(override) : app.getPath('userData');
    store = new GuildStore(baseDir, override || null);

    if (!store.isSingle()) {
      const migrated = store.migrateLegacy();
      if (migrated) console.log('[guild] 已把旧库迁移成帮会:', migrated.name, migrated.id);
    }
    const active = store.openActive();
    if (active) {
      console.log('[guild] 当前帮会:', active.name, `(${active.id})`);
    } else {
      // 一个帮会都没有：应用照常起，界面会引导"新建帮会"（此时没有库可读）
      console.log('[guild] 还没有任何帮会，等待用户新建');
    }
    if (store.active()) {
      console.log('[db] 已打开:', store.file());
      const v = store.db().prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migration').get();
      console.log('[db] schema 版本:', v?.v);
    }
    registerIpc({
      db: () => store!.db(),
      dbFile: () => (store!.active() ? store!.file() : ''),
      /* 单库模式也把 store 传进来：list/active 能给出那个"虚拟帮会"（界面与自检都要用），
         增删改由 GuildStore 自己按 isSingle() 拦住。 */
      guilds: store,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox('数据库初始化失败', `${msg}\n\n数据库路径：${dbFile()}`);
    return false;
  }
}

/**
 * 自检模式（OMNIA_SMOKE=1）：渲染层真正加载后，让它把 renderer→preload→IPC→SQLite
 * 整条链路的探针结果写回主进程并打印，然后退出。
 *
 * 打包后的 Windows 程序没有控制台，stdout 拿不到；因此同时把全部日志写进
 * <DB 同目录>/omnia-smoke.log，这样安装后的程序也能被验证与排障。
 */
function makeLogger(): (...args: unknown[]) => void {
  const explicit = env('OMNIA_SMOKE_LOG');
  // 自检时「截取图片」若走保存对话框会**模态阻塞**，无人点击就永远卡住整个自检。
  // 所以自检模式下一律改成直接写文件（不给对话框机会）。
  if (env('OMNIA_SMOKE', 'LIS_SMOKE') === '1' && !process.env.OMNIA_CAPTURE_DIR) {
    process.env.OMNIA_CAPTURE_DIR = path.join(path.dirname(dbFile()), 'captures');
  }
  const lines: string[] = [];
  const flush = () => {
    try {
      const target = explicit || path.join(path.dirname(dbFile()), 'omnia-smoke.log');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');
    } catch { /* 写不了就算了，不影响自检结论 */ }
  };
  return (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    lines.push(line);
    console.log(...args);
    flush();
  };
}


// 单实例锁：避免两个进程同时写同一个 SQLite 文件
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  /* 任务栏分组与"固定到任务栏"依赖它；不设的话固定后仍是 Electron 的图标。 */
app.setAppUserModelId('cn.omnia.league.desktop');

app.whenReady().then(() => {
    // 本地文件协议（壁纸/中缝图用）：必须在建窗口之前挂好，否则首帧就取不到图
    registerLocalProtocol();
    if (!bootDatabase()) {
      app.exit(1);
      return;
    }
    createWindow();

    if (env('OMNIA_SMOKE', 'LIS_SMOKE') === '1' && mainWindow) {
      void runSmokeTest(mainWindow, { env, log: makeLogger() });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err: unknown) => {
    dialog.showErrorBox('启动失败', err instanceof Error ? err.message : String(err));
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // 当前帮会的库句柄由 GuildStore 持有；关不掉也不阻塞退出
    try { if (store?.active()) store.db().close(); } catch { /* 忽略关闭异常 */ }
  });
}

