# 境途同游 项目文档

> **VRChat 群组网站** | V5.2 论坛化账号体系
> 最后更新: 2026-06-19

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [功能模块](#3-功能模块)
4. [数据库结构](#4-数据库结构)
5. [API 接口文档](#5-api-接口文档)
6. [部署说明](#6-部署说明)
7. [项目文件结构](#7-项目文件结构)
8. [安全规范](#8-安全规范)

---

## 1. 项目概述

境途同游是一个为 VRChat 群组打造的社区网站，提供群组信息展示、公告管理、活动组织、照片分享、成员管理等功能。

### 核心特性

- **VRChat 双轨认证** — 支持本地密码登录与 VRChat 账号绑定登录
- **四元权限体系** — super_admin / admin / editor / user
- **活动管理** — 创建、编辑、报名、归档
- **相册系统** — 照片上传、分类、点赞、评论、回收站
- **群组展示** — 实时成员列表、在线状态、角色展示
- **安全机制** — CSRF 保护、速率限制、密码强度校验、AES 加密

---

## 2. 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 后端框架 | Node.js + Express | ≥16 |
| 数据库 | MySQL | 5.7+ |
| 会话管理 | express-session | — |
| 密码加密 | bcryptjs | 12 rounds |
| 数据加密 | AES-256-CBC (crypto) | — |
| 图像处理 | sharp | — |
| 文件上传 | multer | — |
| 定时任务 | node-schedule | — |
| 速率限制 | express-rate-limit | — |
| 前端 | 原生 HTML + CSS + JavaScript | SPA 单页应用 |

---

## 3. 功能模块

### 3.1 认证系统

| 功能 | API 路径 | 说明 |
|------|----------|------|
| 系统初始化 | `GET /api/auth/init` | 检测是否需要创建首个超管 |
| 创建超管 | `POST /api/auth/init` | 创建首个 super_admin |
| 密码登录 | `POST /api/auth/login` | loginId + password → session |
| VRChat 登录 | `POST /api/auth/vrchat-login` | VRChat 账号密码 → 绑定用户 → session |
| VRChat 2FA | `POST /api/auth/vrchat-2fa` | 两步验证 |
| VRChat 绑定 | `POST /api/auth/vrchat-bind` | 已登录用户绑定 VRChat |
| VRChat 解绑 | `POST /api/auth/vrchat-unbind` | 解绑 VRChat |
| 退出登录 | `POST /api/auth/logout` | 销毁 session |
| 获取会话 | `GET /api/auth/session` | 当前登录信息 |
| 修改密码 | `POST /api/auth/change-password` | 需要旧密码 |

### 3.2 公告管理

| 功能 | API 路径 | 权限 |
|------|----------|------|
| 获取公告列表 | `GET /api/announcements` | 公开（会员可见更多） |
| 发布公告 | `POST /api/announcements` | admin+ |
| 编辑公告 | `PUT /api/announcements/:id` | admin+ |
| 删除公告 | `DELETE /api/announcements/:id` | admin+ |
| 置顶/取消置顶 | `POST /api/announcements/:id/pin` | admin+ |

### 3.3 活动管理

| 功能 | API 路径 | 权限 |
|------|----------|------|
| 获取活动列表 | `GET /api/events` | 公开（会员可见更多） |
| 获取归档活动 | `GET /api/events/archive` | 公开 |
| 获取活动详情 | `GET /api/events/:id` | 公开（会员可见更多） |
| 创建活动 | `POST /api/events` | admin+ |
| 编辑活动 | `PUT /api/events/:id` | admin+ |
| 删除活动 | `DELETE /api/events/:id` | admin+ |
| 活动报名 | `POST /api/events/:id/sign` | 登录用户 |
| 取消报名 | `POST /api/events/:id/unsign` | 登录用户 |
| 报名列表 | `GET /api/events/:id/signs` | 公开 |
| 我的报名 | `GET /api/events/my-signs` | 登录用户 |
| 活动照片列表 | `GET /api/events/:id/photos` | 公开 |
| 上传活动照片 | `POST /api/events/:id/photos` | 登录用户 |

### 3.4 相册管理

| 功能 | API 路径 | 权限 |
|------|----------|------|
| 获取分类列表 | `GET /api/album/categories` | 公开 |
| 创建分类 | `POST /api/album/categories` | admin+ |
| 删除分类 | `DELETE /api/album/categories/:id` | admin+ |
| 获取照片列表 | `GET /api/album/photos` | 公开 |
| 上传照片 | `POST /api/album/upload` | 登录用户 |
| 删除照片 | `DELETE /api/album/photos/:id` | 登录用户/管理员 |
| 点赞 | `POST /api/album/photos/:id/like` | 登录用户 |
| 取消点赞 | `POST /api/album/photos/:id/unlike` | 登录用户 |
| 评论列表 | `GET /api/album/photos/:id/comments` | 公开 |
| 发表评论 | `POST /api/album/photos/:id/comments` | 登录用户 |
| 删除评论 | `DELETE /api/album/comments/:id` | 登录用户/管理员 |
| 回收站列表 | `GET /api/album/recycle` | admin+ |
| 恢复照片 | `POST /api/album/photos/:id/restore` | admin+ |
| 永久删除 | `DELETE /api/album/photos/:id/permanent` | admin+ |

### 3.5 用户管理

| 功能 | API 路径 | 权限 |
|------|----------|------|
| 用户列表 | `GET /api/users` | admin+ |
| 创建用户 | `POST /api/users` | super_admin |
| 用户详情 | `GET /api/users/:id` | admin+ |
| 更新用户 | `PUT /api/users/:id` | admin+ |
| 软删除用户 | `DELETE /api/users/:id` | admin+ |
| 重置密码 | `POST /api/users/:id/reset-password` | admin+ |
| 我的资料 | `GET /api/users/me/profile` | 登录用户 |
| 更新资料 | `PUT /api/users/me/profile` | 登录用户 |
| 上传头像 | `POST /api/users/me/avatar` | 登录用户 |
| 切换 VRChat 头像 | `POST /api/users/me/avatar-vrchat` | 登录用户 |
| 移除头像 | `DELETE /api/users/me/avatar` | 登录用户 |
| 更新位置 | `PUT /api/users/me/location` | 登录用户 |
| 全员位置 | `GET /api/users/all/locations` | 登录用户 |

### 3.6 个人资料 (旧版)

| 功能 | API 路径 | 说明 |
|------|----------|------|
| 获取资料 | `GET /api/user/profile` | motto + bio |
| 更新资料 | `PUT /api/user/profile` | — |
| 我的照片 | `GET /api/user/my-photos` | — |
| 我的活动 | `GET /api/user/my-events` | — |

### 3.7 群组与系统

| 功能 | API 路径 | 说明 |
|------|----------|------|
| 系统健康检查 | `GET /api/health` | — |
| CSRF Token | `GET /api/csrf-token` | — |
| 群组实时统计 | `GET /api/group/stats` | 在线/总人数 |
| 群组完整数据 | `GET /api/group` | 含成员列表 |
| 群组图片 | `GET /api/group/images` | — |
| 更换群组头像 | `POST /api/group/avatar` | admin+ |
| 更换横幅 | `POST /api/group/banner` | admin+ |
| 更换 Hero 图 | `POST /api/group/hero` | admin+ |
| 同步群组成员 | `POST /api/admin/roster/sync` | admin+ |
| 查看群组名单 | `GET /api/admin/roster` | admin+ |
| 检查群组成员 | `GET /api/roster/check/:vrchatId` | 限流 30/min |
| VRChat 系统登录 | `POST /api/login` | 系统级 |
| 2FA 验证 | `POST /api/2fa` | 系统级 |
| 系统退出 | `POST /api/logout` | — |
| 系统会话 | `GET /api/session` | — |

### 3.8 管理员 (旧版)

| 功能 | API 路径 | 说明 |
|------|----------|------|
| 初始化管理员 | `POST /api/admin/init` | 自动设置首位管理员 |
| 管理列表 | `GET /api/admin/list` | — |
| 添加管理员 | `POST /api/admin/add` | — |
| 移除管理员 | `POST /api/admin/remove` | — |
| 操作日志 | `GET /api/admin/logs` | 最近 50 条 |

---

## 4. 数据库结构

共 14 张表：

### 4.1 `sys_admin` — 旧版管理员表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| vrchat_id | VARCHAR(100) UNIQUE | VRChat ID |
| vrchat_name | VARCHAR(100) | VRChat 名称 |
| create_time | DATETIME | 创建时间 |

### 4.2 `sys_oper_log` — 操作日志表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| admin_vrcid | VARCHAR(100) | 操作者 ID |
| oper_type | VARCHAR(50) | 操作类型 |
| content | TEXT | 操作内容 |
| create_time | DATETIME | 创建时间 |

### 4.3 `announcement` — 公告表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| title | VARCHAR(255) | 标题 |
| content | TEXT | 内容 |
| create_admin | VARCHAR(100) | 发布者 |
| is_pinned | TINYINT | 是否置顶 |
| visibility | ENUM('public','members_only') | 可见性 |
| create_time | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间（自动） |

### 4.4 `event` — 活动表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| title | VARCHAR(255) | 标题 |
| place | VARCHAR(255) | 地点/世界 |
| event_time | DATETIME | 活动时间 |
| description | TEXT | 描述 |
| max_sign | INT | 人数上限（0=不限） |
| create_admin | VARCHAR(100) | 创建者 |
| is_archive | TINYINT | 是否归档 |
| visibility | ENUM('public','members_only') | 可见性 |
| create_time | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间（自动） |

### 4.5 `event_sign` — 活动报名表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| event_id | INT | 活动 ID |
| user_vrcid | VARCHAR(100) | 用户 ID |
| user_name | VARCHAR(100) | 用户名 |
| is_sign | TINYINT | 是否报名 |
| sign_time | DATETIME | 报名时间 |
| create_time | DATETIME | 创建时间 |

### 4.6 `album_cate` — 相册分类表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| cate_name | VARCHAR(100) UNIQUE | 分类名 |
| sort | INT | 排序 |
| create_time | DATETIME | 创建时间 |

### 4.7 `album_photo` — 照片表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| cate_id | INT | 分类 ID |
| event_id | INT NULL | 关联活动 ID |
| upload_vrcid | VARCHAR(100) | 上传者 ID |
| upload_name | VARCHAR(100) | 上传者名 |
| photo_path | VARCHAR(255) | 照片路径 |
| thumb_path | VARCHAR(255) | 缩略图路径 |
| photo_desc | TEXT | 描述 |
| like_count | INT | 点赞数 |
| visibility | ENUM('public','members_only') | 可见性 |
| is_recycle | TINYINT | 回收站 |
| recycle_time | DATETIME | 回收时间 |
| create_time | DATETIME | 创建时间 |

### 4.8 `album_like` — 点赞表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| photo_id | INT | 照片 ID |
| user_vrcid | VARCHAR(100) | 用户 ID |
| create_time | DATETIME | 创建时间 |

### 4.9 `album_comment` — 评论表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| photo_id | INT | 照片 ID |
| user_vrcid | VARCHAR(100) | 用户 ID |
| user_name | VARCHAR(100) | 用户名 |
| comment | TEXT | 评论内容 |
| create_time | DATETIME | 创建时间 |

### 4.10 `user_profile` — 用户资料表 (旧版)

| 字段 | 类型 | 说明 |
|------|------|------|
| vrchat_id | VARCHAR(100) PK | VRChat ID |
| motto | VARCHAR(200) | 个性签名 |
| bio | TEXT | 个人简介 |
| updated_at | TIMESTAMP | 更新时间 |

### 4.11 `users` — 用户表 V5.2

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| login_id | VARCHAR(50) UNIQUE | 登录 ID（不可改） |
| display_name | VARCHAR(100) | 显示名（超管可改） |
| vrchat_id | VARCHAR(100) UNIQUE | VRChat ID |
| vrchat_name | VARCHAR(100) | VRChat 显示名 |
| password_hash | VARCHAR(255) | bcrypt 哈希 |
| vrchat_verified | TINYINT | 是否通过群组成员验证 |
| role | ENUM(...) | super_admin/admin/editor/user |
| avatar_type | ENUM(...) | vrchat/custom/none |
| custom_avatar_path | VARCHAR(255) | 自定义头像 |
| vrchat_avatar_url | VARCHAR(500) | VRChat 头像 URL |
| qq_number_enc | VARCHAR(500) | QQ 号 (AES 加密) |
| birthday | DATE | 生日 |
| location | VARCHAR(200) | 所在地 |
| lat | DECIMAL(10,7) | 纬度 |
| lng | DECIMAL(10,7) | 经度 |
| location_visible | TINYINT | 位置可见开关 |
| preferences | JSON | 偏好设置 |
| vrchat_token_enc | VARCHAR(1000) | VRChat token (AES) |
| deleted_at | DATETIME | 软删除时间 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### 4.12 `group_roster` — 群组成员表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| vrchat_id | VARCHAR(100) UNIQUE | VRChat ID |
| vrchat_name | VARCHAR(100) | VRChat 名 |
| is_member | TINYINT | 是否会员 |
| synced_at | DATETIME | 同步时间 |
| create_time | DATETIME | 创建时间 |

### 4.13 `member_note` — 成员备注表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | 自增主键 |
| owner_vrcid | VARCHAR(100) | 备注者 |
| target_vrcid | VARCHAR(100) | 被备注者 |
| note_text | VARCHAR(200) | 备注内容 |
| update_time | DATETIME | 更新时间 |

---

## 5. 部署说明

### 5.1 环境要求

- Node.js ≥ 16
- MySQL ≥ 5.7
- NPM

### 5.2 安装步骤

```bash
# 克隆项目
cd /d/phpstudy_pro/WWW/jingtu-web

# 安装后端依赖
cd server
npm install

# 配置 .env 文件
# 编辑 .env 中的数据库连接信息
```

### 5.3 .env 配置

```env
MYSQL_HOST=127.0.0.1
MYSQL_USER=root
MYSQL_PASSWORD=root
MYSQL_DATABASE=jingtu_group
MYSQL_PORT=3306

SESSION_SECRET=<生成随机字符串>
ENCRYPT_KEY=<64位hex密钥：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
VRC_API_KEY=JlE5Jldo5Jibnk5O5hTx6XVqsJu4WJ26
NODE_ENV=development
```

### 5.4 启动方式

```bash
# 开发模式（自动数据库初始化）
node server/server.js

# 端口：3456
# 访问：http://localhost:3456
```

### 5.5 定时任务

| 时间 | 任务 | 说明 |
|------|------|------|
| 每天 2:00 | 回收站清理 | 删除超过 7 天的回收站照片 |
| 每天 3:00 | 活动归档 | 自动归档已过期活动 |
| 每天 12:00 | Token 提醒 | VRChat 系统账号 Token 验证提醒 |

### 5.6 前端访问

- 单页应用：`public/index.html`
- 资源文件：`assets/` 和 `uploads/`
- 支持深色/浅色主题

---

## 6. 安全规范

### 6.1 认证机制

- 使用 `express-session` 管理登录状态
- Session 配置：httpOnly cookie，24 小时过期
- CSRF 保护（同步令牌模式），对非 GET/HEAD/OPTIONS 请求验证

### 6.2 密码规范

- bcrypt 12 rounds 哈希
- 密码强度：至少 8 位，需含大小写字母和数字
- 密码修改需要验证旧密码

### 6.3 数据加密

- QQ 号使用 AES-256-CBC 加密存储
- 加密密钥来自 `ENCRYPT_KEY` 环境变量（64 位十六进制）
- VRChat token 同样使用 AES 加密存储

### 6.4 速率限制

- 通用 API：每 IP 每分钟 200 次
- 认证接口：每 IP 每分钟 10 次
- 成员检查：每 IP 每分钟 30 次

### 6.5 部署安全检查

- `SESSION_SECRET` 必须更换为随机字符串
- `ENCRYPT_KEY` 必须更换为随机 64 位 hex
- MySQL 密码不能使用默认值

---

## 7. 项目文件结构

```
jingtu-web/
├── .env                          # 环境配置
├── start-services.bat            # Windows 启动脚本
├── README.md                     # 项目说明
├── assets/                       # 静态资源
│   ├── album/                    # 相册照片
│   ├── group-avatar.png          # 群组头像
│   ├── group-banner.png          # 群组横幅
│   └── group-hero.png            # 首页 Hero 图
├── public/                       # 前端文件
│   └── index.html                # SPA 单页应用
├── uploads/
│   └── avatars/                  # 用户头像
├── docs/
│   ├── design-v5.2-final.md      # V5.2 设计文档
│   └── project-docs.md           # 项目文档（本文件）
└── server/                       # 后端代码
    ├── package.json
    ├── db.js                     # 数据库连接池
    ├── db_init.js                # 数据库初始化（建表）
    ├── server.js                 # 主服务（API 路由）
    ├── auth.js                   # 认证与权限中间件
    ├── vrc.js                    # VRChat API 模块
    ├── schedule.js               # 定时任务
    └── routes/
        ├── auth.js               # 认证路由（V5.2）
        ├── users.js              # 用户路由（V5.2）
        └── events.js             # 活动详情路由
```

---

## 8. 权限速查

| 操作 | super_admin | admin | editor | user |
|------|:-----------:|:-----:|:------:|:----:|
| 系统配置 | ✅ | — | — | — |
| 用户创建/删除 | ✅ | — | — | — |
| 用户角色管理 | ✅ | — | — | — |
| 发布公告/活动 | ✅ | ✅ | — | — |
| 编辑公告/活动 | ✅ | ✅ | — | — |
| 删除公告/活动 | ✅ | ✅ | — | — |
| 相册照片管理 | ✅ | ✅ | ✅ | 仅自己 |
| 报名活动 | ✅ | ✅ | ✅ | ✅ |
| 上传照片 | ✅ | ✅ | ✅ | ✅ |
| 评论/点赞 | ✅ | ✅ | ✅ | ✅ |

---

*本文档由项目源码自动生成，与实际代码保持一致。*
