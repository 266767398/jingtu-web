/**
 * P3-92: vrc_pipeline.js 行为测试
 * 覆盖 WebSocket 连接状态机、握手超时、指数退避重连、会话被拒暂停重连、
 * 消息类型分发（通知/用户/好友/实例/系统/未知）、session err 帧处理与 token 掩码。
 * 通过 jest.mock('ws') 注入可控 FakeWebSocket，杜绝真实网络。
 */
jest.mock('ws', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.readyState = FakeWebSocket.CONNECTING;
      this._handlers = {};
      this._sent = [];
      this._pingedAt = 0;
      FakeWebSocket.instances.push(this);
    }
    on(ev, h) {
      if (!this._handlers[ev]) this._handlers[ev] = [];
      this._handlers[ev].push(h);
    }
    emit(ev, ...args) {
      for (const h of this._handlers[ev] || []) h(...args);
    }
    send(data) {
      this._sent.push(data.toString());
    }
    ping() {
      this._pingedAt = Date.now();
    }
    pong() {
      this._pongedAt = Date.now();
    }
    terminate() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', 1006, Buffer.from(''));
    }
    close(code, reason) {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', code, reason);
    }
  }
  FakeWebSocket.instances = [];
  return FakeWebSocket;
});

const VRCPipeline = require('../vrc_pipeline');
const FakeWebSocket = require('ws');

describe('P3-92 VRCPipeline 连接状态机', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('无 authToken 时不创建连接', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new VRCPipeline();
    p.connect();
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('connect 创建 WebSocket：URL 含 encodeURIComponent 的 authToken 与 UA/Origin 头', () => {
    const p = new VRCPipeline();
    p.setAuthToken('authcookie_abc123');
    p.connect();
    expect(FakeWebSocket.instances.length).toBe(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain(encodeURIComponent('authcookie_abc123'));
    expect(ws.opts.headers['User-Agent']).toBeTruthy();
    expect(ws.opts.headers.Origin).toBe('https://vrchat.com');
  });

  test('open 事件：isConnected=true、重连计数清零、emit connected、启动心跳', () => {
    const p = new VRCPipeline();
    const connected = jest.fn();
    const disconnected = jest.fn();
    p.on('connected', connected);
    p.on('disconnected', disconnected);
    p.setAuthToken('tok');
    p.connect();
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    expect(p.isConnected).toBe(true);
    expect(p.reconnectAttempts).toBe(0);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(disconnected).not.toHaveBeenCalled();
    // 心跳 interval 已存在
    expect(p._pingInterval).not.toBeNull();
  });

  test('握手超时（connectTimeoutMs 未 open）→ 主动 terminate 并调度重连', () => {
    const p = new VRCPipeline();
    p.setAuthToken('tok');
    p.connect();
    const ws = FakeWebSocket.instances[0];
    const spy = jest.spyOn(ws, 'terminate');
    jest.advanceTimersByTime(15000);
    expect(spy).toHaveBeenCalled();
    // terminate 触发 close → close 处理器再次 _scheduleReconnect（attempt=2 → delay=7500）
    jest.advanceTimersByTime(7500);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  test('close(1006) 触发 disconnected 与指数退避重连（首轮 5s）', () => {
    const p = new VRCPipeline();
    const disconnected = jest.fn();
    p.on('disconnected', disconnected);
    p.setAuthToken('tok');
    p.connect();
    FakeWebSocket.instances[0].emit('open');
    expect(p.reconnectAttempts).toBe(0);

    FakeWebSocket.instances[0].emit('close', 1006, Buffer.from('boom'));
    expect(p.isConnected).toBe(false);
    expect(disconnected).toHaveBeenCalledWith({ code: 1006, reason: Buffer.from('boom') });
    expect(p.reconnectAttempts).toBe(1);
    jest.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(p.isConnected).toBe(false);
  });

  test('error 事件后主动 terminate 保证 close 触发重连', () => {
    const p = new VRCPipeline();
    const err = jest.fn();
    p.on('error', err);
    p.setAuthToken('tok');
    p.connect();
    const ws = FakeWebSocket.instances[0];
    const spy = jest.spyOn(ws, 'terminate');
    ws.emit('error', new Error('ECONNREFUSED'));
    expect(err).toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });

  test('会话被拒（err 帧）后暂停重连：close 不再创建新连接', () => {
    const p = new VRCPipeline();
    p.setAuthToken('tok');
    p.connect();
    FakeWebSocket.instances[0].emit('open');
    FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ err: "authToken doesn't correspond with an active session", ip: '1.2.3.4' })));
    expect(p._sessionRejected).toBe(true);
    expect(p._lastSessionError.err).toContain("authToken");
    expect(p._lastSessionError.ip).toBe('1.2.3.4');
    expect(p._lastSessionError.authToken).toContain('***');

    FakeWebSocket.instances[0].emit('close', 1006, Buffer.from(''));
    jest.advanceTimersByTime(60000);
    // 暂停重连：不产生新 socket
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(p.getStatus().sessionRejected).toBe(true);
  });

  test('setAuthToken 新 cookie 解除会话被拒暂停并触发重连', () => {
    const p = new VRCPipeline();
    p.setAuthToken('old');
    p.connect();
    FakeWebSocket.instances[0].emit('open');
    expect(p.isConnected).toBe(true);
    // 收到 err 帧进入暂停
    FakeWebSocket.instances[0].emit('message', Buffer.from(JSON.stringify({ err: 'denied' })));
    expect(p._sessionRejected).toBe(true);
    // 注入新 token：断开旧连接并立即重连
    p.setAuthToken('new-token');
    expect(p._sessionRejected).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1].url).toContain(encodeURIComponent('new-token'));
  });
});

describe('P3-92 消息类型分发与 handleNotification', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('handleMessage 分发 user/friend/instance/system 事件', () => {
    const p = new VRCPipeline();
    const user = jest.fn();
    const friend = jest.fn();
    const instance = jest.fn();
    const system = jest.fn();
    p.on('user', user);
    p.on('friend', friend);
    p.on('instance', instance);
    p.on('system', system);

    p.handleMessage({ type: 'user-online', id: 'usr_a' });
    p.handleMessage({ type: 'friend-online', id: 'usr_b' });
    p.handleMessage({ type: 'instance', worldId: 'wrld_x' });
    p.handleMessage({ type: 'system', message: 'hello' });

    expect(user).toHaveBeenCalledTimes(1);
    expect(friend).toHaveBeenCalledTimes(1);
    expect(instance).toHaveBeenCalledTimes(1);
    expect(system).toHaveBeenCalledTimes(1);
  });

  test('未知消息类型仅提示一次且 emit unknown', () => {
    const p = new VRCPipeline();
    const unknown = jest.fn();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    p.on('unknown', unknown);
    p.handleMessage({ type: 'mystery' });
    p.handleMessage({ type: 'mystery' });
    expect(unknown).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(1); // 去重提示
    p.handleMessage({ type: 'another-mystery' });
    expect(logSpy).toHaveBeenCalledTimes(2);
    logSpy.mockRestore();
  });

  test('handleNotification：content 为 JSON 字符串时解析并分发子事件', () => {
    const p = new VRCPipeline();
    const notif = jest.fn();
    const announcement = jest.fn();
    const invite = jest.fn();
    const friendRequest = jest.fn();
    p.on('notification', notif);
    p.on('group_announcement', announcement);
    p.on('invite', invite);
    p.on('friend_request', friendRequest);

    p.handleNotification({ type: 'notification-v2', content: JSON.stringify({ id: 'n1', type: 'group.announcement', title: '公告', message: '正文', senderUsername: 'alice' }) });
    expect(notif).toHaveBeenCalledTimes(1);
    expect(notif.mock.calls[0][0].id).toBe('n1');
    expect(announcement).toHaveBeenCalledTimes(1);

    p.handleNotification({ type: 'notification', content: JSON.stringify({ id: 'n2', type: 'invite', senderUserId: 'usr_1' }) });
    expect(invite).toHaveBeenCalledTimes(1);

    p.handleNotification({ type: 'notification', content: JSON.stringify({ id: 'n3', type: 'friendRequest', senderUserId: 'usr_2' }) });
    expect(friendRequest).toHaveBeenCalledTimes(1);
  });

  test('handleNotification：content 对象直传；解析失败不抛错', () => {
    const p = new VRCPipeline();
    const notif = jest.fn();
    p.on('notification', notif);
    p.handleNotification({ type: 'notification', content: { id: 'n4', type: 'message' } });
    expect(notif.mock.calls[0][0].id).toBe('n4');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => p.handleNotification({ type: 'notification', content: '{broken json' })).not.toThrow();
    warnSpy.mockRestore();
  });

  test('handleResponseNotification 解析并 emit response_notification', () => {
    const p = new VRCPipeline();
    const fn = jest.fn();
    p.on('response_notification', fn);
    p.handleResponseNotification({ content: '{"accepted":true}' });
    expect(fn).toHaveBeenCalledWith({ accepted: true });
  });

  test('see/hide/clear-notification 与 notification-v2 content JSON 串走 handleNotification 分发', () => {
    const p = new VRCPipeline();
    const notif = jest.fn();
    p.on('notification', notif);
    p.handleMessage({ type: 'see-notification', id: 'x' });
    expect(notif).toHaveBeenCalled();
  });

  test('_maskToken 掩码规则', () => {
    const p = new VRCPipeline();
    expect(p._maskToken(null)).toBe('***');
    expect(p._maskToken('short')).toBe('***');
    expect(p._maskToken('authcookie_1234567890abc')).toBe('auth***0abc');
  });

  test('emit 捕获 handler 异常不中断其他 handler', () => {
    const p = new VRCPipeline();
    const a = jest.fn(() => { throw new Error('boom'); });
    const b = jest.fn();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    p.on('connected', a);
    p.on('connected', b);
    p.emit('connected', {});
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('getStatus 暴露会话状态且 authToken 掩码', () => {
    const p = new VRCPipeline();
    p.setAuthToken('secret-token-123456');
    const st = p.getStatus();
    expect(st.authToken).toBe('***');
    expect(st.isConnected).toBe(false);
    expect(st.reconnectAttempts).toBe(0);
    expect(st.sessionErrorCount).toBe(0);
    expect(st.sessionRejected).toBe(false);
  });
});