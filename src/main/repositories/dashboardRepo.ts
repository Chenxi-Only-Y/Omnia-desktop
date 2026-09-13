/**
 * 数据统计仓储（M6 看板的数据来源）
 *
 * 刻意先把「不需要评分算法」的部分做满：
 *   出勤（谁常来 / 谁总缺）、战报完整度、阵容分配、维度覆盖、职业分布、近期场次
 * 等评分口径定了再接 score 表（届时只加方法，不改现有结构）。
 */
import type { SqlDatabase } from '../db';
import type {
  AttendanceRow, DashboardData, MatchRowStat,
} from '../../shared/types';

export type { AttendanceRow, DashboardData, MatchRowStat };

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
      SELECT pl.id, pl.game_id, pl.name, pl.main_class, pl.note_role, pl.status,
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
      id: number; game_id: string; name: string; main_class: string; note_role: string;
      status: string; plays: number; benches: number; leaves: number; matches: number; filled: number;
    }[];

    const attendance: AttendanceRow[] = attendanceRows.map((r) => ({
      playerId: r.id,
      gameId: r.game_id,
      name: r.name,
      mainClass: r.main_class,
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
      SELECT COALESCE(NULLIF(p.class_used, ''), NULLIF(pl.main_class, '')) AS cls,
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
