// 境途同游 — Service Worker v2.25 (20261015:
//  ① 不再预缓存 '/' HTML —— 服务端对每个响应注入一次性 CSP nonce，被缓存下来的
//     HTML 携带的是「那次响应」的旧 nonce。一旦该缓存被 SW 命中（离线兜底、或旧
//     SW 残留未及时换代），就会与当次 CSP 头错配 → 页面内联脚本（含尾部事件绑定块
//     与页头引导块）全部被拦 → 选项卡/按钮点击失效（"刷新后点不了"的真实投递路径）。
//     故 HTML 一律走「网络优先 + offline.html 兜底」，绝不进预缓存清单。
//  ② 替换 group-hero.png 新横幅，强制老用户重装 SW 重抓首屏背景，避免
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
//       版本戳 20261019p 同步 bump
const CACHE = 'jingtu-v2.68';
const STATIC_ASSETS = [
  '/offline.html',
  '/css/style.css',
  '/manifest.json',
  '/assets/group-avatar.svg',
  '/assets/group-avatar.png',
  '/assets/group-banner.png',
  '/assets/group-hero.png',
  '/assets/pwa-icon-192.svg',
  '/assets/pwa-icon-512.svg'
];

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
        if (hit) return hit;
        return fetch(request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
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
      const refresh = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return res;
      }).catch(() => caches.match(request));
      return hit || refresh;
    })
  );
});
