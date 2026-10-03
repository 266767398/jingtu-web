# 04 · API 接口总览

> 默认基址 `http://<host>:3456`。完整端点清单见 `docs/archive/05-API接口全文档.md`；本文为索引级概览。

## 1. 全局约定

- 请求体：JSON 全局 20MB；非上传 POST/PUT 5MB；上传分档（头像 5MB / 群图 10MB / 直播缩略图 20MB /
  聊天 100MB / 动态与个人相册 200MB / 主相册 500MB），8 个上传路由均过扩展名+魔数双闸。
- Session Cookie `connect.sid`：7 天滚动、HttpOnly、SameSite=Lax。
- 响应格式**不统一**（`{success:true}` / `{ok:true}` / 裸对象 / 数组 / 文件 / 重定向并存），对接以各接口实测为准。
- 版本：`/api` 前缀 + `apiVersion` 头；`/api-docs` 仅 `ENABLE_SWAGGER=1` 且超管会话可见。

## 2. 权限记号

| 记号 | 说明 |
|---|---|
| 公开 | 无需登录 |
| `requireAuth` | 登录即可（只校验 userId 存在） |
| `requireAdminCompat` | admin + super_admin |
| `requireSuperAdmin` | 仅超级管理员（运维/安全类接口） |
| 聊天/直播 | `requireChatAuth` 等专用守卫 |

## 3. CSRF

- `GET /api/csrf-token` 取 token；除 GET/HEAD/OPTIONS 外默认全校验。
- 精确豁免 15 条路径（登录/init/登出/密码重置/setup 全流程）。
- 前端 `window.api()` 自动带 token，勿手动处理。

## 4. 接口族

| 族 | 前缀 | 要点 |
|---|---|---|
| 认证 | `/api/auth` | init/login/register(激活码)/logout/session/改密/vrchat-login/2FA/找回密码 |
| 用户 | `/api/users`、`/api/profile` | 列表/生日/位置/搜索/Me 系列 / 管理员 CRUD / 导出 / 注销 |
| 内容 | `/api/posts`、`/api/events`、`/api/event-teams`、`/api/announcements` | 动态（无编辑端点）；活动约 40 端点（签到/签核/QR/日历/iCal/批量删除/归档） |
| 社交 | `/api/friends`、`/api/follows`、`/api/collections`、`/api/user-like`、`/api/checkin`、`/api/achievements` | 好友/关注/统一收藏馆（18+ 端点）/点赞/签到/成就 |
| 实时 | `/api/chat`（约 25）、`/api/live`（约 15）、`/api/notifications`（约 10） | 聊天含群聊管理/媒体 100MB；通知站内 |
| 群组/VRC | `/api/group/*`、`/api/vrc/*`、`/api/moderations` | 群组管理 + VRC lookup/world/search/avatar；审核队列（远程 block/mute 回显） |
| 收藏模型 | `/api/model-collections`、`/api/world-tags`、`/api/avatar-tags` | 旧模型收藏 / 标签 |
| 权限组 | `/api/permission-groups` | 三张表权限模型（30 个 can_* 键） |
| 运维 | `/api/admin/*` | db/backups/config/env-reload/files/logs/security/analytics/export/webhooks/activation-codes/git-status/git-update/git-restart |
| 系统 | `/api/system/*`、`/api/migration`、`/api/health/*`、`/api/sitemap`、`/api/share` | db-recover（RECOVERY_TOKEN 口令）、迁移工具、健康、站点地图 |

## 5. 限流（分层）

| 对象 | 限制 |
|---|---|
| `/api` 全局 | 600 次 / 分 / IP |
| 登录 | 5 次 / 15 分钟（成功跳过） |
| 上传 | 10 次 / 分（3 个入口） |
| 管理 | 30 次 / 分 |
| 搜索 | 20 次 / 30 秒 |

计数 HybridStore：配置 `REDIS_HOST` 用 Redis 共享态，否则回退进程内 Map（单实例必守）。

## 6. 已知实现差异（对接时注意）

- `/api/search` 有两个 GET 处理器（server.js 登录版先注册优先）。
- `users/me/profile` 前端兼容 `data.user || data`。
- `posts` 的 `limit` 参数被忽略。
- 上传字段命名以代码为准：`photo/media/photos/video/avatar/file/thumbnail/image`。
- 直播 `/live/user/history` 被流式参数路由遮蔽不可达（历史遗留）。