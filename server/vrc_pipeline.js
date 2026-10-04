const WebSocket = require('ws');
const logger = require('./logger');

const PIPELINE_URL = 'wss://pipeline.vrchat.cloud';
const RECONNECT_DELAY = 5000;

class VRCPipeline {
  constructor() {
    this.ws = null;
    this.authToken = null;
    this.reconnectAttempts = 0;
    this.isConnected = false;
    this.eventHandlers = new Map();
    this._connectTimeout = null;
    this._pingInterval = null;
    this._pongTimeout = null;
    this._lastPongAt = 0;
    this._socketId = 0;
    this._activeSocketId = 0;
    this._heartbeatIntervalMs = 30000;
    this._pongTimeoutMs = 10000;
    this._connectTimeoutMs = 15000;
    this._maxReconnectDelayMs = 60000;
    this._warnedUnknownTypes = new Set();
    this._sessionErrorCount = 0;
    this._lastSessionError = null;
    // F-29: 会话被服务端拒绝（典型：出口 IP ≠ 签发 authToken 的 IP）后置为 true，
    // 触发「暂停重连」语义：同一 authToken 下无论重连多少次都会被拒，
    // 无限风暴只会空耗出口连接；必须等上层拿到新 cookie（setAuthToken）或管理员介入才恢复。
    this._sessionRejected = false;
  }

  setAuthToken(token) {
    this.authToken = token;
    // 新 authToken = 新会话，解除「会话被拒暂停」，允许重新发起连接
    this._sessionRejected = false;
    if (this.isConnected) {
      this.disconnect();
      this.connect();
    }
  }

  connect() {
    if (!this.authToken) {
      logger.warn('vrc-pipeline', '[VRCPipeline] 缺少 authToken，无法连接');
      return;
    }

    this._clearTimers();

    // 官方 Pipeline 握手参数为 authToken（authcookie_xxx），对齐 VRCX 与官方文档。
    const url = `${PIPELINE_URL}/?authToken=${encodeURIComponent(this.authToken)}`;
    logger.info('vrc-pipeline', `[VRCPipeline] 正在连接 VRChat Pipeline...`);

    const socketId = ++this._socketId;
    this._activeSocketId = socketId;

    const userAgent = process.env.VRC_USER_AGENT || 'JingTuWeb/1.3.0';
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': userAgent,
        'Origin': 'https://vrchat.com'
      }
    });
    this.ws = ws;

    const isCurrentSocket = () => this._activeSocketId === socketId && this.ws === ws;

    this._connectTimeout = setTimeout(() => {
      if (!isCurrentSocket()) return;
      logger.warn('vrc-pipeline', `⚠️ [VRCPipeline] 连接握手超时，关闭重试`);
      try { ws.terminate(); } catch (e) {}
      this._scheduleReconnect();
    }, this._connectTimeoutMs);

    ws.on('open', () => {
      if (!isCurrentSocket()) return;
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this._lastPongAt = Date.now();
      logger.info('vrc-pipeline', `✅ [VRCPipeline] 连接成功`);
      this.emit('connected');
      this._startHeartbeat();
    });

    ws.on('message', (data) => {
      if (!isCurrentSocket()) return;
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        logger.warn('vrc-pipeline', `⚠️ [VRCPipeline] 消息解析失败:`, e.message);
      }
    });

    ws.on('ping', () => {
      if (!isCurrentSocket()) return;
      this._lastPongAt = Date.now();
      try { ws.pong(); } catch (e) {}
    });

    ws.on('pong', () => {
      if (!isCurrentSocket()) return;
      this._lastPongAt = Date.now();
      clearTimeout(this._pongTimeout);
      this._pongTimeout = null;
    });

    ws.on('close', (code, reason) => {
      if (!isCurrentSocket()) return;
      this._clearTimers();
      this.isConnected = false;
      const reasonText = reason ? reason.toString() : '';
      // 1006 = 无关闭帧的异常关闭。若此前收到过服务端 err 帧（会话被拒），
      // 此 1006 大概率为其闭环，直接把原因带上，避免"为什么循环"无从查起。
      if (code === 1006 && this._lastSessionError && this._lastSessionError.err) {
        logger.error('vrc-pipeline', `🔌 [VRCPipeline] 连接异常关闭 (1006)：${this._lastSessionError.err}`);
      } else {
        logger.info('vrc-pipeline', `🔌 [VRCPipeline] 连接关闭 (${code}): ${reasonText || '无'}`);
      }
      this.emit('disconnected', { code, reason });
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (!isCurrentSocket()) return;
      logger.error('vrc-pipeline', `❌ [VRCPipeline] 连接错误:`, err.message);
      this.emit('error', err);
      // 主动关闭：error 后底层 socket 可能已损坏，但 ws 库未必会再触发 close 事件
      // （如握手阶段被重置、部分网络栈的静默丢包）。不 terminate 的话 _scheduleReconnect
      // 将永不被调用，重连机制会卡死在半开连接上。terminate 保证 close 事件必然触发，
      // 由 close 处理器统一驱动重连（对 _sessionRejected 暂停语义无影响，它由 err 帧先行置位）。
      try { ws.terminate(); } catch (e) {}
    });
  }

  disconnect() {
    this._activeSocketId++;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.terminate(); } catch (e) {}
      this.ws = null;
    }
    this.isConnected = false;
  }

  _clearTimers() {
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
    }
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
    if (this._pongTimeout) {
      clearTimeout(this._pongTimeout);
      this._pongTimeout = null;
    }
  }

  _startHeartbeat() {
    this._clearTimers();
    this._pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
      } catch (e) {
        logger.warn('vrc-pipeline', `⚠️ [VRCPipeline] ping 发送失败:`, e.message);
        return;
      }
      this._pongTimeout = setTimeout(() => {
        logger.warn('vrc-pipeline', `⚠️ [VRCPipeline] 心跳 pong 超时，断开重连`);
        if (this.ws) {
          try { this.ws.terminate(); } catch (e) {}
        }
        this._scheduleReconnect();
      }, this._pongTimeoutMs);
    }, this._heartbeatIntervalMs);
  }

  _scheduleReconnect() {
    this._clearTimers();
    if (!this.authToken) return;
    // F-29: 会话被服务端拒绝（如出口 IP ≠ 签发 IP）时暂停重连风暴。
    // 同一 authToken 每次握手都会收到 err 帧 → close(1006)，无限循环，
    // 只等上层自动重登拿到新 cookie（setAuthToken 解除暂停）或管理员介入。
    if (this._sessionRejected) {
      logger.warn('vrc-pipeline', '[VRCPipeline] 会话被拒已暂停重连，等待新 authToken（自动重登）或管理员处理...');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_DELAY * Math.pow(1.5, this.reconnectAttempts - 1),
      this._maxReconnectDelayMs
    );
    logger.info('vrc-pipeline', `[VRCPipeline] ${Math.round(delay / 1000)} 秒后重连... (第 ${this.reconnectAttempts} 次)`);
    this._connectTimeout = setTimeout(() => this.connect(), delay);
  }

  handleMessage(msg) {
    // 服务端 err 帧（无 type 字段，如 "authToken doesn't correspond with an active session"）：
    // 连接可成功打开但会话被拒（典型：出口 IP ≠ 签发 authToken 的 IP，代理/VPN/家宽出口漂移），
    // 随后服务端关闭连接。F-28 修复：不再静默丢弃，记录原因并广播给上层，让 1006 循环可诊断。
    if (msg && msg.err) {
      this._handleSessionError(msg);
      return;
    }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'notification':
      case 'notification-v2':
        this.handleNotification(msg);
        break;
      case 'response-notification':
        this.handleResponseNotification(msg);
        break;
      case 'see-notification':
      case 'hide-notification':
      case 'clear-notification':
        this.emit('notification', msg);
        break;
      case 'user-online':
      case 'user-offline':
      case 'user-update':
      case 'user-location':
        this.emit('user', msg);
        break;
      case 'friend-online':
      case 'friend-offline':
      case 'friend-active':
      case 'friend-add':
      case 'friend-remove':
      case 'friend-location':
      case 'friend-update':
        this.emit('friend', msg);
        break;
      case 'instance':
        this.emit('instance', msg);
        break;
      case 'system':
        this.emit('system', msg);
        break;
      default:
        if (!this._warnedUnknownTypes.has(msg.type)) {
          this._warnedUnknownTypes.add(msg.type);
          logger.info('vrc-pipeline', `[VRCPipeline] 未处理消息类型（仅提示一次）: ${msg.type}`);
        }
        this.emit('unknown', msg);
    }
  }

  _maskToken(token) {
    if (!token || token.length <= 12) return '***';
    return token.slice(0, 4) + '***' + token.slice(-4);
  }

  _handleSessionError(msg) {
    const err = typeof msg.err === 'string' ? msg.err : JSON.stringify(msg.err);
    const ip = msg.ip || null;
    const maskedToken = this._maskToken(msg.authToken || this.authToken);
    this._sessionErrorCount++;
    this._lastSessionError = {
      err,
      ip,
      authToken: maskedToken,
      at: new Date().toISOString()
    };
    // F-29: 会话被拒后暂停重连。服务端 err 帧即明确告知「这个 authToken 无效」，
    // 继续重连只会重复握手→被拒→1006 的循环；由上层监听 session-rejected 触发自动重登。
    this._sessionRejected = true;
    const ipHint = ip ? `（服务端记录出口 IP: ${ip}）` : '';
    logger.error('vrc-pipeline', `❌ [VRCPipeline] 服务端拒绝会话: ${err}${ipHint}${maskedToken ? `（authToken ${maskedToken}）` : ''}`);
    this.emit('session-error', Object.assign({}, this._lastSessionError));
    this.emit('session-rejected', Object.assign({}, this._lastSessionError));
  }

  handleNotification(msg) {
    try {
      let content = msg.content;
      if (typeof content === 'string') {
        content = JSON.parse(content);
      }

      const notification = {
        type: msg.type,
        id: content.id || content.notificationId,
        notificationType: content.type,
        title: content.title,
        message: content.message,
        senderUserId: content.senderUserId,
        senderUsername: content.senderUsername,
        receiverUserId: content.receiverUserId,
        link: content.link,
        imageUrl: content.imageUrl,
        category: content.category,
        isSystem: content.isSystem,
        createdAt: content.createdAt || new Date().toISOString()
      };

      this.emit('notification', notification);

      if (content.type === 'group.announcement') {
        this.emit('group_announcement', notification);
      } else if (content.type === 'invite') {
        this.emit('invite', notification);
      } else if (content.type === 'friendRequest') {
        this.emit('friend_request', notification);
      }
    } catch (e) {
      logger.warn('vrc-pipeline', `⚠️ [VRCPipeline] 通知解析失败:`, e.message);
    }
  }

  handleResponseNotification(msg) {
    try {
      let content = msg.content;
      if (typeof content === 'string') {
        content = JSON.parse(content);
      }
      this.emit('response_notification', content);
    } catch (e) {
      logger.warn('vrc-pipeline', `⚠️ [VRCPipeline] 响应通知解析失败:`, e.message);
    }
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    }
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          logger.error('vrc-pipeline', `⚠️ [VRCPipeline] 事件处理失败 (${event}):`, e.message);
        }
      }
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      authToken: this.authToken ? '***' : null,
      sessionErrorCount: this._sessionErrorCount,
      lastSessionError: this._lastSessionError,
      // F-29: 会话被拒暂停中（重连风暴已中止，等待新 authToken / 管理员介入）
      sessionRejected: this._sessionRejected
    };
  }
}

module.exports = VRCPipeline;