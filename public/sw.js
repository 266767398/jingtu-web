// 境途同游 — Service Worker v1.0
const CACHE = 'jingtu-v1';
const STATIC_ASSETS = [
  '/',
  '/css/style.css',
  '/manifest.json',
  '/assets/group-avatar.svg',
  '/assets/group-banner.png',
  '/assets/pwa-icon-192.svg',
  '/assets/pwa-icon-512.svg'
];

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

// 拦截请求：网络优先，缓存兜底
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 只处理同源请求
  if (url.origin !== location.origin) return;

  // API 请求不缓存（动态数据）
  if (url.pathname.startsWith('/api/')) return;

  // 静态资源：网络优先，失败则使用缓存
  e.respondWith(
    fetch(request)
      .then(res => {
        // 只缓存成功响应
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
