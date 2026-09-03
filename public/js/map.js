// ==================== Leaflet OSM 地图 + 实时位置共享 V6.12 ====================
let mapInstance = null;
let mapInitAttempts = 0;
let mapRetryTimer = null;
let leafletMarkers = {};         // userId → L.marker
let myLocationMarker = null;     // 本人紫色脉冲标记
let markerGroup = null;          // L.featureGroup 用于 fitBounds
let markerLastSeen = {};         // userId → 最后一次收到位置的时间戳
let staleSweepTimer = null;

// 实时位置追踪
let locationWatchId = null;
let locationTrackingActive = false;
let locationUpdateInterval = null;
const LOCATION_UPDATE_INTERVAL = 5000; // 5秒
const LOCATION_STALE_TIMEOUT = 120000;

// ==================== CSS 挂载（本地优先，CDN 回退） ====================
// 本地副本置于首位：CSP 只放行 'self' 与 unpkg，且国内访问公共 CDN 常超时，
// 本地化后地图在离线/弱网环境同样可用。
(function ensureLeafletCSS() {
  if (document.querySelector('link[href*="leaflet.css"]')) return;
  const cdnUrls = [
    '/vendor/leaflet/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
  ];
  function tryLoadCSS(idx) {
    if (idx >= cdnUrls.length) { console.error('[map] ' + __('map.load_failed')); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cdnUrls[idx];
    link.onload = () => { /* 成功，不做特殊处理 */ };
    link.onerror = () => { console.warn(__('auto_map_1'), cdnUrls[idx]); link.remove(); tryLoadCSS(idx + 1); };
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
  if (emptyEl) hideEl(emptyEl);

  if (!mapContainer.style.height || parseInt(mapContainer.style.height) < 200) {
    mapContainer.style.minHeight = '400px';
  }

  try {
    // 动态加载 Leaflet JS
    if (!window.L) {
      let leafletLoaded = false;
      const cdnUrls = [
        '/vendor/leaflet/leaflet.js',
        'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
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
          console.warn(__('auto_map_2'), cdnUrl);
        }
      }
      if (!leafletLoaded) {
        console.error('[map] ' + __('map.load_failed'));
        if (emptyEl) { renderEmpty(emptyEl, { icon: '🗺️', text: __('map.load_failed') }); showEl(emptyEl); }
        return;
      }
      await new Promise(r => setTimeout(r, 50));
    }

    // 创建地图
    mapInstance = L.map(mapContainer, {
      zoomControl: true,
      attributionControl: true
    }).setView([35, 105], 4); // 中国中心

    // ============ 瓦片源（候选预检 + 自动选主 + 逐级降级 + 本地兜底） ============
    // 背景：不同网络环境可达的地图服务差异极大（wprd 高德域名在本机 DNS 解析失败、
    // 腾讯瓦片必须带 version 参数否则返回 400、OSM 在国内被连接重置），因此不再硬编码
    // 固定主源，而是启动时并行预检各候选源，优先使用可达者；全部不可达时回退到本地
    // Canvas 绘制的极简底图，保证地图区域永不空白、玩家标记仍可正常显示。
    const TILE_PROVIDERS = [
      // 本地离线瓦片（最高优先级）：文件位于 public/map-tiles/{z}/{x}/{y}.png，
      // 可手动导入/更新；未下载对应瓦片时 tileerror 会快速降级到在线源。
      { key: 'local', name: __('auto_map_3'), sub: ['1'],
        vector: '/map-tiles/{z}/{x}/{y}.png',
        attr: __('auto_map_4'), isLocal: true },
      { key: 'amap', name: __('auto_map_5'), sub: ['1','2','3','4'],
        vector: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
        sat: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x={x}&y={y}&z={z}',
        label: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        attr: __('auto_map_6'), hasSat: true, hasLabel: true },
      { key: 'amap2', name: __('auto_map_7'), sub: ['1','2','3','4'],
        vector: 'https://wprd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
        sat: 'https://wprd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x={x}&y={y}&z={z}',
        label: 'https://wprd{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        attr: __('auto_map_8'), hasSat: true, hasLabel: true },
      { key: 'tencent', name: __('auto_map_9'), sub: ['0','1','2','3'],
        vector: 'https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=1&scene=0&version=330',
        sat: 'https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid=2&scene=0&version=330',
        attr: __('auto_map_10'), hasSat: true },
      { key: 'carto', name: 'CartoDB', sub: ['a','b','c','d'],
        vector: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        attr: '&copy; <a href="https://carto.com" target="_blank" rel="noopener">CartoDB</a>' },
      { key: 'osm', name: 'OpenStreetMap', sub: ['a','b','c'],
        vector: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: '&copy; <a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }
    ];

    // 本地极简兜底底图：Canvas 绘制深色网格，零外部请求，断网也可用
    const LocalCanvasGrid = L.GridLayer.extend({
      createTile: function(coords) {
        const tile = document.createElement('canvas');
        const size = this.getTileSize();
        tile.width = size.x; tile.height = size.y;
        const ctx = tile.getContext('2d');
        const n = Math.pow(2, coords.z);
        ctx.fillStyle = '#0e1f33';
        ctx.fillRect(0, 0, size.x, size.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath(); ctx.moveTo((size.x / 4) * i, 0); ctx.lineTo((size.x / 4) * i, size.y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, (size.y / 4) * i); ctx.lineTo(size.x, (size.y / 4) * i); ctx.stroke();
        }
        const lon = (coords.x / n) * 360 - 180;
        const latTop = (180 / Math.PI) * (2 * Math.atan(Math.exp(Math.PI - 2 * Math.PI * coords.y / n)) - Math.PI / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '10px sans-serif';
        ctx.fillText('z' + coords.z + ' ' + lon.toFixed(0) + '°, ' + latTop.toFixed(0) + '°', 4, 12);
        return tile;
      }
    });
    const localCanvasLayer = new LocalCanvasGrid({ maxZoom: 19 });

    function probeTile(url) {
      return new Promise(resolve => {
        const img = new Image();
        const timer = setTimeout(() => { img.src = ''; resolve(false); }, 6000);
        img.onload = () => { clearTimeout(timer); resolve(true); };
        img.onerror = () => { clearTimeout(timer); resolve(false); };
        img.src = url;
      });
    }
    // 预检瓦片：z=2/x=1/y=1（亚洲区域），所有源均覆盖
    const probeUrl = p => p.vector
      .replace('{z}', '2').replace('{x}', '1').replace('{y}', '1')
      .replace('{s}', p.sub[0]);

    // 本会话上次可用的源优先预检，避免每次进地图都重演失败风暴（兼容旧 key jingtu_map_fallback）
    let preferredKey = null;
    try { preferredKey = sessionStorage.getItem('jingtu_map_provider') || sessionStorage.getItem('jingtu_map_fallback'); } catch (e) { /* 隐私模式忽略 */ }
    // 本地离线源永远排最前（有本地瓦片即优先使用），其次才按上次可用源排序
    const orderedProviders = TILE_PROVIDERS.slice().sort((a, b) => {
      if (a.isLocal) return -1;
      if (b.isLocal) return 1;
      if (preferredKey) return (a.key === preferredKey ? -1 : 0) - (b.key === preferredKey ? -1 : 0);
      return 0;
    });

    // 先挂本地兜底，保证地图区域立即可见；预检完成后无缝切换更清晰的在线源
    localCanvasLayer.addTo(mapInstance);

    const probeResults = await Promise.all(orderedProviders.map(async p => {
      const ok = await probeTile(probeUrl(p));
      console.log(__('auto_map_11'), p.name, ok ? '✓ 可达' : __('auto_map_12'));
      return { p, ok };
    }));
    const usableProviders = probeResults.filter(r => r.ok).map(r => r.p);
    let activeProvider = usableProviders[0] || null;
    if (activeProvider) {
      try { sessionStorage.setItem('jingtu_map_provider', activeProvider.key); } catch (e) { /* 忽略 */ }
    }

    function makeLayer(tpl, attr) {
      return L.tileLayer(tpl, { maxZoom: 19, subdomains: activeProvider ? activeProvider.sub : ['a'], attribution: attr });
    }
    const layerCache = new Map(); // providerKey → 矢量图层（降级链复用）
    function ensureVectorLayer(p) {
      if (!layerCache.has(p.key)) layerCache.set(p.key, makeLayer(p.vector, p.attr));
      return layerCache.get(p.key);
    }

    let currentBaseLayer = localCanvasLayer;
    let currentProviderKey = null;
    if (activeProvider) {
      mapInstance.removeLayer(localCanvasLayer);
      currentBaseLayer = ensureVectorLayer(activeProvider);
      currentProviderKey = activeProvider.key;
      currentBaseLayer.addTo(mapInstance);
    }

    // 同一图层连续 THRESHOLD 块瓦片失败才切换下一档（避免个别瓦片 404/超时误触发整图切换）
    function bindTileFallback(layer, threshold) {
      let failCount = 0;
      layer.on('tileerror', () => {
        if (++failCount < threshold || !mapInstance || currentBaseLayer !== layer) return;
        failCount = 0;
        const idx = usableProviders.findIndex(p => p.key === currentProviderKey);
        let nextLayer;
        if (idx >= 0 && idx + 1 < usableProviders.length) {
          const next = usableProviders[idx + 1];
          nextLayer = ensureVectorLayer(next);
          currentProviderKey = next.key;
        } else {
          nextLayer = localCanvasLayer;
          currentProviderKey = null;
        }
        console.warn(__('auto_map_13'), nextLayer === localCanvasLayer ? '本地极简底图' : ((TILE_PROVIDERS.find(p => p.key === currentProviderKey) || {}).name));
        mapInstance.removeLayer(layer);
        nextLayer.addTo(mapInstance);
        currentBaseLayer = nextLayer;
        try {
          if (currentProviderKey) sessionStorage.setItem('jingtu_map_provider', currentProviderKey);
          else sessionStorage.removeItem('jingtu_map_provider');
        } catch (e) { /* 忽略 */ }
      });
    }

    // 图层切换控件：矢量 / 卫星 / 注记（按主源能力动态生成；全部离线时仅本地极简）
    const baseLayers = {};
    const overlays = {};
    if (activeProvider) {
      if (activeProvider.isLocal) {
        // 本地离线地图：直接显示中文名称便于识别（不走 i18n）
        baseLayers[__('auto_map_14')] = currentBaseLayer;
      } else {
        baseLayers['🗺️ ' + __('map.layer_vector')] = currentBaseLayer;
        if (activeProvider.hasSat) {
          const satLayer = makeLayer(activeProvider.sat, activeProvider.attr);
          baseLayers['🛰️ ' + __('map.layer_satellite')] = satLayer;
          bindTileFallback(satLayer, 3);
          if (activeProvider.hasLabel) {
            const labelLayer = makeLayer(activeProvider.label, '');
            overlays['🏷️ ' + __('map.layer_labels')] = labelLayer;
            satLayer.on('add', () => labelLayer.addTo(mapInstance));
            satLayer.on('remove', () => { if (mapInstance.hasLayer(labelLayer)) mapInstance.removeLayer(labelLayer); });
          }
        }
      }
      baseLayers['🧭 ' + __('map.layer_local')] = localCanvasLayer;
    } else {
      baseLayers['🗺️ ' + __('map.layer_vector')] = localCanvasLayer;
      console.warn(__('auto_map_15'));
    }
    L.control.layers(baseLayers, overlays, { position: 'topright', collapsed: true }).addTo(mapInstance);
    if (activeProvider) bindTileFallback(currentBaseLayer, 3);

    // 标记组用于自适应缩放
    markerGroup = L.featureGroup().addTo(mapInstance);

    // 比例尺
    L.control.scale({ imperial: false, metric: true }).addTo(mapInstance);

    // 更新标记 + 实时位置
    updateMapMarkers();
    fetchRealtimeLocations();

    // 定期清理离线用户的残留标记（用户直接关闭浏览器时不会有 location:stop）
    if (staleSweepTimer) clearInterval(staleSweepTimer);
    staleSweepTimer = setInterval(sweepStaleMarkers, 30000);

  } catch (e) {
    console.error(__('auto_map_16'), e);
    renderEmpty(mapContainer, { icon: '⚠️', text: __('map.load_failed_retry') });
  }
}

// ==================== 获取实时位置数据 ====================

async function fetchRealtimeLocations() {
  if (!currentUser) return;
  try {
    const res = await api('/api/users/all/locations', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      (data.markers || []).forEach(u => upsertLocationMarker(u));
    }
  } catch (e) { /* 静默 */ }
}

// ==================== 标记管理 ====================

// 地图玩家头像：与群组玩家列表同一套加载逻辑（proxyAvatar 代理改写 + 429/裂图 60s 冷却 + default 兜底）
function mapAvatarSrc(url) {
  if (!url || typeof url !== 'string') return '/api/avatar/default';
  const proxied = proxyAvatar(url);
  return (window.__avatarFailCache && window.__avatarFailCache[proxied] > Date.now() - 60000)
    ? '/api/avatar/default'
    : proxied;
}

function upsertLocationMarker(userData) {
  if (!mapInstance) return;
  const uid = userData.id;
  const lng = parseFloat(userData.lng);
  const lat = parseFloat(userData.lat);
  if (isNaN(lng) || isNaN(lat)) return;
  // 设备/接口返回的是 WGS-84，国内在线瓦片为 GCJ-02，绘制前转换以避免偏移
  const disp = (window.GEO && window.GEO.wgs84ToGcj02) ? window.GEO.wgs84ToGcj02(lng, lat) : [lng, lat];
  const glng = disp[0], glat = disp[1];

  const isMe = currentUser && (String(uid) === String(currentUser.id));

  // 记录最后活跃时间，供 sweepStaleMarkers 清理离线用户的残留标记
  markerLastSeen[uid] = Date.now();

  // 已存在则更新位置与气泡内容（旧实现只更新坐标，气泡里的时间/地点永远是首次的值）
  const existing = leafletMarkers[uid];
  if (existing) {
    existing.setLatLng([glat, glng]);
    existing.setPopupContent(getMarkerPopup(userData));
    return;
  }

  const proxied = proxyAvatar(userData.avatarUrl || '');
  const avatarSrc = escAttr(mapAvatarSrc(userData.avatarUrl));
  const borderColor = isMe ? 'var(--accent)' : 'var(--info)';
  const size = isMe ? 40 : 32;

  // 自定义 DivIcon（头像标记）
  const icon = L.divIcon({
    className: 'leaflet-avatar-marker',
    html: `<div class="l-avatar-wrap ${isMe ? 'l-avatar-me' : ''}" style="width:${size}px;height:${size}px;border-color:${borderColor}">
      <img src="${avatarSrc}" class="l-avatar-img" alt="" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escAttr(proxied || '')}')" />
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 8]
  });

  const marker = L.marker([glat, glng], { icon, zIndexOffset: isMe ? 200 : 100 })
    .addTo(mapInstance)
    .bindPopup(getMarkerPopup(userData), { className: 'leaflet-popup-custom', closeButton: true });

  leafletMarkers[uid] = marker;
  if (markerGroup) markerGroup.addLayer(marker);

  // 仅在首次出现标记时自适应缩放；每插入一个就 fitBounds 会让地图不停跳动，
  // 用户手动平移/缩放后也会被强行拉回。
  if (markerGroup && Object.keys(leafletMarkers).length === 1) {
    try {
      mapInstance.fitBounds(markerGroup.getBounds().pad(0.1), { maxZoom: 14 });
    } catch (e) { /* 边界无效时忽略 */ }
  }
}

function getMarkerPopup(u) {
  const isMe = currentUser && (String(u.id) === String(currentUser.id));
  const proxied = proxyAvatar(u.avatarUrl || '');
  const avatarSrc = escAttr(mapAvatarSrc(u.avatarUrl));
  const borderColor = isMe ? 'var(--accent)' : 'var(--info)';
  const timeStr = u.locationUpdatedAt
    ? new Date(u.locationUpdatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : u.timestamp
      ? new Date(u.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '';
  return `<div style="min-width:150px;text-align:center;padding:4px">
    <img src="${avatarSrc}" style="width:44px;height:44px;border-radius:50%;border:2px solid ${borderColor}" onerror="window.__avatarFail&&window.__avatarFail(this,'${escAttr(proxied || '')}')" />
    <div style="font-weight:700;margin-top:4px">${esc(u.displayName || '')}</div>
    <div class="map-location-text">📍 ${esc(u.location || __('map.unknown_location'))}</div>
    ${timeStr ? `<div class="map-time-text">🕐 ${timeStr}</div>` : ''}
    <button class="btn btn-xs mt-4" onclick="openChat('${escJsStr(String(u.id))}')">${__('map.send_message')}</button>
  </div>`;
}

function removeLocationMarker(userId) {
  const marker = leafletMarkers[userId];
  if (marker) {
    if (mapInstance) mapInstance.removeLayer(marker);
    if (markerGroup) markerGroup.removeLayer(marker);
    delete leafletMarkers[userId];
  }
  delete markerLastSeen[userId];
}

// 清理超过 LOCATION_STALE_TIMEOUT 未更新的标记。
// 若用户直接关闭浏览器，服务端不会广播 location:stop，标记会永久滞留在地图上。
function sweepStaleMarkers() {
  const now = Date.now();
  Object.keys(markerLastSeen).forEach(uid => {
    if (now - markerLastSeen[uid] > LOCATION_STALE_TIMEOUT) {
      removeLocationMarker(uid);
    }
  });
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
    try {
      mapInstance.fitBounds(markerGroup.getBounds().pad(0.1), { maxZoom: 14 });
    } catch (e) { /* 边界无效时忽略 */ }
  }

  // 没有任何可见位置成员时，给出友好的引导提示（而不是一片空白瓦片）。
  const tipEl = document.getElementById('mapEmpty');
  if (total === 0) {
    if (tipEl) {
      renderEmpty(tipEl, {
        icon: '📍',
        text: __('map.no_shared_location')
      });
      showEl(tipEl);
    }
  } else if (tipEl) {
    hideEl(tipEl);
  }
}

// ==================== 实时位置追踪 ====================

function toggleLocationTracking() {
  if (locationTrackingActive) stopLocationTracking();
  else startLocationTracking();
}

// 是否已经拿到第一个有效坐标（用于把__('auto_map_17')提示推迟到真正定位成功之后）
let _locationFirstFixDone = false;

async function startLocationTracking() {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  // 注意：不能只判 navigator.geolocation 存在 —— 非安全上下文（http + 局域网 IP）下
  // 该对象照样存在，但调用会以 code 1 直接失败且不弹权限框。详见 core.js:geoAvailability。
  if (!ensureGeolocation()) return;
  _locationFirstFixDone = false;

  // 确保位置可见：必须调用 /me/location，/me/profile 不接受 locationVisible 字段
  // （会静默返回成功但不生效，导致他人始终看不到本人位置）
  try {
    const res = await api('/api/users/me/location', { method: 'PUT', body: { visible: true } });
    if (!res.ok) { toast(__('map.load_failed'), 'error'); return; }
  } catch (e) {
    if (typeof isApiHandledError === 'function' && isApiHandledError(e)) return;
    toast(__('map.load_failed'), 'error');
    return;
  }

  locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      sendLocationViaWS(lat, lng, position.coords.accuracy);
      // 首次拿到坐标才算真正共享成功
      if (!_locationFirstFixDone) {
        _locationFirstFixDone = true;
        toast(__('map.tracking_on'), 'success');
        // 原先调的是 loadMemberLocations()，全站根本没有这个函数 ——
        // ReferenceError 直接中断回调，其他成员的位置永远拉不下来，
        // 表现为__('auto_map_18')。正确的函数名是 fetchRealtimeLocations。
        fetchRealtimeLocations();
      }
    },
    (err) => {
      console.warn(__('auto_map_19'), err.message);
      // 以前只在 err.code === 1（拒绝授权）时提示，超时和定位不可用两种失败
      // 完全静默，用户只会看到按钮变成__('auto_map_20')却永远没有标记出现。
      // 现在统一走 toastGeoError：它会先排除__('auto_map_21')这种同样是 code 1
      // 却根本没弹过窗的情况，避免提示用户去授权一个从没出现过的弹窗。
      toastGeoError(err);
      stopLocationTracking();
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
  // 立刻给出__('auto_map_22')的反馈，成功提示留到真正拿到坐标时再弹，
  // 否则用户会先看到__('auto_map_23')、随后定位却失败。
  toast(__('map.locating'), 'info');
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
  // 关闭服务端可见性并清除坐标，否则他人仍能从 /all/locations 读到最后位置
  api('/api/users/me/location', { method: 'PUT', body: { visible: false } })
    .catch(() => { /* 前端已停止上报，失败不阻塞 UI */ });
  toast(__('map.tracking_off'), 'info');
}

function updateMyLocationMarker(lat, lng) {
  if (!mapInstance) return;
  // 设备 GPS 为 WGS-84，绘制到 GCJ-02 底图前需转换
  const disp = (window.GEO && window.GEO.wgs84ToGcj02) ? window.GEO.wgs84ToGcj02(lng, lat) : [lng, lat];
  const glng = disp[0], glat = disp[1];

  if (myLocationMarker) {
    myLocationMarker.setLatLng([glat, glng]);
    return;
  }

  const pulseIcon = L.divIcon({
    className: '',
    html: `<div class="l-my-location-pulse"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  myLocationMarker = L.marker([glat, glng], { icon: pulseIcon, zIndexOffset: 300 }).addTo(mapInstance);
  mapInstance.setView([glat, glng], mapInstance.getZoom() < 12 ? 12 : undefined);
}

// 位置上报：WebSocket 走实时广播，HTTP 负责持久化兜底。
// 以前只走 WebSocket，一旦 WS 没连上（断线重连中、被代理拦截、后端未启用 ws）
// 就直接 return，坐标永远写不进数据库 —— 结果是 /api/users/all/locations
// 恒返回空数组，地图上一个标记都不会出现，而用户界面还显示__('auto_map_24')。
let _lastLocationHttpSync = 0;
const LOCATION_HTTP_MIN_INTERVAL = 20000;

function sendLocationViaWS(lat, lng, accuracy) {
  const wsOk = wsClient && wsClient.readyState === WebSocket.OPEN && currentUser;
  if (wsOk) {
    wsClient.send(JSON.stringify({
      type: 'location:update',
      userId: currentUser.id,
      displayName: currentUser.displayName || '',
      avatarUrl: currentUser.avatarUrl || '',
      lat, lng, accuracy: accuracy || null
    }));
  }
  // 本机标记始终要更新，否则自己也看不到自己
  updateMyLocationMarker(lat, lng);
  persistLocationViaHttp(lat, lng, !wsOk);
}

// WS 可用时也定期落库一次，避免服务端重启后坐标丢失；WS 不可用时立即落库。
function persistLocationViaHttp(lat, lng, force) {
  if (!currentUser) return;
  const now = Date.now();
  if (!force && now - _lastLocationHttpSync < LOCATION_HTTP_MIN_INTERVAL) return;
  _lastLocationHttpSync = now;
  api('/api/users/me/location', { method: 'PUT', body: { lat, lng, visible: true } })
    .catch(() => { /* 位置上报失败不该打断地图交互，下一次定位回调会重试 */ });
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
    if (locationTrackingActive) showEl(status, 'inline'); else hideEl(status);
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

// ==================== VRChat 世界视图（群组成员当前所在世界） ====================
// V9.4：把原有"世界卡片网格"升级为带 KPI / 区域聚集 / 热门实例 Top 5 / 世界分布网格的
// 完整面板，与 VRCX 的群组世界分布对齐。数据源仍是 /api/group/worlds（聚合的群成员在线状态）。
//
// region 中文映射（与 worlds-panel 旧版保持一致）
const MAP_REGION_CN = {
  JP: '日本', US: '美洲', EU: '欧洲', USW: '美西', USE: '美东',
  AS: '亚洲', ASIA: '亚洲', AU: '大洋洲', KR: '韩国', IN: '印度'
};
function mapRegionCn(code) {
  if (!code) return __('map.region_unknown') || '未分类';
  const c = String(code).toUpperCase();
  return MAP_REGION_CN[c] || c;
}

// 解析 "wrld_xxx:84292~group(g)~accessType(public)~region(jp)" → {instanceId, region, isPrivate}
function _parseVrcInstance(location) {
  if (!location || typeof location !== 'string') return null;
  const m = location.match(/^wrld_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:([^~]+)/i);
  if (!m) return null;
  const instanceId = m[1];
  const segs = location.split('~');
  let region = '', isPrivate = false;
  for (const seg of segs) {
    if (seg.startsWith('region(')) region = seg.slice(7, -1);
    if (seg.startsWith('accessType(')) isPrivate = (seg.slice(11, -1) === 'private' || seg.slice(11, -1) === 'friends');
  }
  return { instanceId, region, isPrivate };
}

function updateWorldMapMarkers() {
  const grid = document.getElementById('eventWorldsGrid');
  if (!grid) return;
  api('/api/group/worlds', { method: 'GET' }).then(res => {
    if (!res.ok) throw new Error();
    return res.json();
  }).then(data => {
    const worlds = data.worlds || [];
    if (worlds.length === 0) {
      renderEmpty(grid, { icon: '🌐', text: __('map.no_world_data') });
      _setMapKpi({ worlds: 0, members: 0, friends: 0, instances: 0 });
      _renderMapRegions({});
      _renderMapTop([]);
      const up = document.getElementById('mapWorldsUpdatedAt');
      if (up) up.textContent = '· ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return;
    }
    _renderMapWorldsPanel(worlds);
  }).catch(() => {
    renderEmpty(grid, { icon: '⚠️', text: __('map.load_failed') });
  });
}

function _renderMapWorldsPanel(worlds) {
  // ① KPI 汇总
  let totalMembers = 0, totalFriends = 0;
  const instanceMap = new Map();   // instanceId → {instanceId, region, isPrivate, memberCount, worldName, members:[]}
  for (const w of worlds) {
    totalMembers += Number(w.count) || 0;
    totalFriends += Number(w.friendCount) || 0;
    for (const m of (w.members || [])) {
      const loc = m.location || '';
      const parsed = _parseVrcInstance(loc);
      if (!parsed) continue;
      const key = parsed.instanceId;
      if (!instanceMap.has(key)) {
        instanceMap.set(key, {
          instanceId: key,
          region: (parsed.region || '').toUpperCase(),
          isPrivate: !!parsed.isPrivate,
          memberCount: 0,
          worldName: w.worldName,
          members: []
        });
      }
      const it = instanceMap.get(key);
      it.memberCount++;
      it.members.push(m);
    }
  }
  const instances = Array.from(instanceMap.values());
  _setMapKpi({ worlds: worlds.length, members: totalMembers, friends: totalFriends, instances: instances.length });

  // ② 区域聚集
  const regionMap = {};
  for (const it of instances) {
    const r = (it.region || 'unknown').toUpperCase();
    if (!regionMap[r]) regionMap[r] = 0;
    regionMap[r] += it.memberCount;
  }
  _renderMapRegions(regionMap);

  // ③ 热门实例 Top 5
  const top = instances.slice().sort((a, b) => b.memberCount - a.memberCount).slice(0, 5);
  _renderMapTop(top);

  // ④ 世界分布网格
  _renderMapGrid(worlds);

  const up = document.getElementById('mapWorldsUpdatedAt');
  if (up) up.textContent = '· ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function _setMapKpi(s) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('mapKpiWorlds', s.worlds);
  set('mapKpiMembers', s.members);
  set('mapKpiFriends', s.friends);
  set('mapKpiInstances', s.instances);
}

function _renderMapRegions(regionMap) {
  const list = document.getElementById('mapWorldsRegionList');
  if (!list) return;
  const entries = Object.keys(regionMap).map(k => ({ code: k, count: regionMap[k] })).sort((a, b) => b.count - a.count);
  if (entries.length === 0) {
    list.innerHTML = `<div class="worlds-region-empty text-muted2 text-13" data-i18n="map.no_world_data">暂无数据</div>`;
    return;
  }
  const max = entries[0].count || 1;
  list.innerHTML = entries.map(e => `
    <div class="worlds-region-item">
      <div class="worlds-region-head">
        <span class="worlds-region-code">${esc(mapRegionCn(e.code))}</span>
        <span class="worlds-region-count">${e.count}</span>
      </div>
      <div class="worlds-region-bar"><span style="width:${Math.max(8, Math.round(e.count / max * 100))}%"></span></div>
    </div>
  `).join('');
}

function _renderMapTop(top) {
  const list = document.getElementById('mapWorldsTopList');
  if (!list) return;
  if (top.length === 0) {
    list.innerHTML = `<div class="worlds-top-empty text-muted2 text-13" data-i18n="map.no_world_data">暂无数据</div>`;
    return;
  }
  const max = top[0].memberCount || 1;
  list.innerHTML = top.map((it, idx) => `
    <div class="worlds-top-item" title="${esc(it.instanceId)}">
      <div class="worlds-top-rank">${idx + 1}</div>
      <div class="worlds-top-main">
        <div class="worlds-top-line1">
          <span class="worlds-region-badge region-${(it.region || 'unknown').toLowerCase()}">${esc(mapRegionCn(it.region))}</span>
          ${it.isPrivate ? '<span class="worlds-private-badge" title="私有实例">🔒</span>' : ''}
          <span class="worlds-top-name">${esc(it.worldName || it.instanceId)}</span>
        </div>
        <div class="worlds-top-line2">
          <span class="worlds-top-id" onclick="copyToClipboard && copyToClipboard('${escJsStr(it.instanceId)}')" title="${__('map.copy_instance')}">${esc(it.instanceId.length > 36 ? it.instanceId.slice(0, 34) + '…' : it.instanceId)}</span>
        </div>
        <div class="worlds-top-bar"><span style="width:${Math.max(8, Math.round(it.memberCount / max * 100))}%"></span></div>
      </div>
      <div class="worlds-top-count">${it.memberCount}</div>
    </div>
  `).join('');
}

function _renderMapGrid(worlds) {
  const grid = document.getElementById('eventWorldsGrid');
  if (!grid) return;
  grid.innerHTML = worlds.map(w => {
    // 按 instance 拆分子卡（同 instance 成员聚合）
    const instMap = new Map();
    for (const m of (w.members || [])) {
      const parsed = _parseVrcInstance(m.location || '');
      const key = parsed ? parsed.instanceId : '';
      if (!instMap.has(key)) instMap.set(key, { instanceId: key, region: parsed ? (parsed.region || '').toUpperCase() : '', isPrivate: parsed ? !!parsed.isPrivate : false, members: [] });
      instMap.get(key).members.push(m);
    }
    const instArr = Array.from(instMap.values());
    return `
      <div class="world-grid-card">
        <div class="world-grid-header">
          <span class="world-grid-name" title="${esc(w.worldName)}">🌐 ${esc(w.worldName)}</span>
          <div class="world-grid-meta">
            <span class="world-grid-count" title="${__('map.world_total_label', {n: w.totalCount})}${w.totalCountEstimated ? '（' + __('map.world_total_estimated') + '）' : ''}">${__('map.world_total_label', {n: w.totalCount})}</span>
            <span class="world-grid-sub">${__('map.world_friend_label', {n: w.friendCount})} · ${__('map.world_member_label', {n: w.count})}</span>
          </div>
        </div>
        ${instArr.length > 1 ? `<div class="world-instances-list">${instArr.map(it => `
          <div class="world-instance-row" title="${esc(it.instanceId)}">
            <span class="worlds-region-badge region-${(it.region || 'unknown').toLowerCase()}">${esc(mapRegionCn(it.region))}</span>
            ${it.isPrivate ? '<span class="worlds-private-badge" title="私有实例">🔒</span>' : ''}
            <span class="world-instance-id" onclick="copyToClipboard && copyToClipboard('${escJsStr(it.instanceId)}')" title="${__('map.copy_instance')}">${esc(it.instanceId.length > 30 ? it.instanceId.slice(0, 28) + '…' : it.instanceId)}</span>
            <span class="world-instance-count">${it.members.length}</span>
          </div>
        `).join('')}</div>` : ''}
        <div class="world-grid-members">
          ${w.members.slice(0, 8).map(m => {
            const wa = mapAvatarSrc(m.avatarUrl);
            return `
            <div class="world-mini-avatar" title="${esc(m.displayName)}" onclick="openVrcMemberCard('${escJsStr(m.vrchatId)}')" style="cursor:pointer">
              <img src="${escAttr(wa)}" alt="${esc(m.displayName)}" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escAttr(wa)}');this.style.display='none';this.nextElementSibling.style.display='flex'">
              <div class="world-avatar-fallback" style="${wa === '/api/avatar/default' ? 'display:flex' : ''}">${esc((m.displayName || '?').charAt(0).toUpperCase())}</div>
            </div>`;
          }).join('')}
          ${w.members.length > 8 ? `<span class="world-more">+${w.members.length - 8}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ==================== 视图切换 ====================
// 同时兼容 .map-tab-btn（index.html 实际使用的类名）与 .map-view-btn（旧类名）。
function switchMapView(view) {
  const btns = document.querySelectorAll('.map-tab-btn, .map-view-btn');
  btns.forEach(b => b.classList.remove('active'));
  var activeBtn = document.querySelector('.map-tab-btn[data-view="' + view + '"], .map-view-btn[data-view="' + view + '"]');
  if (activeBtn) activeBtn.classList.add('active');
  const membersView = document.getElementById('mapMembersView');
  const worldsView = document.getElementById('mapWorldsView');
  if (membersView) membersView.classList.toggle('d-none', view !== 'members');
  if (worldsView) worldsView.classList.toggle('d-none', view !== 'worlds');
  if (view === 'members') {
    if (mapInstance) {
      setTimeout(() => mapInstance.invalidateSize(), 100);
      updateMapMarkers();
    } else {
      initMap();
    }
  } else {
    bindMapWorldsControls();
    updateWorldMapMarkers();
  }
}

// VRChat 世界面板：刷新按钮（与群组世界面板独立触发）
function bindMapWorldsControls() {
  if (bindMapWorldsControls._inited) return;
  bindMapWorldsControls._inited = true;
  const btn = document.getElementById('mapWorldsRefreshBtn');
  if (btn) btn.addEventListener('click', () => {
    btn.disabled = true;
    Promise.resolve(updateWorldMapMarkers()).finally(() => { btn.disabled = false; });
  });
}

// 打开地图并定位到指定坐标（供聊天位置消息点击调用）
window.openMapLocation = function(lat, lng) {
  if (typeof switchTab === 'function') switchTab('map');
  // 坐标多为设备 WGS-84，绘制到 GCJ-02 底图前转换
  const disp = (window.GEO && window.GEO.wgs84ToGcj02) ? window.GEO.wgs84ToGcj02(lng, lat) : [lng, lat];
  const glng = disp[0], glat = disp[1];
  setTimeout(() => {
    if (!mapInstance) {
      if (typeof initMap === 'function') initMap();
      setTimeout(() => {
        if (mapInstance) {
          mapInstance.setView([glat, glng], 14);
          L.popup().setLatLng([glat, glng]).setContent('📍 ' + lat.toFixed(4) + ', ' + lng.toFixed(4)).openOn(mapInstance);
        }
      }, 500);
    } else {
      mapInstance.setView([glat, glng], 14);
      L.popup().setLatLng([glat, glng]).setContent('📍 ' + lat.toFixed(4) + ', ' + lng.toFixed(4)).openOn(mapInstance);
    }
  }, 300);
};
