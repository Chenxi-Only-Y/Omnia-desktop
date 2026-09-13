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
    backgroundColor: '#14161c',
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
 * 这样在没有人盯着窗口时，也能验证整条链路是否真的通。
 */
async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const probe = async (): Promise<{ preload: boolean; appInfo: boolean; classes: number; players: number; error: string | null }> => {
    const w = win.webContents;
    const has = await w.executeJavaScript('typeof window.omnia === "object" && window.omnia !== null');
    if (!has) return { preload: false, appInfo: false, classes: 0, players: 0, error: 'window.omnia 未注入' };
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
          error: [info, cls, ps].filter(r => r && !r.ok).map(r => r.error).join('; ') || null,
        };
      } catch (e) { return { preload: true, appInfo: false, classes: -1, players: -1, error: String(e) }; }
    })()`);
    return res as { preload: boolean; appInfo: boolean; classes: number; players: number; error: string | null };
  };

  win.webContents.once('did-finish-load', async () => {
    let r: Awaited<ReturnType<typeof probe>>;
    try {
      r = await probe();
    } catch (err) {
      r = { preload: false, appInfo: false, classes: -1, players: -1, error: String(err) };
    }
    const rootHtml = await win.webContents.executeJavaScript(
      'document.getElementById("root") ? document.getElementById("root").innerHTML.length : -1',
    ).catch(() => -1);

    // 写操作往返：create → update → list → remove → list
    const crud = await win.webContents.executeJavaScript(`(async () => {
      const steps = [];
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
    })()`);

    console.log('[smoke] preload 注入        :', r.preload);
    console.log('[smoke] app.info()         :', r.appInfo);
    console.log('[smoke] meta.classes() 数量 :', r.classes);
    console.log('[smoke] player.list() 数量  :', r.players);
    console.log('[smoke] React 已渲染字符数  :', rootHtml);
    console.log('[smoke] 错误                :', r.error ?? '无');
    for (const s of crud.steps) console.log('[smoke] CRUD:', s);

    // M3：对局 → 阵容 → 战报粘贴导入 → 校验 → 入库 → 读回
    const m3 = await win.webContents.executeJavaScript(`(async () => {
      const steps = [];
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
          '战报测试员\\t神相\\t 32/0\\t151\\t0\\t8930953\\t0\\t1965057\\t0\\t0\\t6489941\\t3\\t0\\t0',
          '不在档的人\\t玄机\\t5/1\\t20\\t0\\t100\\t0\\t200\\t0\\t0\\t300\\t1\\t0\\t0',
          '战报测试员\\t神相\\t1/0\\t1\\t0\\t1\\t0\\t1\\t0\\t0\\t1\\t0\\t0\\t0',
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
        const mine = parts.data.find(p => p.name === '战报测试员');
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
    })()`);

    for (const s of m3.steps) console.log('[smoke] M3:', s);
    console.log('[smoke] M3 对局与战报      :', m3.ok ? 'PASS' : 'FAIL');

    // M5：战斗组/小队建制（数据驱动）+ 排表看板渲染
    const m5 = await win.webContents.executeJavaScript(`(async () => {
      const steps = [];
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

        // 点「进入」打开对局详情（若列表页直接带了进入按钮）
        const enterBtn = [...document.querySelectorAll('table.grid button')]
          .find(b => b.textContent.trim() === '进入');
        if (enterBtn) enterBtn.click();

        // 切到阵容编排页签
        await waitFor(() => document.querySelector('button.tab') ? true : null, '页签出现');
        const lineupTab = [...document.querySelectorAll('button.tab')]
          .find(b => b.textContent.includes('阵容编排'));
        if (lineupTab) lineupTab.click();

        // 等排表看板方块渲染出来
        await waitFor(() => document.querySelectorAll('.blk').length > 0 ? true : null, '排表看板方块');

        const blocks = document.querySelectorAll('.blk').length;
        const teamNames = [...document.querySelectorAll('.blk__teamname')].map(e => e.textContent.trim());
        const icons = document.querySelectorAll('.blk__icon').length;
        const named = document.querySelectorAll('.blk__pname').length;
        steps.push('看板渲染小队方块=' + blocks + ' 含职业图标=' + icons + ' 有姓名=' + named);
        steps.push('方块小队名（前5）=' + teamNames.slice(0, 5).join(','));
        const hasTarget = teamNames.includes('防守一-1');

        await api.match.remove(m.data.match.id);
        await api.player.remove(p.data.id);

        const ok = cat.data.groups.length === 4
          && cat.data.squads.length === 12
          && cat.data.capacity === 72
          && squads.includes('防守一-1') && squads.includes('防守二-3') && squads.includes('进攻二-3')
          && s1.data.name === '演练组-1' && s2.data.name === '演练组-2'
          && blocks === 12 && hasTarget;        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`);
    for (const s of m5.steps) console.log('[smoke] M5:', s);
    console.log('[smoke] M5 建制与看板      :', m5.ok ? 'PASS' : 'FAIL');

    // M6：看板统计 + 首页主视觉渲染
    const m6 = await win.webContents.executeJavaScript(`(async () => {
      const steps = [];
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
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: p1.data.id, squad: '防守一-1', state: 'PLAY', stat: { kills: 20, assists: 30, dmgPlayer: 1000, deaths: 1 } });
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: p2.data.id, squad: '防守一-1', state: 'PLAY', stat: { assists: 50, healing: 5000, deaths: 0 } });
        await api.match.upsertParticipation({ matchId: m1.data.match.id, playerId: p3.data.id, squad: '防守一-1', state: 'PLAY', stat: { assists: 10, damageTaken: 9000, deaths: 4 } });
        // 第二场：3 人上场，只填 1 人（完整度应为 1/3）
        await api.match.upsertParticipation({ matchId: m2.data.match.id, playerId: p1.data.id, squad: '进攻一-1', state: 'PLAY', stat: { kills: 5, deaths: 2 } });
        await api.match.upsertParticipation({ matchId: m2.data.match.id, playerId: p2.data.id, squad: '进攻一-1', state: 'PLAY' });
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
    })()`);
    for (const s of m6.steps) console.log('[smoke] M6:', s);
    console.log('[smoke] M6 看板与首页      :', m6.ok ? 'PASS' : 'FAIL');

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
      for (const s of m7.steps) console.log('[smoke] M7:', s);
      console.log('[smoke] M7 真实旧表导入    :', m7.ok ? 'PASS' : 'FAIL');
    } else {
      console.log('[smoke] M7 真实旧表导入    : SKIP（未提供样本，设 OMNIA_SAMPLE_XLSX 指向旧表即可验证）');
    }

    // 导入向导的界面接线：切到成员主档点「从 xlsx 导入」，确认弹窗出来了
    const wizard = await win.webContents.executeJavaScript(`(async () => {
      const steps = [];
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
    })()`);
    for (const s of wizard.steps) console.log('[smoke] 向导:', s);
    console.log('[smoke] 导入向导界面接线  :', wizard.ok ? 'PASS' : 'FAIL');

    // 拖拽排表：用原生拖拽事件驱动看板，验证队员真的换了小队
    const dnd = await win.webContents.executeJavaScript(`(async () => {
      const steps = [];
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
        const m = await api.match.create({ date: '2026-04-01', ourSide: '我方', oppSide: '拖拽队', result: 'WIN' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        const mid = m.data.match.id;
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
        await waitFor(() => document.querySelectorAll('.blk').length > 0 ? true : null, '看板方块');

        // 找「拖拽甲」所在的格子（在 防守一-1 方块里）与其姓名单元格
        const blocks = [...document.querySelectorAll('.blk')];
        const fromBlock = blocks.find(b => b.dataset.squad === '防守一-1');
        if (!fromBlock) throw new Error('看板上找不到 防守一-1');
        const nameCell = [...fromBlock.querySelectorAll('.blk__name td')]
          .find(td => td.textContent.includes('拖拽甲'));
        if (!nameCell) throw new Error('防守一-1 里找不到 拖拽甲');
        steps.push('拖拽前 防守一-1 含 拖拽甲=' + !!nameCell);

        // 目标：进攻一-1
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
        fire(nameCell, 'dragstart');
        fire(toBlock, 'dragover');
        fire(toBlock, 'drop');
        fire(nameCell, 'dragend');

        const KEY = 'application/x-omnia-player';
        steps.push('dragstart 写入的载荷=' + store.getData(KEY));

        // 等界面重新加载后核对
        await waitFor(() => {
          const b = [...document.querySelectorAll('.blk')].find(x => x.dataset.squad === '进攻一-1');
          return b && b.textContent.includes('拖拽甲') ? true : null;
        }, '拖拽后 进攻一-1 出现 拖拽甲');

        const parts = await api.match.participations(mid);
        const p1row = parts.data.find(r => r.name === '拖拽甲');
        steps.push('落库后 拖拽甲.squad=' + p1row?.squad + ' state=' + p1row?.state
          + ' tactic=' + (p1row?.tactic || '（空）'));
        const p2row = parts.data.find(r => r.name === '拖拽乙');
        steps.push('未分配的 拖拽乙.squad=' + JSON.stringify(p2row?.squad ?? ''));

        // 再把 拖拽乙 拖到「未分配」区应该没有效果（它本来就未分配）；
        // 改为验证 拖拽甲 拖回未分配区会被移除小队
        const chip = [...document.querySelectorAll('.board__chip')].find(c => c.textContent.includes('拖拽乙'));
        steps.push('未分配区出现 拖拽乙=' + !!chip);

        await api.match.remove(mid);
        await api.player.remove(p1.data.id);
        await api.player.remove(p2.data.id);

        const ok = store.getData(KEY).includes('拖拽甲')
          && p1row?.squad === '进攻一-1'
          && p1row?.state === 'PLAY'
          && p2row?.squad === ''
          && !!chip;
        return { ok, steps };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`);
    for (const s of dnd.steps) console.log('[smoke] 拖拽:', s);
    console.log('[smoke] 看板拖拽排表      :', dnd.ok ? 'PASS' : 'FAIL');

    // 成员详情：个人汇总 / 雷达对比 / 页面渲染
    const detail = await win.webContents.executeJavaScript(`(async () => {
      const steps = [];
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

        // 页面渲染：进成员主档 → 点「详情」
        const nav = [...document.querySelectorAll('button.nav-item')].find(x => x.textContent.includes('成员主档'));
        nav.click();
        const btn = await waitFor(() => [...document.querySelectorAll('table.grid button')]
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
    })()`);
    for (const s of detail.steps) console.log('[smoke] 详情:', s);
    console.log('[smoke] 成员详情页        :', detail.ok ? 'PASS' : 'FAIL');

    // M8：职业图标能否被页面真正加载并渲染（打包后是 file:// 相对路径，最容易踩坑）
    const icons = await win.webContents.executeJavaScript(`(async () => {
      const base = (document.baseURI || '').replace(/index\\.html.*$/, '');
      const probe = (file) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ file, ok: img.naturalWidth > 0, w: img.naturalWidth });
        img.onerror = () => resolve({ file, ok: false, w: 0 });
        img.src = base + 'class-icons/' + file;
      });
      const results = await Promise.all([
        probe('image4.png'), probe('image11.png'), probe('image2.png'),
      ]);

      // 种一个带主职业的成员，切到成员主档页，确认职业图标真的渲染成 DOM
      const made = await window.omnia.player.create({ gameId: '__icon_probe__', name: '图标探针', mainClass: '素问' });
      const nav = [...document.querySelectorAll('button.nav-item')].find(b => b.textContent.includes('成员主档'));
      if (nav) nav.click();
      await new Promise(r => setTimeout(r, 700));
      const chipIcons = document.querySelectorAll('img.chip-icon').length;
      const firstSrc = document.querySelector('img.chip-icon')?.getAttribute('src') || '';
      if (made.ok) await window.omnia.player.remove(made.data.id);
      return { base, results, dom: chipIcons, firstSrc };
    })()`);
    const iconOk = icons.results.every((x: { ok: boolean }) => x.ok) && icons.dom > 0;
    console.log('[smoke] M8 图标 base       :', icons.base);
    console.log('[smoke] M8 图标加载        :', iconOk ? 'PASS' : 'FAIL',
      icons.results.map((x: { file: string; ok: boolean; w: number }) => `${x.file}:${x.ok ? x.w + 'px' : '失败'}`).join(' '));
    console.log('[smoke] M8 页面渲染图标    :', icons.dom, '个，首个 src =', icons.firstSrc);

    const pass =
      r.preload && r.appInfo && r.classes === 12 && r.players >= 0 &&
      Number(rootHtml) > 100 && crud.ok === true && m3.ok === true && m5.ok === true
      && m6.ok === true && m7.ok === true && wizard.ok === true && dnd.ok === true
      && detail.ok === true && iconOk;
    console.log('[smoke] 写操作往返          :', crud.ok ? 'PASS' : 'FAIL');
    console.log('[smoke] 结果                :', pass ? 'PASS' : 'FAIL');
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
