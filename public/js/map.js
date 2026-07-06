// ==================== Leaflet OSM 地图 + 实时位置共享 V6.12 ====================
let mapInstance = null;
let mapInitAttempts = 0;
let mapRetryTimer = null;
let leafletMarkers = {};         // userId → L.marker
let myLocationMarker = null;     // 本人紫色脉冲标记
let markerGroup = null;          // L.featureGroup 用于 fitBounds

// 实时位置追踪
let locationWatchId = null;
let locationTrackingActive = false;
let locationUpdateInterval = null;
const LOCATION_UPDATE_INTERVAL = 5000; // 5秒
const LOCATION_STALE_TIMEOUT = 120000;

// ==================== CSS 挂载（多 CDN 回退） ====================
(function ensureLeafletCSS() {
  if (document.querySelector('link[href*="leaflet.css"]')) return;
  const cdnUrls = [
    'https://cdn.bootcdn.net/ajax/libs/leaflet/1.9.4/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
    'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
    'https://cdn.staticfile.net/leaflet/1.9.4/leaflet.css'
  ];
  function tryLoadCSS(idx) {
    if (idx >= cdnUrls.length) { console.error('[map] ' + __('map.load_failed')); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cdnUrls[idx];
    link.onload = () => { /* 成功，不做特殊处理 */ };
    link.onerror = () => { console.warn('[map] Leaflet CSS CDN 失败，尝试下一个:', cdnUrls[idx]); link.remove(); tryLoadCSS(idx + 1); };
    document.head.appendChild(link);
  }
  tryLoadCSS(0);
})();

// ==================== 地图初始化 ====================

async function initMap() {
  const mapContainer = document.getElementById('memberMap');
  if (!mapContainer) return;

  if (mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 100);
    return;
  }

  const rect = mapContainer.getBoundingClientRect();
  const isHidden = mapContainer.offsetParent === null;
  if (isHidden || rect.width === 0 || rect.height < 50) {
    if (mapInitAttempts < 20) {
      mapInitAttempts++;
      if (mapRetryTimer) clearTimeout(mapRetryTimer);
      mapRetryTimer = setTimeout(initMap, 300);
    }
    return;
  }

  const emptyEl = document.getElementById('mapEmpty');
  if (emptyEl) emptyEl.style.display = 'none';

  if (!mapContainer.style.height || parseInt(mapContainer.style.height) < 200) {
    mapContainer.style.minHeight = '400px';
  }

  try {
    // 动态加载 Leaflet JS
    if (!window.L) {
      let leafletLoaded = false;
      const cdnUrls = [
        'https://cdn.bootcdn.net/ajax/libs/leaflet/1.9.4/leaflet.js',
        'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
        'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
        'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
        'https://cdn.staticfile.net/leaflet/1.9.4/leaflet.min.js'
      ];
      for (const cdnUrl of cdnUrls) {
        try {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = cdnUrl;
            script.async = true;
            script.onload = resolve;
            script.onerror = reject;
            const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
            script.onload = () => { clearTimeout(timeout); resolve(); };
            script.onerror = () => { clearTimeout(timeout); reject(new Error('load failed')); };
            document.head.appendChild(script);
          });
          leafletLoaded = true;
          break;
        } catch (e) {
          console.warn('[map] Leaflet CDN 失败，尝试下一个:', cdnUrl);
        }
      }
      if (!leafletLoaded) {
        console.error('[map] ' + __('map.load_failed'));
        if (emptyEl) emptyEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🗺️</div><div>' + __('map.load_failed') + '</div></div>';
        return;
      }
      await new Promise(r => setTimeout(r, 50));
    }

    // 创建地图（OSM 瓦片，免费免Key，全球可用）
    mapInstance = L.map(mapContainer, {
      zoomControl: true,
      attributionControl: true
    }).setView([35, 105], 4); // 中国中心

    // OSM 标准瓦片（多 tile 回退，国内用户可用）
    const tileProviders = [
      { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>' },
      { url: 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png', attr: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>' },
      { url: 'https://tiles.wmflabs.org/osm-no-labels/{z}/{x}/{y}.png', attr: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a>' }
    ];
    let tileLayer = null;
    for (const prov of tileProviders) {
      try {
        tileLayer = L.tileLayer(prov.url, { maxZoom: 19, attribution: prov.attr });
        tileLayer.addTo(mapInstance);
        // 如果瓦片${__('map.load_failed')}，自动切换到下一个
        tileLayer.on('tileerror', () => {
          if (mapInstance && tileLayer) {
            mapInstance.removeLayer(tileLayer);
            const nextIdx = tileProviders.indexOf(prov) + 1;
            if (nextIdx < tileProviders.length) {
              console.warn('[map] OSM tile ' + __('map.load_failed') + '，尝试备用:', tileProviders[nextIdx].url);
              const nextLayer = L.tileLayer(tileProviders[nextIdx].url, { maxZoom: 19, attribution: tileProviders[nextIdx].attr });
              nextLayer.addTo(mapInstance);
              tileLayer = nextLayer;
            }
          }
        });
        break;
      } catch(e) {
        console.warn('[map] OSM tile 初始化失败:', prov.url);
      }
    }

    // 标记组用于自适应缩放
    markerGroup = L.featureGroup().addTo(mapInstance);

    // 比例尺
    L.control.scale({ imperial: false, metric: true }).addTo(mapInstance);

    // 更新标记 + 实时位置
    updateMapMarkers();
    fetchRealtimeLocations();

  } catch (e) {
    console.error('[map] Leaflet 初始化失败:', e);
    mapContainer.innerHTML = '<div class="text-muted text-center" style="padding:40px">${__('map.load_failed_retry')}</div>';
  }
}

// ==================== 获取实时位置数据 ====================

async function fetchRealtimeLocations() {
  if (!currentUser) return;
  try {
    const res = await api('/api/users/locations', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      (data.users || []).forEach(u => upsertLocationMarker(u));
    }
  } catch (e) { /* 静默 */ }
}

// ==================== 标记管理 ====================

function upsertLocationMarker(userData) {
  if (!mapInstance) return;
  const uid = userData.id;
  const lng = parseFloat(userData.lng);
  const lat = parseFloat(userData.lat);
  if (isNaN(lng) || isNaN(lat)) return;

  const isMe = currentUser && (String(uid) === String(currentUser.id));

  // 已存在则更新位置
  const existing = leafletMarkers[uid];
  if (existing) {
    existing.setLatLng([lat, lng]);
    return;
  }

  const avatarSrc = userData.avatarUrl ? escAttr(userData.avatarUrl) : '/api/avatar/default';
  const borderColor = isMe ? '#7c5cfc' : '#3b82f6';
  const size = isMe ? 40 : 32;

  // 自定义 DivIcon（头像标记）
  const icon = L.divIcon({
    className: 'leaflet-avatar-marker',
    html: `<div class="l-avatar-wrap ${isMe ? 'l-avatar-me' : ''}" style="width:${size}px;height:${size}px;border-color:${borderColor}">
      <img src="${avatarSrc}" class="l-avatar-img" onerror="this.src='/api/avatar/default'" />
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 8]
  });

  const marker = L.marker([lat, lng], { icon, zIndexOffset: isMe ? 200 : 100 })
    .addTo(mapInstance)
    .bindPopup(getMarkerPopup(userData), { className: 'leaflet-popup-custom', closeButton: true });

  leafletMarkers[uid] = marker;
  markerGroup?.addLayer(marker);

  // 自动缩放适配
  if (markerGroup) {
    mapInstance.fitBounds(markerGroup.getBounds().pad(0.1), { maxZoom: 14 });
  }
}

function getMarkerPopup(u) {
  const isMe = currentUser && (String(u.id) === String(currentUser.id));
  const avatarSrc = u.avatarUrl ? escAttr(u.avatarUrl) : '/api/avatar/default';
  const borderColor = isMe ? '#7c5cfc' : '#3b82f6';
  const timeStr = u.locationUpdatedAt
    ? new Date(u.locationUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : u.timestamp
      ? new Date(u.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '';
  return `<div style="min-width:150px;text-align:center;padding:4px">
    <img src="${avatarSrc}" style="width:44px;height:44px;border-radius:50%;border:2px solid ${borderColor}" />
    <div style="font-weight:700;margin-top:4px">${esc(u.displayName || '')}</div>
    <div style="color:#888;font-size:12px">📍 ${esc(u.location || __('map.unknown_location'))}</div>
    ${timeStr ? `<div style="color:#aaa;font-size:11px;margin-top:2px">🕐 ${timeStr}</div>` : ''}
    <button class="btn btn-xs mt-4" onclick="openChat('${escJsStr(String(u.id))}')">${__('map.send_message')}</button>
  </div>`;
}

function removeLocationMarker(userId) {
  const marker = leafletMarkers[userId];
  if (marker) {
    mapInstance?.removeLayer(marker);
    delete leafletMarkers[userId];
  }
}

// ==================== 更新地图标记（成员列表） ====================

function updateMapMarkers() {
  if (!mapInstance) return;
  // 如果 membersCache 为空，先加载数据再重试
  if (!window.membersCache || window.membersCache.length === 0) {
    if (typeof loadMembers === 'function') {
      loadMembers();
    }
    return;
  }
  const visibleMembers = window.membersCache.filter(m => m.lat && m.lng && m.locationVisible);
  const countEl = document.getElementById('mapCount');
  if (countEl) countEl.textContent = __('members.visible_positions', {n: visibleMembers.length});

  visibleMembers.forEach(m => {
    const uid = String(m.id);
    if (leafletMarkers[uid]) return;
    const lng = parseFloat(m.lng);
    const lat = parseFloat(m.lat);
    if (isNaN(lng) || isNaN(lat)) return;
    upsertLocationMarker({
      id: m.id,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      lat, lng,
      location: m.location || ''
    });
  });

  const total = Object.keys(leafletMarkers).length;
  if (total > 0 && markerGroup) {
    mapInstance.fitBounds(markerGroup.getBounds().pad(0.1), { maxZoom: 14 });
  }
}

// ==================== 实时位置追踪 ====================

function toggleLocationTracking() {
  if (locationTrackingActive) stopLocationTracking();
  else startLocationTracking();
}

async function startLocationTracking() {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (!navigator.geolocation) { toast(__('profile.gps_not_supported'), 'error'); return; }

  // 确保位置可见
  try {
    await api('/api/users/me/profile', { method: 'PUT', body: JSON.stringify({ locationVisible: true }) });
  } catch (e) { /* 忽略 */ }

  locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      updateMyLocationMarker(lat, lng);
      sendLocationViaWS(lat, lng, position.coords.accuracy);
    },
    (err) => {
      console.warn('[location] 定位失败:', err.message);
      if (err.code === 1) { toast(__('map.enable_gps'), 'error'); stopLocationTracking(); }
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
  );

  locationUpdateInterval = setInterval(() => {
    if (locationTrackingActive && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => sendLocationViaWS(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
        () => {},
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
      );
    }
  }, LOCATION_UPDATE_INTERVAL);

  locationTrackingActive = true;
  updateLocationUI();
  toast(__('map.tracking_on'), 'success');
}

function stopLocationTracking() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
  if (locationUpdateInterval) {
    clearInterval(locationUpdateInterval);
    locationUpdateInterval = null;
  }
  if (myLocationMarker) {
    mapInstance?.removeLayer(myLocationMarker);
    myLocationMarker = null;
  }
  sendLocationStopViaWS();
  locationTrackingActive = false;
  updateLocationUI();
  toast(__('map.tracking_off'), 'info');
}

function updateMyLocationMarker(lat, lng) {
  if (!mapInstance) return;

  if (myLocationMarker) {
    myLocationMarker.setLatLng([lat, lng]);
    return;
  }

  const pulseIcon = L.divIcon({
    className: '',
    html: `<div class="l-my-location-pulse"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  myLocationMarker = L.marker([lat, lng], { icon: pulseIcon, zIndexOffset: 300 }).addTo(mapInstance);
  mapInstance.setView([lat, lng], mapInstance.getZoom() < 12 ? 12 : undefined);
}

function sendLocationViaWS(lat, lng, accuracy) {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN || !currentUser) return;
  wsClient.send(JSON.stringify({
    type: 'location:update',
    userId: currentUser.id,
    displayName: currentUser.displayName || '',
    avatarUrl: currentUser.avatarUrl || '',
    lat, lng, accuracy: accuracy || null
  }));
}

function sendLocationStopViaWS() {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN || !currentUser) return;
  wsClient.send(JSON.stringify({ type: 'location:stop', userId: currentUser.id }));
}

function updateLocationUI() {
  const btn = document.getElementById('locationToggleBtn');
  const status = document.getElementById('locationStatus');
  if (btn) {
    btn.textContent = locationTrackingActive ? __('map.stop_sharing') : __('map.share_my_location');
    btn.className = locationTrackingActive ? 'btn btn-sm btn-danger' : 'btn btn-sm';
  }
  if (status) {
    status.textContent = locationTrackingActive ? __('map.sharing_location') : '';
    status.style.display = locationTrackingActive ? 'inline' : 'none';
  }
}

// ==================== WebSocket 位置消息处理 ====================

function handleLocationMessage(msg) {
  if (!mapInstance) return;
  if (msg.type === 'location:update') {
    upsertLocationMarker({
      id: msg.userId,
      displayName: msg.displayName || __('map.unknown_user'),
      avatarUrl: msg.avatarUrl || '',
      lat: msg.lat,
      lng: msg.lng,
      location: '',
      timestamp: msg.timestamp
    });
  } else if (msg.type === 'location:stop') {
    removeLocationMarker(msg.userId);
  }
}

// ==================== World 视图 ====================

function updateWorldMapMarkers() {
  const grid = document.getElementById('eventWorldsGrid');
  if (!grid) return;
  api('/api/events/with-worlds', { method: 'GET' }).then(res => {
    if (!res.ok) throw new Error();
    return res.json();
  }).then(data => {
    const events = data.events || data || [];
    if (events.length === 0) {
      grid.innerHTML = '<div class="text-muted text-center-sm p-8">${__('map.no_world_events')}</div>';
      return;
    }
    const worldMap = {};
    events.forEach(e => {
      if (e.worldId && !worldMap[e.worldId]) {
        worldMap[e.worldId] = { id: e.worldId, name: e.worldName || __('map.unknown_world'), image: e.worldImageUrl || '', events: [] };
      }
      if (e.worldId && worldMap[e.worldId]) worldMap[e.worldId].events.push(e);
    });
    const worlds = Object.values(worldMap);
    grid.innerHTML = worlds.map(w => `
      <div class="world-grid-card" onclick="loadEvents('all','all')">
        ${w.image ? `<img src="${w.image}" class="world-grid-thumb" alt="${esc(w.name)}" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div class="world-grid-name">🌐 ${esc(w.name)}</div>
        <div class="world-grid-count">${__('map.n_events', {n: w.events.length})}</div>
      </div>
    `).join('') || '<div class="text-muted text-center-sm p-8">${__('map.no_world_events')}</div>';
  }).catch(() => {
    grid.innerHTML = '<div class="text-muted text-center-sm p-8">${__('map.load_failed')}</div>';
  });
}

// ==================== 视图切换 ====================

function switchMapView(view) {
  document.querySelectorAll('.map-view-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.map-view-btn[data-view="${view}"]`)?.classList.add('active');
  const membersView = document.getElementById('mapMembersView');
  const worldsView = document.getElementById('mapWorldsView');
  if (membersView) membersView.classList.toggle('d-none', view !== 'members');
  if (worldsView) worldsView.classList.toggle('d-none', view !== 'worlds');
  if (view === 'members') {
    if (mapInstance) setTimeout(() => mapInstance.invalidateSize(), 100);
    updateMapMarkers();
  } else {
    updateWorldMapMarkers();
  }
}
