// ==================== 群聊实时位置共享（M2 拆分自 chat.js） ====================
// 原 chat.js L605-772 + L1025-1086 抽出：GPS 单例 watch / 幽灵标记清扫 / 位置栏渲染。
// 依赖 chat.js 的全局词法状态：chatActiveGroupId；依赖 map.js 全局：mapInstance /
// leafletMarkers / upsertLocationMarker / switchTab。由 loader.js 随 chat Tab 同批加载。

let groupLocationSharing = {}; // groupId → true/false（本端是否正在共享）
let groupLocationMarkers = {}; // groupId → { userId → L.marker }（兼容保留）
// §群位置-单例定位：全站只起一个 watchPosition，按群集合广播，
// 避免「多群并发 watch 受限」+「watch 与 setInterval 双重定位冗余」
let glWatchId = null;
const glGroups = new Set();     // 正在共享的群集合
let glLastSent = 0;             // 全局节流时间戳（≥4s 才发一次）
const groupLocLastSeen = {};    // groupId → { userId → ts }，幽灵标记清扫用
let glSweepTimer = null;        // 幽灵标记清扫定时器
const LOC_STALE_MS = 30000;     // 超过 30s 未更新的标记视为幽灵

// ==================== 群聊实时位置共享 V6.13 ====================
function toggleGroupLocation(groupId) {
  if (groupLocationSharing[groupId]) {
    stopGroupLocation(groupId);
  } else {
    startGroupLocation(groupId);
  }
}

function startGroupLocation(groupId) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (!ensureGeolocation()) return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // 加入共享群集合并启动单例 watch（多群共用同一个定位句柄）
      glGroups.add(groupId);
      groupLocationSharing[groupId] = true;
      ensureGlobalWatch();
      startGroupLocSweep();

      // 用独立信令通知群成员「开始共享」（不进消息表、不计未读，避免污染群聊）
      sendGroupLocationToggle(groupId, true);

      updateGroupLocBtn(groupId, true);
      toast(__('chat.group_location_started'), 'success');
    },
    (err) => {
      toastGeoError(err);
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

function stopGroupLocation(groupId, silent) {
  glGroups.delete(groupId);
  groupLocationSharing[groupId] = false;

  // 独立信令通知「停止共享」+ 广播 stop，让他人移除标记（均不持久化、不计未读）
  sendGroupLocationToggle(groupId, false);
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({
      type: 'group:location:stop', groupId, userId: currentUser.id
    }));
  }

  // 清理本端位置栏中自己的项
  if (groupLocationMarkers[groupId]) delete groupLocationMarkers[groupId][currentUser.id];
  const myBar = document.getElementById('groupLocationBar');
  const myEl = myBar && myBar.querySelector(`[data-uid="${currentUser.id}"]`);
  if (myEl) myEl.remove();
  if (groupLocLastSeen[groupId]) delete groupLocLastSeen[groupId][currentUser.id];

  // 没有任何群在共享时释放唯一 watch，避免空转耗电
  stopGlobalWatchIfIdle();
  if (glGroups.size === 0) stopGroupLocSweep();
  updateGroupLocBtn(groupId, false);
  // 被动停止（群解散/GPS 故障自动清理）不弹提示，避免用户突然看到莫名的「已停止」
  if (!silent) toast(__('chat.location_stopped_icon'), 'info');
}

function sendGroupLocationViaWS(groupId, lat, lng, accuracy) {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;
  wsClient.send(JSON.stringify({
    type: 'group:location:update', groupId,
    userId: currentUser.id,
    displayName: currentUser.displayName || '',
    avatarUrl: currentUser.avatarUrl || '',
    lat, lng, accuracy: accuracy || null
  }));
}

function updateGroupLocBtn(groupId, active) {
  const btn = document.getElementById(`groupLocBtn_${groupId}`);
  if (btn) {
    btn.textContent = active ? __('chat.stop_sharing') : __('chat.share_location');
    btn.className = active ? 'btn btn-xs btn-danger' : 'btn btn-xs';
  }
}

// 全局唯一 geolocation watch：位置变化时向所有正在共享的群广播（带节流）
let glWatchRetried = false; // GPS 暂时性故障后是否已重建 watch（每轮仅重试一次）
function ensureGlobalWatch() {
  if (glWatchId != null) return;
  if (!ensureGeolocation()) return;
  glWatchId = navigator.geolocation.watchPosition(
    (p) => {
      glWatchRetried = false; // 收到一次有效定位即视为恢复，下一轮故障允许再次重试
      const now = Date.now();
      if (now - glLastSent < 4000) return; // 节流，避免高频刷屏
      glLastSent = now;
      const { latitude, longitude, accuracy } = p.coords;
      glGroups.forEach((gid) => sendGroupLocationViaWS(gid, latitude, longitude, accuracy));
    },
    (err) => {
      toastGeoError(err);
      // 权限被拒或无解错误：停止全部共享，避免按钮卡在共享状态却不再发坐标。
      // 不直接判 err.code === 1 —— 非安全上下文下浏览器同样报 code 1（根本没弹过授权窗），
      // 必须走 geoErrorKey 统一排除 isSecureContext === false 的情况后再认定「拒绝授权」。
      if (geoErrorKey(err) === 'geo.permission_denied') {
        Array.from(glGroups).forEach((gid) => stopGroupLocation(gid, true));
        return;
      }
      // 暂时性故障（timeout / unavailable，常见于切后台被浏览器暂停 GPS）：
      // 重建一次 watch 继续共享，不停止、不误弹「已停止」；重建后仍失败才清理。
      if (!glWatchRetried) {
        glWatchRetried = true;
        if (glWatchId != null) { navigator.geolocation.clearWatch(glWatchId); glWatchId = null; }
        ensureGlobalWatch();
        return;
      }
      Array.from(glGroups).forEach((gid) => stopGroupLocation(gid, true));
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
  );
}

function stopGlobalWatchIfIdle() {
  if (glGroups.size === 0 && glWatchId != null) {
    navigator.geolocation.clearWatch(glWatchId);
    glWatchId = null;
  }
}

// 幽灵标记清扫：超过 LOC_STALE_MS 未更新的成员从位置栏移除
// （覆盖对端刷新/关页未点停止导致标记永不消失的场景）
function startGroupLocSweep() {
  if (glSweepTimer) return;
  glSweepTimer = setInterval(() => {
    const gid = chatActiveGroupId;
    if (!gid) return;
    const seen = groupLocLastSeen[gid];
    if (!seen) return;
    const now = Date.now();
    const bar = document.getElementById('groupLocationBar');
    for (const uid in seen) {
      if (now - seen[uid] > LOC_STALE_MS) {
        delete seen[uid];
        if (groupLocationMarkers[gid]) delete groupLocationMarkers[gid][uid];
        const el = bar && bar.querySelector(`[data-uid="${uid}"]`);
        if (el) el.remove();
      }
    }
  }, 10000);
}

function stopGroupLocSweep() {
  if (glSweepTimer) { clearInterval(glSweepTimer); glSweepTimer = null; }
}

// 空闲冻结：暂停/恢复位置幽灵标记清扫定时器，挂机时减少空转（见 freeze.js）
if (window.__freeze && typeof window.__freeze.register === 'function') {
  window.__freeze.register({
    onFreeze: function () { stopGroupLocSweep(); },
    onUnfreeze: function () { startGroupLocSweep(); }
  });
}

// 位置开关信令（开始/停止共享），走独立信令不进消息表、不计未读
function sendGroupLocationToggle(groupId, sharing) {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;
  wsClient.send(JSON.stringify({
    type: 'group:location:toggle', groupId,
    userId: currentUser.id,
    displayName: currentUser.displayName || '',
    sharing: !!sharing
  }));
}
// ==================== 查看用户位置 ====================
// 从私聊切到地图并定位到该用户
function viewUserOnMap(userId) {
  if (typeof switchTab === 'function') switchTab('map');
  let retries = 0;
  const MAX_RETRIES = 10; // P3-69: 地图初始化失败时停止轮询，避免每 500ms 无限自调
  const tryLocate = async () => {
    if (typeof mapInstance === 'undefined' || !mapInstance) {
      if (++retries > MAX_RETRIES) { toast(__('map.load_failed'), 'error'); return; }
      setTimeout(tryLocate, 500);
      return;
    }
    const marker = leafletMarkers ? leafletMarkers[userId] : null;
    if (marker) { marker.openPopup(); mapInstance.setView(marker.getLatLng(), 14); return; }
    try {
      const res = await api('/api/users/all/locations', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const u = (data.markers || []).find(x => String(x.id) === String(userId));
        if (u && typeof upsertLocationMarker === 'function') {
          upsertLocationMarker(u);
          setTimeout(() => {
            const m = leafletMarkers ? leafletMarkers[userId] : null;
            if (m) { m.openPopup(); mapInstance.setView(m.getLatLng(), 14); }
          }, 200);
        } else { toast(__('chat.user_no_location'), 'info'); }
      }
    } catch { toast(__('chat.gps_info_failed'), 'error'); }
  };
  setTimeout(tryLocate, 300);
}

// ==================== 群聊位置标记管理（小地图用） ====================
// 简化版：在聊天框内显示位置提示
function showGroupLocationOnChat(msg) {
  // 记录最后上报时间，供幽灵标记清扫使用
  const gid = msg.groupId;
  groupLocLastSeen[gid] = groupLocLastSeen[gid] || {};
  groupLocLastSeen[gid][msg.userId] = Date.now();
  // 在聊天框底部显示成员的实时位置提示
  const locBar = document.getElementById('groupLocationBar');
  if (!locBar) return;
  // 更新或追加
  let userLoc = locBar.querySelector(`[data-uid="${msg.userId}"]`);
  if (!userLoc) {
    const el = document.createElement('div');
    el.dataset.uid = msg.userId;
    el.className = 'group-loc-item';
    locBar.appendChild(el);
    userLoc = el;
  }
  const avatarSrc = msg.avatarUrl ? escAttr(msg.avatarUrl) : '/api/avatar/default';
  userLoc.innerHTML = `<img src="${avatarSrc}" class="chat-mini-avatar" loading="lazy" data-avatar-fail-src="${escAttr(msg.avatarUrl || '/api/avatar/default')}"> ${esc(msg.displayName || '')} 🟢`;
}

function hideGroupLocationOnChat(userId) {
  const locBar = document.getElementById('groupLocationBar');
  if (locBar) {
    const el = locBar.querySelector(`[data-uid="${userId}"]`);
    if (el) el.remove();
  }
}

// ==================== 位置共享初始化（M2 自 chat.js DOMContentLoaded 迁入） ====================
(function () {
  function _init() {
    // 离开/刷新页面时尽力广播停止，减少他人端幽灵标记（不可靠，主要靠前端清扫兜底）
    window.addEventListener('beforeunload', () => {
      if (glGroups.size === 0 || !wsClient || wsClient.readyState !== WebSocket.OPEN) return;
      try {
        glGroups.forEach((gid) => {
          wsClient.send(JSON.stringify({ type: 'group:location:stop', groupId: gid, userId: currentUser.id }));
        });
      } catch (e) {}
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
