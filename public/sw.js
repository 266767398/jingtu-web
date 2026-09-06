// 境途同游 — Service Worker v2.12 (20260826: 网站 logo 恢复为 group-avatar.png，新版圆形「境途同游」头像；版本化资源 cache-first 秒开；HTML network-first；其余 stale-while-revalidate)
const CACHE = 'jingtu-v2.14';
const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/css/style.css',
  '/manifest.json',
  '/assets/group-avatar.svg',
  '/assets/group-avatar.png',
  '/assets/group-banner.png',
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

  // HTML 文档：network-first（保证最新内容），失败用缓存兜底
  if (isNavigation(request)) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match('/offline.html').then(off => off || caches.match(request)))
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
