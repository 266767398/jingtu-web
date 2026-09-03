// ==================== 坐标系转换 (WGS-84 <-> GCJ-02) ====================
// 浏览器 geolocation / GPS 设备返回的是 WGS-84；
// 高德(AutoNavi)、腾讯、天地图等国内在线瓦片底图使用 GCJ-02(火星坐标)。
// 若直接把 WGS-84 坐标画在 GCJ-02 底图上，标记会偏移数百米，
// 表现为“地图数据不准/过时”。本模块在“展示时”把 WGS-84 转为 GCJ-02，
// 数据库仍按设备原始 WGS-84 存储（作为真实坐标来源，供聊天位置等复用）。
(function (global) {
  'use strict';

  var PI = Math.PI;
  var A = 6378245.0;                 // 长半轴
  var EE = 0.00669342162296594323;   // 偏心率平方

  function outOfChina(lng, lat) {
    return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
  }

  function transformLat(lng, lat) {
    var r = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat +
      0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
    r += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(lat * PI) + 40.0 * Math.sin(lat / 3.0 * PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(lat / 12.0 * PI) + 320 * Math.sin(lat * PI / 30.0)) * 2.0 / 3.0;
    return r;
  }

  function transformLng(lng, lat) {
    var r = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng +
      0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
    r += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(lng * PI) + 40.0 * Math.sin(lng / 3.0 * PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(lng / 12.0 * PI) + 300.0 * Math.sin(lng / 30.0 * PI)) * 2.0 / 3.0;
    return r;
  }

  // WGS-84 -> GCJ-02
  function wgs84ToGcj02(lng, lat) {
    lng = parseFloat(lng); lat = parseFloat(lat);
    if (isNaN(lng) || isNaN(lat)) return [lng, lat];
    if (outOfChina(lng, lat)) return [lng, lat];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }

  global.GEO = {
    wgs84ToGcj02: wgs84ToGcj02,
    outOfChina: outOfChina
  };
})(typeof window !== 'undefined' ? window : this);
