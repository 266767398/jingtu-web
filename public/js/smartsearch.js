/* ============================================================
 * smartsearch.js — 全局命令面板（VN-9，VRCNext SmartSearch 借鉴）
 * Ctrl+K 唤起，支持：
 *   - 页面/功能导航（Tab 直达）
 *   - 成员搜索（/api/users/search）
 *   - 动态搜索（/api/posts?q=）
 *   - 快捷指令：/go <tab>、/user <关键词>、/post <关键词>
 * 依赖：core.js（api/__/esc/toast/switchTab 约定）
 * ============================================================ */
(function() {
  'use strict';
  if (window.__smartsearchInited) return;
  window.__smartsearchInited = true;

  // ---------- 面板 DOM ----------
  function buildPanel() {
    var panel = document.createElement('div');
    panel.id = 'smartSearchPanel';
    panel.className = 'smartsearch-panel d-none';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML =
      '<div class="smartsearch-backdrop" data-ss-close></div>' +
      '<div class="smartsearch-box">' +
        '<div class="smartsearch-input-wrap">' +
          '<span class="smartsearch-kbd-icon">⌕</span>' +
          '<input type="text" id="smartSearchInput" class="smartsearch-input" autocomplete="off" placeholder="…" spellcheck="false">' +
          '<kbd class="smartsearch-kbd">ESC</kbd>' +
        '</div>' +
        '<div id="smartSearchResults" class="smartsearch-results"></div>' +
        '<div class="smartsearch-hint">' +
          '<span>' + esc(__('smartsearch.hint_go')) + '</span>' +
          '<span>' + esc(__('smartsearch.hint_user')) + '</span>' +
          '<span>' + esc(__('smartsearch.hint_post')) + '</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    panel.addEventListener('click', function(e) {
      if (e.target && e.target.hasAttribute('data-ss-close')) closePanel();
    });

    var input = document.getElementById('smartSearchInput');
    input.addEventListener('input', function() { runSearch(input.value); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { closePanel(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveCursor(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        activateCursor();
      }
    });

    document.addEventListener('click', function(e) {
      if (e.target && e.target.closest('#smartSearchResults .ss-result')) {
        activateItem(e.target.closest('.ss-result'));
      }
    });
  }

  // ---------- 快捷键 ----------
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (panelIsOpen()) closePanel(); else openPanel();
    }
  });

  // ---------- 状态 ----------
  var results = [];
  var cursor = -1;

  function panelIsOpen() {
    var p = document.getElementById('smartSearchPanel');
    return !!p && !p.classList.contains('d-none');
  }

  function openPanel() {
    var panel = document.getElementById('smartSearchPanel');
    if (!panel) { buildPanel(); panel = document.getElementById('smartSearchPanel'); }
    panel.classList.remove('d-none');
    var input = document.getElementById('smartSearchInput');
    if (input) { input.value = ''; runSearch(''); setTimeout(function() { input.focus(); }, 0); }
    document.addEventListener('keydown', globalEscHandler);
  }

  function closePanel() {
    var panel = document.getElementById('smartSearchPanel');
    if (panel) panel.classList.add('d-none');
    results = [];
    cursor = -1;
    document.removeEventListener('keydown', globalEscHandler);
  }

  function globalEscHandler(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
  }

  // ---------- 渲染结果 ----------
  function renderList(list) {
    results = list;
    cursor = -1;
    var box = document.getElementById('smartSearchResults');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="ss-empty">' + esc((typeof __ === 'function' ? __('smartsearch.empty') : __('auto_smartsearch_1'))) + '</div>';
      return;
    }
    box.innerHTML = list.map(function(item, i) {
      var active = i === cursor ? ' ss-active' : '';
      return '<div class="ss-result' + active + '" data-idx="' + i + '">' +
        '<span class="ss-icon">' + esc(item.icon || '📄') + '</span>' +
        '<span class="ss-title">' + esc(item.title) + '</span>' +
        '<span class="ss-sub">' + esc(item.sub || '') + '</span>' +
      '</div>';
    }).join('');
  }

  function moveCursor(delta) {
    if (!results.length) return;
    cursor += delta;
    if (cursor < 0) cursor = results.length - 1;
    if (cursor >= results.length) cursor = 0;
    var box = document.getElementById('smartSearchResults');
    if (!box) return;
    var items = box.querySelectorAll('.ss-result');
    items.forEach(function(el, i) { el.classList.toggle('ss-active', i === cursor); });
    var cur = items[cursor];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function activateCursor() {
    if (cursor >= 0 && cursor < results.length) activateItemByIndex(cursor);
  }

  function activateItemByIndex(idx) {
    if (results[idx]) runAction(results[idx]);
  }

  function activateItem(el) {
    var idx = parseInt(el.getAttribute('data-idx'), 10);
    if (!isNaN(idx)) activateItemByIndex(idx);
  }

  // ---------- 动作 ----------
  function runAction(item) {
    closePanel();
    if (!item || !item.action) return;
    item.action();
  }

  // ---------- 数据源 ----------
  // 页面导航项（与 index.html 顶部标签一一对应）
  var NAV_ITEMS = [
    { tab: 'home',         icon: '🏠', key: 'nav.home', fallback: __('auto_smartsearch_2') },
    { tab: 'members',      icon: '👥', key: 'nav.members', fallback: __('auto_smartsearch_3') },
    { tab: 'group',        icon: '🎮', key: 'nav.group', fallback: __('auto_smartsearch_4') },
    { tab: 'announcements',icon: '📢', key: 'nav.announcements', fallback: __('auto_smartsearch_5') },
    { tab: 'events',       icon: '📅', key: 'nav.events', fallback: __('auto_smartsearch_6') },
    { tab: 'birthday',     icon: '🎂', key: 'nav.birthday', fallback: __('auto_smartsearch_7') },
    { tab: 'album',        icon: '🖼️', key: 'nav.album', fallback: __('auto_smartsearch_8') },
    { tab: 'collections',  icon: '📚', key: 'nav.collections', fallback: __('auto_smartsearch_9') },
    { tab: 'posts',        icon: '📝', key: 'nav.posts', fallback: __('auto_smartsearch_10') },
    { tab: 'live',         icon: '📺', key: 'nav.live', fallback: __('auto_smartsearch_11') },
    { tab: 'map',          icon: '🗺️', key: 'nav.map', fallback: __('auto_smartsearch_12') },
    { tab: 'chat',         icon: '💬', key: 'nav.chat', fallback: __('auto_smartsearch_13') },
    { tab: 'friends',      icon: '🤝', key: 'friends.title', fallback: __('auto_smartsearch_14') },
    { tab: 'follows',      icon: '➕', key: 'follows.title', fallback: __('auto_smartsearch_15') },
    { tab: 'notifications',icon: '🔔', key: 'nav.notifications', fallback: __('auto_smartsearch_16') },
    { tab: 'admin',        icon: '⚙️', key: 'nav.admin', fallback: __('auto_smartsearch_17') }
  ];

  function navTitle(item) {
    return (typeof __ === 'function' && __(item.key)) || item.fallback;
  }

  // 延迟防抖
  var debounceTimer = null;

  function runSearch(raw) {
    var q = (raw || '').trim();
    // 指令路由
    if (q.charAt(0) === '/') {
      handleCommand(q);
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      var list = [];
      // 导航匹配
      NAV_ITEMS.forEach(function(n) {
        if (match(q, n.fallback) || match(q, n.tab)) {
          list.push({
            icon: n.icon,
            title: navTitle(n),
            sub: '/go ' + n.tab,
            action: (function(t) { return function() { switchToTab(t); }; })(n.tab)
          });
        }
      });
      // 成员 + 活动 + 群组玩家搜索（并发）
      if (q.length >= 1) {
        Promise.all([searchUsers(q), searchEvents(q), searchGroupMembers(q)]).then(function(arr) {
          var users = arr[0] || [], events = arr[1] || [], groups = arr[2] || [];
          var extra = users.map(function(u) {
            return {
              icon: '👤',
              title: u.username || u.nickname || u.name || String(u.id || ''),
              sub: __('smartsearch.member_sub'),
              action: (function(id) { return function() { openUser(id); }; })(u.id)
            };
          }).concat(events.map(function(e) {
            return {
              icon: '📅',
              title: e.title || ('#' + e.id),
              sub: __('smartsearch.event_sub'),
              action: (function(id) { return function() { openEvent(id); }; })(e.id)
            };
          })).concat(groups.map(function(g) {
            return {
              icon: '🛡️',
              title: g.displayName || g.vrchatName || g.vrchatId || '',
              sub: __('smartsearch.group_sub'),
              action: (function(vid) { return function() { openGroupMember(vid); }; })(g.vrchatId || g.vrcUserId || '')
            };
          }));
          renderList(list.concat(extra));
        }).catch(function() { renderList(list); });
      } else {
        renderList(list);
      }
    }, 180);
  }

  function handleCommand(q) {
    var parts = q.split(/\s+/);
    var cmd = (parts[0] || '').toLowerCase();
    var arg = parts.slice(1).join(' ').trim();
    if (cmd === '/go') {
      var list = [];
      NAV_ITEMS.forEach(function(n) {
        if (match(arg, n.tab) || match(arg, n.fallback)) {
          list.push({
            icon: n.icon,
            title: navTitle(n),
            sub: '/go ' + n.tab,
            action: (function(t) { return function() { switchToTab(t); }; })(n.tab)
          });
        }
      });
      renderList(list);
      return;
    }
    if (cmd === '/user') {
      if (!arg) { renderList([{ icon: '👤', title: __('smartsearch.user_hint'), sub: '', action: function() {} }]); return; }
      searchUsers(arg).then(function(users) {
        renderList(users.map(function(u) {
          return {
            icon: '👤',
            title: u.username || u.nickname || u.name || String(u.id || ''),
            sub: __('smartsearch.member'),
            action: (function(id) { return function() { openUser(id); }; })(u.id)
          };
        }));
      }).catch(function() { renderList([]); });
      return;
    }
    if (cmd === '/event') {
      if (!arg) { renderList([{ icon: '📅', title: __('smartsearch.event_hint'), sub: '', action: function() {} }]); return; }
      searchEvents(arg).then(function(events) {
        renderList(events.map(function(e) {
          return {
            icon: '📅',
            title: e.title || ('#' + e.id),
            sub: __('smartsearch.event_sub'),
            action: (function(id) { return function() { openEvent(id); }; })(e.id)
          };
        }));
      }).catch(function() { renderList([]); });
      return;
    }
    if (cmd === '/group') {
      if (!arg) { renderList([{ icon: '🛡️', title: __('smartsearch.group_hint'), sub: '', action: function() {} }]); return; }
      searchGroupMembers(arg).then(function(groups) {
        renderList(groups.map(function(g) {
          return {
            icon: '🛡️',
            title: g.displayName || g.vrchatName || g.vrchatId || '',
            sub: __('smartsearch.group_sub'),
            action: (function(vid) { return function() { openGroupMember(vid); }; })(g.vrchatId || g.vrcUserId || '')
          };
        }));
      }).catch(function() { renderList([]); });
      return;
    }
    if (cmd === '/post') {
      if (!arg) { renderList([{ icon: '📝', title: __('smartsearch.post_hint'), sub: '', action: function() {} }]); return; }
      searchPosts(arg).then(function(posts) {
        renderList(posts.map(function(p) {
          return {
            icon: p.type === 'image' ? '📷' : p.type === 'video' ? '🎬' : '📝',
            title: stripTags(p.content || '').slice(0, 40) || __('smartsearch.post') + ' #' + p.id,
            sub: __('smartsearch.post_sub') + ' ' + (p.created_at || ''),
            action: (function(id) { return function() { openPost(id); }; })(p.id)
          };
        }));
      }).catch(function() { renderList([]); });
      return;
    }
    renderList([]);
  }

  // ---------- 动作实现 ----------
  function switchToTab(tab) {
    if (typeof window.switchTab === 'function') {
      window.switchTab(tab, true);
    } else {
      // 兜底：模拟点击顶部/底部导航按钮
      var btn = document.getElementById('tab-btn-' + tab);
      if (btn) { btn.click(); return; }
      var m = document.querySelector('.mobile-tab-bar-item[data-tab="' + tab + '"]');
      if (m) { m.click(); }
    }
  }

  function openUser(id) {
    switchToTab('members');
    setTimeout(function() {
      if (typeof window.openMemberCard === 'function') {
        window.openMemberCard(id);
      } else if (typeof window.openVrcMemberCard === 'function') {
        window.openVrcMemberCard(id);
      } else {
        // 跳到成员页并在搜索框填入
        var box = document.getElementById('membersSearch') || document.querySelector('.members-search input');
        if (box) { box.value = String(id); box.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    }, 120);
  }

  function openEvent(id) {
    switchToTab('events');
    setTimeout(function() {
      if (typeof window.showEventDetail === 'function') {
        window.showEventDetail(id);
      }
    }, 120);
  }

  function openGroupMember(vrchatId) {
    if (!vrchatId) return;
    switchToTab('group');
    setTimeout(function() {
      if (typeof window.openVrcMemberCard === 'function') {
        window.openVrcMemberCard(vrchatId);
      }
    }, 160);
  }

  function openPost(id) {
    switchToTab('posts');
    setTimeout(function() {
      // 打开动态详情（posts 模块有 openPostDetail 约定则用之）
      if (typeof window.openPostDetail === 'function') {
        window.openPostDetail(id);
      } else {
        toast(__('auto_smartsearch_18') + id, 'info');
      }
    }, 120);
  }

  // ---------- API ----------
  function searchUsers(q) {
    return api('/api/users/search?q=' + encodeURIComponent(q))
      .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function(data) { return (data && (data.users || data.list || data.results)) || []; })
      .catch(function() { return []; });
  }

  function searchPosts(q) {
    return api('/api/posts?q=' + encodeURIComponent(q) + '&pageSize=10')
      .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function(data) { return (data && data.posts) || []; })
      .catch(function() { return []; });
  }

  function searchEvents(q) {
    return api('/api/events?q=' + encodeURIComponent(q) + '&pageSize=8')
      .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function(data) { return (data && (data.events || data.list || data.results)) || []; })
      .catch(function() { return []; });
  }

  // 群组玩家搜索（本地 roster，requireAuth；仅取前 8 条用于命令面板展示）
  function searchGroupMembers(q) {
    if (!q) return Promise.resolve([]);
    return api('/api/group/members?search=' + encodeURIComponent(q) + '&filter=all')
      .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function(data) { return ((data && data.members) || []).slice(0, 8); })
      .catch(function() { return []; });
  }

  // ---------- 工具 ----------
  function match(q, text) {
    if (!q) return true;
    if (!text) return false;
    return String(text).toLowerCase().indexOf(q.toLowerCase()) !== -1;
  }

  function stripTags(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.innerHTML = s;
    return d.textContent || '';
  }

  // 供其他模块调用
  window.smartSearch = { open: openPanel, close: closePanel };
})();
