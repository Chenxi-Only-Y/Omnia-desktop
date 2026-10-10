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
  /** 游戏角色 ID（原表「角色ID」），业务主键。与「昵称」已合并为此单一字段 */
  gameId: string;
  /** 与 gameId 同值（保留列以兼容旧数据；界面只显示一个「ID」） */
  name: string;
  /**
   * 历史用名（改名前用过的 ID）。
   *
   * 用户口径：改名后旧战报/旧报名里的旧名必须还能对上人，
   * 否则导入会「认不出」甚至阻止入库；导入到新名字时自动把旧名收进这里。
   * 存于 player_alias 表（见迁移 v14）。
   */
  aliases: string[];
  /** 入帮排序（原表 A 列） */
  joinedOrder: number | null;
  mic: '有' | '无' | '无需作答' | '';
  noteRole: NoteRole;
  /** 个人主页背景：成员设置里上传的 mp4 / 图片的绝对路径；空 = 用默认背景（全局壁纸） */
  bgMedia: string;
  /** 个性签名（与介绍分开）：个人主页第 1 屏的一句；空 = 不显示 */
  signature: string;
  /** 介绍（与个性签名是**两个**字段）：个人主页第 1 屏的一行说明；空 = 不显示 */
  intro: string;
  /** 橙武（空 = 没有，界面显示「-」） */
  orangeWeapon: string;
  /** 注意：职业不在这里 —— 职业只从报名表来，存在 signup（人 × 场）上 */
  status: string;
  remark: string;
  /**
   * 对方帮会成员（迁移 v15，用户口径选项 A）。
   *
   * 战报导出里"不在我主档"的行会被存下来并标记为对手：
   * 他们**不进成员主档 / 报名 / 出勤**，也**不参与评分**（participation.side='opp'），
   * 只是留作对比数据。默认的 player.list() 不会返回他们。
   */
  isOpp?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerInput {
  /** 自定义介绍（个人主页显示；留空不显示） */
  signature?: string;
  /** 介绍（个人主页显示；留空不显示） */
  intro?: string;
  gameId: string;
  name?: string;
  /**
   * 历史用名。传入即**整份覆盖**该成员的别名表（与 gameId 变更时的自动追加共用同一张表）。
   * 不传 = 不动别名。
   */
  aliases?: string[];
  joinedOrder?: number | null;
  mic?: Player['mic'];
  noteRole?: NoteRole;
  /** 橙武（空串表示没有） */
  orangeWeapon?: string;
  status?: string;
  remark?: string;
}

export interface Match {
  id: number;
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
  /**
   * 分数是否已过期（战报被改/被清、参战记录被删之后置 1；算分时清零）。
   * 评分页据此提示「数据已变，请重算」——不自动重算，避免录一半刷出没意义的分。
   */
  scoreStale: boolean;
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

// ── 报名表导入（WPS/表单导出的 xlsx） ─────────────────────────────
/** 报名表里解析出的一行 */
export interface SignupImportRow {
  /** 原表行号（1 起，便于用户拿回 Excel 对照） */
  line: number;
  gameId: string;
  status: 'JOIN' | 'LEAVE';
  /** 有 / 无 / 空 */
  mic: string;
  mainClass: string;
  subClass: string;
  submittedAt: string;
}

/** 导入预览：先给用户审查，确认后再入库 */
export interface SignupImportPreview {
  rows: SignupImportRow[];
  /** 同一 角色id 多次提交（按用户口径不自动取舍，标出来让用户处理） */
  duplicates: { gameId: string; lines: number[] }[];
  /** 行级错误：缺必填、状态无法识别等 */
  invalid: { line: number; reason: string }[];
  /** 报名表里有、成员主档里没有的 ID */
  unmatched: string[];
  headers: string[];
  headerRow: number;
  /** 已经在主档里的数量（方便用户判断补建范围） */
  matchedCount?: number;
  /**
   * 行级**提示**（不是错误）：名字与职业粘连、认不出的职业写法、请假行写了职业、
   * 尾饰字疑似同一人… 导入后用户可以照着预览逐行改（用户口径 2026-10-10）。
   */
  warnings?: { line: number; reason: string }[];
}

/** 报名 vs 主档 的交叉核对结果 */
export interface SignupReview {
  matchId: number;
  /** 报名表有、主档没有 */
  signedNotInRoster: { gameId: string; status: string; mainClass: string; subClass: string }[];
  /** 主档有、本场没填表 */
  inRosterNotSigned: { playerId: number; gameId: string; status: string }[];
}

// ── 对局与战报（M3） ─────────────────────────────────────────────
export interface MatchSummary extends Match {
  /** 我方参战人数（state=PLAY） */
  ourCount: number;
  oppCount: number;
  /** 我方**已排进小队**的人数（排表概览用；ourCount 是不管有没有排的都算） */
  ourAssigned: number;
  /** 用到了几个小队 */
  squadsUsed: number;
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
  /** 本场实际使用的职业（排表时可选主职或二职） */
  classUsed: string;
  /** 本场报名表里的主职业 */
  mainClass: string;
  /** 本场报名表里的副职（排表时的「二职」选项） */
  subClass: string;
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
    | 'ALIAS_MATCH'
    | 'HEADER_NOT_FOUND'
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

/**
 * 战报导入时「不在我主档」的行怎么处理（用户口径选项 A，2026-09）。
 *
 *  · 'store' —— 当成**对方帮会**存下来（player.is_opp=1 + participation.side='opp'）：
 *              不进主档/报名/出勤，也不参与评分，只作纯数据对比。界面里默认这一项。
 *  · 'skip'  —— 直接丢掉（界面上取消勾选时的行为）。
 *  · 'block' —— 老语义：只要有对不上的行就整批拦住。IPC 的默认值，
 *              给"不认识对方帮会这回事"的旧调用方保留原有行为。
 *
 * 注意：只有**严格模式**下「不在成员主档（NOT_IN_ROSTER）」这类 error 行才算对方；
 * 完整模式下同一行的 NOT_IN_ROSTER 只是 warn，语义是"自动建档成自己人"。
 */
export type OppImportMode = 'block' | 'skip' | 'store';

export interface ImportCommitResult {
  /** 我方写入的参战记录数 */
  written: number;
  /** 我方自动建档人数（完整模式） */
  created: number;
  /** 对方帮会写入的参战记录数 */
  oppWritten: number;
  /** 对方帮会新建档人数 */
  oppCreated: number;
  /** 被跳过的对方行数（opp='skip' 时） */
  skipped: number;
}

/* ── 战斗组 / 小队建制（**按场次独立**）────────────────────────────
   用户口径 2026-09：「不同场次的队伍数量啥的彼此独立，而不是改一个另外的
   一样会被改」。所以建制不再是全局一张表，而是挂在每场对局下：
     · 组与队用 **名字** 作业务键（沿用项目既有口径：participation.squad
       本来就是文本存名字），所以没有自增 id，也就不会出现"复制到别的场次
       后 id 全变"的问题。
     · 每场首次进入时，若该场还没有建制，会**从全局默认模板复制一份**；
       模板由 combat_group / squad 两张旧表承载，设置页不再管理它们。
     · 任何改动（加组/加队/删队/人数/战术）只写该场的 match_squad。 */
export interface CombatGroupRow {
  name: string;
  kind: GroupKind;
  sortOrder: number;
}

export interface SquadRow {
  /** 所属场次 —— 建制的归属，所有改动都限定在这一场 */
  matchId: number;
  /** 组名，如 防守二 */
  groupName: string;
  kind: GroupKind;
  indexInGroup: number;
  /** 组名-序号，如 防守二-3（与 participation.squad 的文本口径一致） */
  name: string;
  tactic: Tactic | '';
  size: number;
  sortOrder: number;
}

export interface SquadCatalog {
  matchId: number;
  groups: CombatGroupRow[];
  squads: SquadRow[];
  /** 建制总容量 = Σ 小队人数 */
  capacity: number;
}

export interface GroupInput {
  name: string;
  kind: GroupKind;
}

export interface SquadInput {
  /** 组名（不再用自增 id） */
  groupName: string;
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
  /** 本场报名表里的主职业（职业只从报名表来，主档不再持有） */
  mainClass: string;
  /** 本场报名表里的副职（排表时可选用的「二职」） */
  subClass: string;
  noteRole: string;
  mic: Player['mic'];
  status: Player['status'];
  /** 入帮序，用于排序 */
  joinedOrder: number | null;
  /** 本场报名状态；null = 还没报名（主档有、报名表没有 → 界面标「未填表」） */
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
  /**
   * JOIN=参加 / LEAVE=请假 / BENCH=替补 / NONE=清除报名。
   * 不传 = 不改状态（用于"只修正职业"的调用）。
   */
  status?: SignupStatus;
  remark?: string;
  /**
   * 可选的职业修正：报名导入后允许在名单里直接改主职 / 二职
   * （导入进来的职业名可能是错的，之前只能删掉重导）。
   * 只有显式传入才会写；不传则保持原值。空串表示清掉。
   */
  mainClass?: string;
  subClass?: string;
  /**
   * 本场麦克风（可选，手动加人时一并写）。
   * 不传 = 保持原值。面板显示口径是 `signup.mic || player.mic`，所以写这里就够了。
   */
  mic?: string;
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
  version: number;
  active: boolean;
  createdAt: string;
}

export interface RuleSetValidation {
  ok: boolean;
  issues: { level: 'error' | 'warn'; field: string; message: string }[];
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

/** 六维对比数据：个人 vs 团队人均 */
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
  /** 六维雷达（仅在本人与团队都有数据时有意义） */
  radar: RadarAxis[];
  /** 团队基准：所有我方上场记录的人均值 */
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
/** 壁纸库里的一个壁纸（静态图或动态视频） */
export interface WallpaperItem {
  name: string;
  /** 绝对路径 */
  file: string;
  /** image = 静态；video = 动态 */
  kind: 'image' | 'video';
  ext: string;
}

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  dbPath: string;
  platform: string;
  /** 数据库 schema 版本：自检与排障用，界面也可显示，避免"库是旧的"这种问题靠猜 */
  schemaVersion: number;
  /** 当前所在的帮会（单库模式是一个虚拟帮会）；一个帮会都没有时为 null */
  guild: GuildMeta | null;
  /** 帮会总数（界面判断"要不要引导新建帮会"用） */
  guildCount: number;
}

/**
 * 一个帮会（= 一套完全独立的数据库文件）。
 *
 * 用户口径：「点击什么帮会才能进入某帮会整个数据库」「不同帮会的数据库独立存放」。
 * 存储位置见 src/main/guilds.ts 的注释。
 */
export interface GuildMeta {
  /** 内部 id，同时是库文件名（guilds/<id>.db）；用时间戳生成，避免中文名进路径 */
  id: string;
  /** 显示名（可改） */
  name: string;
  /** 备注 / 简介（帮会首页介绍用） */
  note: string;
  createdAt: string;
  /** 封面图绝对路径（已拷进 guilds/<id>/cover.png）；没有就是 null，界面用帮会名大字底 */
  cover: string | null;
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
    import(rows: PlayerInput[]): Promise<IpcResult<{ inserted: number; updated: number; skipped: number; errors: string[] }>>;
    export(): Promise<IpcResult<PlayerInput[]>>;
    /** 按给定 id 顺序重排成员：序 = 下标 + 1（拖拽换位后调用） */
    reorder(playerIds: number[]): Promise<IpcResult<true>>;
    /** 个人详情（历史 + 汇总 + 雷达） */
    detail(playerId: number): Promise<IpcResult<PlayerDetail>>;
    /** 选一段 mp4 / 一张图当个人主页背景（返回所选路径，取消为 null） */
    pickBg(): Promise<IpcResult<string | null>>;
    /** 设置背景：把文件拷进应用目录并写库 */
    setBg(id: number, srcPath: string): Promise<IpcResult<Player>>;
    /** 移除背景（回到默认） */
    clearBg(id: number): Promise<IpcResult<Player>>;
    /** 壁纸库：扫描用户设置的目录（静态图 + 动态视频都收） */
    listWallpapers(dir?: string): Promise<IpcResult<WallpaperItem[]>>;
    /** 把动态壁纸抽一帧存成图（ffmpeg），返回图片绝对路径 */
    wallpaperTranscode(): Promise<IpcResult<string>>;
  };
  meta: {
    classes(): Promise<IpcResult<ClassInfo[]>>;
    settings(): Promise<IpcResult<AppSettings>>;
    /** 写单个设置项（导航栏折叠状态之类的界面偏好） */
    setSetting(key: string, value: string): Promise<IpcResult<true>>;
    /** 战斗组 / 小队建制：**按场次独立**，全部以 matchId 为首参 */
    squads(matchId: number): Promise<IpcResult<SquadCatalog>>;
    createGroup(matchId: number, input: GroupInput): Promise<IpcResult<CombatGroupRow>>;
    removeGroup(matchId: number, groupName: string): Promise<IpcResult<{ removed: boolean }>>;
    createSquad(matchId: number, input: SquadInput): Promise<IpcResult<SquadRow>>;
    /** 给某组再加一队（序号自动取该场该组内最大 +1，所以能加到「防守一-5」） */
    appendSquad(matchId: number, groupName: string): Promise<IpcResult<SquadRow>>;
    removeSquad(matchId: number, squadName: string): Promise<IpcResult<true>>;
    /** 只改某小队的战术（塔后拆/塔前拆/保镖/防守），不碰名称与人数 */
    setSquadTactic(matchId: number, squadName: string, tactic: string): Promise<IpcResult<SquadRow>>;
    /** 改某队人数（不能小于该队已排人数） */
    setSquadSize(matchId: number, squadName: string, size: number): Promise<IpcResult<SquadRow>>;
    /**
     * 触发「截取排表功能区」并保存为 PNG。区域由渲染层分块截图后拼合
     * （capturePage 只截可见区域，必须分块），主进程只负责落盘。
     */
    captureRegion(): Promise<IpcResult<{ path: string | null; width: number; height: number }>>;
    /**
     * 分块截图，返回 PNG dataURL。
     * 要截的矩形先写进 app_setting.captureRect —— 这批 IPC 传不了实参。
     */
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
    /** 把另一场的**排表**沿用过来（小队 / 落位 / 职业；不带战报、不带评分、不带对方数据） */
    copyLineup(fromMatchId: number, toMatchId: number, overwrite?: boolean):
      Promise<IpcResult<{ copied: number; skipped: number; squadsAdded: number }>>;
    /** 只改本场技能备注，不碰小队/状态（排表页卡片上直接填） */
    setSkillNote(matchId: number, playerId: number, note: string): Promise<IpcResult<true>>;
    removeParticipation(id: number): Promise<IpcResult<true>>;
    saveStat(participationId: number, stat: Partial<CombatStat>): Promise<IpcResult<true>>;
    /** 清空某场某一方的战报数值（our 保留参战记录、opp 连参战记录一起删） */
    clearStats(matchId: number, side?: 'our' | 'opp'): Promise<IpcResult<{ cleared: number }>>;
    /** 清空单条参战记录的战报数值 */
    clearStatRow(participationId: number): Promise<IpcResult<true>>;
    importPreview(text: string, mode?: JoinMode): Promise<IpcResult<ImportPreview>>;
    importCommit(matchId: number, preview: ImportPreview, opts?: { opp?: OppImportMode }):
      Promise<IpcResult<ImportCommitResult>>;
    /** 按规则集重算并保存某场分数 */
    runScore(matchId: number, ruleSetId?: number): Promise<IpcResult<ScoreRunSummary>>;
    /** 读取已保存的分数 */
    scores(matchId: number, ruleSetId?: number): Promise<IpcResult<SavedScore[]>>;
  };
  dashboard: {
    data(): Promise<IpcResult<DashboardData>>;
  };
  /**
   * 帮会（一帮会一个库文件）。
   * `open` 会**切换当前库**（不重启应用）：切完之后其它接口读写的都是这个帮会的数据。
   */
  guild: {
    list(): Promise<IpcResult<GuildMeta[]>>;
    active(): Promise<IpcResult<GuildMeta | null>>;
    create(name: string, note?: string): Promise<IpcResult<GuildMeta>>;
    open(id: string): Promise<IpcResult<GuildMeta>>;
    update(id: string, patch: { name?: string; note?: string }): Promise<IpcResult<GuildMeta>>;
    remove(id: string): Promise<IpcResult<true>>;
    /** 把本地图片拷进 guilds/<id>/cover.png 并记为封面 */
    setCover(id: string, srcPath: string): Promise<IpcResult<GuildMeta>>;
    /** 弹系统选图框，返回所选路径（用户取消则 null） */
    pickCover(): Promise<IpcResult<string | null>>;
  };
  signup: {
    /** 某场的报名面板（含未报名的人） */
    board(matchId: number): Promise<IpcResult<SignupBoard>>;
    /** 设置某人的报名状态 */
    set(input: SignupInput): Promise<IpcResult<SignupRow>>;
    /** 把报名结果应用到上场名单（参加→上场、请假→请假、替补→替补） */
    apply(matchId: number, playerIds: number[]): Promise<IpcResult<{ applied: number }>>;
    /** 解析报名表 xlsx，返回预览（含重复/无效行与未匹配 ID），不入库 */
    parseSignup(matchId: number, data: Uint8Array): Promise<IpcResult<SignupImportPreview>>;
    /** 解析「接龙」文本，返回同一个预览结构（不入库） */
    parseSignupText(matchId: number, text: string): Promise<IpcResult<SignupImportPreview>>;
    /** 提交报名导入；重复报名会直接报错（用户口径：手动处理） */
    importSignups(matchId: number, rows: SignupImportRow[]):
      Promise<IpcResult<{ imported: number; unmatched: string[] }>>;
    /** 交叉核对：主档有但本场未填表的名单，以及报名有主档没有的清单 */
    reviewSignups(matchId: number): Promise<IpcResult<SignupReview>>;
    /** 补建缺失成员（职业不进主档，只建 ID 并写入该场报名记录） */
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
    /** 校验但不保存（界面实时提示用） */
    validate(input: RuleSetInput): Promise<IpcResult<RuleSetValidation>>;
  };
}

export const IPC = {
  appInfo: 'app:info',
  playerList: 'player:list',
  playerCreate: 'player:create',
  playerUpdate: 'player:update',
  playerRemove: 'player:remove',
  playerImport: 'player:import',
  /** 按给定顺序重排成员（拖拽换位后调用），写回「序」 */
  playerReorder: 'player:reorder',
  metaListWallpapers: 'meta:list-wallpapers',
  playerExport: 'player:export',
  playerDetail: 'player:detail',
  playerPickBg: 'player:pick-bg',
  playerSetBg: 'player:set-bg',
  playerClearBg: 'player:clear-bg',
  metaClasses: 'meta:classes',
  metaSettings: 'meta:settings',
  metaSettingSet: 'meta:setting:set',
  metaSquads: 'meta:squads',
  metaGroupCreate: 'meta:group:create',
  metaGroupRemove: 'meta:group:remove',
  metaSquadCreate: 'meta:squad:create',
  metaSquadAppend: 'meta:squad:append',
  metaSquadRemove: 'meta:squad:remove',
  /** 改某队人数（按场次独立） */
  metaSquadSize: 'meta:squad:size',
  metaSquadTactic: 'meta:squad:tactic',
  /** 截取窗口内某个区域的图片（排表功能区导出用） */
  captureRegion: 'app:capture-region',
  /** 分块截图（三块：左半区 / 中缝 / 右半区）；矩形走 app_setting.captureRect */
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
  matchCopyLineup: 'match:copy-lineup',
  matchSkillNote: 'match:skill:note',

  // 报名 / 请假
  signupBoard: 'signup:board',
  /** 解析报名 xlsx（只预览，不入库） */
  signupParse: 'signup:parse',
  /** 解析「接龙」文本（只预览，不入库） */
  signupParseText: 'signup:parse-text',
  /** 提交报名导入 */
  signupImport: 'signup:import',
  /** 报名 vs 主档 交叉核对 */
  signupReview: 'signup:review',
  /** 补建「报名有、主档没有」的成员 */
  signupCreateMissing: 'signup:create-missing',
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

  matchParticipationRemove: 'match:participation:remove',
  matchStatSave: 'match:stat:save',
  matchStatClear: 'match:stat:clear',
  matchStatClearRow: 'match:stat:clear-row',
  matchImportPreview: 'match:import:preview',
  matchImportCommit: 'match:import:commit',
  matchRunScore: 'match:score:run',
  matchScores: 'match:score:list',

  // 帮会（一帮会一个库文件）
  guildList: 'guild:list',
  guildActive: 'guild:active',
  guildCreate: 'guild:create',
  guildOpen: 'guild:open',
  guildUpdate: 'guild:update',
  guildRemove: 'guild:remove',
  guildSetCover: 'guild:set-cover',
  /** 弹系统选图框挑封面（返回路径，不落库） */
  guildPickCover: 'guild:pick-cover',

  // M6 看板
  dashboardData: 'dashboard:data',
} as const;
