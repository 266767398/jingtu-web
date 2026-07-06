# 境途同游 (JingTu Web) 项目记忆

## 项目路径
- 代码：`D:/phpstudy_pro/WWW/jingtu-web/`
- 设计文档：`docs/design-v5.2-final.md`
- 改进追踪：`docs/project-improvement.md`
- 项目文档：`docs/project-docs-v6.2.md`

## 技术栈
- Node.js Express + MySQL 5.7 + express-session + bcryptjs + AES-256-CBC
- 前端：单页 HTML（Vanilla JS + CSS Variables 主题系统 + WebSocket 实时在线）
- 端口：MySQL:3306, Nginx:80, Node:3456

## 文件结构（V6.2）
- `public/index.html` — HTML 结构（~1075 行）
- `public/css/style.css` — 全部样式（~2630 行，含聊天系统CSS）
- `public/js/` — **17 个模块化 JS 文件**:
  - `core.js(132)` — 全局状态 + toast + CSRF + API封装 + 工具函数
  - `theme.js(94)` — 主题系统（手动/自动/定时+自定义色）
  - `auth.js(180)` — 登录/登出/loadMe/checkAutoLogin/粒子背景（修复明文密码存储）
  - `ui.js(286)` — UI更新/Tab切换/确认弹窗/通知面板/密码强度
  - `main.js(233)` — init入口/事件绑定/搜索/报名/照片上传
  - `members.js(90)` — 成员列表/筛选/渲染/名片弹窗
  - `announcements.js(55)` — 公告CRUD/详情
  - `events.js(273)` — 活动三态/创建/编辑/详情/评论
  - `vrc.js(90)` — VRChat World搜索/2FA弹窗
  - `map.js(270)` — Leaflet OSM / 自定义头像标记 / GPS实时追踪 / World视图
  - `chat.js(170)` — 私信聊天 / 会话列表 / WebSocket实时推送 / 未读标记
  - `album.js(191)` — 照片墙/灯箱/选择模式/批量删除/回收站
  - `admin.js(448)` — 用户管理/改名审核/权限管理/系统VRChat登录
  - **新增权限组管理(admin.js内)** — 权限组CRUD/设置权限/用户归属管理
  - `birthday.js(77)` — 生日列表/派对活动
  - `profile.js(287)` — 个人中心/资料编辑/头像/VRChat绑定/改名
  - `init.js(31)` — 系统初始化（首次创建超管）
- `server/server.js` — 主服务器（~2000 行）
- `server/routes/auth.js` — 认证路由
- `server/routes/users.js` — 用户管理路由
- `server/routes/chat.js` — 聊天私信路由（V6.12）
- `server/routes/permission_groups.js` — **权限组系统路由（新）**（~310 行）

## 版本状态
- **V6.13 个人静态位置+群聊+群聊实时位置** — 2026-07-03
- **V6.12 Leaflet OSM + 私信聊天系统** — 2026-07-03

## 已实现功能（完整）
- ✅ 登录系统（密码 + VRChat双轨 + 初始化引导）
- ✅ 游客模式 + 内容可见性（公开/成员专属）
- ✅ 成员列表（搜索+角色筛选+名片弹窗）
- ✅ 公告系统（CRUD+置顶+可见性+详情）
- ✅ 活动三态系统（进行中/即将到来/往期）
- ✅ 活动报名/取消报名/评论
- ✅ 活动编辑/归档
- ✅ VRChat日历同步
- ✅ VRChat World搜索+活动关联
- ✅ 相册（上传/灯箱/点赞/评论/选择模式/批量删除）
- ✅ 回收站（恢复/永久删除）
- ✅ 全员位置地图（Leaflet + OpenStreetMap + Dark主题）
- ✅ 活动World地图双视图
- ✅ 个人中心（头像上传/切换/移除/资料编辑/密码修改/VRChat绑定）
- ✅ 改名申请系统（提交+管理员审核+通知）
- ✅ 通知系统（db存储+铃铛徽章+已读管理）
- ✅ **权限组系统（新）** — 多组归属/组继承/27项细粒度权限/冲突检测
- ✅ 主题系统（手动/自动/定时+5预设+color picker）
- ✅ WebSocket 实时在线状态
- ✅ **实时位置共享（V6.12）** — Leaflet OSM + GPS + WebSocket 实时广播，头像标记
- ✅ **私信聊天系统（V6.12）** — 会话列表 / 实时消息推送 / 未读数 badge / Enter发送 / 地图弹窗直通
- ✅ **个人静态位置（V6.13）** — 手动更新GPS、关开关删服务器位置数据、地图显示所有允许共享的用户
- ✅ **群聊系统（V6.13）** — 创建群聊/邀请成员/群消息/群成员在线
- ✅ **群聊实时位置（V6.13）** — 仅群内可见、WS广播不持久化、5秒GPS追踪、位置状态栏显示
- ✅ 操作日志
- ✅ 管理员面板（用户创建/编辑/批准/封禁/删除/重置密码/权限组管理）
- ✅ CSRF保护 + rate-limit限流

## 关键字段映射（前后端对齐）
- 活动：后端 eventTime/maxSign/signedCount ↔ 前端 time/maxParticipants/signCount
- 用户：`avatarUrl`（非 avatar）、`displayName`（非 userName）
- 公告：后端 `{ announcements: [...] }` + createdAt 兼容
- 改名：后端收 `newName`（非 requestedName）
- 权限组：`API /api/permission-groups/*`，27个权限键

## VRChat 登录安全修复
- ✅ 不再用 `vrchat_name` 匹配登录（改为 `vrchat_id`）
- ✅ 不再存明文密码到 localStorage（改为只存 loginId）
- ✅ 不再前端强制设置 `vrchatVerified`（等待服务端返回）
- ✅ 自动登录改为 session 驱动（不再自动填密码登录）
