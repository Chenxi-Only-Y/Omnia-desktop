/**
 * 数据库层：使用 Electron 内置的 node:sqlite（无需原生编译）
 *
 * 之所以不用 better-sqlite3：它是原生模块，需要为 Electron ABI 重新编译，
 * 依赖 VS Build Tools，是部署链上最大的不确定因素。
 * 将来若要换实现，只改 loadSqlite()。
 *
 * 关于「战斗组 / 小队」：设计基准 v2 里原本把它们写成常量（4 组 × 3 队 × 6 人），
 * 但用户明确要求「战斗组可新增、每组队伍数量不定」，因此改为数据库实体：
 *   combat_group（防守一/二、进攻一/二 … 可挂 leadership 等属性）
 *   squad       （防守二-3 这种，属于某个战斗组，默认 6 人）
 * 业务校验一律以库里的行为准，代码里不再硬编码组名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLASSES, DEFAULT_SQUADS, classIconFile } from '../shared/domain';

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (file: string) => SqlDatabase;
}

/** 装载 node:sqlite；失败时给出可执行的修复指引而不是直接崩溃 */
function loadSqlite(): SqliteModule {
  const attempts: string[] = [];
  for (const id of ['node:sqlite', 'sqlite']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(id) as Partial<SqliteModule>;
      if (typeof mod.DatabaseSync === 'function') return mod as SqliteModule;
      attempts.push(`${id}: 未导出 DatabaseSync`);
    } catch (err) {
      attempts.push(`${id}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    '无法加载 SQLite 运行时（node:sqlite）。请确认 Electron 版本 ≥ 35。\n详情：' +
      attempts.join(' | '),
  );
}

// ── 迁移脚本（只增不改：已发布的迁移永不修改，只追加新版本） ──────
interface Migration {
  version: number;
  name: string;
  up: (db: SqlDatabase) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init-core',
    up: (db) => {
      db.exec(`
        CREATE TABLE season (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL UNIQUE,
          started_at   TEXT NOT NULL DEFAULT '',
          ended_at     TEXT NOT NULL DEFAULT '',
          remark       TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE rule_set (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          season_id         INTEGER REFERENCES season(id) ON DELETE SET NULL,
          name              TEXT NOT NULL,
          base_score        REAL NOT NULL DEFAULT 60,
          cap_score         REAL NOT NULL DEFAULT 100,
          scale_team        REAL NOT NULL DEFAULT 20,
          scale_personal    REAL NOT NULL DEFAULT 40,
          death_pen         REAL NOT NULL DEFAULT 3,
          total_towers      INTEGER NOT NULL DEFAULT 9,
          weights_json      TEXT NOT NULL DEFAULT '{}',
          class_coef_json   TEXT NOT NULL DEFAULT '{}',
          bonus_json        TEXT NOT NULL DEFAULT '{}',
          version           INTEGER NOT NULL DEFAULT 1,
          created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE class (
          name        TEXT PRIMARY KEY,
          aliases     TEXT NOT NULL DEFAULT '',
          color       TEXT NOT NULL DEFAULT '#888888',
          icon_file   TEXT,
          coef        REAL NOT NULL DEFAULT 1,
          role        TEXT NOT NULL DEFAULT 'DPS',
          sort_order  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE player (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id       TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL DEFAULT '',
          joined_order  INTEGER,
          mic           TEXT NOT NULL DEFAULT '',
          note_role     TEXT NOT NULL DEFAULT '',
          main_class    TEXT NOT NULL DEFAULT '',
          sub_class     TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'active',
          remark        TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX idx_player_name ON player(name);
        CREATE INDEX idx_player_main_class ON player(main_class);

        CREATE TABLE match (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          season_id         INTEGER REFERENCES season(id) ON DELETE SET NULL,
          date              TEXT NOT NULL,
          index_in_day      INTEGER NOT NULL DEFAULT 1,
          our_side          TEXT NOT NULL DEFAULT '',
          opp_side          TEXT NOT NULL DEFAULT '',
          result            TEXT NOT NULL DEFAULT 'WIN',
          our_towers_left   INTEGER NOT NULL DEFAULT 9,
          opp_towers_left   INTEGER NOT NULL DEFAULT 9,
          state             TEXT NOT NULL DEFAULT 'draft',
          rule_set_id       INTEGER REFERENCES rule_set(id) ON DELETE SET NULL,
          remark            TEXT NOT NULL DEFAULT '',
          created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(date, index_in_day, our_side, opp_side)
        );

        CREATE TABLE match_side (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id   INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
          side       TEXT NOT NULL,
          alliance   TEXT NOT NULL DEFAULT '',
          is_ours    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE participation (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id    INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
          player_id   INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
          side        TEXT NOT NULL DEFAULT 'our',
          squad       TEXT NOT NULL DEFAULT '',
          tactic      TEXT NOT NULL DEFAULT '',
          team_role   TEXT NOT NULL DEFAULT '',
          class_used  TEXT NOT NULL DEFAULT '',
          note_role   TEXT NOT NULL DEFAULT '',
          mic         TEXT NOT NULL DEFAULT '',
          state       TEXT NOT NULL DEFAULT 'PLAY',
          UNIQUE(match_id, player_id, side)
        );
        CREATE INDEX idx_part_match ON participation(match_id);

        CREATE TABLE combat_stat (
          participation_id   INTEGER PRIMARY KEY REFERENCES participation(id) ON DELETE CASCADE,
          kills              INTEGER NOT NULL DEFAULT 0,
          fountain_kills     INTEGER NOT NULL DEFAULT 0,
          assists            INTEGER NOT NULL DEFAULT 0,
          resource           INTEGER NOT NULL DEFAULT 0,
          dmg_player         INTEGER NOT NULL DEFAULT 0,
          dmg_player_armor   INTEGER NOT NULL DEFAULT 0,
          dmg_building       INTEGER NOT NULL DEFAULT 0,
          dmg_building_armor INTEGER NOT NULL DEFAULT 0,
          healing            INTEGER NOT NULL DEFAULT 0,
          damage_taken       INTEGER NOT NULL DEFAULT 0,
          deaths             INTEGER NOT NULL DEFAULT 0,
          revives            INTEGER NOT NULL DEFAULT 0,
          bone_burn          INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE squad_score (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id     INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
          squad        TEXT NOT NULL,
          tactic       TEXT NOT NULL DEFAULT '',
          exec_raw     REAL NOT NULL DEFAULT 0,
          exec_parts   TEXT NOT NULL DEFAULT '{}',
          team_score   REAL NOT NULL DEFAULT 0,
          UNIQUE(match_id, squad)
        );

        CREATE TABLE score (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          participation_id  INTEGER NOT NULL REFERENCES participation(id) ON DELETE CASCADE,
          rule_set_id       INTEGER REFERENCES rule_set(id) ON DELETE SET NULL,
          engine            TEXT NOT NULL DEFAULT '',
          eff_json          TEXT NOT NULL DEFAULT '{}',
          personal_raw      REAL NOT NULL DEFAULT 0,
          personal_ratio    REAL NOT NULL DEFAULT 0,
          personal_score    REAL NOT NULL DEFAULT 0,
          team_score        REAL NOT NULL DEFAULT 0,
          bonus             REAL NOT NULL DEFAULT 0,
          death_penalty     REAL NOT NULL DEFAULT 0,
          total             REAL NOT NULL DEFAULT 0,
          computed_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(participation_id, rule_set_id)
        );

        CREATE TABLE app_setting (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL DEFAULT ''
        );
      `);
    },
  },
  {
    version: 2,
    name: 'seed-class-and-defaults',
    up: (db) => {
      const ins = db.prepare(
        `INSERT INTO class (name, aliases, color, icon_file, coef, role, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           aliases = excluded.aliases, color = excluded.color,
           coef = excluded.coef, role = excluded.role`,
      );
      CLASSES.forEach((c, i) => {
        ins.run(c.name, c.aliases.join(','), c.color, classIconFile(c.name), c.coef, c.role, i);
      });

      db.prepare(
        `INSERT INTO season (id, name, started_at, ended_at, remark)
         VALUES (1, '默认赛季', '', '', '由迁移脚本初始化')
         ON CONFLICT(id) DO NOTHING`,
      ).run();

      const coefs = JSON.stringify(Object.fromEntries(CLASSES.map((c) => [c.name, c.coef])));
      db.prepare(
        `INSERT INTO rule_set (id, season_id, name, weights_json, class_coef_json, bonus_json, version)
         VALUES (1, 1, '默认规则（算法待定）', '{}', ?, ?, 1)
         ON CONFLICT(id) DO NOTHING`,
      ).run(coefs, JSON.stringify({ 指挥: 2.5, 统战: 5, K龙: 5 }));

      db.prepare(
        `INSERT INTO app_setting (key, value) VALUES ('activeSeasonId', '1')
         ON CONFLICT(key) DO NOTHING`,
      ).run();
    },
  },
  {
    version: 3,
    name: 'class-icons-and-brand',
    up: (db) => {
      const upd = db.prepare('UPDATE class SET icon_file = ? WHERE name = ?');
      for (const c of CLASSES) upd.run(classIconFile(c.name), c.name);
      db.prepare(
        `INSERT INTO app_setting (key, value) VALUES ('brandName', '万象·Omnia')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run();
      db.prepare(
        `INSERT INTO app_setting (key, value) VALUES ('brandSlogan', 'All leagues. One universe. / 万象归一，联赛集成')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run();
    },
  },
  {
    version: 4,
    name: 'combat-groups-and-squads',
    up: (db) => {
      // 战斗组与小队改为数据实体：组可新增，组内队伍数量不定
      db.exec(`
        CREATE TABLE combat_group (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL UNIQUE,
          kind        TEXT NOT NULL DEFAULT 'attack',   -- defend | attack
          sort_order  INTEGER NOT NULL DEFAULT 0,
          remark      TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE squad (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id    INTEGER NOT NULL REFERENCES combat_group(id) ON DELETE CASCADE,
          index_in_group INTEGER NOT NULL,               -- 组内第几队 → 命名 组名-N
          name        TEXT NOT NULL UNIQUE,             -- 如 "防守二-3"
          tactic      TEXT NOT NULL DEFAULT '',          -- 塔后拆 / 塔前拆 / 保镖 / 防守
          size        INTEGER NOT NULL DEFAULT 6,
          sort_order  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_squad_group ON squad(group_id);
      `);

      const grp = db.prepare(
        'INSERT INTO combat_group (name, kind, sort_order) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING',
      );
      const sqd = db.prepare(
        `INSERT INTO squad (group_id, index_in_group, name, tactic, size, sort_order)
         VALUES ((SELECT id FROM combat_group WHERE name = ?), ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      );
      for (const g of DEFAULT_SQUADS) {
        grp.run(g.group, g.kind, g.sortOrder);
        sqd.run(g.group, g.indexInGroup, g.name, g.tactic, 6, g.sortOrder);
      }
    },
  },
  {
    version: 5,
    name: 'signup',
    up: (db) => {
      // 报名/请假与"上场名单"分开：报名是意愿（参加/请假/替补/未报名），
      // 上场名单是排表结果，两者可以不一致（人工调整后会有差异）。
      db.exec(`
        CREATE TABLE signup (
          match_id    INTEGER NOT NULL REFERENCES match(id) ON DELETE CASCADE,
          player_id   INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
          status      TEXT NOT NULL DEFAULT 'JOIN',
          remark      TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          PRIMARY KEY (match_id, player_id)
        );
        CREATE INDEX idx_signup_match ON signup(match_id);
      `);
    },
  },
  {
    version: 6,
    name: 'squad_alias',
    up: (db) => {
      // 小队别名：旧表里小队写作「防守一2」（无连字符），本系统按用户口径命名为
      // 「防守二-3」（带连字符）。历史战报、旧表导出的名字直接查库会查不到，
      // 于是战术与攻/防类别静默变成空 —— 打分时少了战术执行分还看不出原因。
      // 这里用一张别名表兜住，和职业别名（findClass 的 aliases）同一个思路。
      db.exec(`
        CREATE TABLE squad_alias (
          squad_id  INTEGER NOT NULL REFERENCES squad(id) ON DELETE CASCADE,
          alias     TEXT NOT NULL,
          PRIMARY KEY (squad_id, alias)
        );
        CREATE INDEX idx_squad_alias ON squad_alias(alias);
      `);

      // 为现有小队补上「组名+序号」这个旧写法作为别名
      const rows = db.prepare(
        `SELECT s.id, s.index_in_group, g.name AS group_name
         FROM squad s JOIN combat_group g ON g.id = s.group_id`,
      ).all() as unknown as { id: number; index_in_group: number; group_name: string }[];
      const ins = db.prepare(
        'INSERT INTO squad_alias (squad_id, alias) VALUES (?, ?) ON CONFLICT DO NOTHING',
      );
      for (const r of rows) {
        ins.run(r.id, `${r.group_name}${r.index_in_group}`);   // 旧表写法：防守一2
      }
    },
  },
  {
    version: 7,
    name: 'participation_skill_note',
    up: (db) => {
      // 本场技能备注：排表页每张队员卡片上直接填写的自由文本。
      // 挂在 participation（人 × 场）而不是 player 上 —— 同一个人不同场次、
      // 不同小队的技能安排本来就不一样，写进主档会把上一场的备注带到下一场。
      db.exec(`ALTER TABLE participation ADD COLUMN skill_note TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    version: 8,
    name: 'ensure_default_squads',
    up: (db) => {
      // 把初始建制的 12 队（4 组 × 3 队）补齐到老库里。
      // **只加不删**：同名队伍已存在就跳过（ON CONFLICT DO NOTHING），
      // 不覆盖用户自己改过的战术/人数，也绝不删任何已有队伍。
      // 「每组队数不固定」由界面负责：排表页可随时＋加一队 / ×删队。
      const grp = db.prepare(
        'INSERT INTO combat_group (name, kind, sort_order) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING',
      );
      const sqd = db.prepare(
        `INSERT INTO squad (group_id, index_in_group, name, tactic, size, sort_order)
         VALUES ((SELECT id FROM combat_group WHERE name = ?), ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      );
      const alias = db.prepare(
        `INSERT INTO squad_alias (squad_id, alias)
         SELECT id, ? FROM squad WHERE name = ?
         ON CONFLICT DO NOTHING`,
      );
      for (const g of DEFAULT_SQUADS) {
        grp.run(g.group, g.kind, g.sortOrder);
        sqd.run(g.group, g.indexInGroup, g.name, g.tactic, g.size, g.sortOrder);
        alias.run(`${g.group}${g.indexInGroup}`, g.name);   // 旧写法别名：防守一3
      }
    },
  },
  {
    version: 9,
    name: 'participation_slot_no',
    up: (db) => {
      // 落位槽号：排表页要「点哪个空位就填哪个位置」，必须知道谁站在第几格。
      // 挂在 participation（人 × 场）上；-1 表示未指定（按加入顺序排）。
      db.exec(`ALTER TABLE participation ADD COLUMN slot_no INTEGER NOT NULL DEFAULT -1`);
    },
  },
  {
    version: 10,
    name: 'single_id_signup_classes',
    up: (db) => {
      // ── 1) 成员身份合并成单列「ID」 ──────────────────────────────
      // 用户口径：主档里的「ID名」和「昵称」合成一个字段，就叫 ID。
      // 以 game_id 为准（它本来就是 ID名，且带 UNIQUE）；为空时用 name 补，
      // 补的时候跳过会撞 UNIQUE 的那些，避免整条迁移失败。
      db.exec(`
        UPDATE player SET game_id = name
         WHERE trim(COALESCE(game_id, '')) = ''
           AND trim(COALESCE(name, '')) <> ''
           AND NOT EXISTS (
             SELECT 1 FROM player p2 WHERE p2.game_id = player.name AND p2.id <> player.id
           )`);
      // name 跟随 game_id，避免两处显示不一致（不再作为独立字段使用）
      db.exec(`UPDATE player SET name = game_id WHERE name <> game_id`);

      // ── 2) 删除主职业 / 副职业（职业改为只从报名表来） ─────────────
      db.exec(`DROP INDEX IF EXISTS idx_player_main_class`);
      for (const col of ['main_class', 'sub_class']) {
        try {
          db.exec(`ALTER TABLE player DROP COLUMN ${col}`);
        } catch {
          // 个别 SQLite 版本不支持 DROP COLUMN：退化为留空列（界面已不使用）
          db.exec(`UPDATE player SET ${col} = ''`);
        }
      }

      // ── 3) 报名表带来的职业与麦克风 ──────────────────────────────
      // 「主职业(能打联赛)」「副职(能打联赛)」「有无麦克风」都来自报名表，
      // 因此存在 signup（人 × 场）上；主档不再持有职业。
      db.exec(`ALTER TABLE signup ADD COLUMN main_class TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE signup ADD COLUMN sub_class TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE signup ADD COLUMN mic TEXT NOT NULL DEFAULT ''`);
      // 报名表里的提交时间（原样保留，便于查重复提交的先后）
      db.exec(`ALTER TABLE signup ADD COLUMN submitted_at TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    version: 11,
    name: 'player_orange_weapon',
    up: (db) => {
      // 橙武：成员主档里「备注」之后的一列，默认空（界面显示为「-」）。
      // 空串与「-」都表示没有，所以只存空串，展示层再统一成「-」。
      db.exec(`ALTER TABLE player ADD COLUMN orange_weapon TEXT NOT NULL DEFAULT ''`);
      // 序（joined_order）允许改 → 排序必须稳定：先按序、再按 id。
      db.exec(`CREATE INDEX IF NOT EXISTS idx_player_joined_order ON player(joined_order)`);
    },
  },
];

export interface DbHandle {
  db: SqlDatabase;
  file: string;
}

export function openDatabase(file: string): DbHandle {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  runMigrations(db);
  return { db, file };
}

function currentVersion(db: SqlDatabase): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migration').get();
  return Number(row?.v ?? 0);
}

export function runMigrations(db: SqlDatabase): { from: number; to: number; applied: string[] } {
  const from = currentVersion(db);
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migration (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
      applied.push(`${m.version}:${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.version} (${m.name}) 失败：${(err as Error).message}`);
    }
  }
  return { from, to: currentVersion(db), applied };
}
