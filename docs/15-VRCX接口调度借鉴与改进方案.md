# 15. VRCX 接口调度借鉴与改进方案

> 研究对象：`D:\phpstudy_pro\WWW\VRCX-master`（VRCX 开源项目）
> 目标：借鉴其接口调度、外部 API 封装与错误处理设计，改进本项目的 VRChat API 调用层。
> 关联代码：本项目 `server/vrc.js`、`server/routes/groups.js`、`server/routes/collections.js`、`server/schedule.js`。

---

## 1. VRCX 接口调度的分层架构

VRCX 的接口调用是一个清晰的四层结构，每层职责单一、向下依赖：

```
┌─────────────────────────────────────────────────────────────┐
│ ① Dotnet/WebApi.cs       最底层 HTTP 执行器（C#）              │
│   统一 Execute(authCookie, twoFactor, method, path, json)      │
│   - 单例 HttpClient                                            │
│   - 自动注入 apiKey / AuthCookie / TwoFactorAuth              │
│   - WebRequestException 统一捕获 → { status, message }        │
│   - SetCookies/GetCookies 维护 Cookie Jar                     │
└─────────────────────────────────────────────────────────────┘
                          ↓ (进程内 IPC)
┌─────────────────────────────────────────────────────────────┐
│ ② src/services/webapi.js    JS↔C# 桥                          │
│   把 Execute 返回的元组 (Item1=status, Item2=data)            │
│   封装为 { status, data } 的 Promise                           │
│   - status === -1 → 抛本地异常（网络/解析错误）               │
│   - status ≥ 0    → 正常 HTTP 状态码（不抛，交由上层判断）    │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ ③ src/api/* + src/services/request.js   业务契约层           │
│   request() 统一入口：                                        │
│   - URL 构造 + query 参数标准化（queryString.stringify）      │
│   - 注入 apiKey（remoteConfig）/ language / API_KEY 头        │
│   - **429 限流识别**：解析 Retry-After → ApiError(url,429)   │
│   - **重试策略**：MAX_RETRIES 仅对 500/504 重试              │
│   - **超时熔断**：requestTimeout                              │
│   api/* 只描述端点契约（如 user.js 的 getUser/getFriends）    │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ ④ src/queries/*    TanStack Query 缓存与实时层               │
│   - entityQueryPolicies：按实体类型设 staleTime/gcTime/retry │
│   - fetchWithEntityPolicy：缓存命中 / 穿透判定               │
│   - patchQueryDataWithRecency：按时间戳比较新旧，旧不覆盖新  │
│   - WS 事件 → patchUserFromEvent 等实时增量更新              │
└─────────────────────────────────────────────────────────────┘
```

**关键设计要点：**
- **单一执行入口**：所有 HTTP 都在 `WebApi.Execute` / JS 侧 `request()` 走，没有散落的 `fetch`。
- **错误分类明确**：本地错误（-1）与 HTTP 错误（状态码）分离；429 被显式识别为限流。
- **缓存按实体策略化**：不是一刀切 TTL，而是"用户多久新鲜、世界更久"。
- **新旧数据防倒灌**：`patchQueryDataWithRecency` 用时间戳守门，避免慢响应覆盖快响应。

---

## 2. 本项目现状

本项目的 VRChat API 封装集中在 `server/vrc.js` 的 `vrchatRequest()`：

- ✅ 已是**统一封装入口**（超时控制、`apiKey` 注入、cookie 合并、ID 白名单 `sanitizeVrcId`、响应头 `set-cookie` 解析回写 cookie jar）。
- ✅ 与 VRCX 的 `WebApi.cs` / `webapi.js` 思路高度一致，**底层不需要重写**。
- ⚠️ 调用方（`groups.js`、`collections.js`、`schedule.js`）直接 `require('../vrc')` 调具体函数，是**扁平工具箱模式**，缺少中间缓存层（`queries`）。
- ⚠️ **错误处理偏粗**：`vrchatRequest` 抛出的异常没有统一的 `status/code/retryable` 分类，`429` 限流未被识别。

### 2.1 VRChat API 封装层逐条对照：`server/vrc.js` ↔ VRCX `WebApi.cs`

这是接口调度的最底层，也是之前分析里"含糊带过"的核心。下面把两边**同名职责**逐条对齐，明确"哪里一致、哪里缺"。

| 职责 | VRCX `Dotnet/WebApi.cs` | 本项目 `server/vrc.js` | 结论 |
|------|--------------------------|--------------------------|------|
| **统一执行入口** | `WebApi.Execute(authCookie, twoFactor, method, path, json)` 是所有 HTTP 的唯一出口 | `vrchatRequest(method, endpoint, body, cookie, opts)` 是 VRChat 调用唯一出口 | ✅ 一致 |
| **底层 HTTP 客户端** | C# 单例 `HttpClient`，连接复用 | Node `https` 直接请求（每调用一次建连，无 keep-alive 连接池） | ⚠️ 缺：无持久连接/连接池，高频轮询（schedule 30s 全员）下开销更大 |
| **认证注入** | `apiKey` 查询参数 + `AuthCookie` Cookie + `TwoFactorAuth` Cookie | `apiKey` 查询参数 + 传入的 `cookie` 字符串（来自 DB 用户绑定） | ✅ 一致（本项目 2FA 已并入 cookie 串） |
| **Cookie 生命周期管理** | `SetCookies`/`GetCookies` 维护进程内 **Cookie Jar**，自动随响应更新 | 调用方从 DB 取 cookie → 传入；响应 `set-cookie` 被解析但**只在个别函数回写**，无统一 jar | ⚠️ 缺：没有"自动把响应新 cookie 合并回用户绑定"的统一机制，依赖各调用处手动处理 |
| **参数/端点安全** | 路径由 C# 强类型拼接，ID 来自本地已知对象 | `sanitizeVrcId()` 白名单校验 ID，防注入/越权 | ✅ 一致（本项目反而更谨慎） |
| **超时控制** | C# `HttpClient.Timeout` | `vrchatRequest` 自带超时（AbortController / setTimeout） | ✅ 一致 |
| **错误分类** | `WebRequestException` 捕获 → 返回 `{ status, message }`；JS 侧 `status === -1` 显式区分本地错误 | 抛普通 `Error`，调用方需自己读 `e.status`/字符串判断；**429 未被识别为限流** | ❌ 缺：无统一 `VrcApiError{status,code,retryable}` |
| **限流处理** | JS 侧 `request.js` 识别 429 → `ApiError(url, 429)`，解析 `Retry-After` | 无；429 等同普通失败 | ❌ 缺 |
| **重试策略** | `MAX_RETRIES` 仅对 `500/504` 重试；超时熔断 `requestTimeout` | 无内置重试 | ❌ 缺 |
| **端点契约封装** | `src/api/*.js` 描述端点（getUser/getFriends/getCurrentUser…），上层不直接拼 URL | 导出 `vrchatGetUser`/`vrchatGetAvatar`/`vrchatGetGroup`/`vrchatSetAvatar`/`vrchatCloneAvatar` 等具名函数 | ✅ 一致（本项目同样把端点收敛成具名函数） |
| **缓存层** | `src/queries/*` 按实体 TTL + 时间戳防倒灌 | 无进程内缓存 | ❌ 缺（见改进 3） |
| **实时增量** | WS 事件 → `patchUserFromEvent` 等增量更新缓存 | 本项目靠 `schedule.js` 定时全量刷新 + `ws_service` 广播 `group:roster_update` | ⚠️ 部分：本项目用定时全量而非事件增量 |

**一句话总结差距**：本项目的 `vrc.js` 在"统一入口 / 认证 / 超时 / ID 白名单 / 端点收敛"上已经对齐 VRCX 的 `WebApi.cs`，**真正缺席的四块**是：① 统一 `VrcApiError` 错误分类（尤其 429），② 限流感知重试，③ 进程内缓存，④ 连接池/统一 cookie jar。前三点即第 3 节的改进 1/2/3；第④点（连接池 + 自动 cookie 回写）可作为后续更深层的重构项，优先级低于前三点。

### 现有痛点（第 9 篇日志已记录）
`server/routes/groups.js` 的 `vrcWithFallback` 在捕获异常时，会把"任何 VRChat 调用失败"都当作"cookie 失效（401）"处理，从而**误清用户绑定 cookie**。当 VRChat 临时 **429 限流**或 5xx 抖动时，也会触发清绑定 —— 这是已观察到的线上问题。

---

### 2.2 VRCX 接口逐模块清单（已全部查阅 `src/api/*` 共 19 个模块）

下表逐接口列出 VRCX 每个 api 模块调用的 VRChat 端点、关键调度行为，以及**本项目（`server/vrc.js` + 各处调用）是否已覆盖 / 可借鉴**。

> 统一约定：所有模块都只通过 `src/services/request.js` 的 `request()` 发请求（即 2.1 节的统一入口），`request()` 内部负责 URL/query 标准化、认证注入、429/404/403 处理、`$throw`。

| 模块 | 主要端点（VRChat API） | 关键调度/错误处理行为 | 本项目覆盖情况 |
|------|------------------------|------------------------|----------------|
| **auth.js** | `auth/twofactorauth/otp/verify`、`.../totp/verify`、`.../emailotp/verify`、`config` | 仅 2FA 校验 + 拉取 `config`；登录态由 `watchState` 守卫 | ⚠️ 未做 2FA 流程（本项目 cookie 已含 2FA，无需） |
| **user.js** | `users/{id}`（GET）、`friends`（GET，分页 `n/offset`）、`auth/user`（当前用户）、`user/{id}/inventory/{invId}` | `getCurrentUser` 失败触发自动登录；好友分页 + `processBulk` 拉全量 | ✅ 已覆盖 `getUser`/`getCurrentUser`/好友思路（`schedule.js` 分批） |
| **friend.js** | `auth/user/friends`（GET 列表）、`auth/user/friendRequests`（GET）、`user/{id}/friendStatus`（GET） | 好友列表 + 好友请求 + 单向好友状态查询 | ⚠️ 仅用了好友在线状态，未调 `friendStatus` 单向查询 |
| **avatar.js** | `avatars/{id}`（GET）、`avatars`（GET 列表）、`auth/user/avatars/{id}/select`（PUT 切换）、`avatars/{id}/favorite`（PUT/DELETE）、`users/{id}/avatar`(非好友)、`avatars/{id}/publications` | **切换模型走 `select`**（非 `/auth/user/avatar`）；收藏/取消收藏；非好友取穿戴模型；公开模型出版物 | ✅ 已基本覆盖（含 `set-avatar` 先克隆再切换，见 conversation 记录） |
| **favorite.js** | `auth/user/favorites`（GET/POST）、`favorites/{id}`（DELETE）、`favorites?id=`、`auth/user/favoriteGroups`（GET/POST）、`favoriteGroups/{id}`（PUT/DELETE） | 收藏项 + 收藏分组（world/avatar/friend/group 四类）独立管理 | ⚠️ 本项目未实现"收藏分组"概念 |
| **group.js** | `groups`、`groups/{id}`、`groups/{id}/members`、`groups/{id}/roles`、`groups/{id}/announcements`、`groups/{id}/auditLogs` | 群、成员、角色、公告、审计日志；列表走 `processBulk` | ✅ 已覆盖群成员/角色/公告（`groups.js`） |
| **instance.js** | `instances/{worldId:instanceId}`（GET）、`instances`（POST 创建）、`.../shortName`、`instances/s/{shortName}`、`invite/myself/to/...` | 实例查询/短名/自邀请；`instanceStore.applyInstance` 解析 location | ✅ 已借鉴 `parseVrcLocation` 等价解析 |
| **inventory.js** | `inventory/{id}`、`inventory`、`user/{userId}/inventory/{invId}`、`inventory/{id}/consume`、`inventory/template/{id}`、`reward/redeem`、`inventory/global` | **克隆（`cloning/pedestal`）在 coordinator 里**、消费/装备/归档；写后 `refetchActiveInventoryQueries` | ✅ 已覆盖克隆（collections.js 借鉴 VRCX `cloning/pedestal`） |
| **world.js** | `worlds/{id}`、`worlds/{option}`、`worlds/{id}/publish`、`file/image`（上传） | 世界查询/发布/取消；写后 `patchAndRefetchActiveQuery` | ⚠️ 本项目仅缓存 worldName，未做世界发布类操作 |
| **notification.js** | `auth/user/notifications`、`notifications`、`invite/{userId}`、`requestInvite/{userId}`、`invite/{id}/response`、`.../accept`/`hide`/`see` | **邀请/请求加入/邀请响应**全链路；好友请求接受；通知已读/隐藏 | ❌ 未实现邀请/通知系统 |
| **playerModeration.js** | `auth/user/playermoderations`（GET/POST）、`auth/user/unplayermoderate`（PUT） | 拉黑/解除拉黑（block/mute 等） | ✅ 已部分落地（F-18，09-06）：`moderations.js` resolve 通过时 block+mute 远程写入、revert 撤销（unblock/unmute）；仅审核队列触发，未做通用列表查询 |
| **avatarModeration.js** | `auth/user/avatarmoderations`（GET/POST/DELETE） | 模型屏蔽/隐藏 | ❌ 未实现（VRChat 无「隐藏他人头像」官方写接口，F-18 avatar 类审核仅站内本地落库） |
| **misc.js** | `file/{id}`、`userNotes`（POST）、`feedback/{userId}/user`（举报）、`analysis/...`、`economy/balance`、`instances/{location}`（关闭）、`users/{id}/{world}/persist`、`users/{id}/badges/{badgeId}`、`visits`、`users/{id}/boop` | **杂项聚合**：文件、备注、举报、信用、关房、持久数据、徽章、访问量、Boop | ⚠️ 仅用了 `file/{id}`（头像代理），其余未做 |
| **inviteMessages.js** | `message/{userId}/{type}`（GET）、`message/{userId}/{type}/{slot}`（PUT） | 邀请消息模板读写（按类型+槽位） | ❌ 未实现 |
| **cosmetics.js** | `cosmetics/index/profileEffect`、`cosmetics/index/iconFrame` | 资料页特效 / 头像框索引 | ❌ 未实现（名片未用特效/头像框） |
| **prop.js** | `props/{id}` | 道具查询 | ❌ 未实现 |
| **vrcPlusIcon.js** | `files`（GET）、`file/{id}`（DELETE）、`file/image`（上传 icon） | VRC+ 图标画廊上传/删除 | ❌ 未实现 |
| **vrcPlusImage.js** | `file/image`（上传 gallery/sticker/emoji）、`prints/...`、`prints/user/{id}` | VRC+ 画廊/贴纸/表情/照片打印 | ❌ 未实现 |
| **image.js** | `file/{id}`、`file/{id}/{ver}/file/start\|finish`、`file/{id}/{ver}/signature/start\|finish`、`avatars/{id}`、`worlds/{id}` | **大文件分片上传**：头像/世界图的多步 start→finish（file + signature） | ❌ 未实现（本项目无需上传） |
| **queryRequest.js** | （聚合入口，转发到各模块） | 把多模块组合成一次性查询；`failedGetRequests` 记录近期失败 GET 防抖 | ✅ 思路已在 `request.js` 体现 |

**调度器 `src/services/request.js` 的核心机制（全模块共用，最值得借鉴）：**
1. **请求去重**：GET 请求 10s 内同 URL 合并为同一 Promise（`pendingGetRequests`）—— 等价于我们的缓存预取。
2. **失败 GET 熔断**：404/403 的 GET 端点记到 `failedGetRequests`，15min 内不再重试（`bailing request`）—— 避免对"不存在资源"反复打 API。
3. **`$throw(code, error, endpoint)`**：统一抛错，错误对象带 `e.status`/`e.endpoint`，并按 `shouldIgnoreError` 决定要不要弹 toast（静默忽略已知可忽略错误，如 `users/x`、`instances/x`、`/mutuals` 的 403/404/-1）。
4. **429 特判**：`/instances/groups` 的 429 把下次群实例刷新推迟到 120s；其余 429 抛 `ApiError`。
5. **`processBulk`**：通用分页全量拉取（offset 递增直到不足一页或达上限 N），被好友/群成员列表复用。

### 本项目"差距地图"（按是否需要借鉴排序）
- **已对齐**：用户/当前用户、好友在线、切换模型、克隆、群成员/角色/公告、invite/myself（自邀请可用）、文件/头像代理、实例解析。
- **可低风险借鉴**：`processBulk` 分页全量（我们手写分批）、`failedGetRequests` 熔断（避免对不存在的 avatarId/userId 反复请求）、`$throw`+`shouldIgnoreError` 静默策略（我们目前任何异常都可能触发 fallback 清 cookie）。
- **暂不需要**（群组社区站场景无关）：通知/邀请系统、玩家/模型 moderation、VRC+ 画廊、大文件分片上传、cosmetics/prop、备注/举报/Boop。

## 3. 借鉴改进方案（3 点增量改进，不改现有行为语义）

> 原则：只对 `server/vrc.js` 做增强，**不动前端、不动路由语义、不重写现有函数**。
> 每个改进都对应 VRCX 的某个具体设计。

### 改进 1：精细错误分类（对应 VRCX 的 `status=-1` 与 `ApiError(url,429)`）

**目标**：让上层能区分"cookie 真过期(401)"、"限流(429)"、"超时/网络(-1)"、"服务端抖动(5xx)"。

在 `vrchatRequest` 抛出的异常上附加结构化字段，定义一个 `VrcApiError`：

```js
class VrcApiError extends Error {
  constructor(message, { status, code, retryable = false, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'VrcApiError';
    this.status = status;      // HTTP 状态码或 0/-1
    this.code = code;          // 'TIMEOUT' | 'RATE_LIMIT' | 'VRC_4XX' | 'VRC_5XX' | 'NETWORK'
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}
```

`vrchatRequest` 在各类失败时构造对应 `code`：
- 重试耗尽 / 超时 → `code: 'TIMEOUT'`（`retryable: true`）
- HTTP 429 → `code: 'RATE_LIMIT'`（`retryable: true`，解析 `Retry-After` 写入 `retryAfter`）
- HTTP 4xx（非 429）→ `code: 'VRC_4XX'`（401 才视为 cookie 失效）
- HTTP 5xx → `code: 'VRC_5XX'`（`retryable: true`）

**收益**：`vrcWithFallback` 改为只在该错误 `code === 'VRC_4XX' && status === 401` 时才清绑定，429/5xx/超时一律走 fallback 旧数据，**根治误清 cookie**。

### 改进 2：限流感知重试（对应 VRCX 的 `MAX_RETRIES` 仅 500/504 + `Retry-After`）

**目标**：减少 VRChat 抖动导致的失败，且不被限流拖垮。

在 `vrchatRequest` 内部加一层轻量重试：
- 仅对 `500 / 502 / 503 / 504` 自动重试 **1 次**（参考 VRCX `MAX_RETRIES`）。
- 遇到 `429`：**不立即重试**，读取响应头 `Retry-After`（秒），若 ≤ 阈值则等待后重试 1 次；否则直接抛 `RATE_LIMIT`。
- 重试间隔用 `Retry-After` 或固定短退避（如 500ms），避免雪崩。

**收益**：`schedule.js` 的 30s 全员刷新、`groups.js` 的批量查询在 VRChat 抖动时更稳。

### 改进 3：轻量进程内缓存层 `vrcCache`（对应 VRCX 的 `entityQueryPolicies` + `patchQueryDataWithRecency`）

**目标**：降低重复请求频率、缓解限流，并防止慢响应覆盖快响应。

在 `vrc.js` 加一个极简 TTL 缓存：
- key = `method + normalizedEndpoint`（GET 幂等请求才缓存）。
- 按实体类型设 `staleTime`：`user`/`group`/`world` 等已知类型各设不同新鲜度（借鉴 `entityQueryPolicies`）。
- 写入时携带 `fetchedAt` 时间戳；命中缓存时若 `now - fetchedAt < staleTime` 直接返回，否则回源并**用时间戳比较新旧**（旧响应不覆盖新响应，对应 `patchQueryDataWithRecency`）。
- **写操作（`set-avatar`/`clone`/`setStatus`）绝不走缓存**。

**收益**：列表页/名片重复打开不再反复打 VRChat API，从源头降低 429 概率。

---

## 4. 落地优先级建议（原第 4 节）

| 优先级 | 改进 | 风险 | 价值 | 说明 |
|--------|------|------|------|------|
| P0 | 改进 1（精细错误分类） | 低 | 高 | 直接修复"误清 cookie"线上问题，且是改进 2/3 的前置 |
| P1 | 改进 2（限流感知重试） | 低 | 中 | 提升 `schedule.js` 同步稳定性 |
| P2 | 改进 3（vrcCache） | 中 | 中 | 降频，但需谨慎处理缓存失效与隐私字段 |

**建议实施顺序**：先落地改进 1（含 `VrcApiError`），同步改造 `groups.js` 的 `vrcWithFallback` 判定；再视稳定性需求推进改进 2；改进 3 作为后续优化。

---

## 5. 参考文件索引（VRCX）

- `Dotnet/WebApi.cs` —— 底层 HTTP 执行器与异常转义
- `src/services/webapi.js` —— JS↔C# 桥，元组 → `{status,data}`
- `src/api/index.js` —— API 模块聚合入口
- `src/api/user.js` —— 端点契约示例（getUser / getFriends）
- `src/services/request.js` —— 统一 `request()`：429 限流识别、MAX_RETRIES、requestTimeout
- `src/queries/index.js` —— 缓存策略装配
- `src/queries/policies.js` —— `entityQueryPolicies`（按实体 staleTime/gcTime/retry）
- `src/queries/entityCache.js` —— `fetchWithEntityPolicy` / `patchQueryDataWithRecency`
- `src/coordinators/userFavoriteAvatars.js` —— coordinator 调用 api → cache 的范例
