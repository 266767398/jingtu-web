# 模型收藏馆 → 复用统一 collections（未完成任务清单）

> 关联指令：「模型收藏馆」改复用 `collections`
> 创建日期：2026-08-28
> 状态：**未完成（仅完成前端/路由层合并，DB 层双存储尚未收敛）**

---

## 一、背景与目标

统一收藏系统 `collections`（V8.2）已合并原「模型收藏馆」(`model_collections`, `kind=avatar_model`) 与「收藏夹」(`world_favorites`/`avatar_favorites`)。目标是让**全站只剩一套收藏实现**：数据写入 `collections` 表、失效检测/通知/公开发现都走 `routes/collections.js`。

### 已完成基线（前几轮已落地，本节仅作背景）
1. 删除孤儿前端 `public/js/model-collections.js` 与孤儿路由 `server/routes/model-collections.js`、`server/server.js` 中的 `/api/model-collections` 注册。
2. VRCX 匿名搜索由 `/api/model-collections/search` 迁移为 `GET /api/collections/search-models`，并接入统一收藏 `collAddModal`。
3. 后台「模型收藏馆」管理面板 `admin-model-collections.js` 已确认**只调用统一接口** `/api/collections/admin/*`（stats/invalid/user/scan），即后台管理本身已复用 collections。
4. 删除 `index.html` 死模态 `#mcAddModal`/`#mcDetailModal`；`groups.js` 公开模型 `url` 改 `/collections`、`members.js modelCard()` 站内路径改 `switchTab('collections')`。

### 仍残留的「双实现」（本轮待办）
虽然后台管理与前端 UI 已切到 collections，但**数据读取侧仍有两处直连遗留 `model_collections` 表**，导致：
- 成员资料页「公开模型」统计/列表（`groups.js`）读的是**已冻结、不再更新的旧表**，新收藏的 avatar_model 不显示。
- 每日 5:00 失效检测定时任务（`schedule.js`）扫描的是**旧表**，统一 `collections` 里的新 avatar_model 收藏**从未被每日扫描**，失效不会通知用户。
- 遗留服务 `server/services/model-collection-service.js` 仍被 schedule 引用，是旧表的唯一写入方（但新收藏已不写它，故旧表只减不增）。

---

## 二、未完成任务清单

### 任务 A（P0，必须）— `groups.js` 公开模型统计/列表改读统一 `collections` 表

**涉及文件**：`server/routes/groups.js`
**行号**：969（`localPublicModels` 声明）、971（计数查询）、982–987（列表查询）、991–997（字段映射）

**现状问题**：
```js
// 971 计数 读旧表
const [pm] = await pool.query(`SELECT COUNT(*) AS c FROM model_collections WHERE user_id = ? AND is_public = 1`, [localUser.id]);
// 982 列表 读旧表，且引用 performance_rating / model_name / thumbnail_url 等旧列
const [models] = await pool.query(
  `SELECT id, model_name, thumbnail_url, performance_rating, platform
   FROM model_collections WHERE user_id = ? AND is_public = 1
   ORDER BY favorite_count DESC LIMIT 6`, [localUser.id]);
// 991 映射：modelId 拼 'local-' 前缀、performanceRating 取旧列、favoriteCount 恒为空
localPublicModels = (models || []).map(m => ({
  modelId: 'local-' + m.id, name: m.model_name, ...
  performanceRating: m.performance_rating || '', platform: m.platform || '',
  favoriteCount: '', source: 'local', url: '/collections'
}));
```

**改法**（统一到 `collections` 表，字段对齐 `collections` schema：`target_id/name/thumbnail/platform/favorite_count`）：
```js
const [pm] = await pool.query(
  `SELECT COUNT(*) AS c FROM collections
   WHERE user_id = ? AND kind='avatar_model' AND visibility='public' AND status='valid'`,
  [localUser.id]);
// ...
const [models] = await pool.query(
  `SELECT id, target_id, name, thumbnail, platform, favorite_count
   FROM collections
   WHERE user_id = ? AND kind='avatar_model' AND visibility='public' AND status='valid'
   ORDER BY favorite_count DESC LIMIT 6`, [localUser.id]);
// ...
localPublicModels = (models || []).map(m => ({
  modelId: m.target_id, name: m.name,
  authorName: base.displayName || (localUser.display_name || ''),
  thumbnailUrl: m.thumbnail || '', tags: [], createdAt: '',
  performanceRating: '', platform: m.platform || '',
  favoriteCount: m.favorite_count || '', source: 'local', url: '/collections'
}));
```

**决策点（需确认）**：
- 旧逻辑统计全部 `is_public=1`（含失效模型）；新写法只统计 `status='valid'`，避免把死模型算进公开数。**推荐只计 valid**（更好的 UX），但会改变显示数字，请在文档/PR 注明。
- `collections` 表**无 `performance_rating` 列**，故 `performanceRating` 置空（前端该字段本就是可选展示）。

**风险**：低。仅改查询与映射，不影响写入。
**验证**：用有 avatar_model 公开收藏的用户进入成员资料页，确认「公开模型」数量/缩略图/名称与 `collections` 表一致。

---

### 任务 B（P0，必须）— `schedule.js` 每日 5:00 失效检测改扫 `collections` 表并保留失效通知

**涉及文件**：
- `server/schedule.js` 第 8 行（import）、522–536（5:00 job）
- `server/routes/collections.js`（需新增可复用扫描函数，当前 578–595 `/scan`、674–690 `/admin/user/:id/scan`、692–708 `/admin/scan` 三个扫描端点**都不发通知**，且都直连 `collections` 但无复用）

**现状问题**：
```js
// schedule.js:8
const modelCollectionService = require('./services/model-collection-service');
// schedule.js:522-536 每日 5:00 调旧服务，扫旧表 model_collections
const result = await modelCollectionService.scanInvalidModels({
  getVRCCookieFn: _getVRCCookie, notificationService, batchSize: 200, onlyUnchecked: true
});
```
旧 `scanInvalidModels` 会向**新失效**模型的主人推送 `model_invalid` 通知（这是真实用户功能）。而统一 `collections` 的三个扫描端点只更新状态、**不推送通知**。

**改法 B1（推荐：单一扫描函数 + 参数注入通知，消除重复）**：

在 `server/routes/collections.js` 中新增并导出共享扫描函数（放在 admin 扫描段附近，约 595 行后）：
```js
// 公共失效检测：扫描 collections(kind=avatar_model)，更新状态并对新失效项推送通知。
// 供定时任务(schedule.js)与后台手动扫描复用，避免双实现。
async function scanAvatarModels(pool, opt = {}) {
  const { getVRCCookieFn, notificationService, batchSize = 200,
          onlyUnchecked = false, specificUserId = null, vrcCookie = null } = opt;
  const where = [`kind='avatar_model'`, `status<>'invalid'`];
  const params = [];
  if (onlyUnchecked) where.push(`(last_checked_at IS NULL OR last_checked_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`);
  if (specificUserId) { where.push('user_id = ?'); params.push(specificUserId); }
  const [rows] = await pool.query(
    `SELECT id, user_id, target_id, status FROM collections
     WHERE ${where.join(' AND ')} ORDER BY last_checked_at ASC LIMIT ?`,
    [...params, batchSize]);
  if (rows.length === 0) return { scanned: 0, newlyInvalid: 0 };
  const cookie = vrcCookie || (typeof getVRCCookieFn === 'function' ? getVRCCookieFn({ session: {} }) : null);
  let scanned = 0, newlyInvalid = 0;
  for (const r of rows) {
    scanned++;
    let newStatus = 'unknown', reason = '';
    try {
      const avatar = await vrchatGetAvatar(r.target_id, cookie);
      if (!avatar) { newStatus = 'invalid'; reason = 'VRChat 未返回该模型'; }
      else newStatus = 'valid';
    } catch (e) { newStatus = 'invalid'; reason = e.message || '检测失败'; }
    const wasInvalid = r.status === 'invalid';
    await pool.query(
      `UPDATE collections SET status=?, invalid_reason=?, last_checked_at=NOW(), invalid_at=? WHERE id=?`,
      [newStatus, reason, newStatus === 'invalid' ? new Date() : null, r.id]);
    if (newStatus === 'invalid' && !wasInvalid) {
      newlyInvalid++;
      if (notificationService && typeof notificationService.notifyUser === 'function') {
        notificationService.notifyUser(
          r.user_id, 'model_invalid', '⚠️ 收藏的模型已失效',
          `您收藏的模型 ${r.target_id} 已无法访问（${reason}），建议删除后重新收藏。`,
          { targetType: 'model_collection', targetId: String(r.id) });
      }
    }
    await new Promise(r => setTimeout(r, 200)); // 轻微限流，降低 VRChat 429 概率
  }
  return { scanned, newlyInvalid };
}
module.exports.scanAvatarModels = scanAvatarModels; // 注意：routes/collections.js 末尾 module.exports 是工厂函数，挂静态属性即可
```

`schedule.js` 改造：
```js
// 删除第 8 行 import：const modelCollectionService = require('./services/model-collection-service');
// 替换 522-536 的 job 体：
jobs.push(schedule.scheduleJob('0 0 5 * * *', async () => {
  console.log('🔄 [定时任务] 开始检测失效的模型收藏...');
  try {
    const { scanAvatarModels } = require('./routes/collections');
    const pool = getPool();
    const result = await scanAvatarModels(pool, {
      getVRCCookieFn: _getVRCCookie, notificationService, batchSize: 200, onlyUnchecked: true
    });
    console.log(`✅ [定时任务] 模型收藏检测完成: 扫描 ${result.scanned} 个, 新失效 ${result.newlyInvalid} 个`);
  } catch (e) {
    console.error('❌ [定时任务] 模型收藏检测失败:', e.message);
  }
}));
```

`server.js`（第 1052 行）：当前 `app.use('/api/collections', require('./routes/collections')(getVRCCookie));` **已满足**（只传 getVRCCookie）。`scanAvatarModels` 以 `notificationService` 参数注入，schedule 自己持有 `notificationService`，无需改 server.js 挂载签名。

**可选增强（非必须）**：将 `routes/collections.js` 现有 `/scan`、`/admin/scan`、`/admin/user/:id/scan` 三个端点改为调用 `scanAvatarModels`（手动扫描可不传 notificationService，保持原行为），实现 DRY。

**风险**：中。涉及每日定时任务 + 用户通知，务必保留 `model_invalid` 通知逻辑（旧功能）。
**验证**：
- 手动触发一次：`POST /api/collections/admin/scan` 应返回 `{success:true, scanned, newInvalid}`；
- 故意把某 avatar_model 的 `target_id` 改成一个不存在的 avtr_，等次日 5:00 或临时手动跑 `scanAvatarModels` → 该用户应收到 `model_invalid` 通知（查 `notifications` 表或铃铛）。

---

### 任务 C（P0，必须）— 删除遗留服务 `server/services/model-collection-service.js`

**涉及文件**：`server/services/model-collection-service.js`
**引用方**（已 grep 确认全仓）：仅 `server/schedule.js`（第 8 行 import + 第 526 行调用）。

**改法**：完成任务 B 后，该文件无任何引用，直接删除。其内部 `addCollection` / `fetchModelDetails` / `fetchModelSize` / `refreshCollectionDetails` / `syncTagDict` 均为内部私有函数，全仓无其它调用（已 grep 确认 `addCollection`/`fetchModelDetails` 仅在文件内出现）。

**风险**：低（依赖方已解耦）。
**验证**：`grep -rn "model-collection-service\|modelCollectionService\|fetchModelDetails" server/` 应 0 命中。

---

### 任务 D（P1，建议）— 处理孤儿 CSS `public/css/model-collections.css`

**现状**：该文件**未被任何地方引入**（已 grep 确认：`index.html`、`style.css` 均无 link/`@import`）。后台「模型收藏馆」面板（`index.html:1008` `data-panel="model-coll"`、`index.html:1025` `id="mcAdminInvalidList"`）使用 `.mc-*` 类，但**当前完全无样式**（渲染为裸 HTML）。

**两个方案**：
- **方案 D2（推荐，低风险）**：把 `model-collections.css` 中 `.mc-*` / `.model-coll-list` / `.badge-valid|invalid|unknown` / `.load-*` / `.pf-*` / `.badge-functional|white|18` 等样式**迁移进已加载的 `public/css/collections.css`**，删除孤儿 `model-collections.css`。后台「模型收藏馆」面板本就调用统一 `/api/collections/admin/*`，保留它即可，仅修复样式。
- **方案 D1（彻底复用，UX 改动较大）**：删除独立的后台「模型收藏馆」面板（`index.html:872` 导航项、`index.html:1008` 面板、`loader.js:39/62` 的 `admin-model-collections.js` 加载），将其功能并入现有 collections 后台管理 UI。属于重构，需确认 collections 后台 UI 已覆盖 invalid 列表/用户下钻等能力（现有 `/admin/invalid`、`/admin/user/:id` 已支持，但页面 UI 需补）。

**推荐 D2**：保留功能、最小化风险，先把样式修好；D1 作为后续可选重构。
**验证**：后台打开「模型收藏馆」，卡片/徽章/分页样式正常（D2）；或导航项消失、功能并入 collections 后台（D1）。

---

### 任务 E（P2，可选）— `db_init.js` 遗留表处理

**现状**：`model_collections` / `model_ratings` / `model_tag_dict` 三张表仍在 `db_init.js` 建表（`CREATE TABLE IF NOT EXISTS`，约 942/954 行与 1554/1564 行两处），且存在一次性迁移块（约 1738–1764 行）从 `model_collections` 读取写入 `collections`（由 `system_config.collections_migrated` 标志幂等控制）。

**结论**：**保留这些建表语句与迁移块**，不要删。因为：
- 若是全新数据库（无 `collections_migrated` 标志），迁移依赖 `model_collections` 表存在才能把历史数据并入 `collections`；删表会破坏冷启动迁移。
- 完成 A/B/C 后，旧表仅剩「迁移来源」用途，运行时不再写入（dormant）。已在 `collections` 表承载全部读写。

**后续清理（不在本轮）**：若未来确认所有生产库均已迁移（`collections_migrated=1`），可单独立项：删 `db_init.js` 的 `model_collections/model_ratings/model_tag_dict` 建表 + 迁移块，并改为直接 seed `collections`。
**风险**：高（误删会破坏冷启动），故本轮不动。

---

### 任务 F（P2，可选）— 后台「模型收藏馆」与 collections 后台去重

`admin-model-collections.js` 已调用统一 `/api/collections/admin/*`，功能上无重复。仅 UI 呈现与 collections 后台存在差异。是否合并见任务 D 方案 D1。本轮不强制。

---

## 三、推荐执行顺序

1. **A** → `groups.js` 改读 `collections`（独立、低风险）
2. **B** → `routes/collections.js` 新增 `scanAvatarModels` + 导出；`schedule.js` 改调
3. **C** → 删除 `model-collection-service.js`（依赖 B 完成）
4. **D2** → 迁移孤儿 CSS 到 `collections.css` 并删除原文件
5. **E/F** → 本轮跳过（仅记录）

## 四、验收标准

- [ ] 全仓 `grep -rn "model_collections" server/` 除 `db_init.js`（迁移块）外 **0 命中**
- [ ] 成员资料页「公开模型」统计/列表来自 `collections` 表，且与数据库一致
- [ ] 每日 5:00 定时任务扫描 `collections`(avatar_model)，新失效模型主人收到 `model_invalid` 通知
- [ ] `server/services/model-collection-service.js` 已删除，无悬挂引用
- [ ] 孤儿 `model-collections.css` 已并入 `collections.css`（或后台面板已并入 collections 后台）
- [ ] `node --check` 通过：`collections.js` / `schedule.js` / `groups.js` / `db_init.js` / `server.js`
- [ ] 重启后冒烟：80/3456 = 200；`/api/collections/admin/stats` 正常；`/api/model-collections/*` 仍 404

## 五、注意事项

- **重启方式**：用 **PowerShell 工具**执行 `jingtu.ps1 restart`（禁止从 Bash 调 PowerShell，会被安全策略拦截）。可设 `$env:JINGTU_NO_OPEN='1'` 抑制自动开浏览器。实测一次干净重启约 4m27s。
- **node 路径**：Windows 下二进制用 `D:/...` 风格路径（不可用 `/d/...`，会被解析成 `d:\d\...` 失败）。
- **不要动 `db_init.js` 的遗留建表/迁移**：见任务 E。
- **通知保留**：任务 B 必须保留 `model_invalid` 推送，这是真实用户功能，统一端点原本不发通知，需在 `scanAvatarModels` 内补回。
