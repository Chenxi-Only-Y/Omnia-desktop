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

export const ENGINE_ID = 'omnia-default-v1';

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);
const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/** 某一组权重（可能缺键）的和 */
const weightSum = (w: Record<string, number | undefined>): number =>
  sum(Object.values(w).map((v) => (typeof v === 'number' ? v : 0)));

/**
 * 按「权重 × 占比」求和。
 * 权重里没出现的键视为"该定位不使用这一项"（不参与计算）。
 * 若权重和不为 1，按权重和归一，避免规则未归一化时量级漂移。
 */
function weighted(w: Record<string, number | undefined>, ratio: (key: string) => number): number {
  const total = weightSum(w);
  if (total <= 0) return 0;
  let acc = 0;
  for (const [k, v] of Object.entries(w)) {
    if (typeof v !== 'number' || v === 0) continue;
    acc += v * ratio(k);
  }
  return acc / total;
}

/** Min-Max 归一（只在正值之间取范围；结果裁剪到 [0,1]） */
function minMax(value: number, values: number[]): number {
  const pos = values.filter((v) => v > 0);
  if (!pos.length || value <= 0) return 0;
  const lo = Math.min(...pos);
  const hi = Math.max(...pos);
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

/** 某一战术类型下的执行分（0~1） */
function execScore(
  kind: 'push' | 'guard' | 'defend',
  w: ExecWeights,
  ctx: {
    pushProgress: number;
    flag: number;
    keepRate: number;
    squad: { kill: number; tower: number; taken: number; avgDeaths: number };
    ranges: {
      kill: number[]; tower: number[]; taken: number[]; avgDeaths: number[];
    };
  },
): { score: number; parts: Record<string, number> } {
  const norm = (v: number, arr: number[], invert = false): number => {
    const n = minMax(v, arr);
    return invert ? 1 - n : n;
  };
  const parts: Record<string, number> = {};
  let score = 0;

  if (kind === 'push') {
    const wp = w.push;
    const f1 = ctx.pushProgress;
    const f2 = ctx.flag;
    const f3 = norm(ctx.squad.tower, ctx.ranges.tower);
    const f4 = norm(ctx.squad.kill, ctx.ranges.kill);
    parts['推塔进度'] = (wp.progress ?? 0) * f1;
    parts['大旗'] = (wp.flag ?? 0) * f2;
    parts['小队塔伤'] = (wp.tower ?? 0) * f3;
    parts['小队击杀'] = (wp.kill ?? 0) * f4;
    score = sum(Object.values(parts));
  } else if (kind === 'guard') {
    const wg = w.guard;
    const f1 = norm(ctx.squad.kill, ctx.ranges.kill);
    const f2 = norm(ctx.squad.taken, ctx.ranges.taken);
    const f3 = norm(ctx.squad.avgDeaths, ctx.ranges.avgDeaths, true);
    parts['小队击杀'] = (wg.kill ?? 0) * f1;
    parts['小队承伤'] = (wg.taken ?? 0) * f2;
    parts['低死亡'] = (wg.lowDeath ?? 0) * f3;
    score = sum(Object.values(parts));
  } else {
    const wd = w.defend;
    const f1 = ctx.keepRate;
    const f2 = norm(ctx.squad.kill, ctx.ranges.kill);
    const f3 = norm(ctx.squad.avgDeaths, ctx.ranges.avgDeaths, true);
    parts['守塔率'] = (wd.keepRate ?? 0) * f1;
    parts['小队击杀'] = (wd.kill ?? 0) * f2;
    parts['低死亡'] = (wd.lowDeath ?? 0) * f3;
    score = sum(Object.values(parts));
  }

  // 权重和不为 1 时归一
  const total = weightSum(
    kind === 'push' ? w.push : kind === 'guard' ? w.guard : w.defend,
  );
  return { score: total > 0 ? score / total : 0, parts };
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
  };

  // 个人原始加权（占比 = 个人 / 联盟）
  const personalRaw = eff.map((x) => {
    const w = (rule.personalWeights[x.row.role] ?? {}) as PersonalWeights;
    const ratio = (key: string): number => safeDiv(
      (x.e as unknown as Record<string, number>)[keyToEff(key)] ?? 0,
      league[keyToLeague(key)] ?? 0,
    );
    return { x, raw: weighted(w as Record<string, number | undefined>, ratio) };
  });

  const rawValues = personalRaw.map((p) => p.raw);
  const rawMin = Math.min(...rawValues.filter((v) => v > 0), 0);
  const rawMax = Math.max(...rawValues, 1);

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
      pushProgress, flag, keepRate, squad: agg, ranges,
    });
    teamScoreBySquad.set(squad, r);
  }

  const lines: ScoreLine[] = personalRaw.map(({ x, raw }) => {
    const role = x.row.role;
    const coef = rule.classCoef[x.row.classUsed] ?? 0;
    const personalRatio = rawMax > rawMin
      ? Math.max(0, Math.min(1, (raw - rawMin) / (rawMax - rawMin)))
      : 0;
    const personalScore = personalRatio * rule.scalePersonal * coef;

    const team = x.row.squad ? teamScoreBySquad.get(x.row.squad) : undefined;
    const teamScore = (team?.score ?? 0) * rule.scaleTeam;

    const bonus = rule.bonus[x.row.noteRole] ?? BONUS_POINTS[x.row.noteRole] ?? 0;

    // 死亡扣分：与全场上场者的平均死亡比较，超出部分按系数扣
    const avgDeaths = players.length ? league.death / players.length : 0;
    const deathPenalty = Math.max(0, (x.e.death - avgDeaths) * rule.deathPen);

    const total = Math.min(
      Math.max(rule.baseScore + teamScore + personalScore + bonus - deathPenalty, 0),
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
        个人归一: Number(personalRatio.toFixed(4)),
        职业系数: coef,
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
    heal: 'heal', taken: 'taken', revive: 'revive',
  };
  return map[key] ?? key;
}

/** 个人权重里的键 → 联盟汇总的键 */
function keyToLeague(key: string): string {
  const map: Record<string, string> = {
    kill: 'kill', dmg: 'dmg', tower: 'tower', assist: 'assist',
    fountain: 'fountain', bone: 'bone', heal: 'heal', taken: 'taken', revive: 'revive',
  };
  return map[key] ?? key;
}
