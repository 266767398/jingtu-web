# 境途同游 站点问题排查报告（第四轮 · 2026-10-12）

> 日期：2026-10-12
> 方式：静态代码审查 3 路并行（前端交互/事件绑定 · 后端安全/鉴权 · 文档/版本戳/多语言一致性）+ 逐项人工复核修复
> 范围：在 10-09 第三轮审计（VRC 绑定 + 模块化）与 10-11 第三轮全站报告（C/J/B/O 39 项）基础上，对**新暴露问题**进行第四轮扫描
> 状态：**全部修复完成**（2026-10-12；相关 Jest 回归全绿、全量测试套件 50/50 · 901/901 全绿、语言键集校验通过、node --check 语法全部通过）
> 说明：本文档记录本轮发现的问题，现均已修复；前三轮已修复项与遗留运维事项不再重复列出。

---

## 一、前端交互与事件绑定（6 项 · 已全部修复）

| # | 问题 | 严重度 | 位置 | 证据 | 修复内容 |
|---|------|--------|------|------|----------|
| F1 | `editEventModal` 关闭按钮 ID 挂在 `.modal-content` 容器上 | 🔴 高 | public/index.html:2359-2361 | `id="editEventModalCloseBtn"` 定义在整块 modal 内容容器上，恒命中 → 点击弹窗**任意位置**即关闭，编辑活动无法操作 | 按钮移回 X 关闭键，并补 `data-modal-close="editEventModal"` |
| F2 | `archiveModal` 关闭按钮同样误挂 `.modal-content` 容器 | 🔴 高 | public/index.html:2382-2384 | 与 F1 同源：归档确认弹窗整块可点关闭，点确认前误触即消失 | 按钮移回 X 键，补 `data-modal-close="archiveModal"` |
| F3 | `memberModal` 关闭按钮误挂 `.member-card-header` 容器 | 🟡 中 | public/index.html:2131-2133 | 点击成员名片卡头部任意位置都会关闭名片弹窗 | 按钮移回 `.modal-close-circle`，补 `data-modal-close="memberModal"` |
| F4 | 群组筛选按钮重复绑定（id 选择器 + class 选择器各绑一次） | 🟡 中 | public/js/…（tab 切换事件绑定区）；public/index.html:2841-2847 | 静态按钮带 `id` 又被 `.group-filter-btn` 选择器命中，点击一次触发两次请求 | 选择器改为 `.group-filter-btn:not([id])`，跳过带 id 的静态按钮 |
| F6 | collections.js 4 处 CSS url 内插值用 `esc()`（`&#39;` 在 CSS 值内被解码 → 可注入） | 🟡 中 | public/js/collections.js:148、453、679、761 | `background-image:url('${esc(thumb)}')`：esc() 只转义 HTML 实体，CSS url 字符串上下文会先解码实体再解析，`'` 可逃逸出引号 | 改用 core.js 既有 `escCssUrl(url)`（返回带引号的安全 url） |
| F13 | `goToProfile` 两处调用无时序保护 | 🟢 低 | public/js/members.js:221、1628 | 函数定义在懒加载 profile-page.js，members.js 冒泡委托被触发早于其加载即 ReferenceError（main.js:936 已有同类保护） | 两处调用前补 `typeof goToProfile === 'function'` 守卫，与 main.js 口径一致 |

---

## 二、后端安全与逻辑（4 项）

| # | 问题 | 严重度 | 位置 | 证据 | 处理 |
|---|------|--------|------|------|------|
| N2 | 创建群聊 `memberIds` 无数量上限 + `invalidMemberIds` 泄露用户存在性 | 🟡 中 | server/routes/chat.js:180-230 | 超大数组可拖垮 `id IN (...)` 查询；响应回传无效 id 明细 = 「用户是否存在」枚举 oracle（前端从未消费该字段） | ✅ 已修：成员数上限 200（去重）+ `deleted_at IS NULL` 过滤 + 响应仅返回 `invalidMemberCount` 计数 |
| N3 | `GET /api/follows/counts/:userId` 绕过 `canViewFollowList` 隐私闸 | 🟡 中 | server/routes/follows.js:212-229 | 关注/粉丝**列表**已加 B4 隐私闸，但**计数**接口可匿名绕行 → 枚举任意用户关系图谱规模 | ✅ 已修：counts 与列表同口径（本人或双向好友才放行，否则 403）；新增测试锁定双分支 |
| N4 | `POST /api/users/me/change-password` 第二改密接口缺限流 + 回退分支缺软删复核 | 🟡 中 | server/routes/users.js:997-1023 | 与 `/api/auth/change-password` 语义重复（B8 只修了 auth 侧）；回退 SQL（deleted_at 列缺失时）不查软删标记 | ✅ 已修：补 `passwordResetLimiter` + `SELECT *` 取全行后显式复核 `deleted_at`，两头口径一致 |
| N1 | `POST /api/auth/init` 首次部署窗口可被抢先创建超管（首人即超管劫持） | 🔴 高 | server/auth_local_service.js:55-124 | 无超管 + `.env` 缺失时按设计放行首人初始化（否则首次部署无法自举），部署窗口期内理论上可被抢先注册 → 劫持首个超管账号 | ✅ 已修（2026-10-12 加固）：补 `initLimiter`（60 分钟 3 次/IP，`hybridStore` 共享存储）压降抢占/爆破窗口；既有防线保留——超管已存在即拒绝且**绝不**轮换密钥、`.env` 缺失走 `/api/setup` 引导；另建议部署后立即创建超管 + 网络层白名单以彻底消除窗口 |

---

## 三、文档 / 版本戳 / 多语言一致性（6 项 · 已全部修复）

| # | 问题 | 严重度 | 位置 | 证据 | 修复内容 |
|---|------|--------|------|------|----------|
| D3 | README 文档地图引用 5 个已删除文档（09-13）成断链 | 🟡 中 | docs/README.md | `09-变更记录 / 10-项目审查 / 11-问题清单 / 12-审计 / 13-模块地图` 均已被 git 移除，链接 404 | ✅ 地图重写：指向实际存在的 01-08、19-审计清单、两份 issues-report、jingtu-docs.html |
| D4 | 03/05/02/06/08 多文档仍引用已删除的 `09-变更记录.md` 或编号错位 | 🟡 中 | docs/03:3、59；docs/05:3；docs/02:66；docs/06:34；docs/08:37、55 | 断链 + 「12-审计问题清单-2026-10-09.md」实际文件名是 19 前缀 | ✅ 全部改为说明性文字 / 指向真实文件（见下方「文档断链清理明细」） |
| D5 | 19-审计问题清单正文标题为 `# 12`，与文件名 `19-` 前缀不一致 | 🟢 低 | docs/19-审计问题清单-2026-10-09.md:1 | 文档地图引用文件名 → 标题自相矛盾，检索/引用易混 | ✅ 标题改为 `# 19 · 审计问题清单`并注明轮次 |
| V1 | 测试断言硬编码版本戳 `20261012a`，实际已升 `b` → 误报 | 🟡 中 | server/__tests__/security-regressions.test.js:837-840 | 上一轮升戳后测试未同步，`expectBefore(…'?v=20261012a')` 必然 -1 | ✅ 改为从 index.html 动态提取主戳（`loader.js? v`），今后升戳不再漏改断言 |
| V2 | 分享页 share.js 内嵌 CSS 引用仍带旧戳 `20261012a` | 🟡 中 | server/routes/share.js:195-196 | 与主戳 b 不一致 → 分享页可能命中旧缓存 | ✅ 同步升为 `20261012b` |
| V3 | 5 份多语言文件缺 5 个键（上一轮新增文案只加了 zh） | 🟡 中 | public/js/languages/{en,ja,fr,de,ru}.js | `admin.activation.revoke_reason_required`、`profile.remember_vrc_creds`、`profile.vrc_relogin`、`profile.vrc_homepage`、`profile.vrc_relogin_enter_pwd` 仅 zh 有 | ✅ 5 份语言逐一补齐，`scripts/check-lang-keys.js` 键集一致通过 |
| V4 | 6 份语言文件缺 11 个键（收藏推荐 + VRC 收藏缓存提示 + DB 管理确认语） | 🟡 中 | public/js/languages/*.js | `rec.*`×7、`vrcfav.cached_hint`、`admin.db.confirm_{optimize,repair,kill}` 仅 zh 有（上轮收藏推荐功能只补了 zh） | ✅ zh 手动补齐 + 脚本同步 en/ja/fr/de/ru，`check-lang-keys.js` 键集一致 |
| V5 | 路由守恒基线缺 3 条上轮新增路由（收藏推荐 / VRC 收藏同步） | 🟡 中 | server/__tests__/fixtures/route-inventory.json | 上轮新增 `POST /api/collections/:id/recommend`、`POST /api/vrc-favorites/sync`、`GET /api/vrc-favorites/sync-status` 未同步基线 → route-inventory 守恒守卫报 -3 | ✅ 基线快照同步为 490 条（live=golden），守卫转绿 |

### 文档断链清理明细

- `docs/03-部署与运维.md:3`：删除「见 09-变更记录.md」引用 → 说明性文字「历史变更见审计/报告清单」。
- `docs/03-部署与运维.md:59`：故障行内「见 09-变更记录」→「（2026-10-04 已全站修复）」。
- `docs/05-数据库设计.md:3`：删除 09 引用 → 说明性文字。
- `docs/02-项目概述与架构.md:66`：删除 09 引用 → 指向 `issues-report-2026-10-12.md`。
- `docs/06-功能模块与安全.md:34`：`12-审计问题清单-2026-10-09.md` → `19-审计问题清单-2026-10-09.md`。
- `docs/08-开发指南.md:37`：同上改文件名；`:55`：`09-变更记录.md` → 说明性文字。

---

## 四、审查中排除的疑点（非问题）

- `/api/auth/init` 密钥轮换路径：已存在「超管存在时绝不生成/轮换 SESSION_SECRET/ENCRYPT_KEY」防护，`.env` 丢失走 `/api/setup` 引导修复，判定为设计正确；首装抢占窗口经 N1 加固（initLimiter）后残余风险进一步收敛。
- 群聊 `invalidMemberCount` 仅当 `>0` 才返回；前端无任何字段消费，契约兼容（旧字段 `invalidMemberIds` 未在任何前端/测试中引用）。
- `/api/follows/status/:userId` 仅返回「我↔他」关系状态（不自报他人互关数据），不构成枚举面，无需加闸。
- `escCssUrl` 已在 core.js:645-650 定义并被 avatar 相关代码使用，无重复实现问题。

---

## 五、统计与结论

- **本轮发现并修复：17 项**（高 1 / 中 12 / 低 4——按修复前计；N1 经代码加固后同列已修复）。
- **修复方式**：前端 6 项（F1/F2/F3 弹窗关闭误触 + F4 重复绑定 + F6 CSS 注入 + F13 时序保护）、后端 4 项（N2/N3/N4 代码修复 + N1 initLimiter 加固）、文档/版本戳/多语言 7 项（D3-D5、V1-V5）。
- **验证结论**：
  - 相关测试套件（follows / social-routes / auth-services / security-regressions / module-regressions / i18n / route-inventory 等）**全量 50 套件 · 901 测试全绿**。
  - `node --check`：chat.js / follows.js / users.js / auth_local_service.js / share.js 全部通过。
  - `scripts/check-lang-keys.js`：6 份语言文件键集合一致（各 3345 键）。
  - 路由守恒基线同步为 490 条（live = golden），守卫转绿。
  - 版本戳统一为 `20261012b`（index / share.js / 测试断言动态化）。
- 遗留提醒（非本轮范围，延续前三轮）：VRChat 系统 cookie 失效需人工 OTP 重登、MySQL 连接池重建刷屏排查、活动提醒任务队列失败、members.js 中期按域切分——见前几轮文档。

---

## 六、第五轮补充（2026-10-13：VRC 绑定语言键 + 激活码彻底删除/使用日志 + UI 层级遮盖）

> 本轮在上表第四轮基础上追加三块修复，版本戳链自 `20261012b` 一路提升至 `20261012e`。

### 6.1 VRChat 绑定 / 登录表单语言键未生效（v1）

| # | 问题 | 严重度 | 位置 | 根因 | 修复内容 |
|---|------|--------|------|------|----------|
| R1 | VRC 绑定区语言键显示原始 key（`login.vrc_user_label` 等） | 🔴 高 | public/index.html + sw.js | 浏览器 Service Worker 对带 `?v=` 资源 cache-first：上一轮升戳后语言包 `en.js?v=20261012c` 已按旧内容缓存，后续磁盘内容更新但因 URL 未变命中旧缓存 | 版本戳链 `20261012b→c→d→e` 全量提升（index.html 40 处 + i18n.js I18N_PACK_VERSION + style.css @import 11 处 + 5 个独立 HTML 页 12 处 + share.js 2 处 + SW CACHE v2.18→v2.20），SW 全量失效重载 |
| R2 | 登录 / 注册 / 初始化表单 label 缺 `data-i18n`（标签恒中文） | 🟡 中 | public/index.html L177-372 | 表单 label 仅硬编码中文，无 i18n 属性，6 语言切换无效 | 补 17 个新键（`login.id_label` / `login.pwd_label` / `register.code_label` / `init.*` 等）+ 复用 4 个已有键，6 份语言包同步；初始化完成区改用 `<span data-i18n>…</span><strong>` 结构避免 textContent 覆盖子元素 |

### 6.2 激活码管理：彻底删除 + 使用日志（v2/v3，2026-10-13 完成并测试通过）

| # | 需求 | 实现 |
|---|------|------|
| R3 | 激活码「彻底删除」（物理删除 + 留证） | `server/activation_code_service.js` 新增 `deleteCode`（物理删除 + 审计）；`server/routes/admin_users.js` 新增 `POST /admin/activation-codes/delete`；后台激活码列表新增删除按钮 |
| R4 | 激活码使用日志（激活了哪个账号 / 显示名） | `validateAndConsume` 记录 `used_by` / `used_display_name`；`public/js/admin-activation.js` 后台展示使用日志 + CSV 导出含显示名列；`admin.activation.used_display_name` / `csv_display_name` 键 6 语言同步 |

### 6.3 UI 层级与遮盖（v4）

| # | 问题 | 严重度 | 位置 | 根因 | 修复内容 |
|---|------|--------|------|------|----------|
| R5 | `#confirmModal` z-index 1000 低于 `.lightbox` 1050 | 🟡 中 | public/css/04-components.css | `showConfirm` 走 `.modal` 容器（z-index 1000），相册 lightbox（1050）打开时点删除照片，确认框被 lightbox 遮罩盖住 | `body #confirmModal { z-index: 1100; }`（与 `.confirm-overlay` 同级，恒高于 modal/lightbox） |
| R6 | 回到顶部按钮 `z-index:1000` 与 `.modal` 同级 | 🟢 低 | public/css/ui-enhance.css:1272 | `.scroll-top-btn/.scroll-to-top/.scroll-to-top-btn` 与 modal 同级，弹窗打开场景下可能浮动到遮罩之上 | 统一压至 900（`body .scroll-top-btn/.scroll-to-top/.scroll-to-top-btn { z-index:900 }`），与 `.back-to-top` 一致 |
| R7 | style.css `@import` 子样式版本戳滞留 `20261012b` | 🟡 中 | public/css/style.css:9-24 | style.css 内 `@import url('04-components.css?v=20261012b')` 子戳未随主戳提升，SW cache-first 命中旧缓存，CSS 修复送不到客户端 | 全部 11 处子戳同步 `20261012b→20261012e` |

### 6.4 验证结论（2026-10-13）

- **浏览器实测**（`http://localhost:3456/?lang=en`）：登录/注册/初始化/VRC 表单英文标签全部正确渲染；`#scrollTopBtn=900`、`#confirmModal=1100`、`#lightbox=1050`、toast=2147483647 层级实测生效。
- **全量测试**：50 套件 · 901 测试全绿（含 i18n / security-regressions / round6-sync-regressions / route-inventory）。
- 版本戳链 `20261012e` 全站单一（index / style.css @import / 5 个独立 HTML / share.js / i18n.js 一致）；SW CACHE = jingtu-v2.20。
- 路由守恒基线同步更新为 491 条（v2 激活码删除路由 `POST /api/admin/activation-codes/delete` 新增，live=golden 守卫转绿）。
