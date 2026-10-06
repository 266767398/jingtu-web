// admin-ui.js —— 后台管理侧边导航 + 新模块加载
// 依赖：core.js（api）、现有 admin-*.js 暴露的全局函数
(function () {
  'use strict';

  // 各 panel 的懒加载入口（首次进入时调用）
  var PANEL_LOADERS = {
    users: function () { if (typeof loadUsersAdmin === 'function') loadUsersAdmin(1); },
    activation: function () { if (typeof loadActivationCodesPanel === 'function') loadActivationCodesPanel(); },
    admins: function () { if (typeof loadAdminMgrList === 'function') loadAdminMgrList(1); },
    vrc: function () {
      if (typeof checkSystemVrcStatus === 'function') checkSystemVrcStatus();
      if (typeof loadVrcBlacklist === 'function') loadVrcBlacklist();
    },
    'group-images': function () { /* 群组图片为纯上传表单，无需拉取 */ },
    'name-review': function () { if (typeof updateNameReviewPreview === 'function') updateNameReviewPreview(); },
    moderation: function () {
      // loadModerationQueue/resolveModeration 定义于 members.js（惰性加载），
      // 后台首次进入举报审核面板时需确保 members 模块就绪
      var run = function () { if (typeof loadModerationQueue === 'function') loadModerationQueue('pending'); };
      if (typeof loadModerationQueue === 'function') { run(); return; }
      if (typeof _ensureTabModules === 'function') { _ensureTabModules('members', run); } else { run(); }
    },
    perms: function () { if (typeof loadPermissions === 'function') loadPermissions(); },
    'perm-groups': function () { if (typeof loadPermGroups === 'function') loadPermGroups(); },
    'model-coll': function () { if (typeof loadAdminModelCollections === 'function') loadAdminModelCollections(); },
    settings: function () { if (typeof loadSystemConfig === 'function') loadSystemConfig(); if (typeof loadGitUpdateStatus === 'function') loadGitUpdateStatus(); },
    logs: function () { if (typeof loadOperLog === 'function') loadOperLog(1); },
    live: loadAdminLive,
    content: loadAdminContent,
    home: loadAdminSiteInfo,
    siteinfo: loadAdminSiteInfo,
    stats: loadAdminAnalytics,
    monitor: loadVrcMonitor,
    'user-backup': initUserBackupPanel,
    'system-backup': initSystemBackupPanel
  };

  var _panelLoaded = {};
  var _opsAvailabilityChecked = false;

  function showPanel(target) {
    var panels = document.querySelectorAll('#tab-admin .admin-panel');
    panels.forEach(function (p) {
      p.classList.toggle('d-none', p.getAttribute('data-panel') !== target);
    });
    var navs = document.querySelectorAll('#adminNav .admin-nav-item');
    navs.forEach(function (n) {
      n.classList.toggle('active', n.getAttribute('data-target') === target);
    });
    // 懒加载（仅首次成功加载后标记）
    if (!_panelLoaded[target] && PANEL_LOADERS[target]) {
      // P1-28: 此前 catch 后仍无条件置 _panelLoaded=true，瞬时错误（网络抖动/401）
      // 会让面板永久空白只能刷新整页。改为：同步抛错不标记；loader 返回 Promise 时
      // 等 resolve 再标记，reject 不标记——下次进入自动重试
      var okSync = true;
      var ret;
      try { ret = PANEL_LOADERS[target](); } catch (e) { okSync = false; console.error('[admin] load panel', target, e); }
      if (okSync) {
        if (ret && typeof ret.then === 'function') {
          ret.then(
            function () { _panelLoaded[target] = true; },
            function (e) { console.error('[admin] load panel', target, e); }
          );
        } else {
          _panelLoaded[target] = true;
        }
      }
    } else if (_panelLoaded[target] && target === 'stats') {
      // 数据统计支持手动刷新，重复进入时重绘
      try { loadAdminAnalytics(); } catch (e) {}
    }
    // 滚动到顶部
    var main = document.querySelector('#tab-admin .admin-main');
    if (main) main.scrollTop = 0;
  }

  // 运维面板可用性探测（用原生 fetch 而非 api()：/api/ops/status 仅超管可查，
  // 普通管理员探测会得 403，走 api() 会弹「无权限」误打扰）
  function checkOpsPanelAvailability() {
    var btn = document.querySelector('#adminNav .admin-nav-item[data-external="/ops/"]');
    if (!btn) return;
    fetch('/api/ops/status', { method: 'GET', credentials: 'include', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.available === false) btn.classList.add('d-none');
      })
      .catch(function () { /* 查询失败（如普通管理员无权限）保持现状 */ });
  }

  function bindAdminNav() {
    var nav = document.getElementById('adminNav');
    if (!nav) return;
    // 运维面板可用性探测：Docker/容器镜像不含 panel/（仅裸机/宝塔/Windows 本机部署），
    // 探测到不可用就隐藏侧栏入口，避免点击后空等超时弹「启动失败」（仅查询一次）
    if (!_opsAvailabilityChecked) {
      _opsAvailabilityChecked = true;
      checkOpsPanelAvailability();
    }
    nav.addEventListener('click', function (e) {
      var btn = e.target.closest('.admin-nav-item');
      if (!btn) return;
      // data-external 按钮不切换面板，直接新窗口打开（用于运维面板等外部入口）
      var external = btn.getAttribute('data-external');
      if (external) {
        // 运维面板：先请求启动（主站按需拉起 panel-server，空闲 20 分钟会自动关闭），
        // 确认就绪后再新窗口打开，避免 502 白屏
        if (external === '/ops/') {
          btn.disabled = true;
          var origText = btn.innerHTML;
          btn.innerHTML = '<span>⏳</span>启动中…';
          api('/api/ops/start', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
            if (d && d.ok) {
              window.open('/ops/', '_blank', 'noopener');
            } else {
              alert((d && d.message) || '运维面板启动失败，请查看服务日志');
            }
          }).catch(function () {
            alert('运维面板启动请求失败，请确认服务运行正常');
          }).finally(function () {
            btn.disabled = false;
            btn.innerHTML = origText;
          });
        } else {
          window.open(external, '_blank', 'noopener');
        }
        return;
      }
      showPanel(btn.getAttribute('data-target'));
    });
  }

  // ============ 新模块加载函数 ============

  // 直播管理
  function loadAdminLive(page) {
    page = page || 1;
    var status = (document.getElementById('adminLiveStatusFilter') || {}).value || '';
    var kw = (document.getElementById('adminLiveSearch') || {}).value || '';
    var box = document.getElementById('adminLiveList');
    if (!box) return;
    box.innerHTML = __('auto_admin_ui_1');
    api('/api/admin/live?page=' + page + '&status=' + encodeURIComponent(status) + '&kw=' + encodeURIComponent(kw))
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.list || !r.list.length) { box.innerHTML = __('auto_admin_ui_2'); renderAdminLivePager(1, 1, page); return; }
        box.innerHTML = r.list.map(function (s) {
          var live = s.status === 'live';
          return '<div class="card-list-item flex-row gap-8 items-center flex-wrap">' +
            '<div class="flex-1 min-w-0"><div class="text-14 fw-600">' + escapeHtml(s.title || __('auto_admin_ui_3')) + '</div>' +
            __('auto_admin_ui_4') + escapeHtml(s.displayName || s.username || '-') + __('auto_admin_ui_5') + (s.startedAt || '-') + '</div></div>' +
            '<span class="badge ' + (live ? 'badge-live' : 'badge-ended') + '">' + (live ? __('live.live_now') : __('auto_admin_ui_6')) + '</span>' +
            (live ? '<button class="btn btn-sm btn-danger" onclick="adminEndLive(\'' + escJsStr(String(s.id)) + '\')">⏹ ' + __('admin_ui.end_live') + '</button>' : '') +
            '<button class="btn btn-sm btn-outline" onclick="adminDeleteLive(\'' + escJsStr(String(s.id)) + '\')">🗑 ' + __('auto_admin_ui_7') + '</button>' +
            '</div>';
        }).join('');
        renderAdminLivePager(r.page || page, r.totalPages || 1, page);
      })
      .catch(function () { box.innerHTML = __('auto_admin_ui_8'); });
  }

  function renderAdminLivePager(cur, total, page) {
    var bar = document.getElementById('adminLivePagination');
    if (!bar) return;
    bar.innerHTML = '';
    if (total <= 1) return;
    for (var i = 1; i <= total; i++) {
      var b = document.createElement('button');
      b.className = 'btn btn-sm ' + (i === cur ? 'btn-accent' : 'btn-outline');
      b.textContent = i;
      b.onclick = (function (p) { return function () { loadAdminLive(p); }; })(i);
      bar.appendChild(b);
    }
  }

  window.adminEndLive = function (id) {
    if (!confirm(__('auto_admin_ui_9'))) return;
    api('/api/admin/live/' + id + '/end', { method: 'POST' }).then(function () { loadAdminLive(); }).catch(function (e) { alert(__('auto_admin_ui_10') + (e && e.message || e)); });
  };
  window.adminDeleteLive = function (id) {
    if (!confirm(__('auto_admin_ui_11'))) return;
    api('/api/admin/live/' + id, { method: 'DELETE' }).then(function () { loadAdminLive(); }).catch(function (e) { alert(__('auto_admin_ui_12') + (e && e.message || e)); });
  };

  // 内容管理
  var _contentTab = 'events';
  var _contentSelected = {};

  // 活动管理筛选状态（类型 / 归档）
  var _eventFilter = { type: '', archived: '' };

  function adminEventFilterBar() {
    var typeOpts = [
      ['', __('admin.all') || __('auto_admin_ui_13')],
      ['activity', __('events.activity') || __('auto_admin_ui_14')],
      ['birthday', __('events.birthday') || __('auto_admin_ui_15')]
    ];
    var archOpts = [
      ['', __('admin.all') || __('auto_admin_ui_16')],
      ['0', __('events.ongoing') || __('auto_admin_ui_17')],
      ['1', __('events.archived') || __('auto_admin_ui_18')]
    ];
    function opts(arr, cur) {
      return arr.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>'; }).join('');
    }
    return '<div class="admin-evt-filter">' +
      '<label>' + (__('admin.type') || __('auto_admin_ui_19')) + ' <select id="evtFilterType">' + opts(typeOpts, _eventFilter.type) + '</select></label>' +
      '<label>' + (__('admin.status') || __('auto_admin_ui_20')) + ' <select id="evtFilterArch">' + opts(archOpts, _eventFilter.archived) + '</select></label>' +
      '</div>';
  }

  function loadAdminContent(page) {
    page = page || 1;
    var kw = (document.getElementById('adminContentSearch') || {}).value || '';
    var box = document.getElementById('adminContentList');
    if (!box) return;
    // 活动 / 公告子标签显示「创建」入口（动态、相册无独立创建入口）
    var createBtn = document.getElementById('adminContentCreateEventBtn');
    if (createBtn) {
      if (_contentTab === 'events') {
        createBtn.classList.remove('d-none');
        createBtn.textContent = '+ ' + (__('auto_admin_ui_create_event') || '创建活动');
        createBtn.onclick = function () { adminCreateEvent(); };
      } else if (_contentTab === 'announcements') {
        createBtn.classList.remove('d-none');
        createBtn.textContent = '+ ' + (__('auto_admin_ui_create_announce') || '创建公告');
        createBtn.onclick = function () { adminCreateAnnouncement(); };
      } else {
        createBtn.classList.add('d-none');
      }
    }
    // 活动类型展示筛选栏
    var filterBox = document.getElementById('adminContentFilter');
    if (filterBox) filterBox.innerHTML = (_contentTab === 'events') ? adminEventFilterBar() : '';
    if (filterBox) {
      var ft = document.getElementById('evtFilterType');
      var fa = document.getElementById('evtFilterArch');
      if (ft) ft.onchange = function () { _eventFilter.type = ft.value; loadAdminContent(1); };
      if (fa) fa.onchange = function () { _eventFilter.archived = fa.value; loadAdminContent(1); };
    }
    box.innerHTML = __('auto_admin_ui_21');
    var q = 'type=' + _contentTab + '&page=' + page + '&kw=' + encodeURIComponent(kw);
    if (_contentTab === 'events') {
      if (_eventFilter.type) q += '&eventType=' + encodeURIComponent(_eventFilter.type);
      if (_eventFilter.archived) q += '&archived=' + encodeURIComponent(_eventFilter.archived);
    }
    api('/api/admin/content?' + q)
      .then(function (r) { return r.json(); })
      .then(function (r) {
        _contentSelected = {};
        if (!r || !r.list || !r.list.length) { box.innerHTML = '<p class="text-muted2">' + (__('admin.no_content') || __('auto_admin_ui_22')) + '。</p>'; renderAdminContentPager(1, 1); return; }
        if (_contentTab === 'events') { box.innerHTML = renderAdminEventList(r.list); }
        else {
          var cols = { posts: [__('auto_admin_ui_23'), __('auto_admin_ui_24')], announcements: [__('auto_admin_ui_25'), __('auto_admin_ui_26')], album: [__('auto_admin_ui_27'), __('auto_admin_ui_28')] }[_contentTab] || [__('auto_admin_ui_29')];
          box.innerHTML = '<div class="table-wrap"><table class="admin-table"><thead><tr>' +
            '<th><input type="checkbox" id="adminContentCheckAll"></th><th>' + cols[0] + '</th><th>' + cols[1] + __('auto_admin_ui_30') +
            r.list.map(function (it) {
              var a = it.author || it.displayName || '-';
              var b = it.title || it.content || it.caption || __('auto_admin_ui_31');
              if (b && b.length > 60) b = b.slice(0, 60) + '…';
              var cell = escapeHtml(b);
              // 相册内容展示缩略图（后端返回 thumbPath/photoPath）
              if (_contentTab === 'album' && (it.thumbPath || it.photoPath)) {
                cell = '<img src="' + escapeHtml(it.thumbPath || it.photoPath) + '" alt="" onerror="window.__imgFail(this)" style="width:56px;height:40px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px">' + cell;
              }
              // 操作按钮：查看（公告/动态/相册）+ 编辑（公告/动态）+ 删除
              var actions = '';
              if (_contentTab === 'announcements' || _contentTab === 'posts' || _contentTab === 'album') {
                actions += '<button class="btn btn-sm btn-outline" onclick="adminViewContent(\'' + escJsStr(String(_contentTab)) + '\',\'' + escJsStr(String(it.id)) + '\')">👁 ' + (__('events.view') || __('auto_admin_ui_view')) + '</button> ';
              }
              if (_contentTab === 'announcements' || _contentTab === 'posts') {
                actions += '<button class="btn btn-sm btn-outline" onclick="adminEditContent(\'' + escJsStr(String(_contentTab)) + '\',\'' + escJsStr(String(it.id)) + '\')">✏️ ' + (__('events.edit_event') || '编辑') + '</button> ';
              }
              actions += '<button class="btn btn-sm btn-outline" onclick="adminDeleteContent(\'' + escJsStr(String(_contentTab)) + '\',\'' + escJsStr(String(it.id)) + '\')">🗑 ' + (__('delete') || __('auto_admin_ui_32')) + '</button>';
              return '<tr><td><input type="checkbox" class="admin-batch-check" data-id="' + it.id + '"></td>' +
                '<td>' + escapeHtml(a) + '</td><td>' + cell + '</td>' +
                '<td>' + actions + '</td></tr>';
            }).join('') + '</tbody></table></div>';
        }
        bindContentCheckAll();
        renderAdminContentPager(r.page || page, r.totalPages || 1);
      })
      .catch(function () { box.innerHTML = '<p class="text-13 text-red">' + (__('admin.load_failed') || __('auto_admin_ui_33')) + '。</p>'; });
  }

  function bindContentCheckAll() {
    var all = document.getElementById('adminContentCheckAll');
    if (all) all.onchange = function () {
      document.querySelectorAll('#adminContentList .admin-batch-check').forEach(function (c) { c.checked = all.checked; });
    };
  }

  function renderAdminEventList(list) {
    var body = list.map(function (it) {
      var title = it.title || it.content || __('auto_admin_ui_34');
      var author = it.displayName || '-';
      var typeLabel = it.eventType === 'birthday' ? (__('events.birthday') || __('auto_admin_ui_35')) : (__('events.activity') || __('auto_admin_ui_36'));
      var t = it.eventTime ? fmtTime(it.eventTime) : '-';
      var ended = it.endsAt ? (new Date(it.endsAt).getTime() < Date.now()) : false;
      var status = it.isArchive ? (__('events.archived') || __('auto_admin_ui_37')) : (ended ? (__('events.ended') || __('auto_admin_ui_38')) : (__('events.status_ongoing') || __('auto_admin_ui_39')));
      var sign = (it.signCount || 0);
      return '<tr data-id="' + it.id + '">' +
        '<td><input type="checkbox" class="admin-batch-check" data-id="' + it.id + '"></td>' +
        '<td class="evt-title">' + escapeHtml(title) + '</td>' +
        '<td>' + escapeHtml(typeLabel) + '</td>' +
        '<td>' + escapeHtml(author) + '</td>' +
        '<td>' + escapeHtml(t) + '</td>' +
        '<td><span class="evt-status ' + (it.isArchive ? 'archived' : (ended ? 'ended' : 'ongoing')) + '">' + escapeHtml(status) + '</span></td>' +
        '<td>' + sign + '</td>' +
        '<td class="evt-actions">' +
          '<button class="btn btn-sm btn-outline" onclick="window.showEventDetail&&showEventDetail(\'' + escJsStr(String(it.id)) + '\')">👁 ' + (__('events.view') || __('auto_admin_ui_40')) + '</button> ' +
          '<button class="btn btn-sm btn-outline" onclick="adminEditEvent(\'' + escJsStr(String(it.id)) + '\')">✏️ ' + (__('events.edit_event') || '编辑') + '</button> ' +
          '<button class="btn btn-sm btn-outline" onclick="adminArchiveEvent(\'' + escJsStr(String(it.id)) + '\',' + (it.isArchive ? 1 : 0) + ')">' + (it.isArchive ? (__('events.unarchive') || __('auto_admin_ui_41')) : (__('events.archive') || __('auto_admin_ui_42'))) + '</button> ' +
          '<button class="btn btn-sm btn-outline" onclick="adminDeleteContent(\'events\',\'' + escJsStr(String(it.id)) + '\')">🗑 ' + (__('delete') || __('auto_admin_ui_43')) + '</button>' +
        '</td>' +
        '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="admin-table admin-evt-table"><thead><tr>' +
      '<th><input type="checkbox" id="adminContentCheckAll"></th>' +
      '<th>' + (__('events.col_title') || __('auto_admin_ui_44')) + '</th>' +
      '<th>' + (__('admin.type') || __('auto_admin_ui_45')) + '</th>' +
      '<th>' + (__('admin.author') || __('auto_admin_ui_46')) + '</th>' +
      '<th>' + (__('events.time') || __('auto_admin_ui_47')) + '</th>' +
      '<th>' + (__('admin.status') || __('auto_admin_ui_48')) + '</th>' +
      '<th>' + (__('events.col_sign') || __('auto_admin_ui_49')) + '</th>' +
      '<th>' + (__('admin.action') || __('auto_admin_ui_50')) + '</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function renderAdminContentPager(cur, total) {
    var bar = document.getElementById('adminContentPagination');
    if (!bar) return;
    bar.innerHTML = '';
    if (total <= 1) return;
    for (var i = 1; i <= total; i++) {
      var b = document.createElement('button');
      b.className = 'btn btn-sm ' + (i === cur ? 'btn-accent' : 'btn-outline');
      b.textContent = i;
      b.onclick = (function (p) { return function () { loadAdminContent(p); }; })(i);
      bar.appendChild(b);
    }
  }

  window.adminDeleteContent = function (type, id) {
    if (!confirm(__('auto_admin_ui_51'))) return;
    api('/api/admin/content/' + type + '/' + id, { method: 'DELETE' })
      .then(function () { loadAdminContent(); })
      .catch(function (e) { alert(__('auto_admin_ui_52') + (e && e.message || e)); });
  };
  // 后台内容管理「查看」入口：按内容类型分发到对应前台模块的详情函数（模块按需加载）
  window.adminViewContent = function (type, id) {
    var run = function () {
      if (type === 'announcements') {
        if (typeof showAnnouncementDetail === 'function') { showAnnouncementDetail(id); return; }
      } else if (type === 'posts') {
        if (typeof showPostDetail === 'function') { showPostDetail(id); return; }
      } else if (type === 'album') {
        if (typeof adminViewAlbumPhoto === 'function') { adminViewAlbumPhoto(id); return; }
      }
      alert(__('auto_admin_ui_view_fail') || '详情模块未就绪，请刷新后重试');
    };
    var need = { announcements: 'announcements', posts: 'posts', album: 'album' }[type];
    if (!need) { run(); return; }
    var ready = type === 'announcements' ? (typeof showAnnouncementDetail === 'function')
      : type === 'posts' ? (typeof showPostDetail === 'function')
      : (typeof adminViewAlbumPhoto === 'function');
    if (ready) { run(); return; }
    if (typeof _ensureTabModules === 'function') { _ensureTabModules(need, run); } else { run(); }
  };
  // 后台内容管理「编辑」入口：按内容类型分发到对应前台模块的编辑函数（模块按需加载）
  window.adminEditContent = function (type, id) {
    var run = function () {
      if (type === 'announcements') { adminEditAnnouncement(id); return; }
      if (type === 'posts') { if (typeof editPost === 'function') { editPost(id); return; } }
      alert(__('auto_admin_ui_edit_fail2') || '编辑模块未就绪，请刷新后重试');
    };
    var need = { announcements: 'announcements', posts: 'posts' }[type];
    if (!need) { run(); return; }
    var ready = type === 'announcements' ? (typeof adminEditAnnouncement === 'function')
      : (typeof editPost === 'function');
    if (ready) { run(); return; }
    if (typeof _ensureTabModules === 'function') { _ensureTabModules(need, run); } else { run(); }
  };
  // 后台内容管理「创建公告」入口：复用前台公告发布弹窗（showAnnounceModal）
  window.adminCreateAnnouncement = function () {
    if (typeof showAnnounceModal === 'function') { showAnnounceModal(); return; }
    if (typeof _ensureTabModules === 'function') {
      _ensureTabModules('announcements', function () {
        if (typeof showAnnounceModal === 'function') showAnnounceModal();
        else alert(__('auto_admin_ui_create_fail') || '公告模块未就绪，请刷新后重试');
      });
    } else {
      alert(__('auto_admin_ui_create_fail') || '公告模块未就绪，请刷新后重试');
    }
  };
  // 后台公告编辑：editAnnouncement 依赖 announcementsCache，需先 loadAnnouncements 填充后再编辑
  window.adminEditAnnouncement = function (id) {
    var edit = function () {
      if (typeof editAnnouncement === 'function') { editAnnouncement(id); }
      else { alert(__('auto_admin_ui_edit_fail2') || '公告编辑模块未就绪，请刷新后重试'); }
    };
    if (typeof editAnnouncement !== 'function') {
      if (typeof _ensureTabModules === 'function') { _ensureTabModules('announcements', edit); } else { edit(); }
      return;
    }
    // 若缓存已含该公告则直接编辑；否则先拉取公告列表填充缓存
    if (typeof announcementsCache !== 'undefined' && announcementsCache.some(function (a) { return String(a.id) === String(id); })) {
      edit();
    } else if (typeof loadAnnouncements === 'function') {
      loadAnnouncements().then(function () { edit(); }).catch(function () { edit(); });
    } else {
      edit();
    }
  };
  // 后台相册照片查看：独立 lightbox（不依赖 album.js 的 albumPhotoList 模块缓存）
  window.adminViewAlbumPhoto = function (id) {
    api('/api/admin/content?type=album&page=1&pageSize=200')
      .then(function (r) { return r.json(); })
      .then(function (r) {
        var p = (r && r.list || []).filter(function (x) { return String(x.id) === String(id); })[0];
        if (!p) { alert(__('auto_admin_ui_photo_miss') || '未找到该照片'); return; }
        var url = p.photoPath || p.thumbPath;
        if (!url) { alert(__('auto_admin_ui_photo_miss') || '未找到该照片'); return; }
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9999;';
        overlay.innerHTML = '<div style="position:relative;max-width:92vw;max-height:90vh;background:transparent;">'
          + '<button onclick="this.parentElement.parentElement.remove()" style="position:absolute;top:-32px;right:0;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:18px;line-height:1;">×</button>'
          + (p.mediaType === 'video'
            ? '<video src="/' + encodeURI(url) + '" controls autoplay style="max-width:92vw;max-height:90vh;border-radius:8px;"></video>'
            : '<img src="/' + encodeURI(url) + '" style="max-width:92vw;max-height:90vh;object-fit:contain;border-radius:8px;">')
          + (p.content || p.displayName ? '<div style="margin-top:8px;color:#fff;text-align:center;font-size:13px;">' + (p.content ? escapeHtml(p.content) + (p.displayName ? ' · ' : '') : '') + (p.displayName ? escapeHtml(p.displayName) : '') + '</div>' : '')
          + '</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
      })
      .catch(function () { alert(__('auto_admin_ui_photo_miss') || '照片加载失败'); });
  };
  // 管理后台活动归档/取消归档（仅超管可操作；复用 PUT /api/events/:id，归档字段已对普通创建者封禁）
  window.adminArchiveEvent = function (id, current) {
    if (!confirm(__('events.toggle_archive_confirm') || __('auto_admin_ui_53'))) return;
    api('/api/events/' + id, { method: 'PUT', body: JSON.stringify({ isArchive: current ? 0 : 1 }) })
      .then(function () { loadAdminContent(); })
      .catch(function (e) { alert(__('auto_admin_ui_54') + (e && e.message || e)); });
  };
  // 后台内容管理「活动」子标签的「编辑」入口：复用前端活动编辑弹窗（editEventCard/showEditEvent）。
  // 与创建入口一致，需按需确保 events.js 模块就绪后再打开。
  window.adminEditEvent = function (id) {
    var open = function () {
      if (typeof editEventCard === 'function') { editEventCard(id); return; }
      if (typeof showEditEvent === 'function') { window._currentEventId = parseInt(id); showEditEvent(); return; }
      alert(__('auto_admin_ui_edit_fail') || '活动编辑模块未就绪，请刷新后重试');
    };
    if (typeof editEventCard === 'function' || typeof showEditEvent === 'function') { open(); return; }
    if (typeof _ensureTabModules === 'function') {
      _ensureTabModules('events', open);
    } else {
      open();
    }
  };
  // 后台内容管理「活动」子标签的「创建活动」入口：复用前端活动创建弹窗（showEventModal）。
  // admin tab 不预载 events.js，故按需确保模块就绪后再打开，避免按钮点击无效。
  window.adminCreateEvent = function () {
    if (typeof showEventModal === 'function') { showEventModal(); return; }
    if (typeof _ensureTabModules === 'function') {
      _ensureTabModules('events', function () {
        if (typeof showEventModal === 'function') showEventModal();
        else alert(__('auto_admin_ui_55'));
      });
    } else if (typeof showEventModal === 'function') {
      showEventModal();
    } else {
      alert(__('auto_admin_ui_56'));
    }
  };
  window.adminBatchDeleteContent = function () {
    var ids = Array.prototype.slice.call(document.querySelectorAll('#adminContentList .admin-batch-check:checked')).map(function (c) { return c.getAttribute('data-id'); });
    if (!ids.length) { alert(__('auto_admin_ui_57')); return; }
    if (!confirm(__('auto_admin_ui_58') + ids.length + __('auto_admin_ui_59'))) return;
    api('/api/admin/content/batch', { method: 'POST', body: JSON.stringify({ type: _contentTab, ids: ids }) })
      .then(function () { loadAdminContent(); })
      .catch(function (e) { alert(__('auto_admin_ui_60') + (e && e.message || e)); });
  };

  // 主页管理 / 网站信息（复用 system_config；需 super_admin 保存）
  function loadAdminSiteInfo() {
    api('/api/admin/config').then(function (r) { return r.json(); }).then(function (cfg) {
      cfg = cfg || {};
      var siteName = document.getElementById('cfgHomeSiteName');
      var siteSlogan = document.getElementById('cfgSiteSlogan');
      var siteWelcome = document.getElementById('cfgSiteWelcome');
      var vrc = document.getElementById('cfgVrcGroupUrl');
      var kook = document.getElementById('cfgKookUrl');
      var oopz = document.getElementById('cfgOopzUrl');
      var turnUrls = document.getElementById('cfgTurnUrls');
      var turnUser = document.getElementById('cfgTurnUsername');
      var turnCred = document.getElementById('cfgTurnCredential');
      if (siteName) siteName.value = cfg.site_name || '';
      if (siteSlogan) siteSlogan.value = cfg.hero_title || '';
      if (siteWelcome) siteWelcome.value = cfg.hero_description || '';
      if (vrc) vrc.value = cfg.vrcGroupUrl || '';
      if (kook) kook.value = cfg.kookUrl || '';
      if (oopz) oopz.value = cfg.oopzUrl || '';
      if (turnUrls) turnUrls.value = cfg.rtc_turn_urls || '';
      if (turnUser) turnUser.value = cfg.rtc_turn_username || '';
      if (turnCred) turnCred.value = cfg.rtc_turn_credential || '';
    }).catch(function () {});
  }

  window.saveRtcTurn = function () {
    var payload = {
      rtc_turn_urls: val('cfgTurnUrls'), rtc_turn_username: val('cfgTurnUsername'), rtc_turn_credential: val('cfgTurnCredential')
    };
    api('/api/admin/config', { method: 'PUT', body: JSON.stringify(payload) })
      .then(function () { toast(__('auto_admin_ui_61'), 'success'); })
      .catch(function (e) { alert(__('auto_admin_ui_63') + (e && e.message || e)); });
  };

  window.saveSiteInfo = function () {
    var payload = {
      site_name: val('cfgHomeSiteName'), hero_title: val('cfgSiteSlogan'), hero_description: val('cfgSiteWelcome'),
      vrcGroupUrl: val('cfgVrcGroupUrl'), kookUrl: val('cfgKookUrl'), oopzUrl: val('cfgOopzUrl')
    };
    api('/api/admin/config', { method: 'PUT', body: JSON.stringify(payload) })
      .then(function () { toast(__('auto_admin_ui_61'), 'success'); })
      .catch(function (e) { alert(__('auto_admin_ui_63') + (e && e.message || e)); });
  };

  // 数据统计（分析仪表盘）
  function loadAdminAnalytics() {
    var grid = document.getElementById('adminStatsGrid');
    var charts = document.getElementById('adminStatsCharts');
    if (!grid) return;
    grid.innerHTML = __('auto_admin_ui_64');
    if (charts) charts.innerHTML = '';
    api('/api/admin/analytics/dashboard')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        d = d || {};
        var u = d.users || {}, c = d.content || {}, p = d.performance || {}, ch = d.cache || {};
        var cards = [
          [__('auto_admin_ui_65'), u.total], [__('auto_admin_ui_66'), u.activeToday], [__('auto_admin_ui_67'), u.online],
          [__('auto_admin_ui_68'), c.posts], [__('auto_admin_ui_69'), c.events], [__('auto_admin_ui_70'), c.photos],
          [__('auto_admin_ui_71'), p.requests], [__('auto_admin_ui_72'), p.avgResponseTime],
          [__('auto_admin_ui_73'), ch.keyCount]
        ];
        grid.innerHTML = cards.map(function (k) {
          return '<div class="stat-card"><div class="stat-value">' + (k[1] != null ? k[1] : '-') + '</div><div class="stat-label">' + k[0] + '</div></div>';
        }).join('');
        if (charts) {
          charts.innerHTML = __('auto_admin_ui_74') +
            __('auto_admin_ui_75') + (p.successRate != null ? p.successRate + '%' : '-') + '</b></div>' +
            __('auto_admin_ui_76') + (p.maxResponseTime != null ? p.maxResponseTime : '-') + '</b></div>' +
            __('auto_admin_ui_77') + (p.slowRequests != null ? p.slowRequests : '-') + '</b></div>' +
            __('auto_admin_ui_78') + (ch.enabled ? __('admin_ui.yes') : __('auto_admin_ui_79')) + '</b></div></div>';
        }
      })
      .catch(function () { grid.innerHTML = __('auto_admin_ui_80'); });
  }

  // VRC 状态监控
  function loadVrcMonitor() {
    var status = document.getElementById('vrcMonitorStatus');
    var detail = document.getElementById('vrcMonitorDetail');
    if (status) status.innerHTML = __('auto_admin_ui_81');
    api('/api/vrc-monitor').then(function (r) { return r.json(); }).then(function (d) {
      d = d || {};
      if (status) status.innerHTML = __('auto_admin_ui_82') + (d.online ? 'text-green' : 'text-red') + '">' + (d.online ? __('admin_ui.online') : __('auto_admin_ui_83')) + __('auto_admin_ui_84') + (d.friendCount != null ? d.friendCount : '-') + __('auto_admin_ui_85') + (d.lastSync || '-') + '</div>';
      if (detail) detail.innerHTML = escapeHtml(d.note) + (d.health ? __('auto_admin_ui_86') + escapeHtml(d.health) + '</div>' : '');
    }).catch(function () { if (status) status.innerHTML = __('auto_admin_ui_87'); });
  }

  // ============ 数据备份还原（按用户 / 批量导出导入） ============
  // 复用 F-4 用户级数据导出导入逻辑（后端 admin.js 的 /admin/user-data/* 端点）

  function ubResult(msg, isErr) {
    var el = document.getElementById('ubResult');
    if (!el) return;
    el.innerHTML = '<span class="' + (isErr ? 'text-red' : 'text-green') + '">' + escapeHtml(msg) + '</span>';
  }

  function ubTriggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // 读取后端 JSON 错误信息，返回可读文案
  async function ubErrMsg(res) {
    try {
      var d = await res.json();
      if (d && typeof d.error === 'string') return d.error;
      if (d && d.error && d.error.message) return d.error.message;
      if (d && d.message) return d.message;
    } catch (_) {}
    return __('admin_ui.ub_request_failed', { status: res.status });
  }

  // 单个用户导出
  async function ubExportUser() {
    var userId = (document.getElementById('ubUserIdInput') || {}).value || '';
    userId = String(userId).trim();
    if (!userId) { ubResult(__('admin_ui.ub_need_user_id'), true); return; }
    ubResult(__('admin_ui.ub_exporting'));
    try {
      var res = await api('/api/admin/user-data/export/' + encodeURIComponent(userId), { method: 'GET' });
      if (!res.ok) { ubResult(await ubErrMsg(res), true); return; }
      var blob = await res.blob();
      var cd = res.headers.get('Content-Disposition') || '';
      var m = cd.match(/filename="?([^";]+)"?/i);
      var filename = m ? m[1] : ('user-' + userId + '.json');
      ubTriggerDownload(blob, filename);
      ubResult(__('admin_ui.ub_export_success', { f: filename }));
    } catch (e) { ubResult(__('admin_ui.ub_export_failed', { e: (e && e.message || e) }), true); }
  }

  // 单个用户导入（粘贴 JSON 或选择文件）
  async function ubImportUser() {
    var userId = (document.getElementById('ubUserIdInput') || {}).value || '';
    userId = String(userId).trim();
    if (!userId) { ubResult(__('admin_ui.ub_need_user_id'), true); return; }
    var text = window.prompt(__('admin_ui.ub_paste_prompt'), '');
    if (text === null) return; // 用户取消
    var body;
    if (text && text.trim()) {
      try { body = JSON.parse(text); }
      catch (_) { ubResult(__('admin_ui.ub_json_bad_format'), true); return; }
    } else {
      ubResult(__('admin_ui.ub_use_batch_import'), true);
      return;
    }
    ubResult(__('admin_ui.ub_importing'));
    try {
      var res = await api('/api/admin/user-data/import/' + encodeURIComponent(userId), { method: 'POST', body: body });
      if (!res.ok) { ubResult(await ubErrMsg(res), true); return; }
      var d = await res.json();
      var n = 0;
      if (d && d.imported) { n = Object.keys(d.imported).reduce(function (s, k) { return s + (d.imported[k] || 0); }, 0); }
      ubResult(__('admin_ui.ub_import_success', { n: n }));
    } catch (e) { ubResult(__('admin_ui.ub_import_failed', { e: (e && e.message || e) }), true); }
  }

  // 批量导出
  async function ubBatchExport() {
    var raw = (document.getElementById('ubBatchIdsInput') || {}).value || '';
    var ids = raw.split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!ids.length) { ubResult(__('admin_ui.ub_need_at_least_one_id'), true); return; }
    ubResult(__('admin_ui.ub_batch_exporting', { n: ids.length }));
    try {
      var res = await api('/api/admin/user-data/batch-export', { method: 'POST', body: { ids: ids } });
      if (!res.ok) { ubResult(await ubErrMsg(res), true); return; }
      var blob = await res.blob();
      var cd = res.headers.get('Content-Disposition') || '';
      var m = cd.match(/filename="?([^";]+)"?/i);
      var filename = m ? m[1] : 'users-batch-export.json';
      ubTriggerDownload(blob, filename);
      ubResult(__('admin_ui.ub_batch_export_success', { f: filename }));
    } catch (e) { ubResult(__('admin_ui.ub_batch_export_failed', { e: (e && e.message || e) }), true); }
  }

  // 批量导入（读取 JSON 文件后提交）
  async function ubBatchImport() {
    var fileInput = document.getElementById('ubImportFile');
    if (!fileInput || !fileInput.files || !fileInput.files.length) {
      ubResult(__('admin_ui.ub_need_file'), true);
      return;
    }
    var file = fileInput.files[0];
    var text;
    try { text = await file.text(); }
    catch (_) { ubResult(__('admin_ui.ub_file_read_failed'), true); return; }
    var body;
    try { body = JSON.parse(text); }
    catch (_) { ubResult(__('admin_ui.ub_json_bad_content'), true); return; }
    // 支持两种结构：批量导出产物（{users:{...}}）或单个用户备份（直接对象）
    var payload;
    if (body && body.users && typeof body.users === 'object') {
      payload = body.users;
    } else {
      var userId = (document.getElementById('ubUserIdInput') || {}).value || '';
      userId = String(userId).trim();
      if (!userId) { ubResult(__('admin_ui.ub_batch_import_hint'), true); return; }
      payload = {};
      payload[userId] = body;
    }
    ubResult(__('admin_ui.ub_batch_importing'));
    try {
      var res = await api('/api/admin/user-data/batch-import', { method: 'POST', body: { users: payload } });
      if (!res.ok) { ubResult(await ubErrMsg(res), true); return; }
      var d = await res.json();
      var total = 0;
      if (d && Array.isArray(d.imported)) {
        total = d.imported.reduce(function (s, it) {
          var c = (it && it.imported) ? Object.keys(it.imported).reduce(function (a, k) { return a + (it.imported[k] || 0); }, 0) : 0;
          return s + c;
        }, 0);
      }
      var failedKeys = (d && d.failed && typeof d.failed === 'object') ? Object.keys(d.failed) : [];
      var failedMsg = failedKeys.length ? __('admin_ui.ub_failed_suffix', { n: failedKeys.length, ids: failedKeys.join(', ') }) : '';
      ubResult(__('admin_ui.ub_batch_import_success', { u: (d && d.imported ? d.imported.length : 0), n: total }) + failedMsg);
    } catch (e) { ubResult(__('admin_ui.ub_batch_import_failed', { e: (e && e.message || e) }), true); }
  }

  // 绑定备份还原面板事件（幂等）
  function initUserBackupPanel() {
    var p = document.querySelector('#tab-admin [data-panel="user-backup"]');
    if (!p) return;
    if (p.dataset.bound) return;
    p.dataset.bound = '1';
    var exportBtn = document.getElementById('ubExportUserBtn');
    var importBtn = document.getElementById('ubImportUserBtn');
    var batchExportBtn = document.getElementById('ubBatchExportBtn');
    var batchImportBtn = document.getElementById('ubBatchImportBtn');
    if (exportBtn) exportBtn.addEventListener('click', ubExportUser);
    if (importBtn) importBtn.addEventListener('click', ubImportUser);
    if (batchExportBtn) batchExportBtn.addEventListener('click', ubBatchExport);
    if (batchImportBtn) batchImportBtn.addEventListener('click', ubBatchImport);
  }

  // 绑定系统备份面板事件（幂等）：创建/刷新按钮 + 首次进入加载列表
  function initSystemBackupPanel() {
    var p = document.querySelector('#tab-admin [data-panel="system-backup"]');
    if (!p) return;
    if (p.dataset.bound) return;
    p.dataset.bound = '1';
    var createBtn = document.getElementById('sysBackupCreateBtn');
    var refreshBtn = document.getElementById('sysBackupRefreshBtn');
    if (createBtn) createBtn.addEventListener('click', function () { if (typeof createBackup === 'function') createBackup(); });
    if (refreshBtn) refreshBtn.addEventListener('click', function () { if (typeof loadBackups === 'function') loadBackups(); });
    if (typeof loadBackups === 'function') loadBackups();
  }

  // 工具
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 绑定（DOM 就绪即可，不依赖其他 admin 模块）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdminUi);
  } else {
    initAdminUi();
  }

  function initAdminUi() {
    bindAdminNav();
    // 内容子标签
    var ctabs = document.getElementById('adminContentTabs');
    if (ctabs) ctabs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ctab]'); if (!b) return;
      ctabs.querySelectorAll('[data-ctab]').forEach(function (x) { x.classList.toggle('active', x === b); });
      _contentTab = b.getAttribute('data-ctab');
      loadAdminContent(1);
    });
    // 内容筛选/批量/刷新按钮
    bind('adminContentRefreshBtn', function () { loadAdminContent(1); });
    bind('adminContentCreateEventBtn', function () { if (window.adminCreateEvent) window.adminCreateEvent(); });
    bind('adminContentBatchDelBtn', function () { if (window.adminBatchDeleteContent) window.adminBatchDeleteContent(); });
    bind('adminContentSearch', function () { loadAdminContent(1); }, 'input');
    // 直播
    bind('adminLiveRefreshBtn', function () { loadAdminLive(1); });
    bind('adminLiveStatusFilter', function () { loadAdminLive(1); }, 'change');
    bind('adminLiveSearch', function () { loadAdminLive(1); }, 'input');
    // 举报审核队列状态切换（待处理/已通过/已驳回）
    var mqSection = document.getElementById('adminModerationSection');
    if (mqSection) mqSection.addEventListener('click', function (e) {
      var b = e.target.closest('[data-mqt]'); if (!b) return;
      mqSection.querySelectorAll('[data-mqt]').forEach(function (x) { x.classList.toggle('btn-accent', x === b); x.classList.toggle('btn-outline', x !== b); });
      if (typeof loadModerationQueue === 'function') loadModerationQueue(b.getAttribute('data-mqt'));
    });
    // 主页/网站信息保存
    bind('saveSiteInfoBtn', function () { if (window.saveSiteInfo) window.saveSiteInfo(); });
    bind('saveSiteLinksBtn', function () { if (window.saveSiteInfo) window.saveSiteInfo(); });
    bind('saveRtcTurnBtn', function () { if (window.saveRtcTurn) window.saveRtcTurn(); });
    // 数据统计
    bind('adminStatsRefreshBtn', function () { loadAdminAnalytics(); });
    bind('adminStatsRange', function () { loadAdminAnalytics(); }, 'change');
    // 默认进入时加载 overview 统计（由 checkAdminStats 在 switchTab 中调用，这里不重复）
  }

  function bind(id, fn, evt) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(evt || 'click', fn);
  }

  // 暴露给 ui.js 的 switchTab('admin') 调用，确保进入后台即初始化导航
  window.initAdminNavOnce = function () {
    if (_panelLoaded.__init) return;
    _panelLoaded.__init = true;
    bindAdminNav();
  };
})();
