import type {
  AppInfo, AssignInput, ClassInfo, CombatStat, CombatGroupRow, DashboardData, GroupInput,
  ImportPreview, IpcResult, JoinMode, MatchInput, MatchSummary, OmniaApi, ParticipationInput,
  ParticipationRow, Player, PlayerDetail, PlayerInput, Match, RuleSet, RuleSetInput,
  RuleSetValidation, SavedScore, ScoreRunSummary, Season, SeasonInput, SeasonSummary,
  SheetGrid, SheetList,
  SignupBoard, SignupInput, SignupRow, SquadCatalog, SquadInput, SquadRow,
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
        reorder(playerIds: number[]): Promise<IpcResult<true>>;
        listWallpapers(dir?: string): Promise<IpcResult<WallpaperItem[]>>;
        detail(playerId: number): Promise<IpcResult<PlayerDetail>>;
      };
      meta: {
        classes(): Promise<IpcResult<ClassInfo[]>>;
        settings(): Promise<IpcResult<Record<string, string>>>;
        setSetting(key: string, value: string): Promise<IpcResult<true>>;
        squads(): Promise<IpcResult<SquadCatalog>>;
        createGroup(input: GroupInput): Promise<IpcResult<CombatGroupRow>>;
        removeGroup(id: number): Promise<IpcResult<true>>;
        createSquad(input: SquadInput): Promise<IpcResult<SquadRow>>;
        appendSquad(groupId: number): Promise<IpcResult<SquadRow>>;
        removeSquad(id: number): Promise<IpcResult<true>>;
        setSquadTactic(id: number, tactic: string): Promise<IpcResult<SquadRow>>;
        captureRegion(): Promise<IpcResult<{ path: string | null; width: number; height: number }>>;
        captureRect(): Promise<IpcResult<string>>;
        captureMaxWin(): Promise<IpcResult<{ w: number; h: number }>>;
        captureRestoreWin(): Promise<IpcResult<true>>;
        captureRect(): Promise<IpcResult<string>>;
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
        setSkillNote(matchId: number, playerId: number, note: string): Promise<IpcResult<true>>;
        removeParticipation(id: number): Promise<IpcResult<true>>;
        saveStat(participationId: number, stat: Partial<CombatStat>): Promise<IpcResult<true>>;
        importPreview(text: string, mode?: JoinMode): Promise<IpcResult<ImportPreview>>;
        importCommit(matchId: number, preview: ImportPreview): Promise<IpcResult<{ written: number; created: number }>>;
        runScore(matchId: number, ruleSetId?: number): Promise<IpcResult<ScoreRunSummary>>;
        scores(matchId: number, ruleSetId?: number): Promise<IpcResult<SavedScore[]>>;
      };
      shell: { openExternal(url: string): Promise<IpcResult<true>> };
      dashboard: { data(): Promise<IpcResult<DashboardData>> };
      signup: {
        board(matchId: number): Promise<IpcResult<SignupBoard>>;
        set(input: SignupInput): Promise<IpcResult<SignupRow>>;
        apply(matchId: number, playerIds: number[]): Promise<IpcResult<{ applied: number }>>;
        parseSignup(matchId: number, data: Uint8Array): Promise<IpcResult<SignupImportPreview>>;
        importSignups(matchId: number, rows: SignupImportRow[]):
          Promise<IpcResult<{ imported: number; unmatched: string[] }>>;
        reviewSignups(matchId: number): Promise<IpcResult<SignupReview>>;
        createMissingPlayers(matchId: number, gameIds: string[]):
          Promise<IpcResult<{ created: number; signups: number }>>;
      };
      rules: {
        list(): Promise<IpcResult<RuleSet[]>>;
        active(): Promise<IpcResult<RuleSet | null>>;
        defaults(): Promise<IpcResult<RuleSetInput>>;
        create(input: RuleSetInput): Promise<IpcResult<RuleSet>>;
        update(id: number, input: RuleSetInput): Promise<IpcResult<RuleSet>>;
        duplicate(id: number, name?: string): Promise<IpcResult<RuleSet>>;
        setActive(id: number): Promise<IpcResult<RuleSet>>;
        remove(id: number): Promise<IpcResult<true>>;
        validate(input: RuleSetInput): Promise<IpcResult<RuleSetValidation>>;
      };
      season: {
        list(): Promise<IpcResult<SeasonSummary[]>>;
        active(): Promise<IpcResult<Season>>;
        create(input: SeasonInput): Promise<IpcResult<Season>>;
        update(id: number, patch: Partial<SeasonInput>): Promise<IpcResult<Season>>;
        setActive(id: number): Promise<IpcResult<Season>>;
        remove(id: number): Promise<IpcResult<true>>;
        assignMatches(seasonId: number, matchIds: number[]): Promise<IpcResult<{ moved: number }>>;
      };
      channels: Record<string, string>;
    };
  }
}

export type {
  AppInfo, ClassInfo, Player, PlayerInput, OmniaApi, MatchSummary, Match,
  ParticipationRow, ImportPreview,
};
