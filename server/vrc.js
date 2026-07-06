/**
 * 境途同游 V5.2 — VRChat API 共享模块
 * 统一管理 VRChat API 常量和请求方法
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const VRC_API = 'https://api.vrchat.cloud/api/1';
const VRC_API_KEY = process.env.VRC_API_KEY || '';
const USER_AGENT = 'JingTuWeb/5.2';
const VRC_FETCH_TIMEOUT = 30000; // VRChat API 请求超时 30 秒

/**
 * 带超时的 fetch 包装
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = VRC_FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 通用的 VRChat API 请求函数（带 Cookie）
 */
async function vrchatRequest(method, endpoint, body = null, cookie = null) {
  const url = `${VRC_API}${endpoint}`;
  const headers = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const res = await fetchWithTimeout(url, options);
  let data;
  try {
    const buffer = await res.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    data = JSON.parse(text);
  } catch { data = null; }
  let setCookie = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') setCookie = res.headers.getSetCookie();
    else setCookie = res.headers.get('set-cookie')?.split(/,(?=\s\w+=)/).map(s => s.trim()) || [];
  } catch {}
  return { status: res.status, data, setCookie };
}

/**
 * 使用 Basic Auth 登录 VRChat
 */
async function vrchatBasicLogin(username, password) {
  const basic = Buffer.from(username + ':' + password, 'utf8').toString('base64');
  const loginRes = await fetchWithTimeout(`${VRC_API}/auth/user?apiKey=${VRC_API_KEY}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, 'Authorization': `Basic ${basic}` }
  });
  let cookie = '';
  try {
    if (typeof loginRes.headers.getSetCookie === 'function') cookie = loginRes.headers.getSetCookie().join('; ');
    else loginRes.headers.forEach((v, k) => { if (k.toLowerCase() === 'set-cookie') cookie += v + '; '; });
  } catch {}
  let data;
  try {
    const buf = await loginRes.arrayBuffer();
    data = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(buf));
  } catch { data = null; }
  const needs2fa = Array.isArray(data?.requiresTwoFactorAuth) && data.requiresTwoFactorAuth.length > 0;
  return { status: loginRes.status, data, cookie, needs2fa };
}

/**
 * 用 Cookie 获取 VRChat 当前用户信息
 */
async function vrchatGetCurrentUser(cookie) {
  const res = await fetchWithTimeout(`${VRC_API}/auth/user?apiKey=${VRC_API_KEY}`, {
    headers: { 'User-Agent': USER_AGENT, 'Cookie': cookie }
  });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  return JSON.parse(text);
}

/**
 * 验证 VRChat Cookie 是否有效（内部使用）
 */
async function vrchatVerifyCookie(cookie) {
  const user = await vrchatGetCurrentUser(cookie);
  return user !== null;
}

/**
 * V5.3: 获取群组日历事件列表
 */
async function vrchatGetGroupEvents(groupId, cookie = null, n = 100, offset = 0) {
  const endpoint = `/calendar/${groupId}?n=${n}&offset=${offset}&apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V5.6: 获取 VRChat World 详情
 */
async function vrchatGetWorld(worldId, cookie = null) {
  const endpoint = `/worlds/${worldId}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V5.6: 搜索 VRChat World
 */
async function vrchatSearchWorlds(query, n = 10, cookie = null) {
  const encoded = encodeURIComponent(query);
  const endpoint = `/worlds?search=${encoded}&n=${n}&apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V6.4: 获取群组信息
 * GET /groups/{groupId}
 */
async function vrchatGetGroup(groupId, cookie) {
  const endpoint = `/groups/${groupId}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V6.4: 获取群组成员列表（分页）
 * GET /groups/{groupId}/members
 */
async function vrchatGetGroupMembers(groupId, cookie, n = 100, offset = 0) {
  const endpoint = `/groups/${groupId}/members?apiKey=${VRC_API_KEY}&n=${n}&offset=${offset}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V6.5: 获取 VRChat 用户详情（含在线状态和位置）
 * GET /users/{userId}
 */
async function vrchatGetUser(userId, cookie) {
  const endpoint = `/users/${userId}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

module.exports = {
  VRC_API,
  VRC_API_KEY,
  vrchatRequest,
  vrchatBasicLogin,
  vrchatGetCurrentUser,
  vrchatGetGroupEvents,
  vrchatGetWorld,
  vrchatSearchWorlds,
  vrchatGetGroup,
  vrchatGetGroupMembers,
  vrchatGetUser
};
