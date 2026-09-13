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
  state?: PartState;
  stat?: Partial<CombatStat>;
}

export interface RuleSet {
  id: number;
  seasonId: number | null;
  name: string;
  baseScore: number;
  capScore: number;
  scaleTeam: number;
  scalePersonal: number;
  deathPen: number;
  totalTowers: number;
  weightsJson: string;
  classCoefJson: string;
  bonusJson: string;
  version: number;
  createdAt: string;
}

export interface Season {
  id: number;
  name: string;
  startedAt: string;
  endedAt: string;
  remark: string;
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
  };
  meta: {
    classes(): Promise<IpcResult<ClassInfo[]>>;
    settings(): Promise<IpcResult<AppSettings>>;
    /** 战斗组 / 小队建制（可新增） */
    squads(): Promise<IpcResult<SquadCatalog>>;
    createGroup(input: GroupInput): Promise<IpcResult<CombatGroupRow>>;
    removeGroup(id: number): Promise<IpcResult<true>>;
    createSquad(input: SquadInput): Promise<IpcResult<SquadRow>>;
    removeSquad(id: number): Promise<IpcResult<true>>;
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
    removeParticipation(id: number): Promise<IpcResult<true>>;
    saveStat(participationId: number, stat: Partial<CombatStat>): Promise<IpcResult<true>>;
    importPreview(text: string, mode?: JoinMode): Promise<IpcResult<ImportPreview>>;
    importCommit(matchId: number, preview: ImportPreview): Promise<IpcResult<{ written: number; created: number }>>;
  };
  dashboard: {
    data(): Promise<IpcResult<DashboardData>>;
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
  metaClasses: 'meta:classes',
  metaSettings: 'meta:settings',
  metaSquads: 'meta:squads',
  metaGroupCreate: 'meta:group:create',
  metaGroupRemove: 'meta:group:remove',
  metaSquadCreate: 'meta:squad:create',
  metaSquadRemove: 'meta:squad:remove',
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
  matchParticipationRemove: 'match:participation:remove',
  matchStatSave: 'match:stat:save',
  matchImportPreview: 'match:import:preview',
  matchImportCommit: 'match:import:commit',

  // M6 看板
  dashboardData: 'dashboard:data',
} as const;
