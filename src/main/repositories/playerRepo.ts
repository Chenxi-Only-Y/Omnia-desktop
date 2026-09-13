/**
 * 成员主档仓储（M2）
 *
 * 业务主键 = game_id（原表用姓名做 MATCH，重名/空格即错配，这里改为角色 ID）。
 * name 仅作展示，并支持别名表映射（见 class 表 aliases）。
 */
import type { SqlDatabase, SqlValue } from '../db';
import type { Player, PlayerInput } from '../../shared/types';
interface PlayerRow {
  id: number;
  game_id: string;
  name: string;
  joined_order: number | null;
  mic: string;
  note_role: string;
  main_class: string;
  sub_class: string;
  status: string;
  remark: string;
  created_at: string;
  updated_at: string;
}

const COLS = `id, game_id, name, joined_order, mic, note_role,
              main_class, sub_class, status, remark, created_at, updated_at`;

function toPlayer(r: PlayerRow): Player {
  return {
    id: r.id,
    gameId: r.game_id,
    name: r.name,
    joinedOrder: r.joined_order,
    mic: (r.mic || '') as Player['mic'],
    noteRole: (r.note_role || '') as Player['noteRole'],
    mainClass: r.main_class || '',
    subClass: r.sub_class || '',
    status: r.status || 'active',
    remark: r.remark || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface ImportSummary {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export class PlayerRepo {
  constructor(private db: SqlDatabase) {}

  list(): Player[] {
    const rows = this.db.prepare(
      `SELECT ${COLS} FROM player
       ORDER BY (joined_order IS NULL), joined_order ASC, id ASC`,
    ).all() as unknown as PlayerRow[];
    return rows.map(toPlayer);
  }

  getById(id: number): Player | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM player WHERE id = ?`).get(id) as unknown as PlayerRow | undefined;
    return r ? toPlayer(r) : undefined;
  }

  getByGameId(gameId: string): Player | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM player WHERE game_id = ?`).get(norm(gameId)) as unknown as PlayerRow | undefined;
    return r ? toPlayer(r) : undefined;
  }

  /** 按角色 ID 精确匹配；找不到时退化为按姓名匹配（仅用于导入兼容） */
  resolveId(gameIdOrName: string): number | undefined {
    const key = norm(gameIdOrName);
    if (!key) return undefined;
    const byId = this.db.prepare('SELECT id FROM player WHERE game_id = ?').get(key) as { id: number } | undefined;
    if (byId) return byId.id;
    const byName = this.db.prepare('SELECT id FROM player WHERE name = ? LIMIT 1').get(key) as { id: number } | undefined;
    return byName?.id;
  }

  create(input: PlayerInput): Player {
    const gameId = norm(input.gameId) || norm(input.name);
    if (!gameId) throw new Error('角色 ID 不能为空');
    if (this.db.prepare('SELECT 1 FROM player WHERE game_id = ?').get(gameId)) {
      throw new Error(`角色 ID 已存在：${gameId}`);
    }
    const stmt = this.db.prepare(
      `INSERT INTO player (game_id, name, joined_order, mic, note_role, main_class, sub_class, status, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      gameId,
      norm(input.name) || gameId,
      num(input.joinedOrder),
      norm(input.mic),
      norm(input.noteRole),
      norm(input.mainClass),
      norm(input.subClass),
      norm(input.status) || 'active',
      norm(input.remark),
    );
    const created = this.getById(Number(info.lastInsertRowid));
    if (!created) throw new Error('创建成员失败');
    return created;
  }

  update(id: number, patch: Partial<PlayerInput>): Player {
    const cur = this.getById(id);
    if (!cur) throw new Error(`成员不存在：id=${id}`);

    // game_id 变更需要唯一性检查
    if (patch.gameId !== undefined) {
      const next = norm(patch.gameId);
      if (!next) throw new Error('角色 ID 不能为空');
      if (next !== cur.gameId) {
        const dup = this.db.prepare('SELECT 1 FROM player WHERE game_id = ?').get(next);
        if (dup) throw new Error(`角色 ID 已存在：${next}`);
      }
    }

    const sets: string[] = [];
    const vals: SqlValue[] = [];
    const put = (col: string, v: SqlValue) => { sets.push(`${col} = ?`); vals.push(v); };

    if (patch.gameId !== undefined) put('game_id', norm(patch.gameId));
    if (patch.name !== undefined) put('name', norm(patch.name));
    if (patch.joinedOrder !== undefined) put('joined_order', num(patch.joinedOrder));
    if (patch.mic !== undefined) put('mic', norm(patch.mic));
    if (patch.noteRole !== undefined) put('note_role', norm(patch.noteRole));
    if (patch.mainClass !== undefined) put('main_class', norm(patch.mainClass));
    if (patch.subClass !== undefined) put('sub_class', norm(patch.subClass));
    if (patch.status !== undefined) put('status', norm(patch.status) || 'active');
    if (patch.remark !== undefined) put('remark', norm(patch.remark));

    if (!sets.length) return cur;

    sets.push(`updated_at = datetime('now','localtime')`);
    vals.push(id);
    this.db.prepare(`UPDATE player SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const next = this.getById(id);
    if (!next) throw new Error('更新成员失败');
    return next;
  }

  remove(id: number): boolean {
    const info = this.db.prepare('DELETE FROM player WHERE id = ?').run(id);
    return info.changes > 0;
  }

  removeByGameIds(gameIds: string[]): number {
    const stmt = this.db.prepare('DELETE FROM player WHERE game_id = ?');
    let n = 0;
    for (const g of gameIds) n += stmt.run(norm(g)).changes;
    return n;
  }

  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM player').get() as { c: number };
    return Number(r.c);
  }

  /**
   * 批量导入（幂等）：按 game_id 合并。
   * 已存在则用非空字段覆盖（避免导入文件里的空列把已有数据清掉）。
   */
  importMany(rows: PlayerInput[]): ImportSummary {
    const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, errors: [] };
    const existedBefore = new Set(
      (this.db.prepare('SELECT game_id FROM player').all() as { game_id: string }[]).map((r) => r.game_id),
    );

    this.db.exec('BEGIN');
    try {
      for (const [i, raw] of rows.entries()) {
        const gameId = norm(raw.gameId) || norm(raw.name);
        if (!gameId) {
          summary.skipped++;
          summary.errors.push(`第 ${i + 1} 行：缺少角色 ID，已跳过`);
          continue;
        }
        const existing = this.getByGameId(gameId);
        if (existing) {
          const patch: Partial<PlayerInput> = {};
          if (norm(raw.name)) patch.name = raw.name;
          if (raw.joinedOrder !== undefined && raw.joinedOrder !== null) patch.joinedOrder = raw.joinedOrder;
          if (norm(raw.mic)) patch.mic = raw.mic;
          if (norm(raw.noteRole)) patch.noteRole = raw.noteRole;
          if (norm(raw.mainClass)) patch.mainClass = raw.mainClass;
          if (norm(raw.subClass)) patch.subClass = raw.subClass;
          if (norm(raw.status)) patch.status = raw.status;
          if (norm(raw.remark)) patch.remark = raw.remark;
          if (Object.keys(patch).length) {
            this.update(existing.id, patch);
            summary.updated++;
          } else {
            summary.skipped++;
          }
        } else {
          this.create(raw);
          summary.inserted++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`导入失败，已回滚：${(err as Error).message}`);
    }

    // 冗余校验：确保没有把重复 game_id 写进去
    const after = this.db.prepare('SELECT COUNT(*) AS c FROM player').get() as { c: number };
    if (Number(after.c) !== existedBefore.size + summary.inserted) {
      summary.errors.push('警告：导入后成员总数与预期不符，请检查重复角色 ID');
    }
    return summary;
  }
}
