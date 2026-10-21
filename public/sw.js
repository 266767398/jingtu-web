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
const CACHE = 'jingtu-v2.79';
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
