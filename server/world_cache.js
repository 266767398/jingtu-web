// 世界详情缓存服务 (F-17)
// 缓存载体：vrc_worlds_cache 表（DB 级，默认 24h 有效），命中直接返回；
// miss 时回源 VRChat 并回写缓存，降低对 VRChat API 的重复回源。
const { getPool } = require('./utils');
const { vrchatGetWorld } = require('./vrc');
const cacheService = require('./cache_service');

const CACHE_TTL_HOURS = 24;

// 世界 ID 清洗：与 vrc.js 的 sanitizeVrcId 保持一致（vrc.js 未导出该函数，故本地复刻）
const WRID_ID_PATTERN = /^(wrld)_[0-9a-fA-F-]+$/;
function sanitizeWorldId(id) {
  if (typeof id !== 'string' || !WRID_ID_PATTERN.test(id)) {
    const err = new Error(`非法 VRChat World ID 格式: ${id}`);
    err.code = 'INVALID_VRC_WORLD_ID';
    err.statusCode = 400;
    throw err;
  }
  return encodeURIComponent(id);
}

// 缓存行 → 世界对象（与 vrchatGetWorld 返回结构的关键字段对齐）
function rowToWorld(row) {
  if (!row) return null;
  let tags = null;
  try { tags = JSON.parse(row.tags || 'null'); } catch (e) { tags = null; }
  if (!Array.isArray(tags)) tags = null;
  return {
    id: row.world_id,
    name: row.world_name,
    description: row.description,
    authorName: row.author_name,
    authorId: row.author_id || '',
    thumbnail: { url: row.image_url },
    imageUrl: row.image_url,
    worldType: row.world_type || '',
    unityPackageUrl: row.unity_package_url || '',
    assetUrl: row.asset_url || '',
    platform: row.platform || '',
    capacity: row.capacity,
    tags: tags,
    releaseStatus: row.release_status || ''
  };
}

// 回源结果 → 缓存行（含新增列）
function worldToRow(world, worldId) {
  return [
    worldId,
    world.name || '',
    world.description || '',
    (world.imageUrl || world.thumbnailImageUrl || (world.thumbnail && world.thumbnail.url) || ''),
    world.authorName || '',
    world.authorId || '',
    world.worldType || '',
    world.unityPackageUrl || '',
    world.assetUrl || '',
    world.platform || '',
    world.capacity || 0,
    JSON.stringify(Array.isArray(world.tags) ? world.tags : []),
    world.releaseStatus || ''
  ];
}

// 获取世界详情：优先读缓存（cached_at 距今 ≤ CACHE_TTL_HOURS 视为有效），miss 回源并回写。
async function getCachedWorld(worldId, cookie = null) {
  const safeId = sanitizeWorldId(worldId);
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM vrc_worlds_cache WHERE world_id = ? AND cached_at > (NOW() - INTERVAL ${CACHE_TTL_HOURS} HOUR)`,
    [safeId]
  );
  // 自愈：历史上曾把 vrchatGetWorld 的 {status,data} 包装体当扁平世界写库，产生空名行；空名行视为 miss 重新回源
  if (rows.length && (rows[0].world_name || '')) return rowToWorld(rows[0]);

  // vrchatGetWorld 返回 vrchatRequest 包装体 {status,data,...}，须解包后再当世界对象使用
  const resp = await vrchatGetWorld(safeId, cookie);
  const world = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
  if (world && world.id) {
    const vals = worldToRow(world, safeId);
    await pool.query(
      `INSERT INTO vrc_worlds_cache
        (world_id, world_name, description, image_url, author_name, author_id, world_type, unity_package_url, asset_url, platform, capacity, tags, release_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        world_name=VALUES(world_name), description=VALUES(description), image_url=VALUES(image_url),
        author_name=VALUES(author_name), author_id=VALUES(author_id), world_type=VALUES(world_type),
        unity_package_url=VALUES(unity_package_url), asset_url=VALUES(asset_url), platform=VALUES(platform),
        capacity=VALUES(capacity), tags=VALUES(tags), release_status=VALUES(release_status),
        cached_at=NOW()`,
      vals
    );
    // Redis 缓存层（未启用时 set 为空操作，安全）
    try { await cacheService.setWorld(safeId, world); } catch (e) { /* ignore */ }
    return world;
  }
  // 回源失败（404/网络错误）：退回已有旧行（可能为空名或已过期），至少保持 ID 可用而不抛错
  return rows.length ? rowToWorld(rows[0]) : null;
}

module.exports = { getCachedWorld, rowToWorld, worldToRow, CACHE_TTL_HOURS };
