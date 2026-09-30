/**
 * IPC 注册：主进程唯一的对外契约入口
 * 所有处理函数都返回 IpcResult<T>，异常被捕获并转成 { ok:false, error }，
 * 避免 IPC 序列化丢失堆栈。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import fs from 'node:fs';
import { IPC, type AppInfo, type ClassInfo, type IpcResult, type PlayerInput } from '../shared/types';
import type {
  MatchInput, ParticipationInput, AssignInput, CombatStat, ImportPreview, GroupInput,
  OppImportMode, RuleSetInput, SignupImportRow, SignupInput, SquadInput,
} from '../shared/types';
import { buildPreview, type RosterEntry } from '../shared/statImport';
import { detectHeaderRow, listSheets, readXlsx } from './xlsx';
import { parseSignupGrid } from '../shared/signupImport';
import type { SqlDatabase } from './db';
import { GuildStore, isGlobalSetting } from './guilds';
import { PlayerRepo } from './repositories/playerRepo';
import { MatchRepo } from './repositories/matchRepo';
import { SquadRepo } from './repositories/squadRepo';
import { DashboardRepo } from './repositories/dashboardRepo';
import { SignupRepo } from './repositories/signupRepo';
import { RuleSetRepo, validate as validateRuleSet } from './repositories/ruleSetRepo';
import { scoreMatch } from '../shared/scoreEngine';

export interface IpcContext {
  /**
   * 当前帮会的库连接。**每次调用都取一次**，因为切帮会只换 GuildStore 里的句柄，
   * 仓储实例与 IPC 处理器都不重建（见 src/main/guilds.ts）。
   */
  db: () => SqlDatabase;
  /** 当前库文件路径（appInfo / 排障用） */
  dbFile: () => string;
  /** 帮会注册表；单库模式（OMNIA_DB_PATH）下为 null */
  guilds: GuildStore | null;
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

/** 包裹处理函数，统一捕获异常 */
function safe<A extends unknown[], R>(fn: (...args: A) => R) {
  return async (_evt: unknown, ...args: A): Promise<IpcResult<R>> => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[omnia:ipc] 处理失败:', msg);
      return { ok: false, error: msg };
    }
  };
}

export function registerIpc(ctx: IpcContext): void {
  const players = new PlayerRepo(ctx.db);
  const matches = new MatchRepo(ctx.db);
  const squads = new SquadRepo(ctx.db);
  const dashboard = new DashboardRepo(ctx.db);
  const signup = new SignupRepo(ctx.db);
  const rules = new RuleSetRepo(ctx.db);

  /* 战报导入的匹配基准：全部我方成员 + 各自的历史用名。
     直接用仓储的 list()（它已经排除对方帮会并带好别名），
     免得这里再抄一遍"查 player + 查 player_alias 再分组"的 SQL。 */
  const rosterEntries = (): RosterEntry[] =>
    players.list().map((p) => ({
      id: p.id,
      gameId: p.gameId,
      name: p.name,
      // 职业不再来自主档（改由报名表提供），这里给匹配用的 ID、名字与**历史用名**
      mainClass: '',
      aliases: p.aliases,
    }));

  const knownClassNames = (): string[] =>
    (ctx.db().prepare('SELECT name FROM class').all() as unknown as { name: string }[])
      .map((r) => r.name);

  /* 设置分两类：
       · 跨帮会的（壁纸 / 品牌名这类界面偏好）→ 写在注册表 guilds.json 里，
         否则切一次帮会壁纸就"变回默认"了（用户很在意壁纸）；
       · 跟帮会数据有关的（activeRuleSetId、中缝图 dividerImage…）→ 留在各帮会自己的库里。
     单库模式（OMNIA_DB_PATH）下注册表只是内存里的一个虚拟帮会：**一律读写库里的 app_setting**，
     否则设置只活在本次进程里（自检与开发都靠单库模式）。 */
  const multi = (): boolean => !!ctx.guilds && !ctx.guilds.isSingle();
  const readSetting = (key: string): string | undefined => {
    if (multi() && isGlobalSetting(key)) {
      const v = ctx.guilds?.globalSetting(key);
      if (v !== undefined) return v;
    }
    const row = ctx.db().prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  };
  const writeSetting = (key: string, value: string): void => {
    if (multi() && isGlobalSetting(key)) {
      ctx.guilds?.setGlobalSetting(key, value);
      return;
    }
    ctx.db().prepare(
      `INSERT INTO app_setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  };

  ipcMain.handle(IPC.appInfo, safe((): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
    dbPath: ctx.dbFile(),
    platform: `${process.platform} ${process.arch}`,
    schemaVersion: Number((ctx.db().prepare(
      'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration',
    ).get() as { v: number }).v),
    guild: ctx.guilds?.active() ?? null,
    guildCount: ctx.guilds?.list().length ?? 1,
  })));
  /* ── 帮会（一帮会一个库文件）────────────────────────────────────
     存储/迁移细节都在 src/main/guilds.ts；这里只做 IPC 门面。
     `guild:open` 之后，所有其它接口读写的都是新帮会的库（仓储拿的是"当前连接"）。 */
  const needGuilds = (): GuildStore => {
    if (!ctx.guilds) throw new Error('单库模式（OMNIA_DB_PATH）下没有帮会注册表');
    return ctx.guilds;
  };
  ipcMain.handle(IPC.guildList, safe(() => needGuilds().list()));
  ipcMain.handle(IPC.guildActive, safe(() => ctx.guilds?.active() ?? null));
  ipcMain.handle(IPC.guildCreate, safe((name: string, note?: string) => needGuilds().create(name, note ?? '')));
  ipcMain.handle(IPC.guildOpen, safe((id: string) => needGuilds().open(String(id))));
  ipcMain.handle(IPC.guildUpdate, safe((id: string, patch: { name?: string; note?: string }) =>
    needGuilds().rename(String(id), patch?.name ?? '', patch?.note)));
  ipcMain.handle(IPC.guildRemove, safe((id: string) => {
    if (!needGuilds().remove(String(id))) throw new Error(`帮会不存在：${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.guildSetCover, safe((id: string, srcPath: string) =>
    needGuilds().setCover(String(id), String(srcPath))));
  ipcMain.handle(IPC.guildPickCover, safe(async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      title: '选择帮会封面图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }));

  /* ── 成员个人主页背景（用户口径 2026-09-27）─────────────────────────
     每个成员可传一段 mp4 或一张图；文件拷进 guilds/<帮会>/players/<成员>/bg.<ext>
     （单库模式落到 userData/media/players/<成员>/），库里只记绝对路径。 */
  const bgDirOf = (playerId: number): string => {
    const fsp = require('node:fs') as typeof import('node:fs');
    const pth = require('node:path') as typeof import('node:path');
    const g = ctx.guilds?.active();
    const base = (g && ctx.guilds) ? ctx.guilds.dirOf(g.id) : pth.join(app.getPath('userData'), 'media');
    const dir = pth.join(base, 'players', String(playerId));
    fsp.mkdirSync(dir, { recursive: true });
    return dir;
  };
  ipcMain.handle(IPC.playerPickBg, safe(async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      title: '选择个人主页背景（视频或图片）',
      properties: ['openFile'],
      filters: [
        { name: '视频或图片', extensions: ['mp4', 'webm', 'mov', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: '视频', extensions: ['mp4', 'webm', 'mov'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      ],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }));
  ipcMain.handle(IPC.playerSetBg, safe((id: number, srcPath: string) => {
    const fsp = require('node:fs') as typeof import('node:fs');
    const pth = require('node:path') as typeof import('node:path');
    const src = String(srcPath ?? '');
    if (!src || !fsp.existsSync(src)) throw new Error('文件不存在：' + src);
    const ext = (pth.extname(src) || '.bin').toLowerCase();
    const dir = bgDirOf(Number(id));
    const cur = players.getById(Number(id));
    /* ⚠️ 不能"先删旧文件再拷新的"：如果成员当前正用这个文件当背景，
       <video> 播放会**锁住文件**，rmSync 抛 EBUSY（用户实测就是这个错）。
       改成写一个**新文件名**，再把库指向它；旧的（可能正在播）先留着，
       等下次导入或删帮会时自然清掉。 */
    const dest = pth.join(dir, `bg-${Date.now()}${ext}`);
    fsp.copyFileSync(src, dest);
    const updated = players.setBgMedia(Number(id), dest);
    for (const f of fsp.readdirSync(dir)) {
      const p = pth.join(dir, f);
      if (p === dest || p === cur?.bgMedia) continue;   // 刚写的、正在用的，都不动
      try { fsp.rmSync(p, { force: true }); } catch { /* 被播放锁定，留着下次 */ }
    }
    return updated;
  }));
  ipcMain.handle(IPC.playerClearBg, safe((id: number) => {
    const fsp = require('node:fs') as typeof import('node:fs');
    const pth = require('node:path') as typeof import('node:path');
    const cur = players.getById(Number(id));
    /* 先把文件删掉再清库（否则库里清了、文件留在 guilds/<帮会>/players/<成员>/ 里占空间） */
    if (cur?.bgMedia) {
      try { fsp.rmSync(pth.dirname(cur.bgMedia), { recursive: true, force: true }); } catch { /* 文件不在就算了 */ }
    }
    return players.clearBgMedia(Number(id));
  }));

  // ── 成员主档 ───────────────────────────────────────────────────
  ipcMain.handle(IPC.playerList, safe(() => players.list()));
  ipcMain.handle(IPC.playerCreate, safe((input: PlayerInput) => players.create(input)));
  ipcMain.handle(IPC.playerUpdate, safe((id: number, patch: Partial<PlayerInput>) => players.update(id, patch)));
  ipcMain.handle(IPC.playerRemove, safe((id: number) => {
    if (!players.remove(id)) throw new Error(`成员不存在：id=${id}`);
    return true as const;
  }));
  // 壁纸库：扫描用户在设置页填入的地址（静态图 + 动态视频都收）
  ipcMain.handle(IPC.metaListWallpapers, safe((dir?: string) => {
    const fsp = require('node:fs') as typeof import('node:fs');
    const pth = require('node:path') as typeof import('node:path');
    const IMG = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif']);
    const VID = new Set(['.mp4', '.webm', '.mov', '.mkv']);
    // 注意：这条 IPC 的参数会被丢（项目已知问题），所以路径**从设置读**：
    // 设置页先把用户填的地址写进 wallpaperLibrary，再触发本方法。
    const saved = readSetting('wallpaperLibrary');
    // 候选目录（下面还会追加 WE 默认位置与系统目录，最后统一去重）
    const rootsRaw = [String(dir ?? saved ?? '').trim()].filter(Boolean);
    // 默认壁纸库 = Wallpaper Engine 创意工坊（Steam AppID 431960）。
    // 没有就退回系统目录，再没有就空 —— 让用户在设置页填地址。
    const WE = ['C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960',
      'C:\\Program Files\\Steam\\steamapps\\workshop\\content\\431960',
      // 副库（Steam 可以把库装到别的盘）
      'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960',
      'D:\\Steam\\steamapps\\workshop\\content\\431960',
      'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960'];
    for (const w of WE) { try { if (fsp.statSync(w).isDirectory()) { rootsRaw.push(w); break; } } catch { /* 没装 WE */ } }
    if (!rootsRaw.length) {
      rootsRaw.push(
        'C:\\Windows\\Web\\Wallpaper',
        pth.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes'),
        pth.join(app.getPath('pictures'), 'Wallpapers'),
        app.getPath('pictures'),
        pth.join(app.getPath('videos'), 'Wallpapers'),
      );
    }
    type Wall = { name: string; file: string; kind: 'image' | 'video'; ext: string };
    const out: Wall[] = [];
    const seen = new Set<string>();
    const walk = (d: string, depth: number) => {
      if (depth > 4 || out.length >= 3000) return;
      let ents: import('node:fs').Dirent[];
      try { ents = fsp.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const fp = pth.join(d, e.name);
        if (e.isDirectory()) {
          // Wallpaper Engine 创意工坊作品：目录里有 project.json，挑一个可用文件
          // （视频型用 .mp4/.webm；其余用图或 preview.jpg/gif 作静态兜底）
          const pj = pth.join(fp, 'project.json');
          if (fsp.existsSync(pj)) {
            let title = e.name;
            try { const t = JSON.parse(fsp.readFileSync(pj, 'utf8')); if (t && t.title) title = String(t.title); } catch { /* 坏 json 用目录名 */ }
            let best: Wall | null = null;
            let img: Wall | null = null;
            let imgSize = -1;
            let prev: Wall | null = null;
            try {
              for (const m of fsp.readdirSync(fp, { withFileTypes: true })) {
                if (!m.isFile()) continue;
                const ext = pth.extname(m.name).toLowerCase();
                const full = pth.join(fp, m.name);
                const item: Wall = { name: title, file: full, kind: VID.has(ext) ? 'video' : 'image', ext: ext.slice(1) };
                if (VID.has(ext)) { if (!best) best = item; }
                else if (IMG.has(ext)) {
                  if (/^preview/i.test(m.name)) { if (!prev) prev = item; }
                  else {
                    // 挑**最大**的那张当原图（小图铺满全屏会糊）
                    let sz = 0;
                    try { sz = fsp.statSync(full).size; } catch { /* 读不到就按 0 */ }
                    if (sz > imgSize) { img = item; imgSize = sz; }
                  }
                }
              }
            } catch { /* 读不了就跳过 */ }
            // 子目录再找一层大图：WE 的 web 型作品顶层只有 192x192 的 preview，
            // 真正的素材在子目录里 —— 只取顶层就是「静态壁纸糊」的根因。
            try {
              for (const m of fsp.readdirSync(fp, { withFileTypes: true })) {
                if (!m.isDirectory()) continue;
                const sub = pth.join(fp, m.name);
                for (const n of fsp.readdirSync(sub, { withFileTypes: true })) {
                  if (!n.isFile()) continue;
                  const ext = pth.extname(n.name).toLowerCase();
                  if (!IMG.has(ext) || /^preview/i.test(n.name)) continue;
                  const full = pth.join(sub, n.name);
                  let sz = 0;
                  try { sz = fsp.statSync(full).size; } catch { continue; }
                  if (sz > imgSize) { img = { name: title, file: full, kind: 'image', ext: ext.slice(1) }; imgSize = sz; }
                }
              }
            } catch { /* 读不了就跳过 */ }
            const pick = best ?? img ?? prev;
            if (pick) out.push(pick);
            continue;
          }
          walk(fp, depth + 1); continue;
        }
        const ext = pth.extname(e.name).toLowerCase();
        const kind = IMG.has(ext) ? 'image' : VID.has(ext) ? 'video' : null;
        if (!kind || seen.has(fp)) continue;
        seen.add(fp);
        out.push({ name: e.name.replace(/\.[^.]+$/, ''), file: fp, kind, ext: ext.slice(1) });
      }
    };
    /* 去重 roots，否则同一个目录会被遍历两次、每个作品收录两遍。
       实测（用户真实壁纸库，30 个工坊作品）：
         roots = ["D:\\SteamLibrary\\...\\431960", "D:\\SteamLibrary\\...\\431960"]
         out = 60  unique = 30  dup = 30
       重复项会让 React 的 key={file} 撞成 30 对 → 控制台刷「two children with
       the same key」，界面上同一张壁纸出现两次。
       注意 walk() 里的 seen 只保护「散图」分支，project.json 分支**没有**去重，
       所以必须在入口把 roots 本身去重（同时也修掉大小写/尾斜杠不一致的写法）。 */
    const normRoot = (p: string) => p.replace(/[\\/]+$/, '');
    const rootKey = (p: string) => normRoot(p).toLowerCase();
    const seenRoot = new Set<string>();
    const roots = rootsRaw.filter((r) => {
      const k = rootKey(r);
      if (!k || seenRoot.has(k)) return false;
      seenRoot.add(k);
      return true;
    });
    for (const r of roots) walk(r, 0);
    // 动态排前面、其次静态，同组按名排（给设置页一个稳定顺序）
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'video' ? -1 : 1));
    return out;
  }));
  // 视频壁纸转码：HEVC/H.265 Chromium 解不了 → 转成 H.264 并缓存（一次转、之后秒开）
  ipcMain.handle('meta:wallpaper-transcode', safe(() => {
    const src = String(readSetting('wallpaperImage') ?? '');
    if (!src) throw new Error('没有选中的壁纸');
    const fsp = require('node:fs') as typeof import('node:fs');
    const pth = require('node:path') as typeof import('node:path');
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const ffmpeg = require('ffmpeg-static') as unknown as string;
    const dir = pth.join(app.getPath('userData'), 'wallpaper-cache');
    fsp.mkdirSync(dir, { recursive: true });
    let key = pth.basename(src, pth.extname(src));
    try { key += '-' + Math.floor(fsp.statSync(src).mtimeMs); } catch { /* 文件可能已删 */ }
    const out = pth.join(dir, key + '.mp4');
    if (!fsp.existsSync(out)) {
      // async execFile：同步的 execFileSync 会阻塞主进程、冻住整个应用
      return new Promise<string>((resolve, reject) => {
        execFile(ffmpeg, ['-y', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out],
          { timeout: 600000 }, (err) => (err ? reject(err) : resolve(out)));
      });
    }
    return out;
  }));
  ipcMain.handle(IPC.playerImport, safe((rows: PlayerInput[]) => players.importMany(rows)));
  // 拖拽换位后整批写回「序」
  ipcMain.handle(IPC.playerReorder, safe((playerIds: number[]) => {
    players.reorder(playerIds);
    return true as const;
  }));
  ipcMain.handle(IPC.playerDetail, safe((playerId: number) => dashboard.playerDetail(playerId)));
  ipcMain.handle(IPC.playerExport, safe(() => players.list().map((p): PlayerInput => ({
    gameId: p.gameId,
    name: p.name,
    aliases: p.aliases,
    joinedOrder: p.joinedOrder,
    mic: p.mic,
    noteRole: p.noteRole,
    orangeWeapon: p.orangeWeapon,
    status: p.status,
    remark: p.remark,
  }))));

  // ── 对局与战报（M3） ───────────────────────────────────────────
  ipcMain.handle(IPC.matchList, safe(() => matches.list()));
  ipcMain.handle(IPC.matchGet, safe((id: number) => {
    const m = matches.get(id);
    if (!m) throw new Error(`对局不存在：id=${id}`);
    return m;
  }));
  ipcMain.handle(IPC.matchCreate, safe((input: MatchInput) => {
    const m = matches.create(input);
    // 新建时自动从上一场继承我方阵容，省去手工排表
    const inherited = matches.inheritLineupFromPrevious(m.id);
    return { match: m, inherited };
  }));
  ipcMain.handle(IPC.matchUpdate, safe((id: number, patch: Partial<MatchInput>) => matches.update(id, patch)));
  ipcMain.handle(IPC.matchRemove, safe((id: number) => {
    if (!matches.remove(id)) throw new Error(`对局不存在：id=${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.matchParticipationList, safe((matchId: number) => matches.participations(matchId)));

  /* 沿用另一场的排表（用户口径 2026-09-27）。
     建制（小队）按场次独立存 → 先把源场的小队补到目标场，
     再按「组名 + 组内序号」建立 源队名→目标队名 映射（名字不一定一样），最后复制落位。 */
  ipcMain.handle(IPC.matchCopyLineup, safe((fromMatchId: number, toMatchId: number, overwrite = false) => {
    const srcCat = squads.catalog(fromMatchId);
    let squadsAdded = 0;
    for (const g of srcCat.groups) {
      const want = srcCat.squads.filter((s) => s.groupName === g.name).length;
      for (;;) {
        const cur = squads.catalog(toMatchId).squads.filter((s) => s.groupName === g.name).length;
        if (cur >= want) break;
        squads.appendSquad(toMatchId, g.name);
        squadsAdded += 1;
      }
    }
    const dstCat = squads.catalog(toMatchId);
    const nameMap: Record<string, string> = {};
    for (const s of srcCat.squads) {
      const hit = dstCat.squads.find((d) => d.groupName === s.groupName && d.indexInGroup === s.indexInGroup);
      if (!hit) continue;
      nameMap[s.name] = hit.name;
      if (s.tactic && hit.tactic !== s.tactic) squads.setTactic(toMatchId, hit.name, s.tactic);
    }
    return { ...matches.copyLineup(fromMatchId, toMatchId, overwrite, nameMap), squadsAdded };
  }));
  ipcMain.handle(IPC.matchParticipationUpsert, safe((input: ParticipationInput) => ({
    id: matches.upsertParticipation(input),
  })));
  ipcMain.handle(IPC.matchAssignBulk, safe((input: AssignInput) => ({
    moved: matches.assignBulk(input),
  })));
  ipcMain.handle(IPC.matchUnassign, safe((matchId: number, playerId: number) => {
    matches.unassign(playerId, matchId);
    return true as const;
  }));

  ipcMain.handle(IPC.matchSkillNote, safe((matchId: number, playerId: number, note: string) => {
    if (!matches.setSkillNote(matchId, playerId, note)) {
      throw new Error(`该队员不在本场名单里：playerId=${playerId}`);
    }
    return true as const;
  }));

  // ── 评分（M1） ─────────────────────────────────────────────────
  ipcMain.handle(IPC.matchRunScore, safe((matchId: number, ruleSetId?: number) => {
    const rule = ruleSetId ? rules.get(ruleSetId) : rules.active();
    if (!rule) throw new Error('没有可用的规则集，请先在「权重与规则」里建一套');
    const input = matches.scoreInput(matchId);
    const out = scoreMatch(input, rule);
    matches.saveScores(matchId, rule.id, out);

    const totals = out.lines.map((l) => l.total);
    const stats = totals.length
      ? {
        min: Math.min(...totals),
        max: Math.max(...totals),
        avg: totals.reduce((a, b) => a + b, 0) / totals.length,
        capped: totals.filter((t) => t >= rule.capScore - 1e-9).length,
      }
      : { min: 0, max: 0, avg: 0, capped: 0 };

    return {
      matchId,
      ruleSetId: rule.id,
      ruleSetName: rule.name,
      engine: out.engine,
      scored: out.lines.length,
      stats,
      lines: out.lines.map((l) => ({
        playerName: l.playerName,
        squad: l.squad,
        role: l.role,
        personalScore: l.personalScore,
        teamScore: l.teamScore,
        bonus: l.bonus,
        deathPenalty: l.deathPenalty,
        total: l.total,
        detail: l.detail,
      })),
    };
  }));
  ipcMain.handle(IPC.matchScores, safe((matchId: number, ruleSetId?: number) =>
    matches.savedScores(matchId, ruleSetId)));
  ipcMain.handle(IPC.matchParticipationRemove, safe((id: number) => {
    if (!matches.removeParticipation(id)) throw new Error(`参战记录不存在：id=${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.matchStatSave, safe((participationId: number, stat: Partial<CombatStat>) => {
    matches.saveStat(participationId, stat);
    return true as const;
  }));
  /* 清空战报（用户口径：「战报录入为啥没有清空或者删除又或者更改」）：
     our → 14 项指标归零、参战记录保留；opp → 连对方参战记录一起删。 */
  ipcMain.handle(IPC.matchStatClear, safe((matchId: number, side: 'our' | 'opp' = 'our') => ({
    cleared: matches.clearStats(Number(matchId), side === 'opp' ? 'opp' : 'our'),
  })));
  ipcMain.handle(IPC.matchStatClearRow, safe((participationId: number) => {
    matches.clearStatRow(Number(participationId));
    return true as const;
  }));

  ipcMain.handle(IPC.matchImportPreview, safe(
    (text: string, mode: 'roster' | 'full' = 'roster'): ImportPreview =>
      buildPreview(text, rosterEntries(), knownClassNames(), mode),
  ));

  /* 战报入库。
     opts.opp（用户口径选项 A，2026-09）：
       · 'store'（界面里默认勾选）→ 不在我主档的行**存成对方帮会数据**：
         player 建档并标 is_opp=1、participation 写 side='opp'。不进主档/报名/出勤，
         也不参与评分，只作对比基准。
       · 'skip'  → 这些行直接丢掉。
       · 'block'（IPC 默认）→ 老语义：有对不上的行就整批拦住（旧调用方保持原行为）。
     注意：只有「不在成员主档（NOT_IN_ROSTER）」这一类**error**行能这样走
     （= 严格模式下才成立；完整模式里它只是 warn，语义是自动建档成自己人）。
     数字不对、同一人重复这类硬错误仍然一律拦住 —— 那是真问题。 */
  ipcMain.handle(IPC.matchImportCommit, safe((
    matchId: number, preview: ImportPreview, opts?: { opp?: OppImportMode },
  ) => {
    if (!matches.get(matchId)) throw new Error(`对局不存在：id=${matchId}`);
    const oppMode: OppImportMode = opts?.opp ?? 'block';

    const errRows = preview.rows.filter((r) => r.issues.some((i) => i.level === 'error'));
    if (oppMode === 'block' && errRows.length) {
      throw new Error(`有 ${errRows.length} 行存在错误，已阻止入库；请先修正后再提交`);
    }
    /* ⚠️ UNKNOWN_CLASS 在解析层是 warn 级 ✗，但仓储层写库时会因"职业不在 12 职业表内"抛错 ✓，
       而循环没有事务 → 前面几行已经入库 = 半截数据（审计 2026-09-30）。
       所以这里把它一并当硬错误拦住（与"整批拦住"的语义一致）✓ */
    const hard = errRows.filter((r) =>
      r.issues.some((i) => (i.level === 'error' && i.code !== 'NOT_IN_ROSTER') || i.code === 'UNKNOWN_CLASS'));
    if (hard.length) {
      throw new Error(`有 ${hard.length} 行存在错误，已阻止入库；请先修正后再提交`);
    }

    let written = 0;
    let created = 0;
    let oppWritten = 0;
    let oppCreated = 0;
    let skipped = 0;
    for (const row of preview.rows) {
      /* 判定"这是对方的人"：没匹配到主档，且原因是严格模式的「不在成员主档」错误。
         其它情况（完整模式下预览没给 playerId 等）都按我方走 —— 会自动建档。 */
      const isOpp = row.playerId === null
        && row.issues.some((i) => i.code === 'NOT_IN_ROSTER' && i.level === 'error');
      if (isOpp) {
        if (oppMode !== 'store') { skipped++; continue; }
        const made = players.upsertOpponent(row.gameId || row.name);
        if (made.created) oppCreated++;
        matches.upsertOppParticipation({
          matchId,
          playerId: made.id,
          classUsed: row.classUsed,
          stat: row.stat,
        });
        oppWritten++;
        continue;
      }
      let playerId = row.playerId;
      if (playerId === null) {
        // 完整名单模式：为不在主档的人自动建档
        // （职业不进主档：它只从报名表来，这里只建 ID）
        const made = players.create({
          gameId: row.gameId || row.name,
          name: row.name,
        });
        playerId = made.id;
        created++;
      }
      matches.upsertParticipation({
        matchId,
        playerId,
        classUsed: row.classUsed,
        squad: row.squad,
        stat: row.stat,
      });
      written++;
    }
    return { written, created, oppWritten, oppCreated, skipped };
  }));

  // ── 元数据 ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.metaClasses, safe((): ClassInfo[] => {
    const rows = ctx.db().prepare(
      'SELECT name, aliases, color, icon_file, coef, role FROM class ORDER BY sort_order ASC',
    ).all() as unknown as {
      name: string; aliases: string; color: string;
      icon_file: string | null; coef: number; role: string;
    }[];
    return rows.map((r) => ({
      name: r.name,
      color: r.color,
      coef: Number(r.coef),
      role: r.role as ClassInfo['role'],
      aliases: r.aliases ? r.aliases.split(',').filter(Boolean) : [],
      iconFile: r.icon_file,
    }));
  }));

  ipcMain.handle(IPC.metaSettings, safe(() => {
    const rows = ctx.db().prepare('SELECT key, value FROM app_setting').all() as unknown as {
      key: string; value: string;
    }[];
    const out: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // 全局项以注册表为准（首次迁移时旧的壁纸设置已经搬过去了）
    if (multi()) for (const [k, v] of Object.entries(ctx.guilds?.globalSettings() ?? {})) out[k] = v;
    return out;
  }));

  // 渲染层拼好截图后写进设置；顺手清掉请求标记，避免误触发
  ipcMain.handle(IPC.metaSettingSet, safe((key: string, value: string) => {
    const k = (key ?? '').trim();
    if (!k) throw new Error('设置项 key 不能为空');
    if (k === 'captureRequest') {
      ctx.db().prepare('DELETE FROM app_setting WHERE key = ?').run('capturePng');
    }
    writeSetting(k, String(value ?? ''));
    return true as const;
  }));

  /* ── 战斗组 / 小队建制（**按场次独立**）─────────────────────────
     用户口径：「不同场次的队伍数量啥的彼此独立，而不是改一个另外的
     一样会被改」。所以这一组 IPC 全部以 matchId 为首参 ——
     缺了 matchId 就没法确定改的是哪一场，宁可报错也不要静默改错场。
     按名字（而不是自增 id）定位组与队，与 participation.squad 的文本口径一致。 */
  ipcMain.handle(IPC.metaSquads, safe((matchId: number) => squads.catalog(Number(matchId))));
  ipcMain.handle(IPC.metaGroupCreate, safe((matchId: number, input: GroupInput) =>
    squads.createGroup(Number(matchId), input)));
  ipcMain.handle(IPC.metaGroupRemove, safe((matchId: number, groupName: string) => {
    const changed = squads.removeGroup(Number(matchId), String(groupName ?? ''));
    return { removed: changed } as const;
  }));
  ipcMain.handle(IPC.metaSquadCreate, safe((matchId: number, input: SquadInput) =>
    squads.createSquad(Number(matchId), input)));
  ipcMain.handle(IPC.metaSquadAppend, safe((matchId: number, groupName: string) =>
    squads.appendSquad(Number(matchId), String(groupName ?? ''))));
  ipcMain.handle(IPC.metaSquadTactic, safe((matchId: number, squadName: string, tactic: string) =>
    squads.setTactic(Number(matchId), String(squadName ?? ''), String(tactic ?? ''))));
  ipcMain.handle(IPC.metaSquadRemove, safe((matchId: number, squadName: string) => {
    if (!squads.removeSquad(Number(matchId), String(squadName ?? ''))) {
      throw new Error(`小队不存在：${squadName}（本场）`);
    }
    return true as const;
  }));
  // 每队人数（用户口径：人数也按场次独立）
  ipcMain.handle(IPC.metaSquadSize, safe((matchId: number, squadName: string, size: number) =>
    squads.setSize(Number(matchId), String(squadName ?? ''), Number(size))));

  // ── 截取排表功能区（导出 PNG） ──────────────────────────────────
  // **一次截完，不做分块拼接**。
  //
  // 物理限制：屏幕宽 1707，而功能区完整宽 2636 —— 窗口撑到最大也显示不下，
  // 所以「撑窗口」单独解决不了；而分块拼接试过多轮，接缝处始终有错位
  // （滚动落位、DPI 缩放、布局重排都会引入亚像素误差），已放弃。
  //
  // 最终做法：截图期间临时收起应用外壳（侧栏/顶栏，同时塌掉 .app 的两列
  // 网格，否则留 216px 空列把内容挤成窄条），再把功能区**等比缩小**到刚好
  // 放进窗口，然后一次 capturePage 截完，最后原样还原。
  // 只有一次截图 → 没有接缝 → 不可能错位；内容一个不少，代价是文字等比变小。
  //
  // 需要多大空间由渲染层通过 app_setting.capturePlan 告知（这批 IPC 传不了实参）。


  // 分块截图：矩形由渲染层写进 app_setting.captureRect（这批 IPC 传不了实参）
  ipcMain.handle(IPC.captureRect, safe(async () => {
    const rr = ctx.db().prepare('SELECT value FROM app_setting WHERE key = ?')
      .get('captureRect') as { value: string } | undefined;
    if (!rr?.value) throw new Error('没有待截区域（app_setting.captureRect 为空）');
    ctx.db().prepare('DELETE FROM app_setting WHERE key = ?').run('captureRect');
    const rect = JSON.parse(rr.value) as { x: number; y: number; width: number; height: number };
    if (!(rect.width > 0) || !(rect.height > 0)) throw new Error(`分块区域无效：${rr.value}`);
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw new Error('找不到窗口，无法截图');
    const img = await w.webContents.capturePage({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    });
    return img.toDataURL();
  }));

  // 收下渲染层拼好的 PNG 并存盘（渲染层负责三块截图 + 拼合，理由见 api.ts）
  ipcMain.handle(IPC.captureRegion, safe(async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('找不到窗口，无法截图');
    const row = ctx.db().prepare('SELECT value FROM app_setting WHERE key = ?')
      .get('capturePng') as { value: string } | undefined;
    if (!row?.value) throw new Error('没有截图数据（渲染层未写入 capturePng）');
    ctx.db().prepare('DELETE FROM app_setting WHERE key = ?').run('capturePng');

    const buf = Buffer.from(row.value.replace(/^data:image\/png;base64,/, ''), 'base64');
    const size = nativeImage.createFromBuffer(buf).getSize();
    const defaultName = `排表_${new Date().toISOString().slice(0, 10)}.png`;
    const outDir = process.env.OMNIA_CAPTURE_DIR;
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const out = require('node:path').join(outDir, defaultName);
      fs.writeFileSync(out, buf);
      console.log('[capture] 已写出', out, size.width + 'x' + size.height);
      return { path: out, width: size.width, height: size.height };
    }
    const picked = await dialog.showSaveDialog(win, {
      title: '保存截图', defaultPath: defaultName,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (picked.canceled || !picked.filePath) {
      return { path: null, width: size.width, height: size.height };
    }
    fs.writeFileSync(picked.filePath, buf);
    return { path: picked.filePath, width: size.width, height: size.height };
  }));

  // ── 报名 / 请假 ────────────────────────────────────────────────
  ipcMain.handle(IPC.signupBoard, safe((matchId: number) => signup.board(matchId)));
  ipcMain.handle(IPC.signupSet, safe((input: SignupInput) => signup.set(input)));
  ipcMain.handle(IPC.signupApply, safe((matchId: number, playerIds: number[]) => {
    const applied = signup.apply(matchId, playerIds);
    /* 报名状态/小队改动也会改评分口径 → 置"评分快照过期"（审计 2026-09-30） */
    matches.markStale(matchId);
    return { applied };
  }));

  // 解析报名表 xlsx：只出预览不入库；同时算出「报名有、主档没有」的 ID
  ipcMain.handle(IPC.signupParse, safe((matchId: number, data: Uint8Array) => {
    const grid = readXlsx(Buffer.from(data)) as unknown as string[][];
    const preview = parseSignupGrid(grid);
    const inRoster = new Set(signup.board(matchId).rows.map((r) => r.gameId));
    const unmatched = [...new Set(preview.rows.map((r) => r.gameId).filter((id) => !inRoster.has(id)))];
    return { ...preview, unmatched, matchedCount: preview.rows.length - unmatched.length };
  }));

  ipcMain.handle(IPC.signupImport, safe((matchId: number, rows: SignupImportRow[]) => {
    const res = signup.importSignups(matchId, rows);
    // 记下「报名有、主档没有」的清单，供报名页审查与补建
    const orphans = rows.filter((r) => res.unmatched.includes(r.gameId));
    if (orphans.length) signup.saveOrphans(matchId, orphans);
    return res;
  }));

  ipcMain.handle(IPC.signupReview, safe((matchId: number) => signup.review(matchId)));
  ipcMain.handle(IPC.signupCreateMissing, safe((matchId: number, gameIds: string[]) => (
    signup.createMissing(matchId, gameIds)
  )));

  // ── 评分规则集（M4） ───────────────────────────────────────────
  ipcMain.handle(IPC.rulesList, safe(() => rules.list()));
  ipcMain.handle(IPC.rulesActive, safe(() => rules.active()));
  ipcMain.handle(IPC.rulesDefaults, safe(() => rules.defaults()));
  ipcMain.handle(IPC.rulesCreate, safe((input: RuleSetInput) => rules.create(input)));
  ipcMain.handle(IPC.rulesUpdate, safe((id: number, input: RuleSetInput) => rules.update(id, input)));
  ipcMain.handle(IPC.rulesDuplicate, safe((id: number, name?: string) => rules.duplicate(id, name)));
  ipcMain.handle(IPC.rulesSetActive, safe((id: number) => rules.setActive(id)));
  ipcMain.handle(IPC.rulesRemove, safe((id: number) => {
    if (!rules.remove(id)) throw new Error(`规则集不存在：id=${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.rulesValidate, safe((input: RuleSetInput) => validateRuleSet(input)));

  // ── 数据看板（M6） ─────────────────────────────────────────────
  ipcMain.handle(IPC.dashboardData, safe(() => dashboard.load()));

  // ── xlsx 读表（应用内导入旧表） ─────────────────────────────────
  ipcMain.handle(IPC.metaXlsxSheets, safe((data: Uint8Array) => {
    const buf = Buffer.from(data);
    return { sheets: listSheets(buf) };
  }));

  ipcMain.handle(IPC.metaXlsxGrid, safe((data: Uint8Array, sheet: string | number, headerRow?: number) => {
    const buf = Buffer.from(data);
    const grid = readXlsx(buf, { sheet });
    const header = headerRow && headerRow > 0 ? headerRow : detectHeaderRow(grid);
    const headerCells = (grid[header - 1] ?? []).map((c) => c.trim());
    const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
    const norm = (r: string[]) => {
      const out = r.slice();
      while (out.length < width) out.push('');
      return out;
    };
    const dataStart = header + 1;
    const before = grid.slice(Math.max(0, header - 4), header - 1).map((r, i) => ({
      row: Math.max(1, header - 3) + i, cells: norm(r),
    }));
    const rows = grid.slice(header).map((r, i) => ({ row: dataStart + i, cells: norm(r) }));

    return {
      sheet: typeof sheet === 'string' ? sheet : `#${sheet}`,
      headerRow: header,
      headers: headerCells,
      rows,
      dataStartRow: dataStart,
      previewBeforeHeader: before,
      totalRows: grid.length,
    };
  }));
}
