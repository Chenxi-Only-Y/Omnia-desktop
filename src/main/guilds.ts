/**
 * 帮会注册表 + **当前库句柄**（多帮会：一个帮会一个 SQLite 文件）。
 *
 * 用户口径 2026-09：
 *   「先按霜序客的我方，后续开发不同帮会的数据库独立存放（排表 / 个人 / 战局等信息）」
 *   「点击什么帮会才能进入某帮会整个数据库」
 *
 * 目录布局（都在 <userData> 下，和旧的 lis.db 同一层）：
 *
 *   guilds.json                注册表：帮会清单 + activeId + **全局设置**（壁纸这类与帮会无关的偏好）
 *   guilds/<id>.db             该帮会的一整套数据（成员 / 对局 / 排表 / 战报 / 评分 / 该帮会的设置）
 *   guilds/<id>/cover.png      帮会封面（本地选图后**拷贝**进来，原图删了也不影响）
 *   lis.db.bak-YYYYMMDD        首次迁移后留下的旧库备份（保底可回滚）
 *
 * 为什么要"取当前连接"的函数而不是把连接塞给仓储：
 *   切帮会要**不重启**就换库，仓储实例得留着，所以仓储拿的是 `() => SqlDatabase`，
 *   换库只换这里返回的句柄（见各仓储的 `private get db()`）。
 *
 * 单库模式（`OMNIA_DB_PATH`）：完全不走注册表 —— 自检与开发都靠它，
 * 行为必须和以前一模一样（一个文件、设置照旧写在库里的 app_setting）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { copyDatabase, openDatabase, type DbHandle, type SqlDatabase } from './db';
import type { GuildMeta } from '../shared/types';

interface Registry {
  version: number;
  activeId: string | null;
  guilds: GuildMeta[];
  /** 跨帮会的全局设置：壁纸、品牌名这类跟帮会数据无关的偏好 */
  settings: Record<string, string>;
}

const EMPTY: Registry = { version: 1, activeId: null, guilds: [], settings: {} };

/** 单库模式下虚拟出来的那一个帮会（不写注册表） */
const SINGLE: GuildMeta = {
  id: '__single__', name: '单库模式', note: '由 OMNIA_DB_PATH 指定，不走帮会注册表',
  createdAt: '', cover: null,
};

const now = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');

export class GuildStore {
  private reg: Registry;
  private handle: DbHandle | null = null;
  private readonly dir: string;
  private readonly regFile: string;
  private readonly legacyDb: string;

  constructor(private baseDir: string, private singleDb: string | null) {
    this.dir = path.join(baseDir, 'guilds');
    this.regFile = path.join(baseDir, 'guilds.json');
    this.legacyDb = path.join(baseDir, 'lis.db');
    this.reg = this.singleDb
      ? { ...EMPTY, guilds: [SINGLE], activeId: SINGLE.id }
      : this.readRegistry();
  }

  isSingle(): boolean { return this.singleDb !== null; }

  // ── 注册表 ───────────────────────────────────────────────────
  private readRegistry(): Registry {
    try {
      const j = JSON.parse(fs.readFileSync(this.regFile, 'utf8')) as Partial<Registry>;
      return {
        version: 1,
        activeId: j.activeId ?? null,
        guilds: Array.isArray(j.guilds) ? (j.guilds as GuildMeta[]) : [],
        settings: (j.settings && typeof j.settings === 'object') ? j.settings : {},
      };
    } catch {
      // 文件不存在 / JSON 坏了都当空注册表（坏掉的原文会另存一份，便于排查）
      if (fs.existsSync(this.regFile)) {
        try { fs.renameSync(this.regFile, `${this.regFile}.bad-${Date.now()}`); } catch { /* 忽略 */ }
      }
      return { ...EMPTY };
    }
  }

  private writeRegistry(): void {
    if (this.isSingle()) return;                 // 单库模式不落注册表
    fs.mkdirSync(this.baseDir, { recursive: true });
    const tmp = `${this.regFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.reg, null, 2), 'utf8');
    fs.renameSync(tmp, this.regFile);            // 原子替换：写一半断电也不会毁掉注册表
  }

  /**
   * 改动前先从磁盘重读一遍。
   *
   * 为什么必须重读：注册表是**整份写盘**的（不是逐行改），而内存里是一份快照。
   * 万一有两个进程（正常被单实例锁挡住，但开发/调试时可能同时开着），
   * 旧进程拿着过期快照一写，就会把别的进程刚删掉的帮会"复活"。
   * 重读 + 立刻写的窗口极小，且只在增删改时发生。
   */
  private refreshRegistry(): void {
    if (this.isSingle()) return;
    this.reg = this.readRegistry();
  }

  // ── 列表 / 当前 ──────────────────────────────────────────────
  list(): GuildMeta[] { return this.reg.guilds; }
  active(): GuildMeta | null {
    return this.reg.guilds.find((g) => g.id === this.reg.activeId) ?? null;
  }
  /** 当前帮会的连接。**没打开就抛错**，绝不静默退回别的库 */
  db(): SqlDatabase {
    if (!this.handle) throw new Error('还没有打开任何帮会的数据库');
    return this.handle.db;
  }
  file(): string {
    if (!this.handle) throw new Error('还没有打开任何帮会的数据库');
    return this.handle.file;
  }
  /** 某个帮会的库文件路径（单库模式下恒为那一个文件） */
  pathOf(id: string): string {
    if (this.singleDb) return this.singleDb;
    return path.join(this.dir, `${id}.db`);
  }
  /** 封面图目录（也能当"这个帮会的附属文件"目录用） */
  dirOf(id: string): string { return path.join(this.dir, id); }

  // ── 打开 / 切换 ──────────────────────────────────────────────
  /**
   * 打开（= 切到）某个帮会。已经开着同一个文件就什么都不做。
   * 切库顺序：先关旧库再开新库 —— 任一时刻只持有一个连接，避免写串。
   */
  open(id: string): GuildMeta {
    this.refreshRegistry();
    const g = this.reg.guilds.find((x) => x.id === id);
    if (!g) throw new Error(`帮会不存在：${id}`);
    const file = this.pathOf(id);
    if (this.handle && this.handle.file === file) {
      if (this.reg.activeId !== id) { this.reg.activeId = id; this.writeRegistry(); }
      return g;
    }
    const next = openDatabase(file);            // 先开后关：开失败就还留着旧库可用
    if (this.handle) { try { this.handle.db.close(); } catch { /* 忽略 */ } }
    this.handle = next;
    this.reg.activeId = id;
    this.writeRegistry();
    return g;
  }

  /** 启动时打开上次用的帮会；没有 activeId 就打开第一个；一个都没有 → 返回 null */
  openActive(): GuildMeta | null {
    const want = this.active() ?? this.reg.guilds[0] ?? null;
    if (!want) return null;
    return this.open(want.id);
  }

  // ── 增删改 ───────────────────────────────────────────────────
  /** 新建帮会：id 用时间戳（避免中文名进文件名/路径），显示名随时可改 */
  create(name: string, note = ''): GuildMeta {
    this.refreshRegistry();
    const n = String(name ?? '').trim();
    if (!n) throw new Error('帮会名不能为空');
    if (this.isSingle()) throw new Error('单库模式（OMNIA_DB_PATH）下不能新建帮会');
    const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const g: GuildMeta = { id, name: n, note: String(note ?? '').trim(), createdAt: now(), cover: null };
    this.reg.guilds.push(g);
    this.writeRegistry();
    return g;
  }

  rename(id: string, name: string, note?: string): GuildMeta {
    this.refreshRegistry();
    if (this.isSingle()) throw new Error('单库模式（OMNIA_DB_PATH）下不能改帮会名');
    const g = this.reg.guilds.find((x) => x.id === id);
    if (!g) throw new Error(`帮会不存在：${id}`);
    const n = String(name ?? '').trim();
    if (!n) throw new Error('帮会名不能为空');
    g.name = n;
    if (note !== undefined) g.note = String(note).trim();
    this.writeRegistry();
    return g;
  }

  /** 删除帮会：连库文件与封面目录一起删。当前打开的是它就先把连接放掉。 */
  remove(id: string): boolean {
    this.refreshRegistry();
    if (this.isSingle()) throw new Error('单库模式（OMNIA_DB_PATH）下不能删除帮会');
    const idx = this.reg.guilds.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const file = path.join(this.dir, `${id}.db`);
    if (this.handle && this.handle.file === file) {
      try { this.handle.db.close(); } catch { /* 忽略 */ }
      this.handle = null;
    }
    this.reg.guilds.splice(idx, 1);
    if (this.reg.activeId === id) {
      this.reg.activeId = this.reg.guilds[0]?.id ?? null;
      /* ⚠️ 删掉的正是当前打开的帮会时，上面的分支已经把 handle 置空 ✗，
         这里必须把新的 active **真正打开** —— 否则会出现"guild:active 有值、
         但 db()/file() 抛「还没有打开任何帮会的数据库」"的非法状态，
         界面表现是 app:info / player:list 全部失败直到手动点开某张卡片（审计 2026-09-30）。 */
      if (this.reg.activeId) this.open(this.reg.activeId);
    }
    this.writeRegistry();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
    }
    try { fs.rmSync(this.dirOf(id), { recursive: true, force: true }); } catch { /* 忽略 */ }
    return true;
  }

  /** 封面图：把用户选的图**拷贝**进 guilds/<id>/cover.png（原图之后删掉也不影响） */
  setCover(id: string, srcPath: string): GuildMeta {
    this.refreshRegistry();
    const g = this.reg.guilds.find((x) => x.id === id);
    if (!g) throw new Error(`帮会不存在：${id}`);
    const src = String(srcPath ?? '').trim();
    if (!src) throw new Error('没有选择图片');
    if (!fs.existsSync(src)) throw new Error(`图片不存在：${src}`);
    const dir = this.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'cover.png');
    fs.copyFileSync(src, dest);
    g.cover = dest;
    this.writeRegistry();
    return g;
  }

  // ── 全局设置（跨帮会）─────────────────────────────────────────
  /** 多帮会模式下读注册表里的 settings；单库模式返回空，调用方回落到库里的 app_setting */
  globalSettings(): Record<string, string> { return this.reg.settings; }
  globalSetting(key: string): string | undefined { return this.reg.settings[key]; }
  setGlobalSetting(key: string, value: string): void {
    this.reg.settings[key] = String(value ?? '');
    this.writeRegistry();
  }

  // ── 首次启动：把旧的 lis.db 迁成「霜序客」──────────────────────
  /**
   * 注册表里一个帮会都没有、而旧的 `<userData>/lis.db` 存在时：
   * 用 `VACUUM INTO` 复制一份成 `guilds/xusuanke.db`（一致的完整副本），
   * 然后把旧库改名成 `lis.db.bak-<日期>` 留底（不删，可回滚）。
   */
  migrateLegacy(): GuildMeta | null {
    if (this.isSingle() || this.reg.guilds.length) return null;
    if (!fs.existsSync(this.legacyDb)) return null;
    const id = 'xusuanke';
    const dest = path.join(this.dir, `${id}.db`);
    if (!fs.existsSync(dest)) copyDatabase(this.legacyDb, dest);
    const g: GuildMeta = {
      id, name: '霜序客', note: '由旧库 lis.db 迁移（旧文件已留 .bak 备份）',
      createdAt: now(), cover: null,
    };
    // 旧库里那几条"全局"设置搬进注册表，切帮会不会把壁纸弄丢
    try {
      const probe = openDatabase(dest);
      const rows = probe.db.prepare('SELECT key, value FROM app_setting').all() as unknown as
        { key: string; value: string }[];
      for (const r of rows) if (isGlobalSetting(r.key)) this.reg.settings[r.key] = r.value;
      probe.db.close();
    } catch { /* 读不到就算了，设置会用默认值 */ }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    try { fs.renameSync(this.legacyDb, `${this.legacyDb}.bak-${stamp}`); } catch { /* 改名失败不影响迁移结果 */ }
    this.reg.guilds.push(g);
    this.reg.activeId = g.id;
    this.writeRegistry();
    return g;
  }
}

/**
 * 哪些设置是**跨帮会**的（跟帮会数据无关的界面偏好）。
 * 其余设置（activeRuleSetId、dividerImage 这类）留在各帮会自己的库里。
 */
export function isGlobalSetting(key: string): boolean {
  return /^wallpaper/.test(key) || /^brand/.test(key);
}
