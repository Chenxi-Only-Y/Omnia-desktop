/**
 * IPC 注册：主进程唯一的对外契约入口
 * 所有处理函数都返回 IpcResult<T>，异常被捕获并转成 { ok:false, error }，
 * 避免 IPC 序列化丢失堆栈。
 */
import { app, ipcMain, shell } from 'electron';
import { IPC, type AppInfo, type ClassInfo, type IpcResult, type PlayerInput } from '../shared/types';
import type { MatchInput, ParticipationInput, CombatStat, ImportPreview, GroupInput, SquadInput } from '../shared/types';
import { buildPreview, type RosterEntry } from '../shared/statImport';
import type { DbHandle } from './db';
import { PlayerRepo } from './repositories/playerRepo';
import { MatchRepo } from './repositories/matchRepo';
import { SquadRepo } from './repositories/squadRepo';
import { DashboardRepo } from './repositories/dashboardRepo';

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

  // ── 战斗组 / 小队建制（可新增） ─────────────────────────────────
  ipcMain.handle(IPC.metaSquads, safe(() => squads.catalog()));
  ipcMain.handle(IPC.metaGroupCreate, safe((input: GroupInput) => squads.createGroup(input)));
  ipcMain.handle(IPC.metaGroupRemove, safe((id: number) => {
    if (!squads.removeGroup(id)) throw new Error(`战斗组不存在：id=${id}`);
    return true as const;
  }));
  ipcMain.handle(IPC.metaSquadCreate, safe((input: SquadInput) => squads.createSquad(input)));
  ipcMain.handle(IPC.metaSquadRemove, safe((id: number) => {
    if (!squads.removeSquad(id)) throw new Error(`小队不存在：id=${id}`);
    return true as const;
  }));

  // ── 数据看板（M6） ─────────────────────────────────────────────
  ipcMain.handle(IPC.dashboardData, safe(() => dashboard.load()));

  // 外部链接走系统浏览器，而不是在应用内开窗
  ipcMain.handle('shell:openExternal', safe((url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
    void shell.openExternal(url);
    return true as const;
  }));
}
