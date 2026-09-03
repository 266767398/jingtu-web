const WebSocket = require('ws');

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
  }

  setAuthToken(token) {
    this.authToken = token;
    if (this.isConnected) {
      this.disconnect();
      this.connect();
    }
  }

  connect() {
    if (!this.authToken) {
      console.warn('[VRCPipeline] 缺少 authToken，无法连接');
      return;
    }

    this._clearTimers();

    const url = `${PIPELINE_URL}/?auth=${encodeURIComponent(this.authToken)}`;
    console.log(`[VRCPipeline] 正在连接 VRChat Pipeline...`);

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
      console.warn(`⚠️ [VRCPipeline] 连接握手超时，关闭重试`);
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
      console.log(`✅ [VRCPipeline] 连接成功`);
      this.emit('connected');
      this._startHeartbeat();
    });

    ws.on('message', (data) => {
      if (!isCurrentSocket()) return;
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        console.warn(`⚠️ [VRCPipeline] 消息解析失败:`, e.message);
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
      console.log(`🔌 [VRCPipeline] 连接关闭 (${code}): ${reasonText || '无'}`);
      this.emit('disconnected', { code, reason });
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (!isCurrentSocket()) return;
      console.error(`❌ [VRCPipeline] 连接错误:`, err.message);
      this.emit('error', err);
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
        console.warn(`⚠️ [VRCPipeline] ping 发送失败:`, e.message);
        return;
      }
      this._pongTimeout = setTimeout(() => {
        console.warn(`⚠️ [VRCPipeline] 心跳 pong 超时，断开重连`);
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
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_DELAY * Math.pow(1.5, this.reconnectAttempts - 1),
      this._maxReconnectDelayMs
    );
    console.log(`[VRCPipeline] ${Math.round(delay / 1000)} 秒后重连... (第 ${this.reconnectAttempts} 次)`);
    this._connectTimeout = setTimeout(() => this.connect(), delay);
  }

  handleMessage(msg) {
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
          console.log(`[VRCPipeline] 未处理消息类型（仅提示一次）: ${msg.type}`);
        }
        this.emit('unknown', msg);
    }
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
      console.warn(`⚠️ [VRCPipeline] 通知解析失败:`, e.message);
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
      console.warn(`⚠️ [VRCPipeline] 响应通知解析失败:`, e.message);
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
          console.error(`⚠️ [VRCPipeline] 事件处理失败 (${event}):`, e.message);
        }
      }
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      authToken: this.authToken ? '***' : null
    };
  }
}

module.exports = VRCPipeline;