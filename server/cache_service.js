const cache = require('./cache');

const CACHE_TTL = {
  USER: 30 * 60,
  USER_ONLINE: 30,
  ACTIVITY: 5 * 60,
  ACTIVITY_CALENDAR: 10 * 60,
  POST: 2 * 60,
  PHOTO: 10 * 60,
  ANNOUNCEMENT: 15 * 60,
  CONFIG: 24 * 60 * 60,
  STATS: 5 * 60,
  STATS_TOP_LIKES: 60 * 60,
  WORLD_CACHE: 60 * 60,
  PROFILE_CARD: 5 * 60,
  GROUP_ROSTER: 1 * 60
};

const cacheKeys = {
  user: (id) => `user:${id}`,
  users: () => 'users:list',
  activity: (id) => `activity:${id}`,
  activities: () => 'activities:list',
  activitiesCalendar: () => 'activities:calendar',
  post: (id) => `post:${id}`,
  posts: () => 'posts:list',
  photo: (id) => `photo:${id}`,
  photos: () => 'photos:list',
  announcement: (id) => `announcement:${id}`,
  announcements: () => 'announcements:list',
  config: () => 'config:global',
  stats: () => 'stats:summary',
  topLikes: () => 'stats:top_likes',
  onlineUsers: () => 'users:online',
  world: (id) => `world:${id}`,
  worldList: () => 'worlds:list',
  profileCard: (id) => `profile:card:${id}`,
  groupRoster: () => 'group:roster',
  groupRosterOnline: () => 'group:roster:online',
  achievements: () => 'achievements:list'
};

async function getUser(id) {
  const key = cacheKeys.user(id);
  return await cache.get(key);
}

async function setUser(id, data) {
  const key = cacheKeys.user(id);
  await cache.set(key, data, CACHE_TTL.USER);
}

async function invalidateUser(id) {
  const key = cacheKeys.user(id);
  await cache.del(key);
  await cache.del(cacheKeys.users());
  await cache.del(cacheKeys.profileCard(id));
}

async function getUsers() {
  const key = cacheKeys.users();
  return await cache.get(key);
}

async function setUsers(data) {
  const key = cacheKeys.users();
  await cache.set(key, data, CACHE_TTL.USER);
}

async function getActivity(id) {
  const key = cacheKeys.activity(id);
  return await cache.get(key);
}

async function setActivity(id, data) {
  const key = cacheKeys.activity(id);
  await cache.set(key, data, CACHE_TTL.ACTIVITY);
}

async function invalidateActivity(id) {
  const key = cacheKeys.activity(id);
  await cache.del(key);
  await cache.del(cacheKeys.activities());
  await cache.del(cacheKeys.activitiesCalendar());
}

async function getActivities() {
  const key = cacheKeys.activities();
  return await cache.get(key);
}

async function setActivities(data) {
  const key = cacheKeys.activities();
  await cache.set(key, data, CACHE_TTL.ACTIVITY);
}

async function getActivityCalendar() {
  const key = cacheKeys.activitiesCalendar();
  return await cache.get(key);
}

async function setActivityCalendar(data) {
  const key = cacheKeys.activitiesCalendar();
  await cache.set(key, data, CACHE_TTL.ACTIVITY_CALENDAR);
}

async function getPost(id) {
  const key = cacheKeys.post(id);
  return await cache.get(key);
}

async function setPost(id, data) {
  const key = cacheKeys.post(id);
  await cache.set(key, data, CACHE_TTL.POST);
}

async function invalidatePost(id) {
  const key = cacheKeys.post(id);
  await cache.del(key);
  await cache.del(cacheKeys.posts());
}

async function getPosts() {
  const key = cacheKeys.posts();
  return await cache.get(key);
}

async function setPosts(data) {
  const key = cacheKeys.posts();
  await cache.set(key, data, CACHE_TTL.POST);
}

async function getPhoto(id) {
  const key = cacheKeys.photo(id);
  return await cache.get(key);
}

async function setPhoto(id, data) {
  const key = cacheKeys.photo(id);
  await cache.set(key, data, CACHE_TTL.PHOTO);
}

async function invalidatePhoto(id) {
  const key = cacheKeys.photo(id);
  await cache.del(key);
  await cache.del(cacheKeys.photos());
}

async function getPhotos() {
  const key = cacheKeys.photos();
  return await cache.get(key);
}

async function setPhotos(data) {
  const key = cacheKeys.photos();
  await cache.set(key, data, CACHE_TTL.PHOTO);
}

async function getAnnouncement(id) {
  const key = cacheKeys.announcement(id);
  return await cache.get(key);
}

async function setAnnouncement(id, data) {
  const key = cacheKeys.announcement(id);
  await cache.set(key, data, CACHE_TTL.ANNOUNCEMENT);
}

async function invalidateAnnouncement(id) {
  const key = cacheKeys.announcement(id);
  await cache.del(key);
  await cache.del(cacheKeys.announcements());
}

async function getAnnouncements() {
  const key = cacheKeys.announcements();
  return await cache.get(key);
}

async function setAnnouncements(data) {
  const key = cacheKeys.announcements();
  await cache.set(key, data, CACHE_TTL.ANNOUNCEMENT);
}

async function getConfig() {
  const key = cacheKeys.config();
  return await cache.get(key);
}

async function setConfig(data) {
  const key = cacheKeys.config();
  await cache.set(key, data, CACHE_TTL.CONFIG);
}

async function invalidateConfig() {
  await cache.del(cacheKeys.config());
}

async function getStats() {
  const key = cacheKeys.stats();
  return await cache.get(key);
}

async function setStats(data) {
  const key = cacheKeys.stats();
  await cache.set(key, data, CACHE_TTL.STATS);
}

async function getTopLikes() {
  const key = cacheKeys.topLikes();
  return await cache.get(key);
}

async function setTopLikes(data) {
  const key = cacheKeys.topLikes();
  await cache.set(key, data, CACHE_TTL.STATS_TOP_LIKES);
}

async function getOnlineUsers() {
  const key = cacheKeys.onlineUsers();
  return await cache.get(key);
}

async function setOnlineUsers(data) {
  const key = cacheKeys.onlineUsers();
  await cache.set(key, data, CACHE_TTL.USER_ONLINE);
}

async function invalidateOnlineUsers() {
  await cache.del(cacheKeys.onlineUsers());
}

async function getWorld(id) {
  const key = cacheKeys.world(id);
  return await cache.get(key);
}

async function setWorld(id, data) {
  const key = cacheKeys.world(id);
  await cache.set(key, data, CACHE_TTL.WORLD_CACHE);
}

async function invalidateWorld(id) {
  await cache.del(cacheKeys.world(id));
  await cache.del(cacheKeys.worldList());
}

async function getWorldList() {
  const key = cacheKeys.worldList();
  return await cache.get(key);
}

async function setWorldList(data) {
  const key = cacheKeys.worldList();
  await cache.set(key, data, CACHE_TTL.WORLD_CACHE);
}

async function getProfileCard(id) {
  const key = cacheKeys.profileCard(id);
  return await cache.get(key);
}

async function setProfileCard(id, data) {
  const key = cacheKeys.profileCard(id);
  await cache.set(key, data, CACHE_TTL.PROFILE_CARD);
}

async function invalidateProfileCard(id) {
  await cache.del(cacheKeys.profileCard(id));
}

async function getGroupRoster() {
  const key = cacheKeys.groupRoster();
  return await cache.get(key);
}

async function setGroupRoster(data) {
  const key = cacheKeys.groupRoster();
  await cache.set(key, data, CACHE_TTL.GROUP_ROSTER);
}

async function invalidateGroupRoster() {
  await cache.del(cacheKeys.groupRoster());
  await cache.del(cacheKeys.groupRosterOnline());
}

async function getGroupRosterOnline() {
  const key = cacheKeys.groupRosterOnline();
  return await cache.get(key);
}

async function setGroupRosterOnline(data) {
  const key = cacheKeys.groupRosterOnline();
  await cache.set(key, data, CACHE_TTL.USER_ONLINE);
}

async function warmup(getPool) {
  if (!cache.isEnabled()) {
    console.log('[cache-service] Redis未启用，跳过缓存预热');
    return;
  }

  try {
    const pool = getPool();
    console.log('[cache-service] 开始缓存预热...');

    const [users] = await pool.query(
      `SELECT id, login_id AS loginId, display_name AS displayName, role, avatar_type, custom_avatar_path, vrchat_avatar_url 
       FROM users WHERE deleted_at IS NULL LIMIT 50`
    );
    if (users.length > 0) {
      await setUsers(users);
      for (const user of users) {
        await setUser(user.id, user);
      }
      console.log(`[cache-service] 预热用户数据: ${users.length} 条`);
    }

    const [activities] = await pool.query(
      `SELECT * FROM event WHERE event_time > NOW() AND is_archive = 0 ORDER BY event_time LIMIT 20`
    );
    if (activities.length > 0) {
      await setActivities(activities);
      for (const activity of activities) {
        await setActivity(activity.id, activity);
      }
      console.log(`[cache-service] 预热活动数据: ${activities.length} 条`);
    }

    const [calendarActivities] = await pool.query(
      `SELECT id, title, event_time AS eventTime, world_name AS worldName 
       FROM event WHERE event_time > NOW() AND is_archive = 0 ORDER BY event_time LIMIT 60`
    );
    if (calendarActivities.length > 0) {
      await setActivityCalendar(calendarActivities);
      console.log(`[cache-service] 预热活动日历: ${calendarActivities.length} 条`);
    }

    const [posts] = await pool.query(
      `SELECT id, user_id, content, type, like_count, comment_count, visibility, created_at 
       FROM posts ORDER BY is_pinned DESC, created_at DESC LIMIT 30`
    );
    if (posts.length > 0) {
      await setPosts(posts);
      for (const post of posts) {
        await setPost(post.id, post);
      }
      console.log(`[cache-service] 预热动态数据: ${posts.length} 条`);
    }

    const [announcements] = await pool.query(
      `SELECT * FROM announcement ORDER BY create_time DESC LIMIT 10`
    );
    if (announcements.length > 0) {
      await setAnnouncements(announcements);
      for (const announcement of announcements) {
        await setAnnouncement(announcement.id, announcement);
      }
      console.log(`[cache-service] 预热公告数据: ${announcements.length} 条`);
    }

    const [topLikes] = await pool.query(
      `SELECT u.id, u.display_name AS displayName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url, 
              COALESCE(l.likeCount, 0) AS likeCount
       FROM users u
       LEFT JOIN (SELECT to_user_id, COUNT(*) AS likeCount FROM user_like GROUP BY to_user_id) l ON u.id = l.to_user_id
       WHERE u.deleted_at IS NULL
       ORDER BY likeCount DESC LIMIT 10`
    );
    if (topLikes.length > 0) {
      await setTopLikes(topLikes);
      console.log(`[cache-service] 预热点赞排行榜: ${topLikes.length} 条`);
    }

    const [onlineRoster] = await pool.query(
      `SELECT vrchat_id, vrchat_name, display_name, avatar_url, world_name 
       FROM group_roster WHERE is_member = 1 AND is_online = 1 LIMIT 50`
    );
    if (onlineRoster.length > 0) {
      await setGroupRosterOnline(onlineRoster);
      console.log(`[cache-service] 预热在线成员: ${onlineRoster.length} 条`);
    }

    const [worlds] = await pool.query(
      `SELECT world_id, world_name, image_url, author_name, capacity, tags 
       FROM vrc_worlds_cache LIMIT 30`
    );
    if (worlds.length > 0) {
      await setWorldList(worlds);
      for (const world of worlds) {
        await setWorld(world.world_id, world);
      }
      console.log(`[cache-service] 预热VRC世界缓存: ${worlds.length} 条`);
    }

    console.log('[cache-service] 缓存预热完成');
  } catch (e) {
    console.error('[cache-service] 缓存预热失败:', e);
  }
}

async function clearAll() {
  await cache.flushAll();
  console.log('[cache-service] 所有缓存已清除');
}

async function getCacheStatus() {
  const stats = await cache.getStats();
  const keys = await cache.keys('*');

  const sizeByType = {};
  for (const key of keys) {
    const type = key.split(':')[0];
    sizeByType[type] = (sizeByType[type] || 0) + 1;
  }

  return {
    enabled: cache.isEnabled(),
    keyCount: keys.length,
    keysByType: sizeByType,
    redisStats: stats
  };
}

async function invalidateRelated(type) {
  switch (type) {
    case 'post':
      await cache.del(cacheKeys.posts());
      await cache.del(cacheKeys.stats());
      break;
    case 'activity':
      await cache.del(cacheKeys.activities());
      await cache.del(cacheKeys.activitiesCalendar());
      await cache.del(cacheKeys.stats());
      break;
    case 'photo':
      await cache.del(cacheKeys.photos());
      await cache.del(cacheKeys.stats());
      break;
    case 'user':
      await cache.del(cacheKeys.users());
      await cache.del(cacheKeys.onlineUsers());
      await cache.del(cacheKeys.groupRosterOnline());
      await cache.del(cacheKeys.topLikes());
      break;
    case 'world':
      await cache.del(cacheKeys.worldList());
      break;
    case 'announcement':
      await cache.del(cacheKeys.announcements());
      break;
    case 'stats':
      await cache.del(cacheKeys.stats());
      await cache.del(cacheKeys.topLikes());
      break;
    default:
      break;
  }
}

module.exports = {
  getUser,
  setUser,
  invalidateUser,
  getUsers,
  setUsers,
  getActivity,
  setActivity,
  invalidateActivity,
  getActivities,
  setActivities,
  getActivityCalendar,
  setActivityCalendar,
  getPost,
  setPost,
  invalidatePost,
  getPosts,
  setPosts,
  getPhoto,
  setPhoto,
  invalidatePhoto,
  getPhotos,
  setPhotos,
  getAnnouncement,
  setAnnouncement,
  invalidateAnnouncement,
  getAnnouncements,
  setAnnouncements,
  getConfig,
  setConfig,
  invalidateConfig,
  getStats,
  setStats,
  getTopLikes,
  setTopLikes,
  getOnlineUsers,
  setOnlineUsers,
  invalidateOnlineUsers,
  getWorld,
  setWorld,
  invalidateWorld,
  getWorldList,
  setWorldList,
  getProfileCard,
  setProfileCard,
  invalidateProfileCard,
  getGroupRoster,
  setGroupRoster,
  invalidateGroupRoster,
  getGroupRosterOnline,
  setGroupRosterOnline,
  warmup,
  clearAll,
  getCacheStatus,
  invalidateRelated,
  CACHE_TTL,
  cacheKeys
};
