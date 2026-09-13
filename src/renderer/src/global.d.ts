import type {
  AppInfo, ClassInfo, CombatStat, ImportPreview, IpcResult, JoinMode,
  MatchInput, MatchSummary, OmniaApi, ParticipationInput, ParticipationRow,
  Player, PlayerInput, Match,
} from '@shared/types';

declare global {
  interface Window {
    /** 预加载脚本注入的桥（见 src/preload/preload.ts） */
    omnia: {
      app: { info(): Promise<IpcResult<AppInfo>> };
      player: {
        list(): Promise<IpcResult<Player[]>>;
        create(input: PlayerInput): Promise<IpcResult<Player>>;
        update(id: number, patch: Partial<PlayerInput>): Promise<IpcResult<Player>>;
        remove(id: number): Promise<IpcResult<true>>;
        import(rows: PlayerInput[]): Promise<IpcResult<{ inserted: number; updated: number; skipped: number; errors: string[] }>>;
        export(): Promise<IpcResult<PlayerInput[]>>;
      };
      meta: {
        classes(): Promise<IpcResult<ClassInfo[]>>;
        settings(): Promise<IpcResult<Record<string, string>>>;
      };
      match: {
        list(): Promise<IpcResult<MatchSummary[]>>;
        get(id: number): Promise<IpcResult<Match>>;
        create(input: MatchInput): Promise<IpcResult<{ match: Match; inherited: number }>>;
        update(id: number, patch: Partial<MatchInput>): Promise<IpcResult<Match>>;
        remove(id: number): Promise<IpcResult<true>>;
        participations(matchId: number): Promise<IpcResult<ParticipationRow[]>>;
        upsertParticipation(input: ParticipationInput): Promise<IpcResult<{ id: number }>>;
        removeParticipation(id: number): Promise<IpcResult<true>>;
        saveStat(participationId: number, stat: Partial<CombatStat>): Promise<IpcResult<true>>;
        importPreview(text: string, mode?: JoinMode): Promise<IpcResult<ImportPreview>>;
        importCommit(matchId: number, preview: ImportPreview): Promise<IpcResult<{ written: number; created: number }>>;
      };
      shell: { openExternal(url: string): Promise<IpcResult<true>> };
      channels: Record<string, string>;
    };
  }
}

export type {
  AppInfo, ClassInfo, Player, PlayerInput, OmniaApi, MatchSummary, Match,
  ParticipationRow, ImportPreview,
};
