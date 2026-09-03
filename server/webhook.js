const axios = require('axios');
const { getPool } = require('./utils');

const WEBHOOK_EVENTS = {
  USER_REGISTERED: 'user_registered',
  USER_LOGIN: 'user_login',
  POST_CREATED: 'post_created',
  POST_UPDATED: 'post_updated',
  POST_DELETED: 'post_deleted',
  EVENT_CREATED: 'event_created',
  EVENT_UPDATED: 'event_updated',
  EVENT_DELETED: 'event_deleted',
  ANNOUNCEMENT_CREATED: 'announcement_created',
  SECURITY_ALERT: 'security_alert',
  SYSTEM_ERROR: 'system_error'
};

async function getWebhooks(eventType = null) {
  try {
    const pool = getPool();
    const query = eventType 
      ? 'SELECT * FROM webhooks WHERE enabled = 1 AND FIND_IN_SET(?, events)'
      : 'SELECT * FROM webhooks WHERE enabled = 1';
    const params = eventType ? [eventType] : [];
    const [rows] = await pool.query(query, params);
    return rows;
  } catch (e) {
    console.error('[webhook] 获取webhook失败:', e);
    return [];
  }
}

async function createWebhook(url, events, secret = '') {
  try {
    const pool = getPool();
    const [result] = await pool.query(
      'INSERT INTO webhooks (url, events, secret, enabled) VALUES (?, ?, ?, 1)',
      [url, Array.isArray(events) ? events.join(',') : events, secret]
    );
    return result.insertId;
  } catch (e) {
    console.error('[webhook] 创建webhook失败:', e);
    throw e;
  }
}

async function updateWebhook(id, updates) {
  try {
    const pool = getPool();
    const [result] = await pool.query(
      'UPDATE webhooks SET ? WHERE id = ?',
      [updates, id]
    );
    return result.affectedRows > 0;
  } catch (e) {
    console.error('[webhook] 更新webhook失败:', e);
    throw e;
  }
}

async function deleteWebhook(id) {
  try {
    const pool = getPool();
    const [result] = await pool.query('DELETE FROM webhooks WHERE id = ?', [id]);
    return result.affectedRows > 0;
  } catch (e) {
    console.error('[webhook] 删除webhook失败:', e);
    throw e;
  }
}

function signPayload(payload, secret) {
  if (!secret) return null;
  const crypto = require('crypto');
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

async function sendWebhook(url, eventType, data, secret = '') {
  try {
    const payload = {
      event: eventType,
      timestamp: Date.now(),
      data: data
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-JingTu-Event': eventType,
      'X-JingTu-Timestamp': payload.timestamp.toString()
    };

    if (secret) {
      headers['X-JingTu-Signature'] = signPayload(payload, secret);
    }

    const response = await axios.post(url, payload, {
      headers,
      timeout: 5000
    });

    console.log('[webhook] 发送成功:', eventType, url);
    return { success: true, status: response.status };
  } catch (e) {
    console.error('[webhook] 发送失败:', eventType, url, e.message);
    return { success: false, error: e.message };
  }
}

async function trigger(eventType, data) {
  const webhooks = await getWebhooks(eventType);
  if (webhooks.length === 0) {
    console.log('[webhook] 没有匹配的webhook:', eventType);
    return;
  }

  console.log('[webhook] 触发事件:', eventType, '目标:', webhooks.length, '个');

  const results = await Promise.allSettled(
    webhooks.map(async (webhook) => {
      return await sendWebhook(webhook.url, eventType, data, webhook.secret);
    })
  );

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  const failCount = results.length - successCount;

  if (failCount > 0) {
    console.warn('[webhook] 部分发送失败:', failCount, '/', results.length);
  }
}

async function triggerUserRegistered(user) {
  await trigger(WEBHOOK_EVENTS.USER_REGISTERED, {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: user.email,
    created_at: user.created_at
  });
}

async function triggerUserLogin(user) {
  await trigger(WEBHOOK_EVENTS.USER_LOGIN, {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    login_at: new Date().toISOString()
  });
}

async function triggerPostCreated(post) {
  await trigger(WEBHOOK_EVENTS.POST_CREATED, {
    id: post.id,
    user_id: post.user_id,
    content: post.content,
    created_at: post.created_at
  });
}

async function triggerPostUpdated(post) {
  await trigger(WEBHOOK_EVENTS.POST_UPDATED, {
    id: post.id,
    user_id: post.user_id,
    content: post.content,
    updated_at: post.updated_at
  });
}

async function triggerPostDeleted(postId, userId) {
  await trigger(WEBHOOK_EVENTS.POST_DELETED, {
    id: postId,
    user_id: userId,
    deleted_at: new Date().toISOString()
  });
}

async function triggerEventCreated(event) {
  await trigger(WEBHOOK_EVENTS.EVENT_CREATED, {
    id: event.id,
    title: event.title,
    description: event.description,
    start_time: event.start_time,
    end_time: event.end_time,
    created_at: event.created_at
  });
}

async function triggerEventUpdated(event) {
  await trigger(WEBHOOK_EVENTS.EVENT_UPDATED, {
    id: event.id,
    title: event.title,
    description: event.description,
    start_time: event.start_time,
    end_time: event.end_time,
    updated_at: event.updated_at
  });
}

async function triggerEventDeleted(eventId) {
  await trigger(WEBHOOK_EVENTS.EVENT_DELETED, {
    id: eventId,
    deleted_at: new Date().toISOString()
  });
}

async function triggerAnnouncementCreated(announcement) {
  await trigger(WEBHOOK_EVENTS.ANNOUNCEMENT_CREATED, {
    id: announcement.id,
    title: announcement.title,
    content: announcement.content,
    created_at: announcement.created_at
  });
}

async function triggerSecurityAlert(message, details = {}) {
  await trigger(WEBHOOK_EVENTS.SECURITY_ALERT, {
    message,
    details,
    timestamp: new Date().toISOString()
  });
}

async function triggerSystemError(error, context = {}) {
  await trigger(WEBHOOK_EVENTS.SYSTEM_ERROR, {
    error: error.message || error.toString(),
    context,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  WEBHOOK_EVENTS,
  getWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  sendWebhook,
  trigger,
  triggerUserRegistered,
  triggerUserLogin,
  triggerPostCreated,
  triggerPostUpdated,
  triggerPostDeleted,
  triggerEventCreated,
  triggerEventUpdated,
  triggerEventDeleted,
  triggerAnnouncementCreated,
  triggerSecurityAlert,
  triggerSystemError
};
