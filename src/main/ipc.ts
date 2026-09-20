/**
 * IPC 注册：主进程唯一的对外契约入口
 * 所有处理函数都返回 IpcResult<T>，异常被捕获并转成 { ok:false, error }，
 * 避免 IPC 序列化丢失堆栈。
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import { IPC, type AppInfo, type ClassInfo, type IpcResult, type PlayerInput } from '../shared/types';
import type {
  MatchInput, ParticipationInput, AssignInput, CombatStat, ImportPreview, GroupInput,
  RuleSetInput, SeasonInput, SignupInput, SquadInput,
} from '../shared/types';
import { buildPreview, type RosterEntry } from '../shared/statImport';
import { detectHeaderRow, listSheets, readXlsx } from './xlsx';
import type { DbHandle } from './db';
import { PlayerRepo } from './repositories/playerRepo';
import { MatchRepo } from './repositories/matchRepo';
import { SquadRepo } from './repositories/squadRepo';
import { DashboardRepo } from './repositories/dashboardRepo';
import { SignupRepo } from './repositories/signupRepo';
import { RuleSetRepo, validate as validateRuleSet } from './repositories/ruleSetRepo';
import { scoreMatch } from '../shared/scoreEngine';
import { SeasonRepo } from './repositories/seasonRepo';

export interface IpcContext {
  handle: DbHandle;
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
  const players = new PlayerRepo(ctx.handle.db);
  const matches = new MatchRepo(ctx.handle.db);
  const squads = new SquadRepo(ctx.handle.db);
  const dashboard = new DashboardRepo(ctx.handle.db);
  const signup = new SignupRepo(ctx.handle.db);
  const rules = new RuleSetRepo(ctx.handle.db);
  const seasons = new SeasonRepo(ctx.handle.db);

  const rosterEntries = (): RosterEntry[] =>
    (ctx.handle.db.prepare('SELECT id, game_id, name, main_class FROM player')
      .all() as unknown as { id: number; game_id: string; name: string; main_class: string }[])
      .map((r) => ({ id: r.id, gameId: r.game_id, name: r.name, mainClass: r.main_class }));

  const knownClassNames = (): string[] =>
    (ctx.handle.db.prepare('SELECT name FROM class').all() as unknown as { name: string }[])
      .map((r) => r.name);

  ipcMain.handle(IPC.appInfo, safe((): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
    dbPath: ctx.handle.file,
    platform: `${process.platform} ${process.arch}`,
    schemaVersion: Number((ctx.handle.db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration',
    ).get() as { v: number }).v),
  })));

  // ── 成员主档 ───────────────────────────────────────────────────
  ipcMain.handle(IPC.playerList, safe(() => players.list()));
  ipcMain.handle(IPC.playerCreate, safe((input: PlayerInput) => players.create(input)));
  ipcMain.handle(IPC.playerUpdate, safe((id: number, patch: Partial<PlayerInput>) => players.update(id, patch)));
  ipcMain.handle(IPC.playerRemove, safe((id: number) => {
    if (!players.remove(id)) throw new Error(`成员不存在：id=${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.playerImport, safe((rows: PlayerInput[]) => players.importMany(rows)));
  ipcMain.handle(IPC.playerDetail, safe((playerId: number) => dashboard.playerDetail(playerId)));
  ipcMain.handle(IPC.playerExport, safe(() => players.list().map((p): PlayerInput => ({
    gameId: p.gameId,
    name: p.name,
    joinedOrder: p.joinedOrder,
    mic: p.mic,
    noteRole: p.noteRole,
    mainClass: p.mainClass,
    subClass: p.subClass,
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

  ipcMain.handle(IPC.matchImportPreview, safe(
    (text: string, mode: 'roster' | 'full' = 'roster'): ImportPreview =>
      buildPreview(text, rosterEntries(), knownClassNames(), mode),
  ));

  ipcMain.handle(IPC.matchImportCommit, safe((matchId: number, preview: ImportPreview) => {
    if (!matches.get(matchId)) throw new Error(`对局不存在：id=${matchId}`);

    const blocked = preview.rows.filter((r) => r.issues.some((i) => i.level === 'error'));
    if (blocked.length) {
      throw new Error(`有 ${blocked.length} 行存在错误，已阻止入库；请先修正后再提交`);
    }

    let written = 0;
    let created = 0;
    for (const row of preview.rows) {
      let playerId = row.playerId;
      if (playerId === null) {
        // 完整名单模式：为不在主档的人自动建档（主职业取行内职业）
        const made = players.create({
          gameId: row.gameId || row.name,
          name: row.name,
          mainClass: row.classUsed,
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
    return { written, created };
  }));

  // ── 元数据 ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.metaClasses, safe((): ClassInfo[] => {
    const rows = ctx.handle.db.prepare(
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
    const rows = ctx.handle.db.prepare('SELECT key, value FROM app_setting').all() as unknown as {
      key: string; value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }));

  // 渲染层拼好截图后写进设置；顺手清掉请求标记，避免误触发
  ipcMain.handle(IPC.metaSettingSet, safe((key: string, value: string) => {
    const k = (key ?? '').trim();
    if (!k) throw new Error('设置项 key 不能为空');
    if (k === 'captureRequest') {
      ctx.handle.db.prepare('DELETE FROM app_setting WHERE key = ?').run('capturePng');
    }
    ctx.handle.db.prepare(
      `INSERT INTO app_setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(k, String(value ?? ''));
    return true as const;
  }));

  // ── 战斗组 / 小队建制（可新增） ─────────────────────────────────
  ipcMain.handle(IPC.metaSquads, safe(() => squads.catalog()));
  ipcMain.handle(IPC.metaGroupCreate, safe((input: GroupInput) => squads.createGroup(input)));
  ipcMain.handle(IPC.metaGroupRemove, safe((id: number) => {
    if (!squads.removeGroup(id)) throw new Error(`战斗组不存在：id=${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.metaSquadCreate, safe((input: SquadInput) => squads.createSquad(input)));
  ipcMain.handle(IPC.metaSquadAppend, safe((groupId: number) => squads.appendSquad(groupId)));
  ipcMain.handle(IPC.metaSquadTactic, safe((...a: unknown[]) => {
    console.log('[tactic] 实收参数个数=', a.length, ' a=', JSON.stringify(a));
    const id = Number(a[0]);
    const tactic = String(a[1] ?? '');
    return squads.setTactic(id, tactic);
  }));
  ipcMain.handle(IPC.metaSquadRemove, safe((id: number) => {
    if (!squads.removeSquad(id)) throw new Error(`小队不存在：id=${id}`);
    return true as const;
  }));

  // ── 截取排表功能区（导出 PNG） ──────────────────────────────────
  // 分工：渲染层做「滚动分块 + canvas 拼合」（它才有 DOM 与画布），
  // 主进程只提供两件事：把窗口撑到屏幕允许的最大尺寸（拿到最大可见区域），
  // 以及按渲染层给的矩形逐块截图。
  //
  // 走过的弯路（都实测失败，记下来免得重走）：
  //  - 直接截 .board：capturePage 只截**可见**区域 → 右半区/下方各队丢失；
  //  - 只撑窗口不拼接：功能区的完整高度超过屏幕可用高度，仍然截不全；
  //  - 隐藏侧栏改 grid-template-columns：网格塌掉（内容被挤成 355px 宽）；
  //  - 分块时用 scroll 后的 getBoundingClientRect() 现算每块尺寸：
  //    看板自身在横向滚动，滚动后 rect 会跑，裁剪尺寸算错 → 错位/重复。
  //    改为**几何只量一次**，分块尺寸固定，位置只用 scrollLeft 推算。
  let maxWinSaved: Electron.Rectangle | null = null;
  const CAPTURE_RECT_KEY = 'captureRect';
  const CAPTURE_PNG_KEY = 'capturePng';

  /** 把窗口临时撑到屏幕允许的最大尺寸，让可见区域尽可能大；返回是否成功 */
  ipcMain.handle(IPC.captureMaxWin, safe(async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('找不到窗口');
    if (maxWinSaved) return { w: win.getContentSize()[0], h: win.getContentSize()[1] };
    const prev = win.getBounds();
    const prevContent = win.getContentSize();
    const work = require('electron').screen.getDisplayMatching(prev).workAreaSize;
    win.setBounds({
      x: prev.x, y: prev.y,
      width: Math.round(work.width + (prev.width - prevContent[0])),
      height: Math.round(work.height + (prev.height - prevContent[1])),
    });
    maxWinSaved = prev;
    await new Promise((r) => setTimeout(r, 700));
    const now = win.getContentSize();
    console.log('[capture] 撑到最大窗口 内容区=' + now[0] + 'x' + now[1]);
    return { w: now[0], h: now[1] };
  }));

  /** 还原窗口尺寸 */
  ipcMain.handle(IPC.captureRestoreWin, safe(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && maxWinSaved) win.setBounds(maxWinSaved);
    maxWinSaved = null;
    return true as const;
  }));

  /** 分块截图：矩形先由渲染层写进设置（这条 IPC 传不了实参） */
  ipcMain.handle(IPC.captureRect, safe(async () => {
    const row = ctx.handle.db.prepare('SELECT value FROM app_setting WHERE key = ?')
      .get(CAPTURE_RECT_KEY) as { value: string } | undefined;
    if (!row?.value) throw new Error('没有待截区域');
    ctx.handle.db.prepare('DELETE FROM app_setting WHERE key = ?').run(CAPTURE_RECT_KEY);
    const rect = JSON.parse(row.value) as { x: number; y: number; width: number; height: number };
    if (!(rect.width > 0) || !(rect.height > 0)) throw new Error('待截区域无效');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('找不到窗口');
    const img = await win.webContents.capturePage({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    });
    return img.toDataURL();
  }));

  /** 收下渲染层拼好的 PNG 并存盘 */
  ipcMain.handle(IPC.captureRegion, safe(async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('找不到窗口');
    const row = ctx.handle.db.prepare('SELECT value FROM app_setting WHERE key = ?')
      .get(CAPTURE_PNG_KEY) as { value: string } | undefined;
    if (!row?.value) throw new Error('没有截图数据（渲染层未写入 capturePng）');
    ctx.handle.db.prepare('DELETE FROM app_setting WHERE key = ?').run(CAPTURE_PNG_KEY);
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
  ipcMain.handle(IPC.signupApply, safe((matchId: number, playerIds: number[]) => ({
    applied: signup.apply(matchId, playerIds),
  })));

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

  // ── 赛季 ───────────────────────────────────────────────────────
  ipcMain.handle(IPC.seasonList, safe(() => seasons.summaries()));
  ipcMain.handle(IPC.seasonActive, safe(() => seasons.active()));
  ipcMain.handle(IPC.seasonCreate, safe((input: SeasonInput) => seasons.create(input)));
  ipcMain.handle(IPC.seasonUpdate, safe((id: number, patch: Partial<SeasonInput>) => seasons.update(id, patch)));
  ipcMain.handle(IPC.seasonSetActive, safe((id: number) => seasons.setActive(id)));
  ipcMain.handle(IPC.seasonRemove, safe((id: number) => {
    if (!seasons.remove(id)) throw new Error(`赛季不存在：id=${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.seasonAssignMatches, safe((seasonId: number, matchIds: number[]) => ({
    moved: seasons.assignMatches(seasonId, matchIds),
  })));

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

  // 外部链接走系统浏览器，而不是在应用内开窗
  ipcMain.handle('shell:openExternal', safe((url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
    void shell.openExternal(url);
    return true as const;
  }));
}
