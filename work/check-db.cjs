/** 诊断：应用真正用的库、schema 版本、以及 slot_no 的实际情况。 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = path.join(process.env.APPDATA, 'omnia-desktop');
console.log('userData 目录:', dir);
for (const f of fs.readdirSync(dir)) {
  if (f.endsWith('.db') || f.endsWith('.db-wal')) {
    const st = fs.statSync(path.join(dir, f));
    console.log('  ', f, st.size, 'bytes  最后写入', st.mtime.toISOString());
  }
}

const db = new DatabaseSync(path.join(dir, 'lis.db'), { readOnly: true });
console.log('schema 版本 =', db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migration').get().v);
const cols = db.prepare('PRAGMA table_info(participation)').all().map((c) => c.name);
console.log('participation 列 =', cols.join(','));
console.log('有 slot_no =', cols.includes('slot_no'));
console.log('对局数 =', db.prepare('SELECT COUNT(*) AS c FROM match').get().c);
console.log('参战记录 =', db.prepare('SELECT COUNT(*) AS c FROM participation').get().c);
console.log('slot_no 分布 =', JSON.stringify(db.prepare('SELECT slot_no, COUNT(*) AS c FROM participation GROUP BY slot_no').all()));
console.log('队伍 =', db.prepare('SELECT COUNT(*) AS c FROM squad').get().c);
db.close();
