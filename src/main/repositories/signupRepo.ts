/**
 * 报名 / 请假仓储
 *
 * 与原表的区别：旧表这块依赖 WPS 在线表单（定义名已全部 #REF!，功能已死），
 * 这里做成库内实体，报名与"上场名单"分开：
 *   signup        = 意愿（参加 / 请假 / 替补 / 未报名）
 *   participation = 排表结果（上场 / 替补 / 请假）
 * 两者允许不一致（人工调整阵容时就会出现差异），页面会同时显示。
 */
import type { SqlDatabase } from '../db';
import type {
  PartState, Player, SignupBoard, SignupImportPreview, SignupImportRow, SignupInput,
  SignupReview, SignupRow, SignupStats, SignupStatus,
} from '../../shared/types';
import { findPlayerIdByKey } from './playerLookup';

interface BoardDbRow {
  id: number; game_id: string; name: string; note_role: string;
  sg_main: string | null; sg_sub: string | null; sg_mic: string | null;
  mic: string; status: string; joined_order: number | null;
  signup_status: string | null; signup_at: string | null; signup_remark: string | null;
  part_state: string | null; squad: string | null;
}

export class SignupRepo {
  /* 库连接用"取当前连接"的函数而不是固定连接：多帮会模式下切帮会只换句柄，
     仓储实例不用重建（见 src/main/guilds.ts）。 */
  constructor(private getDb: () => SqlDatabase) {}

  private get db(): SqlDatabase { return this.getDb(); }

  /**
   * 报名表「角色id」列可能填的是角色名（表头也可能叫「ID名」）。
   * 主档改过名以后 game_id 已经是新名，旧名只留在 player_alias ——
   * 解析规则（game_id → name → 历史用名，限我方成员）的唯一实现在 playerLookup，
   * 这里只是转发，避免第二份实现再漂移。
   */
  private findPlayerId(key: string): number | undefined {
    return findPlayerIdByKey(this.db, key, 'our');
  }

  /** 某场的报名面板：全量成员左连接报名与上场状态 */
  board(matchId: number): SignupBoard {
    const match = this.db.prepare('SELECT id FROM match WHERE id = ?').get(matchId);
    if (!match) throw new Error(`对局不存在：id=${matchId}`);

    const raw = this.db.prepare(`
      SELECT pl.id, pl.game_id, pl.name, pl.note_role, pl.mic, pl.status, pl.joined_order,
             sg.main_class AS sg_main, sg.sub_class AS sg_sub, sg.mic AS sg_mic,
             sg.status AS signup_status, COALESCE(NULLIF(sg.submitted_at, ''), sg.updated_at) AS signup_at, sg.remark AS signup_remark,
             p.state AS part_state, p.squad AS squad
      FROM player pl
      LEFT JOIN signup sg ON sg.player_id = pl.id AND sg.match_id = ?
      LEFT JOIN participation p ON p.player_id = pl.id AND p.match_id = ? AND p.side = 'our'
      WHERE pl.is_opp = 0
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

  /**
   * 设置报名状态；status='NONE' 表示撤回（删除报名记录）。
   * 另支持只改主职 / 二职（报名导入后修正职业用）：传了 mainClass / subClass
   * 就一并写入，且**不影响已有状态**（不传 status 则沿用库里原值）。
   */
  set(input: SignupInput): SignupRow {
    const { matchId, playerId } = input;
    if (!this.db.prepare('SELECT 1 FROM match WHERE id = ?').get(matchId)) {
      throw new Error(`对局不存在：id=${matchId}`);
    }
    if (!this.db.prepare('SELECT 1 FROM player WHERE id = ?').get(playerId)) {
      throw new Error(`成员不存在：id=${playerId}`);
    }

    // 职业修正：只有显式传了才动。空串是合法值（表示"清掉二职"），
    // 所以判据用 !== undefined 而不是真值判断。
    const hasMain = input.mainClass !== undefined;
    const hasSub = input.subClass !== undefined;
    // 麦克风同理：只有显式传了才动（手动加人时写本场的麦）
    const hasMic = input.mic !== undefined;
    const existing = this.db.prepare(
      'SELECT status, remark, main_class, sub_class, mic, submitted_at FROM signup WHERE match_id = ? AND player_id = ?',
    ).get(matchId, playerId) as {
      status: string; remark: string; main_class: string; sub_class: string;
      mic: string; submitted_at: string;
    } | undefined;

    // 只改职业、且本来没有报名记录时：建一条记录，状态沿用「参加」（表单默认口径）
    const status = input.status
      ?? (existing?.status as SignupStatus | undefined)
      ?? (hasMain || hasSub ? 'JOIN' : undefined);
    if (status === undefined) throw new Error('缺少报名状态');

    if (status === 'NONE') {
      this.db.prepare('DELETE FROM signup WHERE match_id = ? AND player_id = ?').run(matchId, playerId);
    } else {
      // 职业为空串时不要用 excluded 覆盖掉库里的值 —— 那会把"只改状态"的调用
      // （报名页每点一次状态都会走这里）顺手把职业清空。
      this.db.prepare(
        `INSERT INTO signup (match_id, player_id, status, remark, main_class, sub_class, mic)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(match_id, player_id) DO UPDATE SET
           status = excluded.status,
           remark = excluded.remark,
           main_class = CASE WHEN ? THEN excluded.main_class ELSE signup.main_class END,
           sub_class  = CASE WHEN ? THEN excluded.sub_class  ELSE signup.sub_class  END,
           mic        = CASE WHEN ? THEN excluded.mic        ELSE signup.mic        END,
           updated_at = datetime('now','localtime')`,
      ).run(
        matchId, playerId, status, (input.remark ?? existing?.remark ?? '').trim(),
        hasMain ? String(input.mainClass) : (existing?.main_class ?? ''),
        hasSub ? String(input.subClass) : (existing?.sub_class ?? ''),
        hasMic ? String(input.mic ?? '') : (existing?.mic ?? ''),
        hasMain ? 1 : 0, hasSub ? 1 : 0, hasMic ? 1 : 0,
      );
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
        const pid = this.findPlayerId(r.gameId);
        if (!pid) { unmatched.push(r.gameId); continue; }
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
        ).run(matchId, pid, r.status, r.mainClass, r.subClass, r.mic, r.submittedAt);
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
        .filter((r) => this.findPlayerId(r.gameId) === undefined)
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
        let pid = this.findPlayerId(r.gameId);
        if (!pid) {
          // 补建时把报名表里的麦克风一并写进主档（职业仍只留在报名表）
          const info = this.db.prepare(
            `INSERT INTO player (game_id, name, mic) VALUES (?, ?, ?)`,
          ).run(r.gameId, r.gameId, r.mic || '');
          pid = Number(info.lastInsertRowid);
          created += 1;
        } else if (r.mic) {
          // 已存在但主档没记麦克风：用报名表的补上
          this.db.prepare(
            "UPDATE player SET mic = ? WHERE id = ? AND trim(COALESCE(mic,'')) = ''",
          ).run(r.mic, pid);
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
}
