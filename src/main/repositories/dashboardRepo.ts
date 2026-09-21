/**
 * 数据统计仓储（M6 看板的数据来源）
 *
 * 刻意先把「不需要评分算法」的部分做满：
 *   出勤（谁常来 / 谁总缺）、战报完整度、阵容分配、维度覆盖、职业分布、近期场次
 * 等评分口径定了再接 score 表（届时只加方法，不改现有结构）。
 */
import type { SqlDatabase } from '../db';
import type {
  AttendanceRow, DashboardData, MatchRowStat, PlayerDetail, PlayerMatchRow, RadarAxis,
} from '../../shared/types';
import { EMPTY_COMBAT_STAT, deriveEffective } from '../../shared/domain';

export type { AttendanceRow, DashboardData, MatchRowStat };

/** 雷达图的六个维度：取"能体现个人职责"的项，T/治疗也各有关注点 */
const RADAR_DEF: { key: string; label: string; pick: (m: PlayerMatchRow) => number }[] = [
  { key: 'kill', label: '有效击杀', pick: (m) => m.effKills },
  { key: 'dmg', label: '有效人伤', pick: (m) => m.effDmg },
  { key: 'tower', label: '有效塔伤', pick: (m) => m.effTower },
  { key: 'assist', label: '助攻', pick: (m) => m.assists },
  { key: 'heal', label: '治疗量', pick: (m) => m.healing },
  { key: 'taken', label: '承伤', pick: (m) => m.taken },
];

const METRIC_LABELS: { key: string; label: string }[] = [
  { key: 'kills', label: '击败' },
  { key: 'fountain_kills', label: '清泉' },
  { key: 'assists', label: '助攻' },
  { key: 'resource', label: '资源' },
  { key: 'dmg_player', label: '对玩家伤害' },
  { key: 'dmg_player_armor', label: '人伤卸甲' },
  { key: 'dmg_building', label: '对建筑伤害' },
  { key: 'dmg_building_armor', label: '破塔卸甲' },
  { key: 'healing', label: '治疗值' },
  { key: 'damage_taken', label: '承受伤害' },
  { key: 'deaths', label: '重伤' },
  { key: 'revives', label: '复活' },
  { key: 'bone_burn', label: '焚骨' },
];

export class DashboardRepo {
  constructor(private db: SqlDatabase) {}

  /**
   * 个人详情：逐场记录 + 汇总 + 六维雷达（对比球队人均）。
   * 只统计「我方 + 上场」的记录；未填战报的场次计入出勤但不计入数值汇总。
   */
  playerDetail(playerId: number): PlayerDetail {
    const pl = this.db.prepare('SELECT * FROM player WHERE id = ?').get(playerId) as unknown as {
      id: number; game_id: string; name: string; joined_order: number | null;
      mic: string; note_role: string;
      status: string; remark: string; created_at: string; updated_at: string;
    } | undefined;
    if (!pl) throw new Error(`成员不存在：id=${playerId}`);

    const raw = this.db.prepare(`
      SELECT m.id AS match_id, m.date, m.index_in_day, m.our_side, m.opp_side, m.result,
             p.squad, p.tactic, p.class_used, p.state,
             CASE WHEN cs.participation_id IS NULL THEN 0 ELSE 1 END AS has_stat,
             COALESCE(cs.kills,0) AS kills, COALESCE(cs.fountain_kills,0) AS fountain_kills,
             COALESCE(cs.assists,0) AS assists,
             COALESCE(cs.dmg_player,0) AS dmg_player, COALESCE(cs.dmg_player_armor,0) AS dmg_player_armor,
             COALESCE(cs.dmg_building,0) AS dmg_building, COALESCE(cs.dmg_building_armor,0) AS dmg_building_armor,
             COALESCE(cs.healing,0) AS healing, COALESCE(cs.damage_taken,0) AS damage_taken,
             COALESCE(cs.deaths,0) AS deaths, COALESCE(cs.revives,0) AS revives,
             COALESCE(cs.bone_burn,0) AS bone_burn
      FROM participation p
      JOIN match m ON m.id = p.match_id
      LEFT JOIN combat_stat cs ON cs.participation_id = p.id
      WHERE p.player_id = ? AND p.side = 'our'
      ORDER BY m.date DESC, m.index_in_day DESC, m.id DESC
    `).all(playerId) as unknown as {
      match_id: number; date: string; index_in_day: number; our_side: string; opp_side: string;
      result: string; squad: string; tactic: string; class_used: string; state: string; has_stat: number;
      kills: number; fountain_kills: number; assists: number;
      dmg_player: number; dmg_player_armor: number; dmg_building: number; dmg_building_armor: number;
      healing: number; damage_taken: number; deaths: number; revives: number; bone_burn: number;
    }[];

    const rows: PlayerMatchRow[] = raw.map((r) => {
      const eff = deriveEffective({
        ...EMPTY_COMBAT_STAT,
        kills: r.kills, fountainKills: r.fountain_kills, assists: r.assists,
        dmgPlayer: r.dmg_player, dmgPlayerArmor: r.dmg_player_armor,
        dmgBuilding: r.dmg_building, dmgBuildingArmor: r.dmg_building_armor,
        healing: r.healing, damageTaken: r.damage_taken, deaths: r.deaths,
        revives: r.revives, boneBurn: r.bone_burn,
      });
      return {
        matchId: r.match_id,
        date: r.date,
        indexInDay: Number(r.index_in_day),
        matchLabel: `${r.date} -${r.index_in_day}`,
        ourSide: r.our_side,
        oppSide: r.opp_side,
        result: r.result,
        squad: r.squad || '',
        tactic: r.tactic || '',
        classUsed: r.class_used || '',
        state: (r.state || 'PLAY') as PlayerMatchRow['state'],
        statFilled: Number(r.has_stat) === 1,
        effKills: eff.effKills,
        assists: eff.assist,
        effDmg: eff.effDmg,
        effTower: eff.effTower,
        healing: eff.heal,
        taken: eff.taken,
        deaths: eff.death,
        revives: eff.revive,
        fountain: eff.fountain,
        bone: eff.bone,
      };
    });

    // 球队人均基准：所有我方上场记录（含未填战报的 0）的人均值
    const team = this.db.prepare(`
      SELECT COUNT(*) AS n,
             AVG(COALESCE(cs.kills,0) + COALESCE(cs.fountain_kills,0)) AS eff_kills,
             AVG(COALESCE(cs.assists,0)) AS assists,
             AVG(COALESCE(cs.dmg_player,0) + COALESCE(cs.dmg_player_armor,0)) AS eff_dmg,
             AVG(COALESCE(cs.dmg_building,0) + COALESCE(cs.dmg_building_armor,0)) AS eff_tower,
             AVG(COALESCE(cs.healing,0)) AS healing,
             AVG(COALESCE(cs.damage_taken,0)) AS taken,
             AVG(COALESCE(cs.deaths,0)) AS deaths
      FROM participation p LEFT JOIN combat_stat cs ON cs.participation_id = p.id
      WHERE p.side = 'our' AND p.state = 'PLAY'
    `).get() as unknown as {
      n: number; eff_kills: number | null; assists: number | null; eff_dmg: number | null;
      eff_tower: number | null; healing: number | null; taken: number | null; deaths: number | null;
    };
    const num = (v: number | null): number => (v === null || !Number.isFinite(v) ? 0 : Number(v));
    const teamAverage = {
      effKills: num(team.eff_kills),
      assists: num(team.assists),
      effDmg: num(team.eff_dmg),
      effTower: num(team.eff_tower),
      healing: num(team.healing),
      taken: num(team.taken),
      deaths: num(team.deaths),
    };

    const filled = rows.filter((r) => r.state === 'PLAY' && r.statFilled);
    const sum = (pick: (m: PlayerMatchRow) => number): number =>
      filled.reduce((n, m) => n + pick(m), 0);

    const totals = {
      matches: rows.length,
      plays: rows.filter((r) => r.state === 'PLAY').length,
      benches: rows.filter((r) => r.state === 'BENCH').length,
      leaves: rows.filter((r) => r.state === 'LEAVE').length,
      statFilled: filled.length,
      effKills: sum((m) => m.effKills),
      assists: sum((m) => m.assists),
      effDmg: sum((m) => m.effDmg),
      effTower: sum((m) => m.effTower),
      healing: sum((m) => m.healing),
      taken: sum((m) => m.taken),
      deaths: sum((m) => m.deaths),
      revives: sum((m) => m.revives),
    };

    // 雷达用「本人均值 vs 球队均值」，避免场次多的人被总量拉高
    const n = Math.max(1, filled.length);
    const selfAvg: Record<string, number> = {
      kill: totals.effKills / n,
      dmg: totals.effDmg / n,
      tower: totals.effTower / n,
      assist: totals.assists / n,
      heal: totals.healing / n,
      taken: totals.taken / n,
    };
    const teamAvg: Record<string, number> = {
      kill: teamAverage.effKills,
      dmg: teamAverage.effDmg,
      tower: teamAverage.effTower,
      assist: teamAverage.assists,
      heal: teamAverage.healing,
      taken: teamAverage.taken,
    };
    const radar: RadarAxis[] = RADAR_DEF.map((d) => {
      const self = selfAvg[d.key] ?? 0;
      const base = teamAvg[d.key] ?? 0;
      return {
        key: d.key,
        label: d.label,
        self,
        teamAvg: base,
        ratio: base > 0 ? self / base : 0,
      };
    });

    return {
      player: {
        id: pl.id,
        gameId: pl.game_id,
        name: pl.name,
        joinedOrder: pl.joined_order,
        mic: (pl.mic || '') as PlayerDetail['player']['mic'],
        noteRole: (pl.note_role || '') as PlayerDetail['player']['noteRole'],
        status: pl.status || 'active',
        remark: pl.remark || '',
        createdAt: pl.created_at,
        updatedAt: pl.updated_at,
      },
      totals,
      matches: rows,
      radar,
      teamAverage,
    };
  }

  load(): DashboardData {
    const sc = (sql: string, ...args: (string | number)[]): number => {
      const r = this.db.prepare(sql).get(...args) as { c: number } | undefined;
      return Number(r?.c ?? 0);
    };

    const matches = sc('SELECT COUNT(*) AS c FROM match');
    const players = sc('SELECT COUNT(*) AS c FROM player');
    const participations = sc('SELECT COUNT(*) AS c FROM participation');
    const statFilled = sc(`
      SELECT COUNT(*) AS c FROM participation p
      JOIN combat_stat cs ON cs.participation_id = p.id
      WHERE (cs.kills + cs.fountain_kills + cs.assists + cs.resource + cs.dmg_player
             + cs.dmg_player_armor + cs.dmg_building + cs.dmg_building_armor + cs.healing
             + cs.damage_taken + cs.deaths + cs.revives + cs.bone_burn) > 0`);
    const statSlots = sc("SELECT COUNT(*) AS c FROM participation WHERE side = 'our' AND state = 'PLAY'");

    const matchRows = (this.db.prepare(`
      SELECT m.id, m.date, m.index_in_day, m.result, m.our_side, m.opp_side,
             SUM(CASE WHEN p.side='our' AND p.state='PLAY' THEN 1 ELSE 0 END) AS our_cnt,
             SUM(CASE WHEN p.side='our' AND p.state='PLAY' AND cs.participation_id IS NOT NULL
                       AND (cs.kills + cs.fountain_kills + cs.assists + cs.resource + cs.dmg_player
                            + cs.dmg_player_armor + cs.dmg_building + cs.dmg_building_armor + cs.healing
                            + cs.damage_taken + cs.deaths + cs.revives + cs.bone_burn) > 0
                      THEN 1 ELSE 0 END) AS stat_cnt
      FROM match m
      LEFT JOIN participation p ON p.match_id = m.id
      LEFT JOIN combat_stat cs ON cs.participation_id = p.id
      GROUP BY m.id
      ORDER BY m.date DESC, m.index_in_day DESC
      LIMIT 30
    `).all() as unknown as {
      id: number; date: string; index_in_day: number; result: string;
      our_side: string; opp_side: string; our_cnt: number; stat_cnt: number;
    }[]).map((r): MatchRowStat => ({
      matchId: r.id,
      label: `${r.date} -${r.index_in_day}`,
      date: r.date,
      result: r.result,
      ourSide: r.our_side,
      oppSide: r.opp_side,
      ourCount: Number(r.our_cnt ?? 0),
      statFilled: Number(r.stat_cnt ?? 0),
    }));

    // 出勤：以「所有成员」为基准，左连接参战记录
    const attendanceRows = this.db.prepare(`
      SELECT pl.id, pl.game_id, pl.name, pl.note_role, pl.status,
             COALESCE((
               SELECT sg.main_class FROM signup sg
                JOIN match m2 ON m2.id = sg.match_id
                WHERE sg.player_id = pl.id AND sg.main_class <> ''
                ORDER BY m2.date DESC, m2.index_in_day DESC LIMIT 1
             ), '') AS main_class,
             COALESCE(SUM(CASE WHEN p.state='PLAY' THEN 1 ELSE 0 END), 0) AS plays,
             COALESCE(SUM(CASE WHEN p.state='BENCH' THEN 1 ELSE 0 END), 0) AS benches,
             COALESCE(SUM(CASE WHEN p.state='LEAVE' THEN 1 ELSE 0 END), 0) AS leaves,
             COUNT(p.id) AS matches,
             COALESCE(SUM(CASE WHEN p.state='PLAY' AND cs.participation_id IS NOT NULL
                     AND (cs.kills + cs.fountain_kills + cs.assists + cs.resource + cs.dmg_player
                          + cs.dmg_player_armor + cs.dmg_building + cs.dmg_building_armor + cs.healing
                          + cs.damage_taken + cs.deaths + cs.revives + cs.bone_burn) > 0
                     THEN 1 ELSE 0 END), 0) AS filled
      FROM player pl
      LEFT JOIN participation p ON p.player_id = pl.id AND p.side = 'our'
      LEFT JOIN combat_stat cs ON cs.participation_id = p.id
      GROUP BY pl.id
      ORDER BY plays DESC, pl.joined_order IS NULL, pl.joined_order, pl.id
    `).all() as unknown as {
      id: number; game_id: string; name: string; main_class: string | null; note_role: string;
      status: string; plays: number; benches: number; leaves: number; matches: number; filled: number;
    }[];

    const attendance: AttendanceRow[] = attendanceRows.map((r) => ({
      playerId: r.id,
      gameId: r.game_id,
      name: r.name,
      mainClass: r.main_class ?? '',
      noteRole: r.note_role,
      status: r.status,
      matches: Number(r.matches),
      plays: Number(r.plays),
      benches: Number(r.benches),
      leaves: Number(r.leaves),
      rate: matches > 0 ? Number(r.plays) / matches : 0,
      filled: Number(r.filled),
    }));

    const classPlayCount = (this.db.prepare(`
      SELECT COALESCE(NULLIF(p.class_used, ''), (
               SELECT sg.main_class FROM signup sg
                JOIN match m2 ON m2.id = sg.match_id
                WHERE sg.player_id = pl.id AND sg.main_class <> ''
                ORDER BY m2.date DESC, m2.index_in_day DESC LIMIT 1
             ), '') AS cls,
             COUNT(*) AS c
      FROM participation p JOIN player pl ON pl.id = p.player_id
      WHERE p.side = 'our' AND p.state = 'PLAY'
      GROUP BY cls ORDER BY c DESC
    `).all() as unknown as { cls: string | null; c: number }[])
      .filter((r) => r.cls)
      .map((r) => {
        const c = this.db.prepare('SELECT color FROM class WHERE name = ?').get(r.cls) as { color: string } | undefined;
        return { name: r.cls as string, color: c?.color ?? '#6b7383', plays: Number(r.c) };
      });

    const squadUsage = (this.db.prepare(`
      SELECT p.squad, COUNT(*) AS c,
             COALESCE(g.kind, '') AS kind,
             COALESCE(g.name, '') AS group_name
      FROM participation p
      LEFT JOIN squad s ON s.name = p.squad
      LEFT JOIN combat_group g ON g.id = s.group_id
      WHERE p.side = 'our' AND p.state = 'PLAY' AND p.squad <> ''
      GROUP BY p.squad ORDER BY c DESC
    `).all() as unknown as { squad: string; c: number; kind: string; group_name: string }[])
      .map((r) => ({ squad: r.squad, group: r.group_name, kind: r.kind, plays: Number(r.c) }));

    // 各战报维度的非零覆盖：能看出哪些列被整列漏填
    const metricCoverage = METRIC_LABELS.map(({ key, label }) => {
      const nonZero = sc(`SELECT COUNT(*) AS c FROM combat_stat cs
                          JOIN participation p ON p.id = cs.participation_id
                          WHERE p.side='our' AND p.state='PLAY' AND cs.${key} > 0`);
      return { key, label, nonZero, total: statSlots };
    });

    return {
      totals: {
        matches,
        players,
        participations,
        statFilled,
        statSlots,
        statRate: statSlots > 0 ? statFilled / statSlots : 0,
        avgLineup: matches > 0
          ? matchRows.reduce((n, m) => n + m.ourCount, 0) / matchRows.length
          : 0,
      },
      matches: matchRows,
      attendance,
      classPlayCount,
      squadUsage,
      metricCoverage,
    };
  }
}
