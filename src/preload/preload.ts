/**
 * 预加载脚本：把受控的 API 暴露给渲染层
 * 渲染层拿不到 ipcRenderer / require，只能调用这里白名单里的方法。
 *
 * 全局名：window.omnia
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  type AssignInput, type CombatStat, type GroupInput, type ImportPreview, type IpcResult,
  type JoinMode, type MatchInput, type OmniaApi, type OppImportMode, type ParticipationInput,
  type PlayerInput, type RuleSetInput,
  type SignupInput, type SquadInput,
} from '../shared/types';

/**
 * 调用主进程的 IPC 通道。
 *
 * 为什么默认类型实参是 `never`：不加时 TS 推成 `unknown`，于是下面 `satisfies OmniaApi`
 * 处处不匹配（`unknown` 不能赋给 `AppInfo`）。用 `never` 当默认值，未显式指定的调用
 * 仍能通过契约校验 —— 代价是**返回值类型没有真正被校验**，这里实际校验的是
 * 「方法有没有漏、名字对不对、参数个数与类型是否与 OmniaApi 一致」。
 * 想连返回值一起校验，就给每处调用补上 `invoke<AppInfo>('app:info')` 这样的类型实参。
 */
function invoke<T = never>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>;
}

const api = {
  app: {
    info: () => invoke('app:info'),
  },
  player: {
    list: () => invoke('player:list'),
    create: (input: PlayerInput) => invoke('player:create', input),
    update: (id: number, patch: Partial<PlayerInput>) => invoke('player:update', id, patch),
    remove: (id: number) => invoke('player:remove', id),
    import: (rows: PlayerInput[]) => invoke('player:import', rows),
    reorder: (playerIds: number[]) => invoke('player:reorder', playerIds),
    listWallpapers: (dir?: string) => invoke('meta:list-wallpapers', dir),
    wallpaperTranscode: () => invoke('meta:wallpaper-transcode'),
    export: () => invoke('player:export'),
    detail: (playerId: number) => invoke('player:detail', playerId),
    pickBg: () => invoke('player:pick-bg'),
    setBg: (id: number, srcPath: string) => invoke('player:set-bg', id, srcPath),
    clearBg: (id: number) => invoke('player:clear-bg', id),
  },
  meta: {
    classes: () => invoke('meta:classes'),
    settings: () => invoke('meta:settings'),
    setSetting: (key: string, value: string) => invoke('meta:setting:set', key, value),
    /* 建制全部按场次独立：matchId 为首参 */
    squads: (matchId: number) => invoke('meta:squads', matchId),
    createGroup: (matchId: number, input: GroupInput) => invoke('meta:group:create', matchId, input),
    removeGroup: (matchId: number, groupName: string) => invoke('meta:group:remove', matchId, groupName),
    createSquad: (matchId: number, input: SquadInput) => invoke('meta:squad:create', matchId, input),
    appendSquad: (matchId: number, groupName: string) => invoke('meta:squad:append', matchId, groupName),
    removeSquad: (matchId: number, squadName: string) => invoke('meta:squad:remove', matchId, squadName),
    setSquadTactic: (matchId: number, squadName: string, tactic: string) =>
      invoke('meta:squad:tactic', matchId, squadName, tactic),
    setSquadSize: (matchId: number, squadName: string, size: number) =>
      invoke('meta:squad:size', matchId, squadName, size),
    /**
     * 截取排表功能区（完整）。
     * 参数一律**不走 IPC**：要截的矩形先写进 app_setting.captureRect，
     * 这里只做无参触发，主进程读库取矩形 —— 这条 IPC 通道的实参传不过去
     * （多参只到第一个、单参也丢，实测多次），所以只能用「触发」语义。
     */
    captureRegion: () => invoke('app:capture-region'),
    captureRect: () => invoke('app:capture-rect'),
    xlsxSheets: (data: Uint8Array) => invoke('meta:xlsx:sheets', data),
    xlsxGrid: (data: Uint8Array, sheet: string | number, headerRow?: number) =>
      invoke('meta:xlsx:grid', data, sheet, headerRow),
  },
  match: {
    list: () => invoke('match:list'),
    get: (id: number) => invoke('match:get', id),
    create: (input: MatchInput) => invoke('match:create', input),
    update: (id: number, patch: Partial<MatchInput>) => invoke('match:update', id, patch),
    remove: (id: number) => invoke('match:remove', id),
    participations: (matchId: number) => invoke('match:participation:list', matchId),
    upsertParticipation: (input: ParticipationInput) => invoke('match:participation:upsert', input),
    assignBulk: (input: AssignInput) => invoke('match:assign:bulk', input),
    unassign: (matchId: number, playerId: number) => invoke('match:unassign', matchId, playerId),
    copyLineup: (fromMatchId: number, toMatchId: number, overwrite?: boolean) =>
      invoke('match:copy-lineup', fromMatchId, toMatchId, overwrite),
    setSkillNote: (matchId: number, playerId: number, note: string) =>
      invoke('match:skill:note', matchId, playerId, note),
    removeParticipation: (id: number) => invoke('match:participation:remove', id),
    saveStat: (participationId: number, stat: Partial<CombatStat>) =>
      invoke('match:stat:save', participationId, stat),
    clearStats: (matchId: number, side: 'our' | 'opp' = 'our') =>
      invoke('match:stat:clear', matchId, side),
    clearStatRow: (participationId: number) => invoke('match:stat:clear-row', participationId),
    importPreview: (text: string, mode: JoinMode = 'roster') =>
      invoke('match:import:preview', text, mode),
    importCommit: (matchId: number, preview: ImportPreview, opts?: { opp?: OppImportMode }) =>
      invoke('match:import:commit', matchId, preview, opts),
    runScore: (matchId: number, ruleSetId?: number) => invoke('match:score:run', matchId, ruleSetId),
    scores: (matchId: number, ruleSetId?: number) => invoke('match:score:list', matchId, ruleSetId),
  },
  dashboard: {
    data: () => invoke('dashboard:data'),
  },
  signup: {
    board: (matchId: number) => invoke('signup:board', matchId),
    set: (input: SignupInput) => invoke('signup:set', input),
    apply: (matchId: number, playerIds: number[]) => invoke('signup:apply', matchId, playerIds),
    parseSignup: (matchId: number, data: Uint8Array) => invoke('signup:parse', matchId, data),
    parseSignupText: (matchId: number, text: string) => invoke('signup:parse-text', matchId, text),
    importSignups: (matchId: number, rows: unknown) => invoke('signup:import', matchId, rows),
    reviewSignups: (matchId: number) => invoke('signup:review', matchId),
    createMissingPlayers: (matchId: number, gameIds: string[]) =>
      invoke('signup:create-missing', matchId, gameIds),
  },
  rules: {
    list: () => invoke('rules:list'),
    active: () => invoke('rules:active'),
    defaults: () => invoke('rules:defaults'),
    create: (input: RuleSetInput) => invoke('rules:create', input),
    update: (id: number, input: RuleSetInput) => invoke('rules:update', id, input),
    duplicate: (id: number, name?: string) => invoke('rules:duplicate', id, name),
    setActive: (id: number) => invoke('rules:setActive', id),
    remove: (id: number) => invoke('rules:remove', id),
    validate: (input: RuleSetInput) => invoke('rules:validate', input),
  },
  /** 帮会（一帮会一个库文件）；open 会切换当前库，之后其它接口都读写这个帮会的数据 */
  guild: {
    list: () => invoke('guild:list'),
    active: () => invoke('guild:active'),
    create: (name: string, note?: string) => invoke('guild:create', name, note),
    open: (id: string) => invoke('guild:open', id),
    update: (id: string, patch: { name?: string; note?: string }) => invoke('guild:update', id, patch),
    remove: (id: string) => invoke('guild:remove', id),
    setCover: (id: string, srcPath: string) => invoke('guild:set-cover', id, srcPath),
    pickCover: () => invoke('guild:pick-cover'),
  },
};

/* satisfies 而不是注解：签名以 types.ts 的 OmniaApi 为准，
   一旦实现与契约不一致（少一个方法、返回类型变了），类型检查当场报错 ——
   这正是当初"手抄契约悄悄漂移"没被发现的原因。 */
contextBridge.exposeInMainWorld('omnia', api satisfies OmniaApi);

