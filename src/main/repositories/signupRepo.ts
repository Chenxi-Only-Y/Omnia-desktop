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
  PartState, Player, SignupBoard, SignupInput, SignupRow, SignupStats, SignupStatus,
} from '../../shared/types';

interface BoardDbRow {
  id: number; game_id: string; name: string; main_class: string; note_role: string;
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
      SELECT pl.id, pl.game_id, pl.name, pl.main_class, pl.note_role, pl.mic, pl.status, pl.joined_order,
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
      mainClass: r.main_class,
      noteRole: r.note_role,
      mic: (r.mic || '') as Player['mic'],
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
            const pl = this.db.prepare('SELECT main_class, note_role, mic FROM player WHERE id = ?')
              .get(pid) as { main_class: string; note_role: string; mic: string };
            this.db.prepare(
              `INSERT INTO participation (match_id, player_id, side, squad, tactic, team_role,
                                          class_used, note_role, mic, state)
               VALUES (?, ?, 'our', '', '', '', ?, ?, ?, 'PLAY')`,
            ).run(matchId, pid, pl.main_class, pl.note_role, pl.mic);
          }
        } else {
          const state = sg.status === 'LEAVE' ? 'LEAVE' : 'BENCH';
          if (exists) {
            this.db.prepare(
              "UPDATE participation SET state = ?, squad = '', tactic = '', team_role = '' WHERE id = ?",
            ).run(state, exists.id);
          } else {
            const pl = this.db.prepare('SELECT main_class, note_role, mic FROM player WHERE id = ?')
              .get(pid) as { main_class: string; note_role: string; mic: string };
            this.db.prepare(
              `INSERT INTO participation (match_id, player_id, side, squad, tactic, team_role,
                                          class_used, note_role, mic, state)
               VALUES (?, ?, 'our', '', '', '', ?, ?, ?, ?)`,
            ).run(matchId, pid, pl.main_class, pl.note_role, pl.mic, state);
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

  /** 兼容旧字段（未使用） */
  static val(v: unknown): SqlValue {
    return v as SqlValue;
  }
}
