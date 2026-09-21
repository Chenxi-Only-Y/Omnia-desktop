/**
 * 渲染层 API 包装：统一解包 IpcResult，把 { ok:false } 转成异常，
 * 这样调用方可以用普通的 try/catch，而不用每处判断 ok。
 */
import type {
  AppInfo, AssignInput, ClassInfo, CombatGroupRow, CombatStat, DashboardData, GroupInput,
  ImportPreview, IpcResult, JoinMode, Match, MatchInput, MatchSummary, ParticipationInput,
  ParticipationRow, Player, PlayerDetail, PlayerInput, RuleSet, RuleSetInput, RuleSetValidation,
  SavedScore, ScoreRunSummary, Season, SeasonInput, SeasonSummary, SheetGrid, SheetList,
  SignupBoard, SignupInput, SignupRow, SquadCatalog, SquadInput, SquadRow,
} from '@shared/types';

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const res = await p;
  if (!res || typeof res !== 'object') throw new ApiError('IPC 返回为空（主进程可能未就绪）');
  if (!res.ok) throw new ApiError(res.error);
  return res.data;
}

const bridge = () => {
  if (!window.omnia) {
    throw new ApiError('预加载桥未注入（window.omnia 不存在）。请确认 preload 路径正确。');
  }
  return window.omnia;
};

export const api = {
  appInfo: (): Promise<AppInfo> => unwrap(bridge().app.info()),

  meta: {
    classes: (): Promise<ClassInfo[]> => unwrap(bridge().meta.classes()),
    settings: (): Promise<Record<string, string>> => unwrap(bridge().meta.settings()),
    setSetting: (key: string, value: string): Promise<true> => unwrap(bridge().meta.setSetting(key, value)),
    /** 战斗组 / 小队建制（数据驱动，可新增） */
    squads: (): Promise<SquadCatalog> => unwrap(bridge().meta.squads()),
    createGroup: (input: GroupInput): Promise<CombatGroupRow> => unwrap(bridge().meta.createGroup(input)),
    removeGroup: (id: number): Promise<true> => unwrap(bridge().meta.removeGroup(id)),
    createSquad: (input: SquadInput): Promise<SquadRow> => unwrap(bridge().meta.createSquad(input)),
    appendSquad: (groupId: number): Promise<SquadRow> => unwrap(bridge().meta.appendSquad(groupId)),
    removeSquad: (id: number): Promise<true> => unwrap(bridge().meta.removeSquad(id)),
    setSquadTactic: (id: number, tactic: string): Promise<SquadRow> =>
      unwrap(bridge().meta.setSquadTactic(id, tactic)),
    /**
     * 截取排表功能区，**完整**（含右半区与下半部分），存成 PNG。
     *
     * 核心思路：**一次截完，不做分块拼接**。
     * 分块拼接试过多轮，接缝处始终有错位 —— 滚动落位、DPI 缩放、布局重排
     * 都会引入亚像素误差，用户实测反馈"还是错位的"，所以放弃拼接。
     *
     * 现在改成：截图期间由主进程把应用外壳（侧栏/顶栏）临时收起来，让功能区
     * 独占窗口，并把窗口撑到屏幕最大，使完整内容全部进入可见区域，一次
     * capturePage 截完 —— 没有接缝，也就不可能错位；之后原样还原。
     * （早前"隐藏侧栏"失败是因为只隐藏 <aside> 而没塌掉 .app 的两列网格，
     *   留下 216px 空列把内容挤成 355px 宽，原因已在主进程里一并处理。）
     */
    captureBoard: async (): Promise<{ path: string | null; width: number; height: number }> => {
      const board = document.querySelector('.board');
      if (!board) throw new Error('排表功能区还没渲染，无法截图');
      // 只做「已就绪」标记：截取区域由主进程在页面里现量（这批 IPC 传不了实参）
      await api.meta.setSetting('capturePlan', JSON.stringify({ ready: true }));
      return unwrap(bridge().meta.captureRegion());
    },

    xlsxSheets: (data: Uint8Array): Promise<SheetList> => unwrap(bridge().meta.xlsxSheets(data)),
    xlsxGrid: (data: Uint8Array, sheet: string | number, headerRow?: number): Promise<SheetGrid> =>
      unwrap(bridge().meta.xlsxGrid(data, sheet, headerRow)),
  },

  player: {
    list: (): Promise<Player[]> => unwrap(bridge().player.list()),
    create: (input: PlayerInput): Promise<Player> => unwrap(bridge().player.create(input)),
    update: (id: number, patch: Partial<PlayerInput>): Promise<Player> =>
      unwrap(bridge().player.update(id, patch)),
    remove: (id: number): Promise<true> => unwrap(bridge().player.remove(id)),
    import: (rows: PlayerInput[]) => unwrap(bridge().player.import(rows)),
    export: (): Promise<PlayerInput[]> => unwrap(bridge().player.export()),
    detail: (playerId: number): Promise<PlayerDetail> => unwrap(bridge().player.detail(playerId)),
  },

  match: {
    list: (): Promise<MatchSummary[]> => unwrap(bridge().match.list()),
    get: (id: number): Promise<Match> => unwrap(bridge().match.get(id)),
    create: (input: MatchInput) => unwrap(bridge().match.create(input)),
    update: (id: number, patch: Partial<MatchInput>): Promise<Match> =>
      unwrap(bridge().match.update(id, patch)),
    remove: (id: number): Promise<true> => unwrap(bridge().match.remove(id)),
    participations: (matchId: number): Promise<ParticipationRow[]> =>
      unwrap(bridge().match.participations(matchId)),
    upsertParticipation: (input: ParticipationInput) =>
      unwrap(bridge().match.upsertParticipation(input)),
    assignBulk: (input: AssignInput) => unwrap(bridge().match.assignBulk(input)),
    unassign: (matchId: number, playerId: number): Promise<true> =>
      unwrap(bridge().match.unassign(matchId, playerId)),
    setSkillNote: (matchId: number, playerId: number, note: string): Promise<true> =>
      unwrap(bridge().match.setSkillNote(matchId, playerId, note)),
    removeParticipation: (id: number): Promise<true> =>
      unwrap(bridge().match.removeParticipation(id)),
    saveStat: (participationId: number, stat: Partial<CombatStat>): Promise<true> =>
      unwrap(bridge().match.saveStat(participationId, stat)),
    importPreview: (text: string, mode: JoinMode = 'roster'): Promise<ImportPreview> =>
      unwrap(bridge().match.importPreview(text, mode)),
    importCommit: (matchId: number, preview: ImportPreview) =>
      unwrap(bridge().match.importCommit(matchId, preview)),
    runScore: (matchId: number, ruleSetId?: number): Promise<ScoreRunSummary> =>
      unwrap(bridge().match.runScore(matchId, ruleSetId)),
    scores: (matchId: number, ruleSetId?: number): Promise<SavedScore[]> =>
      unwrap(bridge().match.scores(matchId, ruleSetId)),
  },

  dashboard: {
    data: (): Promise<DashboardData> => unwrap(bridge().dashboard.data()),
  },

  signup: {
    board: (matchId: number): Promise<SignupBoard> => unwrap(bridge().signup.board(matchId)),
    set: (input: SignupInput): Promise<SignupRow> => unwrap(bridge().signup.set(input)),
    apply: (matchId: number, playerIds: number[]): Promise<{ applied: number }> =>
      unwrap(bridge().signup.apply(matchId, playerIds)),
  },

  rules: {
    list: (): Promise<RuleSet[]> => unwrap(bridge().rules.list()),
    active: (): Promise<RuleSet | null> => unwrap(bridge().rules.active()),
    defaults: (): Promise<RuleSetInput> => unwrap(bridge().rules.defaults()),
    create: (input: RuleSetInput): Promise<RuleSet> => unwrap(bridge().rules.create(input)),
    update: (id: number, input: RuleSetInput): Promise<RuleSet> => unwrap(bridge().rules.update(id, input)),
    duplicate: (id: number, name?: string): Promise<RuleSet> => unwrap(bridge().rules.duplicate(id, name)),
    setActive: (id: number): Promise<RuleSet> => unwrap(bridge().rules.setActive(id)),
    remove: (id: number): Promise<true> => unwrap(bridge().rules.remove(id)),
    validate: (input: RuleSetInput): Promise<RuleSetValidation> => unwrap(bridge().rules.validate(input)),
  },

  season: {
    list: (): Promise<SeasonSummary[]> => unwrap(bridge().season.list()),
    active: (): Promise<Season> => unwrap(bridge().season.active()),
    create: (input: SeasonInput): Promise<Season> => unwrap(bridge().season.create(input)),
    update: (id: number, patch: Partial<SeasonInput>): Promise<Season> => unwrap(bridge().season.update(id, patch)),
    setActive: (id: number): Promise<Season> => unwrap(bridge().season.setActive(id)),
    remove: (id: number): Promise<true> => unwrap(bridge().season.remove(id)),
    assignMatches: (seasonId: number, matchIds: number[]): Promise<{ moved: number }> =>
      unwrap(bridge().season.assignMatches(seasonId, matchIds)),
  },
};
