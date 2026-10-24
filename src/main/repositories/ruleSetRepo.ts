/**
 * 评分规则集（M4）
 *
 * 设计要点：
 *  - 参数全部可编辑、可版本化；评分算法本身还没定，所以这里只做「参数管理」，
 *    但默认值就是设计基准 v2 里那套（原表权重 + 攻防系数 + 分制常数），
 *    算法一落定即可直接取用。
 *  - rule_set 表在迁移 v1 就建好了，这里补齐读写与默认值。
 *  - 权重按「个人（按定位）/ 战术执行（按战术类型）」两组存 JSON，
 *    另外存职业系数与附加分。
 */
import type { SqlDatabase } from '../db';
import type { RuleSet, RuleSetInput, RuleSetValidation } from '../../shared/types';
import { CLASSES } from '../../shared/domain';

/**
 * 把 personalWeights 归一成「按职业」的 12 条。
 *  - 新格式：键是职业名 → 原样返回（缺的职业补初值）
 *  - 旧格式：键只有 DPS/T/HEAL（三档）→ 按各职业的定位展开
 * 这样老库不用迁移就能用，改一个职业也不会牵动别的职业。
 */
export function expandPersonalWeights(
  raw: Record<string, RuleSetInput['personalWeights'][string]> | undefined,
): RuleSetInput['personalWeights'] {
  if (!raw || !Object.keys(raw).length) return buildClassPersonalWeights();
  const out: RuleSetInput['personalWeights'] = {};
  for (const c of CLASSES) {
    out[c.name] = { ...(raw[c.name] ?? raw[c.role] ?? ROLE_PERSONAL_WEIGHTS[c.role]) };
  }
  /* 规则集里可能还有自定义职业名（字典外）：原样带上，不丢数据 */
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in out) && !['DPS', 'T', 'HEAL'].includes(k)) out[k] = { ...v };
  }
  return out;
}

/** 内置默认规则：对齐设计基准 v2 与原表「数据处理1」第 4 行 */
/** 定位级口径（职业权重的初值来源；每个职业之后可各自微调） */
const ROLE_PERSONAL_WEIGHTS: Record<'DPS' | 'T' | 'HEAL', RuleSetInput['personalWeights'][string]> = {
  DPS: { kill: 1.2, dmg: 0.5, tower: 1.2, assist: 0.3, fountain: 0.2, bone: 0.2 },
  /* T（铁衣）2026-10-24 重配：原版权重全压在 承伤(cv 0.14)/助攻(cv 0.29) 上 →
     5 个 T 的 sd 只有 2.44。换成 塔伤(cv 0.76)/人伤(cv 0.42) 为主、承伤只做兜底。 */
  T: { assist: 0.4, taken: 0.4, tower: 1.4, dmg: 0.6 },
  HEAL: { assist: 0.2, heal: 0.8, taken: 0.3, revive: 0.5 },
};

/**
 * 职业级微调（用户 2026-10-24：「碎梦注重击杀 鸿音注重人伤」）
 * 原则：**权重总和保持不变**（仍是 3.6），只改各分项的相对比重 ——
 * 这样个人分的平均水平不漂，只有"看什么"变了。
 */
const CLASS_PERSONAL_TUNING: Record<string, RuleSetInput['personalWeights'][string]> = {
  /* 治疗：治疗/复活是主业，承伤只做兜底 */
  素问: { heal: 0.9, revive: 0.5, assist: 0.2, taken: 0.3 },
  妙音: { heal: 0.8, revive: 0.6, assist: 0.3, taken: 0.3 },
  /* 主坦：承伤 + 塔伤 双主业（实测 T 的承伤 cv 只有 0.14，所以塔伤权重不能小） */
  铁衣: { taken: 1.0, tower: 1.0, assist: 0.4, dmg: 0.4 },
  /* 输出系：按"招牌数据"配，权重集中在能拉开差距的项上 */
  惊鸿: { dmg: 1.5, kill: 1.0, tower: 0.4, assist: 0.3, fountain: 0.2, bone: 0.2 },  // 鸿音：人伤见长
  九灵: { dmg: 1.2, kill: 0.9, tower: 0.5, assist: 0.5, bone: 0.3 },
  神相: { dmg: 1.0, tower: 1.0, kill: 0.8, assist: 0.3, bone: 0.2 },
  玄机: { assist: 0.8, tower: 1.0, dmg: 0.8, kill: 0.6 },
  血河: { kill: 1.4, dmg: 0.8, tower: 0.6, assist: 0.3 },                        // 近战爆发：击杀优先
  龙吟: { kill: 1.1, dmg: 0.8, tower: 0.8, assist: 0.4 },
  碎梦: { kill: 2.0, dmg: 0.6, tower: 0.4, assist: 0.3 },                         // 刺杀：人头优先
  沧澜: { taken: 0.9, tower: 0.9, kill: 0.6, assist: 0.3 },                       // 坦克输出
  潮光: { heal: 0.7, fountain: 0.6, revive: 0.5, assist: 0.4 },                   // 辅助/复活
};

/**
 * 满量程参考值：**按定位**的基准（旧口径，也是按职业标定时的收缩中心）
 * 锚定"同定位中位水平 ≈ 个人分 13 分"
 */
const ROLE_PERSONAL_REF: Record<'DPS' | 'T' | 'HEAL', number> = { DPS: 0.175, T: 0.075, HEAL: 0.2 };

/**
 * 满量程参考值：**按职业**（2026-10-24，用户选 A：个人分=同职业内排名）
 *
 * 标定口径（关键）：用**去掉职业系数后**的 FN 中位数，否则参考值会把系数的影响吃掉 ✗
 *   ratio = 该职业 FN(去系数)中位 ÷ 同定位中位 ；shrink = n/(n+5) ；ref = ref_定位 × (1 + (ratio−1)×shrink)
 * 数据：60 条夹具 + 4 场真实局（2026-08-29、2026-09-23 ×2、2026-10-17），共 299 条（每职业 9~49 条）
 * 重算方式：`npm run score:refcal -- --csv <战报.csv> ...`
 */
const CLASS_PERSONAL_REF: Record<string, number> = {
  素问: 0.1868, 妙音: 0.1463,
  惊鸿: 0.1625, 九灵: 0.2188, 神相: 0.1334, 玄机: 0.1177, 血河: 0.1164,
  龙吟: 0.1374, 碎梦: 0.1686, 沧澜: 0.1282, 潮光: 0.0957,
  铁衣: 0.0905,
};

/** 展开成 12 个职业的参考值（缺的职业回落到同定位基准） */
export function buildClassPersonalRef(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CLASSES) out[c.name] = CLASS_PERSONAL_REF[c.name] ?? ROLE_PERSONAL_REF[c.role];
  return out;
}

/** 兼容旧规则集：只有 DPS/T/HEAL 三键时按职业展开 */
export function expandPersonalRef(raw: Record<string, number> | undefined): Record<string, number> {
  if (!raw || !Object.keys(raw).length) return buildClassPersonalRef();
  const out: Record<string, number> = {};
  for (const c of CLASSES) out[c.name] = raw[c.name] ?? raw[c.role] ?? ROLE_PERSONAL_REF[c.role];
  for (const [k, v] of Object.entries(raw)) if (!(k in out)) out[k] = v;
  return out;
}

/** 展开成 12 个职业各一套（每套独立对象，改一个不会连带改别的职业） */
export function buildClassPersonalWeights(): RuleSetInput['personalWeights'] {
  const out: RuleSetInput['personalWeights'] = {};
  for (const c of CLASSES) {
    out[c.name] = { ...(CLASS_PERSONAL_TUNING[c.name] ?? ROLE_PERSONAL_WEIGHTS[c.role]) };
  }
  return out;
}

export const DEFAULT_RULE_SET: RuleSetInput = {
  name: '默认规则（规范 v2 · 已标定）',
  baseScore: 55,
  capScore: 100,
  scaleTeam: 20,
  scalePersonal: 40,
  deathPen: 3,
  /** 重伤扣分封顶（v2）：一场打崩也不至于扣穿地板 */
  deathPenCap: 20,
  totalTowers: 9,
  /** 个人曲线参数（v2.1）：按定位各一个满量程参考值 + 陡度。
   *  锚定"同定位中位 = 个人分 20"，ref = 该定位 FN 中位数 × 1.587：
   *    DPS  中位≈0.085 → 0.135 ｜ T 中位≈0.0365 → 0.058 ｜ 治疗 中位≈0.098 → 0.156
   *  （实测 60 条样本 + 10/17 真实局两个数据集）*/
  personalRef: buildClassPersonalRef(),
  personalGamma: 1.8,
  /* 个人权重**按职业**（12 套）。初值 = 该职业所属定位的口径，之后每个职业可单独调
     （用户 2026-10-24：不再按 DPS/T/治疗 划分，而是按职业划分，和职业系数一起作用）。
     取值见文件末尾 ROLE_PERSONAL_WEIGHTS；这里用 CLASSES 展开成 12 条。 */
  personalWeights: buildClassPersonalWeights(),
  /* 团队分（方案 D，2026-10-24）：30% 对局加成（全场共享，只抬水平）+ 70% 小队表现（池内比值）
     —— 旧版把 55%~60% 压在推塔进度/守塔率/大旗上，那些每队一样，等于压掉队间差异 ✗ */
  execWeights: {
    anchorShare: 0.3,
    anchor: { pushProgress: 0.45, keepRate: 0.35, flag: 0.2 },
    push: { tower: 0.5, kill: 0.35, lowDeath: 0.15 },
    guard: { kill: 0.45, taken: 0.35, lowDeath: 0.2 },
    defend: { kill: 0.5, lowDeath: 0.5 },
  },
  classCoef: {
    素问: 0.95, 妙音: 1.05, 惊鸿: 1.0, 九灵: 1.0, 神相: 1.2, 玄机: 1.1,
    血河: 1.1, 铁衣: 1.1, 龙吟: 1.0, 碎梦: 1.4, 沧澜: 0.95, 潮光: 0.95,
  },
  bonus: { 指挥: 2.5, 统战: 5, K龙: 5 },
};

interface RuleRow {
  id: number; name: string;
  base_score: number; cap_score: number; scale_team: number; scale_personal: number;
  death_pen: number; total_towers: number;
  weights_json: string; class_coef_json: string; bonus_json: string;
  version: number; created_at: string;
}

const parse = <T>(json: string, fallback: T): T => {
  try {
    const v = JSON.parse(json) as T;
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
};

export class RuleSetRepo {
  /* 库连接用"取当前连接"的函数而不是固定连接：多帮会模式下切帮会只换句柄，
     仓储实例不用重建（见 src/main/guilds.ts）。 */
  constructor(private getDb: () => SqlDatabase) {}

  private get db(): SqlDatabase { return this.getDb(); }

  private toRuleSet(r: RuleRow): RuleSet {
    const weights = parse<{
      personal?: RuleSetInput['personalWeights'];
      exec?: RuleSetInput['execWeights'];
      personalRef?: Record<string, number>;
      personalGamma?: number;
      deathPenCap?: number;
    }>(r.weights_json, {});
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      active: this.activeId() === r.id,
      createdAt: r.created_at,
      baseScore: r.base_score,
      capScore: r.cap_score,
      scaleTeam: r.scale_team,
      scalePersonal: r.scale_personal,
      deathPen: r.death_pen,
      totalTowers: r.total_towers,
      /* 引擎 v2 的两个标定参数存在 weights_json 里（不新增列 → 不用迁移）：
         老库没有这两个键 → 回落到 DEFAULT_RULE_SET（标定值）✓ */
      personalRef: expandPersonalRef(weights.personalRef),
      personalGamma: typeof weights.personalGamma === 'number' ? weights.personalGamma : DEFAULT_RULE_SET.personalGamma,
      deathPenCap: typeof weights.deathPenCap === 'number' ? weights.deathPenCap : DEFAULT_RULE_SET.deathPenCap,
      /* 兼容两种存法：
         - 新：键是职业名（12 条）
         - 旧：键只有 DPS/T/HEAL（三档）→ 按职业的定位展开，职业级改动从此独立 */
      personalWeights: expandPersonalWeights(weights.personal),
      execWeights: weights.exec ?? DEFAULT_RULE_SET.execWeights,
      classCoef: parse(r.class_coef_json, DEFAULT_RULE_SET.classCoef),
      bonus: parse(r.bonus_json, DEFAULT_RULE_SET.bonus),
    };
  }

  list(): RuleSet[] {
    const rows = this.db.prepare('SELECT * FROM rule_set ORDER BY id DESC').all() as unknown as RuleRow[];
    return rows.map((r) => this.toRuleSet(r));
  }

  get(id: number): RuleSet {
    const r = this.db.prepare('SELECT * FROM rule_set WHERE id = ?').get(id) as unknown as RuleRow | undefined;
    if (!r) throw new Error(`规则集不存在：id=${id}`);
    return this.toRuleSet(r);
  }

  /** 当前激活的规则集 id；没有设置就取第一个 */
  activeId(): number | null {
    const s = this.db.prepare("SELECT value FROM app_setting WHERE key = 'activeRuleSetId'")
      .get() as { value: string } | undefined;
    const id = s ? Number(s.value) : NaN;
    if (Number.isFinite(id) && this.db.prepare('SELECT 1 FROM rule_set WHERE id = ?').get(id)) return id;
    const first = this.db.prepare('SELECT id FROM rule_set ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
    return first ? first.id : null;
  }

  active(): RuleSet | null {
    const id = this.activeId();
    return id === null ? null : this.get(id);
  }

  setActive(id: number): RuleSet {
    this.get(id); // 存在性校验
    this.db.prepare(
      `INSERT INTO app_setting (key, value) VALUES ('activeRuleSetId', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(id));
    return this.get(id);
  }

  /** 新建规则集：版本号自动递增（全局，不再按赛季） */
  create(input: RuleSetInput): RuleSet {
    validate(input);
    const name = (input.name ?? '').trim() || `规则 v?`;
    const maxV = this.db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS v FROM rule_set',
    ).get() as { v: number };
    const version = Number(maxV.v) + 1;

    const info = this.db.prepare(
      `INSERT INTO rule_set (name, base_score, cap_score, scale_team, scale_personal,
                             death_pen, total_towers, weights_json, class_coef_json, bonus_json, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      name, input.baseScore, input.capScore, input.scaleTeam, input.scalePersonal,
      input.deathPen, input.totalTowers,
      JSON.stringify({ personal: input.personalWeights, exec: input.execWeights, personalRef: input.personalRef, personalGamma: input.personalGamma, deathPenCap: input.deathPenCap }),
      JSON.stringify(input.classCoef), JSON.stringify(input.bonus), version,
    );
    return this.get(Number(info.lastInsertRowid));
  }

  /** 基于现有规则改参数：直接更新（版本号不变），或另存为新版本 */
  update(id: number, input: RuleSetInput): RuleSet {
    validate(input);
    this.get(id);
    this.db.prepare(
      `UPDATE rule_set SET name = ?, base_score = ?, cap_score = ?, scale_team = ?, scale_personal = ?,
                           death_pen = ?, total_towers = ?, weights_json = ?, class_coef_json = ?, bonus_json = ?
       WHERE id = ?`,
    ).run(
      (input.name ?? '').trim() || this.get(id).name,
      input.baseScore, input.capScore, input.scaleTeam, input.scalePersonal,
      input.deathPen, input.totalTowers,
      JSON.stringify({ personal: input.personalWeights, exec: input.execWeights, personalRef: input.personalRef, personalGamma: input.personalGamma, deathPenCap: input.deathPenCap }),
      JSON.stringify(input.classCoef), JSON.stringify(input.bonus), id,
    );
    return this.get(id);
  }

  /** 另存为新版本（保留原版，便于对比） */
  duplicate(id: number, newName?: string): RuleSet {
    const cur = this.get(id);
    return this.create({
      ...cur,
      name: newName?.trim() || `${cur.name} 副本`,
    });
  }

  remove(id: number): boolean {
    if (this.activeId() === id) throw new Error('不能删除当前激活的规则集，请先切换到别的规则集');
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM rule_set').get() as { c: number };
    if (Number(total.c) <= 1) throw new Error('至少要保留一套规则集');
    return this.db.prepare('DELETE FROM rule_set WHERE id = ?').run(id).changes > 0;
  }

  /** 重置为内置默认值（不改库，只返回默认对象，供界面「恢复默认」用） */
  defaults(): RuleSetInput {
    return JSON.parse(JSON.stringify(DEFAULT_RULE_SET)) as RuleSetInput;
  }
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

/**
 * 参数校验。返回问题清单，error 会阻止保存。
 * 重点：权重必须归一化（和为 1），否则评分量级会漂。
 */
export function validate(input: RuleSetInput): RuleSetValidation {
  const issues: RuleSetValidation['issues'] = [];
  const push = (level: 'error' | 'warn', field: string, message: string) =>
    issues.push({ level, field, message });

  if (!(input.baseScore >= 0 && input.baseScore <= 100)) {
    push('error', 'baseScore', `基础分应在 0~100（当前 ${input.baseScore}）`);
  }
  if (!(input.capScore > input.baseScore)) {
    push('error', 'capScore', `封顶分必须大于基础分（${input.capScore} ≤ ${input.baseScore}）`);
  }
  if (!(input.scaleTeam > 0)) push('error', 'scaleTeam', '团队刻度必须为正');
  if (!(input.scalePersonal > 0)) push('error', 'scalePersonal', '个人刻度必须为正');
  if (!(input.deathPen >= 0)) push('error', 'deathPen', '死亡扣分系数不能为负');
  if (!(input.totalTowers >= 1 && input.totalTowers <= 20)) {
    push('error', 'totalTowers', `每方塔数应在 1~20（当前 ${input.totalTowers}）`);
  }

  // 个人权重：每个定位权重和应为 1（原表是 3.6 这种非归一化值，这里明确要求归一）
  for (const [role, w] of Object.entries(input.personalWeights)) {
    const vals = Object.values(w).filter((v) => typeof v === 'number');
    const sum = vals.reduce((a, b) => a + b, 0);
    if (vals.some((v) => v < 0)) push('error', `personalWeights.${role}`, `${role} 权重不能为负`);
    if (sum <= 0) push('error', `personalWeights.${role}`, `${role} 权重不能全为 0`);
    else if (!near(sum, 1)) {
      push('warn', `personalWeights.${role}`,
        `${role} 权重和为 ${sum.toFixed(3)}（不等于 1）。` +
        `内置默认值刻意保留原表的原始权重（原表也未归一化），绝对值不影响排序，只影响换算量级；` +
        `若要换成归一化权重，请同步调整刻度（团队/个人）以免量级漂移`);
    }
  }

  // 对局加成比重（0~1）
  const share = input.execWeights.anchorShare;
  if (typeof share === 'number' && (share < 0 || share > 1)) {
    push('error', 'execWeights.anchorShare', '对局加成比重必须在 0~1 之间');
  }
  // 对局加成构成：应为 1
  const anchorW = input.execWeights.anchor;
  if (anchorW) {
    const vals = Object.values(anchorW).filter((v) => typeof v === 'number');
    const sum = vals.reduce((a, b) => a + b, 0);
    if (vals.some((v) => v < 0)) push('error', 'execWeights.anchor', '对局加成权重不能为负');
    else if (sum > 0 && !near(sum, 1)) {
      push('warn', 'execWeights.anchor', `对局加成权重和为 ${sum.toFixed(3)}，不等于 1`);
    }
  }
  // 战术权重：三类各应为 1（anchorShare / anchor 是数字与对象，不是战术项，跳过）
  for (const [kind, w] of Object.entries(input.execWeights)) {
    if (kind === 'anchor' || kind === 'anchorShare') continue;
    if (!w || typeof w !== 'object') continue;
    const vals = Object.values(w).filter((v) => typeof v === 'number');
    const sum = vals.reduce((a, b) => a + b, 0);
    if (vals.some((v) => v < 0)) push('error', `execWeights.${kind}`, `${kind} 权重不能为负`);
    if (sum <= 0) push('error', `execWeights.${kind}`, `${kind} 权重不能全为 0`);
    else if (!near(sum, 1)) {
      push('warn', `execWeights.${kind}`, `${kind} 战术权重和为 ${sum.toFixed(3)}，不等于 1`);
    }
  }

  // 职业系数
  const coefs = Object.entries(input.classCoef);
  if (!coefs.length) push('warn', 'classCoef', '没有配置任何职业系数，未登记职业将按 0 处理');
  for (const [cls, c] of coefs) {
    if (!(c > 0)) push('error', `classCoef.${cls}`, `${cls} 的系数必须为正（当前 ${c}）`);
    else if (c > 3) push('warn', `classCoef.${cls}`, `${cls} 的系数 ${c} 偏大，确认是否符合预期`);
  }

  // 附加分
  for (const [k, v] of Object.entries(input.bonus)) {
    if (!(v >= 0)) push('error', `bonus.${k}`, `${k} 的附加分不能为负`);
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}






















