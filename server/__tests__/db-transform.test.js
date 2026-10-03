// P2-150: db.js transformSQL 方言翻译层黄金用例
// transformSQL/scanSQL/rewriteConcat/类型映射是 SQLite↔MySQL 兼容承重墙，
// 此前零测试。本文件以 SQLite 模式加载 db.js（:memory:，无文件副作用），
// 对纯函数做输入→输出断言。
process.env.JINGTU_DB_ENGINE = 'sqlite';
process.env.JINGTU_SQLITE_PATH = ':memory:';

const {
  transformSQL,
  scanSQL,
  rewriteConcat,
  rewriteJsonUnquoteExtract,
  sanitizeParam,
  splitTopLevel,
  parseColumnDef,
  sqliteTypeOf,
  intervalModifier,
  numOr,
  qid,
  stripQ,
  extractInsertTarget,
  getConflictCandidates,
  getPool,
  jsonContains,
  resolveJsonPath
} = require('../db');

describe('P2-150 transformSQL 方言层黄金用例', () => {
  test('NOW() 翻译为 datetime 且不触碰字符串字面量', () => {
    const r = transformSQL(
      'UPDATE users SET updated_at = NOW() WHERE id = ?',
      [1]
    );
    expect(r.sql).toBe(
      'UPDATE users SET updated_at = datetime(\'now\',\'localtime\') WHERE id = ?'
    );
    expect(r.params).toEqual([1]);
  });

  test('DATE_ADD(NOW(), INTERVAL 15 MINUTE) 翻译', () => {
    const r = transformSQL(
      'UPDATE users SET locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?',
      [7]
    );
    expect(r.sql).toBe(
      'UPDATE users SET locked_until = datetime(\'now\',\'localtime\',\'+\' || 15 || \' minutes\') WHERE id = ?'
    );
    expect(r.params).toEqual([7]);
  });

  test('IF(a,b,c) 翻译为 iif', () => {
    const r = transformSQL(
      "SELECT IF(role = 'admin', 1, 0) AS is_admin FROM users",
      []
    );
    expect(r.sql).toBe(
      "SELECT iif(role = 'admin', 1, 0) AS is_admin FROM users"
    );
  });

  test('字符串字面量中的函数名不被改写（P2-143）', () => {
    const input = "INSERT INTO posts (content) VALUES ('says NOW() and IF(a,1,0) and `backtick`')";
    const r = transformSQL(input, []);
    expect(r.sql).toBe(input);
    expect(r.params).toEqual([]);
  });

  test('LIMIT ? OFFSET ? 参数弹出并内联', () => {
    const r = transformSQL('SELECT * FROM posts LIMIT ? OFFSET ?', [20, 5]);
    expect(r.sql).toBe('SELECT * FROM posts LIMIT 20 OFFSET 5');
    expect(r.params).toEqual([]);
  });

  test('纯 LIMIT ? 内联', () => {
    const r = transformSQL('SELECT * FROM posts LIMIT ?', [10]);
    expect(r.sql).toBe('SELECT * FROM posts LIMIT 10');
    expect(r.params).toEqual([]);
  });

  test('INSERT IGNORE INTO 翻译且丢弃 ON DUPLICATE 尾巴', () => {
    const r = transformSQL(
      'INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, 3) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
      [7]
    );
    expect(r.sql).toBe(
      'INSERT OR IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, 3)'
    );
    expect(r.params).toEqual([7]);
  });

  test('ON DUPLICATE KEY UPDATE → ON CONFLICT DO UPDATE（VALUES→excluded）', () => {
    const r = transformSQL(
      'INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = VALUES(created_at)',
      [7, 9]
    );
    expect(r.sql).toBe(
      'INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON CONFLICT DO UPDATE SET created_at = excluded.created_at'
    );
    expect(r.params).toEqual([7, 9]);
  });

  test('CONCAT 与 LEFT 组合改写', () => {
    const r = transformSQL(
      "SELECT CONCAT(owner_name, ' - ', LEFT(name, 10)) AS label FROM posts",
      []
    );
    expect(r.sql).toBe(
      "SELECT (owner_name || ' - ' || substr(name, 1, 10)) AS label FROM posts"
    );
  });

  test('JSON_EXTRACT 小写化且保留路径字面量', () => {
    const r = transformSQL("SELECT JSON_EXTRACT(tags, '$[0]') FROM collections", []);
    expect(r.sql).toBe("SELECT json_extract(tags, '$[0]') FROM collections");
  });

  test('JSON_UNQUOTE(JSON_EXTRACT(...)) 折叠为 json_extract', () => {
    const r = transformSQL("SELECT JSON_UNQUOTE(JSON_EXTRACT(tags, '$[1]')) FROM collections", []);
    expect(r.sql).toBe("SELECT json_extract(tags, '$[1]') FROM collections");
  });

  test('FOR UPDATE 静默移除（仅保留占位空格）', () => {
    const r = transformSQL('SELECT * FROM events WHERE id = ? FOR UPDATE', [1]);
    expect(r.sql).toBe('SELECT * FROM events WHERE id = ? ');
    expect(r.params).toEqual([1]);
  });

  test('反引号标识符去引号', () => {
    const r = transformSQL('SELECT `display_name` FROM `users` WHERE `id` = ?', [3]);
    expect(r.sql).toBe('SELECT display_name FROM users WHERE id = ?');
    expect(r.params).toEqual([3]);
  });
});

describe('P2-150 scanSQL 参数化展开', () => {
  test('IN (?) 数组展开为占位符串', () => {
    const r = scanSQL('SELECT * FROM members WHERE group_id IN (?)', [[1, 2, 3]]);
    expect(r.sql).toBe('SELECT * FROM members WHERE group_id IN (?,?,?)');
    expect(r.params).toEqual([1, 2, 3]);
  });

  test('IN (?) 空数组退化为 NULL', () => {
    const r = scanSQL('SELECT * FROM members WHERE group_id IN (?)', [[]]);
    expect(r.sql).toBe('SELECT * FROM members WHERE group_id IN (NULL)');
    expect(r.params).toEqual([]);
  });

  test('VALUES ? 多行数组展开', () => {
    const r = scanSQL('INSERT INTO t (a, b) VALUES ?', [[[1, 2], [3, 4]]]);
    expect(r.sql).toBe('INSERT INTO t (a, b) VALUES (?,?),(?,?)');
    expect(r.params).toEqual([1, 2, 3, 4]);
  });

  test('sanitizeParam 规范化（bool/Date/undefined/bigint）', () => {
    expect(sanitizeParam(true)).toBe(1);
    expect(sanitizeParam(false)).toBe(0);
    expect(sanitizeParam(undefined)).toBeNull();
    expect(sanitizeParam(null)).toBeNull();
    expect(sanitizeParam(Number.NaN)).toBeNull();
    expect(sanitizeParam(10n)).toBe(10);
    const d = new Date(2026, 8, 1, 9, 5, 6);
    expect(sanitizeParam(d)).toBe('2026-09-01 09:05:06');
    expect(sanitizeParam('keep-me')).toBe('keep-me');
  });
});

describe('P2-150 类型映射与列定义解析', () => {
  test('sqliteTypeOf 各类型映射', () => {
    expect(sqliteTypeOf('INT')).toBe('INTEGER');
    expect(sqliteTypeOf('BIGINT')).toBe('INTEGER');
    expect(sqliteTypeOf('TINYINT(1)')).toBe('INTEGER');
    expect(sqliteTypeOf('DOUBLE')).toBe('NUMERIC');
    expect(sqliteTypeOf('JSON')).toBe('TEXT');
    expect(sqliteTypeOf('varchar(100)')).toBe('TEXT');
    expect(sqliteTypeOf('DATETIME')).toBe('TEXT');
  });

  test('parseColumnDef 解析主键/自增/JSON/默认值', () => {
    const pk = parseColumnDef('user_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY');
    expect(pk.name).toBe('user_id');
    expect(pk.mysqlType).toBe('BIGINT');
    expect(pk.sqliteType).toBe('INTEGER');
    expect(pk.notNull).toBe(true);
    expect(pk.autoInc).toBe(true);
    expect(pk.primary).toBe(true);

    const json = parseColumnDef('tags JSON NULL');
    expect(json.sqliteType).toBe('TEXT');
    expect(json.isJson).toBe(true);

    const def = parseColumnDef('created_at DATETIME DEFAULT CURRENT_TIMESTAMP');
    expect(def.defaultInSql).toBe('CURRENT_TIMESTAMP');
  });

  test('splitTopLevel 括号/引号感知', () => {
    expect(splitTopLevel("a, b, CONCAT(x, y), 'c,d'")).toEqual(['a', ' b', ' CONCAT(x, y)', " 'c,d'"]);
  });

  test('qid/stripQ/intervalModifier 纯函数', () => {
    expect(qid('a"b')).toBe('"a""b"');
    expect(stripQ('`col`')).toBe('col');
    expect(intervalModifier('+', 'DAY', 2)).toBe("'+' || 2 || ' days'");
    expect(intervalModifier('-', 'HOUR', 1)).toBe("'-' || 1 || ' hours'");
  });

  test('extractInsertTarget 识别插入目标', () => {
    expect(extractInsertTarget('INSERT INTO users (id) VALUES (1)')).toBe('users');
    expect(extractInsertTarget('INSERT OR IGNORE INTO members (id) VALUES (1)')).toBe('members');
    expect(extractInsertTarget('SELECT 1')).toBeNull();
  });

  test('getConflictCandidates 无元数据时返回空集（避免误选冲突列）', () => {
    expect(getConflictCandidates('unknown_table')).toEqual([]);
  });

  test('rewriteJsonUnquoteExtract 直接函数级折叠', () => {
    expect(rewriteJsonUnquoteExtract("SELECT JSON_UNQUOTE(JSON_EXTRACT(tags, '$.a')) FROM t"))
      .toBe("SELECT json_extract(tags, '$.a') FROM t");
  });

  test('rewriteConcat 直接函数级改写', () => {
    expect(rewriteConcat("SELECT CONCAT(a, b) FROM t"))
      .toBe('SELECT (a || b) FROM t');
  });
});

describe('P3-81/83 transformSQL 占位符边界加固', () => {
  test('LIMIT 之后仍有其他占位符时按位置消费（不再尾部 pop）', () => {
    const r = transformSQL(
      'SELECT * FROM posts WHERE user_id = ? LIMIT ? AND deleted = ?',
      [7, 10, 0]
    );
    expect(r.sql).toBe('SELECT * FROM posts WHERE user_id = ? LIMIT 10 AND deleted = ?');
    expect(r.params).toEqual([7, 0]);
  });

  test('LIMIT ? OFFSET ? 与其他占位符混排顺序正确', () => {
    const r = transformSQL(
      'SELECT * FROM posts WHERE user_id = ? AND type = ? LIMIT ? OFFSET ?',
      [7, 'activity', 20, 5]
    );
    expect(r.sql).toBe('SELECT * FROM posts WHERE user_id = ? AND type = ? LIMIT 20 OFFSET 5');
    expect(r.params).toEqual([7, 'activity']);
  });

  test('LIMIT 非法参数回落 0 且不吞后续占位符', () => {
    const r = transformSQL('SELECT * FROM posts LIMIT ? AND id = ?', ['abc', 9]);
    expect(r.sql).toBe('SELECT * FROM posts LIMIT 0 AND id = ?');
    expect(r.params).toEqual([9]);
  });

  test("字符串内 `\\'` 反斜杠转义不提前终止、内部 ? 不消费", () => {
    const r = transformSQL("SELECT 'a\\'?b' AS s, ? AS v", ['x']);
    expect(r.sql).toBe("SELECT 'a\\'?b' AS s, ? AS v");
    expect(r.params).toEqual(['x']);
  });

  test('字符串内 \\\\ 双反斜杠不提前终止（Windows 路径场景）', () => {
    const r = transformSQL("SELECT 'C:\\\\dir' AS p, ? AS v", [1]);
    expect(r.sql).toBe("SELECT 'C:\\\\dir' AS p, ? AS v");
    expect(r.params).toEqual([1]);
  });
});

describe('P3-82 SQLite SHOW INDEX WHERE / information_schema 无参', () => {
  const pool = getPool();

  test('SHOW INDEX WHERE Key_name 过滤生效（migrate-v5.6 场景）', async () => {
    await pool.query('DROP TABLE IF EXISTS jt_p382_t');
    await pool.query('CREATE TABLE jt_p382_t (id INT PRIMARY KEY, name VARCHAR(50))');
    await pool.query('CREATE INDEX idx_jt_p382_name ON jt_p382_t(name)');
    const [all] = await pool.query('SHOW INDEX FROM jt_p382_t');
    const [filtered] = await pool.query("SHOW INDEX FROM jt_p382_t WHERE Key_name = 'idx_jt_p382_name'");
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.Key_name === 'idx_jt_p382_name')).toBe(true);
  });

  test('SHOW INDEX WHERE 无匹配返回空（避免误判索引已存在）', async () => {
    const [filtered] = await pool.query("SHOW INDEX FROM jt_p382_t WHERE Key_name = 'idx_never_exists'");
    expect(filtered).toEqual([]);
  });

  test('information_schema.COLUMNS 无参查询按 sqlite_master 全量返回', async () => {
    await pool.query('DROP TABLE IF EXISTS jt_p382_c');
    await pool.query('CREATE TABLE jt_p382_c (id INT PRIMARY KEY, title VARCHAR(100))');
    const [rows] = await pool.query('SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS');
    expect(rows.some((r) => r.COLUMN_NAME === 'title')).toBe(true);
  });
});

describe('P3-84 json_contains MySQL 语义', () => {
  test('候选为数组时 target 数组须包含全部元素（顺序无关）', () => {
    expect(jsonContains(['a', 'b', 'c'], ['b', 'a'])).toBe(true);
    expect(jsonContains(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(jsonContains(['a'], ['a', 'b'])).toBe(false);
    expect(jsonContains({ x: 1 }, ['x'])).toBe(false);
  });

  test('目标为数组、候选为标量时任一元素命中即包含', () => {
    expect(jsonContains(['a', 'b'], 'b')).toBe(true);
    expect(jsonContains(['a', 'b'], 'z')).toBe(false);
  });

  test('对象递归按 key 匹配', () => {
    expect(jsonContains({ a: { b: 1 }, c: 2 }, { a: { b: 1 } })).toBe(true);
    expect(jsonContains({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });

  test('标量相等判定', () => {
    expect(jsonContains(1, 1)).toBe(true);
    expect(jsonContains(1, 2)).toBe(false);
  });

  test('resolveJsonPath 解析 $.a.b[0] 路径', () => {
    const t = { a: { b: [10, 20] } };
    expect(resolveJsonPath(t, '$.a.b[0]')).toBe(10);
    expect(resolveJsonPath(t, '$.a.b')).toEqual([10, 20]);
    expect(resolveJsonPath(t, '$.a.x')).toBeUndefined();
    expect(resolveJsonPath(t, 'a.b')).toBeUndefined();
  });
});
