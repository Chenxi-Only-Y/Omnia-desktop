/**
 * 成员主档仓储（M2）
 *
 * 业务主键 = game_id（原表用姓名做 MATCH，重名/空格即错配，这里改为角色 ID）。
 * name 仅作展示，并支持别名表映射（见 class 表 aliases）。
 *
 * 历史用名（用户口径 2026-09）：玩家改名后，旧名收进 player_alias（迁移 v14），
 * 这样：
 *   · 旧战报/旧报名里的旧名仍能匹配到人（resolveId 会查别名）；
 *   · 反过来导入到新名字时，把新名字设为 game_id、旧名留档 —— 即"自动改为最新名"。
 */
import type { SqlDatabase, SqlValue } from '../db';
import type { Player, PlayerInput } from '../../shared/types';
import { findPlayerIdByKey } from './playerLookup';
interface PlayerRow {
  id: number;
  game_id: string;
  name: string;
  joined_order: number | null;
  mic: string;
  note_role: string;
  orange_weapon: string;
  bg_media: string;
  signature: string;
  intro: string;
  status: string;
  remark: string;
  is_opp: number;
  created_at: string;
  updated_at: string;
}

const COLS = `id, game_id, name, joined_order, mic, note_role,
              orange_weapon, status, remark, is_opp, created_at, updated_at, bg_media, signature, intro`;

function toPlayer(r: PlayerRow, aliases: string[] = []): Player {
  return {
    id: r.id,
    gameId: r.game_id,
    name: r.name,
    aliases,
    joinedOrder: r.joined_order,
    mic: (r.mic || '') as Player['mic'],
    noteRole: (r.note_role || '') as Player['noteRole'],
    orangeWeapon: r.orange_weapon || '',
    bgMedia: r.bg_media || '',
    signature: r.signature || '',
    intro: r.intro || '',
    status: r.status || 'active',
    remark: r.remark || '',
    // 对方帮会的人（迁移 v15）：不参与评分，也不出现在主档/报名/出勤里
    isOpp: r.is_opp === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');
/** 别名统一规范化：去空白、去重、剔掉与当前 ID 相同的项（避免自己匹配自己） */
const cleanAliases = (list: string[], currentId: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const a = norm(raw);
    if (!a || a === currentId || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
};
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
  /* 库连接用"取当前连接"的函数而不是固定连接：多帮会模式下切帮会只换句柄，
     仓储实例不用重建（见 src/main/guilds.ts）。 */
  constructor(private getDb: () => SqlDatabase) {}

  private get db(): SqlDatabase { return this.getDb(); }

  /**
   * 用 SAVEPOINT 而不是 BEGIN 包一段写操作。
   *
   * 为什么不能用 BEGIN：`node:sqlite` 不支持嵌套事务 ——
   * importMany() 已经开了一个事务，里面再调用 create()/setAliases() 就会
   * 抛 `cannot start a transaction within a transaction`（自检实测到的）。
   * SAVEPOINT 可以在事务内外都能用，且出错时能精确回滚自己这一段。
   */
  private sp<T>(name: string, fn: () => T): T {
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw err;
    }
  }

  // ── 别名（历史用名）────────────────────────────────────────────

  /** 某成员的别名列表（已去重、已剔除与当前 ID 相同的项） */
  aliasesOf(playerId: number): string[] {
    const rows = this.db.prepare(
      'SELECT alias FROM player_alias WHERE player_id = ? ORDER BY created_at ASC, alias ASC',
    ).all(playerId) as unknown as { alias: string }[];
    return rows.map((r) => r.alias);
  }

  /**
   * 整份覆盖某成员的别名表。
   * 会剔除与当前 game_id 相同的项（自己不该是自己的别名）。
   */
  setAliases(playerId: number, aliases: string[]): void {
    const cur = this.db.prepare('SELECT game_id FROM player WHERE id = ?')
      .get(playerId) as { game_id: string } | undefined;
    if (!cur) throw new Error(`成员不存在：id=${playerId}`);
    const list = cleanAliases(aliases, cur.game_id);
    this.sp('sp_set_alias', () => {
      this.db.prepare('DELETE FROM player_alias WHERE player_id = ?').run(playerId);
      const ins = this.db.prepare(
        'INSERT INTO player_alias (player_id, alias) VALUES (?, ?) ON CONFLICT DO NOTHING',
      );
      for (const a of list) ins.run(playerId, a);
    });
  }

  /**
   * 成员主档列表。
   *
   * 默认**不含对方帮会**（is_opp=1，迁移 v15）—— 对方只作为战报里的对比数据存在，
   * 不进主档、不进报名、不进评分。需要看对方名单时显式传 includeOpp。
   */
  list(includeOpp = false): Player[] {
    const rows = this.db.prepare(
      `SELECT ${COLS} FROM player
       ${includeOpp ? '' : 'WHERE is_opp = 0'}
       ORDER BY (joined_order IS NULL), joined_order ASC, id ASC`,
    ).all() as unknown as PlayerRow[];
    const byPlayer = this.aliasesByPlayer();
    return rows.map((r) => toPlayer(r, byPlayer.get(r.id) ?? []));
  }

  /**
   * 一次查出全部别名并按成员分组（避免每个成员查一次库的 N+1）。
   * 抽成方法是因为这段 SQL 原来在主档列表和 ipc 的 rosterEntries 里各写了一遍。
   */
  aliasesByPlayer(): Map<number, string[]> {
    const aliasRows = this.db.prepare(
      'SELECT player_id, alias FROM player_alias ORDER BY created_at ASC, alias ASC',
    ).all() as unknown as { player_id: number; alias: string }[];
    const byPlayer = new Map<number, string[]>();
    for (const a of aliasRows) {
      const arr = byPlayer.get(a.player_id);
      if (arr) arr.push(a.alias); else byPlayer.set(a.player_id, [a.alias]);
    }
    return byPlayer;
  }

  getById(id: number): Player | undefined {
    const r = this.db.prepare(`SELECT ${COLS} FROM player WHERE id = ?`).get(id) as unknown as PlayerRow | undefined;
    return r ? toPlayer(r, this.aliasesOf(r.id)) : undefined;
  }

  /**
   * 按角色 ID 精确匹配；找不到时退化为按姓名匹配，**再找不到就查历史用名**
   * （仅用于导入兼容）。实现在 playerLookup.findPlayerIdByKey（唯一一份）。
   */
  resolveId(gameIdOrName: string): number | undefined {
    return findPlayerIdByKey(this.db, gameIdOrName, 'our');
  }

  /**
   * 把某个「名字」（可能是历史用名）解析成成员，并在必要时**自动升级到最新名**。
   *
   * 用户口径：「后续导入数据后自动改为最新名」。
   * 规则：
   *   · 命中当前 ID 或当前 name → 直接返回，不动；
   *   · 命中**历史用名** → 说明玩家已改名：把导入进来的这个新名字写成 game_id，
   *     原 ID 收进别名表（留档），返回该成员。
   */
  resolveOrPromote(nameOrId: string): { id: number; renamed: boolean; from: string; to: string } | undefined {
    const key = norm(nameOrId);
    if (!key) return undefined;
    /* 只在我方成员里解析（is_opp = 0）：
       对方帮会的人即使在库里（选项 A 存了他们的战报），也**不能**被当成"自己人改名/入档"，
       否则一次战报导入就可能把对手变成我方成员。要收编对方得走 create()。 */
    const direct = this.db.prepare('SELECT id, game_id FROM player WHERE game_id = ? AND is_opp = 0')
      .get(key) as { id: number; game_id: string } | undefined;
    if (direct) return { id: direct.id, renamed: false, from: direct.game_id, to: key };

    const byName = this.db.prepare('SELECT id, game_id FROM player WHERE name = ? AND is_opp = 0 LIMIT 1')
      .get(key) as { id: number; game_id: string } | undefined;
    if (byName) return { id: byName.id, renamed: false, from: byName.game_id, to: key };

    const byAlias = this.db.prepare(
      `SELECT p.id, p.game_id FROM player_alias a JOIN player p ON p.id = a.player_id
       WHERE a.alias = ? AND p.is_opp = 0 LIMIT 1`,
    ).get(key) as { id: number; game_id: string } | undefined;
    if (!byAlias) return undefined;

    // 命中历史用名 → 这就是"改名"，把新名字提升为当前 ID
    const oldId = byAlias.game_id;
    // 若新名字已被别的成员占用，则不动（避免撞 UNIQUE），但仍返回命中的人
    const taken = this.db.prepare('SELECT 1 FROM player WHERE game_id = ?').get(key);
    if (taken) return { id: byAlias.id, renamed: false, from: oldId, to: key };
    try {
      this.sp('sp_promote', () => {
        this.db.prepare(
          `UPDATE player SET game_id = ?, name = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        ).run(key, key, byAlias.id);
      });
    } catch {
      // 提升失败（理论上已被上面的 taken 拦住）→ 不改名，但依然把数据算在他头上
      return { id: byAlias.id, renamed: false, from: oldId, to: key };
    }
    /* 别名表必须在改名**之后**重整：
         · 新名字刚刚成了当前 ID，不能再挂在历史用名里（否则界面会出现「曾用 = 现名」）；
         · 旧名要留档。
       走 setAliases 而不是直接 INSERT —— 它带 cleanAliases，能一次把这两件事都做对。
       别名整理失败不回滚改名：数据关联是按 player_id 走的，改名本身已经保住了。 */
    try {
      this.setAliases(byAlias.id, [...this.aliasesOf(byAlias.id), oldId]);
    } catch { /* 忽略 */ }
    return { id: byAlias.id, renamed: true, from: oldId, to: key };
  }

  create(input: PlayerInput): Player {
    const gameId = norm(input.gameId) || norm(input.name);
    if (!gameId) throw new Error('ID 不能为空');
    const dup = this.db.prepare('SELECT id, is_opp FROM player WHERE game_id = ?')
      .get(gameId) as { id: number; is_opp: number } | undefined;
    if (dup && dup.is_opp !== 1) {
      throw new Error(`ID 已存在：${gameId}`);
    }
    if (dup) {
      /* 收编：这个名字以前是**对手**（战报里存过，见迁移 v15），现在正式入档。
         复用同一行而不是新建 —— 他的历史战报（side='opp'）保持原样作为对比数据，
         新场次自然按我方（side='our'）走，两边不会互相污染。 */
      this.db.prepare(
        `UPDATE player SET name = ?, joined_order = ?, mic = ?, note_role = ?,
           orange_weapon = ?, status = ?, remark = ?, is_opp = 0,
           updated_at = datetime('now','localtime')
         WHERE id = ?`,
      ).run(
        gameId,
        num(input.joinedOrder),
        norm(input.mic),
        norm(input.noteRole),
        norm(input.orangeWeapon),
        norm(input.status) || 'active',
        norm(input.remark),
        dup.id,
      );
      const adopted = this.getById(dup.id);
      if (!adopted) throw new Error('收编对方成员失败');
      if (input.aliases?.length) this.setAliases(adopted.id, input.aliases);
      return this.getById(adopted.id) ?? adopted;
    }
    const stmt = this.db.prepare(
      `INSERT INTO player (game_id, name, joined_order, mic, note_role, orange_weapon, status, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      gameId,
      // 「ID名」与「昵称」已合并为单一字段 ID：两列同值，避免出现两个不同的名字
      gameId,
      num(input.joinedOrder),
      norm(input.mic),
      norm(input.noteRole),
      norm(input.orangeWeapon),
      norm(input.status) || 'active',
      norm(input.remark),
    );
    const created = this.getById(Number(info.lastInsertRowid));
    if (!created) throw new Error('创建成员失败');
    // 建档时就允许带历史用名（例如从旧表导入时已经知道他曾用名）
    if (input.aliases?.length) this.setAliases(created.id, input.aliases);
    return this.getById(created.id) ?? created;
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

    // 「ID名」与「昵称」已合并：改了 ID 就把 name 一并对齐，不允许两者分叉
    if (patch.gameId !== undefined) {
      put('game_id', norm(patch.gameId));
      put('name', norm(patch.gameId));
    }
    if (patch.name !== undefined && patch.gameId === undefined) put('name', norm(patch.name));
    if (patch.joinedOrder !== undefined) put('joined_order', num(patch.joinedOrder));
    if (patch.mic !== undefined) put('mic', norm(patch.mic));
    if (patch.noteRole !== undefined) put('note_role', norm(patch.noteRole));
    if (patch.orangeWeapon !== undefined) put('orange_weapon', norm(patch.orangeWeapon));
    if (patch.signature !== undefined) put('signature', String(patch.signature ?? ''));
    if (patch.intro !== undefined) put('intro', String(patch.intro ?? ''));
    if (patch.status !== undefined) put('status', norm(patch.status) || 'active');
    if (patch.remark !== undefined) put('remark', norm(patch.remark));

    const renamedTo = patch.gameId !== undefined ? norm(patch.gameId) : '';
    const didRename = !!renamedTo && renamedTo !== cur.gameId;

    if (sets.length) {
      sets.push(`updated_at = datetime('now','localtime')`);
      vals.push(id);
      this.db.prepare(`UPDATE player SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } else if (!didRename && patch.aliases === undefined) {
      return cur;
    }

    /* 改名 → 旧名自动留档（用户口径：不能因为改名让旧战报/旧报名对不上人）。
       必须在 UPDATE **之后**写：setAliases 会拿当前 game_id 做"别把自己记成别名"的判断。
       注意：这里必须与"整份覆盖"合并成一次写 —— 若先 addAlias 再 setAliases，
       覆盖会把刚留档的旧名又删掉（界面上编辑历史用名时永远会带上这个字段）。 */
    if (didRename || patch.aliases !== undefined) {
      const base = patch.aliases !== undefined ? patch.aliases : this.aliasesOf(id);
      this.setAliases(id, didRename ? [...base, cur.gameId] : base);
    }

    const next = this.getById(id);
    if (!next) throw new Error('更新成员失败');
    return next;
  }

  /** 设置个人主页背景（文件已由 IPC 拷进应用目录） */
  setBgMedia(id: number, absPath: string): Player {
    this.db.prepare(`UPDATE player SET bg_media = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(absPath, id);
    const p = this.getById(id);
    if (!p) throw new Error(`成员不存在：id=${id}`);
    return p;
  }

  /** 清掉个人主页背景（回到默认背景） */
  clearBgMedia(id: number): Player {
    return this.setBgMedia(id, '');
  }

  remove(id: number): boolean {
    const info = this.db.prepare('DELETE FROM player WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ── 对方帮会成员（选项 A：存下来，但不评分、不进主档）──────────────

  /** 找一条已存在的对方记录（按对方 ID → 名字）；实现在 playerLookup（唯一一份） */
  findOpp(nameOrId: string): number | undefined {
    return findPlayerIdByKey(this.db, nameOrId, 'opp');
  }

  /**
   * 取（必要时建）一条对方成员记录 —— 战报导入时"不在我主档"的行落到这里。
   *
   * 为什么要做 upsert：对方是**跨场次**看的（同一个人打了很多场），
   * 每场都新建一条的话，后续做对比页时同一个人会碎成好几条。
   * 名字与我方重名时 game_id 加「对方·」前缀 —— game_id 是 UNIQUE，
   * 而对方的名字完全可能和我方某人一样（同名不同人，必须分开存）。
   */
  upsertOpponent(nameOrId: string): { id: number; created: boolean } {
    const key = norm(nameOrId);
    if (!key) throw new Error('对方成员名字不能为空');
    const found = this.findOpp(key);
    if (found) return { id: found, created: false };
    let gid = key;
    let n = 0;
    while (this.db.prepare('SELECT 1 FROM player WHERE game_id = ?').get(gid)) {
      gid = `对方${++n > 1 ? n : ''}·${key}`;
    }
    const info = this.db.prepare(
      `INSERT INTO player (game_id, name, status, is_opp) VALUES (?, ?, 'active', 1)`,
    ).run(gid, key);
    return { id: Number(info.lastInsertRowid), created: true };
  }

  /**
   * 批量导入（幂等）：按 game_id 合并。
   * 已存在则用非空字段覆盖（避免导入文件里的空列把已有数据清掉）。
   *
   * 历史用名（用户口径 2026-09）：按当前 ID 匹配不到时先查**别名表**；
   * 命中说明玩家改过名 → 把导入进来的名字**升级为当前 ID**、旧名留档，
   * 于是导入文件永远以最新名为准，而旧数据也不会失去关联。
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
        // 先按「当前 ID / 姓名 / 历史用名」解析；命中历史用名会自动改成最新名
        const resolved = this.resolveOrPromote(gameId);
        if (resolved?.renamed) {
          summary.errors.push(
            `第 ${i + 1} 行：「${resolved.from}」已改名为「${resolved.to}」，旧名已留档`,
          );
        }
        const existing = resolved ? this.getById(resolved.id) : undefined;
        if (existing) {
          const patch: Partial<PlayerInput> = {};
          if (norm(raw.name)) patch.name = raw.name;
          if (raw.joinedOrder !== undefined && raw.joinedOrder !== null) patch.joinedOrder = raw.joinedOrder;
          if (norm(raw.mic)) patch.mic = raw.mic;
          if (norm(raw.noteRole)) patch.noteRole = raw.noteRole;
          // 橙武允许被导入覆盖（空值不覆盖，避免把已有值擦掉）
          if (norm(raw.orangeWeapon)) patch.orangeWeapon = raw.orangeWeapon;
          // 旧表的主职业/副职列此处忽略：职业已不在成员主档
          if (norm(raw.status)) patch.status = raw.status;
          if (norm(raw.remark)) patch.remark = raw.remark;
          // 导入文件若自带历史用名列，一并收进来
          if (raw.aliases?.length) patch.aliases = raw.aliases;
          if (Object.keys(patch).length) {
            this.update(existing.id, patch);
            summary.updated++;
          } else {
            summary.skipped++;
          }
        } else {
          /* 这个名字若已经在库里（但是**对方**），create() 会把它收编成我方成员 ——
             此时记录数没增加，所以不能算 inserted（否则下面的冗余校验会误报"总数不符"）。 */
          const oppHit = this.findOpp(gameId);
          this.create(raw);
          if (oppHit) summary.updated++; else summary.inserted++;
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

  /**
   * 按给定顺序重排成员：序 = 下标 + 1。
   * 拖拽换位后调用，整批写回 —— 保证「序」连续，且与界面看到的顺序一致。
   */
  reorder(playerIds: number[]): void {
    if (!playerIds.length) throw new Error('没有要排序的成员');
    const stmt = this.db.prepare('UPDATE player SET joined_order = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      playerIds.forEach((id, i) => { stmt.run(i + 1, id); });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
