# 境途同游 项目改进计划

> 审计时间: 2026-06-20
> 版本: V5.5

---

## 🔴 P0 — 必须修复的 Bug

### 1. 签到按钮 onclick 模板渲染错误 ✅ 已修复 (2026-06-20)

**问题**: 活动详情弹窗头部签到按钮的 onclick 硬编码了 `${currentDetailEventId}` 模板语法。
**修复**: `renderEventDetail()` 中已动态绑定 `document.getElementById('evtDetCheckinBtn').onclick = () => doCheckin(evt.id);`

---

### 2. CSRF 豁免写死了照片 ID ✅ 已修复 (2026-06-20)

**问题**: CSRF_EXEMPT 列表中已使用 `'/api/album/photos'` 前缀匹配，`startsWith` 逻辑覆盖了所有 `/api/album/photos/*` 路径。

---

### 3. VRChat 活动标题乱码 ✅ 已修复 (2026-06-20)

**问题**: VRChat API 返回的活动标题/描述包含非 BMP Unicode 字符时，没有做编码转换处理，前端显示 `??` 乱码。

**位置**: `server/vrc.js` 或 `server/server.js` 中的 VRChat 同步逻辑

**根因**: `fetch().json()` 依赖 HTTP 响应头的 charset 声明，VRChat API 响应头可能缺失 charset，导致 `res.json()` 内部按默认编码（Latin-1）解析，非 BMP 字符丢失。

**修复方案**:
- 在 `vrc.js` 的 `vrchatRequest()`, `vrchatBasicLogin()`, `vrchatGetCurrentUser()` 中，用 `res.arrayBuffer() + TextDecoder('utf-8', { fatal: false })` 替代 `res.json()`
- 清理已损坏的数据库记录（EFBFBD 替换字符）
- 验证：Emoji 🎉🎊😀👍 可正常写入和读取

**数据库验证**: INSERT → SELECT 一致性测试 ✅

---

## 🟠 P1 — 体验优化

### 4. 页面标题不随 Tab 切换 ✅ 已修复 (2026-06-20)

**问题**: 不管切到哪个 Tab，浏览器 title 始终是 "境途同游 - VRChat Group"。

**位置**: `public/index.html` `<title>` 标签 + JS

**修复方案**: 在 `switchTab()` 中根据 `titles` map 动态更新 `document.title`
```js
// 在 switchTab() 中更新
document.title = tabName === 'announcements' ? '公告 - 境途同游'
  : tabName === 'events' ? '活动 - 境途同游'
  : tabName === 'album' ? '相册 - 境途同游'
  : tabName === 'members' ? '成员 - 境途同游'
  : tabName === 'me' ? '个人中心 - 境途同游'
  : '境途同游 - VRChat Group';
```

**实现难度**: ⭐ 极低

---

### 5. Lightbox 描述文字截断 ✅ 已修复 (2026-06-20)

**问题**: `.lightbox-desc` 样式 long 描述被截断。已在之前轮次修复：`white-space: normal` + `max-height: 60px` + `overflow-y: auto`

**实现难度**: ⭐ 极低

---

### 6. Lightbox 编辑描述按钮死代码清理 ✅ 已修复 (2026-06-20)

**问题**: 编辑按钮的 HTML 内联了 `onclick="editPhotoDesc(currentPhotoId, '')"`（模板渲染时 fixed 参数为 undefined），同时 JS 在 `showLightbox()` 中用 `editDescBtn.onclick = () => editPhotoDesc(photoInfo.id, ...)` 动态绑定，内联 onClick 永远不会正确执行。此外按钮使用了大量内联 `style` 而非 CSS 类。

**位置**: `public/index.html` Lightbox 编辑按钮 HTML + JS

**修复方案**:
- 删除按钮的 `onclick` 和内联样式（`position:absolute;top:-4px;right:-4px;background:...`）
- 按钮改用 `class="lightbox-desc-edit-btn"` 引用 CSS 类
- 所有功能通过 `showLightbox()` 中的 JS 动态绑定 `editDescBtn.onclick`

---

### 7. WebSocket 重连无指数退避 ✅ 已修复 (2026-06-20)

**问题**: WS 断线后固定 10 秒重连。已在之前轮次修复：指数退避 1s→2s→4s→...→30s 上限。

**实现难度**: ⭐ 极低

---

### 8. 骨架屏替代"加载中..."文字 ✅ 已修复 (2026-06-20)

**问题**: 3 处遗留 "加载中..." 已全部替换为骨架屏动画：
- 成员名片（head区用 skeleton-card 模拟头像+名字+角色）
- 活动详情标题（skeleton 条代替）
- Lightbox 评论列表（3 条 skeleton-card）


**实现难度**: ⭐⭐ 低

---

### 9. 照片上传无进度条 ✅ 已修复 (2026-06-20)

**问题**: 上传大文件时，用户不知道上传进度。

**位置**: `apiForm()` 函数 + 上传 UI

**修复方案**:
- 新增 `uploadWithProgress(url, formData, onProgress)` — 基于 XMLHttpRequest + `xhr.upload.onprogress` 实现
- 新增 `showUploadProgress(show, label, pct, fileName)` — 显示进度条 UI
- 新增 CSS `.upload-progress-wrap` / `.upload-progress-track` / `.upload-progress-fill` — 渐变进度条样式
- 改造 `uploadPhotos()` — 单文件上传时实时显示文件名 + 百分比进度条
- CSRF Token 通过 Cookie 读取 `XSRF-TOKEN` 并设到 XHR header

**效果**: 上传时显示 "上传中 (2/5) · 文件名.jpg" + 渐变进度条动画

---

### 10. 删除确认弹窗替代原生 confirm ✅ 已修复 (2026-06-20)

**问题**: 全局不再使用 `confirm()`，已统一使用 `showConfirm()` 自定义弹窗。批量删除等调用也已迁移。

**实现难度**: ⭐⭐ 低

---

## 🟡 P2 — 代码质量 & 维护性

### 11. index.html 单文件过大（3000+ 行） ✅ 完成第一阶段拆分 (2026-06-20)

**问题**: 所有 CSS + HTML + JS 堆在一个文件里，难以维护和协作。

**位置**: `public/index.html`

**第一阶段拆分方案** ✅:
- CSS 全部提取到 `public/css/style.css`（401 行）
- JS 全部提取到 `public/js/app.js`（2858 行）
- `index.html` 从 4043 行缩减到 781 行（仅有 HTML 结构）
- 服务器 `express.static('public')` 自动服务 `/css/` 和 `/js/` 路径

**后续优化方向**:
- JS 按功能模块拆分（auth / events / album / admin）
- 提取内联 style 为 CSS 类（index.html 剩余 72 处，app.js 中 132 处需进一步替换）

### 12. 大量内联 style 影响主题切换 ✅ 部分完成 (2026-06-20)

**问题**: 大量 `style="xxx"` 硬编码样式，暗/亮主题切换时很多元素不会跟随主题变化。

**完成情况**:
- 创建了 70+ 个 CSS 实用类和 30+ 组件级类
- index.html: 从 231 处 → 155 处（第一轮批量）→ **72 处**（第二轮，共减少 159 处，68%）
- `style.css` 新增约 200 行组件级 CSS 类
- app.js 中的 132 处内联 style 待处理（模板字符串中较复杂）

### 13. api() 函数 URL 拼接安全性 ✅ 已完成 (2026-06-20)

**修复方案**: 在 `api()` 和 `apiForm()` 函数内部自动对路径段进行 `encodeURIComponent()` 编码，一处修改覆盖所有调用。

### 14. 缺乏错误边界 ✅ 已完成 (2026-06-20)

**修复方案**: 在 `api()` 和 `apiForm()` 函数中统一处理常见 HTTP 状态码：
- 401 → "登录已过期，请重新登录"
- 403 → "权限不足，无法执行此操作"
- 404 → "请求的资源不存在"
- 429 → "操作过于频繁，请稍后再试"
- 500+ → "服务器内部错误，请稍后再试或联系管理员"
- 网络异常 → "网络连接异常，请检查网络后重试"

---

## 🟢 P3 — 锦上添花

### 15. VRChat 在线成员显示当前 World ✅ 已完成 (2026-06-20)

**实现**: 利用 WebSocket 在线用户数据的 `location` 字段，在成员列表中通过 `ws-online-dot` 天蓝色圆点 + 💻 图标显示网站在线状态；VRChat 原生在线成员绿点（🟢 / ⚫）保持不变。已实现 VRChat ↔ WebSocket 双向在线状态联动（详见 API: `/api/group` 的 `wsOnlineCount` 字段）。

### 16. PWA 支持 ✅ 已完成 (2026-06-20)

**方案**: 
- `public/manifest.json` — 配置名称、图标（SVG 渐变圆环+毛笔"境"字）、主题色 `#7c5cfc`
- `public/sw.js` — Service Worker：网络优先+缓存兜底、预缓存核心静态资源、跳过 API 请求
- `public/assets/pwa-icon-192.svg` / `pwa-icon-512.svg` — 两档 PWA 图标
- HTML `<head>` — 添加 `manifest`、`theme-color`、`apple-mobile-web-app` meta
- HTML `<head>` — `favicon` 使用群组头像 SVG
- JS `DOMContentLoaded` — 注册 `sw.js`，静默失败不影响主功能
- 缓存策略：静态资源网络优先→缓存兜底；API 请求不缓存

### 17. VRChat World 活动地图

**问题**: 活动地点是文本，没有直观的地图展示。

**方案**: 利用 VRChat World 的坐标信息，在地图 Tab 上显示活动标记。

### 18. 粘贴上传图片 ✅ 已完成 (2026-06-20)

**实现**: 
- 新增 `initPasteUpload()` — 监听全局 `paste` 事件，过滤剪贴板中的图片文件
- 仅在相册 tab（`activeTab === 'album'`）激活时触发
- 检测到图片后 toast 提示 → 调用 `uploadPhotos()` 复用现有上传流程
- 支持多图粘贴（剪贴板中的多张图依次上传）

### 19. 日/夜模式自动切换 + 自定义主题色 ✅ 已实现 (2026-06-20)

**问题**: 主题只能手动点击切换，且只有暗/亮两色，没有自定义空间。

**实现方案** — 全新 V5.5 主题系统:

**三种模式**:
- 👆 **手动**: 用户手动选择暗色/亮色
- 🌓 **跟随系统**: 自动检测 `prefers-color-scheme`，系统变化时自动跟随
- ⏰ **定时**: 18:00~6:00 暗色，6:00~18:00 亮色（每分钟检查）

**主题色自定义**:
- 5 种预设色：紫（默认）、蓝、粉、绿、金
- 自定义取色器：`<input type="color">` 自由选色
- `applyTheme()` 通过 CSS 变量 `--accent`、`--accent2`、`--hover` 实时覆盖

**持久化**:
- 所有配置存储为 `localStorage` 的 JSON（`jingtu_theme_config` 键）
- 兼容旧版本单 key `theme`，自动迁移

**UI**:
- 头部主题按钮点击弹出下拉面板
- 模式/亮度/主题色分区设置
- 点击外部自动关闭面板

**位置**: `public/js/app.js` 26-234 行 (Theme System) + `public/css/style.css` 主题面板样式 + `public/index.html` 主题面板 HTML

### 20. 相册批量操作 ✅ 已完成 (2026-06-20)

**实现**:
- **后端**: `POST /api/album/photos/batch-delete` — 接收 `{ ids: [...] }`，检查每张权限后批量移入回收站
- **前端 HTML**: 工具栏新增 "☑️ 选择" 和 "🗑️ 批量删除" 按钮
- **前端 JS**: 
  - `toggleAlbumSelect()` — 切换选择模式，照片渲染时加 checkbox 和 `.selectable` 类
  - `toggleAlbumItemSelect(id)` — 勾选/取消单张，视觉 `.selected` 高亮（紫色边框+阴影）
  - `batchDeletePhotos()` — 确认后调用 API 批量删除，使用统一 `showConfirm()` 弹窗
- **CSS**: `.album-checkbox`（复选框样式）、`.album-item.selected`（选中高亮）、`.album-item.selectable`（禁用 hover 缩放）

---

## 执行顺序建议

| 轮次 | 项目 | 预估工作量 | 状态 |
|------|------|-----------|------|
| **第1轮** | Bug 1(签到按钮) + Bug 2(CSRF豁免) + Bug 5(描述截断) + Bug 7(WS退避) | 小 | ✅ 已完成 |
| **第2轮** | Bug 4(Tab标题) + Bug 8(骨架屏) + Bug 10(确认弹窗) + **Bug 3(VRChat乱码)** | 中 | ✅ 已完成 |
| **第3轮** | Bug 9(上传进度条) + Bug 6(编辑按钮清理) | 小 | ✅ 已完成 |
| **第4轮** | Bug 11(代码拆分第一阶段) | 大 | ✅ 已完成 |
| **第5轮** | P3-19(日/夜自动切换 + 自定义主题色) | 中 | ✅ 已完成 |
| **第6轮** | P2-12/13/14(代码质量) | 中 | ✅ 已完成 (2026-06-20) |
| **第7轮** | P3-18(粘贴上传) + P3-16(PWA) + P3-20(相册批量操作) | 中 | ✅ 已完成 (2026-06-20) |
| **第8轮** | 安全加固 .env（SESSION_SECRET、ENCRYPT_KEY、MYSQL_PASSWORD）| 小 | ✅ 已完成 (2026-06-20) |
| **第9轮** | V6 前端模块化重构 (15个JS文件) | 大 | ✅ 已完成 (2026-06-20) |
| **第10轮** | 全面审查 + P0/P1 Bug 大扫除 | 大 | ✅ 已完成 (2026-06-21) |
| **第11轮** | 个人中心全面修复（头像/资料/签名/VRChat绑定） | 大 | ✅ 已完成 (2026-06-21) |
| **第12轮** | 5个Stub功能全部对接（相册批量删除/回收站/成员筛选/编辑用户/重置密码）+ rate-limit IPv6修复 | 中 | ✅ 已完成 (2026-06-21) |

---

## 第10轮 — 全面审查与修复 (2026-06-21)

### 🚨 P0 — 已修复的 Bug

| # | 问题 | 修复 |
|---|------|------|
| 1 | 公告详情 API 404 (`GET /api/announcements/:id` 不存在) | server.js 新增详情路由 |
| 2 | 前端密码修改路径与后端不匹配 (`/api/users/me/change-password` vs `/api/auth/change-password`) | profile.js 路径修正 |
| 3 | VRChat 绑定前端传 `vrchatPassword` 但后端接受 `vrchatName` | profile.js 字段修正 + HTML 适配 |
| 4 | 成员角色映射 `m.role === 'superadmin'` 数据库存的是 `super_admin` | members.js 修正为 `super_admin` |
| 5 | 改名审核列表 ID 不匹配 (`nameChangeList` vs HTML 中 `nameReviewList`) | admin.js 修正 |
| 6 | 权限管理列表 ID 不匹配 (`permissionsList` vs HTML 中 `permMgmtList`) | admin.js 修正 |
| 7 | 全局搜索 API 后端缺失 (`/api/search`) | server.js 新增搜索路由 |
| 8 | 遗留 10 处 `confirm()` 未替换，且 `showConfirm()` 函数不存在 | ui.js 新增 showConfirm + JS 全部替换 + CSS 样式 |

### 🟠 P1 — 已对接/修复的功能

| # | 功能 | 修复内容 |
|---|------|---------|
| 9 | 活动评论前后端对接 | 完整实现 postEventComment / loadEventComments / deleteEventComment |
| 10 | 活动编辑前端 | showEditEvent() 自动填充 + saveEditEvent() 对接后端 PUT API |
| 11 | 地图活动世界视图 | updateWorldMapMarkers() 获取 /api/events/with-worlds 并按 World 去重展示网格 |

### 🟡 剩余未开发功能

- 相册批量删除（还在开发中）
- 回收站功能
- 成员筛选 `filterMembers()` stub

### 💡 新功能建议

| 优先级 | 功能 | 说明 | 难度 |
|--------|------|------|------|
| P2 | 🔔 **VRChat 活动自动提醒** | 后端 `/api/events/reminders` 已实现，前端未对接，可加弹窗通知 | ⭐⭐ |
| P2 | 🔐 **游客模式后端** | 前端有 `loginAsGuest()` 但后端无对应路由，游客无法正常使用 | ⭐ |
| P3 | 📊 **活动日历视图** | 目前只有列表，可选月历/周历切换，直观展示活动时间线 | ⭐⭐⭐ |
| P3 | 🎮 **系统 VRChat 2FA 流程** | `doSystemVrc2FA()` 是 stub，系统登录无法完成 2FA | ⭐⭐ |
| P3 | 📱 **活动分享卡片** | 生成长图/卡片分享到社交平台 | ⭐⭐ |
| P3 | 🔍 **成员搜索/筛选** | `filterMembers()` 从未实现，需前后端对接 | ⭐ |
| P4 | 📈 **数据仪表盘** | 成员增长统计、活动参与率、热门 World 等 | ⭐⭐⭐ |
| P4 | 🏠 **首页/欢迎页** | 目前默认 Tab 是成员列表，可加欢迎仪表盘 | ⭐⭐ |

---

## 第11轮 — 个人中心全面修复 (2026-06-21)

## 第12轮 — 5个Stub功能对接 (2026-06-21)

### ✅ 已对接功能

| # | 功能 | 文件 | 说明 |
|---|------|------|------|
| 1 | **相册选择模式 + 批量删除** | `album.js` + `style.css` | 选择模式切换，checkbox，选中高亮，调用 `POST /api/album/photos/batch-delete` |
| 2 | **回收站** | `album.js` + `style.css` | `showRecycle()` 从 `GET /api/album/recycle` 加载，支持恢复和永久删除 |
| 3 | **成员筛选** | `members.js` | 搜索框+角色下拉联动，动态填充角色选项，显示筛选计数 |
| 4 | **管理员编辑用户** | `admin.js` | 编辑按钮+弹窗，调用 `PUT /api/users/:id` 更新显示名/角色 |
| 5 | **管理员重置密码** | `admin.js` | 重置密码按钮+弹窗，调用 `POST /api/admin/users/:id/reset-password` |

### 🛠 额外修复

- `rate-limit` `keyGenerator` 修复 IPv6 warning（使用 x-forwarded-for 或 session-based key）
- 创建用户弹窗增强（`showAddUserModal()` 重置表单+错误显示）
- CSS 新增 `.album-photo-card` 完整样式类 + `.recycle-item` 回收站样式 + `.album-select-checkbox` 选择框样式

---

## 第14轮 — 模块拆分隐形Bug全面排查 (2026-06-21)

### 发现并修复 18 个问题

**后端修复（9个）：**
1. 活动列表返回裸数组→`{ events: [] }`
2. 新增 `GET /api/events/detail/:id` 活动详情路由
3-4. 创建/编辑活动 `time`/`desc` 字段名兼容
5. 改名申请 `requestedName`→`newName`
6. 相册上传路径修正
7. 成员列表路由被 `/:id` 通配吃掉→移到前面
8. admin SQL 补 `approved`/`banned` 字段
9. 新增 `/api/avatar/default` SVG 占位图路由

**前端修复（6个）：**
10. `renderMembers()` 从 bak 迁移到 members.js
11. `showMemberCard()/showMemberDetail()` 补全
12-13. birthday.js `avatar`/`eventTime` 字段修正
14-15. map.js 字段名 + API 路径修正

### 状态
- ✅ 服务器零 warning 运行
- ✅ 15 个模块全链路字段对齐验证通过
