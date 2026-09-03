# 16. VRCX 代码结构与工程化借鉴（对比 jingtu-web 实际场景）

> 续 `15-VRCX接口调度借鉴与改进方案.md`。本文不再重复接口清单，改从**代码结构 / 命名规范 / 错误处理 / 性能优化 / 可维护性 / 测试覆盖**六个维度，把 VRCX 的工程化实践与本项目现状对比，给出**可落地**的优化点。
>
> 结论先行：本项目在「错误分类语义」「限流感知」「前端分层」上有明显短板；但在「集成测试质量」「缓存分层」「后台权限」上已优于 VRCX。下文按"该抄什么、怎么抄、能避免什么线上事故"展开。

---

## 0. 双方结构速览（对照）

| 维度 | VRCX (src/) | jingtu-web |
|---|---|---|
| 前端组织 | `coordinators/`(24) + `stores/`(Pinia) + `queries/`(TanStack) + `services/`(webapi 桥) | `public/js/` 约 40 个**扁平 .js**（members/group/collections/ui/main/loader…），无 store/coordinator 分层 |
| 后端组织 | C# `WebApi.cs` 执行器 + JS 桥 | `server/routes/`(40 文件) + `server/services/` + `server/vrc.js` 统一封装 |
| 错误处理 | `request.js` 的 `$throw` + `shouldIgnoreError` + `failedGetRequests` 熔断 | `utils.js sendError/sendVrcError/ErrorCodes` + `vrc.js vrchatRequest` 已分类型，但**未枚举 VRChat 4xx 语义** |
| 缓存 | 无服务端缓存（全靠前端 TanStack Query + 本地 DB） | `cache_service.js` + `cache.js`（Redis/内存）分层清晰，**已优于 VRCX** |
| 测试 | `coordinators/__tests__/` 仅 2 个；`api/__tests__/` 几个 querySync | `server/__tests__/` 行为测试（mock + supertest 跑真路由），**注释写明根因与边界，质量高于 VRCX** |

---

## 1. 代码结构：引入前端 coordinator / store 分层

### 现状问题
`public/js/` 是扁平模块。`members.js` 里既有 `openVrcMemberCard`（UI 弹窗）又直接拼 VRChat 字段、又读 `ws_service` 推送；`group.js` 兼管在线状态增量、防抖兜底、卡片渲染。一个文件动辄 800–1500 行，**跨 tab 调用靠全局函数 + `TAB_MODULES` 依赖声明硬连**（见 `MEMORY.md`）。

### VRCX 借鉴点
VRCX 把"数据从哪来、怎么存、怎么给 UI"拆成三层：
```
api/        → 纯请求（users.js / friends.js / groups.js），无状态
coordinators/ → 编排：getCurrentUser() 调 api + 写 store + 触发缓存
stores/     → Pinia 状态（userStore / notificationStore），UI 只订阅 store
```
关键收益：`userCoordinator.js` 的 `getCurrentUser` 是唯一入口，UI 永远不直接碰 `/auth/user` 请求。

### 本项目具体建议（不推翻重写，增量切）
1. **抽出 `public/js/coordinators/`**（类比 VRCX）：把 `members.js` 里"拉名片详情 → 规整字段 → 写缓存"的逻辑挪到 `memberCoordinator.js`，`renderVrcMemberCard` 只负责 DOM。
2. **跨 tab 全局函数收口到 coordinator**：目前 `TAB_MODULES.group` 必须含 `'members.js'` 才能调 `openVrcMemberCard`。改为 coordinator 单例挂在 `window.JT` 命名空间，调用方不再感知"哪个模块定义了它"，**消除 MEMORY 里那条脆弱约定**。
3. **状态集中**：在线状态、roster 目前散在 `group.js` 闭包 + `ws_service` 全局。可建 `public/js/store/roster.js`（轻量发布订阅），`group.js` 与 `members.js` 都订阅它，避免"两个模块各存一份在线名单"导致状态漂移。

> 优先级：P2（重构风险高，建议新功能先按此结构写，旧代码逐步迁移）。

---

## 2. 命名规范：统一"资源 + 动作"、消除歧义

### 现状问题
- 后端函数名风格不一：`vrchatGetCurrentUser` / `vrchatGetGroupMembers`（vrc.js 好）；但 routes 里 `sleep`、`ROLE_CN_MAP` 全局混用；`cache_service.js` 的 `getUsers`/`setUsers` 与 `getUser` 并存但语义不同（list vs 单条）。
- 前端更明显：`ui.js` 的 `switchTab` vs `group.js` 的 `switchGroupTab`；`openVrcMemberCard` vs `renderVrcMemberCard` 职责靠命名区分，新人易混。

### VRCX 借鉴点
VRCX 命名高度一致：`动词 + 实体 + 修饰`（`buildRequestInit` / `processBulk` / `friendQuerySync`），且**测试文件名 = 被测模块名**（`userCoordinator.test.js`）。

### 本项目具体建议
1. **coordinator/store 统一 `get/set/list/subscribe` 动词前缀**（已部分做到，cache_service 可当范本）。
2. **UI 渲染函数统一后缀**：`openXxx`（开弹窗）/`renderXxx`（画 DOM）/`fetchXxx`（取数据）三词法定死，写进 `docs/02-前端架构详解.md` 约定。
3. **常量文件化**：`ROLE_CN_MAP`、`LANG_CN` 散在 routes 与 js 里，挪到 `server/constants.js` 与 `public/js/constants.js`，避免重复定义。

> 优先级：P3（纯规范，不修不影响运行，但应写进约定防止继续劣化）。

---

## 3. 错误处理：把 VRChat 4xx 语义枚举化（最高价值）

### 现状问题
`server/vrc.js` 的 `vrchatRequest` 已能区分 401/429/5xx 并 fallback cookie，但**错误仍以"状态码 + 文本"散落各处**。前端只在 catch 里 `toast` 文案，无法区分：
- `401 Missing Credentials`（需重新登录 2FA）
- `401 Unauthorized`（cookie 过期）
- `429 Too Many Requests`（限流，应退避而非重试）
- `404`（资源不存在，可静默）

→ 结果是：限流时前端反复重试撞更狠的限流；cookie 过期和"没登录"混为一谈（本项目测试 `vrc-cookie-fallback.test.js` 已专门区分 `VRC_COOKIE_EXPIRED` vs `VRC_SYSTEM_OFFLINE`，说明**后端已意识到，但前端没接住**）。

### VRCX 借鉴点（`request.js` 三段式）
```js
// 1) 精细错误类
$throw(code, error, endpoint)  // 携带 status + endpoint + message
// 2) 静默规则（这些错误不打 toast、不重试）
shouldIgnoreError(code, endpoint)  // 404/403 的部分 endpoint 直接忽略
// 3) 熔断：最近 15min 失败的 GET 不再打
failedGetRequests.has(endpoint) && recent → 直接 bail
```

### 本项目具体建议（P0，直接可落地）
1. **后端补 `VrcApiError` 类型枚举**（扩展现有 `ErrorCodes`）：`VRC_2FA_REQUIRED=401_MC` / `VRC_COOKIE_EXPIRED` / `VRC_RATE_LIMITED=429` / `VRC_NOT_FOUND=404` / `VRC_UPSTREAM_5XX`。`vrc.js` 在解析响应时**一次性归类**，路由层只 `throw new VrcApiError('VRC_RATE_LIMITED')`。
2. **前端 `sendVrcError` 已能带 `code`**，但 UI 层要按 `code` 分支：
   - `VRC_RATE_LIMITED` → 退避 30s 后自动重试，**不弹错误红条**，仅顶部轻提示"VRChat 限流中，稍候自动恢复"。
   - `VRC_2FA_REQUIRED` → 弹重新登录模态（而非清 cookie）。
   - `VRC_NOT_FOUND`（如陌生人的私密模型）→ 静默降级，不 toast。
3. **借鉴 `failedGetRequests` 熔断**：前端对"搜世界/搜模型"类 GET，15min 内同一 endpoint 失败直接短路，避免刷新狂点把 VRChat 账号打进限流。

> 优先级：**P0**。这能根治"列表页限流雪崩""cookie 误清""2FA 被当成过期"三类线上问题。当前 `cache_service` 有 `PROFILE_CARD`/`GROUP_ROSTER` 缓存但**VRChat 原始响应层没有限流退避**，恰好补上。

---

## 4. 性能优化：processBulk + 限流感知 + 请求去重

### 4.1 借鉴 `processBulk`（分页全量拉取）
VRCX 的 `processBulk` 统一处理 `offset/n/hasNext`，群成员、好友全量刷新都走它，`done(success)` 回调收尾。

本项目 `schedule.js` 30s 刷新 roster 已是"小群每轮全员、大群分批"，但**分批逻辑散在 schedule 里**。建议把"分批拉 VRChat 列表"抽成 `server/services/paginate.js` 的 `processBulk(fn, {n, N, handle})`，与 VRCX 同名同语义，schedule 直接复用，减少重复分页代码。

### 4.2 借鉴 `pendingGetRequests`（10s GET 去重合并）
前端同一时刻多个 tab/卡片并发调"当前用户""群 roster"，VRCX 在 10s 内合并为一次请求。本项目前端每次 `openVrcMemberCard` 都打一次 `/detail`，**同一个人卡片连点 = N 次 VRChat 调用**。建议加一层 `requestDedup(key, fn, ttl=10000)`，命中直接复用 Promise。

### 4.3 借鉴限流感知（`updateLoopStore.setNextGroupInstanceRefresh(120)`）
VRCX 在收到 429 时把下次刷新延到 120s。本项目 `schedule.js` 固定 30s，**一旦被限流会越刷越糟**。建议：限流时动态把该任务间隔翻倍（指数退避，上限如 5min），恢复后回落。

> 优先级：P1（性能与稳定性，限流退避尤其重要）。

---

## 5. 可维护性：配置外置 + 单一职责

### 现状优势（保持）
- `cache_service.js` 已把"TTL + key 生成 + get/set/invalidate + 预热"聚到一个文件，比 VRCX 散落各 coordinator 的 `cache` 调用**更清晰**。
- 后台 `requireAdminCompat` + `ROLE_LEVEL` 三元角色，比 VRCX 前端 `if (!isFriend)` 散判**更集中**。

### 可改进
1. **魔法数字外置**：`schedule.js` 的 `30s`、群大小阈值 `≤80`、状态稳定化 `≥60s`、信任等级 `3/2/1`，应进 `server/config.js`（或 `.env`），而不是硬编码（已在 MEMORY 记录"小群≤80"等，应固化成常量）。
2. **`MEMORY.md` 里"状态稳定化"逻辑目前写在哪？** 建议状态机（`status_candidate/changed_at/trust`）抽成 `server/services/statusMachine.js`，schedule 与 ws 都调它，避免两处各写一份翻转规则（当前已在 `schedule.js` 内，但 ws_service 也广播，需确认是否单点）。
3. **日志分级**：`logger.js` 已有，但 `vrc.js` 失败日志建议带 `endpoint + status + retryNo`，对齐 VRCX `logWebRequest`，便于排限流。

> 优先级：P2。

---

## 6. 测试覆盖：守住现有优势，补两类缺口

### 现状优势
`server/__tests__/vrc-cookie-fallback.test.js` 是**教科书级行为测试**：用 `jest.mock('../vrc')` 造 DEAD/GOOD cookie，supertest 打真路由，断言"第一份 401 后确实换第二份重试"，且注释写明根因与越权边界（写操作绝不降级到系统账号）。**这比 VRCX 多数测试更贴近真实故障。**

### 应补的缺口（借鉴 VRCX 的 `__tests__` 思路）
1. **`processBulk` / 分页逻辑单测**：造 mock `fn` 返回 `{json:[...], hasNext}`，断言翻页终止、N 上限生效。同步验证限流时 `done(false)`。
2. **`parseVrcLocation` 单测**（本项目 groups.js 已实现，借鉴 VRCX `$location`）：覆盖 `offline` / `private` / 带 `group()~region()` 三种，防止实例字符串格式变更崩名片。
3. **前端 coordinator 单测**：抽出 coordinator 后，对 `memberCoordinator` 做 mock vrc + 断言字段规整（如 `isVrcPlus` 仍按 `system_supporter` tag 判定）。
4. **错误分类单测**：断言 `VRC_RATE_LIMITED` 不会清 cookie、`VRC_2FA_REQUIRED` 走重新登录分支。

> 优先级：P1（测试跟在 P0 错误分类之后，先改代码再补测）。

---

## 7. 落地优先级汇总

| 优先级 | 项 | 解决的真实问题 | 工作量 |
|---|---|---|---|
| **P0** | 错误语义枚举 `VrcApiError` + 前端按 code 分支 + 限流静默 | 限流雪崩 / cookie 误清 / 2FA 当过期 | 中 |
| **P1** | 限流感知退避（schedule 指数退避）+ GET 去重合并 + 测试补缺口 | 被 VRChat 限流后越刷越糟 / 连点狂打 API | 中 |
| **P1** | `processBulk` 抽公共分页服务 | schedule 分批逻辑重复、难维护 | 小 |
| **P2** | 前端 coordinator/store 分层、跨 tab 函数收口 `window.JT` | 扁平模块过大、TAB_MODULES 脆弱依赖 | 大（增量） |
| **P2** | 配置/魔法数字外置 `server/config.js`、状态机单点 | 阈值硬编码、两处写翻转规则风险 | 小 |
| **P3** | 命名规范（动词前缀 + 渲染三词法 + 常量文件化） | 新人上手成本、重复定义 | 小（写约定） |

> 注：缓存分层、后台权限、cookie 降级测试这三项**本项目已优于 VRCX**，无需改，文档仅作对照记录。

---

## 8. 参考索引
- VRCX: `src/services/request.js`（`$throw` / `shouldIgnoreError` / `failedGetRequests` / `processBulk`）
- VRCX: `src/coordinators/userCoordinator.js`、`cacheCoordinator.js`
- 本项目: `server/vrc.js`（`vrchatRequest` 已分状态）、`server/utils.js`（`sendError`/`ErrorCodes`）、`server/cache_service.js`（分层范本）、`server/__tests__/vrc-cookie-fallback.test.js`（行为测试范本）
- 关联文档: `15-VRCX接口调度借鉴与改进方案.md`（P0 错误分类在此已立项，本文补结构/测试维度）
