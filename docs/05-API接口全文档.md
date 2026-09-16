# 境途同游 API 接口全文档

> 版本：V7.10  
> 最后审计：2026-08-25  
> 事实源：`server/server.js`、`server/routes/*.js` 与 `public/js/**/*.js`。本文件描述当前实现，不描述预期设计。

## 1. 全局约定

### 1.1 基础信息

- 默认地址：`http://localhost:3456`；`PORT` 可覆盖端口。
- API 通常以 `/api` 开头；`/sitemap.xml`、`/robots.txt`、`/api-docs`、`/api-docs.json` 例外。
- JSON 请求体全局上限默认 20 MB（非上传 POST/PUT 5 MB、上传类路径 550 MB 安全闸）；该阈值自 2026-08-16 起可由超级管理员在后台「系统设置 → 🛡️ 全局请求限制」调整。上传路由另有 Multer 上限。
- Session Cookie 为 `connect.sid`，7 天、rolling、HttpOnly、SameSite=Lax；生产环境按配置启用 Secure。
- 所有 `/api/*` 请求先经过账户存在/封禁校验；已登录账户被删除或封禁时返回 `401 {error,code:"ACCOUNT_DISABLED"}`。
- 响应并未统一封装：可能是 `{success:true}`、`{ok:true}`、业务对象、裸数组、文件、重定向或 `{error,code?}`。

### 1.2 权限记号

| 记号 | 当前实现 |
|---|---|
| 公开 | 无登录中间件；但端点仍可能依赖 VRChat 系统 Cookie 或先前会话状态 |
| 登录 | `requireAuth`，要求 `req.session.userId` |
| 管理员 | `requireAdminCompat` 或等价检查，允许 `admin`、`super_admin` |
| 超管 | `requireRole('super_admin')` |
| 聊天登录 | `requireChatAuth`，要求已登录且不是 guest |
| VRC Cookie | 需要用户绑定 Cookie或系统 VRChat Cookie；缺失通常返回 401 |

### 1.3 CSRF

`GET /api/csrf-token` 返回 `{csrfToken}`。除 GET/HEAD/OPTIONS 外，请求通常必须携带同一 Session 下取得的 `x-csrf-token`；Token 有效 1 小时且可复用。

精确豁免路径为：`/api/vrchat-login`、`/api/init`、`/api/auth/login`、`/api/auth/init`、`/api/csrf-token`、`/api/auth/logout`、`/api/auth/vrchat-login`、`/api/auth/forgot-password`、`/api/auth/verify-reset-code`、`/api/auth/reset-password`、`/api/setup/test-db`、`/api/setup/test-email`、`/api/setup/save`、`/api/setup/state`、`/api/setup/reset`。

### 1.4 当前挂载

| 路由文件 | 挂载前缀 |
|---|---|
| `auth.js` | `/api/auth` |
| `profile.js` | `/api/profile` |
| `permission_groups.js` | `/api/permission-groups` |
| `posts.js` | `/api/posts` |
| `users.js` | `/api/users` |
| `checkin.js` | `/api/checkin` |
| `achievements.js` | `/api/achievements` |
| `user_like.js` | `/api/user-like` |
| `chat.js` | `/api/chat` |
| `live.js` | `/api/live` |
| `announcements.js` | `/api/announcements` |
| `events.js` | `/api/events` |
| `migration.js` | `/api/migration` |
| `share.js` | `/api/share` |
| `favorites.js` | `/api/favorites` |
| `event_teams.js` | `/api/event-teams` |
| `friends.js` | `/api/friends`（好友系统） |
| `follows.js` | `/api/follows`（关注/粉丝） |
| `avatar.js` | `/api/avatar`（默认头像 + VRChat 头像代理） |
| `collections.js` | `/api/collections`（V8.2 统一收藏馆） |
| `model-collections.js` | `/api/model-collections`（旧模型收藏，与 collections 并存） |
| `permissions.js` | `/api/permissions-view`（权限视图，见 §8.3） |
| `db-recover.js` | `/api/system`（db-status + db-recover，见 §14） |
| `vrc_system.js`、`groups.js`、`admin.js`、`album.js`、`notifications.js`、`logs.js`、`security.js`、`setup.js`、`health.js`、`config.js`、`backups.js`、`database.js`、`files.js`、`export.js`、`analytics.js`、`webhooks.js` | `/api` |
| `sitemap.js` | `/` |

> 注：`routes/` 共 43 个 `.js` 文件，上表为已挂载的 40 个；`journey.js`、`memory.js`、`capsules.js` 已定义路由但**未被挂载**（dead routes，详见 `09-已知问题与技术债务.md`）。新增模块（好友/关注/头像代理/收藏馆/系统恢复）的完整端点见文末 §14。

## 2. 入口文件直接端点

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/avatar/default` | 公开 | — | SVG 图像 |
| `GET /api/auth/check-init` | 公开 | — | `{hasUser}` |
| `GET /api/csrf-token` | 公开 | — | `{csrfToken}` |
| `GET /api/health` | 公开 | — | `{status:"ok",systemVrcLogin,systemVrcUser}` |
| `GET /api/stats` | 登录 | — | `{members,photos,events,posts,online,checkins,memberGrowth,eventSignRate,postActivity,recentUsers}` |
| `GET /api/public/stats` | 公开 | — | `{totalUsers,totalPhotos,totalEvents,totalPosts,onlineCount}`；查询失败时计数为 `"-"`/`0` |
| `GET /api/search` | 登录 | 查询 `q`（少于 2 字符返回空集合） | `{announcements,events,users}` |
| `POST /api/admin/group-image` | 管理员 | multipart：`image`，`type=image|avatar|banner|logo|cover`；10 MB | `{success:true,url}` |

## 3. 认证与系统 VRChat

### 3.1 `/api/auth`（`auth.js`）

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `GET /api/auth/init` | 公开 | — | `{needInit,message}` |
| `POST /api/auth/init` | 公开；仅无超管时 | `{loginId,password,displayName}` | `{success:true,user,message}` |
| `POST /api/auth/login` | 公开 | `{loginId,password}`；前端还发送未被后端使用的 `remember` | `{success:true,user}` |
| `POST /api/auth/register` | 公开（`registerLimiter`） | `{username(2-32字符),password,activationCode}` | `{success:true,user,message:'注册成功'}`；激活码问题 → 400 `{success:false,error,code:INVALID_FORMAT\|NOT_FOUND\|ALREADY_USED\|REVOKED\|EXPIRED\|WRITE_FAILED}`、用户名冲突 400 `code:USERNAME_TAKEN`、缺码 `code:ACTIVATION_CODE_REQUIRED`、并发锁超时 `code:LOCK_TIMEOUT`；激活码在文件锁内原子消耗，成功后重生成会话（自动登录）并写 `sys_oper_log`（类型「用户注册」） |
| `POST /api/auth/logout` | 公开 | — | `{success:true}` |
| `GET /api/auth/session` | 公开 | — | `{loggedIn,user}` |
| `POST /api/auth/change-password` | 登录 | `{oldPassword,newPassword}` | `{success:true,message}` |
| `POST /api/auth/vrchat-login` | 公开 | 首步 `{username,password}`；2FA `{code,loginToken}` | `{success:true,user,bindStatus}`、`{need2fa,loginToken,methods,message}` 或 401 `{needBind:true,...}` |
| `POST /api/auth/vrchat-2fa` | 公开 | `{code,loginToken}` | `{success:true,user}` |
| `POST /api/auth/vrchat-bind-verify` | 登录 | 首步 `{username,password}`；2FA `{code,bindToken}` | `{need2fa,bindToken,methods,message}` 或 `{success:true,user,message}` |
| `POST /api/auth/vrchat-unbind` | 登录 | — | `{success:true,user,message}` |
| `POST /api/auth/forgot-password` | 公开 | `{email}` | `{success:true,message,token?}` |
| `POST /api/auth/verify-reset-code` | 公开 | `{token,code}` | `{success:true,message}` |
| `POST /api/auth/reset-password` | 公开 | `{token,code,newPassword}` | `{success:true,message}` |

认证用户对象包含：`id,loginId,displayName,vrchatId,vrchatName,vrchatVerified,vrchatAvatarUrl,role,roleLabel,avatarType,avatarUrl`。

### 3.2 系统 VRChat（`vrc_system.js`，挂载 `/api`）

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `POST /api/login` | 管理员 | `{username,password}` | `{success:true,user}` 或 `{need2fa:true,methods}` |
| `POST /api/2fa` | 管理员；需先前登录状态 | `{code}` | `{success:true,user}` |
| `POST /api/logout` | 管理员 | — | `{success:true}` |

## 4. 用户与个人主页

### 4.1 用户（`users.js`，前缀 `/api/users`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/users/list` | 登录 | `page,pageSize` | `{users,total,page,pageSize}` |
| `GET /api/users` | 管理员 | `page,pageSize` | `{users,total,page,pageSize}` |
| `POST /api/users` | 超管 | `{loginId,password,displayName,role,email}` | `{success:true,id,message}` |
| `GET /api/users/birthdays` | 登录 | — | `{birthdays,todayCount,todayBirthdays}` |
| `GET /api/users/all/locations` | 登录 | — | `{markers,count}` |
| `GET /api/users/search` | 登录 | 查询 `q` | `{users,total}` |
| `GET /api/users/:id` | 管理员 | 路径 `id` | 脱敏用户对象 |
| `PUT /api/users/:id` | 管理员 | `{displayName,role}` | `{success:true,message}` |
| `DELETE /api/users/:id` | 管理员 | — | `{success:true,message}` |
| `POST /api/users/:id/reset-password` | 管理员 | `{newPassword}` | `{success:true,message}` |
| `GET /api/users/me/profile` | 登录 | — | 当前用户资料对象（不是 `{user:...}` 包装）；**2026-08-27 起响应新增 `banned`（布尔）字段**，前端据此在前端侧强制封禁约束（如活动报名） |
| `PUT /api/users/me/profile` | 登录且非 guest | `{displayName,qq,birthday,location,preferences,bio,motto,website,socialLinks}` | `{success:true,message}` |
| `POST /api/users/me/avatar` | 登录 | multipart `avatar`；5 MB | `{success:true,avatarUrl,thumbUrl,message}` |
| `POST /api/users/me/avatar-vrchat` | 登录 | — | `{success:true,avatarUrl,message}` |
| `DELETE /api/users/me/avatar` | 登录 | — | `{success:true,message}` |
| `PUT /api/users/me/location` | 登录 | `{lat,lng,location,visible}` | `{success:true,message}` |
| `GET /api/users/:id/card` | 登录 | — | 名片对象 `{id,loginId,displayName,...,evtCount,photoCount}` |
| `GET /api/users/me/events` | 登录 | — | `{events}` |
| `GET /api/users/:userId/events` | 登录 | — | `{events}` |
| `GET /api/users/:userId/photos` | 登录 | — | `{photos}` |
| `GET /api/users/tags/list` | 管理员 | — | `{tags}` |
| `GET /api/users/:userId/tags` | 管理员 | — | `{tags}` |
| `POST /api/users/:userId/tags` | 管理员 | `{name,color}` | `{success:true}` |
| `DELETE /api/users/:userId/tags/:tagId` | 管理员 | — | `{success:true}` |
| `GET /api/users/:userId/notes` | 登录 | — | `{note}` |
| `POST /api/users/:userId/notes` | 登录 | `{noteText}` | `{success:true}` |
| `DELETE /api/users/:userId/notes` | 登录 | — | `{success:true}` |
| `POST /api/users/me/change-password` | 登录 | `{oldPassword,newPassword}` | `{success:true,message}` |
| `POST /api/users/me/logout-all` | 登录 | — | `{success:true,message}` |

### 4.2 个人主页（`profile.js`，前缀 `/api/profile`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/profile/stats` | 登录 | — | `{posts,photos,events,comments}` |
| `GET /api/profile/export` | 登录 | — | JSON 附件 `{exportedAt,user,profile,posts,photos,events,comments}` |
| `DELETE /api/profile/delete` | 登录 | — | `{success:true,message}` 并销毁会话 |
| `GET /api/profile/:userId` | 公开 | — | `{user,profile,albums,videos}` |
| `POST /api/profile/update` | 登录 | `{motto,bio,coverImage,location,website,socialLinks,privacySettings}` | `{success:true,message}` |
| `GET /api/profile/:userId/albums` | 公开/隐私过滤 | — | `{albums}` |
| `POST /api/profile/albums` | 登录 | `{name,description,privacy}` | `{success:true,album}` |
| `PUT /api/profile/albums/:id` | 登录/所有者 | `{name,description,privacy,sort,coverPhoto}` | `{success:true,message}` |
| `PUT /api/profile/albums/:id/privacy` | 登录/所有者 | `{privacy}` | `{success:true,message}` |
| `DELETE /api/profile/albums/:id` | 登录/所有者 | — | `{success:true,message}` |
| `POST /api/profile/albums/:id/photos` | 登录/所有者 | multipart `photos`（最多 20 个），`description` | `{success:true,photos,photoCount}` |
| `GET /api/profile/albums/:id/photos` | 公开/隐私过滤 | — | `{albumId,photos}` |
| `DELETE /api/profile/photos/:id` | 登录/所有者 | — | `{success:true,message,photoCount}` |
| `POST /api/profile/videos` | 登录 | multipart `video`，及 `title,description,privacy` | `{success:true,video}` |
| `GET /api/profile/:userId/videos` | 公开/隐私过滤 | — | `{videos}` |
| `DELETE /api/profile/videos/:id` | 登录/所有者 | — | `{success:true,message}` |
| `PUT /api/profile/videos/:id/privacy` | 登录/所有者 | `{privacy}` | `{success:true,message}` |

## 5. 内容、活动与社交

### 5.1 动态（`posts.js`，前缀 `/api/posts`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/posts` | 公开/隐私过滤 | `page,pageSize,userId,type` | `{posts,total,page,pageSize,totalPages,hasMore}` |
| `GET /api/posts/search` | 公开 | `q` | `{posts,total}` |
| `GET /api/posts/:id` | 公开/隐私过滤 | — | 动态对象 |
| `POST /api/posts` | 登录 | multipart：`content,visibility,media`（最多 12 个） | `{success:true,post}` |
| `DELETE /api/posts/:id` | 作者或管理员 | — | `{success:true,message}` |
| `POST /api/posts/:id/like` | 登录 | 可选 `{content}` | `{liked,likeCount}` |
| `GET /api/posts/:id/comments` | 公开 | — | `{comments}` |
| `POST /api/posts/:id/comments` | 登录 | `{content,parentId}` | `{success:true,comment,commentCount}` |
| `DELETE /api/posts/:id/comments/:commentId` | 评论作者或管理员 | — | `{success:true,commentCount}` |
| `PUT /api/posts/:id/pin` | 管理员（先登录后内联校验） | `{pinned}` | `{success:true,pinned}` |

当前没有 `PUT /api/posts/:id` 编辑端点。

### 5.2 活动（`events.js`，前缀 `/api/events`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/events` | 公开 | `status,type,include_archived,page,pageSize` | `{events,total,page,pageSize,totalPages,hasMore}`；列表项含 `signedByMe`（当前登录用户是否已报名，未登录为 false） |
| `GET /api/events/birthday-parties` | 公开 | — | 活动数组 |
| `GET /api/events/export/ical` | 公开 | — | `text/calendar` |
| `GET /api/events/calendar` | 公开 | `year,month` | `{events}` |
| `GET /api/events/with-worlds` | 公开 | — | `{events}` |
| `GET /api/events/detail/:id` | 公开 | — | 活动对象，含 `signList,checkinList,signedByMe,ended` |
| `POST /api/events` | 登录 | `{title,place,eventTime|time,description|desc,maxSign,eventType,endsAt,visibility,worldId,worldName,worldImageUrl,instanceId,instanceType}` | `{success:true,id}` |
| `PUT /api/events/:id` | 管理员或创建者 | 同创建字段，可含 `isArchive`（仅管理员可改归档）；含输入校验（标题≤100 / 描述≤2000 / maxSign 0–9999 / 类型·可见性白名单 / `endsAt>eventTime`） | `{success:true}` |
| `DELETE /api/events/:id` | 管理员或创建者 | — | `{success:true}` |
| `POST /api/events/batch-delete` | 管理员或创建者（逐条校验） | `{ids:number[]}`（去重、≤100、正整数） | `{success:true,deleted}`；先全量预校验（越权/已结束/不存在任一不过即整体 403/409/404 拒绝，无部分删除） |
| `POST /api/events/batch-archive` | 管理员 | `{ids:number[]}`（去重、≤100、正整数） | `{success:true,archived}`；先全量存在性预校验（任一不存在即整体 404 拒绝），通过后事务内批量置 `is_archive=1` |
| `POST /api/events/sync-vrchat` | 管理员 | — | `{success:true,added,total}` |
| `POST /api/events/:id/sign` | 登录（手工校验） | — | `{success:true,alreadySigned?}` |
| `POST /api/events/:id/unsign` | 登录（手工校验） | — | `{success:true}` |
| `POST /api/events/:id/checkin` | 管理员 | — | `{success:true,message}` |
| `GET /api/events/:id/checkin-qr` | 管理员 | — | `{qrCodeUrl,eventId,title}` |
| `GET /api/events/:id/signs` | 公开 | — | 报名数组 |
| `GET /api/events/:id/comments` | 公开 | — | 评论数组 |
| `POST /api/events/:id/comments` | 登录（手工校验） | `{content}` | `{success:true}` |
| `GET /api/events/:id/photos` | 公开 | — | 照片数组 |
| `DELETE /api/events/:eventId/photos/:photoId` | 管理员 | — | `{success:true}` |
| `DELETE /api/events/:eventId/comments/:commentId` | 评论作者或管理员 | — | `{success:true}` |
| `POST /api/events/:id/archive` | 管理员 | — | `{success:true}` |
| `POST /api/events/:id/unarchive` | 管理员 | — | `{success:true}` |
| `GET /api/events/:id/google-calendar` | 公开 | — | 302 跳转至 Google Calendar |

### 5.3 活动队伍（`event_teams.js`，前缀 `/api/event-teams`）

全部需要登录。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/event-teams/:eventId` | — | `{teams}` |
| `POST /api/event-teams` | `{eventId,name,maxMembers}` | `{ok:true,teamId,name}` |
| `POST /api/event-teams/:teamId/join` | — | `{ok:true,alreadyJoined?}` |
| `POST /api/event-teams/:teamId/leave` | 队长不可退出 | `{ok:true}` |
| `DELETE /api/event-teams/:teamId` | 仅队长 | `{ok:true}` |
| `POST /api/event-teams/:teamId/kick/:userId` | 仅队长 | `{ok:true}` |

### 5.4 公告（`announcements.js`，前缀 `/api/announcements`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/announcements` | 公开；匿名列表仅 public | — | `{announcements}` |
| `GET /api/announcements/search` | 公开 | `q` | `{announcements,total}` |
| `GET /api/announcements/:id` | 公开；当前未校验 visibility | — | `{announcement}` |
| `POST /api/announcements` | 管理员 | `{title,content,pinned,visibility}` | `{success:true,id}` |
| `PUT /api/announcements/:id` | 管理员 | 同上 | `{success:true}` |
| `DELETE /api/announcements/:id` | 管理员 | — | `{success:true}` |
| `POST /api/announcements/:id/attachments` | 管理员 | JSON `{filename,url,fileSize,mimeType}`，不是文件上传 | `{success:true}` |
| `GET /api/announcements/:id/attachments` | 公开 | — | `{attachments}` |
| `DELETE /api/announcements/:id/attachments/:attachmentId` | 管理员 | — | `{success:true}` |
| `GET /api/announcements/:id/history` | 管理员 | — | `{history}` |
| `POST /api/announcements/:id/restore/:version` | 管理员 | — | `{success:true}` |

### 5.5 共享相册（`album.js`，挂载 `/api`）

相册写操作的用户识别允许普通 Session，也会回退到系统 VRChat 状态用户。

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/album/categories` | 公开 | — | `{categories}` |
| `POST /api/album/categories` | 管理员 | `{name}` | `{success:true,id}` |
| `DELETE /api/album/categories/:id` | 管理员 | — | `{success:true}` |
| `GET /api/album/photos` | 公开 | `page,cate,sort=newest|oldest|most_liked`；固定每页 40 | `{photos,hasMore}` |
| `POST /api/photos` | 登录/系统 VRC | `{photo_path,thumb_path,caption,eventId}` | `{success:true,id}` |
| `PUT /api/photos/:id` | 所有者或管理员 | `{caption}` | `{success:true}` |
| `DELETE /api/photos/:id` | 所有者或管理员 | — | `{success:true}` |
| `POST /api/photos/:id/like` | 登录/系统 VRC | — | `{success:true,likes}` |
| `DELETE /api/photos/:id/like` | 登录/系统 VRC | — | `{success:true,likes}` |
| `GET /api/photos/:id/comments` | 公开 | — | 评论数组 |
| `POST /api/photos/:id/comments` | 登录/系统 VRC | `{content}` | `{success:true}` |
| `DELETE /api/photos/:photoId/comments/:commentId` | 评论作者或管理员 | — | `{success:true}` |
| `GET /api/album/my-likes` | 公开；未登录为空 | — | `{likedIds}` |
| `POST /api/album/photos/batch-delete` | 所有者/管理员 | `{ids}`，最多 50 | `{success:true,count}` |
| `GET /api/album/recycle` | 管理员 | — | 照片数组 |
| `POST /api/album/photos/:id/restore` | 管理员 | — | `{success:true}` |
| `DELETE /api/album/photos/:id/permanent` | 管理员 | — | `{success:true}` |
| `POST /api/album/upload` | 登录/系统 VRC | multipart `photo`，及 `cateId,eventId,caption`；图片/视频 200 MB | `{success:true,id,url,thumbnail,mediaType}` |
| `GET /api/album/search` | 公开 | `q`（至少 2 字符） | `{photos,total}` |

### 5.6 点赞、签到、成就、收藏

#### 用户点赞（`user_like.js`，全部登录）

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `POST /api/user-like/:userId/like` | — | `{success:true,likeCount,todayLikes,message}` |
| `GET /api/user-like/:userId/stats` | — | `{userId,totalLikes,todayLikes,givenToday,likedToday,canLike}` |
| `GET /api/user-like/:userId/likers` | `page,pageSize` | `{likers,total,page,pageSize,totalPages,hasMore}` |
| `GET /api/user-like/me/given` | `page,pageSize` | `{given,total,page,pageSize,totalPages,hasMore}` |
| `GET /api/user-like/me/today-stats` | — | `{today,total}` |
| `GET /api/user-like/leaderboard` | `period,page,pageSize` | `{leaderboard,period,total,page,pageSize,totalPages,hasMore}` |
| `GET /api/user-like/mutual/:userId` | — | `{mutualDays,history}` |

#### 签到（`checkin.js`，全部登录）

| 方法与路径 | 请求 | 成功/业务响应 |
|---|---|---|
| `POST /api/checkin/me/checkin` | 无请求字段 | `{success:true,message,streak,points,totalCheckins,currentStreak,maxStreak,checkinPoints,todayCheckedIn}`；重复签到为 HTTP 200 `{success:false,alreadyCheckedIn:true,...}` |
| `GET /api/checkin/me/status` | — | `{todayCheckedIn,totalCheckins,currentStreak,maxStreak,checkinPoints,lastCheckinDate,rewards,recentCheckins}` |
| `GET /api/checkin/me/history` | `page,pageSize` | `{history,total,page,pageSize}` |
| `GET /api/checkin/leaderboard` | — | `{leaderboard}` |
| `GET /api/checkin/rewards` | — | `{rewards,userMaxStreak,userPoints}` |

#### 成就（`achievements.js`，全部登录）

`GET /api/achievements/me` → `{achievements,totalAchievements,unlockedCount,lockedCount,achievementPoints}`；`GET /api/achievements/me/type/:type` → `{achievements}`；`GET /api/achievements/me/unlocked` → `{unlocked}`；`GET /api/achievements/me/locked` → `{locked}`；`GET /api/achievements/leaderboard` → `{leaderboard}`；`GET /api/achievements/types` → `{types}`。

`achievements[]` 单项字段：`{id,keyName,name,description,icon,type,conditionType,conditionValue,progress,isUnlocked,unlockedAt,points,rarity,percentage}`。

以下两条是接口契约，改动前务必确认（曾各出过一次线上问题）：

- **以成就目录为基准返回，而非以用户已有记录为基准。** `/me`、`/me/type/:type`、`/me/locked`
  均从 `achievements` 表出发 `LEFT JOIN user_achievements ... AND ua.user_id = ?`，
  因此**从未触发过任何成就的新用户也会拿到全部启用中的成就**，`progress` 为 `0`、
  `isUnlocked` 为 `false`。若改成 `FROM user_achievements` 起手，新用户会收到
  `achievements: []` 却同时收到 `totalAchievements: 29`，前端渲染出空白成就墙。
- **`user_id` 过滤写在 JOIN 的 `ON` 里，不能挪到 `WHERE`。** 挪到 `WHERE` 会把
  外连接退化成内连接，未解锁成就（`ua` 侧全为 NULL）会被整行过滤掉，
  症状与上一条完全相同。遗漏该条件则会返回**全站所有用户**的成就进度（越权）。

`percentage` 在 `conditionValue <= 0` 时返回 `0`；不要写成直接相除，
`Infinity`/`NaN` 会被前端写进 `style.width` 导致进度条布局崩坏。

#### 收藏（`favorites.js`，全部登录）

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/favorites/worlds` | — | `{favorites}` |
| `POST /api/favorites/worlds` | `{worldId,worldName,imageUrl}` | `{ok:true,id,exists?}` |
| `DELETE /api/favorites/worlds/:id` | — | `{ok:true}` |
| `POST /api/favorites/worlds/recommend/:id` | — | `{ok:true}` |
| `GET /api/favorites/avatars` | — | `{favorites}` |
| `POST /api/favorites/avatars` | `{avatarId,avatarName,imageUrl}` | `{ok:true,id,exists?}` |
| `DELETE /api/favorites/avatars/:id` | — | `{ok:true}` |
| `POST /api/favorites/avatars/recommend/:id` | — | `{ok:true}` |

两个 recommend 端点（`/worlds/recommend/:id`、`/avatars/recommend/:id`）当前使用 `requireAdminCompat`（`admin` 或 `super_admin` 可调用）。此前误用 `requireRole(ROLE_LEVEL.ADMIN)`（`ROLE_LEVEL.ADMIN` 不存在，等效要求等级 0，形成任意已登录用户越权）的问题**已修复**——当前实现正确限管理员。

## 6. 聊天、直播与通知

### 6.1 聊天（`chat.js`，前缀 `/api/chat`）

全部使用聊天登录。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/chat/conversations` | — | `{conversations}` |
| `GET /api/chat/history/:userId` | `page,pageSize` | `{messages,total,page,pageSize}` |
| `POST /api/chat/send` | multipart `file` 可选；`receiverId,content` | `{ok:true,message}` |
| `POST /api/chat/read/:userId` | — | `{ok:true}` |
| `POST /api/chat/groups` | `{name,memberIds}` | `{ok:true,groupId,name}` |
| `GET /api/chat/groups` | — | `{groups}` |
| `GET /api/chat/groups/:groupId` | — | `{group,members}` |
| `POST /api/chat/groups/:groupId/join` | body 或 query `inviteCode` | `{ok:true}` |
| `POST /api/chat/groups/:groupId/leave` | — | `{ok:true,message}` |
| `GET /api/chat/groups/:groupId/messages` | `page,pageSize` | `{messages,total,page,pageSize}` |
| `POST /api/chat/groups/:groupId/messages` | multipart `file` 可选；`content,msgType,lat,lng` | `{ok:true,messageId}` |
| `GET /api/chat/groups/:groupId/admins` | — | `{admins}` |
| `POST /api/chat/groups/:groupId/admins` | `{userId}`；需群管理权限 | `{ok:true,message}` |
| `DELETE /api/chat/groups/:groupId/admins/:userId` | 需群管理权限 | `{ok:true,message}` |
| `POST /api/chat/groups/:groupId/kick` | `{userId}`；需群管理权限 | `{ok:true,message}` |
| `GET /api/chat/unread-count` | — | `{total,privateMessages,groups}` |
| `GET /api/chat/search` | `keyword,scope,page,pageSize` | `{privateMessages,groupMessages,privateMessagesTotal,groupMessagesTotal}` |
| `PATCH /api/chat/messages/read-batch` | `{messageIds}` | `{ok:true,count,message}` |
| `PUT /api/chat/messages/:id` | `{content}`；仅作者 | `{ok:true,message}` |
| `DELETE /api/chat/messages/:id` | 仅作者 | `{ok:true,message}` |
| `PATCH /api/chat/groups/:groupId/messages/read-batch` | `{messageIds}` | `{ok:true,count,message}` |
| `PUT /api/chat/groups/:groupId/messages/:msgId` | `{content}`；仅作者 | `{ok:true,message}` |
| `DELETE /api/chat/groups/:groupId/messages/:msgId` | 作者/群权限 | `{ok:true,message}` |

> **聊天媒体上传**（2026-09-16 起）：`POST /api/chat/send` 与 `POST /api/chat/groups/:groupId/messages` 均为 multipart，字段 `file` 可选，经 `chatUpload`（multer 100MB + `createFileFilter(['IMAGE','VIDEO','AUDIO'])`）校验。上传成功后按扩展名判定 `media_type` 入库：图片（`.jpg/.jpeg/.png/.gif/.webp`）→ `image`、视频（`.mp4/.mov/.webm/.avi/.mkv`）→ `video`、音频（`.mp3/.wav/.ogg/.m4a`）→ `audio`；消息响应体含 `media_url`/`media_type`/`file_size`，经 WS `chat:new`（私聊）/`group:new`（群聊）实时下发对端。群聊另以 `msgType` 字段（前端白名单 `text/image/video/audio/location`）标注消息类型。前端仅经 `apiForm`（勿用 JSON 序列化的 `api`）上传，字段 `file`；私聊附 `receiverId`、群聊附 `msgType`。

### 6.2 直播（`live.js`，前缀 `/api/live`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `POST /api/live` | 登录 | multipart：`thumbnail` 可选（20 MB），`title,description,isPublic` | `{ok:true,streamId,rtmpUrl,streamUrl,title}` |
| `GET /api/live` | 公开 | `status,page,pageSize` | `{streams,total,page,pageSize}` |
| `GET /api/live/:streamId` | 公开 | — | 直播对象 |
| `POST /api/live/:streamId/start` | 主播 | — | `{ok:true,message}` |
| `POST /api/live/:streamId/end` | 主播 | — | `{ok:true,message}` |
| `POST /api/live/:streamId/enter` | 登录 | — | `{ok:true,viewerCount}` |
| `POST /api/live/:streamId/leave` | 登录 | — | `{ok:true,viewerCount}` |
| `GET /api/live/:streamId/viewers` | 登录 | — | `{viewers}` |
| `POST /api/live/:streamId/comments` | 登录 | `{content}` | `{ok:true,comment}` |
| `GET /api/live/:streamId/comments` | 登录 | `page,pageSize` | `{comments,total,page,pageSize}` |
| `POST /api/live/:streamId/like` | 登录 | — | `{ok:true,likeCount}` |
| `GET /api/live/:streamId/likes` | 公开 | — | `{likeCount}` |
| `GET /api/live/user/history` | 登录 | `page,pageSize` | `{streams,total,page,pageSize}` |
| `DELETE /api/live/:streamId` | 主播且非直播中 | — | `{ok:true,message}` |

`GET /:streamId` 声明在 `/user/history` 之前，故 `/api/live/user/history` 会被当作 `streamId=user`，当前实际不可达。

### 6.3 通知（`notifications.js`，挂载 `/api`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/notifications` | 可选登录；匿名为空 | — | `{notifications,unread}` |
| `GET /api/notifications/unread` | 可选登录 | — | `{count}` |
| `POST /api/notifications/read` | 登录/系统 VRC | — | `{success:true}` |
| `POST /api/notifications/read-all` | 登录/系统 VRC | — | `{success:true}` |
| `POST /api/notifications/archive-all` | 登录/系统 VRC | — | `{success:true}` |
| `GET /api/notifications/settings` | 登录 | — | `{email,browser,sound}` |
| `POST /api/notifications/settings` | 登录 | `{email,browser,sound}` | `{success:true,settings}` |
| `DELETE /api/notifications` | 登录/系统 VRC | — | `{success:true}` |
| `POST /api/notifications/:id/read` | 登录/系统 VRC | — | `{success:true}` |
| `PUT /api/notifications/:id/archive` | 登录/系统 VRC | `{archived}` | `{success:true,archived}` |
| `DELETE /api/notifications/:id` | Session 登录 | — | `{success:true}` |

## 7. VRChat 群组（`groups.js`，挂载 `/api`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `POST /api/vrc/lookup` | VRC Cookie | `{query}` | `{user}` 或 `{users}` |
| `GET /api/group` | VRC Cookie | — | `{group,members}` |
| `GET /api/vrc/world/:worldId` | VRC Cookie | — | VRChat 世界对象 |
| `GET /api/vrc/worlds/search` | VRC Cookie | `q,n` | `{worlds}` |
| `GET /api/vrc/avatars/search` | VRC Cookie | `q,n` | `{avatars}` |
| `GET /api/vrc/avatar/:avatarId` | VRC Cookie | — | VRChat 头像对象 |
| `POST /api/vrc/avatar/set` | VRC Cookie | `{avatarId}` | `{ok:true,avatarId}` |
| `POST /api/group/members/sync` | 管理员 + VRC Cookie | — | `{success:true,total,joined,left,updated}` |
| `GET /api/group/members/refresh` | VRC Cookie | — | `{success:true,online,offline,total,updated?,results?}` |
| `GET /api/group/members` | 公开 | `filter=all|online|offline` | `{members,total}` |
| `GET /api/group/members/changes` | 公开 | `limit`，最大 100 | `{changes}` |
| `GET /api/group/members/sync-log` | 公开 | — | `{logs}` |
| `POST /api/admin/roster/sync` | 管理员 | `{vrchatId,displayName}` | `{success:true}` |
| `GET /api/group/check/:vrchatId` | 公开 | — | `{inGroup}` |
| `GET /api/group/stats` | 公开 | — | `{totalMembers,onlineCount,offlineCount,onlineRate,statusDistribution,worldDistribution,locationDistribution,recentMembers,joinedToday,leftToday,updatedAt}` |
| `GET /api/group/worlds` | 公开 | — | `{worlds}` |
| `GET /api/group/members/snapshot` | 公开 | — | `{online,offline}` |
| `POST /api/vrc/status/check` | 管理员 + VRC Cookie | `{vrchatId}` | `{success:true,vrchatId,status,errorMsg}` |
| `POST /api/vrc/status/batch-check` | 管理员 + VRC Cookie | `{vrchatIds}`，最多 50 | `{success:true,results}` |
| `GET /api/vrc/status/list` | 管理员 | `page,pageSize,status` | `{statuses,total,page,pageSize}` |
| `POST /api/group/invites/batch` | 管理员 + VRC Cookie | `{vrchatIds,message}`，最多 100 | `{success:true,results}` |
| `GET /api/group/invites` | 管理员 | `page,pageSize,status` | `{invites,total,page,pageSize}` |
| `POST /api/group/invites/:id/accept` | Session 且绑定 VRC ID 匹配 | — | `{success:true}` |
| `POST /api/group/invites/:id/reject` | Session 且绑定 VRC ID 匹配 | — | `{success:true}` |
| `GET /api/group/invites/my` | Session | — | `{invites}` |

**F-6/F-23 群组内容管理（管理员直通 VRChat，写操作使用本人 VRC Cookie）**：

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/group/announcements` | 管理员 + VRC Cookie | — | `{announcements}` |
| `POST /api/group/announcements` | 管理员 + VRC Cookie | `{text,sendNotification?}` | `{announcement}` |
| `DELETE /api/group/announcements/:announcementId` | 管理员 + VRC Cookie | — | `{ok:true}` |
| `GET /api/group/galleries` | 管理员 + VRC Cookie | — | `{galleries}` |
| `POST /api/group/galleries` | 管理员 + VRC Cookie | `{name,description?}` | `{gallery}` |
| `PUT /api/group/galleries/:galleryId` | 管理员 + VRC Cookie | `{name,description?}` | `{gallery}` |
| `DELETE /api/group/galleries/:galleryId` | 管理员 + VRC Cookie | — | `{ok:true}` |
| `GET /api/group/roles` | 管理员 + VRC Cookie | — | `{roles}` |
| `POST /api/group/roles` | 管理员 + VRC Cookie | `{name,description?}` | `{role}` |
| `DELETE /api/group/roles/:roleId` | 管理员 + VRC Cookie | — | `{ok:true}` |
| `PUT /api/group/members/:userId/roles/:roleId` | 管理员 + VRC Cookie | `{action:'add'\|'remove'}` | `{ok:true}` |
| `GET /api/group/audit-logs` | 管理员 + VRC Cookie | `n?`，默认 50 | `{auditLogs}` |
| `GET /api/group/bans` | 管理员 + VRC Cookie | `n?` | `{bans}` |
| `POST /api/group/bans` | 管理员 + VRC Cookie | `{userId}` | `{ban}` |
| `DELETE /api/group/bans/:userId` | 管理员 + VRC Cookie | — | `{ok:true}` |
| `GET /api/group/economy` | 管理员 + VRC Cookie | — | `{economy}` |
| `POST /api/group/calendar/follow` | 管理员 + VRC Cookie | — | `{ok:true}` |
| `DELETE /api/group/calendar/follow` | 管理员 + VRC Cookie | — | `{ok:true}` |

> 路径参数 `userId/roleId/galleryId/announcementId` 均经 `sanitizeVrcId` 白名单校验（`usr_/grol_/gald_` 前缀 + hex）；管理面板前端入口在「群组」Tab 的 admin-only 折叠面板（公告/相册/角色/审计日志/黑名单/经济/日历，见 `group.js` 的 `setupGroupAdminPanels`）。

### 7.1 模型收藏馆（`model-collections.js`，挂载 `/api/model-collections`）

玩家收藏的 VRChat 头像/模型（`avtr_` 等 modelId）的增删改查、有效性检测、失效通知，以及「替换游戏内模型」（调 `vrchatSetAvatar`，严格使用本人 VRC Cookie，绝不回退系统账号）。数据表 `model_collections`（`UNIQUE(user_id, model_id)`）。前端入口：导航「🎭 模型收藏馆」Tab（`#tab-modelcoll`）与管理面板「模型收藏」专区（`#adminModelCollectionsSection`）。

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/model-collections` | 登录 | `page,pageSize(≤100,默认20),status(valid\|invalid\|unknown),search` | `{collections,total,summary{valid,invalid,unknown,total},page,pageSize}` |
| `POST /api/model-collections` | 登录 | `{modelId,notes,isPublic}` | `{ok:true,id,exists,model}` |
| `GET /api/model-collections/:id` | 登录（本人或管理员） | 路径 `id` | `{collection}`（`rowToView`，见下） |
| `PUT /api/model-collections/:id` | 登录（仅本人） | `{notes,isPublic}` | `{ok:true}` |
| `DELETE /api/model-collections/:id` | 登录（仅本人） | — | `{ok:true}` |
| `POST /api/model-collections/:id/replace` | 登录（需本人 VRC Cookie） | — | `{ok:true,message}`；401 `{code:'VRC_NOT_BOUND'\|'VRC_EXPIRED'}`；502 替换失败 |
| `POST /api/model-collections/:id/check` | 登录（本人或管理员） | — | `{ok:true,status,invalidReason}` |
| `GET /api/model-collections/admin/stats` | 管理员 | — | `{summary,userCount}` |
| `GET /api/model-collections/admin/invalid` | 管理员 | `page,pageSize(≤100,默认30)` | `{items,total,page,pageSize}`（`items` 含 `ownerName,ownerVrcName`） |
| `GET /api/model-collections/admin/user/:userId` | 管理员 | `page,pageSize` | `{user,summary,total,collections,page,pageSize}` |
| `DELETE /api/model-collections/admin/:id` | 管理员 | — | `{ok:true}` |
| `DELETE /api/model-collections/admin/user/:userId` | 管理员 | — | `{ok:true,deleted}` |
| `POST /api/model-collections/admin/scan` | 管理员 | `{batchSize(≤500,默认100),all}` | `{ok:true,scanned,newlyInvalid,...}` |
| `POST /api/model-collections/admin/user/:userId/scan` | 管理员 | — | `{ok:true,scanned,newlyInvalid,...}` |
| `POST /api/model-collections/admin/:id/recommend` | 管理员 | — | `{ok:true,isRecommended}` |

**响应结构 `collection`（`rowToView` 输出）**：`id, userId, modelId, modelName, authorId, authorName, thumbnailUrl, description, unityVersion, assetUrl, assetVersion, platform, status('valid'\|'invalid'\|'unknown'), invalidReason, lastCheckedAt, isRecommended, isPublic, notes, createdAt, updatedAt`。

**错误约定**：
- 通用：`{error, code}`（`code` 取自 `ErrorCodes`：`BAD_REQUEST`/`NOT_FOUND`/`FORBIDDEN`/`BAD_GATEWAY`）；未知异常由 `handleError` 兜底。
- `POST /:id/replace` 的 401 **必须**返回 `{error, code:'VRC_NOT_BOUND'|'VRC_EXPIRED'}`（前端 `model-collections.js` 据此引导绑定/重绑）；不可套 `sendError(res,401,code,'…',{code})`——第 5 参是 `detail` 而非 `code`，会让 `error.code` 变成 `UNAUTHORIZED` 导致前端分支永远不匹配（该缺陷已于第九轮修复）。
- `POST /` 失败按 `e.code` 映射：`MODEL_NOT_FOUND`→404、`VRC_UNAUTHORIZED`→401、`INVALID_MODEL_ID`→400。

**定时任务**：每日 `0 0 5 * * *` 调 `scanInvalidModels({onlyUnchecked:true})`；检测到 `status!=invalid` 变为失效时发站内通知 `model_invalid`（200ms 节流）；进程内 `scanInFlight` 互斥，避免手动 `/admin/scan` 与定时并发双通知。

## 8. 权限组与管理基础接口

### 8.1 权限组（`permission_groups.js`）

除 `/my` 为登录外，其余均为超管。

| 方法与路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /api/permission-groups/groups` | — | `{groups}` |
| `POST /api/permission-groups/groups` | `{name,description,parentId}` | `{success:true,id,message}` |
| `PUT /api/permission-groups/groups/:id` | 同上 | `{success:true,message}` |
| `DELETE /api/permission-groups/groups/:id` | — | `{success:true,message}` |
| `GET /api/permission-groups/groups/:id/permissions` | — | `{permissions,allKeys,labels}` |
| `POST /api/permission-groups/groups/:id/permissions/set` | `{key,value}` | `{success:true,conflict,message}` |
| `POST /api/permission-groups/groups/:id/permissions/batch` | `{permissions}` | `{success:true,updated,message}` |
| `GET /api/permission-groups/users/:userId/groups` | — | `{groups,available}` |
| `POST /api/permission-groups/users/:userId/groups` | `{groupId}` | `{success:true,message}` |
| `DELETE /api/permission-groups/users/:userId/groups/:groupId` | — | `{success:true,message}` |
| `GET /api/permission-groups/my` | 登录 | `{permissions,groupIds}` |
| `GET /api/permission-groups/definitions` | — | `{allKeys,labels}` |

### 8.2 管理基础（`admin.js`，挂载 `/api`）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/admin/stats` | 管理员 | — | `{totalUsers,pendingApproval,totalBanned,totalPhotos,totalEvents,totalOnline,totalGroupMembers,totalAnnouncements}` |
| `GET /api/social-links` | 公开 | — | `{vrcGroupUrl,kookUrl,oopzUrl}` |
| `GET /api/admin/config` | 管理员 | — | 配置对象及 `groupId`（含 `req_max_upload_mb`/`req_max_body_mb`/`req_max_other_mb` 等请求限制键） |
| `PUT /api/admin/config` | 超管 | 允许的配置键（`site_name`、`hero_*`、`posts_*`、`post_video_max_size_mb`、`vrcGroupUrl`、`kookUrl`、`oopzUrl`、`req_max_upload_mb`、`req_max_body_mb`、`req_max_other_mb`） | `{success:true}`；请求体兼容 `{config:{...}}` 包裹或顶层直传，保存即生效 |
| `GET /api/admin/users` | 管理员 | `page,pageSize,search,role,status` | `{users,total,page,pageSize,totalPages}` |
| `POST /api/admin/users` | 超管 | `{loginId,password,displayName,role,email}` | `{success:true,id}` |
| `POST /api/admin/users/:id/approve` | 管理员 | — | `{success:true}` |
| `POST /api/admin/users/:id/ban` | 管理员/目标角色保护 | — | `{success:true}` |
| `POST /api/admin/users/:id/unban` | 管理员/目标角色保护 | — | `{success:true}` |
| `DELETE /api/admin/users/:id` | 管理员/目标角色保护 | — | `{success:true}` |
| `POST /api/admin/users/:id/reset-password` | 管理员/目标角色保护 | `{newPassword}` | `{success:true}` |
| `GET /api/search` | 登录（入口文件的同路径处理器先命中） | `q` | `{announcements,events,users}` |
| `POST /api/name-change/request` | 登录 | `{newName, reason?}` | `{success:true,message}`；`reason` 为改名理由（可选，2026-08-27 起被持久化） |
| `GET /api/name-change/my-requests` | 登录 | — | `{requests}`（每条含 `reason` 字段，2026-08-27 起返回） |
| `GET /api/name-change/pending` | 管理员 | — | `{requests}` |
| `GET /api/name-change/all` | 管理员 | — | `{requests}` |
| `POST /api/name-change/review` | 管理员 | `{id,action:"approve"|"reject",comment}` | `{success:true}` |
| `GET /api/permissions` | 管理员 | — | `{userPermissions}` |
| `GET /api/permissions/me` | 登录 | — | `{grants}` |
| `POST /api/permissions/set` | 管理员 | `{userId,permission,granted}` | `{success:true}` |
| `GET /api/admin/groups` | 管理员 | — | `{groups}` |
| `PUT /api/admin/groups/sort` | 管理员 | `{groupIds}` | `{success:true}` |

### 8.3 权限查看（只读检视器，`permissions.js`，前缀 `/api/permissions-view`）

> 2026-08-16 新增：与 `permission_groups.js`（写操作 / 权限组 CRUD）职责分离，本组接口**只读**，用于"单独调用查看群组用户权限与网站用户权限"。

| 方法与路径 | 权限 | 说明 |
|---|---|---|
| `GET /api/permissions-view/user/:userId/website` | 看自己=登录；看他人=`super_admin` | 网站用户权限：站点角色 + 所属权限组 + 合并后的有效权限矩阵（`can_*` 全量 true/false）+ 遗留 `user_permissions` |
| `GET /api/permissions-view/user/:userId/group` | 同上 | 群组用户权限：该用户在 VRChat 群组（`group_roster`）的成员状态 / 角色 / 在线 / 所在世界 |
| `GET /api/permissions-view/user/:userId` | 同上 | 合并视图（网站 + 群组） |
| `GET /api/permissions-view/me` | 登录 | 自身合并视图 |
| `GET /api/permissions-view/definitions` | 登录 | 全部权限键定义 `{allKeys, labels}` |

- 鉴权：`resolveTarget` 确保只有本人或超级管理员可查看；普通 `admin` 不可越权查看他人权限详情。
- 前端「用户权限查看」检视器（`admin-perms.js` 的 `loadPermissions` / `inspectUserPermissions`）与「权限组管理 → 用户归属」弹窗（`#pgUserPermView`）均调用合并视图 `/user/:userId`。
- 注意：权限组 `can_*` 键**目前不被任何业务路由强制**（仅顾问式展示），查看接口如实反映这一事实（`effectivePermissions` 为合并结果，`legacyPermissions` 为旧表残留）。

## 9. 运维与新增路由

以下均为当前 `server/routes` 中已挂载的实际路由。

### 9.1 数据库（`database.js`，全部管理员）

`GET /api/admin/db/status` → `{success,connected,database,version,uptime,connections,activeConnections,queries,poolStats}`；`GET /api/admin/db/tables` → `{success,tables,totalTables,totalRows,totalSize}`；`GET /api/admin/db/processlist` → `{success,processes,total}`；`GET /api/admin/db/variables` → `{success,variables}`；`GET /api/admin/db/slow-queries` → `{success,slowQueryCount,slowLogEnabled,slowLogFile}`。

`GET /api/admin/db/table/:name?page&pageSize` → `{success,name,engine,rows,dataSize,indexSize,columns,indexes,records,total,page,pageSize,totalPages}`；`POST /api/admin/db/optimize/:table`、`POST /api/admin/db/analyze/:table` → `{success,table,duration,message}`；`POST /api/admin/db/check/:table`、`POST /api/admin/db/repair/:table` → `{success,table,result}`；`POST /api/admin/db/kill/:pid` → `{success,pid,message}`。

### 9.2 迁移（`migration.js`，前缀 `/api/migration`，全部管理员）

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `GET /api/migration/detect` | 管理员 | — | `{success:true,results}` |
| `POST /api/migration/test-connection` | 管理员 | `{host,port,database,user,password}` | `{success:true,message}` |
| `POST /api/migration/get-databases` | 管理员 | `{host,port,user,password}` | `{success:true,databases}` |
| `POST /api/migration/get-tables` | 管理员 | `{host,port,database,user,password}` | `{success:true,tables}` |
| `POST /api/migration/migrate` | 管理员 | `{sourceDb,targetDb,tables}` | `{success:true,logs}` |
| `POST /api/migration/scan-config` | 管理员 | — | `{success:true,files}` |
| `POST /api/migration/replace-config` | 管理员 | `{files,dbConfig:{host,port,database,user,password}}` | `{success:true,results}` |
| `GET /api/migration/panel-configs` | 管理员 | — | `{success:true,panels}` |

### 9.3 Setup（`setup.js`）

> 2026-08-16 增强：支持「重走建站引导」——引导状态/草稿隔离存储于 `setup-wizard.json`（不存密码/密钥）；`reset` 仅清引导数据；reconfigure 模式要求超管。

- `GET /api/setup/check` 公开，返回 `{configured, wizardCompleted, authenticated, isSuperAdmin}`。
- `GET /api/setup/state` 返回已保存的非敏感草稿（首次也可从 `.env` 预填），供前端回显。
- `POST /api/setup/state` 仅持久化当前步骤与非敏感草稿（白名单：`dbHost/dbPort/dbName/dbUser/sitePort/nodeEnv/adminUser/adminDisplayName/adminEmail/groupId/groupUrl/smtpHost/smtpPort/smtpUser/smtpFrom/smtpSecure`）。
- `POST /api/setup/reset` **要求 `super_admin`**：仅写回默认引导状态（清空 `setup-wizard.json`），不影响 `.env`/数据库/其它配置。
- `POST /api/setup/test-db` 请求 `{host,port,database,user,password}`；reconfigure 模式下密码留空则沿用 `.env` 现有值。
- `POST /api/setup/test-email` 请求 `{host,port,secure,user,pass,from,to}`；同上。
- `POST /api/setup/save` 请求数据库、站点、Session、加密、管理员、群组和 SMTP 配置字段，返回 `{success,adminCreated?,adminError?|error?}`。行为分两种：
  - **首次安装**（`.env` 不存在）：开放；
  - **重走（reconfigure，`.env` 已存在）**：要求 `super_admin`；合并写盘（仅覆盖已填项，密码/密钥留空=沿用），失败不再删 `.env`；管理员已存在则 `UPDATE`，否则 `INSERT`。
  - 保存失败存在 HTTP 200 且 `success:false` 的情况。

### 9.4 配置（`config.js`，全部管理员）

`GET /api/admin/config/env` → `{success,config}`（敏感值遮罩）；`PUT /api/admin/config/env` 请求白名单环境变量键 → `{success,message}`；`POST /api/admin/config/reload` → `{success,message}`；`GET /api/admin/config/info` → `{nodeVersion,platform,arch,uptime,memoryUsage,env,version}`。

`/api/admin/config`（站点配置）由 `admin.js` 提供；`config.js` 提供的是不同路径 `/api/admin/config/env`、`/reload`、`/info`。

### 9.5 备份（`backups.js`，全部管理员）

`GET /api/admin/backups` → `{backups,total}`；`POST /api/admin/backups/create` → `{success,filename,size,sizeFormatted,createdAt,message}`；`POST /api/admin/backups/restore/:filename` → `{success,filename,message}`；`GET /api/admin/backups/:filename/download` 返回 SQL 附件；`DELETE /api/admin/backups/:filename` → `{success,message}`；`POST /api/admin/backups/cleanup` 请求 `{keepDays}` → `{success,deleted,message}`。

### 9.6 文件（`files.js`，全部管理员）

`GET /api/admin/files` → `{files,total,totalSize,totalSizeBytes}`；`GET /api/admin/files/:filepath/download` 返回附件；`DELETE /api/admin/files/:filepath` → `{success,message}`；`POST /api/admin/files/create-dir` 请求 `{name,parent}`；`POST /api/admin/files/cleanup` 请求 `{days}`；`POST /api/admin/files/rename` 请求 `{filepath,newName}` → `{success,message,newPath}`。

### 9.7 日志、安全、分析（全部管理员）

- `logs.js`：`GET /api/admin/logs/recent?limit`、`GET /api/admin/logs/files`、`GET /api/admin/logs?date&page&pageSize` 返回 logger 服务结果；`DELETE /api/admin/logs/:filename` → `{success:true}`。
- `security.js`：`GET /api/admin/security/alerts/stats` → `{success:true,stats}`。
- `analytics.js`：`GET /api/admin/analytics/dashboard` → `{users,content,performance,cache}`；`GET /api/admin/analytics/requests` → `{total,success,errors,successRate,endpoints,statusCodes,slowRequests}`；`GET /api/admin/analytics/users?days` → `{dailyRegistrations,topUsers,activityByHour}`；`GET /api/admin/analytics/content?days` → `{dailyPosts,dailyEvents,dailyPhotos,postsByUser}`；`GET /api/admin/analytics/system` → `{system,cache,metrics}`。

### 9.8 导出（`export.js`，全部管理员）

`GET /api/admin/export/tables` → `{tables}`；`GET /api/admin/export/sample` → `{sample,counts}`；`POST /api/admin/export/batch` 请求 `{tables,format}` 并返回 JSON/CSV 附件；`GET /api/admin/export/:table?format` 返回单表 JSON/CSV 附件。

### 9.9 Webhook（`webhooks.js`，全部管理员）

`GET /api/admin/webhooks` → `{webhooks}`；`POST /api/admin/webhooks` 请求 `{url,events,secret}` → `{success,id}`；`PUT /api/admin/webhooks/:id` 接受更新对象；`DELETE /api/admin/webhooks/:id` → `{success}`；`POST /api/admin/webhooks/:id/test` 返回发送结果；`GET /api/admin/webhooks/events` → `{events}`。

### 9.10 健康、站点元信息

| 方法与路径 | 权限 | 响应 |
|---|---|---|
| `GET /api/health/detailed` | 管理员 | `{status,timestamp,uptime,database,system,version}`；失败 503 |
| `GET /api/health/live` | 公开 | `{status:"alive"}` |
| `GET /api/health/ready` | 公开 | `{status:"ready"}`；数据库失败 503 |
| `GET /sitemap.xml` | 公开 | XML |
| `GET /robots.txt` | 公开 | 文本 |
| `GET /api-docs` | 公开 | Swagger UI |
| `GET /api-docs.json` | 公开 | OpenAPI JSON |

### 9.11 分享（`share.js`）

文件挂载在 `/api/share`：

| 方法与路径 | 权限 | 请求 | 成功响应 |
|---|---|---|---|
| `POST /api/share` | 登录 | `{type:"post"|"event"|"album",targetId}` | `{success,shareCode,shareUrl,expiresAt}` |
| `GET /api/share/:code` | 公开 | — | `{success,type,shareCode,content,expiresAt,createdAt}` |
| `GET /api/share/list` | 登录 | — | `{shares}` |
| `DELETE /api/share/:code` | 创建者或管理员 | — | `{success:true}` |

分享链接默认有效 7 天；仅可为公开动态、公开活动和未回收的公开相册照片创建分享，解析时会再次校验公开状态。`share_links` 由数据库初始化创建。当前 `shareUrl` 指向返回 JSON 内容的公开 API，尚无独立分享落地页。

## 10. 前端调用与实现不一致

以下是仍存在的兼容调用差异：

1. `auth.js` 对 `GET /api/users/me/profile` 兼容读取 `data.user || data`；后端实际返回顶层资料对象。
2. 前端调用 `/api/posts?limit=3`；后端分页字段为 `pageSize`，`limit` 被忽略。

## 11. 关键实现事实

- `/api/search` 有两个 GET 处理器；`server.js` 中要求登录、读取 `q` 的处理器先注册，故 `admin.js` 中公开版本不会执行。
- `/api/admin/config` 的 GET 需管理员、PUT 需超管；`/api/admin/config/env` 的 GET/PUT 均需管理员。
- `/api/health` 是 `server.js` 的公开简版；`/api/health/detailed` 才是管理员详细版。
- `/uploads`、`/assets` 由 Express 直接公开静态托管；备份只能通过管理员 API 访问。
- 上传字段以代码为准：共享相册 `photo`、动态 `media`、个人相册 `photos`、个人视频 `video`、头像 `avatar`、聊天附件 `file`、直播缩略图 `thumbnail`、群组图片 `image`。

## 14. 新增模块 API（2026-08-25 补充）

> 以下模块在 2026-08-09 基线之后新增并已在 `server.js` 挂载。端点的字段以 `server/routes/*.js` 当前实现为准；其中 `journey.js`、`memory.js`、`capsules.js` 已定义路由但未被挂载，不在此列（dead routes）。

### 14.1 好友系统（`friends.js`，前缀 `/api/friends`，全部登录）

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `POST /api/friends/request` | 登录 | `{targetUserId}` | `{success,status:"pending"|"accepted",friendship}` |
| `POST /api/friends/respond` | 登录 | `{requestId,action:"accept"|"reject"}` | `{success,status}` |
| `POST /api/friends/block` | 登录 | `{targetUserId}` | `{success,ok}` |
| `DELETE /api/friends/block/:targetUserId` | 登录 | — | `{success,ok}` |
| `DELETE /api/friends/:friendUserId` | 登录 | — | `{success,ok}`（删除好友关系） |
| `GET /api/friends?status=accepted\|pending\|blocked` | 登录 | — | `{list,total}` |
| `GET /api/friends/requests` | 登录 | — | `{incoming,outgoing}` |
| `GET /api/friends/status/:userId` | 登录 | — | `{status,direction,blockedByThem}` |
| `GET /api/friends/mutuals` | 登录 | — | `{counts}` |
| `GET /api/friends/mutuals/:targetUserId` | 登录 | — | `{targetId,count,mutualFriends}` |
| `GET /api/friends/history/:userId` | 登录 | 本人或已接受好友（否则 403） | `{items[{id,type,oldValue,newValue,time}],total,page,pageSize}`（F-13 好友变更历史，`friend_log` 表） |
| `GET /api/friends/world-history/:userId` | 登录 | 本人或已接受好友（否则 403） | `{items,totalAvatars?}`（F-14 世界足迹，`world_visit_log` 表按 world_id 聚合） |
| `GET /api/friends/avatar-history/:userId` | 登录 | 本人或已接受好友（否则 403） | `{items[{avatarId,avatarUrl,useCount,firstSeenAt,lastSeenAt}],totalAvatars,totalUses}`（F-16 头像使用历史，`avatar_history_log` 表，LIMIT 100） |

### 14.2 关注系统（`follows.js`，前缀 `/api/follows`，全部登录）

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `POST /api/follows` | 登录 | `{targetUserId}` | `{success,ok,following}` |
| `DELETE /api/follows/:targetUserId` | 登录 | — | `{success,ok,following}` |
| `GET /api/follows/following?userId&page&pageSize` | 登录 | 分页 | `{list,page,pageSize,total}` |
| `GET /api/follows/followers?userId&page&pageSize` | 登录 | 分页 | `{list,page,pageSize,total}` |
| `GET /api/follows/status/:userId` | 登录 | — | `{following,followedBy}` |
| `GET /api/follows/counts/:userId` | 登录 | — | `{following,followers}` |

### 14.3 头像（`avatar.js`，前缀 `/api/avatar`）

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `GET /api/avatar/default` | 公开 | — | 内联 SVG 占位头像 |
| `GET /api/avatar/proxy?u=<url>` | 公开（限流） | 查询 `u` 为 VRChat/允许 CDN 头像地址 | 代理并缓存的图片；非法或非允许主机返回 4xx |

> `GET /api/avatar/default` 同时也由 `server.js` 入口文件直接提供（见 §2）；`avatar.js` 为独立挂载版，二者共存。

### 14.4 统一收藏馆（`collections.js`，前缀 `/api/collections`，登录；管理端点用 `requireAdminCompat`）

V8.2 起收藏统一为「收藏夹 + 收藏项」模型，合并原 `model-collections` 能力。`kind` 区分收藏类型（如 world/avatar/model），`visibility` 区分公开/私有。

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `GET /api/collections/folders` | 登录 | — | `{success,folders}` |
| `POST /api/collections/folders` | 登录 | `{name}` | `{success,folder}` |
| `PUT /api/collections/folders/:id` | 登录 | `{name}` | `{success}` |
| `DELETE /api/collections/folders/:id` | 登录 | — | `{success}` |
| `GET /api/collections?scope=mine\|public&kind&folderId&sort&page&pageSize` | 登录 | 分页 | `{success,items,page,pageSize,total,totalPages,scope}` |
| `GET /api/collections/discover` | 登录 | `kind` 等筛选 | `{success,items,...}` |
| `GET /api/collections/tags` | 登录 | — | `{success,tags}` |
| `POST /api/collections` | 登录 | `{kind,target_id,visibility,folder_id,notes,booth_url}` | `{success,item}` |
| `PUT /api/collections/:id` | 登录 | `{notes,visibility,folder_id,name}` | `{success,item}` |
| `DELETE /api/collections/:id` | 登录 | — | `{success}` |
| `POST /api/collections/:id/check` | 登录 | — | `{success,status,invalidReason}`（失效检测） |
| `POST /api/collections/:id/rate` | 登录 | `{rating}` | `{success,rating_avg,rating_count}` |
| `POST /api/collections/:id/set-avatar` | 登录（需 VRC Cookie） | — | `{success}` |
| `POST /api/collections/scan` | 管理员 | — | `{success,checked,newInvalid}` |
| `GET /api/collections/admin/stats` | 管理员 | — | 统计 |
| `GET /api/collections/admin/invalid` | 管理员 | — | 失效项列表 |
| `GET /api/collections/admin/user/:userId` | 管理员 | — | 该用户收藏 |
| `DELETE /api/collections/admin/user/:userId` | 管理员 | — | `{success}` |
| `DELETE /api/collections/admin/:id` | 管理员 | — | `{success}` |
| `POST /api/collections/admin/user/:userId/scan` | 管理员 | — | 扫描该用户收藏 |
| `POST /api/collections/admin/scan` | 管理员 | — | 全量扫描 |

> `model-collections.js`（前缀 `/api/model-collections`）仍挂载并与 `collections` 并存，详见 §7.1；建议后续合并以避免双写。

### 14.5 系统恢复（`db-recover.js`，前缀 `/api/system`）

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `GET /api/system/db-status` | 公开（不依赖数据库） | — | `{ok:true}` 或 `{ok:false,error}`；用于数据库连通性探测 |
| `POST /api/system/db-recover` | 需 `RECOVERY_TOKEN` 请求头 | `{host,port,user,database,password,testOnly?}` | `{success,reinitialized}`；`testOnly` 为真时仅测试连接不重建 |

> 该模块用于数据库配置损坏/连接失败时的紧急恢复；`RECOVERY_TOKEN` 与恢复口令相关，非普通会话鉴权。

### 14.6 头像标签（`avatar_tags.js`，挂载 `/api/avatar-tags`，全部登录）

> F-16 私有标签：`avatar_tags` 表按 `(owner_id, avatar_id)` 归属，标签仅对打标签者自己可见；`avatar_id` 须匹配 `avtr_` 前缀（否则 400）；最多 8 个标签、单个最长 50 字符。

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `GET /api/avatar-tags/:avatarId` | 登录 | — | `{tags: string[]}` |
| `POST /api/avatar-tags/:avatarId` | 登录 | `{tags: string[]}` | `{tags}`（覆盖式：事务先删后插，整体替换该头像标签；自动去重/去空/截断） |
| `DELETE /api/avatar-tags/:avatarId` | 登录 | — | `{success,ok}`（清空该头像全部标签） |

> F-16 头像收藏复用统一收藏馆 `collections.js` 的 `kind='avatar_model'`（见 §14.4，`target_id` 传 `avtr_xxx` 头像 ID，后端走 `vrchatGetAvatar` 拉元数据）；`kind='avatar_favorite'` 为「收藏用户」语义，不可混用。

### 14.7 世界标签（`world_tags.js`，挂载 `/api/world-tags`，全部登录）

> F-17 私有标签：`world_tags` 表按 `(owner_id, world_id)` 归属，标签仅对打标签者自己可见；`world_id` 须匹配 `wrld_` 前缀（否则 400）；最多 8 个标签、单个最长 50 字符；与 `avatar_tags`（§14.6）同模式。

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `GET /api/world-tags/:worldId` | 登录 | — | `{tags: string[]}` |
| `POST /api/world-tags/:worldId` | 登录 | `{tags: string[]}` | `{tags}`（覆盖式：事务先删后插，整体替换该世界标签；自动去重/去空/截断） |
| `DELETE /api/world-tags/:worldId` | 登录 | — | `{success,ok}`（清空该世界全部标签） |

> F-17 世界收藏/分组复用统一收藏馆 `collections.js` 的 `kind='world'`（见 §14.4，`target_id` 传 `wrld_xxx` 世界 ID）；收藏 POST 走 `world_cache.js` 的 `getCachedWorld`（DB `vrc_worlds_cache` 权威 + Redis L2，miss 回源 `vrchatGetWorld` 并回写，24h 有效期，见 docs/04 §18.1）。

### 14.8 审核队列（`moderations.js`，挂载 `/api/moderations`）

> F-18 玩家/头像审核：`moderations` 表（`target_type` 为 `player`/`avatar`）。「通过」时按类型执行远程 VRChat 动作——player 屏蔽+静音（需管理员本人绑定 VRChat Cookie，graceful：无 ID/无 Cookie/远程失败均不阻断本地落库），avatar 仅站内处理（VRChat 无「隐藏他人头像」官方写接口）。远程结果写 `moderations.remote_result`（`{"applied":true,"block","mute"}` 或 `{"applied":false,"reason"}`）；已通过项可撤销（unblock/unmute），撤销后追加 `revoked:true` 与 `unblock`/`unmute` 状态（`skipped:*`/`error:*` 前缀表未执行/失败）。

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `POST /api/moderations` | 登录 | `{targetType:'player'\|'avatar', targetUserId, reason}` | `{success,ok}`；非法类型/无效目标/空理由/超500字/自举 400；同人同目标待处理去重 409 |
| `GET /api/moderations?status=pending&page=1&pageSize=20` | 管理员 | — | `{items,total,page,pageSize}`；`status` 限 `pending/approved/rejected`；`items[].remoteResult` 为 `remote_result` JSON 字符串（供队列回显 block/mute 状态） |
| `POST /api/moderations/:id/resolve` | 管理员 | `{action:'approve'\|'reject', note?}` | `{status, remote}`；不存在 404；已处理 409；`approve` 触发远程 block+mute 并落库 `remote_result` |
| `POST /api/moderations/:id/revert` | 管理员 | — | `{remote:{unblock,unmute}, revoked:true}`；不存在 404；非 `approved` 409；avatar 仅标 `revoked` 不调远程 |

### 14.9 注册激活码（`admin_users.js`，前缀 `/api/admin/activation-codes`）

> 任务 X/Y/Z 落地：注册激活码用于 `POST /api/auth/register` 自助注册（见 §3.1）。离线文件存储（默认 `server/data/activation-codes.json`，环境变量 `ACTIVATION_CODES_FILE` 可覆盖），全部接口仅 `super_admin`；一码一用（已使用 / 已作废 / 已过期均拒绝消耗）。生成、作废对运维面板 `/api/activation-codes/*`（独立 panel token 鉴权，见 20 号文档 §六）与 `jingtu.ps1 [A]` 菜单、`server/scripts` CLI 即时生效——四处共用同一存储文件。

| 方法与路径 | 权限 | 请求 | 成功/业务响应 |
|---|---|---|---|
| `POST /api/admin/activation-codes/generate` | 超管 | `{count, note?, expiresDays?}`（`expiresDays` 0-3650，0=永久） | `{success:true,codes,count,expiresAt,message}` |
| `GET /api/admin/activation-codes` | 超管 | — | `{success:true,total,used,unused,revoked,expired,codes}`；响应 `Cache-Control: no-store`（未使用码等同凭据） |
| `POST /api/admin/activation-codes/sync` | 超管 | `{codes[]}` | `{success:true,imported,skipped,invalid,alreadySynced}`（离线端导入主站，走 `importCodes` 去重校验） |
| `POST /api/admin/activation-codes/revoke` | 超管 | `{code, reason?}` | `{success:true,code,revoked_at,message}` |

> 配套 CLI（`server/scripts/`）：`generate-activation-codes.js` / `list-activation-codes.js`（unused 过滤含过期未用）/ `verify-activation-code.js` / `revoke-activation-code.js` / `consume-activation-code.js`。离线对接与 P2P 联动详见 `docs/25-激活码离线对接说明-P2P联动.md`。

