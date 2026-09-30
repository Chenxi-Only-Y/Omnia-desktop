/**
 * 成员解析（**唯一实现**）。
 *
 * 规则：按「当前角色 ID → 姓名 → 历史用名（player_alias）」三级解析出成员 id。
 *
 * 为什么单独抽出来：这条规则原来在四个地方各写了一遍
 * （PlayerRepo.resolveId / PlayerRepo.findOpp / SignupRepo.findPlayerId / ipc 的 rosterEntries），
 * 而且彼此已经出现细节差异（有的带 is_opp 过滤、有的带 LIMIT 1、有的不带）。
 * 战报导入、报名导入、手动加人全靠它认人 —— 一旦哪一份漏了历史用名，
 * 表现就是"改名后报名表整张对不上人"，所以必须只有一份。
 *
 * `side`：'our' = 只在我方成员里找（默认）；'opp' = 只在对方帮会成员里找。
 * 两者必须分开 —— 否则一次战报导入就可能把对手认成自己人（反之亦然）。
 */
import type { SqlDatabase } from '../db';

export function findPlayerIdByKey(
  db: SqlDatabase,
  rawKey: string,
  side: 'our' | 'opp' = 'our',
): number | undefined {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!key) return undefined;
  const opp = side === 'opp' ? 1 : 0;

  const byId = db.prepare('SELECT id FROM player WHERE game_id = ? AND is_opp = ?')
    .get(key, opp) as { id: number } | undefined;
  if (byId) return byId.id;

  // 姓名可能重复（旧数据），LIMIT 1 保证结果稳定而不是随查询计划变
  const byName = db.prepare('SELECT id FROM player WHERE name = ? AND is_opp = ? LIMIT 1')
    .get(key, opp) as { id: number } | undefined;
  if (byName) return byName.id;

  // 历史用名：改名后旧战报/旧报名靠这一步才能对上人（对方成员没有别名表，查了也是空）
  const byAlias = db.prepare(
    `SELECT a.player_id AS id FROM player_alias a JOIN player p ON p.id = a.player_id
     WHERE a.alias = ? AND p.is_opp = ? LIMIT 1`,
  ).get(key, opp) as { id: number } | undefined;
  return byAlias?.id;
}
