const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const SQLITE_MODE = process.env.JINGTU_DB_ENGINE === 'sqlite';

// 从 .env 文件直接解析一个键值（兜底：当进程环境变量未注入 MYSQL_PASSWORD 时使用，
// 例如 ServBay 以自身方式拉起 Node 而未 source .env 的场景）。
function readEnvValueFromFile(key) {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return undefined;
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$'));
      if (m) {
        let v = m[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.substring(1, v.length - 1);
        }
        return v;
      }
    }
  } catch (e) {
    // 读不到就返回 undefined，回退到环境变量
  }
  return undefined;
}

function normalizeSecret(v) {
  if (!v) return '';
  v = String(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.substring(1, v.length - 1);
  }
  return v;
}

let password = normalizeSecret(process.env.MYSQL_PASSWORD);
if (!password) {
  // 进程环境无密码：尝试从 .env 文件兜底读取，避免 root@localhost 无密码连接
  const fromFile = readEnvValueFromFile('MYSQL_PASSWORD');
  if (fromFile) password = normalizeSecret(fromFile);
}
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  user: process.env.MYSQL_USER || 'root',
  port: parseInt(process.env.MYSQL_PORT) || 3306,
  timezone: '+08:00',
  charset: 'utf8mb4'
};
if (password && password !== '') {
  DB_CONFIG.password = password;
}

const DB_NAME = process.env.MYSQL_DATABASE || 'jingtu_group';

// holder 模式：所有模块通过 holder.pool 访问，recreate 后自动生效
const holder = { pool: null, dbName: DB_NAME };

function stripQ(name) {
  return String(name).replace(/[`"']/g, '').trim();
}

function qid(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function sqlError(errno, code, message) {
  const e = new Error(message);
  e.errno = errno;
  e.code = code;
  e.sqlState = 'HY000';
  return e;
}

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (d === undefined ? 0 : d);
}

function splitTopLevel(str, delim) {
  if (delim === undefined) delim = ',';
  const parts = [];
  let depth = 0;
  let cur = '';
  let inS = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inS) {
      cur += c;
      if (c === inS) {
        if (str[i + 1] === inS) { cur += inS; i++; continue; }
        inS = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { inS = c; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === delim && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function extractParen(s, openIdx) {
  let depth = 0;
  let inS = null;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inS) {
      if (c === inS) {
        if (s[i + 1] === inS) { i++; continue; }
        inS = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { inS = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { end: i, argStr: s.slice(openIdx + 1, i) };
    }
  }
  return { end: -1, argStr: null };
}

function splitIdentList(listStr) {
  return splitTopLevel(listStr).map(s => stripQ(s)).filter(Boolean);
}

function sqliteTypeOf(mysqlType) {
  const t = String(mysqlType || 'TEXT').toUpperCase();
  if (/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|BIT|BOOL|BOOLEAN)/.test(t)) return 'INTEGER';
  if (/^(DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)\b/.test(t)) return 'NUMERIC';
  if (/^JSON\b/.test(t)) return 'TEXT';
  return 'TEXT';
}

function parseColumnDef(clause) {
  const cm = /^`?([A-Za-z0-9_]+)`?\s+([\s\S]+)$/.exec(clause);
  const name = cm ? stripQ(cm[1]) : stripQ(clause.split(/\s+/)[0]);
  if (!name) {
    return { name: '', mysqlType: 'text', baseType: 'text', sqliteType: 'TEXT', notNull: false, defaultInSql: null, autoInc: false, primary: false, unique: false, isJson: false };
  }
  let rest = cm ? cm[2] : clause.slice(clause.indexOf(name) + name.length);
  const typeMatch = /^\s*([A-Za-z0-9_]+(?:\([^)]*\))?)([\s\S]*)$/.exec(rest);
  let mysqlType = 'text';
  if (typeMatch) {
    mysqlType = typeMatch[1].trim();
    rest = typeMatch[2] || '';
  }
  const baseType = mysqlType.replace(/\(.*/, '').toLowerCase();
  rest = rest.replace(/\bCOMMENT\s+(?:'[^']*'|"[^"]*"|\w+)/gi, ' ');
  rest = rest.replace(/\bAFTER\s+`?[A-Za-z0-9_]+`?/gi, ' ');
  rest = rest.replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\s*\(?\d*\)?\s*/gi, ' ');
  const notNull = /\bNOT\s+NULL\b/i.test(rest);
  const autoInc = /\bAUTO_INCREMENT\b/i.test(rest);
  const primary = /\bPRIMARY\s+KEY\b/i.test(rest);
  const unique = /\bUNIQUE\b/i.test(rest);
  rest = rest.replace(/\b(?:NOT\s+NULL|NULL|AUTO_INCREMENT|PRIMARY\s+KEY|UNIQUE)\b/gi, ' ');
  let defaultInSql = null;
  const defMatch = /\bDEFAULT\s+((?:CURRENT_TIMESTAMP(?:\(\s*\d*\s*\))?)|(?:'[^']*')|(?:"[^"]*")|(?:[-+]?\d+(?:\.\d+)?)|(?:NULL)|(?:\([^)]*\)))\s*/i.exec(rest);
  if (defMatch) defaultInSql = defMatch[1];
  const notNullEffective = notNull || autoInc || primary;
  return {
    name,
    mysqlType,
    baseType,
    sqliteType: sqliteTypeOf(mysqlType),
    notNull: notNullEffective,
    defaultInSql,
    autoInc,
    primary,
    unique,
    isJson: /^json\b/i.test(baseType)
  };
}

let sqliteDb = null;
let sqliteFilePath = '';

const tableMeta = new Map();
const jsonColumns = new Map();

function getSQLiteDb() {
  if (sqliteDb) return sqliteDb;
  sqliteFilePath = process.env.JINGTU_SQLITE_PATH || path.join(__dirname, 'data', 'jingtu.sqlite');
  if (sqliteFilePath !== ':memory:') {
    fs.mkdirSync(path.dirname(sqliteFilePath), { recursive: true });
  }
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(sqliteFilePath);
  sqliteDb.exec('PRAGMA journal_mode = WAL');
  sqliteDb.exec('PRAGMA busy_timeout = 5000');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  registerSQLiteFunctions(sqliteDb);
  ensureSessionsTable(sqliteDb);
  return sqliteDb;
}

function ensureSessionsTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS "sessions" ("session_id" TEXT NOT NULL PRIMARY KEY, "expires" INTEGER NOT NULL, "data" TEXT NOT NULL)');
  const cols = [
    { name: 'session_id', mysqlType: 'varchar(128)', baseType: 'varchar', sqliteType: 'TEXT', notNull: true, defaultInSql: null, autoInc: false, primary: true, unique: false, isJson: false },
    { name: 'expires', mysqlType: 'int', baseType: 'int', sqliteType: 'INTEGER', notNull: true, defaultInSql: null, autoInc: false, primary: false, unique: false, isJson: false },
    { name: 'data', mysqlType: 'longtext', baseType: 'longtext', sqliteType: 'TEXT', notNull: true, defaultInSql: null, autoInc: false, primary: false, unique: false, isJson: false }
  ];
  const colMap = new Map();
  for (const c of cols) colMap.set(c.name, c);
  recordTableMeta('sessions', { name: 'sessions', columns: cols, colMap, tailPk: null, tailUnique: [], tailIndex: [], jsonCols: new Set() });
}

function registerSQLiteFunctions(db) {
  db.function('regexp', { deterministic: true }, (pattern, value) => {
    if (pattern === null || pattern === undefined || value === null || value === undefined) return 0;
    try {
      return new RegExp(String(pattern)).test(String(value)) ? 1 : 0;
    } catch (_) {
      return 0;
    }
  });
  db.function('find_in_set', { deterministic: true, varargs: true }, (needle, hay) => {
    if (needle === null || needle === undefined || hay === null || hay === undefined) return 0;
    const idx = String(hay).split(',').indexOf(String(needle));
    return idx >= 0 ? idx + 1 : 0;
  });
  db.function('greatest', { deterministic: true, varargs: true }, (...vals) => {
    let best = null;
    for (const v of vals) {
      if (v === null || v === undefined) continue;
      if (best === null) { best = v; continue; }
      const nv = Number(v);
      const nb = Number(best);
      if (Number.isFinite(nv) && Number.isFinite(nb)) {
        if (nv > nb) best = v;
      } else if (v > best) {
        best = v;
      }
    }
    return best;
  });
  db.function('field', { deterministic: true, varargs: true }, (v, ...vals) => {
    if (v === null || v === undefined) return 0;
    const sv = String(v);
    const idx = vals.findIndex(x => x !== null && x !== undefined && String(x) === sv);
    return idx < 0 ? 0 : idx + 1;
  });
  db.function('unix_timestamp', { deterministic: true, varargs: true }, (...vals) => {
    const v = vals[0];
    if (v === null || v === undefined || v === '') return Math.floor(Date.now() / 1000);
    const n = Number(v);
    if (Number.isFinite(n) && String(v).trim() !== '') return n;
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  });
  db.function('database', { deterministic: true }, () => holder.dbName);
  db.function('json_contains', { deterministic: true, varargs: true }, (target, candidate) => {
    if (target === null || target === undefined || candidate === null || candidate === undefined) return 0;
    try {
      const t = JSON.parse(String(target));
      const c = JSON.parse(String(candidate));
      return jsonContains(t, c) ? 1 : 0;
    } catch (_) {
      return 0;
    }
  });
  db.function('json_unquote', { deterministic: true }, (v) => {
    if (typeof v !== 'string') return v;
    try {
      const parsed = JSON.parse(v);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed);
      return parsed;
    } catch (_) {
      return v;
    }
  });
}

function jsonContains(t, c) {
  if (Array.isArray(t)) {
    return t.some(el => jsonContains(el, c));
  }
  if (t && typeof t === 'object') {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      return Object.keys(c).every(k => k in t && jsonContains(t[k], c[k]));
    }
    return false;
  }
  return t === c;
}

function parseCreateTable(tableName, sqlStr) {
  const open = sqlStr.indexOf('(');
  const close = open >= 0 ? (function () {
    let depth = 0;
    let inS = null;
    for (let i = open; i < sqlStr.length; i++) {
      const c = sqlStr[i];
      if (inS) {
        if (c === inS) {
          if (sqlStr[i + 1] === inS) { i++; continue; }
          inS = null;
        }
        continue;
      }
      if (c === "'" || c === '"') { inS = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  })() : -1;
  if (open < 0 || close < 0) throw new Error('无法解析 CREATE TABLE: ' + String(sqlStr).slice(0, 80));
  const body = sqlStr.slice(open + 1, close);
  const parts = splitTopLevel(body);
  const columns = [];
  const colMap = new Map();
  const tailUnique = [];
  const tailIndex = [];
  let tailPk = null;
  let idxAuto = 0;
  for (const rawPart of parts) {
    const clause = rawPart.trim();
    if (!clause) continue;
    if (/^PRIMARY\s+KEY/i.test(clause)) {
      const cm = /\(\s*([^)]*?)\s*\)/.exec(clause);
      tailPk = cm ? splitIdentList(cm[1]) : [];
      continue;
    }
    if (/^UNIQUE\s+(KEY|INDEX)/i.test(clause)) {
      const m = /^UNIQUE\s+(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/.exec(clause);
      tailUnique.push({ name: m ? m[1] : ('uk_' + (++idxAuto)), cols: m ? splitIdentList(m[2]) : [] });
      continue;
    }
    if (/^(KEY|INDEX)\b/i.test(clause)) {
      const m = /^(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/.exec(clause);
      tailIndex.push({ name: m ? m[1] : ('idx_' + (++idxAuto)), cols: m ? splitIdentList(m[2]) : [] });
      continue;
    }
    if (/^(CONSTRAINT|FOREIGN\s+KEY|CHECK\s*\()/i.test(clause)) continue;
    const col = parseColumnDef(clause);
    if (col.name) {
      columns.push(col);
      colMap.set(col.name, col);
    }
  }
  if (String(tableName).toLowerCase() === 'member_note') {
    const n = (x) => (x === 'owner_vrcid' ? 'owner_id' : (x === 'target_vrcid' ? 'target_id' : x));
    for (const col of columns) {
      if (col.name === 'owner_vrcid') {
        col.name = 'owner_id'; col.mysqlType = 'int'; col.baseType = 'int'; col.sqliteType = 'INTEGER'; col.isJson = false;
      } else if (col.name === 'target_vrcid') {
        col.name = 'target_id'; col.mysqlType = 'int'; col.baseType = 'int'; col.sqliteType = 'INTEGER'; col.isJson = false;
      }
    }
    for (const u of tailUnique) u.cols = u.cols.map(n);
    for (const i of tailIndex) i.cols = i.cols.map(n);
    if (!tailIndex.some(x => x.name === 'idx_owner')) tailIndex.push({ name: 'idx_owner', cols: ['owner_id'] });
    if (!tailIndex.some(x => x.name === 'idx_target')) tailIndex.push({ name: 'idx_target', cols: ['target_id'] });
  }
  const jsonColSet = new Set();
  for (const col of columns) if (col.isJson) jsonColSet.add(col.name);
  return { name: String(tableName), columns, colMap, tailPk, tailUnique, tailIndex, jsonCols: jsonColSet };
}

function generateSQLiteDDL(tableName, meta) {
  const pkCols = meta.tailPk || [];
  let useTailPk = pkCols.length > 0;
  if (pkCols.length === 1) {
    const c0 = meta.columns.find(c => c.name === pkCols[0]);
    if (c0 && c0.autoInc) useTailPk = false;
  }
  const tailPkSet = new Set(useTailPk ? pkCols : []);
  const lines = meta.columns.map((col) => {
    const colAutoPk = col.autoInc && ((col.primary && !useTailPk) || (pkCols.length === 1 && pkCols[0] === col.name && !useTailPk));
    if (colAutoPk) return qid(col.name) + ' INTEGER PRIMARY KEY AUTOINCREMENT';
    let needNotNull = col.notNull;
    if (col.primary && !useTailPk) needNotNull = true;
    if (tailPkSet.has(col.name)) needNotNull = true;
    let def = qid(col.name) + ' ' + col.sqliteType;
    if (col.primary && !useTailPk) def += ' PRIMARY KEY';
    if (col.unique) def += ' UNIQUE';
    if (needNotNull) def += ' NOT NULL';
    if (col.defaultInSql !== null && col.defaultInSql !== undefined) def += ' DEFAULT ' + col.defaultInSql;
    return def;
  });
  let tail = '';
  if (useTailPk) {
    tail += ',\n PRIMARY KEY (' + pkCols.map(c => qid(c)).join(', ') + ')';
  }
  const tableDef = 'CREATE TABLE IF NOT EXISTS ' + qid(tableName) + ' (\n ' + lines.join(',\n ') + tail + '\n)';
  const statements = [tableDef];
  for (const u of meta.tailUnique) {
    statements.push('CREATE UNIQUE INDEX IF NOT EXISTS ' + qid(u.name) + ' ON ' + qid(tableName) + ' (' + u.cols.map(c => qid(c)).join(', ') + ')');
  }
  for (const i of meta.tailIndex) {
    statements.push('CREATE INDEX IF NOT EXISTS ' + qid(i.name) + ' ON ' + qid(tableName) + ' (' + i.cols.map(c => qid(c)).join(', ') + ')');
  }
  return statements.join(';\n') + ';';
}

function recordTableMeta(tableName, meta) {
  const key = String(tableName).toLowerCase();
  tableMeta.set(key, meta);
  const js = new Set();
  for (const col of meta.columns) if (col.isJson) js.add(col.name);
  jsonColumns.set(key, js);
}

function bufferToType(sqliteType) {
  const t = String(sqliteType).toUpperCase();
  if (/INT/.test(t)) return 'int';
  if (/NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL/.test(t)) return 'decimal(10,2)';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'text';
  return 'varchar(255)';
}

function describeTable(tableName) {
  const db = getSQLiteDb();
  const ti = db.prepare('PRAGMA table_info(' + qid(tableName) + ')').all();
  const meta = tableMeta.get(String(tableName).toLowerCase());
  const indexList = db.prepare('PRAGMA index_list(' + qid(tableName) + ')').all();
  const colIdx = new Map();
  for (const idx of indexList) {
    const info = db.prepare('PRAGMA index_info(' + qid(idx.name) + ')').all();
    for (const col of info) {
      const cur = colIdx.get(col.name);
      if (!cur) colIdx.set(col.name, !!idx.unique);
      else if (!idx.unique) colIdx.set(col.name, false);
    }
  }
  const pkNames = new Set(ti.filter(c => c.pk).map(c => c.name));
  return ti.map(c => {
    let key = '';
    if (pkNames.has(c.name)) key = 'PRI';
    else if (colIdx.has(c.name)) key = colIdx.get(c.name) ? 'UNI' : 'MUL';
    const colMeta = meta && meta.colMap ? meta.colMap.get(c.name) : null;
    const mysqlType = colMeta ? colMeta.mysqlType : bufferToType(c.type);
    return {
      Field: c.name,
      Type: mysqlType,
      Null: c.notnull ? 'NO' : 'YES',
      Key: key,
      Default: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
      Extra: colMeta && colMeta.autoInc ? 'auto_increment' : ''
    };
  });
}

function showIndexFrom(tableName) {
  const db = getSQLiteDb();
  const rows = [];
  const indexList = db.prepare('PRAGMA index_list(' + qid(tableName) + ')').all();
  for (const idx of indexList) {
    const info = db.prepare('PRAGMA index_info(' + qid(idx.name) + ')').all();
    for (const col of info) {
      rows.push({
        Key_name: idx.origin === 'pk' ? 'PRIMARY' : idx.name,
        Non_unique: idx.unique ? 0 : 1,
        Column_name: col.name,
        Seq_in_index: (col.seqno || 0) + 1
      });
    }
  }
  return rows;
}

function buildMySQLShowCreate(tableName) {
  const db = getSQLiteDb();
  let meta = tableMeta.get(String(tableName).toLowerCase());
  if (!meta) {
    const ti = db.prepare('PRAGMA table_info(' + qid(tableName) + ')').all();
    meta = {
      name: tableName,
      columns: ti.map(c => ({
        name: c.name,
        mysqlType: bufferToType(c.type),
        notNull: !!c.notnull,
        autoInc: false,
        primary: !!c.pk,
        defaultInSql: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value)
      })),
      colMap: null,
      tailPk: null,
      tailUnique: [],
      tailIndex: []
    };
  }
  const pkCols = meta.tailPk || meta.columns.filter(c => c.primary).map(c => c.name);
  const colDefs = meta.columns.map(c => {
    let d = '`' + c.name + '` ' + c.mysqlType;
    if (c.autoInc) d += ' AUTO_INCREMENT';
    if (c.notNull) d += ' NOT NULL';
    if (c.defaultInSql !== null && c.defaultInSql !== undefined) d += ' DEFAULT ' + c.defaultInSql;
    return d;
  });
  const pkPart = pkCols && pkCols.length ? ', PRIMARY KEY (`' + pkCols.join('`,`') + '`)' : '';
  const uniqPart = (meta.tailUnique || []).map(u => ', UNIQUE KEY `' + u.name + '` (' + u.cols.map(c => '`' + c + '`').join(',') + ')').join('');
  return 'CREATE TABLE `' + tableName + '` (' + colDefs.join(', ') + pkPart + uniqPart + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
}

function handledShow(sqlStr, params) {
  const db = getSQLiteDb();
  const upper = sqlStr.toUpperCase();
  const likeMatch = /LIKE\s+(['"])(.*?)\1/i.exec(sqlStr);
  const likeParam = likeMatch ? likeMatch[2] : (params && params.length ? String(params[0]) : null);
  if (/^SHOW\s+FULL\s+PROCESSLIST/i.test(upper)) return [];
  if (/^SHOW\s+TABLES/i.test(upper)) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return rows.map(r => ({ ['Tables_in_' + holder.dbName]: r.name }));
  }
  if (/^SHOW\s+TABLE\s+STATUS/i.test(upper)) {
    if (!likeParam) return [];
    let cnt = 0;
    try {
      cnt = db.prepare('SELECT COUNT(*) AS cnt FROM ' + qid(likeParam)).get().cnt || 0;
    } catch (_) { /* 表不存在 */ }
    return [{
      Name: likeParam, Engine: 'InnoDB', Version: 10, Row_format: 'Dynamic', Rows: cnt,
      Avg_row_length: 0, Data_length: 0, Max_data_length: 0, Index_length: 0, Data_free: 0,
      Auto_increment: null, Create_time: null, Update_time: null, Check_time: null,
      Collation: 'utf8mb4_unicode_ci', Checksum: null, Create_options: '', Comment: ''
    }];
  }
  if (/^SHOW\s+(?:GLOBAL\s+)?STATUS/i.test(upper)) {
    const map = { Uptime: 3600, Threads_connected: 0, Threads_running: 0, Queries: 0, Slow_queries: 0, Questions: 0, Connections: 1 };
    if (!likeParam) return Object.keys(map).map(k => ({ Variable_name: k, Value: String(map[k]) }));
    const val = Object.prototype.hasOwnProperty.call(map, likeParam) ? String(map[likeParam]) : '';
    return [{ Variable_name: likeParam, Value: val }];
  }
  if (/^SHOW\s+(?:GLOBAL\s+)?VARIABLES/i.test(upper)) {
    const map = {
      innodb_buffer_pool_size: '134217728', max_connections: '1000', query_cache_size: '0',
      tmp_table_size: '16777216', max_heap_table_size: '16777216', wait_timeout: '28800',
      interactive_timeout: '28800', innodb_log_file_size: '50331648', innodb_flush_log_at_trx_commit: '1',
      slow_query_log_file: '', slow_query_log: 'OFF', sql_mode: '', version: '8.0.0'
    };
    if (likeParam) {
      const val = Object.prototype.hasOwnProperty.call(map, likeParam) ? map[likeParam] : '';
      return [{ Variable_name: likeParam, Value: val }];
    }
    return Object.keys(map).map(k => ({ Variable_name: k, Value: map[k] }));
  }
  if (/^SHOW\s+DATABASES/i.test(upper)) return [{ Database: holder.dbName }];
  if (/^SHOW\s+CREATE\s+TABLE/i.test(upper)) {
    const m = /^SHOW\s+CREATE\s+TABLE\s+`?(\w+)`?/i.exec(sqlStr);
    const tname = m ? m[1] : (likeParam || null);
    if (!tname) return [];
    return [{ 'Create Table': buildMySQLShowCreate(tname) }];
  }
  if (/^SHOW\s+INDEX\s+FROM/i.test(upper)) {
    const m = /^SHOW\s+INDEX\s+FROM\s+`?(\w+)`?/i.exec(sqlStr);
    return m ? showIndexFrom(m[1]) : [];
  }
  if (/^SHOW\s+COLUMNS\s+FROM/i.test(upper)) {
    const m = /^SHOW\s+COLUMNS\s+FROM\s+`?(\w+)`?/i.exec(sqlStr);
    return m ? describeTable(m[1]) : [];
  }
  if (/^SHOW\s+(?:WARNINGS|ERRORS|ENGINES|CHARSET|COLLATION|PLUGINS|PRIVILEGES)/i.test(upper)) return [];
  return [];
}

function handledDescribe(sqlStr) {
  const m = /^\s*DESCRIBE\s+`?(\w+)`?/i.exec(sqlStr) || /^\s*DESC\s+`?(\w+)`?/i.exec(sqlStr);
  return m ? describeTable(m[1]) : [];
}

function handledInfoSchema(sqlStr, params) {
  const db = getSQLiteDb();
  if (/FROM\s+information_schema\.TABLES/i.test(sqlStr)) {
    if (/\bCOUNT\s*\(\s*\*\s*\)/i.test(sqlStr)) {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
      return [{ cnt: row ? row.cnt : 0 }];
    }
    return [];
  }
  if (/FROM\s+information_schema\.COLUMNS/i.test(sqlStr)) {
    const tname = params && params[0] ? String(params[0]) : null;
    const colKey = params && params[1] ? String(params[1]) : null;
    if (tname) {
      const meta = tableMeta.get(tname.toLowerCase());
      if (meta) {
        return meta.columns
          .filter(c => colKey === 'PRI' ? c.primary : true)
          .map(c => ({ COLUMN_NAME: c.name, DATA_TYPE: c.baseType || c.mysqlType.replace(/\(.*/, '') }));
      }
    }
    return [];
  }
  return [];
}

function sanitizeParam(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) {
    const p = (x) => String(x).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate()) + ' ' + p(v.getHours()) + ':' + p(v.getMinutes()) + ':' + p(v.getSeconds());
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

function intervalModifier(sign, unit, num) {
  const n = num;
  const u = String(unit || '').toUpperCase();
  switch (u) {
    case 'DAY': return "'" + sign + "' || " + n + " || ' days'";
    case 'HOUR': return "'" + sign + "' || " + n + " || ' hours'";
    case 'MINUTE': return "'" + sign + "' || " + n + " || ' minutes'";
    case 'SECOND': return "'" + sign + "' || " + n + " || ' seconds'";
    case 'WEEK': return "'" + sign + "' || (" + n + " * 7) || ' days'";
    case 'MONTH': return "'" + sign + "' || " + n + " || ' months'";
    case 'YEAR': return "'" + sign + "' || " + n + " || ' years'";
    default: return "'" + sign + "' || " + n + " || '" + u.toLowerCase() + "s'";
  }
}

function rewriteFunctionCalls(s) {
  const rewrites = [
    { name: 'YEAR', fmt: 'CAST(strftime(\'%Y\', %args) AS INTEGER)' },
    { name: 'MONTH', fmt: 'CAST(strftime(\'%m\', %args) AS INTEGER)' },
    { name: 'DAY', fmt: 'CAST(strftime(\'%d\', %args) AS INTEGER)' },
    { name: 'HOUR', fmt: 'CAST(strftime(\'%H\', %args) AS INTEGER)' }
  ];
  for (const r of rewrites) {
    const re = new RegExp('\\b' + r.name + '\\s*\\(', 'gi');
    let m;
    while ((m = re.exec(s))) {
      const openIdx = m.index + m[0].length - 1;
      const p = extractParen(s, openIdx);
      if (p.end < 0) { re.lastIndex = m.index + 1; continue; }
      const argStr = p.argStr || '';
      const rep = r.fmt.replace('%args', argStr);
      s = s.slice(0, m.index) + rep + s.slice(p.end + 1);
      re.lastIndex = m.index + rep.length;
    }
  }
  const leftRe = /\bLEFT\s*\(/gi;
  let lm;
  while ((lm = leftRe.exec(s))) {
    const openIdx = lm.index + lm[0].length - 1;
    const p = extractParen(s, openIdx);
    if (p.end < 0) { leftRe.lastIndex = lm.index + 1; continue; }
    const args = splitTopLevel(p.argStr || '');
    const rep = 'substr(' + (args[0] || '').trim() + ', 1, ' + (args[1] === undefined ? '1' : args[1].trim()) + ')';
    s = s.slice(0, lm.index) + rep + s.slice(p.end + 1);
    leftRe.lastIndex = lm.index + rep.length;
  }
  return s;
}

function lineMatch(sql, re) {
  const m = re.exec(sql);
  return m ? m[1] : null;
}

function extractInsertTarget(head) {
  const m = /\bINSERT\s+(?:OR\s+IGNORE\s+|IGNORE\s+)?INTO\s+([A-Za-z0-9_]+)/i.exec(head);
  return m ? m[1] : null;
}

function getConflictColumns(tableName) {
  const key = String(tableName || '').toLowerCase();
  const meta = tableMeta.get(key);
  if (!meta) return [];
  for (const u of meta.tailUnique) {
    if (u.cols && u.cols.length) return u.cols;
  }
  const primaries = meta.columns.filter(c => c.primary).map(c => c.name);
  if (primaries.length) return primaries;
  const uniqCols = meta.columns.filter(c => c.unique).map(c => c.name);
  if (uniqCols.length) return uniqCols;
  return [];
}

function rewriteOnDuplicate(s) {
  const m = /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.exec(s);
  if (!m) return s;
  const head = s.slice(0, m.index).trim();
  let tail = s.slice(m.index).replace(/^[\s\S]*?\bUPDATE\s*/i, '').trim();
  const assigns = splitTopLevel(tail).map(a => a.trim()).filter(Boolean);
  const newAssigns = assigns.map(a => a.replace(/\bVALUES\s*\(\s*([A-Za-z0-9_]+)\s*\)/gi, 'excluded.$1'));
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(head)) return head;
  const tname = extractInsertTarget(head);
  const conflictCols = getConflictColumns(tname);
  const onPart = conflictCols.length
    ? 'ON CONFLICT (' + conflictCols.map(c => qid(c)).join(', ') + ') DO UPDATE SET '
    : 'ON CONFLICT DO UPDATE SET ';
  return head + ' ' + onPart + newAssigns.join(', ');
}

function rewriteJsonUnquoteExtract(s) {
  const re = /\bJSON_UNQUOTE\s*\(\s*JSON_EXTRACT\s*\(/gi;
  let m;
  while ((m = re.exec(s))) {
    const innerOpen = m.index + m[0].length - 1;
    const p = extractParen(s, innerOpen);
    if (p.end < 0) { re.lastIndex = m.index + 1; continue; }
    let outerEnd = p.end + 1;
    while (outerEnd < s.length && /\s/.test(s[outerEnd])) outerEnd++;
    const rep = 'json_extract(' + (p.argStr || '') + ')';
    s = s.slice(0, m.index) + rep + s.slice(outerEnd + 1);
    re.lastIndex = m.index + rep.length;
  }
  return s;
}

function transformSQL(sqlStr, params) {
  let s = String(sqlStr);
  s = s.replace(/`/g, '');
  s = s.replace(/\bIF\s*\(/gi, 'iif(');
  s = s.replace(/\bDATE_SUB\s*\(\s*NOW\s*\(\s*\)\s*,\s*INTERVAL\s+(\?|-?\d+(?:\.\d+)?)\s+(\w+)\s*\)/gi, (mm, num, unit) => "datetime('now','localtime'," + intervalModifier('-', unit, num) + ")");
  s = s.replace(/\bDATE_ADD\s*\(\s*NOW\s*\(\s*\)\s*,\s*INTERVAL\s+(\?|-?\d+(?:\.\d+)?)\s+(\w+)\s*\)/gi, (mm, num, unit) => "datetime('now','localtime'," + intervalModifier('+', unit, num) + ")");
  s = s.replace(/\bNOW\s*\(\s*\)\s*-\s*INTERVAL\s+(\?|-?\d+(?:\.\d+)?)\s+(\w+)/gi, (mm, num, unit) => "datetime('now','localtime'," + intervalModifier('-', unit, num) + ")");
  s = s.replace(/\bNOW\s*\(\s*\)\s*\+\s*INTERVAL\s+(\?|-?\d+(?:\.\d+)?)\s+(\w+)/gi, (mm, num, unit) => "datetime('now','localtime'," + intervalModifier('+', unit, num) + ")");
  s = rewriteFunctionCalls(s);
  s = s.replace(/\bCURDATE\s*\(\s*\)/gi, "date('now','localtime')");
  s = s.replace(/\bNOW\s*\(\s*\)/gi, "datetime('now','localtime')");
  s = s.replace(/\bVERSION\s*\(\s*\)/gi, "'8.0.0'");
  s = s.replace(/\bAS\s+UNSIGNED\b/gi, 'AS INTEGER');
  s = rewriteJsonUnquoteExtract(s);
  s = s.replace(/\bJSON_EXTRACT\s*\(/gi, 'json_extract(');
  s = s.replace(/\bJSON_CONTAINS\s*\(/gi, 'json_contains(');
  s = s.replace(/\bJSON_UNQUOTE\s*\(/gi, 'json_unquote(');
  s = s.replace(/\bFIND_IN_SET\s*\(/gi, 'find_in_set(');
  s = s.replace(/\bGREATEST\s*\(/gi, 'greatest(');
  s = s.replace(/\bUNIX_TIMESTAMP\s*\(/gi, 'unix_timestamp(');
  s = s.replace(/\/\*[^]*?\*\//g, ' ');
  s = s.replace(/\s+FOR\s+UPDATE\b/gi, ' ');
  s = s.replace(/\bINSERT\s+IGNORE\s+INTO\b/gi, 'INSERT OR IGNORE INTO');
  s = rewriteOnDuplicate(s);
  s = s.replace(/\bLIMIT\s+\?\s+OFFSET\s+\?/gi, () => {
    const offset = numOr(params.pop());
    const limit = numOr(params.pop());
    return 'LIMIT ' + limit + ' OFFSET ' + offset;
  });
  s = s.replace(/\bLIMIT\s+\?/gi, () => 'LIMIT ' + numOr(params.pop()));
  const r = scanSQL(s, params);
  return r;
}

function scanSQL(sqlStr, params) {
  const out = [];
  const flat = [];
  let pi = 0;
  let tail = '';
  const pushTail = (t) => { tail = (tail + t).slice(-24); };
  const peekParam = () => params[pi];
  const takeParam = () => params[pi++];
  let inS = null;
  for (let i = 0; i < sqlStr.length; i++) {
    const c = sqlStr[i];
    if (inS) {
      out.push(c); pushTail(c);
      if (c === inS) {
        if (sqlStr[i + 1] === inS) { out.push(inS); pushTail(inS); i++; continue; }
        inS = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { inS = c; out.push(c); pushTail(c); continue; }
    if (c === '?') {
      if (sqlStr[i + 1] === '?') {
        const idParam = takeParam();
        out.push((idParam === undefined || idParam === null ? '' : String(idParam)).replace(/`/g, ''));
        i++;
        continue;
      }
      const before = tail.replace(/\s+$/, '');
      if (/IN\s*\($/i.test(before)) {
        let j = i + 1;
        while (j < sqlStr.length && /\s/.test(sqlStr[j])) j++;
        if (sqlStr[j] === ')') {
          const v = peekParam();
          if (Array.isArray(v)) {
            takeParam();
            if (v.length === 0) {
              out.push('NULL)'); pushTail('NULL)');
            } else {
              const phs = v.map(() => '?').join(',');
              out.push(phs + ')'); pushTail(phs + ')');
              for (const item of v) flat.push(sanitizeParam(item));
            }
            i = j;
            continue;
          }
        }
        out.push('?'); pushTail('?');
        flat.push(sanitizeParam(takeParam()));
        continue;
      }
      if (/VALUES$/i.test(before)) {
        const v = peekParam();
        if (Array.isArray(v) && v.length && Array.isArray(v[0])) {
          takeParam();
          const groups = v.map(row => '(' + row.map(() => '?').join(',') + ')').join(',');
          out.push(groups); pushTail(groups);
          for (const row of v) for (const item of row) flat.push(sanitizeParam(item));
          continue;
        }
        if (Array.isArray(v)) {
          takeParam();
          const phs = v.map(() => '?').join(',');
          out.push('(' + phs + ')'); pushTail('(' + phs + ')');
          for (const item of v) flat.push(sanitizeParam(item));
          continue;
        }
      }
      if (/SET$/i.test(before)) {
        const v = peekParam();
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
          takeParam();
          const keys = Object.keys(v);
          const kv = keys.map(k => qid(k) + '=?').join(', ');
          out.push(kv); pushTail(kv);
          for (const k of keys) flat.push(sanitizeParam(v[k]));
          continue;
        }
      }
      out.push('?'); pushTail('?');
      flat.push(sanitizeParam(takeParam()));
      continue;
    }
    out.push(c); pushTail(c);
  }
  return { sql: out.join(''), params: flat };
}

function isSelectLike(sqlStr) {
  const up = String(sqlStr).trim().toUpperCase();
  return /^(SELECT|WITH|PRAGMA|VALUES)/.test(up) || /\bRETURNING\b/i.test(sqlStr);
}

function parseJSONResults(sqlStr, rows) {
  if (!rows || !rows.length) return rows;
  const jCols = new Set();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z0-9_]+)/ig;
  let m;
  const seen = new Set();
  while ((m = re.exec(sqlStr))) {
    const t = m[1].toLowerCase();
    if (seen.has(t)) continue;
    seen.add(t);
    const set = jsonColumns.get(t);
    if (set) for (const c of set) jCols.add(c.toLowerCase());
  }
  if (!jCols.size) return rows;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const k of Object.keys(row)) {
      if (jCols.has(k.toLowerCase()) && typeof row[k] === 'string' && row[k].length > 0) {
        const ch = row[k][0];
        if (ch === '{' || ch === '[' || ch === '"') {
          try {
            row[k] = JSON.parse(row[k]);
          } catch (_) { /* 保持原字符串 */ }
        }
      }
    }
  }
  return rows;
}

function sqliteRawQuery(db, sql, params) {
  const stmt = db.prepare(sql);
  const up = String(sql).trim().toUpperCase();
  if (/^(SELECT|PRAGMA|WITH|VALUES)/.test(up)) return stmt.all(...(params || []));
  return stmt.run(...(params || []));
}

function mapSQLError(e) {
  if (e && (e.errno !== undefined || (e && e.code && e.code !== 'ERR_SQLITE_ERROR'))) return e;
  const msg = e && e.message ? String(e.message) : String(e);
  if (/no such column/i.test(msg)) {
    const mm = /no such column:\s*([^\s]+)/i.exec(msg);
    return sqlError(1054, 'ER_BAD_FIELD_ERROR', "Unknown column '" + (mm ? mm[1] : '') + "' in 'field list'");
  }
  if (/UNIQUE constraint failed/i.test(msg)) {
    return sqlError(1062, 'ER_DUP_ENTRY', 'Duplicate entry for key');
  }
  if (/no such table/i.test(msg)) {
    const mm = /no such table:\s*([^\s]+)/i.exec(msg);
    return sqlError(1146, 'ER_NO_SUCH_TABLE', "Table '" + (mm ? mm[1] : '') + "' doesn't exist");
  }
  if (e && e.errcode !== undefined && e.code === 'ERR_SQLITE_ERROR') {
    const wrapped = new Error(msg);
    wrapped.errno = e.errcode;
    return wrapped;
  }
  return e;
}

function alterAddColumn(tableName, colDef) {
  const db = getSQLiteDb();
  const nm = /^`?([A-Za-z0-9_]+)`?/.exec(colDef.trim());
  const colName = nm ? stripQ(nm[1]) : stripQ(colDef.trim().split(/\s+/)[0]);
  const exists = sqliteRawQuery(db, 'PRAGMA table_info(' + qid(tableName) + ')').some(r => r.name === colName);
  if (exists) throw sqlError(1060, 'ER_DUP_FIELDNAME', "Duplicate column name '" + colName + "'");
  const colRest = colDef.trim().replace(/^`?[A-Za-z0-9_]+`?\s*/, '').trim();
  const col = parseColumnDef(colName + ' ' + colRest);
  if (!col.name) throw new Error('无法解析 ADD COLUMN: ' + colDef);
  let def = qid(colName) + ' ' + col.sqliteType;
  const hasDefault = col.defaultInSql !== null && col.defaultInSql !== undefined;
  if (col.notNull && hasDefault) def += ' NOT NULL';
  if (hasDefault) def += ' DEFAULT ' + col.defaultInSql;
  db.exec('ALTER TABLE ' + qid(tableName) + ' ADD COLUMN ' + def);
  const key = String(tableName).toLowerCase();
  let meta = tableMeta.get(key);
  if (meta && meta.colMap) {
    if (!meta.colMap.has(colName)) {
      meta.columns.push(col);
      meta.colMap.set(colName, col);
    }
  }
  if (!jsonColumns.has(key)) jsonColumns.set(key, new Set());
  if (col.isJson) jsonColumns.get(key).add(colName);
  if (col.unique) {
    const idxName = 'uq_' + tableName + '_' + colName;
    const found = sqliteRawQuery(db, 'SELECT 1 AS x FROM sqlite_master WHERE type=\'index\' AND name=?', [idxName]).length > 0;
    if (!found) db.exec('CREATE UNIQUE INDEX ' + qid(idxName) + ' ON ' + qid(tableName) + ' (' + qid(colName) + ')');
  }
}

function alterAddIndex(tableName, idxNameRaw, colsRaw, isUnique) {
  const db = getSQLiteDb();
  const idxName = stripQ(idxNameRaw);
  const cols = splitIdentList(colsRaw);
  const found = sqliteRawQuery(db, 'SELECT 1 AS x FROM sqlite_master WHERE type=\'index\' AND name=?', [idxName]).length > 0;
  if (found) throw sqlError(1061, 'ER_DUP_KEYNAME', "Duplicate key name '" + idxName + "'");
  db.exec('CREATE ' + (isUnique ? 'UNIQUE ' : '') + 'INDEX ' + qid(idxName) + ' ON ' + qid(tableName) + ' (' + cols.map(c => qid(c)).join(', ') + ')');
}

function alterChangeColumn(tableName, oldC, newC) {
  const db = getSQLiteDb();
  const oldName = stripQ(oldC);
  const newName = stripQ(newC);
  const fields = sqliteRawQuery(db, 'PRAGMA table_info(' + qid(tableName) + ')');
  const hasOld = fields.some(r => r.name === oldName);
  if (!hasOld) {
    if (fields.some(r => r.name === newName)) return;
    throw sqlError(1054, 'ER_BAD_FIELD_ERROR', "Unknown column '" + oldName + "' in 'field list'");
  }
  db.exec('ALTER TABLE ' + qid(tableName) + ' RENAME COLUMN ' + qid(oldName) + ' TO ' + qid(newName));
  const meta = tableMeta.get(String(tableName).toLowerCase());
  if (meta && meta.colMap && meta.colMap.has(oldName)) {
    const col = meta.colMap.get(oldName);
    col.name = newName;
    meta.colMap.delete(oldName);
    meta.colMap.set(newName, col);
  }
}

function handleAlter(sqlStr) {
  const db = getSQLiteDb();
  const m = /^ALTER\s+TABLE\s+`?(\w+)`?/i.exec(sqlStr);
  if (!m) return;
  const tableName = m[1];
  const rest = sqlStr.slice(m[0].length).replace(/`/g, '');
  const clauses = splitTopLevel(rest);
  for (const raw of clauses) {
    const clause = raw.trim();
    if (!clause) continue;
    if (/^ADD\s+COLUMN\b/i.test(clause)) {
      alterAddColumn(tableName, clause.replace(/^ADD\s+COLUMN\s*/i, '').replace(/`/g, ''));
      continue;
    }
    let im = /^ADD\s+UNIQUE\s+(?:INDEX|KEY)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/i.exec(clause);
    if (im) { alterAddIndex(tableName, im[1], im[2], true); continue; }
    im = /^ADD\s+(?:INDEX|KEY)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/i.exec(clause);
    if (im) { alterAddIndex(tableName, im[1], im[2], false); continue; }
    if (/^ADD\s+PRIMARY\s+KEY/i.test(clause)) continue;
    const cm = /^CHANGE\s+COLUMN\s+`?(\w+)`?\s+`?(\w+)`?/i.exec(clause);
    if (cm) { alterChangeColumn(tableName, cm[1], cm[2]); continue; }
    if (/^MODIFY\s+(?:COLUMN\s+)?/i.test(clause)) continue;
    const dm = /^DROP\s+INDEX\s+`?(\w+)`?/i.exec(clause);
    if (dm) {
      db.exec('DROP INDEX IF EXISTS ' + qid(dm[1]));
      continue;
    }
    const dcm = /^DROP\s+COLUMN\s+`?(\w+)`?/i.exec(clause);
    if (dcm) {
      db.exec('ALTER TABLE ' + qid(tableName) + ' DROP COLUMN ' + qid(dcm[1]));
      continue;
    }
  }
}

function execDDL(sqlStr) {
  const db = getSQLiteDb();
  const up = String(sqlStr).toUpperCase();
  if (/^CREATE\s+TABLE/i.test(up)) {
    const tname = lineMatch(sqlStr, /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
    if (tname) {
      const meta = parseCreateTable(tname, sqlStr);
      db.exec(generateSQLiteDDL(tname, meta));
      recordTableMeta(tname, meta);
    }
    return [];
  }
  if (/^ALTER\s+TABLE/i.test(up)) {
    handleAlter(sqlStr);
    return [];
  }
  if (/^DROP\s+TABLE/i.test(up)) {
    const tname = lineMatch(sqlStr, /\bTABLE\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/i);
    if (tname) {
      db.exec('DROP TABLE IF EXISTS ' + qid(tname));
      tableMeta.delete(String(tname).toLowerCase());
      jsonColumns.delete(String(tname).toLowerCase());
    }
    return [];
  }
  db.exec(sqlStr);
  return [];
}

function execQuery(sqlStr, paramsIn) {
  const db = getSQLiteDb();
  let sql = String(sqlStr).trim().replace(/;+\s*$/, '');
  if (!sql) return [[], undefined];
  let params = paramsIn === undefined || paramsIn === null ? [] : (Array.isArray(paramsIn) ? paramsIn.slice() : [paramsIn]);
  const head = sql.toUpperCase();
  try {
    if (/^SHOW\b/.test(head)) return [handledShow(sql, params), undefined];
    if (/^DESCRIBE\b/.test(head) || /^DESC\s+[`"\w]/.test(sql)) return [handledDescribe(sql), undefined];
    if (/^SELECT\b/i.test(sql) && /FROM\s+information_schema\./i.test(sql)) return [handledInfoSchema(sql, params), undefined];
    if (/^(OPTIMIZE|ANALYZE)\s+TABLE/i.test(head)) return [[], undefined];
    if (/^CHECK\s+TABLE/i.test(head)) {
      const t = /^CHECK\s+TABLE\s+`?(\w+)`?/i.exec(sql);
      return [[{ Table: t ? t[1] : '', Op: 'check', Msg_type: 'status', Msg_text: 'OK' }], undefined];
    }
    if (/^REPAIR\s+TABLE/i.test(head)) {
      const t = /^REPAIR\s+TABLE\s+`?(\w+)`?/i.exec(sql);
      return [[{ Table: t ? t[1] : '', Op: 'repair', Msg_type: 'status', Msg_text: 'OK' }], undefined];
    }
    if (/^KILL\b/i.test(head)) return [[], undefined];
    if (/^SET\b/i.test(head)) return [[], undefined];
    if (/^USE\b/i.test(head)) return [[], undefined];
    if (/^(START\s+TRANSACTION|BEGIN\b|COMMIT\b|ROLLBACK\b|SAVEPOINT)/i.test(head)) {
      db.exec(sql);
      return [[], undefined];
    }
    if (/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)/i.test(head) || /^ALTER\s+TABLE/i.test(head) || /^DROP\s+(?:TABLE|INDEX)/i.test(head)) {
      return [execDDL(sql), undefined];
    }
    const transformed = transformSQL(sql, params);
    const stmt = db.prepare(transformed.sql);
    if (isSelectLike(transformed.sql)) {
      const rawRows = stmt.all(...transformed.params);
      const rows = rawRows.map(r => {
        const o = {};
        for (const k of Object.keys(r)) {
          const v = r[k];
          o[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return o;
      });
      return [parseJSONResults(sql, rows), undefined];
    }
    const info = stmt.run(...transformed.params);
    return [{
      insertId: Number(info.lastInsertRowid) || 0,
      affectedRows: info.changes,
      changedRows: info.changes,
      info: '',
      warningStatus: 0
    }, undefined];
  } catch (e) {
    throw mapSQLError(e);
  }
}

function createSQLiteConnection() {
  return {
    query: async (sql, params) => execQuery(sql, params),
    execute: async (sql, params) => execQuery(sql, params),
    beginTransaction: async () => { getSQLiteDb().exec('BEGIN'); },
    commit: async () => { getSQLiteDb().exec('COMMIT'); },
    rollback: async () => { getSQLiteDb().exec('ROLLBACK'); },
    release: () => {},
    end: async () => {},
    threadId: 1
  };
}

function queryStream(promise, opts) {
  return new Readable({
    objectMode: true,
    highWaterMark: opts && opts.highWaterMark ? opts.highWaterMark : 16,
    read() {
      if (this._state === undefined) {
        this._state = 'waiting';
        promise.then((res) => {
          this._state = 'ready';
          this._rows = res[0] || [];
          this._i = 0;
          this._read();
        }).catch((err) => this.destroy(err));
        return;
      }
      if (this._state === 'ready') {
        while (this._i < this._rows.length) {
          if (!this.push(this._rows[this._i++])) return;
        }
        this.push(null);
      }
    }
  });
}

function createCallbackConnection() {
  return {
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = undefined; }
      const p = Promise.resolve().then(() => execQuery(sql, params));
      if (typeof cb === 'function') {
        p.then((res) => cb(null, res[0])).catch((e) => cb(e));
        return undefined;
      }
      const queryObj = { stream: (opts) => queryStream(p, opts) };
      return queryObj;
    },
    execute(sql, params, cb) {
      return this.query(sql, params, cb);
    },
    beginTransaction(cb) {
      try { getSQLiteDb().exec('BEGIN'); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
    },
    commit(cb) {
      try { getSQLiteDb().exec('COMMIT'); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
    },
    rollback(cb) {
      try { getSQLiteDb().exec('ROLLBACK'); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
    },
    release() {},
    end(cb) { if (cb) cb(null); }
  };
}

function createCallbackPool() {
  return {
    getConnection(cb) {
      const conn = createCallbackConnection();
      if (typeof cb === 'function') cb(null, conn);
      return conn;
    }
  };
}

function createSQLitePool() {
  getSQLiteDb();
  return {
    connectionLimit: 50,
    queueLimit: 100,
    _allConnections: [],
    _idleConnections: [],
    _waitingCount: 0,
    query: async (sql, params) => {
      if (sql && typeof sql === 'object' && sql.sql) { params = sql.values; sql = sql.sql; }
      return execQuery(sql, params);
    },
    execute: async (sql, params) => {
      if (sql && typeof sql === 'object' && sql.sql) { params = sql.values; sql = sql.sql; }
      return execQuery(sql, params);
    },
    getConnection: async () => createSQLiteConnection(),
    end: async () => {},
    pool: createCallbackPool()
  };
}

function initSQLitePatch() {
  getSQLiteDb();
  console.log('📦 SQLite 模式已启用（' + sqliteFilePath + '）');
  Object.assign(mysql, {
    createConnection: async (opts) => {
      if (opts && opts.timezone === '+08:00' && opts.charset === 'utf8mb4') {
        return {
          query: async () => [[], undefined],
          execute: async () => [[], undefined],
          end: async () => {}
        };
      }
      const err = new Error('[SQLite模式] createConnection 的目标是真实 MySQL，当前 JINGTU_DB_ENGINE=sqlite，无法创建 MySQL 连接（请使用默认 MySQL 模式或移除 JINGTU_DB_ENGINE）。');
      err.code = 'ERSQLITE_MODE';
      throw err;
    },
    createPool: () => createSQLitePool()
  });
  return true;
}

// createPoolWithoutDB：sqlite 模式直接构建 SQLite 池；MySQL 模式用真实 mysql2
function createPoolWithoutDB() {
  if (SQLITE_MODE) {
    holder.pool = createSQLitePool();
    return;
  }
  holder.pool = mysql.createPool({
    ...DB_CONFIG,
    database: holder.dbName,
    waitForConnections: true,
    connectionLimit: 50,
    queueLimit: 100,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
}

function recreatePool() {
  // 先关闭旧池，释放所有连接句柄
  if (holder.pool && holder.pool.end) {
    holder.pool.end().catch(() => {});
  }
  if (SQLITE_MODE) {
    holder.pool = createSQLitePool();
    return;
  }
  holder.pool = mysql.createPool({
    ...DB_CONFIG,
    database: holder.dbName,
    waitForConnections: true,
    connectionLimit: 50,
    queueLimit: 100,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
}

// §恢复：运行时用新配置重建连接池（无需重启进程）。
// 用于「数据库恢复页」在 MySQL 密码/地址变更后就地重连。
// 注意：db_init.js 在启动时已按值捕获 DB_NAME，本函数仅更新连接池用的库名；
// 恢复场景通常只改 host/密码、库名不变，故不影响建表逻辑。
function applyDbConfig({ host, port, user, password, database } = {}) {
  if (SQLITE_MODE) {
    if (database) holder.dbName = database;
    recreatePool();
    return;
  }
  if (host) DB_CONFIG.host = host;
  if (port) DB_CONFIG.port = parseInt(port, 10) || DB_CONFIG.port;
  if (user) DB_CONFIG.user = user;
  if (password !== undefined) {
    if (password) DB_CONFIG.password = password;
    else delete DB_CONFIG.password;
  }
  if (database) holder.dbName = database;
  recreatePool();
}

function getPool() {
  return holder.pool;
}

if (SQLITE_MODE) {
  initSQLitePatch();
}
createPoolWithoutDB();

// ==================== 数据库心跳重连（MySQL 意外停止后自动恢复，仅 MySQL 模式） ====================
if (!SQLITE_MODE) {
  const DB_HEARTBEAT_INTERVAL = 15000; // 每 15 秒检查一次
  let _dbReconnecting = false;

  async function _dbHeartbeat() {
    // 尚未使用 DB 时跳过（login 阶段不需要）
    if (!holder.pool) return;
    try {
      await holder.pool.query('SELECT 1 AS ping');
    } catch (e) {
      console.warn('⚠️ 数据库心跳检测失败:', e.message);
      if (_dbReconnecting) return;
      _dbReconnecting = true;
      console.log('🔄 尝试重建数据库连接池...');
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          recreatePool();
          // 验证新池是否可用
          await holder.pool.query('SELECT 1 AS ping');
          console.log('✅ 数据库连接池重建成功（第' + attempt + '次）');
          _dbReconnecting = false;
          return;
        } catch (e2) {
          console.warn('⚠️ 数据库重建失败（第' + attempt + '次）:', e2.message);
          await new Promise(r => setTimeout(r, 3000)); // 重试间隔
        }
      }
      console.error('❌ 数据库连接池重建失败，将在 ' + (DB_HEARTBEAT_INTERVAL / 1000) + ' 秒后重试');
      _dbReconnecting = false;
    }
  }

  setInterval(_dbHeartbeat, DB_HEARTBEAT_INTERVAL).unref(); // unref：HTTP 服务本身持有事件循环，心跳不应阻塞进程退出（Jest/工具脚本 require 本模块时不挂起）
  console.log('⏰ 数据库心跳监测已启动（间隔 ' + (DB_HEARTBEAT_INTERVAL / 1000) + ' 秒）');
}

module.exports = { holder, DB_NAME, DB_CONFIG, getPool, recreatePool, applyDbConfig };