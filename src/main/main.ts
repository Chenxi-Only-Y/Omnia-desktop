/**
 * 万象·Omnia —— Electron 主进程入口
 *
 * 数据库位置：<userData>/lis.db（可用 OMNIA_DB_PATH / LIS_DB_PATH 覆盖，便于开发与测试）
 * 渲染层：开发时连 Vite dev server（OMNIA_DEV_SERVER_URL），生产时加载本地文件
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { detectHeaderRow, listSheets, readXlsx } from './xlsx';
import { openDatabase, type DbHandle } from './db';
import { registerIpc } from './ipc';
import { parseTableText } from '../shared/tableText';
import { CLASSES, classIconFile } from '../shared/domain';

/** 编译后本文件位于 dist/main/main.js，应用根目录是上一级的上一级 */
const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIST = path.join(APP_ROOT, 'dist', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

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
app.setPath('userData', path.join(app.getPath('appData'), 'omnia-desktop'));

let mainWindow: BrowserWindow | null = null;
let dbHandle: DbHandle | null = null;

function dbFile(): string {
  const override = env('OMNIA_DB_PATH', 'LIS_DB_PATH');
  if (override) return override;
  return path.join(app.getPath('userData'), 'lis.db');
}

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

function bootDatabase(): boolean {
  try {
    dbHandle = openDatabase(dbFile());
    console.log('[db] 已打开:', dbHandle.file);
    const v = dbHandle.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migration').get();
    console.log('[db] schema 版本:', v?.v);
    registerIpc({ handle: dbHandle });
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

async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const log = makeLogger();

  /**
   * 注入到每个渲染层探针开头的 helper：返回一个会把 push 的内容同时投递到
   * window.__smokeSteps 的数组。主进程在探针运行期间轮询那个数组，
   * 于是探针挂死时日志里能看到"最后走到哪一步"，而不是只有一句超时。
   */
  // 注意：helper 与探针脚本一起被塞进同一个 IIFE，避免 helper 的顶层 const
  // 泄漏到页面全局，也避免各探针之间互相污染。
  const SMOKE_HELPER = `
    const smokeSteps = () => {
      const arr = [];
      window.__smokeSteps = window.__smokeSteps || [];
      const live = window.__smokeSteps;
      arr.push = function (...items) {
        for (const it of items) live.push(String(it));
        return Array.prototype.push.apply(this, items);
      };
      return arr;
    };
    // 探针自建的数据必须登记，主进程在探针结束后（含超时）统一清理。
    // 起因：打包环境里拖拽探针 90s 超时，它造的两个成员没被删掉，
    // 后面的评分探针就按 8 个人算分（应为 6），连带报名探针一起误报。
    // 探针之间不该靠"上一个探针正常跑完"来保证隔离。
    const smokeMade = (kind, id) => {
      window.__smokeMade = window.__smokeMade || [];
      window.__smokeMade.push([kind, id]);
      return id;
    };
  `;
  /** 把探针脚本包成自调用函数：helper 在函数作用域内，脚本的 return 透传出去 */
  const wrapProbe = (script: string): string => `(function(){${SMOKE_HELPER}\nreturn ${script}\n})()`;

  /**
   * 清掉探针登记的自建数据。探针正常跑完时它自己已经删过一遍（这里为空操作），
   * 真正起作用的是探针超时/抛错的情况 —— 不清理就会污染后续探针的断言。
   */
  const sweepProbeRows = async (label: string): Promise<void> => {
    try {
      const made = (await win.webContents.executeJavaScript(
        '(() => { const m = window.__smokeMade || []; window.__smokeMade = []; return m; })()',
      )) as unknown;
      if (!Array.isArray(made) || !made.length) return;
      const removed = await win.webContents.executeJavaScript(`(async () => {
        let n = 0;
        for (const [kind, id] of ${JSON.stringify(made)}) {
          const api = window.omnia;
          try {
            if (kind === 'player') { await api.player.remove(id); n++; }
            else if (kind === 'match') { await api.match.remove(id); n++; }
            else if (kind === 'season') { await api.season.remove(id); n++; }
            else if (kind === 'rule') { await api.rules.remove(id); n++; }
          } catch (e) { /* 已经被探针自己删掉了 */ }
        }
        return n;
      })()`);
      log(`[smoke] 清理残留（${label}）:`, removed, '条，登记', made.length, '条');
    } catch (err) {
      log(`[smoke] 清理残留失败（${label}）:`, String(err));
    }
  };

  /**
   * 可选截图：设置 OMNIA_SMOKE_SHOTS=<目录> 时，把界面真实样子写成 PNG。
   * 用途是"别只看断言通过，要看一眼长什么样"——尤其是排表/赛季这类布局密集的页面。
   */
  const shot = async (name: string, settleMs = 0): Promise<void> => {
    const dir = env('OMNIA_SMOKE_SHOTS');
    if (!dir) return;
    try {
      // 探针返回后 React 可能还没把新页面提交到合成器，先等一拍再要帧
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      fs.mkdirSync(dir, { recursive: true });
      // 后台窗口的合成帧会滞后：先要一帧、再等一下，否则截到的是上一个页面的画面
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 800));
      const img = await win.webContents.capturePage();
      const file = path.join(dir, `${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      log('[smoke] 截图:', file, `${img.getSize().width}x${img.getSize().height}`);
    } catch (err) {
      log('[smoke] 截图失败:', name, String(err));
    }
  };

  /**
   * 执行渲染层探针并兜底。
   * 关键：executeJavaScript 在脚本抛错时会**拒绝 Promise**；不接住的话自检函数
   * 既不退出也不继续（表现为挂死到外部超时）。这里统一接住并限时，
   * 任何脚本错误都退化成一条 ERR 记录，保证自检总能跑完并给出结论。
   *
   * 另外：探针里的 steps 只有在探针**跑完**才会交回主进程，所以一旦某个探针挂死
   * （打包环境里就踩到过：探针 90s 超时，日志里只剩"ERR 超时"，完全看不出卡在哪）。
   * 这里在探针运行期间轮询 window.__smokeSteps，把已产生的步骤实时落进日志，
   * 挂死时就地留下最后一步 —— 这是排障唯一可靠的线索。
   */
  const guarded = async (
    script: string, label: string, timeoutMs = 90_000,
  ): Promise<{ ok: boolean; steps: string[]; value?: unknown }> => {
    let timer: NodeJS.Timeout | undefined;
    let live: NodeJS.Timeout | undefined;
    let seen = 0;
    const drain = async (): Promise<void> => {
      try {
        const pending = (await win.webContents.executeJavaScript(
          `(window.__smokeSteps || []).slice(${seen})`,
        )) as unknown;
        if (!Array.isArray(pending) || !pending.length) return;
        for (const line of pending) log(`[smoke] ${label} ·`, line);
        seen += pending.length;
      } catch { /* 探针正在切换页面时可能取不到，下一轮再取 */ }
    };
    try {
      await win.webContents.executeJavaScript('window.__smokeSteps = []; window.__smokeMade = []');      live = setInterval(() => { void drain(); }, 800);
      const raw = await Promise.race([
        win.webContents.executeJavaScript(wrapProbe(script)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} 探针超时（${timeoutMs}ms）`)), timeoutMs);
        }),
      ]);
      // 探针脚本按约定返回 { ok, steps, value? }；value 必须一起带出来，
      // 否则调用方拿不到颜色/图标/清理句柄这类附加数据。
      if (raw && typeof raw === 'object' && 'ok' in (raw as object) && 'steps' in (raw as object)) {
        const env = raw as { ok: boolean; steps: string[]; value?: unknown };
        if (!env.ok) await sweepProbeRows(label);
        return env;
      }
      return { ok: true, steps: [], value: raw };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await drain();   // 超时/异常时把最后一步捞出来，这是定位挂点的关键
      // 渲染层抛错时 executeJavaScript 只给一句"Script failed to execute"，
      // 顺手把 React 的错误边界信息/控制台最后一条错误捞出来，否则等于没说
      let hint = '';
      try {
        hint = String(await win.webContents.executeJavaScript(
          `(window.__smokeErr || '') + ' | root=' + ((document.getElementById('root')||{}).innerHTML||'').length`,
        ));
      } catch { /* 页面可能已经不可用 */ }
      await sweepProbeRows(label);
      return { ok: false, steps: [`ERR 渲染层脚本失败：${msg}｜线索：${hint}（最后一步见上方 ${label} · 行）`] };
    } finally {
      if (timer) clearTimeout(timer);
      if (live) clearInterval(live);
    }
  };

  const preloadProbe = async (): Promise<{ preload: boolean; appInfo: boolean; classes: number; players: number; schemaVersion: number; error: string | null }> => {
    const w = win.webContents;
    const has = await w.executeJavaScript('typeof window.omnia === "object" && window.omnia !== null');
    if (!has) return { preload: false, appInfo: false, classes: 0, players: 0, schemaVersion: 0, error: 'window.omnia 未注入' };
    const res = await w.executeJavaScript(`(async () => {
      try {
        const info = await window.omnia.app.info();
        const cls = await window.omnia.meta.classes();
        const ps = await window.omnia.player.list();
        return {
          preload: true,
          appInfo: !!(info && info.ok),
          classes: cls && cls.ok ? cls.data.length : -1,
          players: ps && ps.ok ? ps.data.length : -1,
          schemaVersion: info && info.ok ? Number(info.data.schemaVersion) : -1,
          error: [info, cls, ps].filter(r => r && !r.ok).map(r => r.error).join('; ') || null,
        };
      } catch (e) { return { preload: true, appInfo: false, classes: -1, players: -1, schemaVersion: -1, error: String(e) }; }
    })()`);
    return res as { preload: boolean; appInfo: boolean; classes: number; players: number; schemaVersion: number; error: string | null };
  };

  win.webContents.once('did-finish-load', async () => {
    // 全局错误捕获：渲染层抛错时 executeJavaScript 只回一句无信息量的
    // "Script failed to execute"，先把真正的报错记下来给探针用。
    void win.webContents.executeJavaScript(`
      window.__smokeErr = '';
      window.addEventListener('error', (e) => {
        window.__smokeErr = String((e && (e.message || (e.error && e.error.message))) || e);
      });
      window.addEventListener('unhandledrejection', (e) => {
        window.__smokeErr = 'unhandledrejection: ' + String((e && e.reason && (e.reason.stack || e.reason.message)) || e.reason);
      });
    `);
    let r: Awaited<ReturnType<typeof preloadProbe>>;
    try {
      r = await preloadProbe();
    } catch (err) {
      r = { preload: false, appInfo: false, classes: -1, players: -1, schemaVersion: -1, error: String(err) };
    }
    log('[smoke] schema 版本        :', r.schemaVersion, '（迁移应已跑到最新）');
    const rootProbeResult = await guarded(
      `document.getElementById("root") ? document.getElementById("root").innerHTML.length : -1`,
      '根节点渲染',
    );
    const rootHtml = typeof rootProbeResult.value === 'number' ? rootProbeResult.value : -1;
    // 趁探针还没往库里写东西，先拍一张"刚打开应用"的真实样子（首页/总览）
    await shot('overview');

    // 写操作往返：create → update → list → remove → list
    const crud = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const before = (await window.omnia.player.list()).data.length;
        const made = await window.omnia.player.create({
          gameId: '__smoke_probe__', name: '自检探针', mainClass: '神相', mic: '有', joinedOrder: 999,
        });
        if (!made.ok) throw new Error('create: ' + made.error);
        steps.push('create ok id=' + made.data.id + ' class=' + made.data.mainClass);
        const afterCreate = (await window.omnia.player.list()).data.length;
        const upd = await window.omnia.player.update(made.data.id, { subClass: '潮光', remark: '自检写入' });
        if (!upd.ok) throw new Error('update: ' + upd.error);
        steps.push('update ok sub=' + upd.data.subClass + ' remark=' + upd.data.remark);
        const dup = await window.omnia.player.create({ gameId: '__smoke_probe__' });
        steps.push('重复 ID 被拦: ' + (dup.ok ? '否（异常！）' : '是'));
        const del = await window.omnia.player.remove(made.data.id);
        if (!del.ok) throw new Error('remove: ' + del.error);
        const afterRemove = (await window.omnia.player.list()).data.length;
        steps.push('before=' + before + ' afterCreate=' + afterCreate + ' afterRemove=' + afterRemove);
        return { ok: before === afterRemove && afterCreate === before + 1, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针2');

    log('[smoke] preload 注入        :', r.preload);
    log('[smoke] app.info()         :', r.appInfo);
    log('[smoke] meta.classes() 数量 :', r.classes);
    log('[smoke] player.list() 数量  :', r.players);
    log('[smoke] React 已渲染字符数  :', rootHtml);
    log('[smoke] 错误                :', r.error ?? '无');
    for (const s of crud.steps) log('[smoke] CRUD:', s);

    // M3：对局 → 阵容 → 战报粘贴导入 → 校验 → 入库 → 读回
    const m3 = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const api = window.omnia;
        const made = await api.player.create({ gameId: 'smoke_p1', name: '战报测试员', mainClass: '神相' });
        if (!made.ok) throw new Error('建成员失败: ' + made.error);
        steps.push('建档 ok id=' + made.data.id);

        const m = await api.match.create({
          date: '2026-01-01', ourSide: '我方', oppSide: '对手', result: 'WIN',
          ourTowersLeft: 5, oppTowersLeft: 0,
        });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        steps.push('建对局 ok id=' + m.data.match.id + ' inherited=' + m.data.inherited);

        const TSV = [
          '玩家名字\\t职业\\t击败/清泉\\t助攻\\t资源\\t对玩家伤害\\t人伤卸甲\\t对建筑伤害\\t破塔卸甲\\t治疗值\\t承受伤害\\t重伤\\t复活/清泉\\t焚骨',
          'smoke_p1\\t神相\\t 32/0\\t151\\t0\\t8930953\\t0\\t1965057\\t0\\t0\\t6489941\\t3\\t0\\t0',
          '不在档的人\\t玄机\\t5/1\\t20\\t0\\t100\\t0\\t200\\t0\\t0\\t300\\t1\\t0\\t0',
          'smoke_p1\\t神相\\t1/0\\t1\\t0\\t1\\t0\\t1\\t0\\t0\\t1\\t0\\t0\\t0',
        ].join('\\n');

        // 严格模式：应出现 1 个「不在主档」错误 + 1 个重复错误
        const strict = await api.match.importPreview(TSV, 'roster');
        if (!strict.ok) throw new Error('预览失败: ' + strict.error);
        steps.push('严格模式 total=' + strict.data.summary.total
          + ' 匹配=' + strict.data.summary.matched
          + ' 未匹配=' + strict.data.summary.unmatched
          + ' 错误=' + strict.data.summary.errors
          + ' 警告=' + strict.data.summary.warnings);
        const codes = strict.data.issues.map(i => i.code).join(',');
        steps.push('问题分类=' + codes);
        const r0 = strict.data.rows[0];
        steps.push('解析复合列 击败=' + r0.stat.kills + ' 清泉=' + r0.stat.fountainKills
          + ' 有效人伤=' + (r0.stat.dmgPlayer + r0.stat.dmgPlayerArmor)
          + ' 有效塔伤=' + (r0.stat.dmgBuilding + r0.stat.dmgBuildingArmor));

        // 有 error 时必须拒绝入库
        const blocked = await api.match.importCommit(m.data.match.id, strict.data);
        steps.push('有错误时提交被拒: ' + (blocked.ok ? '否（异常！）' : '是'));

        // 完整模式：允许不在档的人自动建档
        const full = await api.match.importPreview(TSV, 'full');
        if (!full.ok) throw new Error('完整模式预览失败: ' + full.error);
        const clean = { ...full.data, rows: full.data.rows.slice(0, 2) };
        const committed = await api.match.importCommit(m.data.match.id, clean);
        if (!committed.ok) throw new Error('入库失败: ' + committed.error);
        steps.push('入库 ok written=' + committed.data.written + ' 自动建档=' + committed.data.created);

        const parts = await api.match.participations(m.data.match.id);
        if (!parts.ok) throw new Error('读回失败: ' + parts.error);
        const mine = parts.data.find(p => p.gameId === 'smoke_p1');
        if (!mine) throw new Error('读回里找不到刚写入的队员');
        steps.push('读回 ok 参战=' + parts.data.length
          + ' 有效击杀=' + (mine.stat.kills + mine.stat.fountainKills)
          + ' 助攻=' + mine.stat.assists
          + ' statFilled=' + mine.statFilled);

        const list = await api.match.list();
        if (!list.ok) throw new Error('对局列表失败: ' + list.error);
        steps.push('对局列表 ok 场次=' + list.data.length + ' 我方参战=' + list.data[0].ourCount
          + ' 已录战报=' + list.data[0].statFilled);

        // 清理
        await api.match.remove(m.data.match.id);
        for (const p of [made.data.id]) await api.player.remove(p);
        const np = await api.player.list();
        steps.push('清理后成员数=' + np.data.length);

        const ok = strict.data.summary.errors >= 1
          && strict.data.rows[0].stat.kills === 32
          && strict.data.rows[0].stat.fountainKills === 0
          && blocked.ok === false
          && committed.data.written === 2
          && mine.stat.assists === 151;
        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针3');

    for (const s of m3.steps) log('[smoke] M3:', s);
    log('[smoke] M3 对局与战报      :', m3.ok ? 'PASS' : 'FAIL');

    // M5：战斗组/小队建制（数据驱动）+ 排表看板渲染
    const m5 = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const api = window.omnia;
        const cat = await api.meta.squads();
        if (!cat.ok) throw new Error('读取建制失败: ' + cat.error);
        const groups = cat.data.groups.map(g => g.name + ':' + g.kind);
        const squads = cat.data.squads.map(s => s.name);
        steps.push('战斗组=' + groups.join(' '));
        steps.push('小队=' + squads.join(' '));
        steps.push('容量=' + cat.data.capacity);

        // 新增一个战斗组 + 一支小队，验证「可新增」与命名规则
        const g = await api.meta.createGroup({ name: '演练组', kind: 'attack' });
        if (!g.ok) throw new Error('新增战斗组失败: ' + g.error);
        const s1 = await api.meta.createSquad({ groupId: g.data.id, tactic: '保镖' });
        if (!s1.ok) throw new Error('新增小队失败: ' + s1.error);
        steps.push('新增组「演练组」→ 自动命名小队「' + s1.data.name + '」序号=' + s1.data.indexInGroup);
        const s2 = await api.meta.createSquad({ groupId: g.data.id });
        steps.push('再增一队 → 自动命名「' + s2.data.name + '」');

        // 「每组队数不固定」：给已有组再加一队（appendSquad），并验证
        // 1) 序号接着末尾（演练组已有 2 队 → 演练组-3）
        // 2) 有历史记录的队删不掉（防误删历史建制）
        const s3 = await api.meta.appendSquad(g.data.id);
        steps.push('appendSquad → 「' + (s3.ok ? s3.data.name : 'ERR ' + s3.error) + '」');
        // 给 防守一-1 造一条参战记录，然后试着删它 —— 必须被拒绝
        const guardP = await api.player.create({ gameId: 'smoke_sqguard', name: '建制守卫', mainClass: '神相' });
        const guardM = await api.match.create({ date: '2026-02-03', ourSide: '我方', oppSide: '守卫队' });
        if (guardP.ok && guardM.ok) {
          await api.match.upsertParticipation({
            matchId: guardM.data.match.id, playerId: guardP.data.id, squad: '防守一-1', state: 'PLAY',
          });
        }
        const catNow = await api.meta.squads();
        const def1 = catNow.data.squads.find((x) => x.name === '防守一-1');
        // 注意：探针脚本是当纯 JS 在页面里跑的，**不能写 TS 语法**（as const 之类会直接语法报错）
        const delUsed = def1
          ? await api.meta.removeSquad(def1.id)
          : { ok: false, error: '防守一-1 不在建制里' };
        steps.push('删有历史的队被拦=' + (delUsed.ok ? '否（异常！）' : '是')
          + (delUsed.ok ? '' : '（' + delUsed.error.slice(0, 30) + '…）'));
        if (guardP.ok) await api.player.remove(guardP.data.id);
        if (guardM.ok) await api.match.remove(guardM.data.match.id);

        await api.meta.removeSquad(s3.ok ? s3.data.id : 0);
        await api.meta.removeSquad(s2.data.id);
        await api.meta.removeSquad(s1.data.id);
        await api.meta.removeGroup(g.data.id);
        steps.push('清理完成');

        // 建一场对局并把一个人排进「防守一-1」，然后进看板页数方块
        const p = await api.player.create({ gameId: 'smoke_board_1', name: '看板测试员', mainClass: '素问', mic: '有' });
        if (!p.ok) throw new Error('建档失败: ' + p.error);
        const m = await api.match.create({ date: '2026-02-02', ourSide: '我方', oppSide: '对手B', result: 'WIN' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        await api.match.upsertParticipation({ matchId: m.data.match.id, playerId: p.data.id, squad: '防守一-1', state: 'PLAY' });

        // 小队别名：旧表写「防守一2」，本系统写「防守一-2」。
        // 用旧写法排表必须能对上，并且落库要统一成正式名（否则同一队分裂成两个格子）。
        const pAlias = await api.player.create({ gameId: 'smoke_board_alias', name: '别名测试员', mainClass: '铁衣' });
        if (!pAlias.ok) throw new Error('建别名成员失败: ' + pAlias.error);
        const upsertAlias = await api.match.upsertParticipation({
          matchId: m.data.match.id, playerId: pAlias.data.id, squad: '防守一2', state: 'PLAY',
        });
        const partsAlias = await api.match.participations(m.data.match.id);
        const aliasRow = partsAlias.data.find(r => r.gameId === 'smoke_board_alias');
        steps.push('旧写法「防守一2」写入=' + (upsertAlias.ok ? '成功' : '被拒:' + upsertAlias.error)
          + ' 落库小队=' + JSON.stringify(aliasRow?.squad)
          + ' 战术=' + JSON.stringify(aliasRow?.tactic));
        const unknown = await api.match.upsertParticipation({
          matchId: m.data.match.id, playerId: pAlias.data.id, squad: '不存在队-9', state: 'PLAY',
        });
        steps.push('未知小队被拦=' + (unknown.ok ? '否（异常！）' : '是'));

        const nav = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('对局与战报'));
        if (!nav) throw new Error('侧栏里没找到「对局与战报」');
        nav.click();

        const waitFor = async (fn, label, ms = 6000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            const r = fn();
            if (r) return r;
            await new Promise(res => setTimeout(res, 150));
          }
          throw new Error('等待超时：' + label
            + '；当前内容区前 120 字=' + (document.querySelector('.content')?.textContent ?? '').slice(0, 120));
        };

        // 点「进入」打开对局详情。**必须等按钮出现再点**：列表是异步加载的，
        // 只查一次会拿到 null → 卡在列表页（这个竞态原来被"自动选中第一场"掩盖着，
        // 而那个自动选中已移除：它会让详情页的「返回列表」失效）。
        const enterBtn = await waitFor(() => [...document.querySelectorAll('table.grid button')]
          .find(b => b.textContent.trim() === '进入'), '列表里的「进入」按钮');
        enterBtn.click();

        // 切到阵容编排页签
        await waitFor(() => document.querySelector('button.tab') ? true : null, '页签出现');
        const lineupTab = [...document.querySelectorAll('button.tab')]
          .find(b => b.textContent.includes('阵容编排'));
        if (lineupTab) lineupTab.click();

        // 等排表看板渲染出来（卡片版：一队一整行 .squadrow，行内是 .pcard 卡片）
        await waitFor(() => document.querySelectorAll('.squadrow').length > 0 ? true : null, '排表看板');

        const blocks = document.querySelectorAll('.squadrow').length;
        // 队名栏文本形如「防守一-1 0/6 防守」，去掉计数与战术，只留队名。
        // 这里刻意不用正则：探针脚本是塞在模板字符串里的，正则里的转义斜杠
        // 会被外层模板吃掉一半，直接把探针变成语法错误（踩过一次）。
        const teamNames = [...document.querySelectorAll('.squadrow__head')]
          .map(e => (e.firstElementChild ? e.firstElementChild.textContent : '').trim())
          .filter(Boolean);
        const icons = document.querySelectorAll('.pcard__icon').length;
        const named = document.querySelectorAll('.pcard__id').length;
        const notes = document.querySelectorAll('.pcard__note').length;
        // 战术就地可改：队名列里应渲染出 select（外观与普通文字一致，不加额外控件）
        const tacticSelects = document.querySelectorAll('.squadrow__tactic--edit').length;
        const tacticOpts = document.querySelectorAll('.squadrow__tactic--edit option').length;
        steps.push('看板渲染小队行=' + blocks + ' 含职业图标=' + icons + ' 有 ID 名=' + named
          + ' 技能备注输入框=' + notes + ' 战术可改下拉=' + tacticSelects + ' 选项数=' + tacticOpts);
        steps.push('小队名（前5）=' + teamNames.slice(0, 5).join(','));
        const hasTarget = teamNames.includes('防守一-1');
        // 别名写进去的那个人也必须落在「防守一-2」同一行里，而不是另起一行
        const aliasBlock = [...document.querySelectorAll('.squadrow')]
          .find(b => b.dataset.squad === '防守一-2');
        const aliasInSameBlock = !!aliasBlock
          && aliasBlock.textContent.includes('smoke_board_alias');
        steps.push('别名成员落在 防守一-2 同一行=' + aliasInSameBlock);

        await api.match.remove(m.data.match.id);
        await api.player.remove(p.data.id);
        await api.player.remove(pAlias.data.id);

        const ok = cat.data.groups.length === 4
          && cat.data.squads.length === 12
          && cat.data.capacity === 72
          && squads.includes('防守一-1') && squads.includes('防守二-3') && squads.includes('进攻二-3')
          && s1.data.name === '演练组-1' && s2.data.name === '演练组-2'
          && s3.ok === true && s3.data.name === '演练组-3' && !delUsed.ok
          && blocks === 12 && hasTarget
          && upsertAlias.ok === true && aliasRow?.squad === '防守一-2' && aliasRow?.tactic === '防守'
          && aliasInSameBlock
          && unknown.ok === false;
        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针4');
    for (const s of m5.steps) log('[smoke] M5:', s);
    log('[smoke] M5 建制与看板      :', m5.ok ? 'PASS' : 'FAIL');

    // 落位：点哪个空位就填哪个位置（不是总挤到最左边）
    const slot = await guarded(`(async () => {
      const steps = smokeSteps();
      let pid1 = null, pid2 = null, mid = null;
      try {
        const api = window.omnia;
        const p1 = await api.player.create({ gameId: 'smoke_slot_1', name: '落位甲', mainClass: '神相' });
        const p2 = await api.player.create({ gameId: 'smoke_slot_2', name: '落位乙', mainClass: '素问' });
        if (!p1.ok || !p2.ok) throw new Error('建档失败');
        pid1 = p1.data.id; pid2 = p2.data.id;
        smokeMade('player', pid1); smokeMade('player', pid2);
        const m = await api.match.create({ date: '2026-09-09', ourSide: '我方', oppSide: '落位队' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        mid = m.data.match.id;
        smokeMade('match', mid);

        // 甲放进「防守一-1」第 4 格（index 3）
        await api.match.assignBulk({ matchId: mid, playerIds: [pid1], squad: '防守一-1', slotIndex: 3 });
        let parts = await api.match.participations(mid);
        const a = parts.data.find(r => r.gameId === 'smoke_slot_1');
        steps.push('甲 放到第 4 格 → 落库 slotNo=' + a?.slotNo + '（应=3）');

        // 乙放进同一队第 2 格（index 1）
        await api.match.assignBulk({ matchId: mid, playerIds: [pid2], squad: '防守一-1', slotIndex: 1 });
        parts = await api.match.participations(mid);
        const a2 = parts.data.find(r => r.gameId === 'smoke_slot_1');
        const b2 = parts.data.find(r => r.gameId === 'smoke_slot_2');
        steps.push('乙 放到第 2 格 → 甲 slotNo=' + a2?.slotNo + ' 乙 slotNo=' + b2?.slotNo + '（应 3 / 1）');

        // 再点回甲占着的第 4 格（用第三人占位验证互换不丢人）：
        // 让乙改放到第 4 格 → 乙占 4，甲被顶到乙原来的 1
        await api.match.assignBulk({ matchId: mid, playerIds: [pid2], squad: '防守一-1', slotIndex: 3 });
        parts = await api.match.participations(mid);
        const a3 = parts.data.find(r => r.gameId === 'smoke_slot_1');
        const b3 = parts.data.find(r => r.gameId === 'smoke_slot_2');
        steps.push('乙 改放第 4 格 → 乙=' + b3?.slotNo + ' 甲=' + a3?.slotNo
          + '（互换：乙应 3，甲应 1，两人都不能丢）');

        // 移出小队要清掉格号
        await api.match.unassign(mid, pid1);
        parts = await api.match.participations(mid);
        const a4 = parts.data.find(r => r.gameId === 'smoke_slot_1');
        steps.push('移出小队后 slotNo=' + a4?.slotNo + '（应=-1）');

        const cond = {
          exact4: a?.slotNo === 3,
          twoSlots: a2?.slotNo === 3 && b2?.slotNo === 1,
          swap: b3?.slotNo === 3 && a3?.slotNo === 1,
          cleared: a4?.slotNo === -1,
        };
        steps.push('判定=' + JSON.stringify(cond));

        // 关键补充：**渲染位置**也要对 —— 光落库对不算，卡片必须出现在第 5 格。
        // 之前就是只断言了 slotNo，没断言 DOM 位置，所以"点了没变"没被发现。
        // 注意此队里还留着第 2 格的「落位乙」，所以已填格数应为 2。
        await api.match.upsertParticipation({ matchId: mid, playerId: pid1, squad: '防守一-1', state: 'PLAY' });
        await api.match.assignBulk({ matchId: mid, playerIds: [pid1], squad: '防守一-1', slotIndex: 4 });
        const nav = [...document.querySelectorAll('button.nav-item')]
          .find(x => x.textContent.indexOf('排表') >= 0);
        if (nav) nav.click();
        await new Promise(r => setTimeout(r, 900));
        // 先看落库，再看渲染 —— 分清是"数据被改了"还是"渲染位置不对"
        const parts2 = await api.match.participations(mid);
        steps.push('落库复查：' + JSON.stringify(parts2.data.map(r => ({
          name: r.name, slotNo: r.slotNo, squad: r.squad,
        }))));
        const row = [...document.querySelectorAll('.squadrow')].find(x => x.dataset.squad === '防守一-1');
        if (!row) throw new Error('看板上找不到 防守一-1');
        const cards = [...row.querySelectorAll('.squadrow__cards > *')];
        const idxOf = (gid) => cards.findIndex(c => c.textContent.indexOf(gid) >= 0);
        const filledCount = cards.filter(c => !c.classList.contains('pcard--empty')).length;
        const dbA = parts2.data.find(r => r.gameId === 'smoke_slot_1');
        const dbB = parts2.data.find(r => r.gameId === 'smoke_slot_2');
        steps.push('渲染：共 ' + cards.length + ' 格；甲 落库 slot=' + dbA?.slotNo
          + ' → 渲染第 ' + (idxOf('smoke_slot_1') + 1) + ' 格；乙 落库 slot=' + dbB?.slotNo
          + ' → 渲染第 ' + (idxOf('smoke_slot_2') + 1) + ' 格；已填 ' + filledCount + ' 格');
        // 不变量：渲染位置必须等于落库槽号（比写死 5/2 更可靠，不会被前置步骤影响）
        cond.renderMatchesSlot = idxOf('smoke_slot_1') === dbA?.slotNo
          && idxOf('smoke_slot_2') === dbB?.slotNo;
        cond.gapsKept = filledCount === 2;          // 中间空格没被"挤过来"填满
        cond.slot5Honoured = idxOf('smoke_slot_1') === 4;   // 点第 5 格就真的在第 5 格
        steps.push('判定2=' + JSON.stringify({
          renderMatchesSlot: cond.renderMatchesSlot,
          gapsKept: cond.gapsKept,
          slot5Honoured: cond.slot5Honoured,
        }));
        cond.ok = Object.values(cond).every(Boolean);

        // 自己造的数据自己清：不然会污染后面的 M6/拖拽/报名/评分等探针
        await api.match.remove(mid);
        await api.player.remove(pid1);
        await api.player.remove(pid2);
        steps.push('清理完成');
        return { ok: cond.ok === true, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针4b');
    for (const s of slot.steps) log('[smoke] 落位:', s);
    log('[smoke] 落位到指定格      :', slot.ok ? 'PASS' : 'FAIL');

    const m6 = await guarded(`(async () => {
      const steps = smokeSteps();
      const created = { players: [], matches: [] };
      try {
        const api = window.omnia;
        // 造两场对局、3 名成员，其中 1 场只填一半战报，用于验证完整度统计
        const p1 = await api.player.create({ gameId: 'smoke_dash_1', name: '统计甲', mainClass: '神相', mic: '有', joinedOrder: 1 });
        const p2 = await api.player.create({ gameId: 'smoke_dash_2', name: '统计乙', mainClass: '素问', mic: '有', joinedOrder: 2 });
        const p3 = await api.player.create({ gameId: 'smoke_dash_3', name: '统计丙', mainClass: '铁衣', mic: '无', joinedOrder: 3 });
        for (const p of [p1, p2, p3]) if (p.ok) created.players.push(p.data.id);

        const m1 = await api.match.create({ date: '2026-03-01', ourSide: '我方', oppSide: '甲队', result: 'WIN' });
        const m2 = await api.match.create({ date: '2026-03-08', ourSide: '我方', oppSide: '乙队', result: 'LOSE' });
        for (const m of [m1, m2]) if (m.ok) created.matches.push(m.data.match.id);

        // 第一场：3 人上场，全部填战报
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: p1.data.id, squad: '防守一-1', state: 'PLAY', classUsed: '神相', stat: { kills: 20, assists: 30, dmgPlayer: 1000, deaths: 1 } });
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: p2.data.id, squad: '防守一-1', state: 'PLAY', classUsed: '素问', stat: { assists: 50, healing: 5000, deaths: 0 } });
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: p3.data.id, squad: '防守一-1', state: 'PLAY', classUsed: '铁衣', stat: { assists: 10, damageTaken: 9000, deaths: 4 } });
        // 第二场：3 人上场，只填 1 人（完整度应为 1/3）
        await api.match.upsertParticipation({ matchId: m2.data.match.id, playerId: p1.data.id, squad: '进攻一-1', state: 'PLAY', classUsed: '神相', stat: { kills: 5, deaths: 2 } });
        await api.match.upsertParticipation({ matchId: m2.data.match.id, playerId: p2.data.id, squad: '进攻一-1', state: 'PLAY', classUsed: '素问' });
        await api.match.upsertParticipation({ matchId: m2.data.match.id, playerId: p3.data.id, state: 'LEAVE' });

        const d = await api.dashboard.data();
        if (!d.ok) throw new Error('看板取数失败: ' + d.error);
        const t = d.data.totals;
        steps.push('总场次=' + t.matches + ' 成员=' + t.players + ' 参战记录=' + t.participations);
        steps.push('战报完整度=' + t.statFilled + '/' + t.statSlots + ' = ' + Math.round(t.statRate * 100) + '%');
        steps.push('场均上场=' + t.avgLineup.toFixed(2));
        steps.push('出勤前三=' + d.data.attendance.slice(0, 3).map(a => a.name + '(' + a.plays + '/' + a.matches + ')').join(' '));
        steps.push('职业出场=' + d.data.classPlayCount.map(c => c.name + ':' + c.plays).join(' '));
        steps.push('小队使用=' + d.data.squadUsage.map(s => s.squad + ':' + s.plays + '[' + s.kind + ']').join(' '));
        const cov = d.data.metricCoverage.find(m => m.key === 'healing');
        steps.push('治疗值覆盖=' + (cov ? cov.nonZero + '/' + cov.total : 'n/a'));

        // 首页主视觉渲染
        const navHome = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('总览'));
        if (navHome) navHome.click();
        const waitFor = async (fn, label, ms = 6000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        await waitFor(() => document.querySelector('.hero') ? true : null, '首页主视觉');
        const heroBrand = document.querySelector('.hero__brand')?.textContent || '';
        const heroClasses = document.querySelectorAll('.hero__class').length;
        const heroButtons = document.querySelectorAll('.hero__btn').length;
        steps.push('主视觉 品牌字=' + JSON.stringify(heroBrand) + ' 职业图标=' + heroClasses + ' 快捷按钮=' + heroButtons);

        // 看板页渲染
        const navBoard = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('数据看板'));
        if (navBoard) navBoard.click();
        await waitFor(() => document.querySelector('table.grid') ? true : null, '看板表格');
        const rows = document.querySelectorAll('table.grid tbody tr').length;
        const tabs = document.querySelectorAll('button.tab').length;
        steps.push('看板页 行数=' + rows + ' 页签=' + tabs);

        // 设置页渲染
        const navSet = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('设置'));
        if (navSet) navSet.click();
        await waitFor(() => [...document.querySelectorAll('h3')].some(h => h.textContent.includes('战斗组')) ? true : null, '设置页战斗组区块');
        const groupRows = document.querySelectorAll('table.grid tbody tr').length;
        steps.push('设置页 战斗组表行数=' + groupRows);

        // 清理
        for (const id of created.matches) await api.match.remove(id);
        for (const id of created.players) await api.player.remove(id);
        const after = await api.dashboard.data();
        steps.push('清理后场次=' + (after.ok ? after.data.totals.matches : '?') + ' 成员=' + (after.ok ? after.data.totals.players : '?'));

        const ok = t.statSlots === 5 && t.statFilled === 4
          && Math.abs(t.statRate - 4 / 5) < 1e-6
          && d.data.classPlayCount.length >= 3
          && d.data.squadUsage.some(s => s.squad === '防守一-1' && s.kind === 'defend')
          && heroBrand.includes('Omnia') && heroClasses === 12 && heroButtons === 4;
        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针5');
    for (const s of m6.steps) log('[smoke] M6:', s);
    log('[smoke] M6 看板与首页      :', m6.ok ? 'PASS' : 'FAIL');

    // M7：用真实旧表验证「列工作表 → 探测表头 → 网格 → TSV → 解析」
    // 走编译产物的核心函数（与 IPC 处理函数同一套逻辑），轻量且确定性；
    // 若有样本再额外验一次 "bytes → grid" 以便报出字节数。
    // 样本路径由 OMNIA_SAMPLE_XLSX 指定；没有样本时 SKIP（不算失败）。
    const samplePath = env('OMNIA_SAMPLE_XLSX', 'LIS_SAMPLE_XLSX');
    let m7: { ok: boolean; steps: string[]; skipped?: boolean } = { ok: true, steps: [], skipped: true };
    if (samplePath && fs.existsSync(samplePath)) {
      const steps: string[] = [];
      let ok = true;
      try {
        const buf = fs.readFileSync(samplePath);
        steps.push(`样本=${path.basename(samplePath)} 字节=${buf.length}`);

        const sheets = listSheets(buf);
        const names = sheets.map((s) => s.name);
        steps.push(`工作表(${names.length})=${names.join('/')}`);

        // 成员主档：应命中「信息数据库」，表头探测在第 5 行
        const g1 = readXlsx(buf, { sheet: '信息数据库' });
        const h1 = detectHeaderRow(g1);
        const head1 = (g1[h1 - 1] ?? []).map((c) => c.trim());
        const members = g1.slice(h1).filter((r) => (r[2] ?? '').trim() !== '');
        steps.push(`信息数据库 表头行=${h1} 总行数=${g1.length} 成员行=${members.length}`);
        steps.push(`表头前 6 列=${head1.slice(0, 6).map((h) => h || '·').join('|')}`);
        steps.push(`首个成员=${(members[0]?.[2] ?? '').trim()}`);

        // 战报：应命中「数据导入」，表头探测在第 6 行
        const g2 = readXlsx(buf, { sheet: '数据导入' });
        const h2 = detectHeaderRow(g2);
        const head2 = (g2[h2 - 1] ?? []).map((c) => c.trim()).filter(Boolean);
        steps.push(`数据导入 表头行=${h2} 表头=${head2.slice(0, 8).join('|')}`);

        // 网格 → TSV → 真实解析（成员名单走已有列名映射）
        // 实测：信息数据库里**没有职业列**（索引 3 全空），
        // 职业信息只存在于「数据导入」战报表。所以成员导入后主职业为空是预期行为，
        // 需要靠战报或手工补齐。这里把该事实固化成断言，避免以后误以为是 bug。
        let dColFilled = 0;
        for (let r = h1; r < g1.length; r++) if ((g1[r]?.[3] ?? '').trim() !== '') dColFilled++;
        steps.push(`信息数据库 D 列（疑似职业列）非空数=${dColFilled}（实测应为 0：该表不含职业）`);

        // C 列角色ID / I 列麦 / L 列备注 应有数据
        const idCol = g1.slice(h1).filter((r) => (r[2] ?? '').trim() !== '').length;
        const micCol = g1.slice(h1).filter((r) => (r[8] ?? '').trim() !== '').length;
        const noteCol = g1.slice(h1).filter((r) => (r[11] ?? '').trim() !== '').length;
        steps.push(`C 列角色ID=${idCol} 人 · I 列麦=${micCol} 人 · L 列备注=${noteCol} 人`);

        const tsv = [
          head1.join('\t'),
          ...g1.slice(h1)
            .map((r) => r.map((c) => (c ?? '').replace(/[\t\r\n]+/g, ' ').trim()).join('\t'))
            .filter((l) => l.replace(/\t/g, '').trim() !== ''),
        ].join('\n');
        const parsed = parseTableText(tsv);
        steps.push(`网格→TSV→解析 得到 ${parsed.length} 名成员，首条=${parsed[0]?.gameId ?? '无'}/入帮序=${parsed[0]?.joinedOrder ?? '?'}/麦=${parsed[0]?.mic ?? '无'}/备注角色=${parsed[0]?.noteRole ?? '无'}`);

        // 显式指定表头行应被尊重：第 6 行是数据首行（角色ID=1）
        const hExplicit = 6;
        const g4 = readXlsx(buf, { sheet: '信息数据库', headerRow: hExplicit, maxRows: hExplicit + 1 });
        steps.push(`显式 headerRow=${hExplicit} → 该行首列=${(g4[hExplicit - 1]?.[0] ?? '') || '（空）'}`);

        // 不存在的表必须报错，不能静默回退
        let badThrew = false;
        try { readXlsx(buf, { sheet: '不存在的表' }); } catch { badThrew = true; }
        steps.push(`读不存在的表 → ${badThrew ? '按预期报错' : '未报错（异常！）'}`);

        // bytes → grid（验证 IPC 入参类型 Uint8Array 也能走通）
        const fromBytes = readXlsx(Buffer.from(buf), { sheet: '信息数据库' });
        steps.push(`Uint8Array 入参 → 行数=${fromBytes.length}`);

        ok = names.length === 10
          && names.includes('信息数据库') && names.includes('数据导入')
          && h1 === 5
          && head1[0] === '入帮排序' && head1[2] === '角色ID'
          && dColFilled === 0
          && idCol >= 79 && micCol >= 70 && noteCol >= 10
          && members.length >= 79
          && h2 === 6
          && head2.includes('玩家名字') && head2.includes('击败/清泉') && head2.includes('焚骨')
          && parsed.length >= 79
          && parsed[0]?.gameId === '草莓酱板鸭'
          && parsed[0]?.joinedOrder === 1
          && parsed[0]?.mic === '有'
          && parsed[0]?.noteRole === '指挥'
          && (g4[hExplicit - 1]?.[0] ?? '') === '1'
          && badThrew
          && fromBytes.length === g1.length;
      } catch (err) {
        ok = false;
        steps.push('ERR ' + (err instanceof Error ? err.message : String(err)));
      }
      m7 = { ok, steps };
      for (const s of m7.steps) log('[smoke] M7:', s);
      log('[smoke] M7 真实旧表导入    :', m7.ok ? 'PASS' : 'FAIL');
    } else {
      log('[smoke] M7 真实旧表导入    : SKIP（未提供样本，设 OMNIA_SAMPLE_XLSX 指向旧表即可验证）');
    }

    // 导入向导的界面接线：切到成员主档点「从 xlsx 导入」，确认弹窗出来了
    const wizard = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const waitFor = async (fn, label, ms = 6000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        const nav = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('成员主档'));
        if (!nav) throw new Error('侧栏没有「成员主档」');
        nav.click();
        const btn = await waitFor(
          () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '从 xlsx 导入'),
          '「从 xlsx 导入」按钮');
        btn.click();
        const modal = await waitFor(() => document.querySelector('.modal'), '导入向导弹窗');
        const title = modal.querySelector('h3')?.textContent || '';
        const hasFileBtn = !!([...modal.querySelectorAll('button')].find(b => b.textContent.includes('选择 xlsx 文件')));
        const hasHint = (modal.textContent || '').includes('表头');
        steps.push('弹窗标题=' + JSON.stringify(title) + ' 有选文件按钮=' + hasFileBtn + ' 有表头说明=' + hasHint);
        // 关掉弹窗
        const closeBtn = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === '关闭');
        if (closeBtn) closeBtn.click();
        await new Promise(r => setTimeout(r, 200));
        const closed = !document.querySelector('.modal');
        steps.push('点击关闭后弹窗已消失=' + closed);
        return { ok: title.includes('导入成员主档') && hasFileBtn && hasHint && closed, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针6');
    for (const s of wizard.steps) log('[smoke] 向导:', s);
    log('[smoke] 导入向导界面接线  :', wizard.ok ? 'PASS' : 'FAIL');

    // 拖拽排表：用原生拖拽事件驱动看板，验证队员真的换了小队
    const dnd = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const api = window.omnia;
        const waitFor = async (fn, label, ms = 6000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };

        // 造两个人和一场对局：甲放进 防守一-1，乙留在未分配
        const p1 = await api.player.create({ gameId: 'smoke_dnd_1', name: '拖拽甲', mainClass: '神相' });
        const p2 = await api.player.create({ gameId: 'smoke_dnd_2', name: '拖拽乙', mainClass: '素问' });
        if (!p1.ok || !p2.ok) throw new Error('建档失败');
        smokeMade('player', p1.data.id);
        smokeMade('player', p2.data.id);
        const m = await api.match.create({ date: '2026-04-01', ourSide: '我方', oppSide: '拖拽队', result: 'WIN' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        const mid = m.data.match.id;
        smokeMade('match', mid);
        await api.match.upsertParticipation({ matchId: mid, playerId: p1.data.id, squad: '防守一-1', state: 'PLAY' });
        await api.match.upsertParticipation({ matchId: mid, playerId: p2.data.id, state: 'PLAY' });

        // 进入对局的阵容编排页
        const nav = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('对局与战报'));
        if (!nav) throw new Error('侧栏没有「对局与战报」');
        nav.click();
        await waitFor(() => document.querySelector('.modal') ? null : true, '弹窗关闭');

        // MatchPage 在列表加载完会自动进入第一场，所以这里两种状态都要能接住：
        //   ① 停在列表 → 点「进入」；② 已经进详情 → 直接切页签
        let entered = false;
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          const btn = [...document.querySelectorAll('table.grid button')]
            .find(b => b.textContent.trim() === '进入');
          if (btn) { btn.click(); entered = true; break; }
          if (document.querySelector('button.tab')) break;   // 已在详情
          await new Promise(r => setTimeout(r, 150));
        }
        steps.push('进入方式=' + (entered ? '点击「进入」' : '自动进入详情'));

        await waitFor(() => document.querySelector('button.tab') ? true : null, '页签');
        await waitFor(() => document.querySelector('button.tab') ? true : null, '页签');
        const tab = [...document.querySelectorAll('button.tab')].find(b => b.textContent.includes('阵容编排'));
        if (tab) tab.click();
        await waitFor(() => document.querySelectorAll('.squadrow').length > 0 ? true : null, '看板');

        // 诊断：看板到底拿到了什么
        const dbgParts = await api.match.participations(mid);
        steps.push('参战记录=' + JSON.stringify(dbgParts.data.map(r => ({
          name: r.name, gameId: r.gameId, squad: r.squad, state: r.state, side: r.side,
        }))));
        steps.push('看板里的 ID 名=' + JSON.stringify(
          [...document.querySelectorAll('.pcard__id')].map(e => e.textContent.trim())));

        // 找「拖拽甲」所在的卡片（在 防守一-1 那一行里）—— 卡片本身是拖拽源。
        // 注意：卡片标题是**角色 ID 名**（用户口径：标题=ID、第二行=职业、第三行=技能备注），
        // 真实姓名不上卡片，所以这里按 gameId 找，不能按姓名找。
        const blocks = [...document.querySelectorAll('.squadrow')];
        const fromBlock = blocks.find(b => b.dataset.squad === '防守一-1');
        if (!fromBlock) throw new Error('看板上找不到 防守一-1');
        const dragCard = [...fromBlock.querySelectorAll('.pcard')]
          .find(c => c.textContent.includes('smoke_dnd_1'));
        if (!dragCard) throw new Error('防守一-1 里找不到 smoke_dnd_1（拖拽甲的 ID）');
        steps.push('拖拽前 防守一-1 含 拖拽甲(ID)=' + !!dragCard);

        // 目标：进攻一-1（整行是落点）
        const toBlock = blocks.find(b => b.dataset.squad === '进攻一-1');
        if (!toBlock) throw new Error('看板上找不到 进攻一-1');

        // 先确认能否构造真正的 DataTransfer（Chromium 支持 new DataTransfer()）
        let dt = null;
        try {
          dt = new DataTransfer();
          dt.setData('text/plain', 'probe');
          steps.push('new DataTransfer() 可用，回读=' + JSON.stringify(dt.getData('text/plain')));
        } catch (e) {
          steps.push('new DataTransfer() 不可用: ' + String(e));
        }
        if (!dt) throw new Error('环境不支持构造 DataTransfer，无法用原生拖拽事件驱动（改为验证 DOM 接线 + 落库接口）');

        const store = dt;
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: store }));
        fire(dragCard, 'dragstart');
        fire(toBlock, 'dragover');
        fire(toBlock, 'drop');
        fire(dragCard, 'dragend');

        const KEY = 'application/x-omnia-player';
        steps.push('dragstart 写入的载荷=' + store.getData(KEY));

        // 等界面重新加载后核对（卡片上没有姓名，按 ID 名找）
        await waitFor(() => {
          const b = [...document.querySelectorAll('.squadrow')].find(x => x.dataset.squad === '进攻一-1');
          return b && b.textContent.includes('smoke_dnd_1') ? true : null;
        }, '拖拽后 进攻一-1 出现 拖拽甲(ID)');

        const parts = await api.match.participations(mid);
        const p1row = parts.data.find(r => r.gameId === 'smoke_dnd_1');
        steps.push('落库后 拖拽甲.squad=' + p1row?.squad + ' state=' + p1row?.state
          + ' tactic=' + (p1row?.tactic || '（空）'));
        const p2row = parts.data.find(r => r.gameId === 'smoke_dnd_2');
        steps.push('未分配的 拖拽乙.squad=' + JSON.stringify(p2row?.squad ?? ''));

        // 再把 拖拽乙 拖到「未分配」区应该没有效果（它本来就未分配）；
        // 改为验证 拖拽甲 拖回未分配区会被移除小队
        const chip = [...document.querySelectorAll('.board__chip')].find(c => c.textContent.includes('smoke_dnd_2'));
        steps.push('未分配区出现 拖拽乙=' + !!chip);

        await api.match.remove(mid);
        await api.player.remove(p1.data.id);
        await api.player.remove(p2.data.id);

        const ok = store.getData(KEY).includes('smoke_dnd_1')
          && p1row?.squad === '进攻一-1'
          && p1row?.state === 'PLAY'
          && p2row?.squad === ''
          && !!chip;        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针7');
    for (const s of dnd.steps) log('[smoke] 拖拽:', s);
    log('[smoke] 看板拖拽排表      :', dnd.ok ? 'PASS' : 'FAIL');

    // 成员详情：个人汇总 / 雷达对比 / 页面渲染
    const detail = await guarded(`(async () => {
      const steps = smokeSteps();
      const made = { players: [], matches: [] };
      try {
        const api = window.omnia;
        const waitFor = async (fn, label, ms = 6000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        // 主角：两场都填战报；队友：一场填、一场不填（用于验证"未填不计入数值"）
        const a = await api.player.create({ gameId: 'smoke_pd_1', name: '详情甲', mainClass: '神相', joinedOrder: 11 });
        const b = await api.player.create({ gameId: 'smoke_pd_2', name: '详情乙', mainClass: '素问', joinedOrder: 12 });
        if (!a.ok || !b.ok) throw new Error('建档失败');
        made.players.push(a.data.id, b.data.id);

        const m1 = await api.match.create({ date: '2026-05-01', ourSide: '我方', oppSide: '详情队A', result: 'WIN' });
        const m2 = await api.match.create({ date: '2026-05-08', ourSide: '我方', oppSide: '详情队B', result: 'LOSE' });
        if (!m1.ok || !m2.ok) throw new Error('建对局失败');
        made.matches.push(m1.data.match.id, m2.data.match.id);

        // 甲：两场都有战报（有效人伤 = dmg + armor，有效击杀 = kills + fountain）
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: a.data.id, squad: '进攻一-1', state: 'PLAY',
          stat: { kills: 20, fountainKills: 2, assists: 30, dmgPlayer: 1000, dmgPlayerArmor: 500, dmgBuilding: 300, dmgBuildingArmor: 100, healing: 0, damageTaken: 800, deaths: 2, revives: 0, boneBurn: 5 } });
        await api.match.upsertParticipation({ matchId: m2.data.match.id, playerId: a.data.id, squad: '进攻一-1', state: 'PLAY',
          stat: { kills: 10, fountainKills: 1, assists: 20, dmgPlayer: 600, dmgPlayerArmor: 200, dmgBuilding: 100, dmgBuildingArmor: 0, damageTaken: 400, deaths: 1 } });
        // 乙：第一场填，第二场只上场不填
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: b.data.id, squad: '防守一-1', state: 'PLAY',
          stat: { assists: 40, healing: 2000, damageTaken: 300, deaths: 1 } });
        await api.match.upsertParticipation({ matchId: m2.data.match.id, playerId: b.data.id, squad: '防守一-1', state: 'PLAY' });

        const d = await api.player.detail(a.data.id);
        if (!d.ok) throw new Error('取详情失败: ' + d.error);
        const t = d.data.totals;
        steps.push('场次=' + t.matches + ' 上场=' + t.plays + ' 已填战报=' + t.statFilled);
        steps.push('有效击杀=' + t.effKills + '（应 20+2+10+1=33）');
        steps.push('有效人伤=' + t.effDmg + '（应 1500+800=2300）');
        steps.push('有效塔伤=' + t.effTower + '（应 400+100=500）');
        steps.push('助攻=' + t.assists + ' 重伤=' + t.deaths + ' 承伤=' + t.taken);
        steps.push('逐场条数=' + d.data.matches.length + ' 首条=' + d.data.matches[0].matchLabel
          + ' 职业=' + d.data.matches[0].classUsed + ' 状态=' + d.data.matches[0].state);
        steps.push('雷达维度=' + d.data.radar.map(r => r.label + ':' + r.ratio.toFixed(2)).join(' '));
        const kb = d.data.radar.find(r => r.key === 'kill');
        const kd = d.data.radar.find(r => r.key === 'dmg');
        steps.push('球队人均 有效击杀=' + d.data.teamAverage.effKills.toFixed(2)
          + ' 有效人伤=' + d.data.teamAverage.effDmg.toFixed(2));

        // 乙：第二场没填战报，plays=2 但 statFilled=1
        const d2 = await api.player.detail(b.data.id);
        steps.push('乙 上场=' + (d2.ok ? d2.data.totals.plays : '?')
          + ' 已填战报=' + (d2.ok ? d2.data.totals.statFilled : '?') + '（应 2 / 1）');

        // 页面渲染：进成员主档 → 点某张成员卡片上的「详情」
        // 注意：成员列表已从表格改为卡片，选择器要跟着改（找不到就会超时，
        // 进而跳过下面的清理、把残留数据留给后面的探针 —— 已经踩过一次）
        const nav = [...document.querySelectorAll('button.nav-item')].find(x => x.textContent.includes('成员主档'));
        nav.click();
        const btn = await waitFor(() => [...document.querySelectorAll('.roster-card__actions button')]
          .find(x => x.textContent.trim() === '详情'), '「详情」按钮');
        btn.click();
        const radar = await waitFor(() => document.querySelector('svg.radar'), '雷达图');
        const polygons = radar.querySelectorAll('polygon').length;
        const labels = [...radar.querySelectorAll('text')].map(e => e.textContent);
        const rows = document.querySelectorAll('table.grid tbody tr').length;
        steps.push('雷达多边形=' + polygons + '（个人 + 基准圈 = 2）标签=' + labels.join('/'));
        steps.push('雷达下方对比表行数=' + rows);
        const back = [...document.querySelectorAll('button')].find(x => x.textContent.includes('← 成员主档'));
        if (back) back.click();
        await waitFor(() => document.querySelector('button') && !document.querySelector('svg.radar') ? true : null, '返回主档');

        for (const id of made.matches) await api.match.remove(id);
        for (const id of made.players) await api.player.remove(id);

        const ok = t.matches === 2 && t.plays === 2 && t.statFilled === 2
          && t.effKills === 33 && t.effDmg === 2300 && t.effTower === 500
          && t.assists === 50 && t.deaths === 3 && t.taken === 1200
          && d.data.matches[0].matchLabel.includes('2026-05-08')
          && kb && kd && Math.abs(kb.self - 16.5) < 0.001 && Math.abs(kd.self - 1150) < 0.001
          && d2.ok && d2.data.totals.plays === 2 && d2.data.totals.statFilled === 1
          && polygons === 2 && labels.length >= 6;
        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针8');
    for (const s of detail.steps) log('[smoke] 详情:', s);
    log('[smoke] 成员详情页        :', detail.ok ? 'PASS' : 'FAIL');

    // 报名 / 请假：标记 → 应用上场名单 → 校验状态流转
    const signup = await guarded(`(async () => {
      const steps = smokeSteps();
      const made = { players: [], matches: [] };
      try {
        const api = window.omnia;
        const p1 = await api.player.create({ gameId: 'smoke_sg_1', name: '报名甲', mainClass: '神相', joinedOrder: 1 });
        const p2 = await api.player.create({ gameId: 'smoke_sg_2', name: '报名乙', mainClass: '素问', joinedOrder: 2 });
        const p3 = await api.player.create({ gameId: 'smoke_sg_3', name: '报名丙', mainClass: '铁衣', joinedOrder: 3 });
        const p4 = await api.player.create({ gameId: 'smoke_sg_4', name: '报名丁', mainClass: '潮光', joinedOrder: 4 });
        if (![p1,p2,p3,p4].every(r => r.ok)) throw new Error('建档失败');
        for (const p of [p1,p2,p3,p4]) made.players.push(p.data.id);

        const m = await api.match.create({ date: '2026-06-01', ourSide: '我方', oppSide: '报名队', result: 'WIN' });
        if (!m.ok) throw new Error('建对局失败');
        const mid = m.data.match.id;
        made.matches.push(mid);

        // 初始：全员未报名
        let b = await api.signup.board(mid);
        if (!b.ok) throw new Error('取报名面板失败: ' + b.error);
        steps.push('初始 未报名=' + b.data.stats.none + ' 参加=' + b.data.stats.joined
          + ' 在队未报名=' + b.data.stats.pending);

        // 标记：甲参加、乙替补、丙请假、丁不动
        await api.signup.set({ matchId: mid, playerId: p1.data.id, status: 'JOIN' });
        await api.signup.set({ matchId: mid, playerId: p2.data.id, status: 'BENCH' });
        const leaveRow = await api.signup.set({ matchId: mid, playerId: p3.data.id, status: 'LEAVE', remark: '家里有事' });
        if (!leaveRow.ok) throw new Error('标请假失败: ' + leaveRow.error);
        steps.push('请假记录 备注=' + leaveRow.data.signupRemark + ' 提交时间=' + (leaveRow.data.signupAt ? '有' : '无'));

        b = await api.signup.board(mid);
        steps.push('标记后 参加=' + b.data.stats.joined + ' 替补=' + b.data.stats.bench
          + ' 请假=' + b.data.stats.leave + ' 未报名=' + b.data.stats.none);
        const dRow = b.data.rows.find(r => r.gameId === 'smoke_sg_4');
        steps.push('丁 报名=' + dRow.signup + ' 上场名单=' + dRow.lineupState);

        // 撤回请假改回参加后，取最新一次面板作为断言依据（避免用过期快照）
        await api.signup.set({ matchId: mid, playerId: p3.data.id, status: 'JOIN' });
        const boardNow = await api.signup.board(mid);
        if (!boardNow.ok) throw new Error('取最新面板失败');
        steps.push('最终报名统计 参加=' + boardNow.data.stats.joined
          + ' 替补=' + boardNow.data.stats.bench
          + ' 请假=' + boardNow.data.stats.leave
          + ' 未报名=' + boardNow.data.stats.none);

        // 应用到场名单
        const applied = await api.signup.apply(mid, []);
        if (!applied.ok) throw new Error('应用失败: ' + applied.error);
        steps.push('应用条数=' + applied.data.applied);

        const parts = await api.match.participations(mid);
        const byName = Object.fromEntries(parts.data.map(p => [p.gameId, p.state + '/' + (p.squad || '未分配')]));
        steps.push('应用后 甲=' + byName['smoke_sg_1'] + ' 乙=' + byName['smoke_sg_2']
          + ' 丙=' + byName['smoke_sg_3'] + ' 丁=' + byName['smoke_sg_4']);

        // 甲先排进小队，再"应用一次"应该保留小队（只有状态被拉回上场）
        await api.match.upsertParticipation({ matchId: mid, playerId: p1.data.id, squad: '防守一-1', state: 'PLAY' });
        await api.signup.apply(mid, [p1.data.id]);
        const parts2 = await api.match.participations(mid);
        const jia = parts2.data.find(p => p.gameId === 'smoke_sg_1');
        steps.push('再次应用后 甲 squad=' + jia.squad + '（应保留 防守一-1）');

        // 界面渲染
        const nav = [...document.querySelectorAll('button.nav-item')].find(x => x.textContent.includes('对局与战报'));
        nav.click();
        const waitFor = async (fn, label, ms = 8000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        // 可能停在列表，也可能自动进入详情
        const tEnter = Date.now();
        while (Date.now() - tEnter < 6000) {
          const btn = [...document.querySelectorAll('table.grid button')].find(x => x.textContent.trim() === '进入');
          if (btn) { btn.click(); break; }
          if (document.querySelector('button.tab')) break;
          await new Promise(res => setTimeout(res, 150));
        }
        const tab = await waitFor(() => [...document.querySelectorAll('button.tab')]
          .find(x => x.textContent.includes('报名')), '报名页签');
        tab.click();
        // 等报名表真的出现数据（只看 table 存在会太早）
        await waitFor(() => document.querySelector('.row-edit') ? true : null, '报名行（标记按钮组）');
        const rows = document.querySelectorAll('table.grid tbody tr').length;
        const marks = document.querySelectorAll('table.grid .row-edit').length;
        const title = (document.querySelector('.card h3')?.textContent ?? '');
        steps.push('报名页 行数=' + rows + ' 每行标记按钮组=' + marks + ' 标题=' + JSON.stringify(title));

        for (const id of made.matches) await api.match.remove(id);
        for (const id of made.players) await api.player.remove(id);

        // 甲 JOIN、乙 BENCH、丙 LEAVE→改回 JOIN ⇒ 参加 2 / 替补 1 / 请假 0 / 未报名 2（另含探针成员）
        const ok = boardNow.data.stats.joined === 2 && boardNow.data.stats.bench === 1
          && boardNow.data.stats.leave === 0 && boardNow.data.stats.none === 2
          && dRow.signup === null && dRow.lineupState === null
          && byName['smoke_sg_1'] === 'PLAY/未分配'
          && byName['smoke_sg_2'] === 'BENCH/未分配'
          && byName['smoke_sg_3'] === 'PLAY/未分配'
          && byName['smoke_sg_4'] === undefined
          && jia.squad === '防守一-1'
          && rows >= 4 && marks >= 4;
        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针9');
    for (const s of signup.steps) log('[smoke] 报名:', s);
    log('[smoke] 报名与请假        :', signup.ok ? 'PASS' : 'FAIL');

    // 规则集：默认值/校验/新建/版本递增/编辑/另存/激活/删除保护/页面渲染
    const rules = await guarded(`(async () => {
      const steps = smokeSteps();
      const madeIds = [];
      try {
        const api = window.omnia;
        const psum = (o) => Object.values(o).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
        const def = await api.rules.defaults();
        if (!def.ok) throw new Error('取默认值失败: ' + def.error);
        const d = def.data;
        steps.push('默认值 基础=' + d.baseScore + ' 封顶=' + d.capScore
          + ' 团队x' + d.scaleTeam + ' 个人x' + d.scalePersonal + ' 死亡扣' + d.deathPen + ' 塔=' + d.totalTowers);
        steps.push('默认个人权重和 DPS=' + psum(d.personalWeights.DPS).toFixed(3)
          + ' T=' + psum(d.personalWeights.T).toFixed(3)
          + ' HEAL=' + psum(d.personalWeights.HEAL).toFixed(3));
        steps.push('默认战术权重和 push=' + psum(d.execWeights.push).toFixed(4)
          + ' (应=1) guard=' + psum(d.execWeights.guard).toFixed(2)
          + ' defend=' + psum(d.execWeights.defend).toFixed(2));

        const okVal = await api.rules.validate(d);
        const okValWarns = okVal.data.issues.filter(i => i.level === 'warn');
        steps.push('默认值校验 ok=' + okVal.data.ok + ' 提示数=' + okVal.data.issues.length
          + '（应全为 warn：原表个人权重未归一化，默认值刻意保留原样）');
        steps.push('校验提示字段=' + okValWarns.map(i => i.field).join(','));

        const bad = JSON.parse(JSON.stringify(d));
        bad.capScore = 50;
        bad.personalWeights.DPS.kill = 9;
        bad.classCoef['神相'] = -1;
        const badVal = await api.rules.validate(bad);
        const hasErr = badVal.data.issues.some(i => i.level === 'error' && i.field === 'capScore');
        const hasWarn = badVal.data.issues.some(i => i.level === 'warn' && i.field.indexOf('personalWeights.DPS') === 0);
        steps.push('错误值校验 ok=' + badVal.data.ok + ' 封顶错误被拦=' + hasErr + ' 权重和警告=' + hasWarn);

        const before = await api.rules.list();
        const maxV = Math.max(0, ...before.data.map(r => r.version));

        const created = await api.rules.create({ ...d, name: '自检规则A' });
        if (!created.ok) throw new Error('新建失败: ' + created.error);
        madeIds.push(created.data.id);
        steps.push('新建 v' + created.data.version + '（原最大 v' + maxV + '）');

        const dup = await api.rules.duplicate(created.data.id, '自检规则B');
        if (!dup.ok) throw new Error('另存失败: ' + dup.error);
        madeIds.push(dup.data.id);
        steps.push('另存 v' + dup.data.version + ' 名称=' + dup.data.name);

        const edited = await api.rules.update(created.data.id, { ...d, name: '自检规则A改', deathPen: 4.5 });
        if (!edited.ok) throw new Error('编辑失败: ' + edited.error);
        steps.push('编辑后 名称=' + edited.data.name + ' 死亡扣=' + edited.data.deathPen + ' 版本仍 v' + edited.data.version);

        const act = await api.rules.setActive(dup.data.id);
        if (!act.ok) throw new Error('激活失败: ' + act.error);
        const listNow = await api.rules.list();
        const activeCount = listNow.data.filter(r => r.active).length;
        steps.push('激活后 使用中数量=' + activeCount + ' 名称=' + listNow.data.find(r => r.active).name);

        const delActive = await api.rules.remove(dup.data.id);
        steps.push('删除使用中的规则被拦=' + (delActive.ok ? '否（异常！）' : '是'));

        const nav = [...document.querySelectorAll('button.nav-item')].find(x => x.textContent.indexOf('权重与规则') >= 0);
        nav.click();
        const waitFor = async (fn, label, ms = 8000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        await waitFor(() => document.querySelector('table.grid tbody tr') ? true : null, '规则列表');
        const listRows = document.querySelectorAll('table.grid tbody tr').length;
        const editBtn = await waitFor(() => [...document.querySelectorAll('button')]
          .find(x => x.textContent.trim() === '编辑'), '编辑按钮');
        editBtn.click();
        await waitFor(() => [...document.querySelectorAll('h3')].some(h => h.textContent.indexOf('个人权重') >= 0)
          ? true : null, '权重编辑区');
        const coefInputs = document.querySelectorAll('.coef-item input').length;
        const numInputs = document.querySelectorAll('input.cell-num').length;
        const activeBadge = [...document.querySelectorAll('.badge-state')].filter(b => b.textContent.indexOf('使用中') >= 0).length;
        steps.push('规则页 列表行=' + listRows + ' 使用中标记=' + activeBadge
          + ' 权重输入框=' + numInputs + ' 职业系数框=' + coefInputs);

        for (const id of madeIds) await api.rules.remove(id);
        const after = await api.rules.list();
        steps.push('清理后规则集数=' + after.data.length);

        const ok = d.baseScore === 60 && d.capScore === 100 && d.scaleTeam === 20 && d.scalePersonal === 40
          && d.deathPen === 3 && d.totalTowers === 9
          && Math.abs(psum(d.execWeights.push) - 1) < 1e-9
          && Math.abs(psum(d.personalWeights.DPS) - 3.6) < 1e-9
          && okVal.data.ok === true
          && okVal.data.issues.every(i => i.level === 'warn') && okVal.data.issues.length === 3
          && badVal.data.ok === false && hasErr && hasWarn
          && created.data.version === maxV + 1 && dup.data.version === maxV + 2
          && edited.data.version === created.data.version && edited.data.deathPen === 4.5
          && activeCount === 1 && delActive.ok === false
          && listRows >= 1 && coefInputs === 12 && numInputs > 10 && activeBadge === 1;
        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针10');
    for (const s of rules.steps) log('[smoke] 规则:', s);
    log('[smoke] 规则集管理        :', rules.ok ? 'PASS' : 'FAIL');

    // 首页首屏：渐变铺满 + 钉住不动 + 下滑时数据层从下往上盖住
    const guide = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const waitFor = async (fn, label, ms = 10000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 200)); }
          throw new Error('等待超时：' + label);
        };
        const home = [...document.querySelectorAll('button.nav-item')].find(x => x.textContent.indexOf('总览') >= 0);
        if (!home) throw new Error('侧栏没有「总览」');
        home.click();
        // 首屏与数据层都要在
        await waitFor(() => document.querySelector('.hero--pinned') ? true : null, '首屏');
        await waitFor(() => document.querySelector('.hero-cover') ? true : null, '数据层');
        const content = document.querySelector('.content');
        const heroEl = document.querySelector('.hero--pinned');
        const coverEl = document.querySelector('.hero-cover');
        content.scrollTop = 0;
        await new Promise(res => setTimeout(res, 250));
        const restTop = Math.round(heroEl.getBoundingClientRect().top);
        const coverTopAtRest = Math.round(coverEl.getBoundingClientRect().top);
        // 往下滚：首屏应钉住不动，数据层升上来把它盖住
        content.scrollTop = Math.round(content.clientHeight * 0.6);
        await new Promise(res => setTimeout(res, 350));
        const pinnedTop = Math.round(heroEl.getBoundingClientRect().top);
        const coverTop = Math.round(coverEl.getBoundingClientRect().top);
        const heroBottom = Math.round(heroEl.getBoundingClientRect().bottom);
        steps.push('首屏静止 top=' + restTop + '（应≈顶栏下方 46）高度='
          + Math.round(heroEl.getBoundingClientRect().height));
        steps.push('滚动后 首屏 top=' + pinnedTop + '（应与静止一致=钉住）'
          + ' 数据层 top=' + coverTop + ' 首屏底=' + heroBottom
          + ' 覆盖=' + (coverTop < heroBottom));
        steps.push('静止时数据层在首屏下方=' + (coverTopAtRest >= heroBottom));
        const heroOk = Math.abs(pinnedTop - restTop) <= 2
          && restTop <= 52                      // 铺满：紧贴顶栏，没有 16px 灰条
          && coverTop < heroBottom
          && coverTopAtRest >= heroBottom;
        content.scrollTop = 0;
        await new Promise(res => setTimeout(res, 200));
        steps.push('首屏结构判定=' + heroOk);

        // 攻略页必须已经从导航里消失
        const stillThere = [...document.querySelectorAll('button.nav-item')]
          .some(x => x.textContent.indexOf('攻略') >= 0);
        steps.push('导航里仍有「攻略」=' + stillThere);

        // 主题令牌必须已切到单色稿：背景主色 = 第 3 个色 #E6E1E6
        const bgComputed = getComputedStyle(document.body).backgroundColor;
        const heroCard = document.querySelector('.card') ? getComputedStyle(document.querySelector('.card')).backgroundColor : '';
        steps.push('主题 页面背景=' + bgComputed + '（应 rgb(230,225,230)） 卡片=' + heroCard + '（应 rgb(252,248,253)）');
        const themeOk = bgComputed === 'rgb(230, 225, 230)' && heroCard === 'rgb(252, 248, 253)';

        // 导航栏折叠/展开：宽度真的变、标签真的藏、偏好真的落库
        const app = document.querySelector('.app');
        const toggle = document.querySelector('.nav-toggle');
        if (!toggle) throw new Error('顶栏没有 .nav-toggle 折叠按钮');
        const sideW = () => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width);
        const labelVisible = () => {
          const el = document.querySelector('.nav-item .nav-label');
          return !!(el && el.getBoundingClientRect().width > 0);
        };
        const wOpen = sideW();
        const labelOpen = labelVisible();
        const bgOpen = getComputedStyle(app).gridTemplateColumns;

        toggle.click();
        await new Promise(r => setTimeout(r, 300));
        const wShut = sideW();
        const labelShut = labelVisible();
        const collapsedClass = app.classList.contains('nav-collapsed');

        const savedShut = await window.omnia.meta.settings();
        // 先不展开：留给主进程截图，截完由主进程点一下恢复
        steps.push('折叠前 侧栏=' + wOpen + 'px 标签可见=' + labelOpen + ' grid=' + bgOpen);
        // 收起必须**完全隐藏**（宽度 0），不能留图标条 —— 用户口径
        steps.push('折叠后 侧栏=' + wShut + 'px（应为 0 = 完全隐藏）标签可见=' + labelShut
          + ' nav-collapsed=' + collapsedClass + ' 落库 navCollapsed=' + JSON.stringify(savedShut.data.navCollapsed));

        return {
          ok: heroOk
            && stillThere === false
            && themeOk
            && wOpen > 180 && wShut === 0 && labelOpen && !labelShut && collapsedClass
            && savedShut.data.navCollapsed === '1',
          steps,
        };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针11');
    for (const s of guide.steps) log('[smoke] 首页:', s);
    // 注意：这里不再截图。capturePage 对「纯布局变化」（CSS class 切换）不刷新合成帧，
    // 只会拍到上一帧，反而误导。折叠后的宽度/标签可见性是直接在 DOM 上量的，更可信。
    const navResume = await guarded(`(async () => {
      const steps = smokeSteps();
      const toggle = document.querySelector('.nav-toggle');
      toggle.click();
      await new Promise(r => setTimeout(r, 300));
      const el = document.querySelector('.nav-item .nav-label');
      const s = await window.omnia.meta.settings();
      const w = Math.round(document.querySelector('.sidebar').getBoundingClientRect().width);
      steps.push('再展开 侧栏=' + w + 'px 标签可见=' + !!(el && el.getBoundingClientRect().width > 0)
        + ' 落库 navCollapsed=' + JSON.stringify(s.data.navCollapsed));
      return {
        ok: w > 180 && !!(el && el.getBoundingClientRect().width > 0) && s.data.navCollapsed === '0',
        steps,
      };
    })()`, '探针11b');
    for (const s of navResume.steps) log('[smoke] 首页:', s);
    guide.ok = guide.ok && navResume.ok;
    log('[smoke] 首页立绘与导航    :', guide.ok ? 'PASS' : 'FAIL');

    // 排表页：独立成页后必须能从侧栏直达，且带上场次选择与完整看板。
    // 注意：跑到这里时前面探针的对局都已清理，所以本探针自己造一场
    // （否则页面会正确地显示"还没有对局"，断言就没意义了）。
    const lineup = await guarded(`(async () => {
      const steps = smokeSteps();
      let madePlayer = null;
      let madePlayer2 = null;
      let madeMatch = null;
      try {
        const api = window.omnia;
        const p = await api.player.create({ gameId: 'smoke_lineup_1', name: '排表测试员', mainClass: '神相' });
        if (!p.ok) throw new Error('建档失败: ' + p.error);
        madePlayer = p.data.id;
        smokeMade('player', p.data.id);
        // 再来一个「未分配」的人：未分配区只在有未分配队员时才渲染，
        // 不造一个的话就测不到"拖回未分配"这条路径
        const p2 = await api.player.create({ gameId: 'smoke_lineup_2', name: '排表测试员乙', mainClass: '素问' });
        if (!p2.ok) throw new Error('建档失败2: ' + p2.error);
        madePlayer2 = p2.data.id;
        smokeMade('player', p2.data.id);
        const m = await api.match.create({ date: '2026-08-01', ourSide: '我方', oppSide: '排表队' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        madeMatch = m.data.match.id;
        smokeMade('match', m.data.match.id);
        await api.match.upsertParticipation({
          matchId: madeMatch, playerId: madePlayer, squad: '防守一-1', state: 'PLAY',
        });
        await api.match.upsertParticipation({
          matchId: madeMatch, playerId: madePlayer2, state: 'PLAY',
        });

        const nav = [...document.querySelectorAll('button.nav-item')]
          .find(x => x.textContent.indexOf('排表') >= 0);
        if (!nav) throw new Error('侧栏没有「排表」');
        nav.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          if (document.querySelector('.squadrow')) break;
          await new Promise(r => setTimeout(r, 150));
        }
        const blocks = document.querySelectorAll('.squadrow').length;
        const picker = document.querySelector('.field select');
        const opts = picker ? picker.querySelectorAll('option').length : 0;
        // 队名取 head 里第一个子元素（避免用到正则 —— 见 M5 探针里的说明）
        const names = [...document.querySelectorAll('.squadrow__head')]
          .map(e => (e.firstElementChild ? e.firstElementChild.textContent : '').trim())
          .filter(Boolean);
        const cards = document.querySelectorAll('.pcard').length;
        const noteInputs = document.querySelectorAll('.pcard__note').length;
        const hasBench = document.body.textContent.indexOf('未分配') >= 0;
        const active = document.querySelector('button.nav-item.active')?.textContent?.trim() ?? '';
        // 造的那个人应该出现在看板上（卡片标题是 ID 名，不是姓名）
        const showsPlayer = document.body.textContent.indexOf('smoke_lineup_1') >= 0;
        steps.push('排表页 小队行=' + blocks + ' 场次选择器=' + !!picker + ' 场次选项=' + opts);
        steps.push('卡片=' + cards + ' 技能备注框=' + noteInputs
          + ' 小队（前4）=' + names.slice(0, 4).join(',') + ' 有未分配区=' + hasBench
          + ' 显示本场队员=' + showsPlayer);
        steps.push('当前导航=' + JSON.stringify(active));
        return {
          ok: blocks === 12 && !!picker && opts >= 1 && hasBench && showsPlayer
            && active.indexOf('排表') >= 0,
          steps,
          // 清理句柄必须放在 value 里：guarded 只透传 ok/steps/value，直接挂顶层会被丢掉
          value: { cleanup: { playerId: madePlayer, playerIds: [madePlayer, madePlayer2], matchId: madeMatch } },
        };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针11c');
    for (const s of lineup.steps) log('[smoke] 排表:', s);
    log('[smoke] 排表页            :', lineup.ok ? 'PASS' : 'FAIL');

    // 排表页尺寸实测：卡片 16:9 是否真的成立、看板有没有占满可用区域。
    // 这类"比例对不对"的问题，肉眼看截图判断不了，必须量。
    const geom = await guarded(`(async () => {
      const steps = smokeSteps();
      const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
      const card = document.querySelector('.pcard:not(.pcard--empty)') || document.querySelector('.pcard');
      const row = document.querySelector('.squadrow');
      const board = document.querySelector('.board');
      const scroll = document.querySelector('.board__scroll');
      const content = document.querySelector('.content');
      const halves = document.querySelector('.board__halves');
      const cs = card ? getComputedStyle(card) : null;
      const cardBox = card ? r(card) : { w: 0, h: 0 };
      const ratio = cardBox.h ? +(cardBox.w / cardBox.h).toFixed(3) : 0;
      const boardBox = board ? r(board) : { w: 0, h: 0 };
      const contentBox = content ? r(content) : { w: 0, h: 0 };
      const scrollBox = scroll ? r(scroll) : { w: 0, h: 0 };
      const halvesBox = halves ? r(halves) : { w: 0, h: 0 };
      const rowBox = row ? r(row) : { w: 0, h: 0 };
      const rows = document.querySelectorAll('.squadrow').length;
      const cols = document.querySelectorAll('.squadrow__cards > *').length;
      const cardsPerRow = rows ? Math.round(cols / rows) : 0;
      const head = document.querySelector('.squadrow__head');
      const headBox = head ? r(head) : { w: 0, h: 0 };
      steps.push('卡片=' + cardBox.w + 'x' + cardBox.h + ' 比例=' + ratio + '（16:9=1.778）');
      // 实测三行字号（计算值），确认 CSS 真的生效、没被别处盖掉
      const idEl = document.querySelector('.pcard__id');
      const clsEl = document.querySelector('.pcard__cls');
      const noteEl = document.querySelector('.pcard__note');
      const fs = (el) => (el ? getComputedStyle(el).fontSize : '（无）');
      const fw = (el) => (el ? getComputedStyle(el).fontWeight : '');
      // 排表功能区各处的字号全量实测（用户问"各个卡片字号多少"，不凭记忆答）
      const probe = (sel) => {
        const el = document.querySelector(sel);
        return el ? (getComputedStyle(el).fontSize + '/' + getComputedStyle(el).fontWeight) : '（无）';
      };
      steps.push('字号全览（字号/字重）:'        + ' 队名=' + probe('.squadrow__name')
        + ' 人数=' + probe('.squadrow__count')
        + ' 战术=' + probe('.squadrow__tactic--edit')
        + ' 组名=' + probe('.half__groupname')
        + ' 加一队=' + probe('.half__addbtn')
        + ' ID=' + probe('.pcard__id')
        + ' 职业=' + probe('.pcard__cls')
        + ' 备注=' + probe('.pcard__note')
        + ' 空位=' + probe('.pcard__empty')
        + ' 未分配标题=' + probe('.board__unassigned-title')
        + ' 未分配chip=' + probe('.board__chip'));
      // 尺寸全览：卡片（已填/空位）、队名列、小队行、组间距
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return '（无）';
        const b = el.getBoundingClientRect();
        return Math.round(b.width) + 'x' + Math.round(b.height);
      };
      steps.push('尺寸全览:'
        + ' 卡片(已填)=' + box('.pcard:not(.pcard--empty)')
        + ' 卡片(空位)=' + box('.pcard--empty')
        + ' 队名列=' + box('.squadrow__head')
        + ' 小队行=' + box('.squadrow')
        + ' 卡片区=' + box('.squadrow__cards')
        + ' 卡片间距=' + (() => {
          const c = document.querySelectorAll('.squadrow__cards > *');
          if (c.length < 2) return '?';
          const a = c[0].getBoundingClientRect(); const b2 = c[1].getBoundingClientRect();
          return Math.round(b2.left - a.right) + 'px';
        })());
      // 两个半区中间的分隔（默认竖排「万象」；设了 dividerImage 就显示图片）
      const dv = document.querySelector('.board__divider');
      if (dv) {
        const db = dv.getBoundingClientRect();
        const dc = getComputedStyle(dv);
        const cal = dv.querySelector('.board__calligraphy');
        const cc = cal ? getComputedStyle(cal) : null;
        steps.push('中缝分隔: ' + Math.round(db.width) + 'x' + Math.round(db.height)
          + ' 背景=' + dc.backgroundColor + ' 圆角=' + dc.borderRadius
          + '（宽度应为 344）'
          + ' ｜ 书法字=' + (cc ? (cc.fontSize + ' ' + cc.fontFamily.split(',')[0] + ' 颜色=' + cc.color
            + ' 透明度=' + cc.opacity + ' 书写方向=' + cc.writingMode + ' 字距=' + cc.letterSpacing) : '（未显示）'));
        // 中缝图片：设了 dividerImage 后应渲染 <img> 且 object-fit:cover（横向铺满裁剪）
        // 注意：探针里没有组件内的 api 变量，必须用 window.omnia
        const savedOld = await window.omnia.meta.settings();
        const prev = savedOld.data.dividerImage ?? '';
        const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        await window.omnia.meta.setSetting('dividerImage', px);
        // 用同一事件通知看板（与设置页选图后的路径一致），不必切页重挂载
        window.dispatchEvent(new CustomEvent('omnia:divider-image', { detail: px }));
        await new Promise(r => setTimeout(r, 400));
        const imgEl = document.querySelector('.board__divider-img');
        const ic = imgEl ? getComputedStyle(imgEl) : null;
        const ib = imgEl ? imgEl.getBoundingClientRect() : null;
        steps.push('中缝图片: 渲染=' + !!imgEl
          + ' object-fit=' + (ic ? ic.objectFit : '（无）')
          + ' 显示尺寸=' + (ib ? Math.round(ib.width) + 'x' + Math.round(ib.height) : '（无）')
          + ' 中缝=' + Math.round(db.width) + 'x' + Math.round(db.height)
          + '（宽应=172：居中占一半，两侧各 86px 由底色补）');
        await window.omnia.meta.setSetting('dividerImage', prev);   // 还原
        await new Promise(r => setTimeout(r, 300));
      } else {
        steps.push('中缝分隔: 未渲染');
      }
      steps.push('字号实测 ID=' + fs(idEl) + ' 职业=' + fs(clsEl) + ' 备注=' + fs(noteEl)
        + '（应为 25px / 15px / 17px）');
      // 内容有没有被卡片裁掉：三个子元素的高度之和 vs 卡片可用高度
      const inner = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
      const need = inner(idEl) + inner(clsEl) + inner(noteEl);
      const avail = cardBox.h - 12;   // 卡片上下 padding 各 6
      steps.push('内容高度=' + need + ' 卡片可用高=' + avail
        + ' 会不会被裁=' + (need > avail));
      steps.push('一队=' + rowBox.w + 'x' + rowBox.h + ' 每行卡片数=' + cardsPerRow
        + ' 队名列=' + headBox.w);
      steps.push('看板=' + boardBox.w + 'x' + boardBox.h
        + ' 滚动区=' + scrollBox.w + 'x' + scrollBox.h
        + ' 半区总宽=' + halvesBox.w);
      steps.push('内容区=' + contentBox.w + 'x' + contentBox.h
        + ' → 横向留白=' + (contentBox.w - boardBox.w));
      // 逐层量：内容区 → card(内边距) → board → scroll → halves，看空间丢在哪一层
      const cardEl = document.querySelector('.content .card .board')
        ? document.querySelector('.content .card .board').closest('.card') : null;
      const layers = [];
      let el = board ? board.parentElement : null;
      while (el && el !== content) {
        const b = r(el);
        layers.push((el.className || el.tagName) + '=' + b.w + 'x' + b.h);
        el = el.parentElement;
      }
      steps.push('外层链=' + layers.join(' ← '));
      if (cardEl) {
        const cb = r(cardEl);
        const ccs = getComputedStyle(cardEl);
        steps.push('card=' + cb.w + 'x' + cb.h + ' padding=' + ccs.padding
          + ' → 看板可用宽=' + (cb.w - parseFloat(ccs.paddingLeft) - parseFloat(ccs.paddingRight))
          + ' 可用高=' + (cb.h - parseFloat(ccs.paddingTop) - parseFloat(ccs.paddingBottom)));
      }
      const toolbar = document.querySelector('.content .card .toolbar');
      if (toolbar) {
        const tb = r(toolbar);
        steps.push('场次工具条=' + tb.w + 'x' + tb.h);
      }
      // 竖直方向：行数 × 行高 是否装得下内容区
      const rowsPerHalf = Math.ceil(rows / 2);
      const needH = rowsPerHalf * rowBox.h + rowsPerHalf * 8;
      steps.push('单半区需要高度≈' + needH + ' 可用高度≈' + contentBox.h
        + ' 装得下=' + (needH <= contentBox.h));
      return { ok: true, steps, value: { cardBox, rowBox, boardBox, contentBox, scrollBox, halvesBox, rows, fonts: { id: fs(idEl), cls: fs(clsEl), note: fs(noteEl) } } };
    })()`, '探针11d');
    for (const s of geom.steps) log('[smoke] 排表尺寸:', s);
    // 三行字号必须正好是用户指定的 22 / 13 / 15 ——
    // 之前两条 .pcard__note 规则同名覆盖，把 15px 悄悄改成 10px，靠这条断言才抓住
    {
      const g = geom.value as { fonts?: { id: string; cls: string; note: string } } | undefined;
      const f = g?.fonts;
      const fontsOk = f?.id === '25px' && f?.cls === '15px' && f?.note === '17px';
      if (!fontsOk) log('[smoke] 排表字号            : FAIL', JSON.stringify(f));
      else log('[smoke] 排表字号            : PASS ID=25px 职业=15px 备注=17px');
      geom.ok = geom.ok && fontsOk;
    }
    await shot('lineup', 900);
    // 前面几个探针会切页，等排表页真正画出来再截第二张（截图只信合成帧，必须留足时间）
    await guarded(`(async () => {
      const nav = [...document.querySelectorAll('button.nav-item')]
        .find(x => x.textContent.indexOf('排表') >= 0);
      if (nav) nav.click();
      await new Promise(r => setTimeout(r, 1200));
      return { ok: true, steps: [] };
    })()`, '回到排表页');
    await shot('lineup-settled', 1200);
    {
      const c = (lineup.value as { cleanup?: { playerIds?: number[]; matchId: number } } | undefined)?.cleanup;
      if (c?.matchId) await guarded(`window.omnia.match.remove(${c.matchId}).catch(() => {})`, '清理排表对局');
      for (const pid of c?.playerIds ?? []) {
        await guarded(`window.omnia.player.remove(${pid}).catch(() => {})`, `清理排表成员${pid}`);
      }
    }

    // 截取图片：验证「截取图片」按钮存在，且真能截出功能区 PNG。
    // 自检下走 OMNIA_CAPTURE_DIR 出口（不弹模态保存框，否则会卡住无人值守自检）。
    const cap = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const btn = [...document.querySelectorAll('button')]
          .find(b => b.textContent.trim() === '截取图片');
        if (!btn) throw new Error('工具栏里没有「截取图片」按钮');
        steps.push('按钮存在=true');
        // 走界面同一条路：分块截图 + canvas 拼合 → 主进程落盘
        const board = document.querySelector('.board').getBoundingClientRect();
        const sc = document.querySelector('.content');
        steps.push('看板实测=' + Math.round(board.width) + 'x' + Math.round(board.height)
          + ' 内容区=' + sc.scrollWidth + 'x' + sc.scrollHeight
          + ' 可视=' + sc.clientWidth + 'x' + sc.clientHeight);
        // 提示现在是浮动 toast 且 2.5 秒自动消失 —— 等 14 秒后再读 .msg 必然是空的
        // （改版后本探针就是这么挂的）。用 MutationObserver 把出现过的提示都记下来。
        // 注意：这里是纯 JS 字符串（executeJavaScript），不能写 TS 语法，
        // 也不能在注释里用反引号 —— 反引号会终止外层的模板字符串。
        window.__seenMsgs = [];
        const seen = window.__seenMsgs;
        const mo = new MutationObserver(() => {
          for (const el of document.querySelectorAll('.msg')) {
            const t = el.textContent.trim();
            if (t && !seen.includes(t)) seen.push(t);
          }
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        btn.click();   // 与用户点按钮完全一致
        // 等拼图 + 落盘（分块截图需要若干轮滚动）
        await new Promise(r => setTimeout(r, 14000));   // 三块截图 + 拼合 + 落盘需要更久
        mo.disconnect();
        const msgs = seen.slice();
        // 找出**真正**在滚动的是哪个元素（不要再猜容器）
        const scrollers = [...document.querySelectorAll('*')]
          .filter(el => el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
          .slice(0, 8)
          .map(el => (el.className || el.tagName) + '[' + el.scrollWidth + 'x' + el.scrollHeight
            + ' / ' + el.clientWidth + 'x' + el.clientHeight + ']');
        steps.push('可滚动元素=' + JSON.stringify(scrollers));
        const diag = (window).__captureDiag || '（无几何诊断）';
        steps.push('界面提示=' + JSON.stringify(msgs));
        steps.push('几何诊断=' + diag);
        return { ok: msgs.some(m => m.includes('已保存截图')), steps, value: { msgs } };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针11f');
    for (const s of cap.steps) log('[smoke] 截取图片:', s);
    log('[smoke] 截取图片          :', cap.ok ? 'PASS' : 'FAIL');

    const scoring = await guarded(`(async () => {
      const steps = smokeSteps();
      const made = { players: [], matches: [], rules: [] };
      try {
        const api = window.omnia;
        const psum = (o) => Object.values(o).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

        // 6 人：神相x3（两小队各若干）+ 素问x2 + 铁衣x1，覆盖三种定位
        const spec = [
          ['sc_1', '评分甲', '神相', '防守一-1'],
          ['sc_2', '评分乙', '神相', '防守一-1'],
          ['sc_3', '评分丙', '素问', '防守一-1'],
          ['sc_4', '评分丁', '神相', '进攻一-1'],
          ['sc_5', '评分戊', '素问', '进攻一-1'],
          ['sc_6', '评分己', '铁衣', '进攻一-1'],
        ];
        const ids = {};
        for (const [gid, name, cls, squad] of spec) {
          const p = await api.player.create({ gameId: gid, name, mainClass: cls });
          if (!p.ok) throw new Error('建档失败 ' + name + ': ' + p.error);
          made.players.push(p.data.id);
          ids[name] = { id: p.data.id, cls, squad };
        }

        const m = await api.match.create({ date: '2026-07-01', ourSide: '我方', oppSide: '评分队', result: 'WIN', ourTowersLeft: 6, oppTowersLeft: 1 });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        const mid = m.data.match.id;
        made.matches.push(mid);

        // 给不同量级的表现，制造区分度
        const stats = {
          评分甲: { kills: 30, fountainKills: 2, assists: 60, dmgPlayer: 9000000, dmgPlayerArmor: 100000, dmgBuilding: 2000000, damageTaken: 6000000, deaths: 1 },
          评分乙: { kills: 12, assists: 30, dmgPlayer: 4000000, dmgBuilding: 500000, damageTaken: 5000000, deaths: 2 },
          评分丙: { assists: 80, healing: 8000000, damageTaken: 3000000, deaths: 1, revives: 6 },
          评分丁: { kills: 20, assists: 40, dmgPlayer: 7000000, dmgBuilding: 1200000, damageTaken: 4000000, deaths: 3 },
          评分戊: { assists: 70, healing: 7000000, damageTaken: 2500000, deaths: 2, revives: 5 },
          评分己: { assists: 50, damageTaken: 9000000, deaths: 6 },
        };
        for (const [name, st] of Object.entries(stats)) {
          const r = await api.match.upsertParticipation({
            matchId: mid, playerId: ids[name].id, squad: ids[name].squad, state: 'PLAY', stat: st,
          });
          if (!r.ok) throw new Error('写战报失败 ' + name + ': ' + r.error);
        }

        const active = await api.rules.active();
        steps.push('使用中的规则=' + (active.ok && active.data ? active.data.name + ' v' + active.data.version : '无'));

        const run1 = await api.match.runScore(mid);
        if (!run1.ok) throw new Error('算分失败: ' + run1.error);
        const s1 = run1.data;
        const totals1 = s1.lines.map(l => l.total);
        steps.push('参评人数=' + s1.scored + ' 均分=' + s1.stats.avg.toFixed(2)
          + ' 区间=[' + s1.stats.min.toFixed(2) + ',' + s1.stats.max.toFixed(2) + ']'
          + ' 触顶=' + s1.stats.capped);
        steps.push('引擎=' + s1.engine + ' 规则=' + s1.ruleSetName);

        // 分解合计 = 总分（含基础分与封顶）
        const one = s1.lines[0];
        const base = active.ok && active.data ? active.data.baseScore : 60;
        const cap = active.ok && active.data ? active.data.capScore : 100;
        const composeOk = s1.lines.every((l) => {
          const raw = base + l.teamScore + l.personalScore + l.bonus - l.deathPenalty;
          return Math.abs(Math.min(raw, cap) - l.total) < 1e-9 || Math.abs(l.total - cap) < 1e-9;
        });
        const distinct = new Set(totals1.map(t => t.toFixed(2))).size;
        steps.push('区分度：不同总分数=' + distinct + ' 个 / ' + totals1.length + ' 人');
        steps.push('抽样 ' + one.playerName + ' 团队=' + one.teamScore.toFixed(2)
          + ' 个人=' + one.personalScore.toFixed(2) + ' 附加=' + one.bonus
          + ' 扣分=' + one.deathPenalty.toFixed(2) + ' 总分=' + one.total.toFixed(2));
        steps.push('明细字段=' + Object.keys(one.detail).join(','));
        steps.push('小队执行分 防御一-1=' + one.detail['小队执行分'] + ' 战术=' + one.detail['战术类型']
          + ' 职业系数=' + one.detail['职业系数']);

        // 落库 + 幂等
        const saved1 = await api.match.scores(mid);
        await api.match.runScore(mid);
        const saved2 = await api.match.scores(mid);
        steps.push('落库条数 第一次=' + saved1.data.length + ' 重算后=' + saved2.data.length + '（应相同）');
        const orderOk = saved2.data.every((x, i) => i === 0 || saved2.data[i - 1].total >= x.total);
        steps.push('落库按总分降序=' + orderOk);

        // 改规则 → 重算分数应变化（证明参数真的生效）
        const cur = active.data;
        const { id, seasonId, version, active: act, createdAt, ...curInput } = cur;
        const tweaked = JSON.parse(JSON.stringify(curInput));
        tweaked.name = '自检·高死亡扣分';
        tweaked.deathPen = 15;
        const nr = await api.rules.create(tweaked);
        if (!nr.ok) throw new Error('建规则失败: ' + nr.error);
        made.rules.push(nr.data.id);
        await api.rules.setActive(nr.data.id);
        const run2 = await api.match.runScore(mid, nr.data.id);
        if (!run2.ok) throw new Error('按新规则算分失败: ' + run2.error);
        const before = s1.lines.find((l) => l.playerName === 'sc_6').total;
        const after = run2.data.lines.find((l) => l.playerName === 'sc_6').total;
        steps.push('评己(6 死) 旧规则=' + before.toFixed(2) + ' 高死亡扣分规则=' + after.toFixed(2)
          + ' 差=' + (after - before).toFixed(2));
        const savedBoth = await api.match.scores(mid);
        steps.push('两套规则的分数并存条数=' + savedBoth.data.length + '（应=12）');

        // 界面：本场评分页签
        const nav = [...document.querySelectorAll('button.nav-item')].find(x => x.textContent.indexOf('对局与战报') >= 0);
        nav.click();
        const waitFor = async (fn, label, ms = 8000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        const tEnter = Date.now();
        while (Date.now() - tEnter < 6000) {
          const btn = [...document.querySelectorAll('table.grid button')].find(x => x.textContent.trim() === '进入');
          if (btn) { btn.click(); break; }
          if (document.querySelector('button.tab')) break;
          await new Promise(res => setTimeout(res, 150));
        }
        const tab = await waitFor(() => [...document.querySelectorAll('button.tab')]
          .find(x => x.textContent.indexOf('本场评分') >= 0), '本场评分页签');
        tab.click();

        // 先等面板把它自己的数据读完：data-scores 是组件内部状态，最可靠
        await waitFor(() => {
          const el = document.querySelector('[data-scores]');
          return el && Number(el.getAttribute('data-scores')) > 0 ? el : null;
        }, '评分面板载入分数');
        const panel = document.querySelector('[data-scores]');
        const loadedCount = Number(panel.getAttribute('data-scores'));
        const btnText = ([...document.querySelectorAll('button.btn.primary')]
          .find(x => x.textContent.indexOf('算') >= 0)?.textContent ?? '').trim();

        await waitFor(() => document.querySelector('table.grid tbody tr') ? true : null, '评分表');
        const rows = document.querySelectorAll('table.grid tbody tr').length;
        const scoreCells = document.querySelectorAll('table.grid tbody tr td.num').length;

        const expand = [...document.querySelectorAll('button.btn.sm.ghost')].find(x => x.textContent.trim() === '展开');
        let kvItems = 0;
        let rowsAfterExpand = rows;
        if (expand) {
          expand.click();
          await new Promise(res => setTimeout(res, 400));
          rowsAfterExpand = document.querySelectorAll('table.grid tbody tr').length;
          kvItems = document.querySelectorAll('.kv__item').length;
        }
        steps.push('展开前后表格行数 ' + rows + ' → ' + rowsAfterExpand + '，明细项=' + kvItems);
        steps.push('评分页 组件载入=' + loadedCount + ' 按钮=' + JSON.stringify(btnText)
          + ' 表格行=' + rows + ' 数字单元格=' + scoreCells + ' 明细项=' + kvItems
          + ' 面板错误=' + JSON.stringify(panel.getAttribute('data-error') ?? ''));

        for (const id2 of made.rules) await api.rules.remove(id2).catch(() => {});
        for (const id2 of made.matches) await api.match.remove(id2);
        for (const id2 of made.players) await api.player.remove(id2);

        const panelEl = document.querySelector('[data-scores]');
        steps.push('评分面板 最终 data-scores=' + (panelEl?.getAttribute('data-scores') ?? '（找不到）')
          + ' data-error=' + JSON.stringify(panelEl?.getAttribute('data-error') ?? ''));

        const cond = {
          scored6: s1.scored === 6,
          inRange: totals1.every(t => t >= 0 && t <= 100),
          capped: s1.stats.capped >= 0 && s1.stats.capped <= 5 && s1.stats.max <= cap + 1e-9,
          distinct: distinct >= 4,
          composeOk,
          detailNum: typeof one.detail['小队执行分'] === 'number' && typeof one.detail['职业系数'] === 'number',
          idem: saved1.data.length === 6 && saved2.data.length === 6 && orderOk,
          ruleChanged: after < before,
          bothRules: savedBoth.data.length === 12,
          ui: loadedCount === 6 && rows >= 6 && scoreCells >= 24 && rowsAfterExpand === rows + 1,
        };
        steps.push('判定明细=' + JSON.stringify(cond));
        const ok = Object.values(cond).every(Boolean);
        return { ok, steps };      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '评分引擎');
    for (const s of scoring.steps) log('[smoke] 评分:', s);
    log('[smoke] 评分引擎          :', scoring.ok ? 'PASS' : 'FAIL');

    // M8：赛季——口径隔离的载体（对局/规则集打标，成员与建制跨赛季）
    const season = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const api = window.omnia;
        const active0 = await api.season.active();
        if (!active0.ok) throw new Error('取当前赛季失败: ' + active0.error);
        steps.push('初始当前赛季=' + active0.data.name + '（id=' + active0.data.id + '）');

        const created = await api.season.create({ name: '__smoke_s1__', startedAt: '2025-01-01', endedAt: '2025-03-31' });
        if (!created.ok) throw new Error('新建赛季失败: ' + created.error);
        steps.push('新建赛季 id=' + created.data.id + ' 名称=' + created.data.name);

        const dupName = await api.season.create({ name: '__smoke_s1__' });
        steps.push('重名赛季被拦=' + (dupName.ok ? '否（异常！）' : '是'));

        const emptyName = await api.season.create({ name: '   ' });
        steps.push('空名赛季被拦=' + (emptyName.ok ? '否（异常！）' : '是'));

        const setAct = await api.season.setActive(created.data.id);
        if (!setAct.ok) throw new Error('切换赛季失败: ' + setAct.error);
        const listA = await api.season.list();
        const actCount = listA.data.filter(s => s.active).length;
        steps.push('切换后 使用中数量=' + actCount + ' 当前=' + listA.data.find(s => s.active).name);

        const delActive = await api.season.remove(created.data.id);
        steps.push('删除当前赛季被拦=' + (delActive.ok ? '否（异常！）' : '是'));

        // 造一场对局并归档到新赛季，验证计数与区间
        // 注意：match.create 会把新对局登记到「当前赛季」下，所以这里先验证这一点，
        // 再用 assignMatches 把它搬到另一个赛季（历史数据纠偏就是这条路）。
        const p = await api.player.create({ gameId: '__season_probe__', name: '赛季探针' });
        const m = await api.match.create({ date: '2025-02-14', ourSide: '本帮', oppSide: '__赛季归属__' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        // 注意：match.create 返回 { match, inherited }，不是对局本身
        const mid = m.data.match.id;
        const born = await api.match.get(mid);
        steps.push('新对局自动归属当前赛季=' + (born.ok && born.data.seasonId === created.data.id)
          + '（seasonId=' + (born.ok ? born.data.seasonId : 'ERR') + '，当前赛季=' + created.data.id + '）');

        // 再建一个赛季，把对局从 s1 搬到 s2，验证 assignMatches 真的改归属
        const s2 = await api.season.create({ name: '__smoke_s2__' });
        if (!s2.ok) throw new Error('新建赛季2失败: ' + s2.error);
        const assigned = await api.season.assignMatches(s2.data.id, [mid]);
        const moved = await api.match.get(mid);
        steps.push('归档对局 移动数=' + (assigned.ok ? assigned.data.moved : 'ERR:' + assigned.error)
          + ' 归属=' + (moved.ok ? moved.data.seasonId : 'ERR:' + moved.error) + '（应=' + s2.data.id + '）');
        const wasMoved = moved.ok && moved.data.seasonId === s2.data.id;
        const listB = await api.season.list();
        const s1b = listB.data.find(s => s.id === created.data.id);
        steps.push('归档后 s1 对局数=' + s1b.matchCount + '（应=0，已搬走）数据区间='
          + (s1b.firstDate || '—') + '→' + (s1b.lastDate || '—'));

        // 切回原赛季后删掉探针赛季 s2（对局此刻正挂在 s2 上）：
        // 赛季记录要消失，但对局不能被连带删掉，只解除归属
        await api.season.setActive(active0.data.id);
        const delOk = await api.season.remove(s2.data.id);
        const afterMatch = await api.match.get(mid);
        const afterSeason = await api.season.list();
        const s2Gone = !afterSeason.data.some(s => s.id === s2.data.id);
        steps.push('删除探针赛季 s2=' + (delOk.ok ? '成功' : '失败:' + delOk.error)
          + ' 赛季已移除=' + s2Gone
          + ' 对局仍在=' + afterMatch.ok
          + ' 归属=' + (afterMatch.ok ? JSON.stringify(afterMatch.data.seasonId) : 'ERR'));

        // 界面：切到赛季页，确认表格渲染出行且当前赛季有标记
        const nav = [...document.querySelectorAll('button.nav-item')].find(x => x.textContent.indexOf('赛季') >= 0);
        if (nav) nav.click();
        await new Promise(res => setTimeout(res, 800));
        const rows = document.querySelectorAll('table.grid tbody tr').length;
        const activeMark = document.body.textContent.indexOf('当前') >= 0;
        const hasCreate = [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '新建赛季');
        const activeNav = document.querySelector('button.nav-item.active')?.textContent?.trim() ?? '（无）';
        const cards = [...document.querySelectorAll('.card h3')].map(h => h.textContent).join('|');
        steps.push('赛季页 表格行=' + rows + ' 有当前标记=' + activeMark + ' 有新建按钮=' + hasCreate);
        steps.push('当前导航=' + JSON.stringify(activeNav) + ' 卡片标题=' + cards);

        const cond = {
          created: created.ok === true,
          dupBlocked: !dupName.ok,
          emptyBlocked: !emptyName.ok,
          singleActive: actCount === 1,
          delActiveBlocked: !delActive.ok,
          autoTaggedActive: born.ok === true && born.data.seasonId === created.data.id,
          assigned: assigned.ok === true && assigned.data.moved === 1 && wasMoved,
          counted: s1b.matchCount === 0,
          unassignKeepsMatch: delOk.ok === true && s2Gone && afterMatch.ok === true && afterMatch.data.seasonId === null,
          ui: rows >= 1 && activeMark && hasCreate,
        };
        steps.push('判定明细=' + JSON.stringify(cond));
        // 清理交给外层：截图要在数据还在的时候拍。
        // 句柄必须放 value 里 —— guarded 只透传 ok/steps/value，挂顶层会被丢掉。
        return {
          ok: Object.values(cond).every(Boolean),
          steps,
          value: { cleanup: { playerId: p.data.id, seasonIds: [created.data.id, s2.data.id] } },
        };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '赛季');
    for (const s of season.steps) log('[smoke] 赛季:', s);
    log('[smoke] 赛季模块          :', season.ok ? 'PASS' : 'FAIL');
    // 先截图再清理，这样截图里能看到完整的赛季列表（含探针赛季）
    await shot('season');
    {
      const cleanup = (season.value as { cleanup?: { playerId: number; seasonIds: number[] } } | undefined)?.cleanup;
      for (const id of cleanup?.seasonIds ?? []) {
        await guarded(`window.omnia.season.remove(${id}).catch(() => {})`, `清理赛季${id}`);
      }
      if (cleanup?.playerId) {
        await guarded(`window.omnia.player.remove(${cleanup.playerId}).catch(() => {})`, '清理探针成员');
      }
    }

    // 报名导入与交叉核对：重复报名拒绝、未匹配 ID 记录、补建、未填表识别
    const sgImp = await guarded(`(async () => {
      const steps = smokeSteps();
      const made = { players: [], matches: [] };
      try {
        const api = window.omnia;
        const m = await api.match.create({ date: '2026-06-06', ourSide: '我方', oppSide: '报名导入队' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        const mid = m.data.match.id;
        made.matches.push(mid);

        const p1 = await api.player.create({ gameId: 'smoke_sgi_1', name: '报名导入甲' });
        const p2 = await api.player.create({ gameId: 'smoke_sgi_2', name: '报名导入乙' });
        if (!p1.ok || !p2.ok) throw new Error('建档失败');
        made.players.push(p1.data.id, p2.data.id);

        const row = (line, gameId, status, mainClass, subClass) => ({
          line, gameId, status, mic: status === 'JOIN' ? '有' : '',
          mainClass: status === 'JOIN' ? mainClass : '',
          subClass: status === 'JOIN' ? subClass : '', submittedAt: '2026-06-01 20:00',
        });

        // ① 重复报名必须被拒绝（用户口径：不自动取舍，让用户回 Excel 处理）
        const dup = await api.signup.importSignups(mid, [
          row(2, 'smoke_sgi_1', 'JOIN', '神相', ''),
          row(3, 'smoke_sgi_1', 'JOIN', '素问', ''),
        ]);
        steps.push('重复报名被拒=' + (dup.ok ? '否（异常！）' : '是') + (dup.ok ? '' : '（' + dup.error.slice(0, 26) + '…）'));

        // ② 正常导入：1 人已建档、1 人不在主档
        const imp = await api.signup.importSignups(mid, [
          row(2, 'smoke_sgi_1', 'JOIN', '神相', '铁衣'),
          row(3, 'smoke_sgi_missing', 'LEAVE', '', ''),
        ]);
        if (!imp.ok) throw new Error('导入失败: ' + imp.error);
        steps.push('导入=' + imp.data.imported + ' 条 未匹配=' + JSON.stringify(imp.data.unmatched));

        // ③ 交叉核对
        const rev = await api.signup.reviewSignups(mid);
        if (!rev.ok) throw new Error('核对失败: ' + rev.error);
        steps.push('报名有主档没有=' + JSON.stringify(rev.data.signedNotInRoster.map(r => r.gameId)));
        steps.push('主档有未填表=' + JSON.stringify(rev.data.inRosterNotSigned.map(r => r.gameId)));

        // ④ 补建缺失成员
        const cm = await api.signup.createMissingPlayers(mid, ['smoke_sgi_missing']);
        if (!cm.ok) throw new Error('补建失败: ' + cm.error);
        steps.push('补建 新建=' + cm.data.created + ' 报名=' + cm.data.signups);
        const after = await api.signup.reviewSignups(mid);
        steps.push('补建后 报名有主档没有=' + JSON.stringify(
          after.data.signedNotInRoster.map(r => r.gameId)));

        // ⑤ 报名表带来的职业与二职
        const board = await api.signup.board(mid);
        const r1 = board.data.rows.find(r => r.gameId === 'smoke_sgi_1');
        steps.push('甲 报名状态=' + r1.signup + ' 主职=' + r1.mainClass + ' 二职=' + r1.subClass + ' 麦=' + r1.mic);

        // ⑥ 排表候选只应有报名记录的人：甲在、乙（未报名）不在
        const inCand = board.data.rows.filter(r => r.signup !== null).map(r => r.gameId);
        steps.push('本场候选=' + JSON.stringify(inCand));

        const cond = {
          dupBlocked: dup.ok === false,
          imported: imp.data.imported === 1 && imp.data.unmatched.includes('smoke_sgi_missing'),
          orphanListed: rev.data.signedNotInRoster.some(r => r.gameId === 'smoke_sgi_missing'),
          notFilled: rev.data.inRosterNotSigned.some(r => r.gameId === 'smoke_sgi_2'),
          created: cm.data.created === 1 && cm.data.signups === 1,
          orphanCleared: !after.data.signedNotInRoster.some(r => r.gameId === 'smoke_sgi_missing'),
          classes: r1.mainClass === '神相' && r1.subClass === '铁衣' && r1.signup === 'JOIN',
          candidateOnlySigned: inCand.includes('smoke_sgi_1') && !inCand.includes('smoke_sgi_2'),
        };
        steps.push('判定=' + JSON.stringify(cond));
        return { ok: Object.values(cond).every(Boolean), steps, value: { cleanup: made } };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)), value: { cleanup: made } }; }
    })()`, '探针13');
    for (const s of sgImp.steps) log('[smoke] 报名导入:', s);
    log('[smoke] 报名导入与核对    :', sgImp.ok ? 'PASS' : 'FAIL');
    {
      const c = (sgImp.value as { cleanup?: { players: number[]; matches: number[] } } | undefined)?.cleanup;
      for (const id of c?.matches ?? []) await guarded(`window.omnia.match.remove(${id}).catch(() => {})`, `清理报名对局${id}`);
      for (const id of c?.players ?? []) await guarded(`window.omnia.player.remove(${id}).catch(() => {})`, `清理报名成员${id}`);
    }

    // M8：职业图标能否被页面真正加载并渲染（打包后是 file:// 相对路径，最容易踩坑）
    // 另加一条回归断言：12 个职业必须各有一张**互不相同**的图标 —— 原表里惊鸿和妙音
    // 共用同一张图，界面上看起来就是"两个职业图标一样"，这种缺陷不该再溜回来。
    const iconMap = CLASSES.map((c) => ({ name: c.name, file: classIconFile(c.name) }));
    const iconProbe = await guarded(`(async () => {
      const base = (document.baseURI || '').replace(/index\\.html.*$/, '');
      const probe = (file) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ file, ok: img.naturalWidth > 0, w: img.naturalWidth });
        img.onerror = () => resolve({ file, ok: false, w: 0 });
        img.src = base + 'class-icons/' + file;
      });
      const all = ${JSON.stringify(iconMap.map((x) => x.file).filter(Boolean))};
      const results = [];
      for (const f of all) results.push(await probe(f));

      // 职业图标真正渲染成 DOM 的地方改为**总览页的职业分布**：
      // 成员主档已不持有职业（职业改由报名表提供），那里的职业图标自然会消失，
      // 而总览的职业分布对 12 个职业恒定渲染图标，是更稳的断言点。
      const nav = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('总览'));
      if (nav) nav.click();
      await new Promise(r => setTimeout(r, 800));
      const chipIcons = document.querySelectorAll('img[src*="class-icons"]').length;
      const firstSrc = document.querySelector('img[src*="class-icons"]')?.getAttribute('src') || '';
      // 和其它探针统一走 { ok, steps, value } 信封，值放 value 里
      return { ok: true, steps: [], value: { base, results, dom: chipIcons, firstSrc } };
    })()`, '探针12');
    type IconProbe = { base: string; results: { file: string; ok: boolean; w: number }[]; dom: number; firstSrc: string };
    const icons = ((iconProbe.value as IconProbe | undefined) ?? { base: '', results: [], dom: 0, firstSrc: '' });
    const missing = iconMap.filter((x) => !x.file).map((x) => x.name);
    const fileCount = new Set(iconMap.map((x) => x.file)).size;
    const allDistinct = missing.length === 0 && fileCount === CLASSES.length;
    const iconOk = icons.results.length === CLASSES.length
      && icons.results.every((x) => x.ok) && icons.dom > 0 && allDistinct;
    log('[smoke] M8 图标 base       :', icons.base);
    log('[smoke] M8 图标加载        :', icons.results.every((x) => x.ok) && icons.results.length === CLASSES.length ? 'PASS' : 'FAIL',
      icons.results.map((x) => `${x.file}:${x.ok ? x.w + 'px' : '失败'}`).join(' '));
    log('[smoke] M8 图标一一对应    :', allDistinct ? 'PASS' : 'FAIL',
      `缺失=[${missing.join(',')}] 不同图标=${fileCount}/${CLASSES.length}`);
    log('[smoke] M8 页面渲染图标    :', icons.dom, '个，首个 src =', icons.firstSrc);

    const pass =
      r.preload && r.appInfo && r.classes === 12 && r.players >= 0 &&
      Number(rootHtml) > 100 && crud.ok === true && m3.ok === true && m5.ok === true
      && m6.ok === true && m7.ok === true && wizard.ok === true && dnd.ok === true
      && detail.ok === true && signup.ok === true && rules.ok === true && guide.ok === true
      && scoring.ok === true && season.ok === true && iconOk && lineup.ok === true
      && geom.ok === true && slot.ok === true && cap.ok === true && sgImp.ok === true
      && r.schemaVersion >= 10;
    log('[smoke] 写操作往返          :', crud.ok ? 'PASS' : 'FAIL');
    log('[smoke] 结果                :', pass ? 'PASS' : 'FAIL');
    app.exit(pass ? 0 : 1);
  });
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

  app.whenReady().then(() => {
    if (!bootDatabase()) {
      app.exit(1);
      return;
    }
    createWindow();

    if (env('OMNIA_SMOKE', 'LIS_SMOKE') === '1' && mainWindow) {
      void runSmokeTest(mainWindow);
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
    try { dbHandle?.db.close(); } catch { /* 忽略关闭异常 */ }
    dbHandle = null;
  });
}

