/**
 * 战斗组 / 小队建制仓储 —— **按场次独立**
 *
 * 用户口径（2026-09）：「不同场次的队伍数量啥的彼此独立，而不是改一个
 * 另外的一样会被改」。
 *
 * 数据模型：
 *   · `match_squad`（迁移 v13）按 match_id 存该场的组与队；
 *     group_name + name 是业务键，沿用项目既有口径（participation.squad
 *     本来就是文本存名字），所以没有自增 id。
 *   · `combat_group` / `squad` **保留为全局默认模板**：某场还没有建制时
 *     （新对局首次进入排表页），从模板整份复制一份过来。
 *     设置页不再管理模板（用户口径：设置页不再管建制）。
 *
 * 所有写操作都必须带 matchId —— 保证「改一场不影响其它场」。
 */
import type { SqlDatabase } from '../db';
import type {
  CombatGroupRow, GroupInput, SquadCatalog, SquadInput, SquadRow,
} from '../../shared/types';
import type { GroupKind, Tactic } from '../../shared/domain';
import { TACTICS } from '../../shared/domain';

/** 一行 = 一个小队（组信息冗余在行上，组名就是组的键） */
interface MatchSquadDbRow {
  match_id: number;
  name: string;
  group_name: string;
  group_kind: string;
  index_in_group: number;
  tactic: string;
  size: number;
  sort_order: number;
}

interface TemplateGroupRow {
  name: string; kind: string; sort_order: number;
}

const kindOf = (v: string): GroupKind => (v === 'defend' ? 'defend' : 'attack');

const toSquad = (r: MatchSquadDbRow): SquadRow => ({
  matchId: r.match_id,
  groupName: r.group_name,
  kind: kindOf(r.group_kind),
  indexInGroup: r.index_in_group,
  name: r.name,
  tactic: (r.tactic || '') as Tactic | '',
  size: r.size,
  sortOrder: r.sort_order,
});

export class SquadRepo {
  /* 库连接用"取当前连接"的函数而不是固定连接：多帮会模式下切帮会只换句柄，
     仓储实例不用重建（见 src/main/guilds.ts）。 */
  constructor(private getDb: () => SqlDatabase) {}

  private get db(): SqlDatabase { return this.getDb(); }

  // ── 内部：模板（全局默认建制） ───────────────────────────────────

  private templateSquads(): {
    name: string; groupName: string; kind: GroupKind; indexInGroup: number;
    tactic: string; size: number; sortOrder: number;
  }[] {
    const rows = this.db.prepare(
      `SELECT s.name, s.index_in_group, s.tactic, s.size, g.name AS group_name, g.kind,
              (g.sort_order * 1000 + s.index_in_group) AS sort_order
       FROM squad s JOIN combat_group g ON g.id = s.group_id`,
    ).all() as unknown as {
      name: string; index_in_group: number; tactic: string; size: number;
      group_name: string; kind: string; sort_order: number;
    }[];
    return rows.map((r) => ({
      name: r.name,
      groupName: r.group_name,
      kind: kindOf(r.kind),
      indexInGroup: r.index_in_group,
      tactic: r.tactic,
      size: r.size,
      sortOrder: r.sort_order,
    }));
  }

  private templateGroups(): TemplateGroupRow[] {
    return this.db.prepare(
      'SELECT name, kind, sort_order FROM combat_group ORDER BY sort_order ASC, id ASC',
    ).all() as unknown as TemplateGroupRow[];
  }

  /**
   * 确保该场已有一份建制：没有就从全局模板整份复制。
   * 只在该场**一条都没有**时复制 —— 用户把某场的队删光了也不该被自动加回来。
   */
  ensureSeeded(matchId: number): void {
    const n = this.db.prepare(
      'SELECT COUNT(*) AS c FROM match_squad WHERE match_id = ?',
    ).get(matchId) as { c: number };
    if (Number(n.c) > 0) return;
    const seeds = this.templateSquads();
    if (!seeds.length) return;  // 模板是空的（全新库）：留空，让用户自己建组
    const ins = this.db.prepare(
      `INSERT INTO match_squad
         (match_id, name, group_name, group_kind, index_in_group, tactic, size, sort_order)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(match_id, name) DO NOTHING`,
    );
    this.db.exec('BEGIN');
    try {
      for (const s of seeds) {
        ins.run(matchId, s.name, s.groupName, s.kind, s.indexInGroup,
          s.tactic, s.size, s.sortOrder);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── 读 ───────────────────────────────────────────────────────────

  /** 该场的建制（组 + 队 + 容量）。首次访问会自动从模板复制一份。 */
  catalog(matchId: number): SquadCatalog {
    this.ensureSeeded(matchId);
    const rows = this.db.prepare(
      'SELECT * FROM match_squad WHERE match_id = ? ORDER BY sort_order ASC, index_in_group ASC',
    ).all(matchId) as unknown as MatchSquadDbRow[];
    const squads = rows.map(toSquad);

    /* 组列表 = 该场有队的组 ∪ 模板里的组。
       模板那部分必须并进来，否则"某组被删光了队"就会直接从界面上消失，
       连"往这个组里加一队"的入口都没了（踩过一次：删完最后一队就没法加回来）。 */
    const byName = new Map<string, CombatGroupRow>();
    for (const s of squads) {
      if (!byName.has(s.groupName)) {
        byName.set(s.groupName, { name: s.groupName, kind: s.kind, sortOrder: s.sortOrder });
      }
    }
    for (const g of this.templateGroups()) {
      if (!byName.has(g.name)) {
        byName.set(g.name, { name: g.name, kind: kindOf(g.kind), sortOrder: g.sort_order });
      }
    }
    const groups = [...byName.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return { matchId, groups, squads, capacity: squads.reduce((n, s) => n + s.size, 0) };
  }

  findByName(matchId: number, name: string): SquadRow | undefined {
    const n = (name ?? '').trim();
    if (!n) return undefined;
    const r = this.db.prepare(
      'SELECT * FROM match_squad WHERE match_id = ? AND name = ?',
    ).get(matchId, n) as unknown as MatchSquadDbRow | undefined;
    if (r) return toSquad(r);
    // 历史场次/战报里的旧名字回退到模板查一次（模板保留着默认 12 队）
    const t = this.templateSquads().find((x) => x.name === n);
    return t ? { matchId, groupName: t.groupName, kind: t.kind, indexInGroup: t.indexInGroup,
      name: t.name, tactic: t.tactic as Tactic | '', size: t.size, sortOrder: t.sortOrder } : undefined;
  }

  /** 把外来小队名解析成本系统的队（正式名 → 模板 → 「防守一2」这种去连字符写法） */
  resolve(matchId: number, name: string): SquadRow | undefined {
    const n = (name ?? '').trim();
    if (!n) return undefined;
    const direct = this.findByName(matchId, n);
    if (direct) return direct;
    const m = /^(.*?)(\d+)$/.exec(n);
    if (m) return this.findByName(matchId, `${m[1]}-${m[2]}`);
    return undefined;
  }

  /** 队名 → 战术 / 攻防类别（写入参战时补全字段用） */
  paramsForSquadName(matchId: number, name: string): { tactic: string; teamRole: string; kind: GroupKind | '' } {
    const s = this.resolve(matchId, name);
    if (!s) return { tactic: '', teamRole: '', kind: '' };
    return {
      tactic: s.tactic,
      teamRole: s.kind === 'defend' ? '防守' : '进攻',
      kind: s.kind,
    };
  }

  groupKindOf(matchId: number, groupName: string): GroupKind | '' {
    const n = (groupName ?? '').trim();
    if (!n) return '';
    const r = this.db.prepare(
      'SELECT group_kind FROM match_squad WHERE match_id = ? AND group_name = ? LIMIT 1',
    ).get(matchId, n) as { group_kind: string } | undefined;
    if (r) return kindOf(r.group_kind);
    const t = this.templateGroups().find((g) => g.name === n);
    return t ? kindOf(t.kind) : '';
  }

  // ── 写（一律限定 matchId）───────────────────────────────────────

  /**
   * 在某场里新增一个战斗组。
   * 注意 match_squad 一行同时代表组与队（行必须挂在某个队名下），
   * 所以"空组"没有立足点 —— 这里建组时**顺手建该组第 1 队**，
   * 与旧行为一致（旧 createGroup 之后也是立刻加队）。
   */
  createGroup(matchId: number, input: GroupInput): CombatGroupRow {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('战斗组名称不能为空');
    const exists = this.db.prepare(
      'SELECT 1 FROM match_squad WHERE match_id = ? AND group_name = ? LIMIT 1',
    ).get(matchId, name)
      ?? this.templateGroups().find((g) => g.name === name);
    if (exists) throw new Error(`战斗组已存在：${name}`);

    const kind = kindOf(input.kind);
    const maxSort = this.db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS m FROM match_squad WHERE match_id = ?',
    ).get(matchId) as { m: number };
    const sortOrder = Number(maxSort.m) + 1000;
    const squadName = `${name}-1`;
    this.db.prepare(
      `INSERT INTO match_squad
         (match_id, name, group_name, group_kind, index_in_group, tactic, size, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(matchId, squadName, name, kind, 1, kind === 'defend' ? '防守' : '', 6, sortOrder);
    return { name, kind, sortOrder };
  }

  /** 该组在**该场**里还有几支队（模板里的队不算） */
  private squadsInGroup(matchId: number, groupName: string): number {
    const r = this.db.prepare(
      'SELECT COUNT(*) AS c FROM match_squad WHERE match_id = ? AND group_name = ?',
    ).get(matchId, groupName) as { c: number };
    return Number(r.c);
  }

  removeGroup(matchId: number, groupName: string): boolean {
    const n = this.squadsInGroup(matchId, groupName);
    if (n > 0) throw new Error(`该战斗组下还有 ${n} 支小队，请先删除小队`);
    // 空组在本场里本来就没有行可删；模板里若有同名组也不动（模板是全局默认）
    return false;
  }

  /** 给某组"再加一队"（排表页的「＋ 加一队」） */
  appendSquad(matchId: number, groupName: string): SquadRow {
    return this.createSquad(matchId, { groupName });
  }

  /** 新增小队：序号接在该场该组末尾，命名自动「组名-序号」 */
  createSquad(matchId: number, input: SquadInput): SquadRow {
    const groupName = (input.groupName ?? '').trim();
    if (!groupName) throw new Error('战斗组不能为空');

    // 组必须存在于该场或模板里，否则报错（避免拼错组名产生孤儿队）
    const gk = this.groupKindOf(matchId, groupName);
    if (!gk) throw new Error(`未知战斗组：${groupName}`);

    const maxIdx = this.db.prepare(
      'SELECT COALESCE(MAX(index_in_group), 0) AS m FROM match_squad WHERE match_id = ? AND group_name = ?',
    ).get(matchId, groupName) as { m: number };
    const idx = input.indexInGroup && input.indexInGroup > 0 ? input.indexInGroup : Number(maxIdx.m) + 1;
    const name = `${groupName}-${idx}`;

    const dup = this.db.prepare(
      'SELECT 1 FROM match_squad WHERE match_id = ? AND name = ?',
    ).get(matchId, name);
    if (dup) throw new Error(`小队已存在：${name}`);

    const maxSort = this.db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS m FROM match_squad WHERE match_id = ?',
    ).get(matchId) as { m: number };
    this.db.prepare(
      `INSERT INTO match_squad
         (match_id, name, group_name, group_kind, index_in_group, tactic, size, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(matchId, name, groupName, gk, idx, (input.tactic ?? '').trim(),
      input.size && input.size > 0 ? Math.min(12, Math.round(input.size)) : 6,
      Number(maxSort.m) + 1);

    const row = this.findByName(matchId, name);
    if (!row) throw new Error('新增小队后读取失败');
    return row;
  }

  /** 只改战术（排表页队名列里直接改），限定该场 */
  setTactic(matchId: number, squadName: string, tactic: string): SquadRow {
    const t = (tactic ?? '').trim();
    if (t && !(TACTICS as readonly string[]).includes(t)) {
      throw new Error(`未知战术：${t}（可选：${TACTICS.join(' / ')}）`);
    }
    const info = this.db.prepare(
      'UPDATE match_squad SET tactic = ? WHERE match_id = ? AND name = ?',
    ).run(t, matchId, squadName);
    if (!info.changes) throw new Error(`小队不存在：${squadName}（本场）`);
    const row = this.findByName(matchId, squadName);
    if (!row) throw new Error('改战术后读取失败');
    return row;
  }

  /** 改某队人数（校验：不能小于该队已排人数） */
  setSize(matchId: number, squadName: string, size: number): SquadRow {
    const s = Math.round(Number(size));
    if (!Number.isFinite(s) || s < 1 || s > 12) throw new Error(`人数应在 1~12（当前传入 ${size}）`);
    const used = this.db.prepare(
      "SELECT COUNT(*) AS c FROM participation WHERE match_id = ? AND squad = ? AND state = 'PLAY'",
    ).get(matchId, squadName) as { c: number };
    if (Number(used.c) > s) {
      throw new Error(`「${squadName}」里已经有 ${used.c} 人，不能把人数改到 ${s} 以下`);
    }
    const info = this.db.prepare(
      'UPDATE match_squad SET size = ? WHERE match_id = ? AND name = ?',
    ).run(s, matchId, squadName);
    if (!info.changes) throw new Error(`小队不存在：${squadName}（本场）`);
    const row = this.findByName(matchId, squadName);
    if (!row) throw new Error('改人数后读取失败');
    return row;
  }

  /**
   * 删掉一场里的某一队。
   * 有历史记录就拒绝 —— participation.squad / squad_score.squad 都是按名字文本存的，
   * 直接删会让历史战报里的队名变成孤儿，看板与评分的小队维度都会对不上。
   */
  removeSquad(matchId: number, squadName: string): boolean {
    const used = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM participation p WHERE p.match_id = ? AND p.squad = ?) AS parts,
         (SELECT COUNT(*) FROM squad_score q WHERE q.match_id = ? AND q.squad = ?) AS scores`,
    ).get(matchId, squadName, matchId, squadName) as { parts: number; scores: number };
    if (Number(used.parts) > 0 || Number(used.scores) > 0) {
      throw new Error(
        `「${squadName}」在本场已有记录（参战 ${used.parts} 条 / 小队评分 ${used.scores} 条），不能删。`
        + '先把该队的人移到别队。',
      );
    }
    return this.db.prepare(
      'DELETE FROM match_squad WHERE match_id = ? AND name = ?',
    ).run(matchId, squadName).changes > 0;
  }
}
