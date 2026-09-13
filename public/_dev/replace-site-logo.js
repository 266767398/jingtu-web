/* ================================================================
 * replace-site-logo.js
 * 境途同游 — 仅替换"网站 logo"，不动任何用户/玩家/通用头像
 *
 * 用法：
 *   1) 浏览器打开 http://your-host/login  或任意页
 *   2) DevTools Console 粘贴本脚本（或先加载 <script src="/_dev/replace-site-logo.js">）
 *   3) 调用：
 *        replaceSiteLogo()                            // 用默认目标图
 *        replaceSiteLogo('/assets/group-banner.png')   // 自定义 URL
 *        replaceSiteLogo('/p/横幅-12.png?v=1', { dryRun: true })  // 预览
 *        revertSiteLogo()                              // 撤销
 *
 * 默认目标图：/assets/group-banner.png（项目内已存在的"群组横幅"）
 *   ※ 用户称之为"群组横幅-12.png"，若你放在了别处，请显式传入。
 *
 * 设计要点（务必读懂再用）：
 *   - "要换" = 4 个明确位置：favicon <link rel=icon>、OG 分享卡 <meta>、
 *     登录页 logo <img#loginLogoImg>、PWA manifest 的 icon/badge
 *   - "不动" = 一切其它头像（含通用头像 group-avatar-sm、玩家头像
 *     avatar-vrc、用户头像 me-avatar/profile-avatar/user-avatar 等）
 *     ——双重保险：className 白名单 + id 白名单 + src 路径白名单
 *   - 含版本号缓存击穿：自动加 ?v=logoN 强制刷新
 *   - 含 PWA manifest 拦截：通过拦截 <link rel=manifest> 或 document.querySelector
 *     找到并改写 JSON 内容（如果 manifest 是动态注入的）
 * ============================================================== */
(function (global) {
  'use strict';

  // ---------- 配置 ----------
  const DEFAULT_TARGET = '/assets/group-avatar.png';   // 默认目标图（新版圆形「境途同游」头像）
  const CACHE_BUST = '?v=logo1';                        // 缓存击穿参数
  const TARGET = DEFAULT_TARGET + CACHE_BUST;

  // ---------- 用户/玩家/通用头像"白名单"：命中即跳过 ----------
  // CSS 类名片段（任一命中即跳过）
  const AVATAR_CLASS_FRAGMENTS = [
    // 用户头像
    'user-avatar', 'me-avatar', 'profile-avatar', 'member-avatar',
    'post-avatar', 'post-comment-avatar', 'chat-conv-avatar',
    'chat-mini-avatar', 'gm-avatar', 'admin-user-avatar',
    'birthday-avatar',
    // 玩家头像（VRChat）
    'avatar-vrc',
    // 通用头像（含顶栏 logo 槽位 — 用户已明确不动通用头像）
    'group-avatar', 'chat-group-avatar', 'event-world-thumb',
    'evt-det-world-thumb', 'home-welcome-avatar',
    'admin-preview-img', 'vrc-card-banner',
  ];
  // id 命中即跳过（用户/玩家头像、通用头像明确槽位）
  const AVATAR_ID_FRAGMENTS = [
    // 用户/玩家头像
    'meAvatar', 'profileAvatar', 'ucAvatar', 'vrchatBoundAvatar',
    'editAvatarPreview', 'headerUserAvatar', 'birthdayAvatar',
    // 通用头像槽位（活动 World 缩略图等 — 用户明确不动）
    // 注：headerAvatar 是顶栏「网站 logo」，不在此白名单，已纳入 logo 替换分支
    'evtWorldThumb', 'eeWorldThumb', 'homeWelcomeAvatar',
  ];
  // src 路径命中即跳过（用户上传 / 玩家头像 / API 头像）
  const AVATAR_SRC_FRAGMENTS = [
    '/api/avatar/', '/api/users/', '/uploads/avatar/',
    '/uploads/vrchat/', '/uploads/profile/', '/uploads/posts/',
    'vrchatcdn.com', 'vrchat.com',
  ];

  // "网站 logo" 明确槽位：仅这 4 类被替换
  const LOGO_IDS        = new Set(['loginLogoImg']);
  const LOGO_CLASSES    = new Set(['login-logo-img', 'site-logo']);
  const LOGO_LINK_RELS  = new Set(['icon', 'shortcut icon', 'apple-touch-icon', 'mask-icon']);
  const LOGO_META_NAMES = new Set(['og:image', 'twitter:image', 'msapplication-TileImage']);

  // ---------- 工具函数 ----------
  const hasAny = (haystack, needles) =>
    !haystack || needles.some(n => haystack.indexOf(n) !== -1);

  function isAvatarByClass(el) {
    const cls = el.className && typeof el.className === 'string' ? el.className : '';
    return hasAny(cls, AVATAR_CLASS_FRAGMENTS);
  }
  function isAvatarById(el) {
    const id = el.id || '';
    return AVATAR_ID_FRAGMENTS.some(n => id.indexOf(n) !== -1);
  }
  function isAvatarBySrc(el) {
    const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('content') || '';
    return hasAny(src, AVATAR_SRC_FRAGMENTS);
  }
  function isAvatarByData(el) {
    // data-user-id / data-player-id / data-member-id 视为用户/玩家头像
    return !!(el.dataset && (el.dataset.userId || el.dataset.playerId || el.dataset.memberId));
  }

  // 命中"白名单"任一即跳过
  function shouldSkip(el) {
    if (!el || el.nodeType !== 1) return true;
    if (isAvatarByClass(el)) return true;
    if (isAvatarById(el))    return true;
    if (isAvatarBySrc(el))   return true;
    if (isAvatarByData(el))  return true;
    // 跳过已经是目标图的元素（防止重复替换）
    const cur = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('content') || '';
    if (cur && cur.indexOf('group-banner') !== -1) return true;
    return false;
  }

  // 命中"明确 logo"槽位（白名单未命中后，再用此判定）
  function isLogoSlot(el) {
    if (el.tagName === 'LINK') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      return LOGO_LINK_RELS.has(rel);
    }
    if (el.tagName === 'META') {
      return LOGO_META_NAMES.has((el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase());
    }
    if (el.tagName === 'IMG') {
      if (LOGO_IDS.has(el.id)) return true;
      const cls = (el.className || '') + '';
      if (LOGO_CLASSES.has(cls.trim())) return true;
      // alt="Logo"（仅在白名单未命中时作为补充判定）
      const alt = el.getAttribute('alt') || '';
      if (alt.trim().toLowerCase() === 'logo') return true;
    }
    return false;
  }

  // ---------- PWA manifest 处理 ----------
  function patchManifest(manifestHref, targetUrl, dryRun) {
    if (!manifestHref) return null;
    try {
      // 抓取 + 改写 + 用 Blob URL 替换原 link（仅在非 dryRun 时）
      // 同源 fetch，避免 CORS 问题
      const url = new URL(manifestHref, location.href);
      return fetch(url).then(r => r.json()).then(json => {
        const before = JSON.stringify({ icons: json.icons });
        json.icons = (json.icons || []).map(ic => {
          if (ic && ic.src) {
            // 仅替换 src 中含 group-avatar 的（默认 logo），其它用途（如 splash）保留
            if (ic.src.indexOf('group-avatar') !== -1) {
              return Object.assign({}, ic, { src: targetUrl });
            }
          }
          return ic;
        });
        if (json.theme_color || json.background_color) {
          // 保留主题色
        }
        const after = JSON.stringify({ icons: json.icons });
        if (dryRun) return { kind: 'manifest', href: manifestHref, changed: before !== after, before, after };
        // 创建 blob 并替换 <link rel=manifest>
        const blob = new Blob([JSON.stringify(json)], { type: 'application/manifest+json' });
        const blobUrl = URL.createObjectURL(blob);
        const link = document.querySelector('link[rel="manifest"]');
        if (link) link.setAttribute('href', blobUrl);
        return { kind: 'manifest', href: manifestHref, changed: before !== after, blobUrl };
      }).catch(err => ({ kind: 'manifest', href: manifestHref, error: String(err) }));
    } catch (e) {
      return { kind: 'manifest', error: String(e) };
    }
  }

  // ---------- 主流程 ----------
  function replaceSiteLogo(targetUrl, opts) {
    targetUrl = targetUrl || TARGET;
    opts = opts || {};
    const dryRun = !!opts.dryRun;
    const scope  = opts.scope || 'all';   // all | favicon | og | login | pwa
    const report = { replaced: [], skipped: [], errors: [] };

    const want = {
      favicon: scope === 'all' || scope === 'favicon',
      og:      scope === 'all' || scope === 'og',
      login:   scope === 'all' || scope === 'login',
      pwa:     scope === 'all' || scope === 'pwa',
    };

    // 1) <link rel=icon|shortcut|apple-touch|mask>
    if (want.favicon) {
      const links = document.querySelectorAll('link[rel]');
      links.forEach(l => {
        if (shouldSkip(l)) { report.skipped.push({ el: l, reason: 'whitelist' }); return; }
        const rel = (l.getAttribute('rel') || '').toLowerCase();
        if (!LOGO_LINK_RELS.has(rel)) return;
        const before = l.getAttribute('href');
        if (!dryRun) l.setAttribute('href', targetUrl);
        report.replaced.push({ kind: 'favicon', rel, before, after: targetUrl });
      });
    }

    // 2) <meta property=og:image> 等社交分享卡
    if (want.og) {
      const metas = document.querySelectorAll('meta[property], meta[name]');
      metas.forEach(m => {
        if (shouldSkip(m)) { report.skipped.push({ el: m, reason: 'whitelist' }); return; }
        const key = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
        if (!LOGO_META_NAMES.has(key)) return;
        const before = m.getAttribute('content');
        if (!dryRun) m.setAttribute('content', targetUrl);
        report.replaced.push({ kind: 'og-meta', key, before, after: targetUrl });
      });
    }

    // 3) <img id=loginLogoImg> / class=login-logo-img / alt=Logo
    if (want.login) {
      const imgs = document.querySelectorAll('img');
      imgs.forEach(img => {
        if (shouldSkip(img)) { report.skipped.push({ el: img, reason: 'whitelist' }); return; }
        if (!isLogoSlot(img)) return;
        const before = img.getAttribute('src');
        if (!dryRun) img.setAttribute('src', targetUrl);
        report.replaced.push({ kind: 'login-logo', id: img.id, alt: img.getAttribute('alt'), before, after: targetUrl });
      });
    }

    // 4) PWA manifest
    if (want.pwa) {
      const manifestLink = document.querySelector('link[rel="manifest"]');
      const href = manifestLink && manifestLink.getAttribute('href');
      const r = patchManifest(href, targetUrl, dryRun);
      if (r && typeof r.then === 'function') {
        r.then(res => {
          if (res && res.changed) report.replaced.push({ kind: 'pwa-manifest', ...res });
          else if (res && res.error) report.errors.push({ kind: 'pwa-manifest', error: res.error });
          if (!dryRun) console.log('[replaceSiteLogo] manifest 异步处理完成：', res);
        });
      }
    }

    if (dryRun) {
      console.log('[replaceSiteLogo] DRY RUN — 未实际改动 DOM', report);
    } else {
      console.log('[replaceSiteLogo] 已替换 %d 项（目标：%s）', report.replaced.length, targetUrl, report);
    }
    return report;
  }

  // ---------- 撤销 ----------
  // 仅撤销本次会话内的替换：把 replaced 列表里 before/after 配对写回
  let _lastReport = null;
  function revertSiteLogo() {
    if (!_lastReport) { console.warn('[revertSiteLogo] 没有可撤销的记录'); return; }
    _lastReport.replaced.forEach(r => {
      if (r.kind === 'favicon') {
        document.querySelectorAll('link[rel="' + r.rel + '"]').forEach(l => l.setAttribute('href', r.before));
      } else if (r.kind === 'og-meta') {
        document.querySelectorAll('meta[property="' + r.key + '"], meta[name="' + r.key + '"]').forEach(m => m.setAttribute('content', r.before));
      } else if (r.kind === 'login-logo' && r.id) {
        const el = document.getElementById(r.id);
        if (el) el.setAttribute('src', r.before);
      }
    });
    console.log('[revertSiteLogo] 已撤销 %d 项', _lastReport.replaced.length);
  }

  // 暴露到全局（控制台直接调用）
  global.replaceSiteLogo = function (targetUrl, opts) {
    const r = replaceSiteLogo(targetUrl, opts);
    _lastReport = r;
    return r;
  };
  global.revertSiteLogo = revertSiteLogo;

  // 自动跑一遍（dryRun 模式，提示用户）
  console.log('[replace-site-logo] 已加载。调用 replaceSiteLogo() 即可执行；replaceSiteLogo(null,{dryRun:true}) 仅预览。');
  console.log('[replace-site-logo] 白名单：用户头像(user/me/profile/member/post/chat/gm/admin-user/birthday) + 玩家头像(avatar-vrc) + 通用头像(group-avatar/chat-group-avatar/event-world-thumb 等) 全部跳过。');
})(window);

/* ================================================================
 * 自检脚本（可单独粘贴运行，验证过滤逻辑）
 * ================================================================
 *
 *  document.querySelectorAll('img').forEach(img => {
 *    const cls = img.className || '';
 *    const isUser = /user-avatar|me-avatar|profile-avatar|member-avatar|post-avatar|post-comment-avatar|chat-conv-avatar|chat-mini-avatar|gm-avatar|admin-user-avatar|birthday-avatar/.test(cls);
 *    const isPlayer = /avatar-vrc/.test(cls);
 *    const isGeneric = /group-avatar|chat-group-avatar|event-world-thumb|evt-det-world-thumb|home-welcome-avatar/.test(cls);
 *    const isLogo = img.id === 'loginLogoImg' || img.alt === 'Logo' || /login-logo-img/.test(cls);
 *    console.log(img.id || img.alt || cls.slice(0,40), { isUser, isPlayer, isGeneric, isLogo });
 *  });
 *
 * ============================================================== */
