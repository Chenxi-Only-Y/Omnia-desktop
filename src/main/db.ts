/**
 * 主进程 SQLite 封装（CommonJS 输出，直接使用 require 加载内置模块）
 *
 * 用 Electron 内置的 node:sqlite，而不是原生模块 better-sqlite3：
 * 原生模块需要为 Electron ABI 重编译，依赖 VS Build Tools，是部署链上最大的不确定因素。
 * 将来若要换实现，只改 loadSqlite()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLASSES, classIconFile } from '../shared/domain';

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
      // M8：把从原表导出的职业图标写入字典；惊鸿暂无素材，保持 NULL
      const upd = db.prepare('UPDATE class SET icon_file = ? WHERE name = ?');
      for (const c of CLASSES) {
        const f = classIconFile(c.name);
        if (f) upd.run(f, c.name);
        else upd.run(null, c.name);
      }
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
