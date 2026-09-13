/**
 * 预加载脚本：把受控的 API 暴露给渲染层
 * 渲染层拿不到 ipcRenderer / require，只能调用这里白名单里的方法。
 *
 * 全局名：window.omnia
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC, type CombatStat, type ImportPreview, type IpcResult, type JoinMode,
  type MatchInput, type ParticipationInput, type PlayerInput,
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
    export: () => invoke('player:export'),
  },
  meta: {
    classes: () => invoke('meta:classes'),
    settings: () => invoke('meta:settings'),
  },
  match: {
    list: () => invoke('match:list'),
    get: (id: number) => invoke('match:get', id),
    create: (input: MatchInput) => invoke('match:create', input),
    update: (id: number, patch: Partial<MatchInput>) => invoke('match:update', id, patch),
    remove: (id: number) => invoke('match:remove', id),
    participations: (matchId: number) => invoke('match:participation:list', matchId),
    upsertParticipation: (input: ParticipationInput) => invoke('match:participation:upsert', input),
    removeParticipation: (id: number) => invoke('match:participation:remove', id),
    saveStat: (participationId: number, stat: Partial<CombatStat>) =>
      invoke('match:stat:save', participationId, stat),
    importPreview: (text: string, mode: JoinMode = 'roster') =>
      invoke('match:import:preview', text, mode),
    importCommit: (matchId: number, preview: ImportPreview) =>
      invoke('match:import:commit', matchId, preview),
  },
  shell: {
    openExternal: (url: string) => invoke('shell:openExternal', url),
  },
  /** 通道常量透出，便于渲染层调试时核对 */
  channels: IPC,
};

contextBridge.exposeInMainWorld('omnia', api);

export type OmniaPreloadApi = typeof api;
