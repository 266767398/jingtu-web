# 境途同游 站点问题排查报告（第三轮 · 2026-10-11）

> 日期：2026-10-11
> 方式：多线程静态代码审查（前端 CSS/布局 · 前端 JS 逻辑 · 后端安全 · 运维与资源 4 路并行）+ 重点条目人工复核
> 范围：在 10-10/10-11 前两轮已修复的 40 项基础上，对全站**新暴露问题**进行第三轮扫描
> 状态：**39 项全部修复完成**（2026-10-11，4 路并行修复 + 统一验证：875 测试全绿 / 18 文件 node --check 通过 / 服务重启探活正常 / 缓存版本戳升至 20261011a）
> 说明：本文档记录本轮发现的 39 项问题，现均已修复；前两轮已修复项与遗留运维事项不再重复列出。

---

## 一、前端 CSS / 布局（9 项 · 已全部修复）

| # | 问题 | 严重度 | 位置 | 证据 | 修复建议 |
|---|------|--------|------|------|----------|
| C1 | 返回顶部按钮静止态永久下沉 20px（已复核） | 中 | public/css/animations.css:754-763；public/css/ui-enhance.css:1249-1288；public/js/main.js:545-547 | animations.css 对 `.scroll-top-btn` 声明 `transform:translateY(20px)`，显隐用 `.visible`；而 main.js 实际添加的是 `.show`，ui-enhance.css 的 `.show` 只复位 opacity/visibility 不复位 transform | 统一控制类：`.show` 补 `transform:translateY(0)`，或删除 animations.css 中未被使用的 `.visible` 规则并保留单一显隐类 |
| C2 | like-burst 心形爆裂动画被父卡片 `overflow:hidden` 裁剪 | 中 | public/css/08-chat-posts.css:4；public/css/likes-anim.css:64-70；public/js/posts.js:194 | 点赞动画要求按钮 `overflow:visible` 使心形溢出，但 `.post-card{overflow:hidden}` 及 members/achievements 同款模式把溢出心形全部裁掉 | 圆角裁剪下沉到 `.post-media-grid/.post-header/.post-actions` 等子元素；或将心形动画提升到 body 级 fixed 层 |
| C3 | 常驻 `will-change:transform` 造成合成层常驻、长列表内存上涨 | 中 | public/css/animations.css:640-648 | 对 card/list-item/post-card 等大量元素无条件提升为独立图层；`prefers-reduced-motion` 块也未回收 | 仅在交互态（hover/.tilt-on/.revealed）临时添加；reduced-motion 下置 `will-change:auto` |
| C4 | favorites.css / social.css 为孤儿样式表（未被任何页面加载） | 低 | public/css/favorites.css（全文）；public/css/social.css（全文） | style.css 的 @import 与 index.html 的 `<link>` 均未引用二者；favorites 视图实际由 collections.css 提供 | 功能已迁移则删除；未来复用则补回 `<link>` 并重写选择器，避免与 10-social.css/collections.css 重复 |
| C5 | `.group-member-card` 三处重复定义互相覆盖（易碎） | 低 | public/css/06-members.css:9、87、386-396 | 基础型横向、随后改 pointer、最终 386 行整体改纵向并隐藏部分字段，靠级联顺序生效 | 删除旧定义，收敛为「基础 + 修饰类 / @media」结构 |
| C6 | `#tab-chat` 高度 `calc(100vh-200px)` 矮屏溢出 | 低 | public/css/08-chat-posts.css:4 | 视口 <600px 时计算高度低于 min-height:400px，叠加 header/tabs/底部栏后超出视口 | 改为 `max(calc(100vh-200px),400px)` 仅宽屏生效，或矮屏降低 min-height 并让内部子区滚动 |
| C7 | 首页精选墙 600px 断点强制 3 列，320px 屏每列仅 ~95px | 低 | public/css/home-featured.css:31-35 | `max-width:600px` 无条件 3 列，无 <360px 回退 | 加 `max-width:380px` 用 auto-fill minmax 回退，或改 auto-fill minmax(96px,1fr) |
| C8 | 通用工具类 `overflow-y-auto` / `.collapsible` 硬编码 max-height 存在裁剪风险 | 低 | public/css/02-base.css:7；public/css/ui-enhance.css:323-332 | `.overflow-y-auto{max-height:200px}`、`.collapsible.open{max-height:500px}` 均为潜伏风险（当前未被使用、超长即截断） | max-height 交给具体场景类；collapsible 改用 grid 0fr→1fr 过渡 |
| C9 | `.tab-home::before` 负 inset 可能造成窄屏横向溢出 | 低 | public/css/home-enhance.css:18-30 | `inset:-40px -24px` 左右外扩 24px，body/html 无 overflow-x 约束 | `html,body` 加 `overflow-x:clip`，或改 `inset:-40px 0` |

---

## 二、前端 JS 逻辑（10 项 · 已全部修复）

| # | 问题 | 严重度 | 位置 | 证据 | 修复建议 |
|---|------|--------|------|------|----------|
| J1 | `handleCardAction` 引用隐式全局 `event`（已复核） | 高 | public/js/collections.js:164-167、174、194、205 | 点击监听未把 `e` 传入，函数内 `btnBusy(event.target)` 依赖全局 `event`（严格模式下存在 ReferenceError 风险） | 透传参数 `handleCardAction(act,id,e)`，内部改 `e.target` |
| J2 | keydown Escape 无防重复注册 | 中 | public/js/main.js:521-537 | `bindEvents()` 在 L114/L128 两处被调用，keydown 未像 click 那样先移除旧 handler，会叠加多个监听器 | 提取 `_mainEscKeyHandler`，绑定前先 removeEventListener |
| J3 | `playNotificationSound` 每次 `new AudioContext()` 从不 close | 中 | public/js/main.js:37-54 | 每次播放泄漏一个持续存活的 AudioContext 实例 | 模块级单例 + `oscillator.onended` 中 close 并置空 |
| J4 | `scrollToTop()` 固定 `behavior:'smooth'` | 低 | public/js/main.js:12-14 | 频繁滚动触发多次平滑动画互相打断；不尊重系统减弱动效偏好 | 检测 `prefers-reduced-motion` 决定 smooth/auto |
| J5 | 成就数值字段直接拼接，缺字段渲染 `undefined/undefined` | 中 | public/js/achievements.js:120、124 | `a.progress/a.conditionValue/a.percentage` 未经 Number 归一化 | 块体 map + `Number()||0` 归一化，百分比 clamp 0-100 |
| J6 | `renderVRChatBindStatus` 4 处 DOM 直取无判空 | 中 | public/js/profile.js:634-643 | `getElementById(...).textContent/.src/.href` 连写，页面结构不完整即 TypeError | 每处 `if(el)` 守卫后再赋值（参照同文件 M10 模式） |
| J7 | VRC 收藏 fill 轮次覆盖已加载分页 | 中 | public/js/vrc_favorites.js:27-40、142、154-158、236-244、310-322 | `state.offset` 语义为「已加载总数」，fill 却把它当「补全页起点」并 `state.items=d.items` 整体替换，加载更多后首发页被覆盖 | 新增独立 `fillOffset`；fill 只替换对应页切片；loadMore 固定补全目标页 |
| J8 | `closeAllModals` 不回收 `.confirm-overlay` 覆盖层 | 低 | public/js/core.js:750-756、861-876 | `createOverlayDialog` 生成的 confirm 层无 `.modal` class，全局 Esc/开新弹窗时残留 | 对 overlay 挂 `_cleanup` 并在 closeAllModals 中遍历 `.confirm-overlay` 触发取消清理 |
| J9 | `showInput` 回调无类型校验 | 低 | public/js/core.js:954 | `callback(...)` 若传入非函数会 TypeError | 入口 `if(typeof callback!=='function') callback=function(){};` |
| J10 | `openGenericLightbox/closeGenericLightbox` 为空壳 | 低 | public/js/ui.js:1073-1079 | 仅有滚动锁，无实际开/关行为（被 ui-interaction.test.js 正则锁定契约，不可删） | 保留滚动锁以符合测试契约，同时补充对可选元素的 `show` class 与 display 切换 |

---

## 三、后端安全与逻辑（11 项 · 已全部修复）

| # | 问题 | 严重度 | 位置 | 证据 | 修复建议 |
|---|------|--------|------|------|----------|
| B1 | 建站引导超管判定仅信任会话角色，未回查 DB（已复核） | 高 | server/routes/setup.js:190-196 | `requireSuperAdminForReconfigure` 仅检查 `req.session.role==='super_admin'`；被降权/封禁超管在会话有效期内仍可 POST /setup/save 重写 .env（含 SMTP_PASS、VRC_API_KEY），且该路径在 CSRF 豁免名单内；对比 auth.js:154-164 requireSuperAdmin 均实时回查 DB | 复用 requireSuperAdmin / currentRole（DB 优先），仅保留「首次安装无超管」放行分支 |
| B2 | DELETE /api/share/:code 管理员判定未回查 DB | 中 | server/routes/share.js:314-315 | `req.session?.role` 判 admin，与全站其余 DB 回查口径不一致，被降权管理员会话期内仍可删他人分享 | 改用 `currentRole(req)` / `hasRole(req,'admin','super_admin')` |
| B3 | GET /users/:id/card 对任意登录用户返回完整 birthday（含年份） | 中 | server/routes/users.js:844 | `birthday: u.birthday` 无权限分支，可推算任意用户年龄；与 users.js:404-407、profile.js:418 隐私口径冲突 | 按本人/好友/管理员分支，非好友仅返回 MM-DD 或 null |
| B4 | /following、/followers 接受任意 `?userId=` 无隐私校验 | 中 | server/routes/follows.js:109、139 | 登录用户可枚举任意账号的关注/粉丝关系图谱（含时间戳） | 非本人且非好友时拒绝，或增加关注列表隐私开关 |
| B5 | 私信编辑接口允许接收方修改发送方消息内容 | 中 | server/routes/chat.js:728-731 | 只要 `sender_id===uid || receiver_id===uid` 即放行并 UPDATE content，接收方可篡改发送方消息（聊天证据可被栽赃） | 仅 `sender_id===uid` 可编辑；接收方只保留删除/撤回/已读权 |
| B6 | NODE_ENV 非 production 时错误响应透传 err.message | 中 | server/utils.js:17、211；server/server.js:817 | `IS_DEV=NODE_ENV!=='production'`，dev 下所有 API 错误把 SQL/堆栈/路径回吐客户端；生产漏配 NODE_ENV 即全量泄漏 | 错误响应一律静态文案，err.message/stack 仅写日志；启动期校验 NODE_ENV |
| B7 | 群主可自定义 4 位邀请码（约 168 万组合可枚举） | 中 | server/routes/chat.js:303 | `/^[A-Za-z0-9]{4,32}$/` 直接落库；与创建时服务端强制 8 位随机码不一致 | 邀请码最低 8 位或禁止自定义仅 regenerateCode；入群申请叠加限流 |
| B8 | change-password 回退分支丢失 `deleted_at` 守卫 | 低 | server/auth_local_service.js:655-657 | ER_BAD_FIELD_ERROR 回退查询无软删过滤（login 登录路径已单独补复核，此处漏补） | 回退分支同样加 deleted_at 过滤或二次复核 |
| B9 | `users.preferences` 损坏 JSON 时 /users/:id/card 恒 500 | 低 | server/routes/users.js:826 | `JSON.parse(u.preferences)` 无容错，单用户脏数据拖垮名片接口（profile.js:350-353 已有 try-catch 先例） | JSON.parse 包 try-catch 降级为 {} |
| B10 | ENCRYPT_KEY 缺失/未配置时静默生成随机临时密钥 | 低 | server/auth.js:28-35 | 启动时 `randomBytes(32)` 临时密钥，重启后历史加密数据（QQ/VRChat cookie/TOTP secret）全部不可解密 | 缺失时生产 fail-fast，禁止静默轮换密钥 |
| B11 | PUT /admin/vrc-cookie-expire 仅 requireAdminCompat | 低 | server/routes/admin.js:37-53 | 普通管理员即可将全站 VRChat cookie 有效期设为 0/365，与全局配置仅 super_admin 的粒度不一致 | 改为 requireRole('super_admin') |

---

## 四、运维与资源（9 项 · 已全部修复）

| # | 问题 | 严重度 | 位置 | 证据 | 修复建议 |
|---|------|--------|------|------|----------|
| O1 | tasks.js 通知清理 SQL 的 SQLite 翻译隐含风险 | 中 | server/tasks.js:171-186；server/db.js:963、710-723 | `DELETE FROM notifications WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`，SQLite 层被翻译为 `'-' || ? || ' days'` 字符串拼接表达式，依赖 node:sqlite 对拼接修饰符的支持 | 改用双引擎通用的 `datetime('now','localtime', ? || ' days')` 写法或显式计算时间戳传参 |
| O2 | 根 .htaccess 未屏蔽 `/panel/` 运维面板目录 | 中 | .htaccess:13-16 | 已屏蔽 /server/、/node_modules/、/docs/，但 panel/ 含 server.js、panel-api.ps1 等敏感文件未屏蔽 | 追加 `RedirectMatch 403 ^/panel/` |
| O3 | docker-compose.fnos.yml `build.context` 分支锚点被 YAML 注释吞掉 | 中 | docker-compose.fnos.yml:88-92 | `context: "https://...git#jingtu-web"` 中 `#` 在 flow 字符串内被当作注释起点，分支钉死失效，会拉到默认分支 | 改为显式 `ref:` 字段（compose 规范）或重新引号/转义 |
| O4 | docker-compose.fnos.yml `APP_URL` 为空字符串 | 中 | docker-compose.fnos.yml:118 | `APP_URL: ""` 未配置，邮件链接将回退 localhost | 部署前显式填写站点公网地址 |
| O5 | install.sh 健康探测与完成提示端点不一致 | 低 | install.sh:443-458、456、481 | 探测用 `/api/health/live`、提示引 `/api/health/ready`，live 不校验就绪语义不同 | pass 判断与提示统一用 ready（或文档说明 live/ready 区别） |
| O6 | install.sh `MYSQL_ROOT_PASSWORD` 未做字符白名单校验 | 低 | install.sh:89、281 | DB_PASS 有必填校验，root 密码直接 printf 进 MYSQL_CNF，含换行/分号等会破坏配置 | 增加与 DB_PASS 一致的白名单/必填校验 |
| O7 | docker-compose.fnos.yml 密码明文入 healthcheck 命令 | 低 | docker-compose.fnos.yml:70 | `mysqladmin ping -p<DB_ROOT_PASSWORD>` 明文暴露于 compose 文件 | 使用 env 环境变量引用或专用健康检查 user |
| O8 | docker-compose.fnos.yml 密钥占位符未替换即上线风险 | 低 | docker-compose.fnos.yml:58、61、113、115-116 | `<DB_ROOT_PASSWORD>/<DB_PASSWORD>/<SESSION_SECRET>/<ENCRYPT_KEY>` 均为占位符；ENCRYPT_KEY 若非 64 位 hex 将导致 server.js:392 启动失败 | 保留强制占位符校验（缺少即拒绝启动），在 README 补充一条命令生成 |
| O9 | public/.htaccess 安全头与 Node 冲突 / 授权指令混用 | 低 | public/.htaccess:16-30 | Node（server.js）已统一设置安全头，deploy/nginx 注释明确「安全头由 Node 设置」，.htaccess 又设一份可能产生重复头；`Require all denied` 与 `Require ip` 授权上下文混用 | 删除 public/.htaccess 中与 Node 重复的安全头，保留纯静态资源缓存头；统一授权指令风格 |

---

## 五、审查中排除的疑点（非问题）

- 暗色主题 CSS 旧变量（`--card-bg:#1a1a2e` 等）：01-variables.css 已定义全套兼容别名并跟随 `data-theme`，无深浅色缺陷。
- `files.js` realpath 前缀+深度限制、`database.js` 表名白名单+escapeId、`avatar.js` ALLOWED_HOSTS 防 SSRF、`export.js`/`config.js` 密钥脱敏、`db-recover.js` 恒定时间比较：均已核实无确认缺陷。
- vrc bindTokens / 密码重置 token 均存进程内存，配合 server.js 单实例锁不存在多 worker 泄漏。
- z-index 层级链（toast > skip-link > global-loading > lightbox-viewer/smartsearch > confirm > lightbox > modal > scroll-top-btn > back-to-top > mobile-tab-bar）完整，未发现新竞争。
- install.sh `ENCRYPT_KEY` 生成 `randomBytes(32).toString('hex')`（64 hex 字符），与 server.js `===64` 校验一致，正确。
- RTC 浮层均被 `#chatPanel` 内绝对定位收敛，不与全局覆盖层竞争。

---

## 六、统计与结论

- **本轮发现并修复：39 项**（高 2 / 中 17 / 低 20），已全部完成。
- **修复方式**：4 路并行修复（CSS 组 C1-C9、JS 组 J1-J10、后端组 B1-B11+O1、运维组 O2-O9），各代理互不重叠文件集。
- **验证结论**：
  - 875 项 jest 测试全绿（49 套件）；改动文件 18 个全部通过 `node --check`。
  - 服务重启成功（487 条路由 / 93 张表 / VRChat Pipeline 连接正常）。
  - HTTP 探活：`/` 200；`/api/health` 200；鉴权端点（admin/config、notifications/settings、chat/rtc/config、users）401 正常；`/api/share/:code` 无效码 404。
  - 缓存版本戳统一升至 `20261011a`（index/db-recover/migration/offline/setup/starting.html + i18n.js + 测试断言），浏览器强刷一次即可生效。
- 遗留提醒（非本轮范围）：VRChat 系统 cookie 失效需人工 OTP 重登、MySQL 连接池重建刷屏排查、活动提醒任务队列 106 次/日失败——见前两轮遗留事项，仍待人工/运维处理。