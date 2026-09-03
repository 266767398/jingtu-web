/**
 * 境途同游 — Webhook系统路由
 * 
 * @swagger
 * tags:
 *   name: Webhooks
 *   description: Webhook通知相关接口
 */
const express = require('express');
const { requireAdminCompat } = require('../auth');
const { handleError , sendError, ErrorCodes } = require('../utils');
const {
  WEBHOOK_EVENTS,
  getWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  sendWebhook
} = require('../webhook');

const router = express.Router();

router.get('/admin/webhooks', requireAdminCompat, async (req, res) => {
  try {
    const webhooks = await getWebhooks();
    res.json({ webhooks });
  } catch (e) {
    handleError(res, e, '[webhooks]');
  }
});

router.post('/admin/webhooks', requireAdminCompat, async (req, res) => {
  try {
    const { url, events, secret } = req.body;
    
    if (!url || !events) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'URL和事件类型不能为空');
    }
    
    const id = await createWebhook(url, events, secret);
    res.json({ success: true, id });
  } catch (e) {
    handleError(res, e, '[webhooks]');
  }
});

router.put('/admin/webhooks/:id', requireAdminCompat, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const success = await updateWebhook(id, updates);
    if (success) {
      res.json({ success: true });
    } else {
      sendError(res, 404, ErrorCodes.NOT_FOUND, 'Webhook不存在');
    }
  } catch (e) {
    handleError(res, e, '[webhooks]');
  }
});

router.delete('/admin/webhooks/:id', requireAdminCompat, async (req, res) => {
  try {
    const { id } = req.params;
    const success = await deleteWebhook(id);
    
    if (success) {
      res.json({ success: true });
    } else {
      sendError(res, 404, ErrorCodes.NOT_FOUND, 'Webhook不存在');
    }
  } catch (e) {
    handleError(res, e, '[webhooks]');
  }
});

router.post('/admin/webhooks/:id/test', requireAdminCompat, async (req, res) => {
  try {
    const { getPool } = require('../utils');
    const pool = getPool();
    const { id } = req.params;
    
    const [webhooks] = await pool.query('SELECT * FROM webhooks WHERE id = ?', [id]);
    if (webhooks.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, 'Webhook不存在');
    }
    
    const webhook = webhooks[0];
    const result = await sendWebhook(
      webhook.url,
      WEBHOOK_EVENTS.SECURITY_ALERT,
      { message: '测试消息', test: true },
      webhook.secret
    );
    
    res.json(result);
  } catch (e) {
    handleError(res, e, '[webhooks]');
  }
});

router.get('/admin/webhooks/events', requireAdminCompat, (req, res) => {
  res.json({ events: Object.values(WEBHOOK_EVENTS) });
});

module.exports = router;
