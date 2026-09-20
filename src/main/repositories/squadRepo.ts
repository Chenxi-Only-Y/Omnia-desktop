/**
 * 战斗组 / 小队建制仓储
 *
 * 用户口径：一共 10 个战斗队每队 6 人，10 个队划归到不同战斗组（每组划归小队数量不定），
 * 共 4 个战斗组：防守一 / 防守二 / 进攻一 / 进攻二，**可新增**。
 * 战斗组按队伍数量分 1/2/3：如防守二有 3 队，则第 3 队叫「防守二-3」。
 *
 * 因此组与小队的命名、归属、战术都在库里维护，代码不硬编码。
 */
import type { SqlDatabase, SqlValue } from '../db';
import type {
  CombatGroupRow, GroupInput, SquadCatalog, SquadInput, SquadRow,
} from '../../shared/types';
import type { GroupKind, Tactic } from '../../shared/domain';
import { TACTICS } from '../../shared/domain';

interface GroupDbRow {
  id: number; name: string; kind: string; sort_order: number; remark: string;
}
interface SquadDbRow {
  id: number; group_id: number; index_in_group: number; name: string;
  tactic: string; size: number; sort_order: number;
  group_name: string; kind: string;
}

const toGroup = (r: GroupDbRow): CombatGroupRow => ({
  id: r.id,
  name: r.name,
  kind: (r.kind === 'defend' ? 'defend' : 'attack') as GroupKind,
  sortOrder: r.sort_order,
  remark: r.remark ?? '',
});

const toSquad = (r: SquadDbRow): SquadRow => ({
  id: r.id,
  groupId: r.group_id,
  groupName: r.group_name,
  kind: (r.kind === 'defend' ? 'defend' : 'attack') as GroupKind,
  indexInGroup: r.index_in_group,
  name: r.name,
  tactic: (r.tactic || '') as Tactic | '',
  size: r.size,
  sortOrder: r.sort_order,
});

export class SquadRepo {
  constructor(private db: SqlDatabase) {}

  catalog(): SquadCatalog {
    const groups = (this.db.prepare(
      'SELECT * FROM combat_group ORDER BY sort_order ASC, id ASC',
    ).all() as unknown as GroupDbRow[]).map(toGroup);

    const squads = (this.db.prepare(
      `SELECT s.*, g.name AS group_name, g.kind
       FROM squad s JOIN combat_group g ON g.id = s.group_id
       ORDER BY g.sort_order ASC, s.index_in_group ASC, s.sort_order ASC`,
    ).all() as unknown as SquadDbRow[]).map(toSquad);

    return { groups, squads, capacity: squads.reduce((n, s) => n + s.size, 0) };
  }

  /** 战斗组可新增；名称唯一 */
  createGroup(input: GroupInput): CombatGroupRow {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('战斗组名称不能为空');
    if (this.db.prepare('SELECT 1 FROM combat_group WHERE name = ?').get(name)) {
      throw new Error(`战斗组已存在：${name}`);
    }
    const max = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM combat_group').get() as { m: number };
    const info = this.db.prepare(
      'INSERT INTO combat_group (name, kind, sort_order, remark) VALUES (?, ?, ?, ?)',
    ).run(name, input.kind === 'defend' ? 'defend' : 'attack', Number(max.m) + 1, (input.remark ?? '').trim());
    const row = this.db.prepare('SELECT * FROM combat_group WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as unknown as GroupDbRow;
    return toGroup(row);
  }

  removeGroup(id: number): boolean {
    const n = this.db.prepare('SELECT COUNT(*) AS c FROM squad WHERE group_id = ?').get(id) as { c: number };
    if (Number(n.c) > 0) throw new Error(`该战斗组下还有 ${n.c} 支小队，请先删除小队`);
    return this.db.prepare('DELETE FROM combat_group WHERE id = ?').run(id).changes > 0;
  }

  /**
   * 给某个战斗组"再加一队"。
   *
   * 用户口径：**每组队数不固定**，按需增删，人数不够就加。加到第 5 队就叫
   * 「组名-5」，第 6 队就叫「组名-6」，没有上限（序号取组内最大 +1）。
   * 排表页的「＋ 加一队」直接调它，免得为了加一队还要跳到设置页。
   */
  appendSquad(groupId: number): SquadRow {
    return this.createSquad({ groupId });
  }

  /** 新增小队：序号默认接在该组末尾，命名自动为「组名-序号」 */
  createSquad(input: SquadInput): SquadRow {
    const g = this.db.prepare('SELECT * FROM combat_group WHERE id = ?')
      .get(input.groupId) as unknown as GroupDbRow | undefined;
    if (!g) throw new Error(`战斗组不存在：id=${input.groupId}`);

    const maxIdx = this.db.prepare(
      'SELECT COALESCE(MAX(index_in_group), 0) AS m FROM squad WHERE group_id = ?',
    ).get(input.groupId) as { m: number };
    const idx = input.indexInGroup && input.indexInGroup > 0 ? input.indexInGroup : Number(maxIdx.m) + 1;
    const name = `${g.name}-${idx}`;

    if (this.db.prepare('SELECT 1 FROM squad WHERE name = ?').get(name)) {
      throw new Error(`小队已存在：${name}`);
    }
    const maxSort = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM squad').get() as { m: number };
    const info = this.db.prepare(
      `INSERT INTO squad (group_id, index_in_group, name, tactic, size, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.groupId, idx, name,
      (input.tactic ?? '').trim(),
      input.size && input.size > 0 ? Math.min(12, Math.round(input.size)) : 6,
      Number(maxSort.m) + 1,
    );
    const row = this.db.prepare(
      `SELECT s.*, g.name AS group_name, g.kind FROM squad s
       JOIN combat_group g ON g.id = s.group_id WHERE s.id = ?`,
    ).get(Number(info.lastInsertRowid)) as unknown as SquadDbRow;
    // 新增小队时顺手登记旧写法别名，保证「补一队」之后历史战报也能对上
    this.addAlias(row.id, SquadRepo.aliasFor(g.name, idx));
    return toSquad(row);
  }

  /**
   * 删掉一队。
   *
   * 有历史记录就拒绝 —— participation.squad 与 squad_score.squad 都是按名字文本存的
   * （没有外键约束），直接删会让历史战报里的队名变成"查不到的孤儿"，
   * 看板与评分的小队维度都会对不上。要删先把该队的人移走/清掉历史。
   */
  /** 只改战术（排表页队名列里直接改），不碰名称/人数/归属 */
  setTactic(id: number, tactic: string): SquadRow {
    const t = (tactic ?? '').trim();
    if (t && !(TACTICS as readonly string[]).includes(t)) {
      throw new Error(`未知战术：${t}（可选：${TACTICS.join(' / ')}）`);
    }
    const info = this.db.prepare('UPDATE squad SET tactic = ? WHERE id = ?').run(t, id);
    if (!info.changes) throw new Error(`小队不存在：id=${id}`);
    const row = this.db.prepare(
      `SELECT s.*, g.name AS group_name, g.kind FROM squad s
       JOIN combat_group g ON g.id = s.group_id WHERE s.id = ?`,
    ).get(id) as unknown as SquadDbRow;
    return toSquad(row);
  }
  removeSquad(id: number): boolean {
    const s = this.db.prepare('SELECT name FROM squad WHERE id = ?').get(id) as { name: string } | undefined;
    if (!s) return false;
    const used = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM participation p WHERE p.squad = ?) AS parts,
         (SELECT COUNT(*) FROM squad_score q WHERE q.squad = ?) AS scores`,
    ).get(s.name, s.name) as { parts: number; scores: number };
    if (Number(used.parts) > 0 || Number(used.scores) > 0) {
      throw new Error(
        `「${s.name}」已有历史记录（参战 ${used.parts} 条 / 小队评分 ${used.scores} 条），不能删。`
        + '先把该队的人移到别队，或保留该队。',
      );
    }
    return this.db.prepare('DELETE FROM squad WHERE id = ?').run(id).changes > 0;
  }

  /** 小队别名：旧表写「防守一2」，本系统写「防守二-3」（用户口径）。同一个队两种写法都要认 */
  private static aliasFor(groupName: string, indexInGroup: number): string {
    return `${groupName}${indexInGroup}`;
  }

  private addAlias(squadId: number, alias: string): void {
    this.db.prepare(
      'INSERT INTO squad_alias (squad_id, alias) VALUES (?, ?) ON CONFLICT DO NOTHING',
    ).run(squadId, alias);
  }

  /**
   * 把外来小队名（历史战报 / 旧表导出 / 手工输入）解析成本系统的小队。
   * 顺序：正式名 → 别名表 → 去掉连字符的猜测。
   * 认不出来就返回 undefined —— 宁可空着，也不要瞎认一个队，
   * 因为认错会把分数算到别的小队头上（战术执行分是按小队归一化的）。
   */
  resolve(name: string): SquadRow | undefined {
    const n = (name ?? '').trim();
    if (!n) return undefined;
    const direct = this.findByName(n);
    if (direct) return direct;

    const viaAlias = this.db.prepare(
      `SELECT s.*, g.name AS group_name, g.kind
       FROM squad_alias a
       JOIN squad s ON s.id = a.squad_id
       JOIN combat_group g ON g.id = s.group_id
       WHERE a.alias = ?`,
    ).get(n) as unknown as SquadDbRow | undefined;
    if (viaAlias) return toSquad(viaAlias);

    // 「防守一2」→「防守一-2」：把结尾的数字前插一个连字符再试一次
    const m = /^(.*?)(\d+)$/.exec(n);
    if (m) return this.findByName(`${m[1]}-${m[2]}`);
    return undefined;
  }

  /** 按名字找小队（写参战时用） */
  findByName(name: string): SquadRow | undefined {
    const r = this.db.prepare(
      `SELECT s.*, g.name AS group_name, g.kind FROM squad s
       JOIN combat_group g ON g.id = s.group_id WHERE s.name = ?`,
    ).get((name ?? '').trim()) as unknown as SquadDbRow | undefined;
    return r ? toSquad(r) : undefined;
  }

  /** 供参战校验使用：名字集合 */
  nameSet(): Set<string> {
    const rows = this.db.prepare('SELECT name FROM squad').all() as unknown as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  groupByName(name: string): CombatGroupRow | undefined {
    const r = this.db.prepare('SELECT * FROM combat_group WHERE name = ?')
      .get((name ?? '').trim()) as unknown as GroupDbRow | undefined;
    return r ? toGroup(r) : undefined;
  }

  /** 组名 → 类别，用于 team_role 判定 */
  kindOfGroup(name: string): GroupKind | '' {
    const g = this.groupByName(name);
    return g ? g.kind : '';
  }

  paramsForSquadName(name: string): { tactic: string; teamRole: string; kind: GroupKind | '' } {
    // 走 resolve：历史战报里的「防守一2」也要能取到战术与攻/防类别
    const s = this.resolve(name);
    if (!s) return { tactic: '', teamRole: '', kind: '' };
    return {
      tactic: s.tactic,
      teamRole: s.kind === 'defend' ? '防守' : '进攻',
      kind: s.kind,
    };
  }

  /** 从「防守二-3」这类名字里取出组名 */
  static groupOf(squadName: string): string {
    return (squadName ?? '').replace(/-\d+$/, '');
  }

  static sqlValue(v: unknown): SqlValue {
    return v as SqlValue;
  }
}
