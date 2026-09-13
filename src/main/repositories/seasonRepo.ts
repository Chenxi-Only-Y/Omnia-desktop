/**
 * 赛季仓储
 *
 * 数据模型取舍（重要）：赛季只给「对局」与「规则集」打标（match.season_id / rule_set.season_id），
 * 不给成员主档、战斗组/小队建制打标 —— 因为人是跨赛季的、建制也是长期资产。
 * 这带来两个约束，界面会明确提示：
 *   · 同一场对局的分数换赛季不会重算，因为它属于创建它的那个赛季
 *   · 成员总览类统计天然跨赛季（那是我们想要的）
 * 这样既拿到"按赛季看对局与规则"的能力，又不需要给每张表加列。
 */
import type { SqlDatabase, SqlValue } from '../db';
import type { Season, SeasonInput, SeasonSummary } from '../../shared/types';

interface SeasonRow {
  id: number; name: string; started_at: string; ended_at: string; remark: string;
}

export class SeasonRepo {
  constructor(private db: SqlDatabase) {}

  private toSeason(r: SeasonRow): Season {
    return {
      id: r.id,
      name: r.name,
      startedAt: r.started_at ?? '',
      endedAt: r.ended_at ?? '',
      remark: r.remark ?? '',
    };
  }

  activeId(): number {
    const s = this.db.prepare("SELECT value FROM app_setting WHERE key = 'activeSeasonId'")
      .get() as { value: string } | undefined;
    const id = s ? Number(s.value) : NaN;
    if (Number.isFinite(id) && this.db.prepare('SELECT 1 FROM season WHERE id = ?').get(id)) return id;
    // 兜底：取第一个赛季；库为空则新建一个
    const first = this.db.prepare('SELECT id FROM season ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
    if (first) {
      this.setActive(first.id);
      return first.id;
    }
    return this.create({ name: '默认赛季' }).id;
  }

  active(): Season {
    return this.get(this.activeId());
  }

  get(id: number): Season {
    const r = this.db.prepare('SELECT * FROM season WHERE id = ?').get(id) as unknown as SeasonRow | undefined;
    if (!r) throw new Error(`赛季不存在：id=${id}`);
    return this.toSeason(r);
  }

  setActive(id: number): Season {
    this.get(id);
    this.db.prepare(
      `INSERT INTO app_setting (key, value) VALUES ('activeSeasonId', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(id));
    return this.get(id);
  }

  create(input: SeasonInput): Season {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('赛季名称不能为空');
    if (this.db.prepare('SELECT 1 FROM season WHERE name = ?').get(name)) {
      throw new Error(`赛季已存在：${name}`);
    }
    const info = this.db.prepare(
      'INSERT INTO season (name, started_at, ended_at, remark) VALUES (?,?,?,?)',
    ).run(name, (input.startedAt ?? '').trim(), (input.endedAt ?? '').trim(), (input.remark ?? '').trim());
    return this.get(Number(info.lastInsertRowid));
  }

  update(id: number, patch: Partial<SeasonInput>): Season {
    const cur = this.get(id);
    const sets: string[] = [];
    const vals: SqlValue[] = [];
    const put = (col: string, v: SqlValue) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n) throw new Error('赛季名称不能为空');
      const dup = this.db.prepare('SELECT 1 FROM season WHERE name = ? AND id <> ?').get(n, id);
      if (dup) throw new Error(`赛季名已占用：${n}`);
      put('name', n);
    }
    if (patch.startedAt !== undefined) put('started_at', patch.startedAt.trim());
    if (patch.endedAt !== undefined) put('ended_at', patch.endedAt.trim());
    if (patch.remark !== undefined) put('remark', patch.remark.trim());
    if (!sets.length) return cur;
    vals.push(id);
    this.db.prepare(`UPDATE season SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.get(id);
  }

  remove(id: number): boolean {
    if (this.activeId() === id) throw new Error('不能删除当前赛季，请先切换到别的赛季');
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM season').get() as { c: number };
    if (Number(total.c) <= 1) throw new Error('至少要保留一个赛季');
    // 该赛季下的对局与规则不删，只解除赛季归属（避免误删历史数据）
    this.db.prepare('UPDATE match SET season_id = NULL WHERE season_id = ?').run(id);
    this.db.prepare('UPDATE rule_set SET season_id = NULL WHERE season_id = ?').run(id);
    return this.db.prepare('DELETE FROM season WHERE id = ?').run(id).changes > 0;
  }

  /** 所有赛季 + 各自的规模统计 */
  summaries(): SeasonSummary[] {
    const rows = this.db.prepare('SELECT * FROM season ORDER BY id ASC').all() as unknown as SeasonRow[];
    const activeId = this.activeId();
    return rows.map((r) => {
      const m = this.db.prepare('SELECT COUNT(*) AS c FROM match WHERE season_id = ?').get(r.id) as { c: number };
      const rs = this.db.prepare('SELECT COUNT(*) AS c FROM rule_set WHERE season_id = ?').get(r.id) as { c: number };
      const range = this.db.prepare(
        'SELECT MIN(date) AS a, MAX(date) AS b FROM match WHERE season_id = ?',
      ).get(r.id) as { a: string | null; b: string | null };
      return {
        ...this.toSeason(r),
        active: r.id === activeId,
        matchCount: Number(m.c),
        ruleSetCount: Number(rs.c),
        firstDate: range.a ?? '',
        lastDate: range.b ?? '',
      };
    });
  }

  /** 把若干对局划到某赛季（用于纠正历史数据） */
  assignMatches(seasonId: number, matchIds: number[]): number {
    this.get(seasonId);
    const stmt = this.db.prepare('UPDATE match SET season_id = ? WHERE id = ?');
    let n = 0;
    for (const id of matchIds) n += stmt.run(seasonId, id).changes;
    return n;
  }
}
