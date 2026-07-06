# 境途同游 (JingTu Web) 项目文档 V6.2

> VRChat 群组网站 — 论坛化账号体系 + 活动管理 + 相册 + 地图 + 权限组系统  
> 最后更新: 2026-06-21 (16:02, 第15轮修复)

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构设计](#2-架构设计)
3. [数据库设计](#3-数据库设计)
4. [API 参考](#4-api-参考)
5. [权限组系统](#5-权限组系统)
6. [前端模块说明](#6-前端模块说明)
7. [部署指南](#7-部署指南)
8. [功能清单](#8-功能清单)

---

## 1. 项目概述

### 技术栈

| 层 | 技术 |
|---|------|
| **后端** | Node.js 22 + Express 4 |
| **数据库** | MySQL 5.7 (utf8mb4) |
| **Session** | express-session (内存存储) |
| **认证** | bcryptjs + AES-256-CBC + CSRF Token |
| **前端** | Vanilla JS (SPA) + CSS Variables 主题系统 |
| **地图** | Leaflet + OpenStreetMap |
| **实时** | WebSocket (在线状态) |
| **图片** | Multer + Sharp (头像/相册) |

### 端口

| 服务 | 端口 |
|------|------|
| Node.js | 3456 |
| Nginx | 80 (反向代理) |
| MySQL | 3306 |

---

## 2. 架构设计

```
jingtu-web/
├── public/
│   ├── index.html           # 单页 HTML 结构 (~1050 行)
│   ├── css/
│   │   └── style.css        # 全部样式 (~2050 行)
│   ├── js/
│   │   ├── core.js          # 全局状态 + 工具函数 + API封装
│   │   ├── theme.js         # 主题系统 (手动/自动/定时)
│   │   ├── auth.js          # 登录/登出/自动登录/粒子背景
│   │   ├── ui.js            # UI更新/Tab切换/通知面板/弹窗
│   │   ├── main.js          # 入口初始化/事件绑定/搜索
│   │   ├── members.js       # 成员列表/筛选/名片
│   │   ├── announcements.js # 公告CRUD
│   │   ├── events.js        # 活动三态/评论/编辑
│   │   ├── vrc.js           # VRChat World搜索/2FA
│   │   ├── map.js           # 地图双视图
│   │   ├── album.js         # 相册/灯箱/批量删除/回收站
│   │   ├── admin.js         # 管理面板/权限组/改名审核
│   │   ├── birthday.js      # 生日专区
│   │   ├── profile.js       # 个人中心/VRChat绑定/改名
│   │   └── init.js          # 系统初始化
│   └── assets/              # 群组图片资源
├── server/
│   ├── server.js            # Express 主入口 (~1285 行)
│   ├── db.js                # 数据库连接池
│   ├── db_init.js           # 建库建表 + 默认数据
│   ├── auth.js              # 认证中间件 + AES/bcrypt
│   ├── vrc.js               # VRChat API 客户端
│   ├── schedule.js          # 定时任务
│   ├── routes/
│   │   ├── auth.js          # 认证路由
│   │   ├── users.js         # 用户路由
│   │   └── permission_groups.js  # 权限组路由 (新)
│   └── session.json         # VRChat 系统登录缓存
└── docs/
    ├── design-v5.2-final.md
    ├── project-improvement.md
    └── project-docs-v6.2.md  # 本文档
```

### 认证流程

```
┌──────────┐     ┌──────────────┐     ┌──────────┐
│  登录页面  │────▶│  密码/VRCLogin  │────▶│ Session  │
│          │     │  初始化引导    │     │ userId   │
│          │     │  游客模式     │     │ role     │
└──────────┘     └──────────────┘     └──────────┘
                        │
                        ▼
                ┌──────────────┐
                │  权限中间件    │
                │ requireAuth   │
                │ requireRole   │
                │ requireAdmin  │
                └──────────────┘
                        │
                        ▼
                ┌──────────────┐
                │  权限组系统    │
                │ 多组归属       │
                │ 权限继承      │
                │ 冲突检测      │
                └──────────────┘
```

---

## 3. 数据库设计

### 表清单 (20 张表)

| # | 表名 | 说明 | 行数参考 |
|---|------|------|---------|
| 1 | `users` | 用户账号表 | 主表 |
| 2 | `sys_admin` | 管理员表 | 小 |
| 3 | `sys_oper_log` | 操作日志 | 大 |
| 4 | `announcement` | 公告 | 中 |
| 5 | `event` | 活动 | 中 |
| 6 | `event_sign` | 活动报名 | 大 |
| 7 | `event_checkin` | 活动签到 | 中 |
| 8 | `event_comment` | 活动评论 | 大 |
| 9 | `album_cate` | 相册分类 | 小 |
| 10 | `album_photo` | 相册照片 | 大 |
| 11 | `album_like` | 照片点赞 | 大 |
| 12 | `album_comment` | 照片评论 | 大 |
| 13 | `user_profile` | 用户资料扩展 | 中 |
| 14 | `group_roster` | 群组成员名单 | 中 |
| 15 | `member_note` | 成员备注 | 小 |
| 16 | `name_change_requests` | 改名申请 | 中 |
| 17 | `permissions` | 权限开关(旧) | 小 |
| 18 | `vrc_worlds_cache` | World 缓存 | 小 |
| 19 | `notifications` | 通知 | 大 |
| 20 | `permission_groups` | 权限组 (新) | 小 |
| 21 | `group_permission_entries` | 权限条目 (新) | 中 |
| 22 | `user_group_membership` | 用户组归属 (新) | 中 |

### 核心表 ER

```
users
├── id (PK)
├── login_id (UNIQUE)        # 登录ID
├── display_name             # 显示名
├── password_hash            # bcrypt哈希
├── role                     # super_admin/admin/member/guest
├── vrchat_id (UNIQUE)       # VRChat绑定ID
├── vrchat_name
├── avatar_type              # vrchat/custom/none
├── custom_avatar_path
├── vrchat_avatar_url
├── birthday
├── location / lat / lng
├── location_visible
├── preferences (JSON)
├── deleted_at               # 软删除
├── created_at
└── updated_at

event
├── id (PK)
├── title / place / description
├── event_time / ends_at
├── max_sign
├── event_type               # activity/birthday
├── visibility               # public/members_only
├── world_id / world_name / world_image_url
├── vrchat_event_id (UNIQUE)
├── is_archive
└── source                   # manual/vrchat

permission_groups
├── id (PK)
├── name (UNIQUE)
├── description
├── parent_id (FK → self)
├── is_default               # 新用户自动加入
├── is_system                # 不可删除
├── created_at / updated_at

group_permission_entries
├── id (PK)
├── group_id (FK → permission_groups)
├── permission_key           # can_create_event, ...
├── permission_value         # 0/1
└── UNIQUE(group_id, permission_key)

user_group_membership
├── id (PK)
├── user_id (FK → users)
├── group_id (FK → permission_groups)
├── joined_at
└── UNIQUE(user_id, group_id)
```

---

## 4. API 参考

### 认证 API

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/auth/init` | 检查是否需要初始化 | 公开 |
| POST | `/api/auth/init` | 创建超级管理员 | 公开 |
| POST | `/api/auth/login` | 密码登录 | 公开 (限流15/m) |
| POST | `/api/auth/vrchat-login` | VRChat登录 | 公开 (需绑定) |
| POST | `/api/auth/vrchat-bind` | 绑定VRChat | 登录 |
| POST | `/api/auth/vrchat-unbind` | 解绑VRChat | 登录 |
| POST | `/api/auth/vrchat-2fa` | VRChat 2FA验证 | 临时session |
| POST | `/api/auth/logout` | 退出 | 登录 |
| GET | `/api/auth/session` | 获取当前会话 | 公开 |
| POST | `/api/auth/change-password` | 修改密码 | 登录 |
| GET | `/api/csrf-token` | 获取CSRF令牌 | 公开 |

### 用户 API

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/users/list` | 公开成员列表 | 无 |
| GET | `/api/users` | 用户管理列表 | admin |
| POST | `/api/users` | 创建用户 | super_admin |
| GET | `/api/users/birthdays` | 生日列表 | 公开 |
| GET | `/api/users/all/locations` | 所有公开位置 | 登录 |
| GET | `/api/users/:id` | 获取单个用户 | admin |
| PUT | `/api/users/:id` | 更新用户 | admin |
| DELETE | `/api/users/:id` | 删除用户 | admin |
| POST | `/api/users/:id/reset-password` | 重置密码 | admin |
| GET | `/api/users/me/profile` | 我的资料 | 登录 |
| PUT | `/api/users/me/profile` | 更新资料 | 登录 |
| POST | `/api/users/me/avatar` | 上传头像 | 登录 |
| POST | `/api/users/me/avatar-vrchat` | 切换VRChat头像 | 登录 |
| DELETE | `/api/users/me/avatar` | 移除头像 | 登录 |
| PUT | `/api/users/me/location` | 更新位置 | 登录 |
| GET | `/api/users/:id/card` | 用户名片 | 登录 |

### 权限组 API (新)

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/permission-groups/groups` | 所有权限组 | super_admin |
| POST | `/api/permission-groups/groups` | 创建权限组 | super_admin |
| PUT | `/api/permission-groups/groups/:id` | 更新权限组 | super_admin |
| DELETE | `/api/permission-groups/groups/:id` | 删除权限组 | super_admin |
| GET | `/api/permission-groups/groups/:id/permissions` | 获取组权限 | super_admin |
| POST | `/api/permission-groups/groups/:id/permissions/set` | 设置单条权限 | super_admin |
| POST | `/api/permission-groups/groups/:id/permissions/batch` | 批量设置权限 | super_admin |
| GET | `/api/permission-groups/users/:userId/groups` | 用户组归属 | super_admin |
| POST | `/api/permission-groups/users/:userId/groups` | 添加用户到组 | super_admin |
| DELETE | `/api/permission-groups/users/:userId/groups/:groupId` | 从组移除用户 | super_admin |
| GET | `/api/permission-groups/my` | 我的有效权限 | 登录 |
| GET | `/api/permission-groups/definitions` | 权限定义列表 | super_admin |

### 活动 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/events` | 活动列表（支持status/type参数） |
| GET | `/api/events/detail/:id` | 活动详情 |
| GET | `/api/events/with-worlds` | 关联World的活动 |
| POST | `/api/events` | 创建活动 (admin) |
| PUT | `/api/events/:id` | 编辑活动 (admin) |
| DELETE | `/api/events/:id` | 删除活动 (admin) |
| POST | `/api/events/:id/sign` | 报名活动 |
| POST | `/api/events/:id/unsign` | 取消报名 |
| GET | `/api/events/:id/signs` | 报名列表 |
| GET | `/api/events/:id/comments` | 活动评论列表 |
| POST | `/api/events/:id/comments` | 发布评论 |
| DELETE | `/api/events/:eventId/comments/:commentId` | 删除评论 |
| POST | `/api/events/sync-vrchat` | 同步VRChat日历 (admin) |
| GET | `/api/events/birthday-parties` | 生日派对 |
| POST | `/api/events/:id/archive` | 归档活动 |
| POST | `/api/events/:id/unarchive` | 恢复活动 |

### 公告 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/announcements` | 公告列表 |
| GET | `/api/announcements/:id` | 公告详情 |
| POST | `/api/announcements` | 发布公告 (admin) |
| DELETE | `/api/announcements/:id` | 删除公告 (admin) |

### 相册 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/album/photos` | 照片列表 |
| POST | `/api/upload` | 上传照片 |
| DELETE | `/api/photos/:id` | 删除照片 |
| POST | `/api/photos/:id/like` | 点赞 |
| DELETE | `/api/photos/:id/like` | 取消点赞 |
| GET | `/api/photos/:id/comments` | 评论列表 |
| POST | `/api/photos/:id/comments` | 发表评论 |
| DELETE | `/api/photos/:photoId/comments/:commentId` | 删除评论 |
| POST | `/api/album/photos/batch-delete` | 批量删除 |
| GET | `/api/album/recycle` | 回收站 |
| POST | `/api/album/photos/:id/restore` | 恢复照片 |
| DELETE | `/api/album/photos/:id/permanent` | 永久删除 |

### VRChat API

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| POST | `/api/login` | 系统VRChat登录 | admin |
| POST | `/api/2fa` | 系统2FA | admin |
| POST | `/api/logout` | 系统VRChat登出 | admin |
| GET | `/api/health` | 系统状态 | 公开 |
| POST | `/api/vrc/lookup` | 查VRChat用户 | 登录 |
| GET | `/api/group` | 群组信息 | 公开 |
| GET | `/api/vrc/world/:worldId` | World详情 | 登录 |
| GET | `/api/vrc/worlds/search` | 搜索World | 登录 |
| GET | `/api/group/check/:vrchatId` | 群组验证 | 公开 |

### 通知 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/notifications` | 通知列表+未读数 |
| POST | `/api/notifications/:id/read` | 标记已读 |
| POST | `/api/notifications/read-all` | 全部已读 |

### 改名 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/name-change/request` | 提交申请 |
| GET | `/api/name-change/my-requests` | 我的申请 |
| GET | `/api/name-change/pending` | 待审核 (admin) |
| GET | `/api/name-change/all` | 全部记录 (admin) |
| POST | `/api/name-change/review` | 审核处理 (admin) |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/search` | 全局搜索 |
| GET | `/api/logs` | 操作日志 (admin) |
| GET | `/api/avatar/default` | 默认头像SVG |
| POST | `/api/admin/roster/sync` | 同步名册 (admin) |
| POST | `/api/admin/group-image` | 上传群图 (admin) |
| GET | `/api/permissions` | 权限列表 (admin) |
| POST | `/api/permissions/set` | 设置权限 (admin) |

---

## 5. 权限组系统

### 概述

权限组系统(V6.2)取代了原有的单用户权限开关模型，支持：

- **多组归属**：一个用户可以同时属于多个权限组
- **组继承**：子组自动继承父组权限（可覆盖）
- **默认组**：新注册用户自动加入默认组（"成员"）
- **冲突检测**：加入同层级组时提示潜在冲突
- **权限合并**：多组权限取并集（任一组合许即可）

### 内置组

| 组名 | 系统内置 | 默认组 | 权限范围 |
|------|---------|--------|---------|
| 超级管理员 | ✅ | ❌ | 全部27项权限 |
| 管理员 | ✅ | ❌ | 除管理权限/角色外的全部 |
| 成员 | ✅ | ✅ | 基础权限（上传/报名/评论/编辑资料等） |
| 访客 | ✅ | ❌ | 只读（查看成员/相册/活动） |

### 完整权限列表 (27项)

| 键 | 标签 | 说明 |
|---|------|------|
| `can_create_album` | 创建相册 | 创建相册分类 |
| `can_create_photo` | 上传照片 | 上传照片到相册 |
| `can_delete_photo` | 删除照片 | 删除自己的照片 |
| `can_create_announcement` | 发布公告 | 发布群公告 |
| `can_edit_announcement` | 编辑公告 | 修改已有公告 |
| `can_delete_announcement` | 删除公告 | 删除公告 |
| `can_create_event` | 创建活动 | 发起VRChat活动 |
| `can_edit_event` | 编辑活动 | 修改活动信息 |
| `can_delete_event` | 删除活动 | 取消活动 |
| `can_sign_event` | 报名活动 | 参加活动 |
| `can_comment_event` | 活动评论 | 在活动中发言 |
| `can_manage_users` | 管理用户 | 增删改用户账号 |
| `can_manage_roles` | 管理角色 | 修改用户角色 |
| `can_review_names` | 审核改名 | 审批改名申请 |
| `can_manage_permissions` | 管理权限 | 修改权限组/权限 |
| `can_sync_vrchat` | 同步VRChat | 同步日历/群组 |
| `can_manage_rosters` | 管理名册 | 管理群组成员名单 |
| `can_view_logs` | 查看日志 | 查看操作日志 |
| `can_upload_group_image` | 上传群图 | 更换群组头像/横幅 |
| `can_edit_profile` | 编辑资料 | 修改个人资料 |
| `can_change_password` | 修改密码 | 更改登录密码 |
| `can_view_members` | 查看成员 | 浏览成员列表 |
| `can_view_map` | 查看地图 | 使用地图功能 |
| `can_view_album` | 查看相册 | 浏览照片 |
| `can_view_events` | 查看活动 | 浏览活动列表 |
| `can_create_album_category` | 创建相册分类 | 管理相册分类 |

---

## 6. 前端模块说明

### 模块依赖图

```
core.js (工具函数/API/CSRF)
  ├── theme.js (主题)
  ├── auth.js (登录)
  │     └── init.js (初始化)
  ├── ui.js (UI更新/Tab/通知)
  │     ├── members.js (成员)
  │     ├── announcements.js (公告)
  │     ├── events.js (活动)
  │     │     └── vrc.js (World搜索)
  │     ├── map.js (地图)
  │     ├── album.js (相册)
  │     ├── admin.js (管理) ← 含权限组
  │     ├── birthday.js (生日)
  │     └── profile.js (个人中心)
  └── main.js (入口/事件绑定)
```

### 全局变量

| 变量 | 说明 | 定义位置 |
|------|------|---------|
| `currentUser` | 当前登录用户对象 | core.js |
| `csrfToken` | CSRF令牌 | core.js |
| `membersCache` | 成员缓存数组 | core.js |
| `albumsCache` | 相册缓存 | core.js |
| `eventsCache` | 活动缓存 | events.js |
| `activeTab` | 当前Tab名 | core.js |
| `map` | Leaflet地图实例 | map.js |
| `pgGroupsCache` | 权限组缓存 | admin.js |

### 核心函数

```javascript
// API 封装
api(url, options)          // JSON请求 (自动CSRF)
apiForm(url, formData)     // 表单上传

// UI 工具
toast(msg, type)           // 消息提示
showModal(id)              // 显示弹窗
showConfirm(msg, cb)       // 确认对话框
esc(str)                   // HTML转义
safeUrl(str)               // URL安全编码
fmtDate(date)              // 日期格式化
```

---

## 7. 部署指南

### 环境要求

- Node.js >= 18
- MySQL >= 5.7
- Nginx (可选，用于反向代理)

### 安装步骤

```bash
# 1. 克隆项目
git clone <repo> jingtu-web
cd jingtu-web

# 2. 安装依赖
cd server
npm install express mysql2 bcryptjs cors express-session multer sharp ws dotenv express-rate-limit

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入数据库配置

# 4. 启动
node server.js

# 5. 打开浏览器
# http://localhost:3456
# 首次访问 → 创建超级管理员
```

### .env 配置

```ini
# 数据库配置
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=root
MYSQL_DATABASE=jingtu_group

# VRChat API Key（从VRC SDK获取）
VRC_API_KEY=JlE5Jldo5Jibnk5O5hTx6XVqsJu4WJ26

# Session密钥（随机生成）
SESSION_SECRET=

# AES加密密钥（64位hex）
ENCRYPT_KEY=

# VRChat账号（系统级，可选）
VRC_USERNAME=
VRC_PASSWORD=
```

### Nginx 反向代理配置

```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    client_max_body_size 20m;
    
    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

---

## 8. 功能清单

### ✅ 已完成

| 功能 | 状态 | 说明 |
|------|------|------|
| 密码登录 | ✅ | bcrypt加密 + 强度校验 |
| VRChat双轨登录 | ✅ | 绑定后可用VRChat账号登录 |
| 2FA验证 | ✅ | TOTP + Email OTP 双模式 |
| 游客模式 | ✅ | 访客可浏览公开内容 |
| 内容可见性 | ✅ | 公开/成员专属 两级 |
| 成员列表 | ✅ | 搜索+角色筛选+名片 |
| 公告系统 | ✅ | CRUD + 置顶 + 可见性 |
| 活动三态 | ✅ | 进行中/即将到来/往期 |
| 活动报名/评论 | ✅ | 含人数上限 |
| VRChat日历同步 | ✅ | 从VRChat拉取活动 |
| World搜索+关联 | ✅ | 关联VRChat World |
| 相册系统 | ✅ | 上传/灯箱/点赞/评论 |
| 批量删除/回收站 | ✅ | 选择模式+恢复+永久删除 |
| 全员位置地图 | ✅ | Leaflet + OSM 双视图 |
| 个人中心 | ✅ | 头像/资料/VRChat绑定/密码 |
| 改名申请 | ✅ | 提交+审核+通知 |
| 通知系统 | ✅ | 铃铛徽章+已读管理 |
| 操作日志 | ✅ | 记录所有重要操作 |
| 权限组系统 | ✅ | 多组归属/继承/冲突检测/27项权限 |
| 主题系统 | ✅ | 手动/自动/定时+自定义色 |
| WebSocket在线 | ✅ | 实时在线用户列表 |
| CSRF保护 | ✅ | 同步令牌模式 |
| 速率限制 | ✅ | 600通用/15认证 每分钟 |

### 🚧 待完善

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 通知推送 | P2 | WebSocket/邮件推送 |
| 活动日历视图 | P3 | 月历/周历展示 |
| 数据仪表盘 | P4 | 成员/活动统计数据 |
| 首页欢迎页 | P4 | 信息聚合仪表盘 |

---

## 附录：常见问题

### Q: 为什么有些页面显示401？
A: 需要登录。游客模式只能看到公开内容。

### Q: 如何给用户设置权限？
A: 管理员面板 → 权限组管理 → 选择组 → 设置权限。或切换到"用户归属"标签 → 管理具体用户的组归属。

### Q: 忘记超级管理员密码怎么办？
A: 直接操作数据库 `UPDATE users SET password_hash = ? WHERE role = 'super_admin'` 用bcrypt生成新密码哈希。

### Q: VRChat API 调用失败？
A: 需要先登录系统VRChat账号（管理员面板 → 系统VRChat账号 → 登录）。API Key使用VRChat官方公开密钥。

---

## 附录：版本历史

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| V6.2 | 2026-06-21 | 权限组系统（3张表+12 API+4内置组+27项权限+多组归属+冲突检测）；登录密码问题修复；角色标识统一(member/guest)；VRChat绑定UI优化；地图视图切换修复；文档更新 |
| V5.6 | 2026-06-20 | VRChat World活动地图；World搜索+缓存；活动关联World；前端World选择/预览 |
| V5.5 | 2026-06-20 | 主题系统（手动/系统/定时）；自定义主题色；CSS变量重构 |
| V5.3 | 2026-06-19 | 活动三态+VRChat日历同步+生日专区+改名申请+权限管理+数据库迁移脚本 |
| V5.2 | 2026-06-16 | 论坛化账号体系+游客模式+内容可见性+CSRF+rate-limit+Session认证 |
