/**
 * 预加载脚本：把受控的 API 暴露给渲染层
 * 渲染层拿不到 ipcRenderer / require，只能调用这里白名单里的方法。
 *
 * 全局名：window.omnia
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC, type AssignInput, type CombatStat, type GroupInput, type ImportPreview, type IpcResult,
  type JoinMode, type MatchInput, type ParticipationInput, type PlayerInput, type RuleSetInput,
  type SeasonInput, type SignupInput, type SquadInput,
} from '../shared/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
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
    export: () => invoke('player:export'),
    detail: (playerId: number) => invoke('player:detail', playerId),
  },
  meta: {
    classes: () => invoke('meta:classes'),
    settings: () => invoke('meta:settings'),
    setSetting: (key: string, value: string) => invoke('meta:setting:set', key, value),
    squads: () => invoke('meta:squads'),
    createGroup: (input: GroupInput) => invoke('meta:group:create', input),
    removeGroup: (id: number) => invoke('meta:group:remove', id),
    createSquad: (input: SquadInput) => invoke('meta:squad:create', input),
    appendSquad: (groupId: number) => invoke('meta:squad:append', groupId),
    removeSquad: (id: number) => invoke('meta:squad:remove', id),
    setSquadTactic: (id: number, tactic: string) => invoke('meta:squad:tactic', id, tactic),
    /**
     * 截取排表功能区（完整）。
     * 参数一律**不走 IPC**：要截的矩形先写进 app_setting.captureRect，
     * 这里只做无参触发，主进程读库取矩形 —— 这条 IPC 通道的实参传不过去
     * （多参只到第一个、单参也丢，实测多次），所以只能用「触发」语义。
     */
    captureRegion: () => invoke('app:capture-region'),
    captureRect: () => invoke('app:capture-rect'),
    captureMaxWin: () => invoke('app:capture-maxwin'),
    captureRestoreWin: () => invoke('app:capture-restorewin'),
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
    setSkillNote: (matchId: number, playerId: number, note: string) =>
      invoke('match:skill:note', matchId, playerId, note),
    removeParticipation: (id: number) => invoke('match:participation:remove', id),
    saveStat: (participationId: number, stat: Partial<CombatStat>) =>
      invoke('match:stat:save', participationId, stat),
    importPreview: (text: string, mode: JoinMode = 'roster') =>
      invoke('match:import:preview', text, mode),
    importCommit: (matchId: number, preview: ImportPreview) =>
      invoke('match:import:commit', matchId, preview),
    runScore: (matchId: number, ruleSetId?: number) => invoke('match:score:run', matchId, ruleSetId),
    scores: (matchId: number, ruleSetId?: number) => invoke('match:score:list', matchId, ruleSetId),
  },
  shell: {
    openExternal: (url: string) => invoke('shell:openExternal', url),
  },
  dashboard: {
    data: () => invoke('dashboard:data'),
  },
  signup: {
    board: (matchId: number) => invoke('signup:board', matchId),
    set: (input: SignupInput) => invoke('signup:set', input),
    apply: (matchId: number, playerIds: number[]) => invoke('signup:apply', matchId, playerIds),
    parseSignup: (matchId: number, data: Uint8Array) => invoke('signup:parse', matchId, data),
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
  season: {
    list: () => invoke('season:list'),
    active: () => invoke('season:active'),
    create: (input: SeasonInput) => invoke('season:create', input),
    update: (id: number, patch: Partial<SeasonInput>) => invoke('season:update', id, patch),
    setActive: (id: number) => invoke('season:setActive', id),
    remove: (id: number) => invoke('season:remove', id),
    assignMatches: (seasonId: number, matchIds: number[]) => invoke('season:assignMatches', seasonId, matchIds),
  },
  /** 通道常量透出，便于渲染层调试时核对 */
  channels: IPC,
};

contextBridge.exposeInMainWorld('omnia', api);

export type OmniaPreloadApi = typeof api;
