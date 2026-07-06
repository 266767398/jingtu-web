# 境途同游 VRChat 登录/绑定流程审计报告

> 审计日期: 2026-06-21 | 项目版本: V5.2

---

## 1. VRChat API Key 配置

### 当前配置

| 位置 | 值 | 来源 |
|------|-----|------|
| `.env` 第17行 | `VRC_API_KEY=JlE5Jldo5Jibnk5O5hTx6XVqsJu4WJ26` | 环境变量 |
| `server/vrc.js` 第9行 | `const VRC_API_KEY = process.env.VRC_API_KEY \|\| '';` | 从 env 读取 |

### 评价

- 代码正确地使用 `process.env.VRC_API_KEY` 从环境变量读取，未硬编码在源码中。
- `.env` 文件中的值是 VRChat SDK 公开的 API Key (`JlE5Jldo5Jibnk5O5hTx6XVqsJu4WJ26`)，在 VRChat 社区中广为流传，并非真正的"机密"。这是 VRChat API 的工作方式 — 所有客户端都使用同一个 Key。
- **问题**: `.env` 被检入版本控制（位于项目根目录），包含数据库密码、会话密钥、加密密钥等敏感信息。应添加 `.env` 到 `.gitignore`。
- **次要**: `server/server.js` 第40行重复定义了 `const VRC_API = 'https://api.vrchat.cloud/api/1'`，与 `vrc.js` 中的定义重复。应导入而非重复声明。

---

## 2. 2FA 流程完成度

### 系统级 VRChat 登录 (`/api/login` + `/api/2fa` in `server.js`)

**路径**: `server.js:229-278`

**流程**:
1. `POST /api/login` → `vrchatBasicLogin()` 调用 → 若 `needs2fa`，将临时 cookie 和 user 存入 `req.session`（`_vrcLoginCookie`, `_vrcLoginUser`），返回 `need2fa: true`。
2. `POST /api/2fa` → 先尝试 TOTP 验证，失败则尝试 email OTP → 成功后将完整状态写入 `authState`（内存 + `session.json` 磁盘持久化）。

**结论**: ✅ **系统级 2FA 流程完整**。临时状态正确存入 session，完成后清理临时变量。

### 用户级 VRChat 登录 (`/vrchat-login` + `/vrchat-2fa` in `server/routes/auth.js`)

**路径**: `server/routes/auth.js:153-312`

**流程 — 已绑定用户**:
1. `POST /vrchat-login` 查询 `WHERE vrchat_name = ?` → 找到绑定 → 调用 `vrchatBasicLogin()` → 若需要 2FA 且未传入 `code`，保存 `_vrchatTempCookie`, `_vrchatTempUser`, `_vrchatBoundUserId` 到 session → 返回 `need2fa: true`。
2. `POST /vrchat-2fa` → 验证 2FA → 更新 session → 登录成功。

**流程 — 未绑定用户**:
1. `POST /vrchat-login` 查询不到绑定 → 立即返回 `needBind: true`（第165行），不会调用 VRChat API。
2. 用户需要通过 `/vrchat-bind` 绑定，或通过应用内已登录的系统账号搜索绑定。

**结论**: ⚠️ **用户级 2FA 流程基本完整，但有一条不可达代码路径**。

---

## 3. 🐛 发现的 Bug

### Bug 1: `/vrchat-2fa` 中未绑定用户会被提前拒绝

**位置**: `server/routes/auth.js:284-286`

```js
if (!boundUserId) return res.status(400).json({ error: '会话中未找到绑定信息，请重新登录' });
```

**问题**: 第284行要求 `_vrchatBoundUserId`（通过 session 获取），但该值仅在 `/vrchat-login` 中已绑定用户且需要 2FA 时才会设置（第186行）。未绑定用户通过其他路径进入 `submitVrc2fa()` 时，`boundUserId` 为 `undefined`，直接返回错误，无法到达第310行的 `needBind: true` 分支。

**影响**: 前端的 `submitVrc2fa()` (public/js/vrc.js:71) 预期收到 `data.needBind`，但实际上会因为后端提前拒绝而走到 `else` 分支显示"验证码错误"。

**修复建议**: 将第284-286行移到第300行查询之后，或允许 `boundUserId` 为空时继续流程。

### Bug 2: `vrchat-login` 使用 `vrchat_name`（显示名）而非 `vrchat_id` 匹配用户

**位置**: `server/routes/auth.js:159-161`

```sql
WHERE vrchat_name = ? AND vrchat_name IS NOT NULL AND deleted_at IS NULL
```

**问题**: VRChat 显示名可以随时更改。如果绑定后用户改了显示名，下次登录时用新名字查询不到绑定记录，会返回 `needBind: true`（即"请先绑定"），用户无法通过 VRChat 登录。

**影响**: 任何修改过 VRChat 显示名的用户都无法通过 VRChat 登录。

**修复建议**: 增加 `vrchat_id` 查询，或同时匹配 `vrc_id` 和 `vrchat_name`。前端登录时可通过系统已登录账号的 VRChat API 先查询当前用户信息再匹配绑定。

### Bug 3: `confirmVrcBind()` 客户端总是假设验证成功

**位置**: `public/js/profile.js:207`

```js
currentUser.vrchatVerified = true;
```

**问题**: 绑定成功后，客户端无条件将 `vrchatVerified` 设为 `true`。但服务端 `/vrchat-bind`（auth.js:244-249）尝试查群组成员来判断验证状态，且查找失败时静默吞异常（`catch(e) {}`）。客户端忽略了服务端返回的 `user.vrchatVerified` 字段。

**影响**: 即使用户不在群组中，前端也会显示"已验证"状态。刷新页面后才会纠正。

**修复建议**: 应从服务端返回的 `data.user.vrchatVerified` 读取：

```js
currentUser.vrchatVerified = data.user?.vrchatVerified ?? true;
```

### Bug 4: `doVrcLogin()` 读取服务器未返回的 `csrfToken`

**位置**: `public/js/auth.js:112`

```js
csrfToken = data.csrfToken || null;
```

**问题**: `/vrchat-login` 服务端响应（auth.js:224）不包含 `csrfToken` 字段。`data.csrfToken` 永远是 `undefined`，所以 `csrfToken` 会被设为 `null`。下次 `api()` 调用会触发 `ensureCsrf()` 重新获取 token，功能上无碍但浪费了一次请求。

**影响**: 轻微 — 每次 VRChat 登录后第一个 API 调用会额外触发一次 `/api/csrf-token` 请求。

---

## 4. 安全相关问题

### 严重: 明文密码存储在 localStorage

**位置**: `public/js/auth.js:34`

```js
if (remember) localStorage.setItem('jingtu_remember', JSON.stringify({ loginId, password }));
```

**问题**: "记住我"功能将用户的明文密码存储在浏览器 localStorage 中。任何 XSS 攻击或能访问开发者工具的本地攻击者都可以窃取密码。

**影响**: 高风险。密码以明文形式永久存储在客户端。

**修复建议**: (1) 移除密码存储，改用 session cookie 自动恢复；或 (2) 使用 httpOnly cookie 配合 token 机制，避免明文密码出现在客户端存储中。

### 中: `.env` 文件包含敏感凭据

**问题**: `.env` 文件包含数据库密码 (`gWfOPxIROLrt#bSM`)、会话密钥和加密密钥。如果该文件被检入 Git 仓库或暴露在 web 可访问目录，这些凭据将被泄露。

### 中: API Key 通过 URL 查询参数传递

**问题**: 所有 VRChat API 调用都使用 `?apiKey=...` 作为查询参数（VRChat API 的惯例）。这会导致 API Key 出现在:
- Web 服务器访问日志
- 反向代理日志
- 浏览器网络面板（前端直接调用时）
- Referer 头（某些配置下）

这是 VRChat API 的设计决策，项目层面难以改变，但值得注意。

### 低: CSRF Token 一次性使用导致重试失败

**位置**: `server/server.js:174`

```js
csrfTokens.delete(token);
```

**问题**: CSRF token 使用一次即删除。如果请求发送后服务器端验证通过但客户端网络中断（未收到响应），用户重试时旧 token 已失效，需要重新获取。`api()` 函数每次调用 `ensureCsrf()`，所以正常流程不会出问题，但快速连续重试可能遇到"CSRF token 无效"错误。

---

## 5. 绑定流程分析

### 绑定流程图

```
用户输入 VRChat 用户名 → lookupVRChat()  → /api/vrc/lookup（系统账号查询）
     ↓
显示搜索结果 → confirmVrcBind(id, name, url)  → /api/auth/vrchat-bind
     ↓
服务端: 检查重绑冲突 → 检查是否已绑定 → 写入 DB → 查群组验证 → 返回
     ↓
前端: 更新 currentUser (含 Bug 3 的已验证状态问题)
```

### 绑定流程中的问题

1. **无绑定密码验证**: 绑定流程 (`/vrchat-bind`) 不要求用户提供 VRChat 密码。这本身是合理的设计（通过系统已登录的 VRChat 账号进行搜索验证），但依赖系统 VRChat 账号必须在线且持有有效 cookie。

2. **系统账号过期处理**: 如果系统 VRChat 账号 cookie 过期（authState 中的 cookie 失效），`/api/vrc/lookup` 会返回 401，前端会显示"系统 VRChat 账号未登录"。但系统层面没有自动续期或健康检查机制来及时检测 cookie 失效。

3. **解绑后群组验证状态**: 解绑（`/vrchat-unbind`）将 `vrchat_verified` 设为 0，但若用户后续重新绑定同一 VRChat 账号，不会自动从群组验证状态恢复。

---

## 6. 其他发现

### 重复常量定义

`server/server.js:40` 定义了 `VRC_API`，但 `server/vrc.js:8` 已有相同定义。应通过 `require('../vrc').VRC_API` 引用。

### 登录路由无速率限制

`server/server.js:163` 中 `/vrchat-login` 和 `/vrchat-2fa` 被列入 CSRF 豁免路径，但它们没有被 `authLimiter`（第133-140行，15次/分钟）保护。`authLimiter` 似乎没有被应用到任何路由上（只是定义而未使用）。

### 会话 Cookie 无 Secure 标志

`server/server.js:109`: `secure: false` — 在生产环境中应设为 `true`，配合 HTTPS 使用。

---

## 7. 总结与修复优先级

| 优先级 | 问题 | 位置 |
|--------|------|------|
| 🔴 **高** | 明文密码存 localStorage | `public/js/auth.js:34` |
| 🔴 **高** | 2FA 未绑定用户路径中断 | `auth.js:284-286` |
| 🟡 **中** | 使用显示名而非 ID 匹配登录 | `auth.js:159-161` |
| 🟡 **中** | 客户端绑定验证状态覆盖 | `profile.js:207` |
| 🟡 **中** | `.env` 含敏感凭据 | 项目根目录 |
| 🟢 **低** | 读取未返回的 csrfToken | `auth.js:112` |
| 🟢 **低** | `VRC_API` 常量重复定义 | `server.js:40` |
| 🟢 **低** | `authLimiter` 未使用 | `server.js:133-140` |
| 🟢 **低** | Session Cookie 无 Secure 标志 | `server.js:109` |
