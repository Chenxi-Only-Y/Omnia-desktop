/**
 * 评分引擎（M1）—— 纯函数，所有参数来自「规则中心」的 rule_set
 *
 * 设计原则：
 *  1. 引擎不写死任何权重/系数/分制，全部由规则集传入 → 改规则即可重算，不用改代码。
 *  2. 中间量全部返回（团队分、个人分、各项权重贡献），便于审计与后续标定。
 *  3. 这是**可标定的一版实现**，口径取自设计基准 v2（原表权重 + 战术权重推导）。
 *     用户一旦给出正式口径，只需替换本文件的公式或新增引擎实现。
 *
 * 管线：
 *   原始 → 有效值 → 联盟/团队汇总 → 贡献比 → 加权 → Min-Max 归一 → ×刻度 → 总分
 */
import { BONUS_POINTS, deriveEffective, tacticKind, type RoleKey, type Tactic } from './domain';
import type { CombatStat, PersonalWeights, RuleSet, ExecWeights } from './types';

export interface ScoreInputRow {
  participationId: number;
  playerId: number;
  playerName: string;
  /** 本场使用的职业 */
  classUsed: string;
  /** 职业定位（DPS / T / HEAL） */
  role: RoleKey;
  /** 小队名，可为空（未分配） */
  squad: string;
  tactic: Tactic | '';
  /** 团队定位：防守 / 进攻 */
  teamRole: '防守' | '进攻' | '';
  /** 备注角色（指挥/统战/K龙…） */
  noteRole: string;
  /** 手动赋分（K龙补偿、阵容问题等；正负均可，直接加到总分） */
  manualBonus?: number;
  state: 'PLAY' | 'BENCH' | 'LEAVE';
  stat: CombatStat;
}

export interface MatchScoreInput {
  matchId: number;
  /** 对局级：我方剩余塔、敌方剩余塔、胜负（大旗） */
  ourTowersLeft: number;
  oppTowersLeft: number;
  result: 'WIN' | 'LOSE' | 'DRAW';
  rows: ScoreInputRow[];
}

export interface ScoreLine {
  participationId: number;
  playerId: number;
  playerName: string;
  role: RoleKey;
  squad: string;
  /** 个人换算分 */
  personalScore: number;
  /** 团队换算分（同小队共享） */
  teamScore: number;
  bonus: number;
  deathPenalty: number;
  total: number;
  detail: Record<string, number | string>;
}

export interface MatchScoreOutput {
  matchId: number;
  lines: ScoreLine[];
  /** 引擎标识，落库用，便于算法迭代后区分历史分数 */
  engine: string;
}

/**
 * 引擎标识：落库用，便于算法迭代后区分历史分数。
 *  v1       = 早期"可标定的一版"（FN 按权重和归一、个人比例钳到 [0,1]、总分有 0 下限）
 *  spec-v1  = 照搬 LIS设计基准v2.md「评分算法规范 v1.0」（同场 Min-Max 归一，零贡献可为负）
 *  spec-v2  = **重新设计**（2026-10-24）：个人分改绝对饱和曲线（跨场可比、零贡献记 0）、
 *             重伤扣分封顶、T/治疗 补 资源/焚骨 提升区分度。见 personalCurve() 注释。
 */
export const ENGINE_ID = 'omnia-spec-v2';

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);
/** 职业系数（取规则集里的；未知职业按 1.0 中性处理，不把人的个人分打没） */
const coefOf = (rule: RuleSet, cls: string): number => {
  const c = rule.classCoef[cls];
  return typeof c === 'number' && c > 0 ? c : 1;
};
const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/** 某一组权重（可能缺键）的和 */
const weightSum = (w: Record<string, number | undefined>): number =>
  sum(Object.values(w).map((v) => (typeof v === 'number' ? v : 0)));

/**
 * 按「权重 × 占比」求和。
 * 权重里没出现的键视为"该定位不使用这一项"（不参与计算）。
 *
 * ⚠️ **不按权重和归一**（规范 v1.0 §2.4）：FN = Σ w_k × (个人有效值_k / 联盟有效值_k) 就是原式。
 * 以前这里除以权重和，等于把三种定位的 FN 各自缩放到不同量级（DPS 权重和 3.6 / T 2.6 / 治疗 1.8），
 * 而个人分是**跨定位**一起排的 Min-Max → 缩放不同就会改变不同职业之间的相对高低 ✗
 */
function weighted(w: Record<string, number | undefined>, ratio: (key: string) => number): number {
  const total = weightSum(w);
  if (total <= 0) return 0;
  let acc = 0;
  for (const [k, v] of Object.entries(w)) {
    if (typeof v !== 'number' || v === 0) continue;
    acc += v * ratio(k);
  }
  return acc;
}

/**
 * 池内**比值**归一（2026-10-24 换掉 min-max）：`r(v) = v ÷ 池内最大值`，落在 [0,1]。
 *
 * 为什么不用 min-max：小池子（保镖只有 2 队）会退化成 0 / 1 二值 ✗
 * 实测：两队承伤只差 2.6%（8666 万 vs 8898 万），min-max 却给出 0.00 vs 1.00
 * → 承伤权重 0.30 × 20 = 直接 6 分的鸿沟 ✗。比值归一则是 0.974 vs 1.000 ✓
 */
function ratioNorm(value: number, values: number[]): number {
  const mx = values.length ? Math.max(...values) : 0;
  if (!(mx > 0)) return 0;
  return Math.max(0, Math.min(1, value / mx));
}

/**
 * "少死"折算成 [0,1]：以**全场平均死亡**为锚（绝对基准，不随池变）。
 * d̄ = 0 → 1 ｜ d̄ = 平均 → 0.5 ｜ d̄ ≥ 2×平均 → 0
 */
function lowDeathScore(avgDeaths: number, matchAvgDeaths: number): number {
  if (!(matchAvgDeaths > 0)) return 0.5;
  return Math.max(0, Math.min(1, 1 - avgDeaths / (2 * matchAvgDeaths)));
}

/**
 * 某一战术类型的执行分（0~1）= 对局加成（全场共享）+ 小队表现（池内比值）
 *
 * 2026-10-24 重做（方案 D）：
 *   以前 55%~60% 的权重压在推塔进度/守塔率/大旗上 —— 这些对**每支小队完全一样**，
 *   只抬水平、不区分高低 ✗ 现在把"对局事实"压到 30%，70% 交给小队自己的数据，
 *   并用**比值**而不是 min-max 归一（避免小池子退化成 0/1）。
 */
function execScore(
  kind: 'push' | 'guard' | 'defend',
  w: ExecWeights,
  ctx: {
    pushProgress: number;
    flag: number;
    keepRate: number;
    matchAvgDeaths: number;
    squad: { kill: number; tower: number; taken: number; avgDeaths: number };
    ranges: { kill: number[]; tower: number[]; taken: number[]; avgDeaths: number[] };
  },
): { score: number; parts: Record<string, number> } {
  /* ── 对局加成：全场共享（每队同一份） ── */
  const aw = w.anchor ?? {};
  const anchorSum = (aw.pushProgress ?? 0) + (aw.keepRate ?? 0) + (aw.flag ?? 0);
  const anchorRaw = (aw.pushProgress ?? 0) * ctx.pushProgress
    + (aw.keepRate ?? 0) * ctx.keepRate
    + (aw.flag ?? 0) * ctx.flag;
  const anchor = anchorSum > 0 ? anchorRaw / anchorSum : 0;

  /* ── 小队表现：池内比值 ── */
  const wk = w[kind] as unknown as Record<string, number | undefined>;
  const parts: Record<string, number> = {};
  const add = (label: string, weight: number | undefined, v: number): void => {
    if (typeof weight === 'number' && weight !== 0) parts[label] = weight * v;
  };
  add('小队击杀', wk['kill'], ratioNorm(ctx.squad.kill, ctx.ranges.kill));
  if (kind !== 'defend') add('小队塔伤', wk['tower'], ratioNorm(ctx.squad.tower, ctx.ranges.tower));
  if (kind === 'guard' || kind === 'defend') add('小队承伤', wk['taken'], ratioNorm(ctx.squad.taken, ctx.ranges.taken));
  add('低死亡', wk['lowDeath'], lowDeathScore(ctx.squad.avgDeaths, ctx.matchAvgDeaths));

  const wSum = Object.values(wk).reduce<number>((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const perf = wSum > 0 ? sum(Object.values(parts)) / wSum : 0;

  const share = typeof w.anchorShare === 'number' ? Math.max(0, Math.min(1, w.anchorShare)) : 0.3;
  parts['对局加成'] = share * anchor;
  parts['小队表现'] = (1 - share) * perf;
  const score = Math.max(0, Math.min(1, share * anchor + (1 - share) * perf));
  return { score, parts };
}

/**
 * 计算一场比赛的所有个人分数。
 * 只计算 state='PLAY' 的行（替补/请假不参与评分）。
 */
export function scoreMatch(input: MatchScoreInput, rule: RuleSet): MatchScoreOutput {
  const players = input.rows.filter((r) => r.state === 'PLAY');
  const towers = Math.max(1, rule.totalTowers);
  const pushProgress = Math.max(0, Math.min(1, (towers - input.oppTowersLeft) / towers));
  const keepRate = Math.max(0, Math.min(1, input.ourTowersLeft / towers));
  const flag = input.result === 'WIN' ? 1 : input.result === 'DRAW' ? 0.5 : 0;

  // 有效值
  const eff = players.map((p) => ({ row: p, e: deriveEffective(p.stat) }));

  // 联盟汇总（排除请假/替补已由上面的 filter 完成）
  const league: Record<string, number> = {
    kill: sum(eff.map((x) => x.e.effKills)),
    dmg: sum(eff.map((x) => x.e.effDmg)),
    tower: sum(eff.map((x) => x.e.effTower)),
    assist: sum(eff.map((x) => x.e.assist)),
    heal: sum(eff.map((x) => x.e.heal)),
    taken: sum(eff.map((x) => x.e.taken)),
    death: sum(eff.map((x) => x.e.death)),
    revive: sum(eff.map((x) => x.e.revive)),
    fountain: sum(eff.map((x) => x.e.fountain)),
    bone: sum(eff.map((x) => x.e.bone)),
    resource: sum(eff.map((x) => x.e.resource)),
  };

  // 个人原始加权（占比 = 个人 / 联盟）
  const personalRaw = eff.map((x) => {
    /* 权重按**职业**取（用户 2026-10-24）；老规则集只有 DPS/T/HEAL 三档 → 回落定位 ✓ */
    const w = (rule.personalWeights[x.row.classUsed]
      ?? rule.personalWeights[x.row.role]
      ?? {}) as PersonalWeights;
    /* 职业系数进**单项**（用户 2026-10-24：「系数只放在单项数据里，整体分数不再加系数」）：
       每项 = 系数 × 个人有效值 ÷ 联盟该项总和 → 系数影响的是"自己的数据"，最后不再整体再乘一次 */
    const ratio = (key: string): number => coefOf(rule, x.row.classUsed) * safeDiv(
      (x.e as unknown as Record<string, number>)[keyToEff(key)] ?? 0,
      league[keyToLeague(key)] ?? 0,
    );
    return { x, raw: weighted(w as Record<string, number | undefined>, ratio) };
  });

  const rawValues = personalRaw.map((p) => p.raw);
  /* 满量程参考值的兜底：规则集没给就用本场最大 FN（仅为不发生除零，正常都走规则集） */
  const rawHi = rawValues.length ? Math.max(...rawValues, 0) : 0;

  // 小队聚合（用于战术执行分）
  const bySquad = new Map<string, ScoreInputRow[]>();
  for (const p of players) {
    if (!p.squad) continue;
    if (!bySquad.has(p.squad)) bySquad.set(p.squad, []);
    bySquad.get(p.squad)!.push(p);
  }
  const squadAgg = new Map<string, { kill: number; tower: number; taken: number; avgDeaths: number }>();
  for (const [squad, list] of bySquad) {
    const es = list.map((p) => deriveEffective(p.stat));
    squadAgg.set(squad, {
      kill: sum(es.map((e) => e.effKills)),
      tower: sum(es.map((e) => e.effTower)),
      taken: sum(es.map((e) => e.taken)),
      avgDeaths: list.length ? sum(es.map((e) => e.death)) / list.length : 0,
    });
  }

  // 战术执行分只在「同战术类型」的小队之间做横向归一
  const rangeByKind = new Map<'push' | 'guard' | 'defend', {
    kill: number[]; tower: number[]; taken: number[]; avgDeaths: number[];
  }>();
  for (const kind of ['push', 'guard', 'defend'] as const) {
    const aggs = [...bySquad.entries()]
      .filter(([, list]) => tacticKind((list[0]?.tactic ?? '') as Tactic) === kind)
      .map(([squad]) => squadAgg.get(squad)!);
    rangeByKind.set(kind, {
      kill: aggs.map((a) => a.kill),
      tower: aggs.map((a) => a.tower),
      taken: aggs.map((a) => a.taken),
      avgDeaths: aggs.map((a) => a.avgDeaths),
    });
  }

  // 每个小队的团队分
  const teamScoreBySquad = new Map<string, { score: number; parts: Record<string, number> }>();
  for (const [squad, list] of bySquad) {
    const kind = tacticKind((list[0]?.tactic ?? '') as Tactic);
    const agg = squadAgg.get(squad)!;
    const ranges = rangeByKind.get(kind)!;
    const r = execScore(kind, rule.execWeights, {
      pushProgress, flag, keepRate,
      matchAvgDeaths: players.length ? league.death / players.length : 0,
      squad: agg, ranges,
    });
    teamScoreBySquad.set(squad, r);
  }

  /* 各阵组的平均重伤（按人头加权）：进攻 vs 防守 */
  const groupOf = (tactic: string): 'attack' | 'defend' => (tactic === '防守' ? 'defend' : 'attack');
  const gDeath = { attack: { sum: 0, n: 0 }, defend: { sum: 0, n: 0 } };
  for (const p of players) {
    const g = groupOf(p.tactic ?? '');
    gDeath[g].sum += deriveEffective(p.stat).death;
    gDeath[g].n += 1;
  }
  const overallAvgDeaths = players.length ? league.death / players.length : 0;
  const avgDeathsByGroup = (tactic: string): number => {
    const g = gDeath[groupOf(tactic)];
    return g.n > 0 ? g.sum / g.n : overallAvgDeaths;
  };

  const lines: ScoreLine[] = personalRaw.map(({ x, raw }) => {
    const role = x.row.role;
    const coef = coefOf(rule, x.row.classUsed);
    /* 满量程参考值按**职业**取（用户 2026-10-24 选 A：个人分 = 同职业内排名）；
       老规则集只有 DPS/T/HEAL 三键 → 回落定位 ✓ */
    const refForClass = rule.personalRef?.[x.row.classUsed] ?? rule.personalRef?.[role] ?? 0;
    const ref = refForClass > 0 ? refForClass : (rawHi > 0 ? rawHi : 1);
    const gamma = rule.personalGamma > 0 ? rule.personalGamma : 1;
    const personalRatio = personalCurve(raw, ref, gamma);
    /* 系数已经在单项里作用过，这里不再乘（用户 2026-10-24） */
    const personalScore = personalRatio * rule.scalePersonal;

    const team = x.row.squad ? teamScoreBySquad.get(x.row.squad) : undefined;
    const teamScore = (team?.score ?? 0) * rule.scaleTeam;

    /* 附加分 = 规则给的（备注角色）+ 手动赋分（人为补的，可正可负） */
    const manual = x.row.manualBonus ?? 0;
    const bonus = (rule.bonus[x.row.noteRole] ?? BONUS_POINTS[x.row.noteRole] ?? 0) + manual;

    // 死亡扣分：与全场上场者的平均死亡比较，超出部分按系数扣；**封顶**避免一场打崩扣穿地板
    /* 2026-10-24：基准改成**同阵组内平均**（进攻内部比、防守内部比）——
       以前跟全场上场者平均比，但进攻天生冲脸、死得多，等于系统性多扣 ✗ */
    const avgDeaths = avgDeathsByGroup(x.row.tactic);
    const deathPenalty = Math.min(
      rule.deathPenCap > 0 ? rule.deathPenCap : Number.POSITIVE_INFINITY,
      Math.max(0, (x.e.death - avgDeaths) * rule.deathPen),
    );

    /* 总分（规范 v1.0 §2.7）：总分 = MIN(60 + 团队 + 个人 + 附加 − 重伤扣分, 100)
       ⚠️ 只有**上封顶**，没有 0 下限 —— 零贡献 + 重伤扣分可以低于 60（规范 §2.8 的"最低分 49.30"就是这么来的）*/
    const total = Math.min(
      rule.baseScore + teamScore + personalScore + bonus - deathPenalty,
      rule.capScore,
    );

    return {
      participationId: x.row.participationId,
      playerId: x.row.playerId,
      playerName: x.row.playerName,
      role,
      squad: x.row.squad,
      personalScore,
      teamScore,
      bonus,
      deathPenalty,
      total,
      detail: {
        有效击杀: x.e.effKills,
        有效人伤: x.e.effDmg,
        有效塔伤: x.e.effTower,
        助攻: x.e.assist,
        治疗: x.e.heal,
        承伤: x.e.taken,
        重伤: x.e.death,
        复活: x.e.revive,
        个人原始加权: Number(raw.toFixed(6)),
        个人曲线: Number(personalRatio.toFixed(4)),
        满量程FN: Number(ref.toFixed(6)),
        职业系数: coef,
        手动赋分: manual,
        战术类型: tacticKind((x.row.tactic ?? '') as Tactic),
        小队执行分: Number((team?.score ?? 0).toFixed(4)),
        分会项: JSON.stringify(team?.parts ?? {}),
      },
    };
  });

  return { matchId: input.matchId, lines, engine: ENGINE_ID };
}

/** 个人权重里的键 → 有效值字段名 */
function keyToEff(key: string): string {
  const map: Record<string, string> = {
    kill: 'effKills', dmg: 'effDmg', tower: 'effTower',
    assist: 'assist', fountain: 'fountain', bone: 'bone',
    heal: 'heal', taken: 'taken', revive: 'revive', resource: 'resource',
  };
  return map[key] ?? key;
}

/** 个人权重里的键 → 联盟汇总的键 */
function keyToLeague(key: string): string {
  const map: Record<string, string> = {
    kill: 'kill', dmg: 'dmg', tower: 'tower', assist: 'assist',
    fountain: 'fountain', bone: 'bone', heal: 'heal', taken: 'taken', revive: 'revive',
    resource: 'resource',
  };
  return map[key] ?? key;
}

/**
 * 个人换算比例（引擎 v2.1）：比例曲线 FO = min(1, (FN / personalRef) ^ γ)。
 *
 * **为什么从饱和曲线改成比例曲线**（2026-10-24 用户指出"个人分这么算的"）：
 *   FN 的实际取值范围只有 0~0.195（两个真实数据集实测：P50≈0.09、P90≈0.15、max≈0.19），
 *   而饱和曲线 FN/(FN+half) 在 half=0.1 时把所有 FN 映射到 0.17~0.61 ✗ ——
 *   结果个人分永远只用到 0~40 里的 7~26 分，**满分档形同虚设** ✗。
 *   比例曲线以"参考值"为满量程：FN = personalRef → 满 1.0；超过就封顶（说明"已到顶尖水平"）。
 *   仍然**绝对**（参考值是规则集里的常数，不看同场其他人）→ 跨场可比 ✓
 *
 * 为什么不用"同场 Min-Max 归一"（规范 v1.0）：
 *   那样个人分 = (FN − 同场最低) / (同场最高 − 同场最低) ✗ 取决于**同场其他人的极值** ——
 *   同一份战报，队友越猛你越低；换一场分数就变；一场里出了个怪物，全队都被压平。
 *   联赛要跨场比，个人分必须是**绝对**的。
 *
 * 性质：FN=0 → 0（零贡献不得负分 ✓）；FN=personalRef → 1（满量程）；单调、有界 [0,1]；
 * γ<1 抬高中间段、γ>1 压低中间段。参考值与 γ 由 scripts/score-calibrate.mjs 用真实战报标定。
 */
function personalCurve(fn: number, ref: number, gamma: number): number {
  if (!(fn > 0)) return 0;
  const r = ref > 0 ? ref : 1;
  const g = gamma > 0 ? gamma : 1;
  const v = g === 1 ? fn / r : Math.pow(fn / r, g);
  return v > 1 ? 1 : v;
}













