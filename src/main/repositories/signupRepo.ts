/**
 * 报名 / 请假仓储
 *
 * 与原表的区别：旧表这块依赖 WPS 在线表单（定义名已全部 #REF!，功能已死），
 * 这里做成库内实体，报名与"上场名单"分开：
 *   signup        = 意愿（参加 / 请假 / 替补 / 未报名）
 *   participation = 排表结果（上场 / 替补 / 请假）
 * 两者允许不一致（人工调整阵容时就会出现差异），页面会同时显示。
 */
import type { SqlDatabase, SqlValue } from '../db';
import type {
  PartState, Player, SignupBoard, SignupImportPreview, SignupImportRow, SignupInput,
  SignupReview, SignupRow, SignupStats, SignupStatus,
} from '../../shared/types';

interface BoardDbRow {
  id: number; game_id: string; name: string; note_role: string;
  sg_main: string | null; sg_sub: string | null; sg_mic: string | null;
  mic: string; status: string; joined_order: number | null;
  signup_status: string | null; signup_at: string | null; signup_remark: string | null;
  part_state: string | null; squad: string | null;
}

export class SignupRepo {
  constructor(private db: SqlDatabase) {}

  /** 某场的报名面板：全量成员左连接报名与上场状态 */
  board(matchId: number): SignupBoard {
    const match = this.db.prepare('SELECT id FROM match WHERE id = ?').get(matchId);
    if (!match) throw new Error(`对局不存在：id=${matchId}`);

    const raw = this.db.prepare(`
      SELECT pl.id, pl.game_id, pl.name, pl.note_role, pl.mic, pl.status, pl.joined_order,
             sg.main_class AS sg_main, sg.sub_class AS sg_sub, sg.mic AS sg_mic,
             sg.status AS signup_status, sg.updated_at AS signup_at, sg.remark AS signup_remark,
             p.state AS part_state, p.squad AS squad
      FROM player pl
      LEFT JOIN signup sg ON sg.player_id = pl.id AND sg.match_id = ?
      LEFT JOIN participation p ON p.player_id = pl.id AND p.match_id = ? AND p.side = 'our'
      ORDER BY (pl.status <> 'active'), pl.joined_order IS NULL, pl.joined_order, pl.id
    `).all(matchId, matchId) as unknown as BoardDbRow[];

    const rows: SignupRow[] = raw.map((r) => ({
      playerId: r.id,
      gameId: r.game_id,
      name: r.name,
      // 职业只从报名表来；没报名就是空
      mainClass: r.sg_main ?? '',
      subClass: r.sg_sub ?? '',
      noteRole: r.note_role,
      // 麦克风也以报名表为准，没填则退回主档记录
      mic: ((r.sg_mic || r.mic || '') as Player['mic']),
      status: r.status || 'active',
      joinedOrder: r.joined_order,
      signup: (r.signup_status as SignupStatus | null) ?? null,
      signupAt: r.signup_at ?? '',
      signupRemark: r.signup_remark ?? '',
      lineupState: (r.part_state as PartState | null) ?? null,
      squad: r.squad ?? '',
    }));

    const active = rows.filter((r) => r.status === 'active');
    const stats: SignupStats = {
      roster: rows.length,
      joined: rows.filter((r) => r.signup === 'JOIN').length,
      leave: rows.filter((r) => r.signup === 'LEAVE').length,
      bench: rows.filter((r) => r.signup === 'BENCH').length,
      none: rows.filter((r) => r.signup === null).length,
      pending: active.filter((r) => r.signup === null).length,
    };

    return { matchId, rows, stats };
  }

  /** 设置报名状态；status='NONE' 表示撤回（删除报名记录） */
  set(input: SignupInput): SignupRow {
    const { matchId, playerId } = input;
    if (!this.db.prepare('SELECT 1 FROM match WHERE id = ?').get(matchId)) {
      throw new Error(`对局不存在：id=${matchId}`);
    }
    if (!this.db.prepare('SELECT 1 FROM player WHERE id = ?').get(playerId)) {
      throw new Error(`成员不存在：id=${playerId}`);
    }

    if (input.status === 'NONE') {
      this.db.prepare('DELETE FROM signup WHERE match_id = ? AND player_id = ?').run(matchId, playerId);
    } else {
      this.db.prepare(
        `INSERT INTO signup (match_id, player_id, status, remark)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(match_id, player_id) DO UPDATE SET
           status = excluded.status,
           remark = excluded.remark,
           updated_at = datetime('now','localtime')`,
      ).run(matchId, playerId, input.status, (input.remark ?? '').trim());
    }

    const row = this.board(matchId).rows.find((r) => r.playerId === playerId);
    if (!row) throw new Error('读取报名结果失败');
    return row;
  }

  /**
   * 把报名结果应用到上场名单。
   *   参加 → 上场（PLAY，若已在名单则保留原小队）
   *   请假 → 取消上场（state=LEAVE 且清空小队）
   *   替补 → 替补（BENCH 且清空小队）
   * 单事务执行。
   */
  apply(matchId: number, playerIds: number[]): number {
    if (!this.db.prepare('SELECT 1 FROM match WHERE id = ?').get(matchId)) {
      throw new Error(`对局不存在：id=${matchId}`);
    }
    const ids = playerIds.length
      ? playerIds
      : (this.board(matchId).rows.filter((r) => r.signup !== null).map((r) => r.playerId));

    let applied = 0;
    this.db.exec('BEGIN');
    try {
      for (const pid of ids) {
        const sg = this.db.prepare(
          'SELECT status FROM signup WHERE match_id = ? AND player_id = ?',
        ).get(matchId, pid) as { status: string } | undefined;
        if (!sg) continue;

        const exists = this.db.prepare(
          "SELECT id FROM participation WHERE match_id = ? AND player_id = ? AND side = 'our'",
        ).get(matchId, pid) as { id: number } | undefined;

        if (sg.status === 'JOIN') {
          if (exists) {
            // 已经在名单里：只把状态拉回上场，保留原本的小队分配
            this.db.prepare("UPDATE participation SET state = 'PLAY' WHERE id = ?").run(exists.id);
          } else {
            const sgRow = this.db.prepare(
              'SELECT main_class, mic FROM signup WHERE match_id = ? AND player_id = ?',
            ).get(matchId, pid) as { main_class: string; mic: string } | undefined;
            const pl = this.db.prepare('SELECT note_role, mic FROM player WHERE id = ?')
              .get(pid) as { note_role: string; mic: string };
            this.db.prepare(
              `INSERT INTO participation (match_id, player_id, side, squad, tactic, team_role,
                                          class_used, note_role, mic, state)
               VALUES (?, ?, 'our', '', '', '', ?, ?, ?, 'PLAY')`,
            ).run(matchId, pid, sgRow?.main_class ?? '', pl.note_role, sgRow?.mic || pl.mic);
          }
        } else {
          const state = sg.status === 'LEAVE' ? 'LEAVE' : 'BENCH';
          if (exists) {
            this.db.prepare(
              "UPDATE participation SET state = ?, squad = '', tactic = '', team_role = '' WHERE id = ?",
            ).run(state, exists.id);
          } else {
            const sgRow = this.db.prepare(
              'SELECT main_class, mic FROM signup WHERE match_id = ? AND player_id = ?',
            ).get(matchId, pid) as { main_class: string; mic: string } | undefined;
            const pl = this.db.prepare('SELECT note_role, mic FROM player WHERE id = ?')
              .get(pid) as { note_role: string; mic: string };
            this.db.prepare(
              `INSERT INTO participation (match_id, player_id, side, squad, tactic, team_role,
                                          class_used, note_role, mic, state)
               VALUES (?, ?, 'our', '', '', '', ?, ?, ?, ?)`,
            ).run(matchId, pid, sgRow?.main_class ?? '', pl.note_role, sgRow?.mic || pl.mic, state);
          }
        }
        applied++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return applied;
  }

  /**
   * 导入报名表（预览通过后的提交）。
   *
   * 用户口径：
   *  - 重复报名**不自动取舍**，直接报错让用户回 Excel 处理；
   *  - 报名有、主档没有的 ID **不自动建档**，返回问题清单供审查，
   *    用户可选择用 createMissing() 补建。
   */
  importSignups(matchId: number, rows: SignupImportRow[]): {
    imported: number; matched: number; unmatched: string[];
  } {
    if (!this.db.prepare('SELECT 1 FROM match WHERE id = ?').get(matchId)) {
      throw new Error(`对局不存在：id=${matchId}`);
    }
    if (!rows.length) throw new Error('没有可导入的报名记录');

    // 重复报名：直接拒绝（用户要求手动处理）
    const seen = new Map<string, number[]>();
    for (const r of rows) {
      const arr = seen.get(r.gameId) ?? [];
      arr.push(r.line);
      seen.set(r.gameId, arr);
    }
    const dup = [...seen.entries()].filter(([, l]) => l.length > 1);
    if (dup.length) {
      const detail = dup.slice(0, 8)
        .map(([id, lines]) => `${id}（第 ${lines.join('、')} 行）`).join('；');
      throw new Error(
        `有 ${dup.length} 个 ID 重复报名，请在报名表里处理后再导入：${detail}`
        + (dup.length > 8 ? ' …' : ''),
      );
    }

    const unmatched: string[] = [];
    let imported = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const pl = this.db.prepare('SELECT id FROM player WHERE game_id = ?')
          .get(r.gameId) as { id: number } | undefined;
        if (!pl) { unmatched.push(r.gameId); continue; }
        this.db.prepare(
          `INSERT INTO signup (match_id, player_id, status, remark, main_class, sub_class, mic, submitted_at)
           VALUES (?, ?, ?, '', ?, ?, ?, ?)
           ON CONFLICT(match_id, player_id) DO UPDATE SET
             status = excluded.status,
             main_class = excluded.main_class,
             sub_class = excluded.sub_class,
             mic = excluded.mic,
             submitted_at = excluded.submitted_at,
             updated_at = datetime('now','localtime')`,
        ).run(matchId, pl.id, r.status, r.mainClass, r.subClass, r.mic, r.submittedAt);
        imported += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { imported, matched: imported, unmatched };
  }

  /** 报名 vs 主档 的交叉核对 */
  review(matchId: number): SignupReview {
    if (!this.db.prepare('SELECT 1 FROM match WHERE id = ?').get(matchId)) {
      throw new Error(`对局不存在：id=${matchId}`);
    }
    const board = this.board(matchId);
    return {
      matchId,
      inRosterNotSigned: board.rows
        .filter((r) => r.status === 'active' && r.signup === null)
        .map((r) => ({ playerId: r.playerId, gameId: r.gameId, status: r.status })),
      // 「报名有、主档没有」在导入时就已经落库不了（外键指向 player），
      // 所以这里返回的是导入时记录下来的问题清单
      signedNotInRoster: this.readOrphans(matchId),
    };
  }

  /** 把「报名有、主档没有」的清单存下来，供报名页审查与补建 */
  saveOrphans(matchId: number, orphans: SignupImportPreview['rows']): void {
    this.db.prepare(
      `INSERT INTO app_setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(`signupOrphans:${matchId}`, JSON.stringify(orphans));
  }

  readOrphans(matchId: number): SignupReview['signedNotInRoster'] {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?')
      .get(`signupOrphans:${matchId}`) as { value: string } | undefined;
    if (!row?.value) return [];
    try {
      const arr = JSON.parse(row.value) as SignupImportRow[];
      // 已经补建过的不再列为问题
      return arr
        .filter((r) => !this.db.prepare('SELECT 1 FROM player WHERE game_id = ?').get(r.gameId))
        .map((r) => ({ gameId: r.gameId, status: r.status, mainClass: r.mainClass, subClass: r.subClass }));
    } catch {
      return [];
    }
  }

  /**
   * 补建缺失成员（用户选中的那些 ID）。
   * 职业不进主档（职业只从报名表来），所以这里只建 ID；报名记录随重建一并写入。
   */
  createMissing(matchId: number, gameIds: string[]): { created: number; signups: number } {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?')
      .get(`signupOrphans:${matchId}`) as { value: string } | undefined;
    const all = row?.value ? (JSON.parse(row.value) as SignupImportRow[]) : [];
    const want = all.filter((r) => gameIds.includes(r.gameId));
    if (!want.length) throw new Error('没有要补建的成员');

    let created = 0;
    let signups = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of want) {
        const exists = this.db.prepare('SELECT id FROM player WHERE game_id = ?')
          .get(r.gameId) as { id: number } | undefined;
        let pid = exists?.id;
        if (!pid) {
          const info = this.db.prepare(
            `INSERT INTO player (game_id, name, mic) VALUES (?, ?, '')`,
          ).run(r.gameId, r.gameId);
          pid = Number(info.lastInsertRowid);
          created += 1;
        }
        this.db.prepare(
          `INSERT INTO signup (match_id, player_id, status, remark, main_class, sub_class, mic, submitted_at)
           VALUES (?, ?, ?, '', ?, ?, ?, ?)
           ON CONFLICT(match_id, player_id) DO UPDATE SET
             status = excluded.status, main_class = excluded.main_class,
             sub_class = excluded.sub_class, mic = excluded.mic,
             submitted_at = excluded.submitted_at`,
        ).run(matchId, pid, r.status, r.mainClass, r.subClass, r.mic, r.submittedAt);
        signups += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { created, signups };
  }

  /** 兼容旧字段（未使用） */
  static val(v: unknown): SqlValue {
    return v as SqlValue;
  }
}
