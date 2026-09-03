// ==================== 动画强制开关（force-anim 逃生舱）====================
// 背景：站点尊重系统「减少动态效果」(prefers-reduced-motion) 无障碍偏好，
// 一旦系统/浏览器开启该偏好，所有 CSS 动画与过渡会被全局禁用（避免眩晕/不适）。
// 但部分用户希望即便开启了系统偏好也强制显示动画。为此提供逃生舱：
//   1) URL 带 ?anim=on   → 强制开启动画（写入 localStorage 持久化）
//   2) URL 带 ?anim=off  → 强制关闭并清除持久化
//   3) localStorage.jingtu_anim === 'on' → 持久强制开启动画
// 命中后给 <html> 加 .force-anim，CSS 中 reduced-motion 的通杀规则改为
// :root:not(.force-anim) *，从而被 .force-anim 豁免（见各 css 的 @media 块）。
(function () {
  try {
    var params = new URLSearchParams(location.search);
    var p = params.get('anim');
    if (p === 'on') { localStorage.setItem('jingtu_anim', 'on'); }
    else if (p === 'off') { localStorage.removeItem('jingtu_anim'); }
    if (localStorage.getItem('jingtu_anim') === 'on') {
      document.documentElement.classList.add('force-anim');
    }
  } catch (e) { /* localStorage/URLSearchParams 不可用则忽略，回退到系统偏好 */ }
})();

// ==================== 路由模块懒加载（P1 性能优化）====================
// 目标：缩短首屏关键路径。改动前 index.html 一次性急切加载 24 个路由模块
// （~1.17MB 未压缩 JS）；改动后仅加载「当前访问 Tab 所需模块」，其余在浏览器
// 空闲时后台预载，导航到任意 Tab 时若尚未加载则按需加载。
//
// 依赖：
//  - core.js 顶部的 DOMContentLoaded 垫片（保证延迟加载模块的自我初始化会执行）
//  - 本文件须在 ui.js 之后、init.js/main.js 之前加载，以包裹 switchTab
//
// 安全网：若某 Tab 渲染时因模块缺失抛错，则全量加载其余模块后重试一次；
// 空闲预载也会在数秒内覆盖绝大多数跨模块依赖，因此映射表即使略有遗漏也不影响正确性。

// 全部路由模块（不含基础设施：core/ui/i18n/theme/auth/reveal/nav-more/init/main）
var ROUTE_MODULES = [
  'members.js', 'home.js', 'group.js', 'announcements.js', 'events.js',
  'vrc.js', 'geo.js', 'map.js', 'chat.js', 'album.js',
  'admin-users.js', 'admin-perms.js', 'admin-vrc.js', 'admin-ui.js',
  'admin-model-collections.js', 'posts.js', 'friends.js', 'follows.js',
  'birthday.js', 'profile.js', 'profile-page.js',
  'checkin.js', 'checkin-extra.js', 'achievements.js', 'collections.js'
];

// 2026-08-31：被禁用的功能模块（占用网络多/暂不需要）
// - 'live'：直播功能。入口通过 CSS [data-feature-disabled] 隐藏，模块不参与懒加载也不预载；
//   服务端路由 live.js 仍在 server.js 中挂载（保留代码资产，需要时一行启用）。
var DISABLED_FEATURES = new Set(['live']);
function _isDisabled(name) { return DISABLED_FEATURES.has(name); }

// 各 Tab 首次渲染所需的核心模块（用于首访按需加载；跨模块依赖由空闲预载兜底）
var TAB_MODULES = {
  home: ['home.js'],
  members: ['members.js'],
  me: ['admin-users.js', 'profile.js', 'profile-page.js'],
  group: ['group.js', 'members.js'],
  announcements: ['announcements.js'],
  events: ['events.js'],
  album: ['album.js'],
  map: ['geo.js', 'map.js', 'vrc.js'],
  chat: ['chat.js'],
  birthday: ['birthday.js'],
  posts: ['posts.js'],
  collections: ['collections.js'],
  friends: ['friends.js'],
  follows: ['follows.js'],
  'profile-user': ['profile.js', 'profile-page.js'],
  admin: ['admin-users.js', 'admin-perms.js', 'admin-vrc.js', 'admin-model-collections.js', 'admin-ui.js']
  // notifications 由 ui.js 提供，无需额外模块
};

var _loadedMods = Object.create(null);
var _loadingMods = Object.create(null);

function _loadScriptOnce(src) {
  if (_loadedMods[src]) return Promise.resolve();
  if (_loadingMods[src]) return _loadingMods[src];
  var p = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = '/js/' + src + '?v=20260902b';
    s.async = false; // 同批脚本保持插入顺序，保证模块间相对依赖
    s.onload = function () { _loadedMods[src] = true; resolve(); };
    s.onerror = function () { reject(new Error('Failed to load ' + src)); };
    document.head.appendChild(s);
  });
  _loadingMods[src] = p;
  return p;
}

function _ensureTabModules(tab, cb) {
  var mods = TAB_MODULES[tab] || [];
  Promise.all(mods.map(_loadScriptOnce)).then(cb, cb);
}

function _preloadRemaining() {
  ROUTE_MODULES.forEach(function (m) {
    if (!_loadedMods[m]) _loadScriptOnce(m);
  });
}

// 包裹 switchTab：先确保模块就绪再渲染；渲染中因缺失模块抛错则全量加载后重试一次
(function () {
  if (typeof switchTab !== 'function') return;
  var _origSwitchTab = switchTab;
  var _retried = false;

  // ==================== 页面级 SEO（按 Tab 自动写入 og:* / twitter:* / canonical）====================
  // 需求：seo.js 暴露了 setPageSeo 但目前只有入口默认值。各 Tab 切换时应自动切换
  // og:title / og:description / og:url / canonical，避免搜索引擎收录全站相同 description。
  // 策略：集中在 loader.js 维护一张 TAB_SEO_MAP，包裹器渲染完成后调用一次。
  // 业务模块若需要更精细的 SEO（如打开某个动态详情），可在自己内部再调用一次 SITE_SEO.setPageSeo 覆盖。
  var TAB_SEO_MAP = {
    'home':           { title: '境途同游首页',         path: '/',       description: '面向 VRChat 玩家的社群平台：群组相册、活动报名、动态分享、成员地图与实时聊天。' },
    'members':        { title: '成员总览',              path: '/members',description: '查看境途同游全部成员的活跃度、所在地与在线状态。' },
    'group':          { title: '群组相册',              path: '/group',  description: '群组专属相册：随时上传精彩瞬间，沉淀 VRChat 同游回忆。' },
    'announcements':  { title: '群组公告',              path: '/announcements', description: '管理员发布的最新公告、活动通知与平台变动说明。' },
    'events':         { title: '活动报名',              path: '/events', description: '即将到来的 VRChat 主题活动：在线报名、签到、回顾。' },
    'birthday':       { title: '成员生日墙',            path: '/birthday',description: '境途同游成员生日日历：今天有谁过生日？' },
    'album':          { title: '公共相册',              path: '/album',  description: '海量 VRChat 截图作品：按分类浏览、点赞与评论。' },
    'collections':    { title: '收藏的世界',            path: '/collections', description: '成员收藏的 VRChat 世界与模型，按热度与时间排序。' },
    'posts':          { title: '动态广场',              path: '/posts',  description: 'VRChat 玩家新鲜事：图文动态、互动评论、点赞。' },
    'map':            { title: '成员地图',              path: '/map',    description: '基于地理位置查看境途同游成员在全球的分布。' },
    'chat':           { title: '实时聊天',              path: '/chat',   description: '群组内实时聊天频道。' },
    'friends':        { title: '我的好友',              path: '/friends',description: '境途同游好友列表、互相关注与近期动态。' },
    'follows':        { title: '我的关注',              path: '/follows',description: '我关注的成员与最新动态。' },
    'notifications':  { title: '通知中心',              path: '/notifications', description: '我的互动通知：回复、点赞、关注、系统提醒。' },
    'me':             { title: '个人资料',              path: '/me',     description: '我的个人资料、设置与成就。' },
    'profile-user':   { title: '成员资料',              path: '/u',      description: '查看成员的公开资料、动态与作品集。' },
    'admin':          { title: '管理后台',              path: '/admin',  description: '管理员后台：用户、权限、模型收藏、界面与审计日志。' }
    // 'live' 已被 DISABLED_FEATURES 屏蔽，切换路径走 _isDisabled 分支，不会进入此处
  };
  function _afterSwitchTab(tab) {
    try {
      if (!window.SITE_SEO || typeof window.SITE_SEO.setPageSeo !== 'function') return;
      var conf = TAB_SEO_MAP[tab];
      if (!conf) return; // 未知 Tab：保留上一次的 SEO
      var defaults = window.SITE_SEO.getDefaults ? window.SITE_SEO.getDefaults() : {};
      window.SITE_SEO.setPageSeo({
        title: conf.title,
        description: conf.description || defaults.description || '',
        path: conf.path,
        image: defaults.image
      });
    } catch (e) { /* SEO 失败不影响主流程 */ }
  }

  window.switchTab = function (tab, force) {
    // 兜底：被禁用的 Tab 直接忽略调用，避免任何 JS 路径绕过 CSS 隐藏激活面板
    if (_isDisabled(tab)) {
      try {
        if (window.SITE_LOG && SITE_LOG.warn) SITE_LOG.warn('switchTab ignored (feature disabled): ' + tab);
      } catch (e) { /* 静默 */ }
      return;
    }
    _ensureTabModules(tab, function () {
      try {
        _origSwitchTab(tab, force);
      } catch (err) {
        if (!_retried && !_loadedMods.__all) {
          _retried = true;
          Promise.all(ROUTE_MODULES.map(_loadScriptOnce)).then(function () {
            _loadedMods.__all = true;
            _origSwitchTab(tab, force);
            _afterSwitchTab(tab);
            _retried = false;
          }, function () {
            _retried = false;
            throw err;
          });
        } else {
          throw err;
        }
      }
      // 正常分支：渲染完成后立即刷新页面级 SEO
      _afterSwitchTab(tab);
    });
  };
})();

// 浏览器空闲时预载其余路由模块，不阻塞首屏
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(_preloadRemaining, { timeout: 4000 });
} else {
  setTimeout(_preloadRemaining, 1500);
}

// ==================== 点赞动效触发器（SITE_LIKE）====================
// 业务模块（posts/album/...）在切换 like 状态时调用 triggerBurst，
// 给按钮加上 .like-burst / .like-burst-cancel 类，由 likes-anim.css 完成动画。
// 注意：仅做「加类-定时移除」这一种低开销调度，动画本身全部由 CSS 处理，
// 即使 JS 关闭也能看到部分反馈（只是没有 sparkle），不影响无障碍。
window.SITE_LIKE = {
  /** @param {HTMLElement|null} el 按钮元素
   *  @param {boolean} liked 切换后的状态：true=已点赞(心爆裂) false=取消(小回弹)
   *  @param {object} [opts] { burstMs:600, cancelMs:260 } */
  triggerBurst: function (el, liked, opts) {
    if (!el || !el.classList) return;
    opts = opts || {};
    var burstMs = opts.burstMs || 600;
    var cancelMs = opts.cancelMs || 260;
    var cls = liked ? 'like-burst' : 'like-burst-cancel';
    var ms = liked ? burstMs : cancelMs;
    // 防止上一次动画尚未结束造成 keyframe 重启抖动：先清掉两个类，再重排再加
    el.classList.remove('like-burst');
    el.classList.remove('like-burst-cancel');
    // 强制 reflow，让浏览器识别「类真的被移除过」，从而使下一次 add 重新触发动画
    // eslint-disable-next-line no-unused-expressions
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, ms);
  },
  /**
   * 防重复点赞锁（前端兜底）。
   * 给同一按钮绑定 onClick handler 之前先用 guardLock 包裹：
   *   SITE_LIKE.guardLock(btn, 700, function(){ ... 真正发请求 ... });
   * 700ms 内再次点击会被静默忽略，避免乐观 UI 与服务端回滚打架。
   * 该锁不持久化、刷新即丢，仅做"点得太快"的兜底。
   */
  guardLock: function (el, cooldownMs, fn) {
    if (!el) { fn(); return; }
    var until = parseInt(el.dataset.likeLockUntil || '0', 10);
    var now = Date.now();
    if (until > now) return; // 冷却中，丢弃本次点击
    el.dataset.likeLockUntil = String(now + (cooldownMs || 700));
    try { fn(); } finally {
      // 防御性清理：万一 fn 抛异常，确保锁在 cooldownMs 后总能解除
      setTimeout(function () {
        if (Date.now() >= parseInt(el.dataset.likeLockUntil || '0', 10)) {
          delete el.dataset.likeLockUntil;
        }
      }, (cooldownMs || 700) + 50);
    }
  },
  /**
   * 热度计算（前端纯函数）：根据点赞数 + 时间衰减 + 当前在线状态
   * 返回 0-100 的热度分。业务模块可在排序/置顶时调用。
   *
   *   heat = clamp(0, 100, log10(1 + likes) * 22 + onlineBonus + recencyBonus)
   *   - log10 让头部分布更平滑，避免万人点赞用户把所有人压在底部
   *   - onlineBonus 在线 +12，让当前活跃用户上浮
   *   - recencyBonus 最近 24h 收到过赞 +8，反映短期热度
   */
  heatScore: function (likes, opts) {
    opts = opts || {};
    var likesNum = Math.max(0, Number(likes) || 0);
    var base = Math.log10(1 + likesNum) * 22;
    var onlineBonus = opts.isOnline ? 12 : 0;
    var recencyBonus = opts.recent24h ? 8 : 0;
    var raw = base + onlineBonus + recencyBonus;
    return Math.max(0, Math.min(100, Math.round(raw)));
  }
};
