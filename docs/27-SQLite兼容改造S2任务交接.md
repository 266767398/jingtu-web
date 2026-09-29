# 27-SQLite 兼容改造（S2 任务）交接文档

> 生成时间：2026-09-27
> 用途：任务中途交接文档。新开对话时，让 AI 读完本文档即可无缝继续 S2 任务的实施。

---

## 1. 任务总览与契约

**项目**：`d:\phpstudy_pro\WWW\jingtu-web` —— VRChat 群组管理应用「境途同游」（Node.js + Express + MySQL，Node v23.11.1，Windows 开发环境）。

**S2 任务目标**：重写 `server/db.js`，使系统既能用现有线上 MySQL 模式运行，也能用基于 `node:sqlite`（Node 内置，`DatabaseSync`）的嵌入式 SQLite 模式运行。

**硬性契约（必须遵守）**：

1. **就地 monkey-patch `mysql2/promise`**：在同一个导出对象上用 `Object.assign(exportsObj, { createConnection, createPool })` 替换这两个函数。这样 `db_init.js` 第 1 行的 `require('mysql2/promise')` 以及约 74 个路由/服务模块的既有 `mysql` 用法**都无需改动**即可在 SQLite 模式运行。
2. **MySQL 为默认行为**；只有当 `process.env.JINGTU_DB_ENGINE === 'sqlite'` 时才切换到 SQLite 模式。
3. **保留 `module.exports` 导出契约**：`{ holder, DB_NAME, DB_CONFIG, getPool, recreatePool, applyDbConfig }`，并保留 `.env` 密码回退文件读取逻辑。
4. **保留心跳/重连机制（仅 MySQL 模式）**：15s 间隔、3 次重试、3s 重试间隔、`setInterval(...).unref()`。
5. **只修改 `server/db.js` 一个文件**；不修改任何其他消费者模块。
6. 测试完成后清理临时探针文件。

**重要环境事实**：
- `node:sqlite` 的 `DatabaseSync` 是同步 API，Node 23.11.1 可用；首次加载会打印 `ExperimentalWarning`（无害，不要当作错误）。
- `db.function(name, {}, fn)` 会报错——必须传 `{ deterministic: true }`；`FIND_IN_SET` 需 `varargs: true`。
- patch 必须在 `db.js` 模块**顶层最先执行**（`db.js` 第 107 行 `createPoolWithoutDB()` 在模块加载时就会调用 `mysql.createPool`）；同一导出对象在所有 require 方间共享。

---

## 2. 当前进度状态

| 任务 | 状态 |
|---|---|
| 重读 `server/db.js`（144 行）与 `mysql2/promise.js`（208 行），确认导出契约 | ✅ 完成 |
| 精读 `db_init.js` 全部 DDL/ALTER 与 `database.js` 的 SHOW 语句 | ✅ 完成 |
| 全量枚举真实 SQL 模式（6 大重写窗口，见第 4 节） | ✅ 完成 |
| 探针验证 SQLite 关键语法可行性 | ✅ 完成 |
| **编写新的 `server/db.js`（SQLite 引擎 + 就地 patch）** | ✅ **完成** |
| 冒烟测试 SQLite 模式（db_init 加载 + 基本查询） | ✅ 完成（35/35 用例通过） |
| 验证 MySQL 模式未破坏（默认仍连运行时 MySQL） | ✅ 完成 |
| 清理探针文件 | ✅ 完成 |
| 实现后追加审查与修复（FIELD/sessions/SET/行对象，见 §11） | ✅ 完成 |

**状态**：S2 任务全部交付。`server/db.js` 已重写（约 1300 行），仅此一个文件被修改；所有消费者模块零改动。
- `node db_init.js`（`JINGTU_DB_ENGINE=sqlite`）全量通过：82 张表（81 张业务表 + 预建 sessions 表）+ 全部迁移/种子/一次性迁移，二次运行幂等。
- 20 组冒烟用例 35/35 通过；真实消费者 SQL 形态（FIELD 聚合子查询、JSON_EXTRACT/CONTAINS、FIND_IN_SET、REGEXP+CAST、UNIX_TIMESTAMP、DATE_ADD/SUB、NOW()-INTERVAL、ON DUPLICATE 等）10/10 通过。
- MySQL 模式（不设环境变量）回归正常：心跳、导出契约、池行为与改动前一致。
- `npm test` 469 通过；5 个失败为**改动前已存在**的 i18n 键缺失 / 路由清单快照漂移（git 工作树中 `public/js/languages/*`、路由文件在本次会话前已有未提交改动），与 db.js 无关。

---

## 3. 基线文件与消费者契约

### 3.1 `server/db.js`（重写目标，原始 144 行）

- `readEnvValueFromFile(key)`（L7-26）：从 `.env` 文件读键值。
- `normalizeSecret(v)`（L28-35）。
- `.env` 密码回退（L37-42）。
- `DB_CONFIG = { host, user, port: 3306, timezone: '+08:00', charset: 'utf8mb4' }`（L43-52）。
- `DB_NAME = process.env.MYSQL_DATABASE || 'jingtu_group'`（L54）。
- `const holder = { pool: null, dbName: DB_NAME }`（L57）。
- `createPoolWithoutDB()`（L59-69）：`holder.pool = mysql.createPool({ ...DB_CONFIG, database: holder.dbName, waitForConnections: true, connectionLimit: 50, queueLimit: 100, enableKeepAlive: true, keepAliveInitialDelay: 10000 })`。
- `recreatePool()`（L71-85）：旧 pool 存在时 `holder.pool.end().catch(() => {})` 后重建。
- `applyDbConfig({ host, port, user, password, database })`（L91-101）：原地改 `DB_CONFIG`、改 `holder.dbName`、调用 `recreatePool()`。
- `getPool()`（L103-105）。
- 模块顶层 L107：`createPoolWithoutDB()`（patch 触发点）。
- 心跳（L109-141）：15s 间隔、`SELECT 1 AS ping`、3 次重试、3s 重试间隔、`_dbReconnecting` 标志。
- L144：`module.exports = { holder, DB_NAME, DB_CONFIG, getPool, recreatePool, applyDbConfig }`。

### 3.2 `server/node_modules/mysql2/promise.js`（208 行）

- 只有具名导出（**无 default**）。导出含 `createConnection`、`createPool`、`createPoolCluster`、`escape`、`escapeId`、`format`、`raw`、`Connection`、`PoolConnection`、`PromisePool`、`PromiseConnection`、`PromisePoolConnection`、Types/Charsets getter。
- 消费者只使用 `createConnection` / `createPool` 两个函数，`Object.assign` 覆盖即可。

### 3.3 关键消费者

- `db_init.js` L1 `require('mysql2/promise')`；L66 `const tables = [` 建表数组；L1248-1265 循环执行、收集 `createFailures`。
- `server.js`（L310-341）：session store 分支逻辑为 —— `NODE_ENV === 'test'` 直接走 MemoryStore；否则 try `new MySQLStore({...createDatabaseTable:true})`，失败才 catch 回退 MemoryStore。**SQLite 模式下若未设 `NODE_ENV=test`，启动时仍会先尝试构造 MySQLStore 并连 MySQL（可能拖慢启动）**；因 SQLite 模式无 MySQL，最终会回退 MemoryStore，故**无需修改 server.js**，但冒烟测试建议设 `NODE_ENV=test` 或接受启动时的连接等待。
- `routes/export.js` `streamTableExport` 用 `getPool().pool`（基础 callback Pool）+ `.stream({highWaterMark})` —— 需兼容性处理（见第 6 节决策 3）。
- `routes/migration.js` L145/238/247 用 `mysql.createConnection`（会命中 patch；迁移目标是真实 MySQL，见第 6 节决策 4）。

---

## 4. SQL 重写规则目录（核心执行资产）

以下为经全量 grep 枚举的真实使用形态，实现时按此窗口逐一处理。

### 4.1 DDL 重写（`db_init.js` 的 `tables` 数组 + ALTER）

**已确认 DDL 模式**（样本：password_reset_tokens L68-79、sys_admin L82-87、sys_oper_log L90-97、announcement L100-110、announcement_attachments L113-122、announcement_history L125-135、event L140-170、event_sign L173-183、album_cate L186-191、album_photo L194-212、album_like L215-219、以及 L1830-1912、L1990-2003 等区段）：

- `CREATE TABLE IF NOT EXISTS ... ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` —— 重写：移除 engine/charset/COLLATE/COMMENT。
- `id INT AUTO_INCREMENT PRIMARY KEY`、`BIGINT AUTO_INCREMENT PRIMARY KEY` → `INTEGER PRIMARY KEY AUTOINCREMENT`。
- `TINYINT(1)`/`TINYINT` → `INTEGER`。
- `DATETIME`/`DATE`/`TIMESTAMP` → TEXT；`DEFAULT CURRENT_TIMESTAMP` 保留（SQLite 原生支持）；**去掉 `ON UPDATE CURRENT_TIMESTAMP`**。
- `JSON` → TEXT。
- `ENUM('...')` → TEXT。
- 队尾 `INDEX idx_...(...)` → 提取为 `CREATE INDEX IF NOT EXISTS ...`。
- 队尾 `UNIQUE KEY uk_...( ... )` → 提取为 `CREATE UNIQUE INDEX IF NOT EXISTS ...`。
- 列级 `UNIQUE`、`NOT NULL UNIQUE` → SQLite 列约束。
- 建表后用 `PRAGMA table_info` 校验，将 SQLite 实际列类型映射回 MySQL 风格（`INTEGER`→`int`、`TEXT`→`text`），供 `SHOW COLUMNS` 等使用。

**ALTER 重写（`db_init.js` 的 ALTER 批次）**：
- `ADD COLUMN` 必须**抛 MySQL 兼容错误**：`errno 1060` / `code 'ER_DUP_FIELDNAME'` / 消息含 "Duplicate column name"（db_init.js 的 try/catch 用 `e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME'` 以及 `/Duplicate key name/i.test(e.message)` 识别，需确保消息含可识别关键词）。
- `ADD INDEX` → `CREATE INDEX IF NOT EXISTS`（重复时 errno 1061 / `ER_DUP_KEYNAME`）。
- `ADD UNIQUE INDEX` → `CREATE UNIQUE INDEX IF NOT EXISTS`（**`ADD UNIQUE KEY` 为同义语法**，如 L1708/L1779/L1838 亦按此处理；重复时 errno 1061 / `ER_DUP_KEYNAME`）。
- `MODIFY COLUMN` → no-op。
- 不支持 `ADD COLUMN ... UNIQUE`，改用 `CREATE UNIQUE INDEX`。
- **复合 ALTER（关键！）**：一个语句内可同时含多个子句，如 db_init.js L1704-1710：`ALTER TABLE member_note CHANGE COLUMN owner_vrcid owner_id INT NOT NULL, CHANGE COLUMN target_vrcid target_id INT NOT NULL, DROP INDEX uk_owner_target, ADD UNIQUE KEY uk_owner_target(owner_id, target_id), ADD INDEX idx_owner(owner_id), ADD INDEX idx_target(target_id)`。重写器需按子句拆分执行：
  - `CHANGE COLUMN old new TYPE...`（列改名+改类型）→ SQLite 不支持，需 `ALTER TABLE ... RENAME COLUMN old TO new`（仅当列类型兼容）或重建表；本场景 dbs5.6+ 已迁移，SQLite 首次建表直接用 `owner_id/target_id INT` 全新定义，此复合 ALTER 走到时列已存在 → 直接 no-op 即可，但重写器仍需能识别该语法，避免报错。
  - `DROP INDEX idx` → `DROP INDEX IF EXISTS idx`（注意 SQLite 的 `DROP INDEX` 语句不带表名）。
  - 1680 行同类形态：`ALTER TABLE messages ADD COLUMN edited_at ...` 单个 try/catch 包裹，同样走 1060 兼容错误路径。
  - 复合语句拆分后的子操作应**顺序执行**，任一失败按各自 errno 收敛（1060/1061/1054），不中断批次。

### 4.2 INSERT / UPSERT

- `INSERT IGNORE` → `INSERT OR IGNORE`（含 `VALUES ?` 二维数组形式，如 `chat.js:719`）。
- `ON DUPLICATE KEY UPDATE` → `ON CONFLICT(...) DO UPDATE SET ...`：`VALUES(col)` → `excluded.col`；若无可定位的唯一列，退化为**无目标** `ON CONFLICT DO UPDATE SET ...`（探针已验证可用，覆盖 `chat_offline_summary`、system_config 等无唯一表）。
- `VALUES ?` 展开为显式 `VALUES (?,?...),(?,?...)` 并扁平化参数，按约 100 行分块。
- 出现位置：admin.js、schedule.js、ws_service.js:731、world_cache.js:97、friends.js:274、jtt.js:441、profile.js:413、groups_members.js:108、permission_groups.js、groups_member_detail.js:189、groups_vrc_status.js、groups_members_sync.js、user-data-helper.js、users_tags_notes.js、migration.js:174、posts.js:400/517、auth_local_service.js、events.js、users.js 等。

### 4.3 时间 / 间隔函数

- `DATE_SUB(NOW(), INTERVAL ? DAY)` → SQL 字符串拼接：`datetime('now','localtime','-' || ? || ' days')`（**SQLite 参数不能直接做 datetime modifier**，`datetime('now','-? days')` 无效）。位置：tasks.js:146、analytics.js:85/127/135/143。
- 字面量 `DATE_SUB(NOW(), INTERVAL 7 DAY)` → `datetime('now','localtime','-7 days')`。位置：analytics.js:106、ws_service.js:741、collections.js:925。
- `DATE_ADD(NOW(), INTERVAL 15 MINUTE)`（auth_local_service.js:356）、`INTERVAL ? DAY`（jtt.js:626）、`INTERVAL 7 DAY`（share.js:65）同理改写为 `datetime('now','localtime','+N minutes/days')`。
- **算术语法 `NOW() - INTERVAL 15 MINUTE`**（schedule.js:275/444/591、world_cache.js:82 `${CACHE_TTL_HOURS}`、groups_members_sync.js:301、`_archive/memory.js:61/69/76`）→ 同上改为 modifier 拼接。
- `CURDATE()`（analytics.js:23、groups_members.js:134/135、`_archive/memory.js`）、`YEAR(CURDATE())` → `date('now','localtime')` + `strftime('%Y',...)`。
- `UNIX_TIMESTAMP()`：仅 `tasks.js:38`（`DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP()`）→ UDF 或重写为 `strftime('%s','now')`。

### 4.4 其他函数

- `REGEXP`（admin.js:98 `l.admin_vrcid REGEXP '^[0-9]+$'`）→ UDF `db.function('regexp', {deterministic:true}, (a,b)=>new RegExp(b).test(a))`；注意 SQLite 谓词语法为 `x REGEXP y` 编译成 `regexp(y, x)`，UDF 签名需按 `(pattern, value)`。
- `FIND_IN_SET(?, events)`（webhook.js:22）→ UDF `{ deterministic: true, varargs: true }`。
- `GREATEST(...)`（checkin.js:109、posts.js:648/818）→ UDF。
- `HOUR/MONTH/DAY/YEAR` → `strftime('%H'/'%m'/'%d'/'%Y', col)`。
- `LEFT(x, n)` → `substr(x, 1, n)`。
- `IF()`、`IFNULL`、`CONCAT`、`json_each`、`concat`（SQLite 3.44+ 内置）→ **原生可用，无需 UDF**（探针已验）。
- `JSON_CONTAINS`（collections.js:215）、`JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId'))`（auth_local_service.js:471、auth_reset_service.js:139、collections.js:312 带 CONCAT 路径）→ 用 `json_extract` / `json_array_contains` 重写，或注册兼容 UDF。

### 4.5 查询窗口

- 从 SELECT 移除 `FOR UPDATE`（events.js:398/473/519/576/579、posts.js:474/582、profile.js:211）。
- `SET FOREIGN_KEY_CHECKS = 0/1` → no-op（migration.js:274/310/332）。
- `IN (?)` 数组 → 展开为等量 `?` 并扁平化参数。

### 4.6 SHOW / information_schema 模拟（结果形状必须与 MySQL 一致）

- `SHOW TABLES` → `[{ 'Tables_in_<db>': 'table_name' }]`。
- `SHOW TABLE STATUS LIKE ?`（database.js:69）→ `Engine/Rows/Data_length/Index_length/Collation/Create_time/Update_time`。
- `DESCRIBE`（database.js:72/187）→ `Field/Type/Null/Key/Default/Extra`。
- `SHOW FULL PROCESSLIST`（database.js:110）→ `Id/User/Host/db/Command/Time/State/Info`。
- `SHOW VARIABLES`（database.js:134）→ `Variable_name/Value`。
- `SHOW INDEX FROM`（database.js:197、migrate-v5.6.js:39）→ `Key_name/Non_unique/Column_name`。
- `SHOW CREATE TABLE`（migration.js:291-292）→ 返回 **MySQL 风格 SQL 字符串**（migration 会把 DDL 重放到真实 MySQL）。
- `SHOW COLUMNS FROM users`（db_init.js:1398/1701/1721、migrate-v5.6.js:26）→ Field 形状。
- `information_schema.TABLES ... TABLE_SCHEMA = ?` 带 `[holder.dbName]` 参数 → `COUNT(*) AS cnt`（db_init.js:2041）。
- `information_schema.COLUMNS ... COLUMN_KEY = 'PRI'` → `COLUMN_NAME + DATA_TYPE`（migration.js:186）。
- `information_schema.KEY_COLUMN_USAGE`（scripts/diag-account.js:23）。

**注意**：`GROUP_CONCAT` 只出现在 WAF 正则（middleware/waf.js:29）的拦截名单里，真实 SQL 未使用，**无需为其实现 UDF**。

---

## 5. Pool / 连接外观设计（SQLite 模式）

- `getPool()` 返回 `holder.pool`；SQLite 模式下返回 pool-like 对象，`pool.query(sql, params)` 返回 `[rows, fields]`。
- 池统计（database.js:36-43）：`connectionLimit`、`queueLimit || 50`、`_allConnections?.length || 0`、`_idleConnections?.length || 0`、`_waitingCount || 0`。
- `getConnection()` 返回 connection-like：`.query()`、`.execute()`、`.beginTransaction()`、`.commit()`、`.rollback()`、`.release()`（约 15 个消费者事务位置，如 events.js、posts.js、profile.js、admin.js 等）。
- SQLite 文件路径：默认 `server/data/jingtu.sqlite`（mkdir -p 创建目录），可由 `JINGTU_SQLITE_PATH` 覆盖。
- 开启 WAL：`db.exec("PRAGMA journal_mode = WAL")`。

---

## 6. 待定设计决策（实现时拍板）

1. **UPSERT 目标策略**：优先从 SQL/DDL 提取唯一列用 `ON CONFLICT(col,...)`；无唯一列时退化无目标 `ON CONFLICT DO UPDATE`（探针已验证可行）。
2. **`UNIX_TIMESTAMP()`**：注册 UDF（`(v) => Math.floor(Date.now()/1000)`）与重写为 `strftime('%s','now')` 二选一；建议 UDF，改动面小。
3. **`routes/export.js` 流式导出**：pool-like 对象上提供兼容 `.pool`（基础 callback 形态 + `.stream()` 降级为一次性拉全量），或 SQLite 模式优雅降级为 JSON 导出。
4. **`routes/migration.js` 迁移**：`createConnection` 命中 patch 后目标是真实 MySQL；设计为：SQLite 模式下迁移路由返回明确错误（文档说明不可用），避免误操作。
5. **JSON 列结果转换**：在 DDL 层维护 JSON 列清单，exec 层对对应列结果做 `JSON.parse`，使消费者拿到 JS 对象（与 mysql2 行为一致）。
6. **错误映射**：errno 1060/1061/1054/1062 与 `ER_*` code 需在 exec 包装层统一映射（1062 用于 `ON CONFLICT` 兜底场景的 `ER_DUP_ENTRY` 语义）。

---

## 7. 实现步骤计划（新对话按此推进）

1. 读取当前 `server/db.js` 全文（重写前必须 Read，Write 工具要求）。
2. 继续通读 `db_init.js` 剩余 DDL 数组区段（L219-1243）与尾部建表/ALTER 区段（L1909-2003），补全 DDL 重写器覆盖样例；如有新的 SQL 形态，扩充第 4 节规则。
3. 实现新 `server/db.js`：
   - 顶层：读 `JINGTU_DB_ENGINE`；若非 `'sqlite'`，走原 MySQL 逻辑（保持现有代码 100% 行为）。
   - SQLite 分支：初始化 `DatabaseSync`（mkdir、WAL、UDF 注册：regexp / find_in_set / greatest / unix_timestamp 等），可选预建 `sessions` 表。
   - 统一的 SQL 路由重写器：DDL / ALTER / SHOW / information_schema / DML 分支，全部落实第 4 节规则。
   - Promise pool/connection 外观：query / execute / 事务语句 / release / 统计。
   - 错误映射层（第 6 节决策 6）。
   - MySQL 模式下跳过 SQLite 心跳，保持原心跳逻辑。
   - 导出/迁移兼容性处理（第 6 节决策 3、4）。
   - JSON 列结果转换（第 6 节决策 5）。
   - 末尾保持 `module.exports = { holder, DB_NAME, DB_CONFIG, getPool, recreatePool, applyDbConfig }`。
4. 清理探针文件（见第 9 节）。
5. 冒烟测试（见第 8 节）。
6. 验证 MySQL 模式未破坏。

---

## 8. 冒烟测试方案

在 `server/` 目录下执行（否则 MODULE_NOT_FOUND）：

```bash
# 1. 模块加载（MySQL 模式默认，应输出原行为）
node -e "require('./db')"

# 2. SQLite 模式模块加载
$env:JINGTU_DB_ENGINE="sqlite"; node -e "require('./db'); console.log('ok')"

# 3. 用 SQLite 引擎跑 db_init（建表全量通过）
$env:JINGTU_DB_ENGINE="sqlite"; node db_init.js
```

验证 SQLite 文件生成到 `server/data/jingtu.sqlite`，然后对代表性查询逐项验证：

- `INSERT OR IGNORE`、带目标与无目标 `ON CONFLICT DO UPDATE`
- `IN (?)` 数组展开
- 带参数 INTERVAL 的 `DATE_SUB` / 算术 `NOW() - INTERVAL`
- `JSON_EXTRACT` / `JSON_CONTAINS`
- `FIND_IN_SET`、`GREATEST`、`REGEXP`
- `HOUR/MONTH/DAY/YEAR` strftime、`IFNULL`
- `SHOW TABLES` / `DESCRIBE` / `SHOW CREATE TABLE` / information_schema 计数
- 事务（begin/commit/rollback）
- ALTER 批次（重复列 1060、重复索引 1061 的 MySQL 兼容错误）

最后：**MySQL 模式回归**——不设环境变量正常启动，确认心跳与连接行为与原先一致。

---

## 9. 清理清单（测试完成后删除）

`server/_probe_json.js`、`server/_probe_sqlite_features.js`、`server/test-sqlite-tmp.js`、`server/_smoke_sqlite.js`、`server/_smoke_sqlite2.js`、`server/_smoke_backtick.js`、`server/_smoke_s3.js`

> ✅ 已全部清理（含本会话新增的 `_probe_*`/`_smoke_*`/`_tmp_*`/`scripts/_verify_*` 等共 27 个探针文件）。

---

## 10. 相关文件索引（绝对路径 + 关键行）

- `d:\phpstudy_pro\WWW\jingtu-web\server\db.js` —— **已重写**（约 1300 行）：MySQL 默认模式 + `JINGTU_DB_ENGINE=sqlite` 分支（SQLite 引擎、就地 patch、SQL 重写器、pool/connection 兼容层、错误映射）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\node_modules\mysql2\promise.js` —— patch 目标（208 行，具名导出）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\db_init.js` —— DDL/ALTER/INSERT IGNORE 主消费方（L66 建表数组、L1248-1265 执行、L1398/1701/1721 SHOW COLUMNS、L2041 information_schema、L2077 ON DUPLICATE）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\routes\database.js` —— SHOW 语句与池统计消费方。
- `d:\phpstudy_pro\WWW\jingtu-web\server\routes\export.js` —— `.stream()` 流式导出。
- `d:\phpstudy_pro\WWW\jingtu-web\server\routes\migration.js` —— SHOW/迁移/重放 DDL。
- `d:\phpstudy_pro\WWW\jingtu-web\server\server.js` —— MySQLStore → MemoryStore 回退（无需改）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\tasks.js` —— 唯一 `UNIX_TIMESTAMP()` 消费方（L38）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\webhook.js` —— `FIND_IN_SET`（L22）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\routes\admin.js` —— `REGEXP` + `CAST(..., UNSIGNED)`（L98）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\routes\collections.js` —— `JSON_CONTAINS`（L215）、`JSON_UNQUOTE(JSON_EXTRACT...)`（L312）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\routes\events.js` / `posts.js` / `profile.js` —— `FOR UPDATE` 与事务。
- `d:\phpstudy_pro\WWW\jingtu-web\server\auth_local_service.js`（L356 DATE_ADD、L471 JSON_EXTRACT）、`server\auth_reset_service.js`（L139）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\schedule.js`（L275/444/591）、`server\world_cache.js`（L82）、`server\groups_members_sync.js`（L301）—— `NOW() - INTERVAL`。
- `d:\phpstudy_pro\WWW\jingtu-web\server\migrate-v5.6.js` —— `SHOW COLUMNS`（L26）、`SHOW INDEX`（L39）。
- `d:\phpstudy_pro\WWW\jingtu-web\server\scripts\diag-account.js` —— `KEY_COLUMN_USAGE`（L23）。

---

## 11. 实现后追加审查与修复记录（2026-09-29）

S2 主体交付后，对 `server/db.js` 做了二次审查（通读代码 + 对照第 4 节规则 + 真实消费者 SQL 形态实测），发现并修复以下问题：

| # | 问题 | 修复 |
|---|---|---|
| 1 | `FIELD()` 函数缺失：`routes/users.js` 4 处使用（含 `MAX(FIELD(...))` 聚合与 `ORDER BY FIELD(...)`），SQLite 原生无此函数 | 注册 `field` UDF（`varargs + deterministic`，1-based 位置，未命中返回 0） |
| 2 | `SET` 会话语句仅吞 4 种前缀，其他（如 `SET time_zone`）会走到 prepare 崩溃 | `SET` 开头语句统一 no-op（`UPDATE ... SET` 以 UPDATE 开头不受影响） |
| 3 | `node:sqlite` 返回 **null-prototype 行对象**且超大整数为 **BigInt**（`JSON.stringify` 会抛错），与 mysql2 普通对象语义不符 | SELECT 结果逐行转为普通 `Object`，`bigint` 值转 `Number` |
| 4 | `sessions` 表缺失：db_init 无其建表语句（由 server.js 的 MySQLStore 创建）；SQLite 模式下回退 MemoryStore 后 `tasks.js` 定时清理 `DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP()` 报"表不存在"并每小时告警 | SQLite 初始化时预建 sessions 表（express-mysql-session 同构 schema：`session_id` PK / `expires` INT / `data` TEXT），并注册元数据 |

**验证补充**：10 项真实消费者 SQL 形态实测 10/10 通过（users 管理列表完整查询、JSON_EXTRACT/JSON_CONTAINS、FIND_IN_SET、REGEXP+CAST、UNIX_TIMESTAMP、DATE_ADD 字面量+参数化、NOW()-INTERVAL、多表 ON DUPLICATE upsert 等）；干净库 `db_init` 全量 82 张表、二次幂等；MySQL 模式回归正常。

**遗留说明**：
- `routes/user-data-helper.js:147` 对 `member_note` 使用旧列名（`owner_vrcid/target_vrcid`），SQLite 模式下该处查询会报未知列——属第 6 节决策"迁移后 schema 优先"的范围外预期，未改动。
- JSON 列结果解析依赖"进程内先执行过 CREATE TABLE"（DDL 层注册清单）。正常启动路径（server.js → initDatabase）满足；独立脚本若直接 require('./db') 使用需先跑 `initDatabase()`。
