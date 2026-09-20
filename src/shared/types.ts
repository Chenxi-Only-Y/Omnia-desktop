/**
 * 共享实体类型与 IPC 契约
 * 主进程与渲染进程共用；任何一侧改动都会触发 TypeScript 报错。
 */
import type {
  CombatStat, MatchResult, NoteRole, PartState, Tactic, SquadGroup, RoleKey, GroupKind,
} from './domain';

/**
 * 领域类型统一从 types 出口转发，调用方（主进程 / 预加载 / 渲染层）
 * 只需依赖 `shared/types` 一个模块。
 */
export type { CombatStat, MatchResult, NoteRole, PartState, Tactic, SquadGroup, RoleKey, GroupKind };

// ── 实体 ─────────────────────────────────────────────────────────
export interface Player {
  id: number;
  /** 游戏角色 ID / 角色名（原表「角色ID」），业务主键 */
  gameId: string;
  name: string;
  /** 入帮排序（原表 A 列） */
  joinedOrder: number | null;
  mic: '有' | '无' | '无需作答' | '';
  noteRole: NoteRole;
  mainClass: string;
  subClass: string;
  /** active / inactive / left */
  status: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerInput {
  gameId: string;
  name?: string;
  joinedOrder?: number | null;
  mic?: Player['mic'];
  noteRole?: NoteRole;
  mainClass?: string;
  subClass?: string;
  status?: string;
  remark?: string;
}

export interface Match {
  id: number;
  seasonId: number | null;
  /** ISO 日期 YYYY-MM-DD */
  date: string;
  /** 同日场次号，如 1 / 2 */
  indexInDay: number;
  ourSide: string;
  oppSide: string;
  result: MatchResult;
  ourTowersLeft: number;
  oppTowersLeft: number;
  /** draft / playing / settled */
  state: string;
  ruleSetId: number | null;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface MatchInput {
  date: string;
  indexInDay?: number;
  ourSide?: string;
  oppSide?: string;
  result?: MatchResult;
  ourTowersLeft?: number;
  oppTowersLeft?: number;
  state?: string;
  remark?: string;
}

export interface Participation {
  id: number;
  matchId: number;
  playerId: number;
  playerName: string;
  playerGameId: string;
  classUsed: string;
  role: RoleKey | '';
  squad: string;
  group: SquadGroup | '';
  tactic: Tactic | '';
  noteRole: NoteRole;
  mic: Player['mic'];
  state: PartState;
  stat: CombatStat;
}

export interface ParticipationInput {
  matchId: number;
  playerId: number;
  classUsed?: string;
  squad?: string;
  noteRole?: NoteRole;
  /** 本场技能备注：排表页卡片上直接填的自由文本（每人每场各自一份） */
  skillNote?: string;
  /** 落位槽号（从 0 起；-1 = 未指定）。一般由 assignBulk 的 slotIndex 维护 */
  slotNo?: number;
  state?: PartState;
  stat?: Partial<CombatStat>;
}

/** 一次把多个队员放进指定小队（拖拽落点/多人调整用，单事务） */export interface AssignInput {
  matchId: number;
  playerIds: number[];
  squad: string;
  /** 目标小队已满时是否照常放入（默认 true，超出只是提示） */
  allowOverfill?: boolean;
  /**
   * 指定落位：点哪个空位就放哪个位置（从 0 起）。
   * 该位置已有人时，两人互换 —— 这样"点空位补人"不会总是挤到最左边。
   * 不传则按顺序追加（拖拽落点用）。
   */
  slotIndex?: number;
}

// ── 评分引擎（M1 占位，算法待定） ────────────────────────────────
export interface ScoreBreakdown {
  personalRaw: number;
  personalRatio: number;
  personalScore: number;
  teamScore: number;
  bonus: number;
  deathPenalty: number;
  total: number;
  /** 逐项中间量，用于审计与调试 */
  detail: Record<string, number | string>;
  /** 引擎标识，便于算法迭代后区分历史分数 */
  engine: string;
}

export interface ScoreEngine {
  readonly id: string;
  readonly label: string;
  scoreMatch(matchId: number): ScoreBreakdown[];
}

// ── 对局与战报（M3） ─────────────────────────────────────────────
export interface MatchSummary extends Match {
  /** 我方参战人数（state=PLAY） */
  ourCount: number;
  oppCount: number;
  /** 已录入战报的人数（有任意非零指标或显式保存过） */
  statFilled: number;
}

export interface ParticipationRow {
  id: number;
  matchId: number;
  playerId: number;
  gameId: string;
  name: string;
  side: 'our' | 'opp';
  squad: string;
  group: string;
  tactic: string;
  classUsed: string;
  mainClass: string;
  noteRole: NoteRole;
  /** 本场技能备注（排表页可编辑） */
  skillNote: string;
  /** 落位槽号（从 0 起；-1 = 未指定，按加入顺序排） */
  slotNo: number;
  mic: Player['mic'];
  state: PartState;
  stat: CombatStat;
  /** 战报是否已填写（用于列表里的完成度提示） */
  statFilled: boolean;
}

/** 校验问题的严重级别：error 阻止入库，warn 只提示 */
export type IssueLevel = 'error' | 'warn';

export interface ValidationIssue {
  level: IssueLevel;
  /** 问题分类，便于前端分组与统计 */
  code:
    | 'UNKNOWN_CLASS'
    | 'CLASS_LEVEL_MISMATCH'
    | 'NOT_IN_ROSTER'
    | 'DUPLICATE_IN_MATCH'
    | 'NAME_MISMATCH'
    | 'INVALID_NUMBER'
    | 'NEGATIVE_VALUE'
    | 'DEATH_WITH_ZERO_KILLS'
    | 'HEALER_WITH_KILLS'
    | 'MISSING_CLASS'
    | 'LINEUP_INCOMPLETE';
  /** 行号（从 1 开始，指待导入数据行）；对局级问题为 0 */
  row: number;
  player: string;
  message: string;
}

export interface ImportPreviewRow {
  row: number;
  /** 匹配到的成员主档 ID；未匹配到时为 null（除非允许建档） */
  playerId: number | null;
  gameId: string;
  name: string;
  classUsed: string;
  squad: string;
  stat: CombatStat;
  issues: ValidationIssue[];
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  issues: ValidationIssue[];
  summary: {
    total: number;
    matched: number;
    unmatched: number;
    errors: number;
    warnings: number;
  };
}

export type JoinMode = 'roster' | 'full';

// ── 战斗组 / 小队建制（可新增，运行时以库为准） ──────────────────
export interface CombatGroupRow {
  id: number;
  name: string;
  kind: GroupKind;
  sortOrder: number;
  remark: string;
}

export interface SquadRow {
  id: number;
  groupId: number;
  groupName: string;
  kind: GroupKind;
  indexInGroup: number;
  /** 组名-序号，如 防守二-3 */
  name: string;
  tactic: Tactic | '';
  size: number;
  sortOrder: number;
}

export interface SquadCatalog {
  groups: CombatGroupRow[];
  squads: SquadRow[];
  /** 建制总容量 = Σ 小队人数 */
  capacity: number;
}

export interface GroupInput {
  name: string;
  kind: GroupKind;
  remark?: string;
}

export interface SquadInput {
  groupId: number;
  indexInGroup?: number;
  tactic?: string;
  size?: number;
}

// ── xlsx 导入（应用内直接读旧表） ────────────────────────────────
export interface SheetList {
  sheets: { name: string; index: number }[];
}

export interface SheetGrid {
  sheet: string;
  /** 探测到的表头行（1 基）。旧表常在 5/6 行。 */
  headerRow: number;
  /** 选中的表头行内容（已 trim） */
  headers: string[];
  /** 表头下方的数据行（前 N 行，行号从 1 起） */
  rows: { row: number; cells: string[] }[];
  /** 探测到的数据起始行（1 基） */
  dataStartRow: number;
  /** 表头之前的原始行（用于让用户确认选对了表头） */
  previewBeforeHeader: { row: number; cells: string[] }[];
  totalRows: number;
}
/** 报名/请假模块（M7 旧表这块是 WPS 表单，已失效，这里做本地替代） */
export type SignupStatus = 'JOIN' | 'LEAVE' | 'BENCH' | 'NONE';

export const SIGNUP_LABEL: Record<SignupStatus, string> = {
  JOIN: '参加', LEAVE: '请假', BENCH: '替补', NONE: '未报名',
};

export interface SignupRow {
  playerId: number;
  gameId: string;
  name: string;
  mainClass: string;
  noteRole: string;
  mic: Player['mic'];
  status: Player['status'];
  /** 入帮序，用于排序 */
  joinedOrder: number | null;
  /** 本场报名状态；null = 还没报名 */
  signup: SignupStatus | null;
  /** 报名提交时间 */
  signupAt: string;
  signupRemark: string;
  /** 本场上场名单里的状态（与报名区分：报名是意愿，上场是排表结果） */
  lineupState: PartState | null;
  squad: string;
}

export interface SignupBoard {
  matchId: number;
  rows: SignupRow[];
  stats: SignupStats;
}

export interface SignupStats {
  /** 成员总数（作为应报名基数参考） */
  roster: number;
  joined: number;
  leave: number;
  bench: number;
  none: number;
  /** 在队且未报名的成员（需要提醒的人） */
  pending: number;
}

export interface SignupInput {
  matchId: number;
  playerId: number;
  /** JOIN=参加 / LEAVE=请假 / BENCH=替补 / NONE=清除报名 */
  status: SignupStatus;
  remark?: string;
}

// ── 评分规则集（M4：只做参数管理，算法待定） ─────────────────────
export interface PersonalWeights {
  /** 有效击杀（含清泉） */
  kill?: number;
  dmg?: number;
  tower?: number;
  assist?: number;
  fountain?: number;
  bone?: number;
  heal?: number;
  taken?: number;
  revive?: number;
}

export interface ExecWeights {
  /** 推塔型：对局共享项（塔进度 + 大旗）与小队表现项 */
  push: { progress?: number; flag?: number; tower?: number; kill?: number };
  guard: { kill?: number; taken?: number; lowDeath?: number };
  defend: { keepRate?: number; kill?: number; lowDeath?: number };
}

export interface RuleSetInput {
  name: string;
  baseScore: number;
  capScore: number;
  scaleTeam: number;
  scalePersonal: number;
  deathPen: number;
  totalTowers: number;
  personalWeights: { DPS: PersonalWeights; T: PersonalWeights; HEAL: PersonalWeights };
  execWeights: ExecWeights;
  classCoef: Record<string, number>;
  bonus: Record<string, number>;
}

export interface RuleSet extends RuleSetInput {
  id: number;
  seasonId: number | null;
  version: number;
  active: boolean;
  createdAt: string;
}

export interface RuleSetValidation {
  ok: boolean;
  issues: { level: 'error' | 'warn'; field: string; message: string }[];
}

// ── 赛季 ─────────────────────────────────────────────────────────
export interface Season {
  id: number;
  name: string;
  startedAt: string;
  endedAt: string;
  remark: string;
}

export interface SeasonInput {
  name: string;
  startedAt?: string;
  endedAt?: string;
  remark?: string;
}

export interface SeasonSummary extends Season {
  active: boolean;
  /** 归属该赛季的对局数 */
  matchCount: number;
  /** 归属该赛季的规则集数 */
  ruleSetCount: number;
  firstDate: string;
  lastDate: string;
}

// ── 评分结果 ─────────────────────────────────────────────────────
export interface SavedScore {
  participationId: number;
  playerId: number;
  playerName: string;
  squad: string;
  personalScore: number;
  teamScore: number;
  bonus: number;
  deathPenalty: number;
  total: number;
  engine: string;
  computedAt: string;
}

export interface ScoreRunSummary {
  matchId: number;
  ruleSetId: number;
  ruleSetName: string;
  engine: string;
  /** 被评分的人数 */
  scored: number;
  /** 覆盖率统计，便于判断"这场算全了吗" */
  stats: { min: number; max: number; avg: number; capped: number };
  lines: {
    playerName: string;
    squad: string;
    role: string;
    personalScore: number;
    teamScore: number;
    bonus: number;
    deathPenalty: number;
    total: number;
    detail: Record<string, number | string>;
  }[];
}

// ── 数据看板（M6，先做不依赖评分算法的部分） ─────────────────────
export interface AttendanceRow {
  playerId: number;
  gameId: string;
  name: string;
  mainClass: string;
  noteRole: string;
  status: string;
  /** 有记录的场次数 */
  matches: number;
  plays: number;
  benches: number;
  leaves: number;
  /** 参战次数 / 场次 */
  rate: number;
  /** 已填战报的场次 */
  filled: number;
}

export interface MatchRowStat {
  matchId: number;
  label: string;
  date: string;
  result: string;
  ourSide: string;
  oppSide: string;
  ourCount: number;
  statFilled: number;
}

// ── 成员详情（个人历史，不含评分算法） ───────────────────────────
/** 个人在某一场的汇总（含原表口径的有效值） */
export interface PlayerMatchRow {
  matchId: number;
  date: string;
  indexInDay: number;
  matchLabel: string;
  ourSide: string;
  oppSide: string;
  result: string;
  squad: string;
  tactic: string;
  classUsed: string;
  state: PartState;
  /** 是否有战报 */
  statFilled: boolean;
  /** 原表「击败/清泉」拆开后的合计（= 有效击杀） */
  effKills: number;
  assists: number;
  /** 有效人伤 = 对玩家伤害 + 人伤卸甲 */
  effDmg: number;
  /** 有效塔伤 = 对建筑伤害 + 破塔卸甲 */
  effTower: number;
  healing: number;
  taken: number;
  deaths: number;
  revives: number;
  fountain: number;
  bone: number;
}

/** 六维对比数据：个人 vs 球队人均 */
export interface RadarAxis {
  key: string;
  label: string;
  self: number;
  teamAvg: number;
  /** 归一化后的比例（self/teamAvg，1 表示持平），上限由 UI 处理 */
  ratio: number;
}

export interface PlayerTotals {
  matches: number;
  plays: number;
  benches: number;
  leaves: number;
  statFilled: number;
  effKills: number;
  assists: number;
  effDmg: number;
  effTower: number;
  healing: number;
  taken: number;
  deaths: number;
  revives: number;
}

export interface PlayerDetail {
  player: Player;
  totals: PlayerTotals;
  /** 按日期倒序 */
  matches: PlayerMatchRow[];
  /** 六维雷达（仅在本人与球队都有数据时有意义） */
  radar: RadarAxis[];
  /** 球队基准：所有我方上场记录的人均值 */
  teamAverage: {
    effKills: number; assists: number; effDmg: number;
    effTower: number; healing: number; taken: number; deaths: number;
  };
}

export interface DashboardData {
  totals: {
    matches: number;
    players: number;
    participations: number;
    statFilled: number;
    statSlots: number;
    statRate: number;
    avgLineup: number;
  };
  matches: MatchRowStat[];
  attendance: AttendanceRow[];
  classPlayCount: { name: string; color: string; plays: number }[];
  squadUsage: { squad: string; group: string; kind: string; plays: number }[];
  metricCoverage: { key: string; label: string; nonZero: number; total: number }[];
}

// ── IPC 契约 ─────────────────────────────────────────────────────
export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  dbPath: string;
  platform: string;
  /** 数据库 schema 版本：自检与排障用，界面也可显示，避免"库是旧的"这种问题靠猜 */
  schemaVersion: number;
}

export interface ClassInfo {
  name: string;
  color: string;
  coef: number;
  role: RoleKey;
  aliases: string[];
  iconFile: string | null;
}

export interface AppSettings {
  [key: string]: string;
}

/** 统一的调用结果包装：主进程不抛异常到渲染层，避免 IPC 序列化丢栈 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface OmniaApi {
  app: {
    info(): Promise<IpcResult<AppInfo>>;
  };
  player: {
    list(): Promise<IpcResult<Player[]>>;
    create(input: PlayerInput): Promise<IpcResult<Player>>;
    update(id: number, patch: Partial<PlayerInput>): Promise<IpcResult<Player>>;
    remove(id: number): Promise<IpcResult<true>>;
    import(rows: PlayerInput[]): Promise<IpcResult<{ inserted: number; updated: number; skipped: number }>>;
    export(): Promise<IpcResult<PlayerInput[]>>;
    /** 个人详情（历史 + 汇总 + 雷达） */
    detail(playerId: number): Promise<IpcResult<PlayerDetail>>;
  };
  meta: {
    classes(): Promise<IpcResult<ClassInfo[]>>;
    settings(): Promise<IpcResult<AppSettings>>;
    /** 写单个设置项（导航栏折叠状态之类的界面偏好） */
    setSetting(key: string, value: string): Promise<IpcResult<true>>;
    /** 战斗组 / 小队建制（可新增） */
    squads(): Promise<IpcResult<SquadCatalog>>;
    createGroup(input: GroupInput): Promise<IpcResult<CombatGroupRow>>;
    removeGroup(id: number): Promise<IpcResult<true>>;
    createSquad(input: SquadInput): Promise<IpcResult<SquadRow>>;
    /** 给某组再加一队（序号自动取组内最大 +1，所以能加到「防守一-5」） */
    appendSquad(groupId: number): Promise<IpcResult<SquadRow>>;
    removeSquad(id: number): Promise<IpcResult<true>>;
    /** 只改某小队的战术（塔后拆/塔前拆/保镖/防守），不碰名称与人数 */
    setSquadTactic(id: number, tactic: string): Promise<IpcResult<SquadRow>>;
    /**
     * 触发「截取排表功能区」并保存为 PNG。区域由渲染层分块截图后拼合
     * （capturePage 只截可见区域，必须分块），主进程只负责落盘。
     */
    captureRegion(): Promise<IpcResult<{ path: string | null; width: number; height: number }>>;
    /** 把窗口临时撑到屏幕最大，返回内容区尺寸（截图用，拿最大可见区域） */
    captureMaxWin(): Promise<IpcResult<{ w: number; h: number }>>;
    /** 还原窗口尺寸 */
    captureRestoreWin(): Promise<IpcResult<true>>;
    /** 分块截图，返回 PNG dataURL；矩形先写进 app_setting.captureRect */
    captureRect(): Promise<IpcResult<string>>;
    /** 读取 xlsx：先列工作表，再取某个工作表的网格与表头探测 */
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
    /** 批量把队员放进某小队（单事务，拖拽用） */
    assignBulk(input: AssignInput): Promise<IpcResult<{ moved: number }>>;
    /** 移出小队但保留在名单 */
    unassign(matchId: number, playerId: number): Promise<IpcResult<true>>;
    /** 只改本场技能备注，不碰小队/状态（排表页卡片上直接填） */
    setSkillNote(matchId: number, playerId: number, note: string): Promise<IpcResult<true>>;
    removeParticipation(id: number): Promise<IpcResult<true>>;
    saveStat(participationId: number, stat: Partial<CombatStat>): Promise<IpcResult<true>>;
    importPreview(text: string, mode?: JoinMode): Promise<IpcResult<ImportPreview>>;
    importCommit(matchId: number, preview: ImportPreview): Promise<IpcResult<{ written: number; created: number }>>;
    /** 按规则集重算并保存某场分数 */
    runScore(matchId: number, ruleSetId?: number): Promise<IpcResult<ScoreRunSummary>>;
    /** 读取已保存的分数 */
    scores(matchId: number, ruleSetId?: number): Promise<IpcResult<SavedScore[]>>;
  };
  dashboard: {
    data(): Promise<IpcResult<DashboardData>>;
  };
  signup: {
    /** 某场的报名面板（含未报名的人） */
    board(matchId: number): Promise<IpcResult<SignupBoard>>;
    /** 设置某人的报名状态 */
    set(input: SignupInput): Promise<IpcResult<SignupRow>>;
    /** 把报名结果应用到上场名单（参加→上场、请假→请假、替补→替补） */
    apply(matchId: number, playerIds: number[]): Promise<IpcResult<{ applied: number }>>;
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
    /** 校验但不保存（界面实时提示用） */
    validate(input: RuleSetInput): Promise<IpcResult<RuleSetValidation>>;
  };
  season: {
    list(): Promise<IpcResult<SeasonSummary[]>>;
    active(): Promise<IpcResult<Season>>;
    create(input: SeasonInput): Promise<IpcResult<Season>>;
    update(id: number, patch: Partial<SeasonInput>): Promise<IpcResult<Season>>;
    setActive(id: number): Promise<IpcResult<Season>>;
    remove(id: number): Promise<IpcResult<true>>;
    /** 把若干对局划到某赛季 */
    assignMatches(seasonId: number, matchIds: number[]): Promise<IpcResult<{ moved: number }>>;
  };
}

export const IPC = {
  appInfo: 'app:info',
  playerList: 'player:list',
  playerCreate: 'player:create',
  playerUpdate: 'player:update',
  playerRemove: 'player:remove',
  playerImport: 'player:import',
  playerExport: 'player:export',
  playerDetail: 'player:detail',
  metaClasses: 'meta:classes',
  metaSettings: 'meta:settings',
  metaSettingSet: 'meta:setting:set',
  metaSquads: 'meta:squads',
  metaGroupCreate: 'meta:group:create',
  metaGroupRemove: 'meta:group:remove',
  metaSquadCreate: 'meta:squad:create',
  metaSquadAppend: 'meta:squad:append',
  metaSquadRemove: 'meta:squad:remove',
  metaSquadTactic: 'meta:squad:tactic',
  /** 截取窗口内某个区域的图片（排表功能区导出用） */
  captureRegion: 'app:capture-region',
  /** 截图前把窗口临时撑到屏幕最大（拿最大可见区域） */
  captureMaxWin: 'app:capture-maxwin',
  /** 截图后还原窗口尺寸 */
  captureRestoreWin: 'app:capture-restorewin',
  /** 分块截图；矩形走 app_setting.captureRect（这条 IPC 传不了实参） */
  captureRect: 'app:capture-rect',
  metaXlsxSheets: 'meta:xlsx:sheets',
  metaXlsxGrid: 'meta:xlsx:grid',

  // M3 对局与战报
  matchList: 'match:list',
  matchGet: 'match:get',
  matchCreate: 'match:create',
  matchUpdate: 'match:update',
  matchRemove: 'match:remove',
  matchParticipationList: 'match:participation:list',
  matchParticipationUpsert: 'match:participation:upsert',
  matchAssignBulk: 'match:assign:bulk',
  matchUnassign: 'match:unassign',
  matchSkillNote: 'match:skill:note',

  // 报名 / 请假
  signupBoard: 'signup:board',
  signupSet: 'signup:set',
  signupApply: 'signup:apply',

  // 评分规则集
  rulesList: 'rules:list',
  rulesActive: 'rules:active',
  rulesDefaults: 'rules:defaults',
  rulesCreate: 'rules:create',
  rulesUpdate: 'rules:update',
  rulesDuplicate: 'rules:duplicate',
  rulesSetActive: 'rules:setActive',
  rulesRemove: 'rules:remove',
  rulesValidate: 'rules:validate',

  // 赛季
  seasonList: 'season:list',
  seasonActive: 'season:active',
  seasonCreate: 'season:create',
  seasonUpdate: 'season:update',
  seasonSetActive: 'season:setActive',
  seasonRemove: 'season:remove',
  seasonAssignMatches: 'season:assignMatches',
  matchParticipationRemove: 'match:participation:remove',
  matchStatSave: 'match:stat:save',
  matchImportPreview: 'match:import:preview',
  matchImportCommit: 'match:import:commit',
  matchRunScore: 'match:score:run',
  matchScores: 'match:score:list',

  // M6 看板
  dashboardData: 'dashboard:data',
} as const;
