// 境途同游 — Service Worker v2.25 (20261015:
//  ① 不再预缓存 '/' HTML —— 服务端对每个响应注入一次性 CSP nonce，被缓存下来的
//     HTML 携带的是「那次响应」的旧 nonce。一旦该缓存被 SW 命中（离线兜底、或旧
//     SW 残留未及时换代），就会与当次 CSP 头错配 → 页面内联脚本（含尾部事件绑定块
//     与页头引导块）全部被拦 → 选项卡/按钮点击失效（"刷新后点不了"的真实投递路径）。
//     故 HTML 一律走「网络优先 + offline.html 兜底」，绝不进预缓存清单。
//  ② 替换 group-hero 新横幅，强制老用户重装 SW 重抓首屏背景，避免
//     stale-while-revalidate 继续返回旧横幅缓存)
// UI-2 修复：CACHE 版本随前端版本戳 20261017c 同步 bump，确保旧 SW 换代时清缓存
// V6.9X BUG修复+新功能：CACHE 版本随前端版本戳 20261018c 同步 bump（完整资料页+封面上传）
// V6.10 信任光环：CACHE 版本随前端版本戳 20261019g 同步 bump（地图成员位置图层取数修复）
// V6.11 半透明UI：CACHE 版本随前端版本戳 20261019h 同步 bump（站点背景图存在时 UI 半透明化）
// V6.11b 半透明UI：主题选择器修正，版本戳 20261019i 同步 bump
// V6.12 头像信任环：修复圆形容器 overflow:hidden 裁掉外圈，版本戳 20261019j 同步 bump
// V6.12b 头像信任环：成员弹窗 86px 头像（切角布局）同样去除 overflow:hidden，版本戳 20261019k 同步 bump
// V6.13 移动端一致性：成员网格列数/弹窗滚动压缩/群组徽章缩放/半透明衬底环，版本戳 20261019l 同步 bump
// V6.14 后端修复：导出/资料/好友动态/相册通知/注销清理/评论事务/点赞幂等，版本戳 20261019m 同步 bump
// V6.15 群组头像双图修复：有真实头像的成员不再显示默认兜底图（双头像错位），版本戳 20261019n 同步 bump
// V6.16 光环按人可见+hover整环放大+动态效果开关：光环开关改为控制自己光环对别人可见、
//       群组卡片悬停头像与光环一起放大、主题面板新增「动态效果」强制开启开关，版本戳 20261019o 同步 bump
// V6.17 我的信息光环绑定真实信任等级：名册无记录时用 users.trust_level 回填（绑定/个人页后台刷新），
// V6.18 聊天两档/互关独立列表/主题服务端持久化/成员卡整卡点击办详情/资料页VRChat在线状态，
//       版本戳 20261020b 同步 bump
// V6.19 动画性能：进度条/上传进度/RTC音量条/全局加载条/签到彩带改用 transform（scaleX / translate3d），
//       will-change 去掉 top/width 等 layout 属性；半透明 UI 补齐 --bg2/--bg3 等别名变量复盖，版本戳 20261020b 同步 bump
// V6.20 无障碍反馈：主题面板动态效果开关（force-anim）补「减少动态效果」一次性提示；游客态封面/背景兜底注释对齐私有目录，
//       CACHE 版本随前端版本戳 20261020c 同步 bump
// V6.21 P3 加固：WS 关系校验/坐标钳制/隐身 fail-closed、diff 任务防重入、登录 IP 限流桶、评论编辑锁、
//       live.js 归档；CACHE 版本随前端版本戳 20261020d 同步 bump
// V6.22 P3 收尾：Nginx 品牌错误页（public/error/）、3456 回环监听、启动器端口占用文案、
//       gradient 动画默认降级、avatar-cache TTL 清理；CACHE 版本随前端版本戳 20261020e 同步 bump
// V6.23 UI 合规（手册复查）：01-variables.css 补 color-scheme（深浅主题对齐原生控件/滚动条）、
//       hero 关键图 fetchpriority=high；CACHE 版本随前端版本戳 20261020f 同步 bump
// V6.24 首屏性能：安装期预缓存不再包含三张大图（hero/banner/avatar），图片改由下方
//       stale-while-revalidate 按需缓存；hero 由 PNG 2.1MB 换为 JPEG 287KB。CACHE 版本随
//       前端版本戳 20261020g 同步 bump
// V6.25 遗漏优化（性能改进轮第二轮）：① 缓存条目上限淘汰（CACHE_MAX_ENTRIES + 内存 LRU，
//       防 map-tiles 等无版本号静态资源无限膨胀 CacheStorage）；② 预缓存清单与 manifest.json
//       统一为 png 图标（pwa-icon-192/512.png），并补品牌头像小图 group-avatar-192.png；
//       favicon/og 分享图换小体积资源（64px/横幅）。CACHE 版本随前端版本戳 20261020h 同步 bump
// V6.26 响应式 hero：新增 group-hero-960.jpg（75.8KB），index.html 用 srcset/sizes 让移动端
//       只取 960w 小图、桌面取 1920w 原图，preload 同步 imagesrcset；unpkg preconnect 降为
//       dns-prefetch（leaflet 已本地优先，平时不建连）。CACHE 版本随前端版本戳 20261020i 同步 bump
// V6.27 内存专项：前端 postsDetailCache 加上限（200 篇按写入序清最旧一半）；服务端
//       collections 搜索缓存加周期清理与上限（同 csrf 模式）。CACHE 版本随前端版本戳 20261020j 同步 bump
// V6.28 懒加载补全：帖子流头像/评论头像、好友列表/共同好友/动态流头像、聊天搜索会话头像、
//       活动队伍成员头像补 loading="lazy"（列表性动态图视口外不再提前请求）。CACHE 版本随前端版本戳 20261020k 同步 bump
// V6.29 成员身份修复：角色兜底不再出现「游客/访客」（前端 fallback→成员、后端出站归一化、
//       admin 总览封禁统计 i18n 键名修正），完成后删除 members.role_guest 死键，新增 admin.banned_users。
//       CACHE 版本随前端版本戳 20261021a 同步 bump
// V6.30 收藏/权限组/时区修复轮：VRChat 收藏移除好友、只留模型/世界；网站收藏左侧分类支持
//       重命名；刷新只同步当前类型；权限组继承运行时生效 + 系统组层级自愈；Docker 按 IP 自动时区。
//       CACHE 版本随前端版本戳 20261021b 同步 bump
// V6.31 群组成员资料全站同步：详情页「刷新资料」成功后头像/昵称回写 group_roster 并
//       WebSocket 广播（修复此前 VRChat 群 grp_xxx 广播因 parseInt=NaN 永远发不出的静默 bug），
//       前端卡片即时换新头像/昵称；发起者本人在 members.js 同步后立即更新本地卡片。
//       CACHE 版本随前端版本戳 20261021c 同步 bump
// V6.32 质检评审轮（P3低风险完善）：收藏分组/添加收藏防重复提交；VRChat 收藏删除改
//       showConfirm 统一弹窗；同步状态条 taskDone 服务端文本转义；成员列表全量分页改
//       6路并行批次；#collAddFolderBtn 补 aria-label；#loginId 双防抖合并；beforeunload
//       改用 stopSlideshow 正确关闭相册轮播。CACHE 版本随前端版本戳 20261021d 同步 bump
// V6.33 P3 i18n 批次：管理侧栏（标题/5 分组/24 导航项/运维提示）、群邀请（占位符/按钮）、
//       生日卡片标题与新建按钮、VRChat 直连登录提示补 6 语言键（新增 38 键 × 6 文件）；
//       侧栏图标/文字拆分为两个 span，图标样式选择器收窄为 :first-child 保持原字号。
//       CACHE 版本随前端版本戳 20261021e 同步 bump
// V6.34 P3 i18n 第二批：主题面板（模式/亮度/动态效果/11 主题色 title/重置关闭）、
//       初始化向导（步骤标签/环境检查标题与描述）、我的 Tab（头像操作、侧栏 6 项、
//       个人资料表单、个性签名/简介、数据统计、账号信息、修改密码、主题外观），
//       管理设置面板（站点基础/全局请求限制/定时任务/Hero 装修/保存设置/在线更新）；
//       新增 92 键 × 6 文件（3547 → 3639），复用 me.*/common.save 等既有键。
//       CACHE 版本随前端版本戳 20261021f 同步 bump
// V6.35 P3 i18n 第三批：核心内容 Tab —— 登录区残留（检查状态/头像 alt）、成员 Tab
//       （角色筛选项与 aria）、VRC 黑名单表单、公告发布按钮、活动 Tab（状态筛选/
//       视图切换/历史/iCal 导出/VRC 同步/批量归档/批量删除）、动态 Tab（发动态/类型
//       筛选/每页条数/加载更多）、相册 Tab（分类/上传/选择/批量删除/回收站/拖拽提示）、
//       收藏弹窗（类型选项/分组名占位）；新增 37 键 × 6 文件（3639 → 3676），
//       复用 events.export_ical/album.select_btn/admin_vrc.bl_* 等既有键。
//       CACHE 版本随前端版本戳 20261021g 同步 bump
const CACHE = 'jingtu-v2.86';
const STATIC_ASSETS = [
  '/offline.html',
  '/css/style.css',
  '/manifest.json',
  '/assets/group-avatar.svg',
  '/assets/group-avatar-192.png',
  '/assets/pwa-icon-192.png',
  '/assets/pwa-icon-512.png'
];

// ===== 缓存容量上限（V6.25）=====
// 站点含大量无版本号静态资源（如地图瓦片 map-tiles 约 2000 个），若全量写入
// CacheStorage 且无淘汰，长期使用会无限膨胀。这里设条目上限，超出按最近使用
// （LRU，内存时间戳表）淘汰最旧条目。SW 存活期间 LRU 表有效；SW 重启后表为空，
// 此时按缓存内 keys 顺序近似淘汰，瓦片等幂等资源重拉即可，无正确性问题。
const CACHE_MAX_ENTRIES = 1500;
const lru = new Map(); // url -> 最近使用时间戳

function touchLru(url) { lru.set(url, Date.now()); }

// 超出上限时按 LRU 时间升序（最久未用在前）淘汰最旧条目；无时间戳的排最前
async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= CACHE_MAX_ENTRIES) return;
  const sorted = keys.slice().sort((a, b) =>
    (lru.get(a.url) || 0) - (lru.get(b.url) || 0)
  );
  const overflow = sorted.length - CACHE_MAX_ENTRIES;
  const doomed = sorted.slice(0, overflow);
  await Promise.all(doomed.map(k => cache.delete(k)));
  for (const k of doomed) lru.delete(k.url);
}

// 统一写入入口：写缓存 + 记 LRU + 超限淘汰
async function putWithLimit(cache, request, response) {
  await cache.put(request, response);
  touchLru(request.url);
  await trimCache(cache);
}

// 判断是否带版本号查询参数（?v=xxx），带版本号的资源 URL 变即内容变，可放心 cache-first
function isVersioned(url) {
  return url.searchParams.has('v');
}

// 判断是否为 HTML 文档导航请求
function isNavigation(request) {
  return request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html');
}

// 安装：预缓存核心资源
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      // 不阻塞安装，部分资源 404 不影响
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(() => {/* skip failed */})
        )
      );
    })
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 拦截请求
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 只处理同源 GET 请求
  if (url.origin !== location.origin) return;
  if (request.method !== 'GET') return;

  // API 请求不缓存（动态数据）
  if (url.pathname.startsWith('/api/')) return;

  // 带版本号的静态资源（js/css/vendor）：cache-first，命中零网络请求
  if (isVersioned(url)) {
    e.respondWith(
      caches.match(request).then(hit => {
        if (hit) { touchLru(request.url); return hit; }
        return fetch(request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(cache => putWithLimit(cache, request, clone));
          }
          return res;
        }).catch(() => caches.match(request));
      })
    );
    return;
  }

  // HTML 文档：network-first（保证最新内容）；失败仅用 offline.html 兜底。
  // 注意：绝不把 HTML 写入缓存 —— 服务端每响应注入一次性 CSP nonce，缓存下来的
  // HTML 携带旧 nonce，与当次 CSP 头错配后页内内联脚本全被拦（见文件头说明）。
  if (isNavigation(request)) {
    e.respondWith(
      fetch(request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // 其余静态资源（无版本号的图片等）：stale-while-revalidate
  e.respondWith(
    caches.match(request).then(hit => {
      if (hit) touchLru(request.url);
      const refresh = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => putWithLimit(cache, request, clone));
        }
        return res;
      }).catch(() => caches.match(request));
      return hit || refresh;
    })
  );
});
