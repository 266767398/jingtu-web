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
const CACHE = 'jingtu-v2.45';
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
