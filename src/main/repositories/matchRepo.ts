/**
 * 对局与战报仓储（M3）
 *
 * 数据流向（对齐原表）：
 *   对局级 5 字段（日期/场次/胜负/我方剩余塔/敌方剩余塔）
 *     → participation（谁上场、在哪个小队、用什么职业）
 *     → combat_stat（14 项战报）
 * 参战名单默认从上一场的阵容继承（原表是手工维护「排表」，这里做成一键继承）。
 */
import type { SqlDatabase, SqlValue } from '../db';
import type {
  CombatStat, Match, MatchInput, MatchSummary, NoteRole, PartState,
  ParticipationInput, ParticipationRow,
} from '../../shared/types';
import { BENCH_SQUADS, EMPTY_COMBAT_STAT, findClass, tacticKind } from '../../shared/domain';
import { SquadRepo } from './squadRepo';

interface MatchRow {
  id: number; season_id: number | null; date: string; index_in_day: number;
  our_side: string; opp_side: string; result: string;
  our_towers_left: number; opp_towers_left: number;
  state: string; rule_set_id: number | null; remark: string;
  created_at: string; updated_at: string;
}

interface PartRow {
  id: number; match_id: number; player_id: number; side: string;
  squad: string; tactic: string; team_role: string; class_used: string;
  note_role: string; mic: string; state: string;
  game_id: string; name: string; main_class: string;
  kills: number | null; fountain_kills: number | null; assists: number | null;
  resource: number | null; dmg_player: number | null; dmg_player_armor: number | null;
  dmg_building: number | null; dmg_building_armor: number | null;
  healing: number | null; damage_taken: number | null; deaths: number | null;
  revives: number | null; bone_burn: number | null;
  stat_id: number | null;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function toMatch(r: MatchRow): Match {
  return {
    id: r.id,
    seasonId: r.season_id,
    date: r.date,
    indexInDay: n(r.index_in_day),
    ourSide: r.our_side,
    oppSide: r.opp_side,
    result: (r.result || 'WIN') as Match['result'],
    ourTowersLeft: n(r.our_towers_left),
    oppTowersLeft: n(r.opp_towers_left),
    state: r.state || 'draft',
    ruleSetId: r.rule_set_id,
    remark: r.remark || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toStat(r: PartRow): CombatStat {
  if (r.stat_id === null || r.stat_id === undefined) return { ...EMPTY_COMBAT_STAT };
  return {
    kills: n(r.kills), fountainKills: n(r.fountain_kills), assists: n(r.assists),
    resource: n(r.resource), dmgPlayer: n(r.dmg_player), dmgPlayerArmor: n(r.dmg_player_armor),
    dmgBuilding: n(r.dmg_building), dmgBuildingArmor: n(r.dmg_building_armor),
    healing: n(r.healing), damageTaken: n(r.damage_taken), deaths: n(r.deaths),
    revives: n(r.revives), boneBurn: n(r.bone_burn),
  };
}

function hasAnyStat(st: CombatStat): boolean {
  return Object.values(st).some((v) => v !== 0);
}

const STAT_COLUMNS: [keyof CombatStat, string][] = [
  ['kills', 'kills'], ['fountainKills', 'fountain_kills'], ['assists', 'assists'],
  ['resource', 'resource'], ['dmgPlayer', 'dmg_player'], ['dmgPlayerArmor', 'dmg_player_armor'],
  ['dmgBuilding', 'dmg_building'], ['dmgBuildingArmor', 'dmg_building_armor'],
  ['healing', 'healing'], ['damageTaken', 'damage_taken'], ['deaths', 'deaths'],
  ['revives', 'revives'], ['boneBurn', 'bone_burn'],
];

export class MatchRepo {
  private squads: SquadRepo;

  constructor(private db: SqlDatabase) {
    this.squads = new SquadRepo(db);
  }

  // ── 对局 ─────────────────────────────────────────────────────
  list(): MatchSummary[] {
    const rows = this.db.prepare(
      `SELECT * FROM match ORDER BY date DESC, index_in_day DESC, id DESC`,
    ).all() as unknown as MatchRow[];

    const counts = this.db.prepare(
      `SELECT p.match_id,
              SUM(CASE WHEN p.side='our' AND p.state='PLAY' THEN 1 ELSE 0 END) AS our_cnt,
              SUM(CASE WHEN p.side='opp' AND p.state='PLAY' THEN 1 ELSE 0 END) AS opp_cnt,
              SUM(CASE WHEN p.side='our' AND p.state='PLAY' AND cs.participation_id IS NOT NULL
                        AND (cs.kills+cs.fountain_kills+cs.assists+cs.resource+cs.dmg_player
                             +cs.dmg_player_armor+cs.dmg_building+cs.dmg_building_armor+cs.healing
                             +cs.damage_taken+cs.deaths+cs.revives+cs.bone_burn) > 0
                       THEN 1 ELSE 0 END) AS stat_cnt
       FROM participation p
       LEFT JOIN combat_stat cs ON cs.participation_id = p.id
       GROUP BY p.match_id`,
    ).all() as unknown as { match_id: number; our_cnt: number; opp_cnt: number; stat_cnt: number }[];

    const map = new Map(counts.map((c) => [c.match_id, c]));
    return rows.map((r) => {
      const c = map.get(r.id);
      return {
        ...toMatch(r),
        ourCount: n(c?.our_cnt),
        oppCount: n(c?.opp_cnt),
        statFilled: n(c?.stat_cnt),
      };
    });
  }

  get(id: number): Match | undefined {
    const r = this.db.prepare('SELECT * FROM match WHERE id = ?').get(id) as unknown as MatchRow | undefined;
    return r ? toMatch(r) : undefined;
  }

  /** 同日场次号自动递增（原表用 8.15-1 / 8.15-2 这种编号） */
  nextIndexInDay(date: string): number {
    const r = this.db.prepare(
      'SELECT COALESCE(MAX(index_in_day), 0) AS m FROM match WHERE date = ?',
    ).get(date) as { m: number };
    return n(r.m) + 1;
  }

  create(input: MatchInput): Match {
    const date = s(input.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');

    const index = input.indexInDay && input.indexInDay > 0 ? input.indexInDay : this.nextIndexInDay(date);
    const ourSide = s(input.ourSide) || '我方';
    const oppSide = s(input.oppSide) || '对手';

    const dup = this.db.prepare(
      'SELECT id FROM match WHERE date = ? AND index_in_day = ? AND our_side = ? AND opp_side = ?',
    ).get(date, index, ourSide, oppSide);
    if (dup) throw new Error(`${date} 第 ${index} 场（${ourSide} vs ${oppSide}）已存在`);

    const info = this.db.prepare(
      `INSERT INTO match (season_id, date, index_in_day, our_side, opp_side, result,
                          our_towers_left, opp_towers_left, state, remark)
       VALUES ((SELECT CAST(value AS INTEGER) FROM app_setting WHERE key='activeSeasonId'), ?,?,?,?,?,?,?,?,?)`,
    ).run(
      date, index, ourSide, oppSide, s(input.result) || 'WIN',
      this.clampTowers(input.ourTowersLeft), this.clampTowers(input.oppTowersLeft),
      s(input.state) || 'draft',
      s(input.remark),
    );
    const id = Number(info.lastInsertRowid);

    // 对阵双方落表（D6：建「对阵双方」模型）
    const sideStmt = this.db.prepare(
      'INSERT INTO match_side (match_id, side, alliance, is_ours) VALUES (?,?,?,?)',
    );
    sideStmt.run(id, 'our', ourSide, 1);
    sideStmt.run(id, 'opp', oppSide, 0);

    const created = this.get(id);
    if (!created) throw new Error('创建对局失败');
    return created;
  }

  update(id: number, patch: Partial<MatchInput>): Match {
    const cur = this.get(id);
    if (!cur) throw new Error(`对局不存在：id=${id}`);

    const sets: string[] = [];
    const vals: SqlValue[] = [];
    const put = (col: string, v: SqlValue) => { sets.push(`${col} = ?`); vals.push(v); };

    if (patch.date !== undefined) {
      const d = s(patch.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('日期格式应为 YYYY-MM-DD');
      put('date', d);
    }
    if (patch.indexInDay !== undefined) put('index_in_day', Math.max(1, n(patch.indexInDay)));
    if (patch.ourSide !== undefined) put('our_side', s(patch.ourSide));
    if (patch.oppSide !== undefined) put('opp_side', s(patch.oppSide));
    if (patch.result !== undefined) put('result', s(patch.result) || 'WIN');
    if (patch.ourTowersLeft !== undefined) put('our_towers_left', this.clampTowers(patch.ourTowersLeft));
    if (patch.oppTowersLeft !== undefined) put('opp_towers_left', this.clampTowers(patch.oppTowersLeft));
    if (patch.state !== undefined) put('state', s(patch.state) || 'draft');
    if (patch.remark !== undefined) put('remark', s(patch.remark));

    if (!sets.length) return cur;
    sets.push(`updated_at = datetime('now','localtime')`);
    vals.push(id);
    this.db.prepare(`UPDATE match SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const next = this.get(id);
    if (!next) throw new Error('更新对局失败');
    return next;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM match WHERE id = ?').run(id).changes > 0;
  }

  private clampTowers(v: unknown): number {
    const x = n(v);
    return Math.max(0, Math.min(9, Math.round(x)));
  }

  // ── 参战名单 ─────────────────────────────────────────────────
  participations(matchId: number): ParticipationRow[] {
    const rows = this.db.prepare(
      `SELECT p.*, pl.game_id, pl.name, pl.main_class,
              cs.participation_id AS stat_id, cs.kills, cs.fountain_kills, cs.assists, cs.resource,
              cs.dmg_player, cs.dmg_player_armor, cs.dmg_building, cs.dmg_building_armor,
              cs.healing, cs.damage_taken, cs.deaths, cs.revives, cs.bone_burn
       FROM participation p
       JOIN player pl ON pl.id = p.player_id
       LEFT JOIN combat_stat cs ON cs.participation_id = p.id
       WHERE p.match_id = ?
       ORDER BY CASE p.side WHEN 'our' THEN 0 ELSE 1 END,
                CASE WHEN p.squad = '' THEN 1 ELSE 0 END,
                p.squad, pl.joined_order IS NULL, pl.joined_order, pl.id`,
    ).all(matchId) as unknown as PartRow[];

    return rows.map((r): ParticipationRow => {
      const stat = toStat(r);
      return {
        id: r.id,
        matchId: r.match_id,
        playerId: r.player_id,
        gameId: r.game_id,
        name: r.name,
        side: (r.side === 'opp' ? 'opp' : 'our'),
        squad: r.squad || '',
        group: (r.squad || '').replace(/[123]$/, ''),
        tactic: r.tactic || '',
        classUsed: r.class_used || '',
        mainClass: r.main_class || '',
        noteRole: (r.note_role || '') as NoteRole,
        mic: (r.mic || '') as ParticipationRow['mic'],
        state: (r.state || 'PLAY') as PartState,
        stat,
        statFilled: hasAnyStat(stat),
      };
    });
  }

  /**
   * 从上一场（按日期倒序的最近一场）继承我方阵容，方便快速开新场。
   * 返回新建的参战记录数。
   */
  inheritLineupFromPrevious(matchId: number): number {
    const cur = this.get(matchId);
    if (!cur) throw new Error(`对局不存在：id=${matchId}`);

    const prev = this.db.prepare(
      `SELECT id FROM match WHERE id <> ?
       ORDER BY (date < ?) DESC, date DESC, index_in_day DESC, id DESC LIMIT 1`,
    ).get(matchId, cur.date) as { id: number } | undefined;
    if (!prev) return 0;

    const prevRows = this.participations(prev.id).filter((r) => r.side === 'our');
    if (!prevRows.length) return 0;

    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of prevRows) {
        const exists = this.db.prepare(
          'SELECT 1 FROM participation WHERE match_id = ? AND player_id = ? AND side = ?',
        ).get(matchId, r.playerId, 'our');
        if (exists) continue;
        this.upsertParticipation({
          matchId,
          playerId: r.playerId,
          classUsed: r.classUsed,
          squad: r.squad,
          noteRole: r.noteRole,
          state: r.state,
          stat: undefined,
        });
        added++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  upsertParticipation(input: ParticipationInput): number {
    const { matchId, playerId } = input;
    if (!this.get(matchId)) throw new Error(`对局不存在：id=${matchId}`);
    const pl = this.db.prepare('SELECT id, main_class, note_role, mic FROM player WHERE id = ?')
      .get(playerId) as { id: number; main_class: string; note_role: string; mic: string } | undefined;
    if (!pl) throw new Error(`成员不存在：id=${playerId}`);

    const squad = s(input.squad);
    let tactic = '';
    let teamRole = '';
    if (squad) {
      // 允许「替补 / 请假」这类非战斗槽位，以及库里登记过的战斗小队
      const isBench = (BENCH_SQUADS as readonly string[]).includes(squad);
      if (!isBench) {
        const hit = this.squads.paramsForSquadName(squad);
        if (!hit.kind) throw new Error(`未知小队：${squad}（可在「设置 → 战斗组与小队」里新增）`);
        tactic = hit.tactic;
        teamRole = hit.teamRole;
      }
    }

    const classUsed = s(input.classUsed) || pl.main_class;
    if (classUsed && !findClass(classUsed)) {
      throw new Error(`职业「${classUsed}」不在 12 职业表内（可用别名见职业字典）`);
    }

    this.db.prepare(
      `INSERT INTO participation
         (match_id, player_id, side, squad, tactic, team_role, class_used, note_role, mic, state)
       VALUES (?, ?, 'our', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id, player_id, side) DO UPDATE SET
         squad = excluded.squad, tactic = excluded.tactic, team_role = excluded.team_role,
         class_used = excluded.class_used, note_role = excluded.note_role,
         mic = excluded.mic, state = excluded.state`,
    ).run(
      matchId, playerId, squad, tactic, teamRole, classUsed,
      s(input.noteRole) || pl.note_role, pl.mic, s(input.state) || 'PLAY',
    );

    const row = this.db.prepare(
      'SELECT id FROM participation WHERE match_id = ? AND player_id = ? AND side = ?',
    ).get(matchId, playerId, 'our') as { id: number };

    if (input.stat) this.saveStat(row.id, input.stat);
    return row.id;
  }

  removeParticipation(id: number): boolean {
    return this.db.prepare('DELETE FROM participation WHERE id = ?').run(id).changes > 0;
  }

  /** 只改某一条参战记录的战报（保存 14 项指标） */
  saveStat(participationId: number, stat: Partial<CombatStat>): void {
    const cur = this.db.prepare(
      'SELECT participation_id FROM combat_stat WHERE participation_id = ?',
    ).get(participationId);

    if (!cur) {
      const cols = STAT_COLUMNS.map(([, c]) => c).join(', ');
      const qs = STAT_COLUMNS.map(() => '?').join(', ');
      this.db.prepare(
        `INSERT INTO combat_stat (participation_id, ${cols}) VALUES (?, ${qs})`,
      ).run(participationId, ...STAT_COLUMNS.map(([k]) => Math.max(0, Math.round(n(stat[k])))) as SqlValue[]);
      return;
    }

    const sets: string[] = [];
    const vals: SqlValue[] = [];
    for (const [k, col] of STAT_COLUMNS) {
      if (stat[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(Math.max(0, Math.round(n(stat[k]))));
    }
    if (!sets.length) return;
    vals.push(participationId);
    this.db.prepare(`UPDATE combat_stat SET ${sets.join(', ')} WHERE participation_id = ?`).run(...vals);
  }

  /** 某场里已分配到小队的人数，用于阵容完整性提示 */
  squadFill(matchId: number): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT squad, COUNT(*) AS c FROM participation
       WHERE match_id = ? AND side = 'our' AND state = 'PLAY' AND squad <> ''
       GROUP BY squad`,
    ).all(matchId) as unknown as { squad: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.squad, n(r.c)]));
  }
}

export { tacticKind };
