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
import type { SqlDatabase, SqlValue } from '../db';
import type { RuleSet, RuleSetInput, RuleSetValidation } from '../../shared/types';

/** 内置默认规则：对齐设计基准 v2 与原表「数据处理1」第 4 行 */
export const DEFAULT_RULE_SET: RuleSetInput = {
  name: '默认规则（严格照搬原表权重）',
  baseScore: 60,
  capScore: 100,
  scaleTeam: 20,
  scalePersonal: 40,
  deathPen: 3,
  totalTowers: 9,
  personalWeights: {
    DPS: { kill: 1.2, dmg: 0.5, tower: 1.2, assist: 0.3, fountain: 0.2, bone: 0.2 },
    T: { assist: 0.8, taken: 1.8 },
    HEAL: { assist: 0.2, heal: 0.8, taken: 0.3, revive: 0.5 },
  },
  execWeights: {
    push: { progress: 0.6 * (7 / 9), flag: 0.6 * (2 / 9), tower: 0.25, kill: 0.15 },
    guard: { kill: 0.5, taken: 0.3, lowDeath: 0.2 },
    defend: { keepRate: 0.55, kill: 0.25, lowDeath: 0.2 },
  },
  classCoef: {
    素问: 0.95, 妙音: 1.05, 惊鸿: 1.0, 九灵: 1.0, 神相: 1.2, 玄机: 1.1,
    血河: 1.1, 铁衣: 1.1, 龙吟: 1.0, 碎梦: 1.4, 沧澜: 0.95, 潮光: 0.95,
  },
  bonus: { 指挥: 2.5, 统战: 5, K龙: 5 },
};

interface RuleRow {
  id: number; season_id: number | null; name: string;
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
  constructor(private db: SqlDatabase) {}

  private toRuleSet(r: RuleRow): RuleSet {
    const weights = parse<{ personal?: RuleSetInput['personalWeights']; exec?: RuleSetInput['execWeights'] }>(
      r.weights_json, {},
    );
    return {
      id: r.id,
      seasonId: r.season_id,
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
      personalWeights: weights.personal ?? DEFAULT_RULE_SET.personalWeights,
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

  /** 新建规则集：版本号自动递增（同赛季内） */
  create(input: RuleSetInput, seasonId: number | null = null): RuleSet {
    validate(input);
    const name = (input.name ?? '').trim() || `规则 v?`;
    const maxV = this.db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS v FROM rule_set',
    ).get() as { v: number };
    const version = Number(maxV.v) + 1;
    const sid = seasonId ?? (this.db.prepare(
      "SELECT CAST(value AS INTEGER) AS v FROM app_setting WHERE key = 'activeSeasonId'",
    ).get() as { v: number } | undefined)?.v ?? null;

    const info = this.db.prepare(
      `INSERT INTO rule_set (season_id, name, base_score, cap_score, scale_team, scale_personal,
                             death_pen, total_towers, weights_json, class_coef_json, bonus_json, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sid as SqlValue, name, input.baseScore, input.capScore, input.scaleTeam, input.scalePersonal,
      input.deathPen, input.totalTowers,
      JSON.stringify({ personal: input.personalWeights, exec: input.execWeights }),
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
      JSON.stringify({ personal: input.personalWeights, exec: input.execWeights }),
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
    }, cur.seasonId);
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

  // 战术权重：三类各应为 1
  for (const [kind, w] of Object.entries(input.execWeights)) {
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
