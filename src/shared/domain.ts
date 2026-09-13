/**
 * 万象·Omnia —— 共享领域常量与类型
 *
 * 来源：`LIS设计基准v2.md`（原 LIS 联赛集成系统逆向识别结论）
 *  - 12 职业与别名映射         → D7
 *  - 小队/编组结构（4 守 + 6 攻 = 10 支小队 × 6 人） → D10
 *  - 对局字段（胜负 + 双方剩余塔数，共 9 塔，大旗由胜负代替） → D11~D14
 *  - 60 分保底                                 → D8
 */

// ── 职业定位（D7：以 12 职业为准） ────────────────────────────────
export type RoleKey = 'DPS' | 'T' | 'HEAL';

export interface ClassDef {
  name: string;
  color: string;
  coef: number;
  role: RoleKey;
  aliases: string[];
}

/** 12 职业：名称 / 色板 / 平衡系数 / 定位 / 别名 */
export const CLASSES: readonly ClassDef[] = [
  { name: '素问', color: '#EF949F', coef: 0.95, role: 'HEAL', aliases: [] },
  { name: '妙音', color: '#A4D663', coef: 1.05, role: 'HEAL', aliases: [] },
  { name: '惊鸿', color: '#F0BC06', coef: 1.0, role: 'DPS', aliases: ['鸿音'] },
  { name: '九灵', color: '#B086D7', coef: 1.0, role: 'DPS', aliases: [] },
  { name: '神相', color: '#4470C8', coef: 1.2, role: 'DPS', aliases: [] },
  { name: '玄机', color: '#97965F', coef: 1.1, role: 'DPS', aliases: [] },
  { name: '血河', color: '#E35569', coef: 1.1, role: 'DPS', aliases: [] },
  { name: '铁衣', color: '#F98B1F', coef: 1.1, role: 'T', aliases: [] },
  { name: '龙吟', color: '#32CC97', coef: 1.0, role: 'DPS', aliases: [] },
  { name: '碎梦', color: '#27C3CD', coef: 1.4, role: 'DPS', aliases: [] },
  { name: '沧澜', color: '#91AADF', coef: 0.95, role: 'DPS', aliases: [] },
  { name: '潮光', color: '#2BCBFF', coef: 0.95, role: 'DPS', aliases: [] },
] as const;

export const CLASS_NAMES: readonly string[] = CLASSES.map((c) => c.name);

/**
 * 职业图标映射。
 *
 * 来源：原表「下滑预选」D6:D17 的 DISPIMG 内嵌图，已从 xlsx 解包导出。
 * 顺序依据 cellimages.xml 里的 DISPIMG ID ↔ media 文件对应关系（逐条核对），
 * 而非工作簿里的编号顺序 —— 二者并不一致，这里以 ID 映射为准。
 * ⚠️ 惊鸿（原表 A8 / D8）没有图标素材，是个待补缺口。
 */
export const CLASS_ICON_FILE: Record<string, string> = {
  素问: 'image4.png',
  妙音: 'image3.png',
  九灵: 'image1.png',
  神相: 'image11.png',
  玄机: 'image9.png',
  血河: 'image5.png',
  铁衣: 'image6.png',
  龙吟: 'image10.png',
  碎梦: 'image7.png',
  沧澜: 'image8.png',
  潮光: 'image2.png',
};

export function classIconFile(name: string | null | undefined): string | null {
  if (!name) return null;
  return CLASS_ICON_FILE[name.trim()] ?? null;
}

/** 渲染层里职业图标的相对路径（public/class-icons） */
export function classIconUrl(name: string | null | undefined): string | null {
  const f = classIconFile(name);
  return f ? `./class-icons/${f}` : null;
}

export function findClass(name: string | null | undefined): ClassDef | undefined {
  if (!name) return undefined;
  const n = name.trim();
  return CLASSES.find((c) => c.name === n || c.aliases.includes(n));
}

export const CLASS_COEF: Record<string, number> = Object.fromEntries(
  CLASSES.map((c) => [c.name, c.coef]),
);

// ── 战术类型与小队结构（D9 / D10） ───────────────────────────────
export type Tactic = '塔后拆' | '塔前拆' | '保镖' | '防守';
export const TACTICS: readonly Tactic[] = ['塔后拆', '塔前拆', '保镖', '防守'] as const;

export type SquadGroup = '防守一' | '防守二' | '进攻一' | '进攻二';
export const SQUAD_GROUPS: readonly SquadGroup[] = ['防守一', '防守二', '进攻一', '进攻二'] as const;

export interface SquadDef {
  /** 小队编号，如 "防守一1" —— 与原表 I 列自动编号规则一致 */
  squad: string;
  group: SquadGroup;
  tactic: Tactic;
  size: number;
}

/** 10 支上场小队：防守一/二 各 2 支，进攻一/二 各 3 支 */
export const SQUADS: readonly SquadDef[] = [
  { squad: '防守一1', group: '防守一', tactic: '防守', size: 6 },
  { squad: '防守一2', group: '防守一', tactic: '防守', size: 6 },
  { squad: '防守二1', group: '防守二', tactic: '防守', size: 6 },
  { squad: '防守二2', group: '防守二', tactic: '防守', size: 6 },
  { squad: '进攻一1', group: '进攻一', tactic: '塔后拆', size: 6 },
  { squad: '进攻一2', group: '进攻一', tactic: '塔前拆', size: 6 },
  { squad: '进攻一3', group: '进攻一', tactic: '保镖', size: 6 },
  { squad: '进攻二1', group: '进攻二', tactic: '塔后拆', size: 6 },
  { squad: '进攻二2', group: '进攻二', tactic: '塔前拆', size: 6 },
  { squad: '进攻二3', group: '进攻二', tactic: '保镖', size: 6 },
] as const;

/** 非上场槽位 */
export const BENCH_SQUADS = ['替补', '请假'] as const;

export const TOTAL_MATCH_SLOTS = SQUADS.reduce((s, x) => s + x.size, 0); // 60

// ── 备注角色与附加分（D18） ───────────────────────────────────────
export type NoteRole = '指挥' | '统战' | 'K龙' | '替补指挥' | '长期请假' | '';
export const NOTE_ROLES: readonly NoteRole[] = [
  '指挥', '统战', 'K龙', '替补指挥', '长期请假', '',
] as const;

export const BONUS_POINTS: Record<string, number> = {
  指挥: 2.5,
  统战: 5,
  K龙: 5,
};

// ── 参战状态 ─────────────────────────────────────────────────────
export type PartState = 'PLAY' | 'BENCH' | 'LEAVE';
export const PART_STATE_LABEL: Record<PartState, string> = {
  PLAY: '上场',
  BENCH: '替补',
  LEAVE: '请假',
};

// ── 比赛结果 ─────────────────────────────────────────────────────
export type MatchResult = 'WIN' | 'LOSE' | 'DRAW';
export const MATCH_RESULT_LABEL: Record<MatchResult, string> = {
  WIN: '胜', LOSE: '负', DRAW: '平',
};

/** 每方塔数（含高地塔）；拆掉大旗判定为胜 (D12/D13) */
export const TOTAL_TOWERS_PER_SIDE = 9;

// ── 个人分权重（对齐原表 数据处理1 第 4 行，D18） ─────────────────
export interface PersonalWeights {
  kill: number; dmg: number; tower: number; assist: number;
  fountain: number; bone: number; heal: number; taken: number; revive: number;
}

export const DEFAULT_PERSONAL_WEIGHTS: Record<RoleKey, PersonalWeights> = {
  DPS: { kill: 1.2, dmg: 0.5, tower: 1.2, assist: 0.3, fountain: 0.2, bone: 0.2, heal: 0, taken: 0, revive: 0 },
  T: { kill: 0, dmg: 0, tower: 0, assist: 0.8, fountain: 0, bone: 0, heal: 0, taken: 1.8, revive: 0 },
  HEAL: { kill: 0, dmg: 0, tower: 0, assist: 0.2, fountain: 0, bone: 0, heal: 0.8, taken: 0.3, revive: 0.5 },
};

// ── 团队执行分权重（D9/D14）—— 首版拟定值，待真实对局数据回归微调 ──
export interface ExecWeights {
  /** 推塔型：对局共享项（塔进度 + 大旗）与小队表现项 */
  push: { progress: number; flag: number; tower: number; kill: number };
  guard: { kill: number; taken: number; lowDeath: number };
  defend: { keepRate: number; kill: number; lowDeath: number };
}

export const DEFAULT_EXEC_WEIGHTS: ExecWeights = {
  push: { progress: 0.6 * (7 / 9), flag: 0.6 * (2 / 9), tower: 0.25, kill: 0.15 },
  guard: { kill: 0.5, taken: 0.3, lowDeath: 0.2 },
  defend: { keepRate: 0.55, kill: 0.25, lowDeath: 0.2 },
};

export function tacticKind(t: Tactic | string): 'push' | 'guard' | 'defend' {
  if (t === '保镖') return 'guard';
  if (t === '防守') return 'defend';
  return 'push';
}

// ── 战报原始字段（对齐原表 数据导入 B6:O，共 14 项） ──────────────
export interface CombatStat {
  /** 击败（原表「击败/清泉」的击败部分） */
  kills: number;
  /** 清泉（原表「击败/清泉」的清泉部分；仅潮光计入个人分） */
  fountainKills: number;
  assists: number;
  resource: number;
  dmgPlayer: number;
  dmgPlayerArmor: number;
  dmgBuilding: number;
  dmgBuildingArmor: number;
  healing: number;
  damageTaken: number;
  deaths: number;
  /** 复活（原表「复活/清泉」的复活部分；仅素问/妙音计入个人分） */
  revives: number;
  boneBurn: number;
}

export const EMPTY_COMBAT_STAT: CombatStat = {
  kills: 0, fountainKills: 0, assists: 0, resource: 0,
  dmgPlayer: 0, dmgPlayerArmor: 0, dmgBuilding: 0, dmgBuildingArmor: 0,
  healing: 0, damageTaken: 0, deaths: 0, revives: 0, boneBurn: 0,
};

export const COMBAT_FIELDS: { key: keyof CombatStat; label: string; group: string }[] = [
  { key: 'kills', label: '击败', group: '进攻' },
  { key: 'fountainKills', label: '清泉', group: '进攻' },
  { key: 'assists', label: '助攻', group: '进攻' },
  { key: 'resource', label: '资源', group: '进攻' },
  { key: 'dmgPlayer', label: '对玩家伤害', group: '进攻' },
  { key: 'dmgPlayerArmor', label: '人伤卸甲', group: '进攻' },
  { key: 'dmgBuilding', label: '对建筑伤害', group: '进攻' },
  { key: 'dmgBuildingArmor', label: '破塔卸甲', group: '进攻' },
  { key: 'healing', label: '治疗值', group: '生存' },
  { key: 'damageTaken', label: '承受伤害', group: '生存' },
  { key: 'deaths', label: '重伤', group: '生存' },
  { key: 'revives', label: '复活', group: '生存' },
  { key: 'boneBurn', label: '焚骨', group: '生存' },
];

/** 有效值派生（照搬原表口径） */
export function deriveEffective(s: CombatStat) {
  return {
    effKills: s.kills + s.fountainKills,
    effDmg: s.dmgPlayer + s.dmgPlayerArmor,
    effTower: s.dmgBuilding + s.dmgBuildingArmor,
    assist: s.assists,
    heal: s.healing,
    taken: s.damageTaken,
    death: s.deaths,
    revive: s.revives,
    fountain: s.fountainKills,
    bone: s.boneBurn,
  };
}
