/**
 * 自检（smoke）探针：只在 OMNIA_SMOKE=1 时运行，跑完 app.exit(0/1)。
 *
 * 为什么单独一个文件：这些探针是一堆"把 JS 塞进渲染层执行再断言"的长模板字符串，
 * 加起来两千多行 —— 混在 main.ts 里会让主进程入口完全看不出结构。
 * 它们与主进程启动逻辑只共享两样东西：env()（读环境变量）与 log()（写日志），
 * 所以通过 SmokeDeps 显式传进来，不反向 import main.ts（避免循环依赖）。
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { detectHeaderRow, listSheets, readXlsx } from './xlsx';
import { parseTableText } from '../shared/tableText';
import { CLASSES, classIconFile } from '../shared/domain';

/** 编译后本文件位于 dist/main/smoke.js，应用根目录是上一级的上一级（与 main.ts 同一算法） */
const APP_ROOT = path.resolve(__dirname, '..', '..');

/** 本地文件协议名（与 main.ts 的 registerLocalProtocol 一致）：探针要断言 omnia:// 能取到图 */
const LOCAL_SCHEME = 'omnia';

/** 绝对路径 → omnia://local/…（反斜杠必须先归一，拼错就静默加载失败）；探针用它拼期望 URL */
function toLocalUrl(absPath: string): string {
  const norm = String(absPath ?? '').split(/[\\/]+/).filter(Boolean).join('/');
  return norm ? `${LOCAL_SCHEME}://local/${norm}` : '';
}

export interface SmokeDeps {
  /** 读环境变量（新名优先，兼容旧的 LIS_* 前缀） */
  env: (...names: string[]) => string;
  /** 同时写 stdout 与 <库目录>/omnia-smoke.log 的日志函数 */
  log: (...args: unknown[]) => void;
}

export async function runSmokeTest(win: BrowserWindow, deps: SmokeDeps): Promise<void> {
  const { env, log } = deps;

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
    /* 导航改版（2026-09-27）：二级页签从顶栏**下沉到帮会页内**（.tabs[data-guild-tabs]）。
       探针里到处是 nav('成员主档').click() 这种同步写法，所以给一个替身：
       顶栏/页内都找不到时，返回一个"先异步进帮会、再点目标"的假按钮 —— 调用点不用改。 */
    const smokeNav = (label) => {
      const hit = () => [...document.querySelectorAll('button.nav-item, [data-guild-tabs] button')]
        .find((b) => b.textContent.trim().includes(label));
      const direct = hit();
      if (direct) return direct;
      return { click: () => { void window.__enterGuild().then((okk) => { if (okk) { const t2 = hit(); if (t2) t2.click(); } }); } };
    };
    window.smokeNav = smokeNav;
    /** 进帮会（切到帮会页并点开第一个帮会卡片）；已经在帮会页里就直接返回 true */
    window.__enterGuild = async () => {
      if (document.querySelector('[data-guild-tabs]')) return true;
      const g = [...document.querySelectorAll('button.nav-item')].find((x) => x.textContent.trim() === '帮会');
      if (g) g.click();
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 60; i += 1) {
        await wait(100);
        const card = document.querySelector('.gcard[data-guild-id]');
        if (card) { card.click(); break; }
      }
      for (let i = 0; i < 60; i += 1) {
        await wait(100);
        if (document.querySelector('[data-guild-tabs]')) return true;
      }
      return false;
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
          gameId: '__smoke_probe__', name: '自检探针', mic: '有', joinedOrder: 999,
        });
        if (!made.ok) throw new Error('create: ' + made.error);
        const afterCreate = (await window.omnia.player.list()).data.length;
        const upd = await window.omnia.player.update(made.data.id, { remark: '自检写入' });
        steps.push('update ok remark=' + upd.data.remark);
        if (!upd.ok) throw new Error('update: ' + upd.error);
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

    /* M3c：战报导入的**原子性**（HANDOFF 待办 2 / MatchRepo.importStats）
       造一批"第 1 行合法、第 2 行写库必失败"的预览，直接调 importCommit：
         · 第 2 行的小队名在本场不存在 → upsertParticipation 抛「未知小队」；
         · 修复前（循环无事务）：第 1 行已经落库 = 半截数据；
         · 修复后（整批一个 SAVEPOINT 事务）：整批回滚，库里一条都没有。
       为什么只能这样测：正常入口的那些校验错误（数字不对 / 同一人重复 /
       未知职业）在进循环**之前**就被硬拦了，构造不出"写到一半才炸"的输入。
       所以这里手工拼一个 preview，绕过解析层，直接压仓储层的事务。 */
    const atomic = await guarded(`(async () => {
      const steps = smokeSteps();
      const ids = [];
      let mid = 0;
      const api = window.omnia;
      try {
        const a = await api.player.create({ gameId: 'smoke_atom_a', name: '原子甲' });
        if (!a.ok) throw new Error('建档甲失败: ' + a.error);
        ids.push(a.data.id);
        const b = await api.player.create({ gameId: 'smoke_atom_b', name: '原子乙' });
        if (!b.ok) throw new Error('建档乙失败: ' + b.error);
        ids.push(b.data.id);

        const m = await api.match.create({
          date: '2026-02-02', ourSide: '我方', oppSide: '对手', result: 'WIN',
          ourTowersLeft: 5, oppTowersLeft: 0,
        });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        mid = m.data.match.id;

        const zero = { kills: 0, fountainKills: 0, assists: 0, resource: 0, dmgPlayer: 0,
          dmgPlayerArmor: 0, dmgBuilding: 0, dmgBuildingArmor: 0, healing: 0,
          damageTaken: 0, deaths: 0, revives: 0, boneBurn: 0 };
        const mk = (pid, gid, squad, kills) => ({
          row: 1, playerId: pid, gameId: gid, name: gid, classUsed: '神相', squad: squad,
          stat: Object.assign({}, zero, { kills: kills }), issues: [],
        });
        const preview = {
          rows: [mk(a.data.id, 'smoke_atom_a', '', 7), mk(b.data.id, 'smoke_atom_b', '不存在的队', 9)],
          issues: [],
          summary: { total: 2, matched: 2, unmatched: 0, errors: 0, warnings: 0 },
        };

        const res = await api.match.importCommit(mid, preview);
        steps.push('中途失败时提交 = ' + (res.ok ? '竟然成功（异常！）' : '被拒: ' + res.error));

        const parts = await api.match.participations(mid);
        if (!parts.ok) throw new Error('读回失败: ' + parts.error);
        const leaked = parts.data.filter((p) =>
          p.gameId === 'smoke_atom_a' || p.gameId === 'smoke_atom_b').length;
        steps.push('回滚后残留参战 = ' + leaked + ' 条（应为 0）');

        return { ok: res.ok === false && leaked === 0, steps: steps };
      } catch (e) {
        return { ok: false, steps: steps.concat('ERR ' + String(e)) };
      } finally {
        try {
          if (mid) await api.match.remove(mid);
          for (const p of ids) await api.player.remove(p);
        } catch (e2) { /* 清理失败不影响断言 */ }
      }
    })()`, '探针3c');

    for (const s of atomic.steps) log('[smoke] M3c:', s);
    log('[smoke] M3c 战报导入原子性  :', atomic.ok ? 'PASS' : 'FAIL');

    /* M3b：历史用名（改名兼容）—— 用户口径 2026-09：
       「成员主档每个人里面添加历史用名，以免后续改名导致排表数据和战报数据导入被清空和无法识别。
        且后续导入数据后自动改为最新名」
       断言四件事：
         ① 建档时可填历史用名、改名时旧 ID 自动留档；
         ② 战报里写**旧名**仍能认人（严格模式不再 NOT_IN_ROSTER 阻止入库），且归到最新名下；
         ③ 报名表里写旧名也能对上主档（不再落进 unmatched）；
         ④ 名单导入时旧名被识别为「已改名」→ 自动升到导入文件里的最新名，旧名留档。 */
    const alias = await guarded(`(async () => {
      const steps = smokeSteps();
      const ids = [];
      const mids = [];
      try {
        const api = window.omnia;
        const made = await api.player.create({
          gameId: 'smoke_alias_new', name: 'smoke_alias_new', aliases: ['smoke_alias_older'],
        });
        if (!made.ok) throw new Error('建档失败: ' + made.error);
        ids.push(made.data.id);
        steps.push('建档即带历史用名 aliases=' + JSON.stringify(made.data.aliases));

        const rn = await api.player.update(made.data.id, { gameId: 'smoke_alias_newer' });
        if (!rn.ok) throw new Error('改名失败: ' + rn.error);
        steps.push('改名后 gameId=' + rn.data.gameId + ' 历史用名=' + JSON.stringify(rn.data.aliases));

        const m = await api.match.create({ date: '2026-03-01', ourSide: '我方', oppSide: '别名测试' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        mids.push(m.data.match.id);

        // 战报里写的是最早的名字（早已不是当前 ID）
        const TSV = ['玩家名字\\t职业\\t击败/清泉\\t助攻\\t对玩家伤害',
                     'smoke_alias_older\\t神相\\t7/0\\t3\\t1000'].join('\\n');
        const pv = await api.match.importPreview(TSV, 'roster');
        if (!pv.ok) throw new Error('预览失败: ' + pv.error);
        steps.push('旧名战报预览 匹配=' + pv.data.summary.matched
          + ' 未匹配=' + pv.data.summary.unmatched
          + ' 错误=' + pv.data.summary.errors
          + ' 分类=' + pv.data.issues.map(i => i.code).join(','));
        steps.push('归一后登记名=' + pv.data.rows[0].name + '（行内写的是 smoke_alias_older）');
        const cm = await api.match.importCommit(m.data.match.id, pv.data);
        if (!cm.ok) throw new Error('入库失败: ' + cm.error);
        const parts = (await api.match.participations(m.data.match.id)).data;
        const mine = parts.find(p => p.gameId === 'smoke_alias_newer');
        steps.push('入库参战=' + parts.length + ' 归属当前名=' + (mine ? '是' : '否'));

        // 报名表里也写旧名
        const sg = await api.signup.importSignups(m.data.match.id, [{
          line: 2, gameId: 'smoke_alias_older', status: 'JOIN', mic: '有',
          mainClass: '神相', subClass: '', submittedAt: '',
        }]);
        if (!sg.ok) throw new Error('报名导入失败: ' + sg.error);
        steps.push('旧名报名导入 imported=' + sg.data.imported
          + ' unmatched=' + JSON.stringify(sg.data.unmatched));

        // 名单导入：文件名=旧名 → 识别为改名，自动升到最新名（旧名留档）
        const imp = await api.player.import([{ gameId: 'smoke_alias_older', joinedOrder: 998 }]);
        if (!imp.ok) throw new Error('名单导入失败: ' + imp.error);
        steps.push('名单导入 inserted=' + imp.data.inserted + ' updated=' + imp.data.updated
          + ' 提示=' + JSON.stringify(imp.data.errors));
        const after = (await api.player.list()).data.find(p => p.id === made.data.id);
        steps.push('导入后 gameId=' + (after ? after.gameId : '—')
          + ' 历史用名=' + JSON.stringify(after ? after.aliases : []));
        const total = (await api.player.list()).data.filter(p => p.gameId.indexOf('smoke_alias_') === 0).length;
        steps.push('同名残留记录数=' + total + '（必须为 1）');

        return {
          ok: pv.data.summary.errors === 0 && pv.data.summary.matched === 1
            && pv.data.issues.some(i => i.code === 'ALIAS_MATCH')
            && !!mine && sg.data.unmatched.length === 0
            && after && after.gameId === 'smoke_alias_older'
            && after.aliases.indexOf('smoke_alias_newer') >= 0
            && total === 1,
          steps,
        };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
      finally {
        for (const mid of mids) await window.omnia.match.remove(mid).catch(() => {});
        for (const pid of ids) await window.omnia.player.remove(pid).catch(() => {});
      }
    })()`, '探针3b');

    for (const s of alias.steps) log('[smoke] M3b:', s);
    log('[smoke] M3b 历史用名        :', alias.ok ? 'PASS' : 'FAIL');

    /* M3d：对方帮会数据（用户口径选项 A，2026-09）
         「表内出现别的帮会 —— 不纳入评分机制，纯数据对比」。
         整场战报导出里必然混着对手，现在这些行会**存下来**：
         player.is_opp=1 + participation.side='opp'，但不进成员主档 / 报名 / 出勤，也不评分。
         断言：
           ① 严格模式预览：自己人匹配、对手 NOT_IN_ROSTER；
           ② 不传 opts 的旧调用方式**仍然是整批拒绝**（老语义没被改坏）；
           ③ opts.opp='store' → 自己人入库 + 对手存成 side='opp'，且不误建"我方"成员；
           ④ 主档 / 报名表 / 出勤里都看不到对手；看板成员数 = 主档条数；
           ⑤ 评分只覆盖自己人（2 条参战里只落 1 条分数）；
           ⑥ 同一对手打第二场 → 复用同一条对方记录（oppCreated=0）；
           ⑦ opts.opp='skip' → 直接丢掉（skipped=1、落库 0 条）。 */
    const opp = await guarded(`(async () => {
      const steps = smokeSteps();
      const mids = [];
      const ids = [];
      try {
        const api = window.omnia;
        const our = await api.player.create({ gameId: 'smoke_opp_our', name: 'smoke_opp_our' });
        if (!our.ok) throw new Error('建自己人失败: ' + our.error);
        ids.push(our.data.id);

        const mk = async (label) => {
          const m = await api.match.create({ date: '2026-02-02', ourSide: '我方', oppSide: label });
          if (!m.ok) throw new Error('建对局失败: ' + m.error);
          mids.push(m.data.match.id);
          return m.data.match.id;
        };
        const HEAD = '玩家名字\\t职业\\t击败/清泉\\t助攻\\t对玩家伤害\\t治疗值';
        const ROW_OUR = 'smoke_opp_our\\t神相\\t9/1\\t12\\t123456\\t0';
        const ROW_OPP = 'smoke_opp_foe\\t素问\\t3/0\\t7\\t99999\\t55555';
        const mid = await mk('对方测试A');

        const pv = await api.match.importPreview([HEAD, ROW_OUR, ROW_OPP].join('\\n'), 'roster');
        if (!pv.ok) throw new Error('预览失败: ' + pv.error);
        steps.push('严格模式 匹配=' + pv.data.summary.matched + ' 未匹配=' + pv.data.summary.unmatched
          + ' 错误=' + pv.data.summary.errors + ' 分类=' + pv.data.issues.map(i => i.code).join(','));

        // ② 默认（不传 opts）= 老语义：有对不上的行就整批拦住
        const legacy = await api.match.importCommit(mid, pv.data);
        steps.push('不传 opts 仍然整批拒绝: ' + (legacy.ok ? '否（异常！）' : '是'));

        // ③ 存对方
        const st = await api.match.importCommit(mid, pv.data, { opp: 'store' });
        if (!st.ok) throw new Error('store 入库失败: ' + st.error);
        steps.push('store → 自己人 written=' + st.data.written + ' 自动建档=' + st.data.created
          + '；对方 oppWritten=' + st.data.oppWritten + ' oppCreated=' + st.data.oppCreated);

        const parts = (await api.match.participations(mid)).data;
        const ourRow = parts.find(p => p.gameId === 'smoke_opp_our');
        const oppRow = parts.find(p => p.side === 'opp');
        steps.push('参战记录 我方=' + parts.filter(p => p.side === 'our').length
          + ' 对方=' + parts.filter(p => p.side === 'opp').length
          + ' 对方名=' + (oppRow ? oppRow.name : '—')
          + ' 对方治疗=' + (oppRow ? oppRow.stat.healing : '—'));
        if (oppRow) ids.push(oppRow.playerId);

        // ④ 主档 / 报名 / 出勤 都看不到对手
        const list = (await api.player.list()).data;
        const bd = (await api.signup.board(mid)).data;
        const dash = (await api.dashboard.data()).data;
        const inRoster = list.some(p => p.name === 'smoke_opp_foe');
        const inBoard = bd.rows.some(r => r.name === 'smoke_opp_foe');
        const inAtt = dash.attendance.some(a => a.name === 'smoke_opp_foe');
        steps.push('对手出现在 主档=' + inRoster + ' 报名=' + inBoard + ' 出勤=' + inAtt + '（都应为 false）');
        steps.push('看板 成员数=' + dash.totals.players + '（主档条数=' + list.length + '）'
          + ' 参战记录=' + dash.totals.participations);

        // ⑤ 评分只算自己人
        const run = await api.match.runScore(mid);
        if (!run.ok) throw new Error('评分失败: ' + run.error);
        const saved = (await api.match.scores(mid)).data;
        steps.push('评分落库=' + saved.length + ' 条（2 条参战里只有自己人，应为 1）');

        // ⑥ 第二场：同一个人 → 复用同一条对方记录
        const mid2 = await mk('对方测试B');
        const pv2 = await api.match.importPreview([HEAD, ROW_OPP].join('\\n'), 'roster');
        const st2 = await api.match.importCommit(mid2, pv2.data, { opp: 'store' });
        if (!st2.ok) throw new Error('第二场 store 失败: ' + st2.error);
        steps.push('第二场 oppCreated=' + st2.data.oppCreated + ' oppWritten=' + st2.data.oppWritten
          + '（复用应为 0 / 1）');

        // ⑦ 跳过对方
        const mid3 = await mk('对方测试C');
        const pv3 = await api.match.importPreview([HEAD, ROW_OPP].join('\\n'), 'roster');
        const st3 = await api.match.importCommit(mid3, pv3.data, { opp: 'skip' });
        if (!st3.ok) throw new Error('skip 入库失败: ' + st3.error);
        const parts3 = (await api.match.participations(mid3)).data;
        const opp3 = parts3.filter(p => p.side === 'opp').length;
        /* 注意：新场次会**从上一场继承我方阵容**（inheritLineupFromPrevious），
           所以这里只断言"对方一条都没落库"，不断言总条数为 0。 */
        steps.push('skip → oppWritten=' + st3.data.oppWritten + ' skipped=' + st3.data.skipped
          + ' 落库参战=' + parts3.map(p => p.side + ':' + p.gameId).join('|')
          + ' 其中对方=' + opp3 + '（对方应为 0）');

        // ⑧ 清空（用户口径：「战报录入为啥没有清空或者删除又或者更改的」）
        //    我方：只清数值，队员保留；对方：连参战记录一起删
        const c1 = await api.match.clearStats(mid, 'our');
        if (!c1.ok) throw new Error('清空我方战报失败: ' + c1.error);
        const after1 = (await api.match.participations(mid)).data;
        const ourKeep = after1.filter(p => p.side === 'our').length;
        const ourFilled = after1.filter(p => p.side === 'our' && p.statFilled).length;
        const c2 = await api.match.clearStats(mid, 'opp');
        if (!c2.ok) throw new Error('清空对方数据失败: ' + c2.error);
        const after2 = (await api.match.participations(mid)).data;
        const oppLeft = after2.filter(p => p.side === 'opp').length;
        steps.push('清空我方=' + c1.data.cleared + ' 条（队员保留=' + ourKeep
          + ' 已录战报=' + ourFilled + '）');
        steps.push('清空对方=' + c2.data.cleared + ' 条 剩余对方=' + oppLeft);

        /* ⑨ 评分快照失效（#4）：战报被改/被清之后，已存的分数应标记为"过期"，
              重算之后清零。断言这条是因为窗口里有"分数还在、底下数据已经变了"的坑。 */
        const staleAfterClear = (await api.match.get(mid)).data.scoreStale;
        const runAgain = await api.match.runScore(mid);
        if (!runAgain.ok) throw new Error('重算失败: ' + runAgain.error);
        const staleAfterRun = (await api.match.get(mid)).data.scoreStale;
        const partsNow = (await api.match.participations(mid)).data.filter(p => p.side === 'our');
        if (partsNow.length) await api.match.saveStat(partsNow[0].id, { assists: 5 });
        const staleAfterEdit = (await api.match.get(mid)).data.scoreStale;
        await api.match.runScore(mid);
        const staleFinal = (await api.match.get(mid)).data.scoreStale;
        steps.push('评分快照 清空后=' + staleAfterClear + ' 重算后=' + staleAfterRun
          + ' 改战报后=' + staleAfterEdit + ' 再重算后=' + staleFinal + '（应 t/f/t/f）');

        return {
          ok: pv.data.summary.errors === 1 && pv.data.summary.matched === 1
            && legacy.ok === false
            && st.data.written === 1 && st.data.created === 0
            && st.data.oppWritten === 1 && st.data.oppCreated === 1
            && !!ourRow && !!oppRow && oppRow.stat.healing === 55555
            && !inRoster && !inBoard && !inAtt
            && dash.totals.players === list.length
            && saved.length === 1
            && st2.data.oppCreated === 0 && st2.data.oppWritten === 1
            && st3.data.oppWritten === 0 && st3.data.skipped === 1 && opp3 === 0
            && c1.data.cleared === 1 && ourKeep === 1 && ourFilled === 0
            && c2.data.cleared === 1 && oppLeft === 0
            && staleAfterClear === true && staleAfterRun === false
            && staleAfterEdit === true && staleFinal === false,
          steps,
        };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
      finally {
        for (const mid of mids) await window.omnia.match.remove(mid).catch(() => {});
        for (const id of ids) await window.omnia.player.remove(id).catch(() => {});
      }
    })()`, '探针3d');

    for (const s of opp.steps) log('[smoke] M3d:', s);
    log('[smoke] M3d 对方帮会数据    :', opp.ok ? 'PASS' : 'FAIL');

    /* M3c：两个界面需求（用户口径 2026-09）
         ①「报名请假这里我可以手动新增加人」—— 报名页「＋ 手动加人」浮层：
            主档里没有的 ID 要能一次建档 + 写本场报名；
         ②「成员主档在在帮的基础上，有现在离帮的（能查到历史记录）」+「额外新加表：离帮人员的表」
            —— 成员主档的「离帮人员」表要列得出来，并能一键恢复到在帮。 */
    const manual = await guarded(`(async () => {
      const steps = smokeSteps();
      const made = { matches: [], players: [] };
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const waitFor = async (fn, label, ms = 10000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(150); }
        throw new Error('等待超时：' + label);
      };
      const nav = (text) => window.smokeNav(text);
      try {
        const api = window.omnia;
        // 未来日期 → 一定排在对局列表最前面，界面上点「进入」就是它
        const m = await api.match.create({ date: '2027-12-31', ourSide: '我方', oppSide: '手动加人' });
        if (!m.ok) throw new Error('建对局失败: ' + m.error);
        const mid = m.data.match.id;
        made.matches.push(mid);

        // ── ① 手动加人 ──
        const openSignup = async () => {
          nav('对局与战报').click();
          const detailReady = () => [...document.querySelectorAll('button.tab')]
            .some(x => x.textContent.includes('报名'));
          const t0 = Date.now();
          while (Date.now() - t0 < 8000) {
            const btn = [...document.querySelectorAll('table.grid button')]
              .find(x => x.textContent.trim() === '进入');
            if (btn) { btn.click(); break; }
            if (detailReady()) break;
            await sleep(150);
          }
          const tab = await waitFor(() => [...document.querySelectorAll('button.tab')]
            .find(x => x.textContent.includes('报名')), '报名页签');
          tab.click();
          /* 报名页本身也是异步取数的，点完页签不一定立刻有行；
             成员主档换成 78 张卡片之后渲染更重，这一拍更容易抢跑 ——
             所以这里容错：等不到就再点一次页签（点两次无害），最多试 3 轮。 */
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await waitFor(() => document.querySelector('.row-edit') ? true : null, '报名行', 4000);
              return;
            } catch {
              const t2 = [...document.querySelectorAll('button.tab')]
                .find(x => x.textContent.includes('报名'));
              t2?.click();
              await sleep(400);
            }
          }
          throw new Error('等待超时：报名行');
        };
        await openSignup();

        const popBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('手动加人'));
        if (!popBtn) throw new Error('报名页没有「＋ 手动加人」按钮');
        popBtn.click();
        const idInput = await waitFor(() => [...document.querySelectorAll('input.input')]
          .find(i => (i.placeholder || '').includes('ID / 名字')), '手动加人 ID 输入框');
        /* React 会给 DOM 节点的 value 属性装自己的 setter 并缓存旧值，
           直接 idInput.value = x 之后派发 input 事件会被判成"没变化"，onChange 不触发。
           必须走**原型上的原生 setter**，让 React 的 value tracker 看到真实变化。 */
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(idInput, 'smoke_manual_1');
        idInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(250);
        const submit = [...document.querySelectorAll('.pop button')]
          .find(b => b.textContent.trim() === '加入本场');
        if (!submit) throw new Error('浮层里没有「加入本场」按钮');
        submit.click();
        await sleep(600);
        const popErr = document.querySelector('.pop .msg.error');
        if (popErr) steps.push('浮层报错=' + popErr.textContent.trim());

        const rowHit = await waitFor(() => [...document.querySelectorAll('table.grid tbody tr')]
          .find(tr => tr.textContent.includes('smoke_manual_1')), '手动加进来的行');
        steps.push('手动加人 → 表里出现该行: ' + !!rowHit);

        const list = (await api.player.list()).data;
        const created = list.find(p => p.gameId === 'smoke_manual_1');
        if (created) made.players.push(created.id);
        steps.push('主档里已自动建档: ' + (created ? 'yes id=' + created.id : 'no'));
        const bd = (await api.signup.board(mid)).data;
        const bRow = bd.rows.find(r => r.gameId === 'smoke_manual_1');
        steps.push('本场报名状态=' + (bRow ? bRow.signup : '—') + ' 麦=' + (bRow ? bRow.mic : '—'));
        steps.push('统计 参加=' + bd.stats.joined + ' 未报名=' + bd.stats.none);

        // ── ② 离帮人员表 ──
        if (!created) throw new Error('手动加人没有建档，后面的离帮测试无法进行');
        /* 先给他留一条**参战记录**：用户口径「为啥离帮不会算进历史战局里」——
           离帮只是主档状态，participation / combat_stat 一条都不受影响。
           这里就断言：离帮之后，出勤统计里他仍然有场次，且离帮表能把数字显示出来。 */
        await api.match.upsertParticipation({ matchId: mid, playerId: created.id, state: 'PLAY', squad: '' });
        await api.player.update(created.id, { status: 'left' });
        const dash = (await api.dashboard.data()).data;
        const at = dash.attendance.find(x => x.playerId === created.id);
        steps.push('出勤统计里离帮成员: ' + (at ? '场次=' + at.matches + ' 上场=' + at.plays : '不见了（异常！）'));
        nav('成员主档').click();
        const leftTab = await waitFor(() => [...document.querySelectorAll('button.tab')]
          .find(b => b.textContent.includes('离帮人员')), '离帮人员页签');
        leftTab.click();
        /* 卡片式改版（2026-09）：成员列表从「表格行」换成「个人卡片」，
           选择器统一改成 .mcard（data-player-id 仍在，用于定位）。 */
        const leftRow = await waitFor(() => [...document.querySelectorAll('.mcard')]
          .find(c => c.textContent.includes('smoke_manual_1')), '离帮人员卡片');
        steps.push('离帮列表里能找到他: ' + !!leftRow);
        const cardTxt = (leftRow?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        steps.push('离帮卡片文本=' + JSON.stringify(cardTxt.slice(0, 96)));
        /* 快捷操作在 hover 时才滑出来，但 DOM 一直在：直接查按钮文案。 */
        const rowBtns = [...leftRow.querySelectorAll('.mcard__quick button')]
          .map(b => b.textContent.trim());
        steps.push('离帮卡片快捷操作=' + JSON.stringify(rowBtns));
        const leftH = Math.round(leftRow.getBoundingClientRect().height);

        /* 反向断言（用户反馈的 bug）：离帮的人**不能**出现在「在帮成员」表里。
           之前两张表是"包含"关系：在帮表列出全部人，离帮表再列一次，
           页签写 78、列表却 79 行。现在两张表互斥、加起来 = 全体。 */
        const clickTab = (txt) => [...document.querySelectorAll('button.tab')]
          .find(b => b.textContent.includes(txt))?.click();
        clickTab('在帮成员');
        await sleep(600);
        const stillInActive = [...document.querySelectorAll('.mcard')]
          .some(c => c.textContent.includes('smoke_manual_1'));
        const activeH = Math.round(document.querySelector('.mcard')?.getBoundingClientRect().height ?? 0);
        steps.push('在帮列表里还看得到离帮的人吗: ' + (stillInActive ? '看得到（异常！）' : '看不到')
          + ' ｜ 卡片数=' + document.querySelectorAll('.mcard').length);
        steps.push('卡片高度对照 离帮=' + leftH + ' 在帮=' + activeH + '（必须相等）');
        clickTab('离帮人员');
        const back2 = await waitFor(() => [...document.querySelectorAll('.mcard')]
          .find(c => c.textContent.includes('smoke_manual_1')), '回到离帮列表');
        const restore2 = [...back2.querySelectorAll('.mcard__quick button')]
          .find(b => b.textContent.includes('复帮') || b.textContent.includes('恢复到在帮'));
        if (!restore2) throw new Error('离帮卡片上没有「恢复到在帮 / 复帮」按钮');
        restore2.click();
        await waitFor(() => {
          const still = [...document.querySelectorAll('.mcard')]
            .some(c => c.textContent.includes('smoke_manual_1'));
          return still ? null : true;
        }, '恢复到在帮后从离帮列表消失');
        const back = (await api.player.list()).data.find(p => p.id === created.id);
        steps.push('恢复后主档状态=' + (back ? back.status : '—'));

        return {
          ok: !!created && !!bRow && bRow.signup === 'JOIN' && !!leftRow
            && back && back.status === 'active'
            && !!at && at.matches >= 1 && at.plays >= 1
            && leftH > 0 && leftH === activeH
            && rowBtns.includes('删除') && rowBtns.includes('复帮') && !rowBtns.includes('编辑')
            && !stillInActive
            && bd.stats.joined >= 1,
          steps,
        };
      } catch (e) {
        return { ok: false, steps: steps.concat('ERR ' + String(e)) };
      } finally {
        for (const id of made.matches) await window.omnia.match.remove(id).catch(() => {});
        for (const id of made.players) await window.omnia.player.remove(id).catch(() => {});
      }
    })()`, '探针3c');

    for (const s of manual.steps) log('[smoke] M3c:', s);
    log('[smoke] M3c 手动加人与离帮  :', manual.ok ? 'PASS' : 'FAIL');

    /* M3e：成员主档**拖动换位**（用户反馈：「拖动过后会卡顿且会收缩一下」「拖动反应卡卡的」）
       断言四件事：
         ① 拖动与松手前后卡片**不卸载**（列表不会塌成一行"加载中"）、网格高度不变 —— 这是当时"收缩一下"的根因；
         ② 滚动位置不回弹；
         ③ 顺序真的变了，「序」重写成连续 1..N，且**界面顺序与库一致**；
         ④ 拖动反馈在位（提示条文案、被拖卡的虚线类、落点标记），松手后无残留；
       另外量一个性能关键点：dragover 风暴期间 **App 自己不读布局**（原来是每个事件都读 getBoundingClientRect）。 */
    const rdrag = await guarded(`(async () => {
      const steps = smokeSteps();
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const waitFor = async (fn, label, ms = 8000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await sleep(120); }
        throw new Error('等待超时：' + label);
      };
      const made = [];
      /* 拖动会整批把「序」写成 1..N —— 连本来没有序（NULL）的人也会被写上，
         于是"列表第一张卡"可能换成另一个人，后续探针（详情页按第一张卡找雷达图）就会踩空。
         所以这里先记下每个人的原始 joinedOrder，收尾时**按原值还原**（包括 null）。 */
      let snapshot = [];
      try {
        const api = window.omnia;
        const nav = (t) => window.smokeNav(t);
        /* 自检库几乎是空的（只有前面探针留下的两三个人），
           一行的网格至少要 4 张卡才测得出"跨卡拖动"，所以先造 4 个人，收尾再删。 */
        for (let i = 1; i <= 4; i += 1) {
          const r = await api.player.create({ gameId: 'smoke_rd_' + i, name: 'smoke_rd_' + i });
          if (r.ok) made.push(r.data.id);
        }
        /* 页面可能已经挂着了（M3c 结束时就在成员主档），**同页导航不会重挂、也不会重新取数** ——
           所以先切到总览再切回来，保证列表里包含刚造出来的那 4 个人。 */
        nav('总览').click();
        await sleep(400);
        nav('成员主档').click();
        /* 上一个探针（M3c 离帮）收尾时停在「离帮人员」表，那边可能已经空了 ——
           先切回「在帮成员」再等卡片。 */
        const tabList = await waitFor(
          () => [...document.querySelectorAll('button.tab')].find(b => b.textContent.includes('在帮成员')),
          '主档页签');
        tabList.click();
        await waitFor(() => document.querySelectorAll('.mcard').length ? true : null, '成员卡片');

        const before = (await api.player.list()).data.map(p => p.id);
        snapshot = (await api.player.list()).data.map(p => ({ id: p.id, joinedOrder: p.joinedOrder }));
        const grid = document.querySelector('.mcard-grid');
        if (!grid) throw new Error('没有找到 .mcard-grid');
        const content = document.querySelector('.content');
        if (content) content.scrollTop = 120;
        await sleep(150);
        const cards = [...document.querySelectorAll('.mcard')];
        if (cards.length < 4) throw new Error('卡片太少，无法验证拖动：' + cards.length);

        /* 只统计**探针之外**（= App 自己）的布局读取：探针自身的读取通过开关排除 */
        const orig = Element.prototype.getBoundingClientRect;
        let appReads = 0;
        Element.prototype.getBoundingClientRect = function () {
          if (window.__countAppReads) appReads += 1;
          return orig.call(this);
        };

        const dt = new DataTransfer();
        const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        const src = cards[0];
        const dst = cards[3];
        const rc = dst.getBoundingClientRect();
        const rcGrid0 = grid.getBoundingClientRect();
        const h0 = Math.round(grid.getBoundingClientRect().height);
        const scroll0 = content ? content.scrollTop : 0;
        const movedId = Number(src.dataset.playerId);

        /* 诊断：这个探针历史上偶发"落点标记=0"（同代码两次跑一红一绿），
           根因一直没定性。这里把几条可能性直接测出来，省得下次再猜：
             · rAF 到底有没有在跑（拖拽命中判定挂在 requestAnimationFrame 上）
             · dragstart 前后卡片/网格有没有位移（有位移 → 探针的旧坐标必然落空）
             · 网格列数与内容宽度（跨过 @media 断点时卡片会整片重排） */
        const rafAlive = await new Promise((resolve) => {
          const t = setTimeout(() => resolve('超时(未触发)'), 600);
          requestAnimationFrame(() => { clearTimeout(t); resolve('正常'); });
        });
        const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;

        fire(src, 'dragstart', 0, 0);
        await sleep(80);
        const rc1 = dst.getBoundingClientRect();
        const rcGrid1 = grid.getBoundingClientRect();
        const dDst = Math.round(rc1.left - rc.left) + ',' + Math.round(rc1.top - rc.top);
        const dGrid = Math.round(rcGrid1.left - rcGrid0.left) + ',' + Math.round(rcGrid1.top - rcGrid0.top);
        const hintEl = document.querySelector('.drag-hint');
        steps.push('诊断 rAF=' + rafAlive + ' 网格列数=' + cols + ' 窗口宽=' + window.innerWidth
          + ' 内容宽=' + (content ? Math.round(content.clientWidth) : -1));
        steps.push('诊断 dragstart 位移 卡片Δ=(' + dDst + ') 网格Δ=(' + dGrid + ')'
          + ' 提示条高=' + (hintEl ? hintEl.offsetHeight : -1) + ' 探针点=('
          + Math.round(rc.left + rc.width * 0.6) + ',' + Math.round(rc.top + rc.height / 2) + ')');
        const hintStart = hintEl ? hintEl.textContent : '';
        const draggingCls = document.querySelectorAll('.mcard--dragging').length;
        const gridDragging = grid.className.indexOf('mcard-grid--dragging') >= 0;

        window.__countAppReads = true;
        for (let i = 0; i < 20; i += 1) fire(dst, 'dragover', rc.left + rc.width * 0.6, rc.top + rc.height / 2);
        window.__countAppReads = false;
        await sleep(80);
        /* 命中点统一用卡片宽度的 **60%**（不是 80%）：
           与下面那批 dragover 一致，且离右边缘还有 ~40% 宽度（≈80px）余量。
           2026-10-08 实测：这条探针同一份代码会一红一绿，且**与 CSS 无关** ——
           同一份 styles.css 连跑三次得到 FAIL/FAIL/PASS，跑绿那次连
           「排表尺寸」都跟着变（看板 1361x862 ↔ 1351x856），说明是环境里的
           布局变体在决定 80% 那个点是否落进卡片空隙。
           60% 仍在卡片中线右侧（探针要的是"插到目标后面"），但余量翻倍。
           ⚠️ 别改成 50% 正中心：那时 x === 中线，below 会变成 false，
              落点变成"插到目标前面"，断言 movedTo===3 就不成立了。 */
        for (let k = 0; k < 3; k += 1) {
          if (document.querySelectorAll('.mcard--drop-after,.mcard--drop-before').length > 0) break;
          const rc2 = dst.getBoundingClientRect();
          fire(dst, 'dragover', rc2.left + rc2.width * 0.6, rc2.top + rc2.height / 2);
          await sleep(200);
        }
        const marks = document.querySelectorAll('.mcard--drop-after,.mcard--drop-before').length;
        const tinted = document.querySelectorAll('.mcard--drop-target').length;
        const hintMid = hintEl ? hintEl.textContent : '';

        /* 松手后立刻密集采样：塌陷（卡片卸载）就发生在这一瞬间 */
        fire(dst, 'drop', rc.left + rc.width * 0.6, rc.top + rc.height / 2);
        fire(src, 'dragend', 0, 0);
        const samples = [];
        for (const d of [0, 16, 33, 66, 150, 400]) {
          if (d) await sleep(d - samples[samples.length - 1].d);
          samples.push({
            d,
            cards: document.querySelectorAll('.mcard').length,
            h: Math.round(grid.getBoundingClientRect().height),
            loading: document.body.innerText.indexOf('加载中') >= 0,
            scroll: content ? content.scrollTop : 0,
          });
        }
        Element.prototype.getBoundingClientRect = orig;

        const after = [...document.querySelectorAll('.mcard')].slice(0, 6).map(c => Number(c.dataset.playerId));
        const orders = [...document.querySelectorAll('.mcard__order')].slice(0, 6).map(e => e.textContent.trim());
        const dbOrder = (await api.player.list()).data.map(p => p.id);
        const leftover = document.querySelectorAll(
          '.mcard--drop-before,.mcard--drop-after,.mcard--drop-target,.mcard--dragging').length;
        const movedTo = after.indexOf(movedId);
        const dbMatchesUi = dbOrder.slice(0, after.length).every((id, i) => id === after[i]);

        steps.push('卡片数 ' + cards.length + ' → ' + samples.map(s => s.cards).join('/')
          + '（任何时刻都不能为 0）');
        steps.push('网格高度 ' + h0 + ' → ' + samples.map(s => s.h).join('/') + '（不能收缩）');
        steps.push('滚动 ' + Math.round(scroll0) + ' → ' + samples.map(s => Math.round(s.scroll)).join('/'));
        steps.push('提示条 开始=' + JSON.stringify(hintStart.slice(0, 44))
          + ' 悬停=' + JSON.stringify(hintMid.slice(0, 46)));
        steps.push('被拖卡类=' + draggingCls + ' 网格拖动态=' + gridDragging
          + ' 落点标记=' + marks + ' 目标底色=' + tinted);
        steps.push('dragover 20 次里 App 读布局=' + appReads + ' 次（应为 0）');
        steps.push('拖动后前 6 位=' + after.join(',') + ' 被拖的人在第 ' + (movedTo + 1) + ' 位');
        steps.push('序=' + orders.join(',') + ' 残留标记=' + leftover + ' 界面与库一致=' + dbMatchesUi);

        // 还原成拖动前的顺序，别影响后面的探针
        const back = await api.player.reorder(before);
        steps.push('已还原顺序=' + (back.ok ? '是' : '否'));

        return {
          ok: samples.every((s) => s.cards === cards.length && s.h === h0 && !s.loading)
            && samples.every((s) => Math.abs(s.scroll - scroll0) < 2)
            && movedTo === 3
            && orders.join(',') === after.map((_, i) => i + 1).join(',')
            && leftover === 0 && draggingCls === 1 && gridDragging === true
            && marks === 1 && tinted === 1 && appReads === 0
            && hintStart.indexOf('拖动') >= 0 && hintMid.indexOf('位') >= 0
            && dbMatchesUi === true && back.ok === true,
          steps,
        };
      } catch (e) {
        return { ok: false, steps: steps.concat('ERR ' + String(e)) };
      } finally {
        for (const id of made) await window.omnia.player.remove(id).catch(() => {});
        /* 按拖动前的原值还原每个人的「序」（含 null）——
           只靠 reorder(before) 是不够的：那会把 NULL 变成具体数字，等于改了"第一张卡"是谁。 */
        for (const s of snapshot) {
          await window.omnia.player.update(s.id, { joinedOrder: s.joinedOrder }).catch(() => {});
        }
      }
    })()`, '探针3e');

    for (const s of rdrag.steps) log('[smoke] M3e:', s);
    log('[smoke] M3e 主档拖动      :', rdrag.ok ? 'PASS' : 'FAIL');

    /* M5：战斗组/小队建制 —— **按场次独立**（用户口径 2026-09）
       这一版同时验证两件事：
         ① 组/队可新增、命名规则、有历史的队删不掉（原有断言）
         ② 改一场**不影响另一场**（新增的核心断言 —— 这正是用户提的需求） */
    const m5 = await guarded(`(async () => {
      const steps = smokeSteps();
      try {
        const api = window.omnia;
        // 建制挂在场上，所以先造一场
        const host = await api.match.create({ date: '2026-02-01', ourSide: '我方', oppSide: '建制宿主' });
        if (!host.ok) throw new Error('建宿主对局失败: ' + host.error);
        const hostMid = host.data.match.id;

        const cat = await api.meta.squads(hostMid);
        if (!cat.ok) throw new Error('读取建制失败: ' + cat.error);
        const groups = cat.data.groups.map(g => g.name + ':' + g.kind);
        const squads = cat.data.squads.map(s => s.name);
        steps.push('本场战斗组=' + groups.join(' '));
        steps.push('本场小队=' + squads.join(' '));
        steps.push('本场容量=' + cat.data.capacity + '（matchId=' + cat.data.matchId + '）');

        // 新增战斗组（会顺手建第 1 队）+ 再加两队，验证命名规则
        const g = await api.meta.createGroup(hostMid, { name: '演练组', kind: 'attack' });
        if (!g.ok) throw new Error('新增战斗组失败: ' + g.error);
        const s2 = await api.meta.createSquad(hostMid, { groupName: '演练组', tactic: '保镖' });
        steps.push('演练组已有 1 队，再增一队 → 「' + (s2.ok ? s2.data.name : 'ERR ' + s2.error) + '」');
        const s3 = await api.meta.appendSquad(hostMid, '演练组');
        steps.push('appendSquad → 「' + (s3.ok ? s3.data.name : 'ERR ' + s3.error) + '」');

        // 有历史记录的队删不掉
        const guardP = await api.player.create({ gameId: 'smoke_sqguard', name: '建制守卫', mainClass: '神相' });
        const guardM = await api.match.create({ date: '2026-02-03', ourSide: '我方', oppSide: '守卫队' });
        if (guardP.ok && guardM.ok) {
          await api.match.upsertParticipation({
            matchId: guardM.data.match.id, playerId: guardP.data.id, squad: '防守一-1', state: 'PLAY',
          });
        }
        const delUsed = await api.meta.removeSquad(guardM.ok ? guardM.data.match.id : 0, '防守一-1');
        steps.push('删有历史的队被拦=' + (delUsed.ok ? '否（异常！）' : '是')
          + (delUsed.ok ? '' : '（' + delUsed.error.slice(0, 30) + '…）'));

        /* 核心断言：改 A 场不影响 B 场 */
        const other = await api.match.create({ date: '2026-02-04', ourSide: '我方', oppSide: '另一场' });
        if (!other.ok) throw new Error('建对照对局失败: ' + other.error);
        const otherMid = other.data.match.id;
        const otherCat = await api.meta.squads(otherMid);
        const otherHasDrill = otherCat.data.groups.some(x => x.name === '演练组');
        steps.push('B 场（id=' + otherMid + '）是否被 A 场影响：演练组=' + (otherHasDrill ? '存在（异常！）' : '不存在 ✅'));
        // 再在 B 场删掉一个默认队，A 场必须还在
        const delB = await api.meta.removeSquad(otherMid, '进攻二-3');
        const aAfter = await api.meta.squads(hostMid);
        const aStillHas = aAfter.data.squads.some(x => x.name === '进攻二-3');
        steps.push('B 场删「进攻二-3」=' + (delB.ok ? '成功' : '失败:' + delB.error)
          + ' → A 场仍有该队=' + aStillHas);

        const aNames = new Set(aAfter.data.squads.map(x => x.name));
        const bAfter = await api.meta.squads(otherMid);
        const bNames = new Set(bAfter.data.squads.map(x => x.name));
        steps.push('A 场小队数=' + aNames.size + ' B 场小队数=' + bNames.size + '（应不同）');

        // 清理
        if (guardP.ok) await api.player.remove(guardP.data.id);
        if (guardM.ok) await api.match.remove(guardM.data.match.id);
        await api.match.remove(otherMid);
        await api.match.remove(hostMid);
        steps.push('清理完成');

        const isolated = !otherHasDrill && (delB.ok ? aStillHas : false)
          && aNames.size !== bNames.size;
        return {
          ok: cat.ok && groups.length === 4 && squads.length === 12
            && s2.ok && s2.data.name === '演练组-2' && s3.ok && s3.data.name === '演练组-3'
            && !delUsed.ok && isolated,
          steps,
        };
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
        const nav = window.smokeNav('排表');
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
        const navHome = window.smokeNav('总览');
        if (navHome) navHome.click();
        const waitFor = async (fn, label, ms = 6000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        await waitFor(() => document.querySelector('.hero') ? true : null, '首页主视觉');
        // 首页已改「大厂风」：品牌字是 .home-display，品牌块是 .home-brand，按钮是 .home-btn。
        // 注意：职业托盘已按用户要求**删除**，所以这里不再断言"12 个职业图标"。
        const heroBrand = document.querySelector('.home-display')?.textContent || '';
        const heroBlocks = document.querySelectorAll('.home-brand').length;
        // 首屏**不放按钮**（用户口径 2026-09：入口全部在顶栏常驻导航里）。
        // 这里断言为 0，既是当前口径，也是"别又长出一行与导航重复的按钮"的回归保护。
        const heroButtons = document.querySelectorAll('.home-cta .home-btn').length;
        steps.push('主视觉 品牌字=' + JSON.stringify(heroBrand) + ' 品牌块=' + heroBlocks + ' 快捷按钮=' + heroButtons);

        // 看板页渲染：数据看板是「页签 + 卡片」结构，没有 table.grid
        // （原先等 table.grid 会超时 —— 那是拿报名页/设置页的结构去套看板）
        const navBoard = window.smokeNav('数据看板');
        if (!navBoard) throw new Error('顶栏导航没有「数据看板」');
        navBoard.click();
        await waitFor(() => document.querySelector('button.tab') ? true : null, '看板页签');
        const boardTabs = document.querySelectorAll('button.tab').length;
        const boardCards = document.querySelectorAll('.card').length;
        steps.push('看板页 页签=' + boardTabs + ' 卡片=' + boardCards);

        /* 设置页：权重与规则并入后是默认页签。
           建制已按场次独立（用户口径），设置页**不再管建制** ——
           这里断言「设置页没有建制页签」，作为回归保护。 */
        const navSet = window.smokeNav('设置');
        if (!navSet) throw new Error('顶栏导航没有「设置」');
        navSet.click();
        await waitFor(() => document.querySelectorAll('.tabs button.tab').length >= 2 ? true : null, '设置页页签');
        const settingsTabs = [...document.querySelectorAll('.tabs button.tab')].map(b => b.textContent.trim());
        const hasSquadTab = settingsTabs.some((x) => x.includes('战斗组'));
        const hasInfoTab = settingsTabs.some((x) => x === '全部信息');
        steps.push('设置页 页签=' + JSON.stringify(settingsTabs)
          + ' 建制页签=' + hasSquadTab + '（应 false）'
          + ' 全部信息页签=' + hasInfoTab + '（应 true）');

        // 清理
        for (const id of created.matches) await api.match.remove(id);
        for (const id of created.players) await api.player.remove(id);
        const after = await api.dashboard.data();
        steps.push('清理后场次=' + (after.ok ? after.data.totals.matches : '?') + ' 成员=' + (after.ok ? after.data.totals.players : '?'));

        const ok = t.statSlots === 5 && t.statFilled === 4
          && Math.abs(t.statRate - 4 / 5) < 1e-6
          && d.data.classPlayCount.length >= 3
          && d.data.squadUsage.some(s => s.squad === '防守一-1' && s.kind === 'defend')
          && heroBrand.includes('Omnia') && heroBlocks === 1
          // 首屏不再有按钮：入口全在顶栏
          && heroButtons === 0
          // 设置页 4 个页签（权重与规则 / 壁纸 / 数据与兼容 / 全部信息）——建制已移出
          && settingsTabs.length === 4 && !hasSquadTab && hasInfoTab;
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
        const nav = window.smokeNav('成员主档');
        if (!nav) throw new Error('顶栏导航没有「成员主档」');
        nav.click();
        const btn = await waitFor(
          () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '从 xlsx 导入'),
          '「从 xlsx 导入」按钮');
        btn.click();
        const modal = await waitFor(() => document.querySelector('.modal'), '导入向导弹窗');
        const title = modal.querySelector('h3')?.textContent || '';
        const hasFileBtn = !!([...modal.querySelectorAll('button')].find(b => b.textContent.includes('选择 xlsx 文件')));
        // 原来这里断言弹窗文案里有「表头」二字，但那句是说明性小字、已按用户口径删除。
        // 改成结构性断言：弹窗里确实有文件输入框（不依赖任何文案）。
        const hasInput = !!modal.querySelector('input[type=file]');
        steps.push('弹窗标题=' + JSON.stringify(title) + ' 有选文件按钮=' + hasFileBtn + ' 有文件输入框=' + hasInput);
        // 关掉弹窗
        const closeBtn = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === '关闭');
        if (closeBtn) closeBtn.click();
        await new Promise(r => setTimeout(r, 200));
        const closed = !document.querySelector('.modal');
        steps.push('点击关闭后弹窗已消失=' + closed);
        return { ok: title.includes('导入成员主档') && hasFileBtn && hasInput && closed, steps };
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
        const nav = window.smokeNav('对局与战报');
        if (!nav) throw new Error('顶栏导航没有「对局与战报」');
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
        steps.push('团队人均 有效击杀=' + d.data.teamAverage.effKills.toFixed(2)
          + ' 有效人伤=' + d.data.teamAverage.effDmg.toFixed(2));

        // 乙：第二场没填战报，plays=2 但 statFilled=1
        const d2 = await api.player.detail(b.data.id);
        steps.push('乙 上场=' + (d2.ok ? d2.data.totals.plays : '?')
          + ' 已填战报=' + (d2.ok ? d2.data.totals.statFilled : '?') + '（应 2 / 1）');

        // 页面渲染：进成员主档 → 点某张卡片快捷操作里的「详情」
        // 注意：成员列表 2026-09 改成了**个人卡片**（.mcard），
        // 快捷操作在 .mcard__quick 里（hover 才滑出来，但 DOM 一直在）。
        const nav = window.smokeNav('成员主档');
        nav.click();
        /* 按 **data-player-id 精确定位甲**，不要用"第一张卡" —— 卡片顺序受「序」影响，
           别的探针一改序，这里就会点到另一个人（没有战报 → 没有雷达图 → 超时）。 */
        const cardA = await waitFor(() => document.querySelector('.mcard[data-player-id="' + a.data.id + '"]'),
          '甲的成员卡片');
        /* 用户口径 2026-09-27：点整张卡片就是开成员详情（快捷操作里的「详情」已删） */
        cardA.click();
        const radar = await waitFor(() => document.querySelector('svg.radar'), '雷达图');
        const polygons = radar.querySelectorAll('polygon').length;
        const labels = [...radar.querySelectorAll('text')].map(e => e.textContent);
        const rows = document.querySelectorAll('table.grid tbody tr').length;
        steps.push('雷达多边形=' + polygons + '（个人 + 基准圈 = 2）标签=' + labels.join('/'));
        steps.push('雷达下方对比表行数=' + rows);
        const back = [...document.querySelectorAll('button')].find(x => x.textContent.includes('← 成员主档'));
        if (back) back.click();
        await waitFor(() => document.querySelector('button') && !document.querySelector('svg.radar') ? true : null, '返回主档');

        /* 再进一次详情，这次用**顶栏导航**退出。
           用户反馈过「卡住」：详情页是成员主档的子视图，顶栏点「成员主档」时若不重置
           detailId，点击看着毫无反应，只能靠页面里的返回按钮。这里锁住这个行为。 */
        const cardA2 = await waitFor(
          () => document.querySelector('.mcard[data-player-id="' + a.data.id + '"]'), '甲的成员卡片（第二次）');
        cardA2.click();
        await waitFor(() => document.querySelector('svg.radar'), '雷达图（第二次）');
        window.smokeNav('成员主档').click();
        await waitFor(() => document.querySelector('.mcard-grid') ? true : null, '顶栏退出详情');
        steps.push('顶栏「成员主档」能退出详情: 是');

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
        const nav = window.smokeNav('对局与战报');
        nav.click();
        const waitFor = async (fn, label, ms = 8000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        // 可能停在列表，也可能自动进入详情
        // ⚠️ 判据必须是「报名页签」本身，不能是"有没有 button.tab"：
        //    成员主档现在也有 .tabs（在帮 / 离帮两张表），页面还没切过去时
        //    就能看到 button.tab，于是这个循环会立刻 break，最后卡在等报名页签上。
        const detailTabReady = () => [...document.querySelectorAll('button.tab')]
          .some(x => x.textContent.includes('报名'));
        const tEnter = Date.now();
        while (Date.now() - tEnter < 6000) {
          const btn = [...document.querySelectorAll('table.grid button')].find(x => x.textContent.trim() === '进入');
          if (btn) { btn.click(); break; }
          if (detailTabReady()) break;
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

        /* 权重与规则已并入「设置」页，且是设置的**默认页签** ——
           所以从顶栏进「设置」即可看到规则列表，不再有独立的导航项。 */
        const nav = window.smokeNav('设置');
        if (!nav) throw new Error('顶栏导航没有「设置」');
        nav.click();
        const waitFor = async (fn, label, ms = 8000) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise(res => setTimeout(res, 150)); }
          throw new Error('等待超时：' + label);
        };
        // 默认页签就是「权重与规则」；万一以后改默认值，这里顺手点一下更稳
        await waitFor(() => document.querySelector('.tabs button.tab') ? true : null, '设置页页签');
        const rulesTab = [...document.querySelectorAll('.tabs button.tab')].find(b => b.textContent.includes('权重与规则'));
        if (rulesTab) rulesTab.click();
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
        const home = window.smokeNav('总览');
        if (!home) throw new Error('顶栏导航没有「总览」');
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
        // 注意查 html 而不是 body：body 被设成 transparent（否则会盖住 z-index:-1 的壁纸层），深色底在 html 上
        const bgComputed = getComputedStyle(document.documentElement).backgroundColor;
        const heroCard = document.querySelector('.card') ? getComputedStyle(document.querySelector('.card')).backgroundColor : '';
        // 大厂风：全局深色底 rgb(11,11,13)、首页下滑区白底 rgb(255,255,255)
        steps.push('主题 页面背景=' + bgComputed + '（应 rgb(11, 11, 13)） 首页卡片=' + heroCard + '（应有非透明背景）');
        // 卡片配色随设计迭代（磨砂/白半透/纯白三级），不再钉死具体颜色，
        // 只要求：页面底是深色、卡片有非透明的背景（能读出来即可）。
        const themeOk = bgComputed === 'rgb(11, 11, 13)'
          && !!heroCard && heroCard !== 'rgba(0, 0, 0, 0)' && heroCard !== 'transparent';

        /* 导航：侧栏已删（用户口径 2026-09），改为顶部导航条并**常驻**
           （用户后来明确：不需要收缩按钮了）。断言：
             ① .sidebar 必须**不存在**（回归保护：别又长出侧栏）
             ② .nav-toggle 折叠按钮也**不存在**（常驻 → 没有收缩入口）
             ③ 导航在顶栏里（.topbar .nav-item）、可见、6 项文案齐全
                （其它探针靠文案定位页面，缺一项会连带失败）
             ④ 换页后仍常驻可见（曾经"收起后再展开"的路径已不存在） */
        const sidebarGone = !document.querySelector('.sidebar');
        const toggleGone = !document.querySelector('.nav-toggle');
        const navItems = () => [...document.querySelectorAll('.topbar .nav-item')];
        const navBox = () => {
          const n = document.querySelector('.topbar .nav');
          return n ? n.getBoundingClientRect() : null;
        };
        const navVisible = () => { const b = navBox(); return !!b && b.height > 0 && b.width > 0; };
        const navLabels = navItems().map(b => b.textContent.trim());
        const vis = navVisible();
        const count = navItems().length;
        // 顶栏在首屏之上，不能被首屏盖住（首屏 top 应为顶栏下方）
        const topbarBox = document.querySelector('.topbar').getBoundingClientRect();
        const heroTop = document.querySelector('.home-hero').getBoundingClientRect().top;

        steps.push('侧栏已删除=' + sidebarGone + ' 折叠按钮已删除=' + toggleGone
          + ' 导航项=' + JSON.stringify(navLabels));
        steps.push('导航可见=' + vis + ' 项数=' + count
          + ' 顶栏高=' + Math.round(topbarBox.height) + ' 首屏 top=' + Math.round(heroTop));

        /* 导航口径 2026-09-27（用户：「3 个一级页签：首屏/帮会/设置；进入帮会后有 5 个二级页签，
           二级放帮会页里，当前帮会只显示文字、不要 ▾ 下拉」）：
           这里断言 **顶栏 = 3 个一级 + 1 个当前帮会**，且 5 个二级页签在**帮会页内**找得到。 */
        const topLabels = ['总览', '帮会', '设置'];
        const subLabels = ['帮会首页', '成员主档', '对局与战报', '排表', '数据看板'];
        const topOk = topLabels.every((l) => navLabels.includes(l));
        // 进帮会 → 页内页签应齐 5 个（顺带验证"点得进去"）
        const entered = await window.__enterGuild();
        const subTabs = [...document.querySelectorAll('[data-guild-tabs] button')]
          .map((b) => b.textContent.trim());
        const subOk = entered === true && subLabels.every((l) => subTabs.includes(l));
        const labelsOk = topOk && subOk;
        steps.push('一级页签=' + JSON.stringify(navLabels.filter((l) => topLabels.includes(l)))
          + ' 二级页签(帮会页内)=' + JSON.stringify(subTabs));
        // 顶栏 = 3 个一级（用户口径 2026-09-27：不要再有"当前帮会"按钮）
        const wantCount = topLabels.length;

        return {
          ok: heroOk
            && stillThere === false
            && themeOk
            && sidebarGone && toggleGone && labelsOk
            && vis && count === wantCount
            && topbarBox.height > 0,
          steps,
        };
      } catch (e) { return { ok: false, steps: steps.concat('ERR ' + String(e)) }; }
    })()`, '探针11');
    for (const s of guide.steps) log('[smoke] 首页:', s);
    /* 导航已改成常驻：原先「收起后再展开」的恢复步骤（探针11b）已无意义，
       整段删除。折叠按钮本身也不该再存在 —— 这一点已在上面的探针里断言。 */
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

        const nav = window.smokeNav('排表');
        if (!nav) throw new Error('导航里没有「排表」');
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
        const active = document.querySelector('[data-guild-tabs] button[aria-current="page"]')?.textContent?.trim() ?? '';
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
      const nav = window.smokeNav('排表');
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
        const { id, version, active: act, createdAt, ...curInput } = cur;
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
        const nav = window.smokeNav('对局与战报');
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

    /* 赛季探针已随「删除赛季页」一并移除（2026-09，用户口径：赛季整块不要了，
       连数据层一起清）。这里不再断言赛季相关行为，也无需再清理探针赛季。 */

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
      const nav = window.smokeNav('总览');
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

    /* M8 壁纸：本地文件必须能经 `omnia://` 特权协议加载。
       根因（实测对照，别再走回头路）：
         `npm run dev` 时页面来源是 http://127.0.0.1:5173，而 Chromium **禁止 http 源
         读取 file:// 资源，且 CSP 放不开** —— 给 img-src 加 file: 之后依然 BLOCKED；
         同一张图在 file 源（打包形态）下 PASS。于是壁纸缩略图与全局壁纸层在开发模式下
         全是空白，打包后却正常，形成「打包能用、开发不能用」的假象。
       修法：主进程注册 omnia:// 协议（registerLocalProtocol），渲染层统一走
         lib/localFile.ts 的 localUrl()，CSP 里显式放行 omnia:。

       ⚠️ 本探针**结构上无法复现那个 bug**：smoke 跑的是打包产物（file 源），
         而 file 源下 file:// 本来就通。它只钉住「omnia: 协议可用 + CSP 放行 +
         目录穿越被挡」，不宣称能防住「有人又改回 file://」—— 那需要 http 源下的验证。 */
    const wallOk = await (async () => {
      const classIcon = path.join(APP_ROOT, 'src', 'renderer', 'public', 'class-icons', 'image1.png');
      const guideImg = path.join(APP_ROOT, 'src', 'renderer', 'public', 'guide', 'image26.png');
      const wallAssets = [
        classIcon,
        guideImg,
        path.join(APP_ROOT, 'src', 'renderer', 'public', 'guide', 'image22.png'),
      ];
      const existing = wallAssets.filter((p) => fs.existsSync(p));
      const localUrls = existing.map(toLocalUrl);
      const fileUrls = existing.map((p) => 'file:///' + p.split(/[\\/]+/).filter(Boolean).join('/'));

      /* ── 目录穿越探针（2026-10-08 重做，HANDOFF 待办 3）──────────────────────
         旧写法是 `urls[0].replace('/class-icons/', '/../class-icons/')` —— **恒真**：
         字面 `..` 会被 URL 解析器（omnia: 注册成了 standard scheme）先归一化掉，
         于是它指向 `src/renderer/class-icons/imageX.png`：一个**根本不存在的目录**。
         "加载失败"跟 main.ts 里那条 403 守卫毫无关系 ——
         把守卫删掉，旧探针**照样 PASS**（= 它测的是"文件不存在"，不是"守卫有效"）。

         修法：把斜杠也一起百分号编码（`%2e%2e%2f`）。这样一个 path 段不再匹配
         URL 标准的 "double-dot path segment"（只认 `..` / `.%2e` / `%2e.` / `%2e%2e`），
         解析器不会折叠它；主进程 `decodeURIComponent` 之后才变回 `../`。
         于是**只有** `rel.includes('..')` 那条守卫能拦住它。

         同时保证"若不拦就会命中一张**真实存在**的图"（classIcon 必须存在），
         否则探针又会退化成"测文件在不在"。                                         */
      const evasionUrl = (() => {
        if (!fs.existsSync(classIcon) || !fs.existsSync(guideImg)) return '';
        const tail = '%2e%2e%2fclass-icons%2f' + path.basename(classIcon);
        return toLocalUrl(guideImg).replace(/\/[^/]*$/, '/' + tail);
      })();

      const wallProbe = await guarded(`(async () => {
        const urls = ${JSON.stringify(localUrls)};
        const fileUrls = ${JSON.stringify(fileUrls)};
        const evasion = ${JSON.stringify(evasionUrl)};
        const load = (u) => new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ u, ok: img.naturalWidth > 0, w: img.naturalWidth });
          img.onerror = () => resolve({ u, ok: false, w: 0 });
          img.src = u;
        });
        // 1) 多张 omnia:// 都要能加载
        const results = [];
        for (const u of urls) results.push(await load(u));
        // 2) fetch 也要通（协议声明了 supportFetchAPI，走 net.fetch）
        let fetchStatus = 'n/a';
        try { const r = await fetch(urls[0]); fetchStatus = r.ok ? String(r.status) : 'fail ' + r.status; }
        catch (e) { fetchStatus = 'threw: ' + String(e).slice(0, 60); }
        // 3) 目录穿越必须被挡（见主进程里 evasionUrl 的注释：只有真守卫能拦住它）
        const bad = evasion
          ? await load(evasion)
          : { u: '', ok: false, w: 0 };
        const blockedTraversal = !!evasion && !bad.ok;
        // 4) CSS background-image 走 omnia://（全局壁纸层的真实加载方式）
        const d = document.createElement('div');
        d.style.backgroundImage = 'url("' + urls[0] + '")';
        document.body.appendChild(d);
        const cssVal = getComputedStyle(d).backgroundImage;
        const cssOk = cssVal.indexOf('omnia:') >= 0;
        d.remove();
        // 5) dataURL 兜底（中缝图走这条）
        const dataOk = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth > 0);
          img.onerror = () => resolve(false);
          img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
        });
        // 6) file:// 在 file 源下应照常可用（不回归打包形态）
        const fileRes = fileUrls.length ? await load(fileUrls[0]) : { ok: false, w: 0 };
        return {
          ok: true, steps: [],
          value: { results, fetchStatus, blockedTraversal, cssOk, cssVal, dataOk, fileRes,
                   evasion, evasionOk: bad.ok,
                   origin: location.origin, csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '' },
        };
      })()`, '探针13');

      type WallProbe = {
        results: { u: string; ok: boolean; w: number }[];
        fetchStatus: string; blockedTraversal: boolean; cssOk: boolean; cssVal: string;
        dataOk: boolean; fileRes: { ok: boolean; w: number };
        evasion: string; evasionOk: boolean;
        origin: string; csp: string;
      };
      const wp = (wallProbe.value as WallProbe | undefined) ?? {
        results: [], fetchStatus: 'n/a', blockedTraversal: false, cssOk: false, cssVal: '',
        dataOk: false, fileRes: { ok: false, w: 0 },
        evasion: '', evasionOk: false, origin: '', csp: '',
      };
      const cspAllowsOmnia = /img-src[^;]*omnia:/.test(wp.csp) && /media-src[^;]*omnia:/.test(wp.csp);
      const allLoaded = wp.results.length > 0 && wp.results.every((x) => x.ok);
      /* 探针是否"真的架起来了"：拿不到 evasionUrl（样本图缺失）就不算通过，
         免得又退化成一条永远 PASS 的空转断言。 */
      const traversalArmed = evasionUrl !== '' && wp.evasion === evasionUrl;
      const wallOk = cspAllowsOmnia && allLoaded && wp.fetchStatus === '200'
        && traversalArmed && wp.blockedTraversal && wp.cssOk && wp.dataOk;
      log('[smoke] 壁纸页面来源      :', wp.origin);
      log('[smoke] CSP 含 omnia:      :', cspAllowsOmnia ? 'PASS' : 'FAIL');
      log('[smoke] omnia:// 图片加载  :', allLoaded ? 'PASS' : 'FAIL',
        wp.results.map((x) => `${x.u.split('/').pop()}:${x.ok ? x.w + 'px' : '失败'}`).join(' '));
      log('[smoke] omnia:// fetch     :', wp.fetchStatus === '200' ? 'PASS' : 'FAIL', `status=${wp.fetchStatus}`);
      log('[smoke] 目录穿越被挡      :', wp.blockedTraversal && traversalArmed ? 'PASS' : 'FAIL',
        `试探=${wp.evasion || '（未构造出）'} 结果=${wp.evasionOk ? '竟然加载成功 ✗' : '已挡住 ✓'}`);
      if (!traversalArmed) {
        log('[smoke] ⚠️ 目录穿越探针没架起来（样本图缺失或 URL 没送到渲染层）→ 按 FAIL 计');
      }
      log('[smoke] CSS 背景 omnia://  :', wp.cssOk ? 'PASS' : 'FAIL');
      log('[smoke] dataURL 兜底       :', wp.dataOk ? 'PASS' : 'FAIL');
      return wallOk;
    })();

    const pass =
      r.preload && r.appInfo && r.classes === 12 && r.players >= 0 &&
      Number(rootHtml) > 100 && crud.ok === true && m3.ok === true && atomic.ok === true
      && alias.ok === true
      && opp.ok === true && manual.ok === true && rdrag.ok === true && m5.ok === true
      && m6.ok === true && m7.ok === true && wizard.ok === true && dnd.ok === true
      && detail.ok === true && signup.ok === true && rules.ok === true && guide.ok === true
      && scoring.ok === true && iconOk && lineup.ok === true
      && geom.ok === true && slot.ok === true && cap.ok === true && sgImp.ok === true
      && wallOk === true
      && r.schemaVersion >= 19;
    log('[smoke] 写操作往返          :', crud.ok ? 'PASS' : 'FAIL');
    log('[smoke] 结果                :', pass ? 'PASS' : 'FAIL');
    app.exit(pass ? 0 : 1);
  });
}
