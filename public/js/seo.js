/**
 * seo.js — SEO 注入器（2026-08-31 新增）
 *
 * 职责：
 * 1. 写入 og:url / og:site_name / og:locale / twitter:*（基于 location.origin，避免硬编码域名）
 * 2. 注入 Organization + WebSite JSON-LD（搜索引擎结构化数据）
 * 3. 暴露 SITE_SEO 与 setPageSeo({title, description, image})：
 *    - 路由模块切换时调用 setPageSeo，可更新 head 中的 og:title / og:description / og:image
 *    - 当前路由的 canonical 也由 setPageSeo 同步刷新（避免 og:url 与实际页面错配）
 *
 * 不做的事：
 * - 不重写 description（已在静态 meta 中写好，避免闪烁）
 * - 不接管 sitemap / robots（由后端 routes/sitemap.js 提供）
 */
(function () {
  'use strict';
  if (window.SITE_SEO && window.SITE_SEO.__inited) return;

  var DEFAULTS = {
    siteName: '境途同游',
    title: '境途同游 - VRChat Group',
    description: '面向 VRChat 玩家的社群平台：群组相册、活动报名、动态分享、成员地图与实时聊天。',
    image: '/assets/group-avatar.png',
    twitterSite: '@jingtu_vrchat'
  };

  function origin() {
    // location.origin 在 file:// 或异常环境下可能为空，做兜底
    try { return window.location.origin || ''; } catch (e) { return ''; }
  }

  function setMeta(name, value) {
    var sel = document.head.querySelector('meta[property="' + name + '"]') ||
              document.head.querySelector('meta[name="' + name + '"]');
    if (!sel) {
      sel = document.createElement('meta');
      var attr = name.indexOf('og:') === 0 ? 'property' : 'name';
      sel.setAttribute(attr, name);
      document.head.appendChild(sel);
    }
    sel.setAttribute('content', value);
  }

  function setCanonical(href) {
    var l = document.head.querySelector('link[rel="canonical"]');
    if (!l) { l = document.createElement('link'); l.setAttribute('rel', 'canonical'); document.head.appendChild(l); }
    l.setAttribute('href', href);
  }

  function upsertJsonLd(id, payload) {
    var old = document.getElementById(id);
    if (old) old.parentNode.removeChild(old);
    var s = document.createElement('script');
    s.type = 'application/ld+json';
    s.id = id;
    s.textContent = JSON.stringify(payload);
    document.head.appendChild(s);
  }

  // 基础 og:url + site_name
  var o = origin();
  if (o) setMeta('og:url', o + '/');
  setMeta('og:site_name', DEFAULTS.siteName);
  setMeta('twitter:site', DEFAULTS.twitterSite);
  if (o) setCanonical(o + '/');

  // JSON-LD: Organization + WebSite（含 SearchAction 提示潜在站点搜索框）
  upsertJsonLd('jsonld-org', {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: DEFAULTS.siteName,
    url: o || '/',
    logo: (o || '') + '/assets/group-avatar.png',
    sameAs: [],
    description: DEFAULTS.description
  });
  upsertJsonLd('jsonld-site', {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: DEFAULTS.siteName,
    url: o || '/',
    inLanguage: ['zh-CN', 'en', 'ja', 'fr', 'de', 'ru']
  });

  // 页面级覆写：路由模块切换 Tab 时调用
  function setPageSeo(opts) {
    if (!opts) return;
    if (opts.title) {
      setMeta('og:title', opts.title);
      setMeta('twitter:title', opts.title);
      document.title = opts.title + ' · ' + DEFAULTS.siteName;
    }
    if (opts.description) {
      setMeta('og:description', opts.description);
      setMeta('twitter:description', opts.description);
    }
    if (opts.image) {
      setMeta('og:image', opts.image);
      setMeta('twitter:image', opts.image);
    }
    if (opts.path) {
      var url = (o || '') + (opts.path[0] === '/' ? opts.path : '/' + opts.path);
      setMeta('og:url', url);
      setCanonical(url);
    }
  }

  function getDefaults() { return Object.assign({}, DEFAULTS); }

  window.SITE_SEO = {
    __inited: true,
    setPageSeo: setPageSeo,
    getDefaults: getDefaults,
    origin: origin
  };
})();
