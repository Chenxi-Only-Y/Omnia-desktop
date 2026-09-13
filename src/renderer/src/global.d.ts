import type {
  AppInfo, AssignInput, ClassInfo, CombatStat, CombatGroupRow, DashboardData, GroupInput,
  ImportPreview, IpcResult, JoinMode, MatchInput, MatchSummary, OmniaApi, ParticipationInput,
  ParticipationRow, Player, PlayerDetail, PlayerInput, Match, SheetGrid, SheetList,
  SquadCatalog, SquadInput, SquadRow,
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
        detail(playerId: number): Promise<IpcResult<PlayerDetail>>;
      };
      meta: {
        classes(): Promise<IpcResult<ClassInfo[]>>;
        settings(): Promise<IpcResult<Record<string, string>>>;
        squads(): Promise<IpcResult<SquadCatalog>>;
        createGroup(input: GroupInput): Promise<IpcResult<CombatGroupRow>>;
        removeGroup(id: number): Promise<IpcResult<true>>;
        createSquad(input: SquadInput): Promise<IpcResult<SquadRow>>;
        removeSquad(id: number): Promise<IpcResult<true>>;
        xlsxSheets(data: Uint8Array): Promise<IpcResult<SheetList>>;
        xlsxGrid(data: Uint8Array, sheet: string | number, headerRow?: number): Promise<IpcResult<SheetGrid>>;
      };
      match: {
        list(): Promise<IpcResult<MatchSummary[]>>;
        get(id: number): Promise<IpcResult<Match>>;
        create(input: MatchInput): Promise<IpcResult<{ match: Match; inherited: number }>>;
        update(id: number, patch: Partial<MatchInput>): Promise<IpcResult<Match>>;
        remove(id: number): Promise<IpcResult<true>>;
        participations(matchId: number): Promise<IpcResult<ParticipationRow[]>>;
        upsertParticipation(input: ParticipationInput): Promise<IpcResult<{ id: number }>>;
        assignBulk(input: AssignInput): Promise<IpcResult<{ moved: number }>>;
        unassign(matchId: number, playerId: number): Promise<IpcResult<true>>;
        removeParticipation(id: number): Promise<IpcResult<true>>;
        saveStat(participationId: number, stat: Partial<CombatStat>): Promise<IpcResult<true>>;
        importPreview(text: string, mode?: JoinMode): Promise<IpcResult<ImportPreview>>;
        importCommit(matchId: number, preview: ImportPreview): Promise<IpcResult<{ written: number; created: number }>>;
      };
      shell: { openExternal(url: string): Promise<IpcResult<true>> };
      dashboard: { data(): Promise<IpcResult<DashboardData>> };
      channels: Record<string, string>;
    };
  }
}

export type {
  AppInfo, ClassInfo, Player, PlayerInput, OmniaApi, MatchSummary, Match,
  ParticipationRow, ImportPreview,
};
