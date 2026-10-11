// ==================== RTC 实时通话模块（M2 拆分自 chat.js） ====================
// 原 chat.js L1410-2599 整体抽出；信令仍复用现有 WS（rtc:* 前缀由 main.js 转发到
// handleChatMessage → handleRtcMessage）；媒体走 HTTP multipart（apiForm）。
// 依赖 chat.js 的全局词法状态：chatActiveUserId / chatActiveGroupId（顶层 let，跨脚本共享）；
// getChatUserName（chat.js 保留，window 函数）。本文件由 loader.js 随 chat Tab 同批加载。

// ==================== RTC 实时通话状态 ====================
let rtcIceServers = null;              // 缓存 /api/chat/rtc/config 下发的 iceServers
let rtcTurnConfigured = false;
let rtcPrivate = null;                 // 私聊 1v1：{ status, peerId, roomId, callType, localStream, screenStream, pc, isCaller, timer, screenSharing }
let rtcGroupRoom = null;               // 群语音房：{ groupId, roomKey, members:[], peerMap:{userId→pc}, localStream, screenStream, screenSharing }
let rtcPttRecorder = null;             // 按住说话 MediaRecorder
let rtcPttChunks = [];
let rtcPttTimer = 0;
let rtcPttStartedAt = 0;
let rtcAudioCtx = null;                // 音效 AudioContext（懒加载、用户手势解锁）
let rtcRingTimer = 0;                  // 来电铃声循环定时器
const rtcVolumeWatchers = new Map();   // 音量监视器：key -> stop()
let rtcRemoteStream = null;            // 当前通话已挂载的远端流（重建浮层时用于重挂音量监视）

// ==================== RTC 实时通话模块 ====================
// 信令全部复用现有 WS（'rtc:' 前缀由 main.js 转发到 handleChatMessage）；
// 媒体（按住说话录音）走 HTTP multipart（apiForm），WS 不承载二进制。
// 契约对应 server/ws_service.js handleRtcSignal：
//   私聊：rtc:invite|cancel|accept|decline|offer|answer|candidate|hangup（带 targetId）
//   响应：rtc:invite / rtc:accepted / rtc:declined / rtc:canceled / rtc:offer|answer|candidate(sdp/candidate)
//         / rtc:hangup / rtc:invite:failed / rtc:error
//   群语音房（mesh）：rtc:group:join|leave|hangup（带 groupId）、rtc:group:offer|answer|candidate（带 groupId+targetId）
//   响应：rtc:group:joined(members) / rtc:group:member:join(member) / rtc:group:member:leave(userId)
//         / rtc:group:left / rtc:group:error；群 offer/answer/candidate 携带 senderId/targetId/roomKey
function rtcSend(payload) {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

async function ensureRtcIce() {
  if (rtcIceServers) return rtcIceServers;
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    const res = await api('/api/chat/rtc/config', { method: 'GET' });
    if (!res.ok) throw new Error('rtc config failed');
    const d = await res.json();
    rtcIceServers = (d.iceServers && d.iceServers.length) ? d.iceServers : fallback;
    rtcTurnConfigured = !!d.turnConfigured;
  } catch (e) {
    rtcIceServers = fallback;
  }
  return rtcIceServers;
}

function rtcFmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ---- WebAudio 提示音（合成音效，无需音频素材） ----
function rtcEnsureAudio() {
  if (!rtcAudioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) rtcAudioCtx = new AC();
  }
  if (rtcAudioCtx && rtcAudioCtx.state === 'suspended') rtcAudioCtx.resume();
  return rtcAudioCtx;
}

function rtcTone(freq, durSec, type, gain, delaySec) {
  const ctx = rtcEnsureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + (delaySec || 0);
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (durSec || 0.2));
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (durSec || 0.2) + 0.05);
  } catch (e) {}
}

function rtcPlayRing() {
  rtcStopRing();
  rtcTone(880, 0.16, 'sine', 0.09, 0);
  rtcTone(880, 0.16, 'sine', 0.09, 0.28);
  rtcRingTimer = setInterval(() => {
    rtcTone(880, 0.16, 'sine', 0.09, 0);
    rtcTone(880, 0.16, 'sine', 0.09, 0.28);
  }, 700);
}

function rtcStopRing() {
  if (rtcRingTimer) { clearInterval(rtcRingTimer); rtcRingTimer = 0; }
}

function rtcPlayConnected() { rtcTone(660, 0.12, 'sine', 0.1, 0); rtcTone(880, 0.16, 'sine', 0.1, 0.12); }
function rtcPlayHangup() { rtcTone(440, 0.16, 'sine', 0.09, 0); rtcTone(330, 0.22, 'sine', 0.09, 0.16); }
function rtcPlayPttStart() { rtcTone(720, 0.05, 'square', 0.05, 0); }
function rtcPlayPttStop() { rtcTone(480, 0.05, 'square', 0.05, 0); }

// ---- 音量监视（WebAudio Analyser，不输出到扬声器） ----
function rtcWatchVolumeImpl(stream, cb) {
  if (!stream || !stream.getAudioTracks().length) return null;
  const ctx = rtcEnsureAudio();
  if (!ctx) return null;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const ana = ctx.createAnalyser();
    ana.fftSize = 256;
    ana.smoothingTimeConstant = 0.5;
    src.connect(ana);
    const buf = new Uint8Array(ana.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      ana.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      try { cb(sum / buf.length / 255); } catch (e) {}
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      try { src.disconnect(); ana.disconnect(); } catch (e) {}
    };
  } catch (e) { return null; }
}

function rtcSetVolumeWatch(key, stream, cb) {
  rtcStopVolumeWatch(key);
  if (stream && stream.getAudioTracks().length) {
    const stop = rtcWatchVolumeImpl(stream, cb);
    if (stop) rtcVolumeWatchers.set(key, stop);
  }
}

function rtcStopVolumeWatch(key) {
  const stop = rtcVolumeWatchers.get(key);
  if (stop) { stop(); rtcVolumeWatchers.delete(key); }
}

function rtcStopVolumesByPrefix(prefix) {
  rtcVolumeWatchers.forEach((stop, key) => {
    if (key.indexOf(prefix) === 0) {
      try { stop(); } catch (e) {}
      rtcVolumeWatchers.delete(key);
    }
  });
}

// level 0~1 → 宽度百分比（UI 更新）
function rtcSetLevel(id, level) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.max(2, Math.min(100, Math.round(level * 100))) + '%';
}

function rtcStopStream(stream) {
  if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
}

// 麦克风采集统一开启回音消除/降噪/自动增益（防回音第一层防线）。
// 仅 audio:true 时 Safari 等浏览器不保证启用 AEC，扬声器外放声会被再次采集形成回音环路。
const RTC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function rtcClosePeer(pc) {
  if (!pc) return;
  try {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.onnegotiationneeded = null;
    pc.close();
  } catch (e) {}
}

// 构造 RTCPeerConnection，并挂上通用的 ICE/轨道/连接状态回调（私聊与群聊共用骨架）
function rtcBuildPeer(handlers) {
  const pc = new RTCPeerConnection({ iceServers: rtcIceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.onicecandidate = (e) => { if (e.candidate && handlers.onIce) handlers.onIce(pc, e.candidate.toJSON()); };
  pc.ontrack = (e) => { if (handlers.onTrack) handlers.onTrack(pc, e); };
  pc.onconnectionstatechange = () => { if (handlers.onState) handlers.onState(pc); };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected' && handlers.onDisconnected) handlers.onDisconnected(pc);
  };
  return pc;
}

// 远端连通性探测失败（ICE disconnected）时保守提示，避免完全静默
function rtcWarnBrokenCall() {
  toast(__('rtc.disconnected'), 'error');
}

// ==================== 私聊 1v1 通话 ====================
function rtcIsUserOnline(userId) {
  return !!(window.onlineUsersList || []).some(u => String(u.userId) === String(userId));
}

async function startPrivateCall(userId, callType) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (String(userId) === String(currentUser.id)) { toast(__('chat.cant_self'), 'info'); return; }
  if (rtcPrivate && rtcPrivate.status !== 'idle') { toast(__('rtc.busy'), 'error'); return; }
  if (rtcGroupRoom) { toast(__('rtc.busy'), 'error'); return; }
  if (!rtcIsUserOnline(userId)) { toast(__('rtc.offline'), 'error'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: callType === 'video' });
  } catch (e) {
    toast(__('rtc.media_error'), 'error');
    return;
  }
  await ensureRtcIce();
  rtcPrivate = {
    status: 'outgoing', peerId: userId, roomId: null, callType: callType === 'video' ? 'video' : 'voice',
    localStream: stream, screenStream: null, pc: null, isCaller: true, timer: 0, screenSharing: false, screenAudioSender: null
  };
  if (!rtcSend({ type: 'rtc:invite', targetId: userId, callType: rtcPrivate.callType })) {
    rtcClearPrivate();
    toast(__('rtc.ws_down'), 'error');
    return;
  }
  renderPrivateCallOverlay();
  startPrivateCallTimer(0);
}

function acceptPrivateCall() {
  const inv = rtcPrivate;
  if (!inv || inv.status !== 'ringing') return;
  (async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: inv.callType === 'video' });
    } catch (e) {
      toast(__('rtc.media_error'), 'error');
      hangupPrivateCall();
      return;
    }
    inv.localStream = stream;
    inv.status = 'active';
    rtcPlayConnected();
    rtcSend({ type: 'rtc:accept', targetId: inv.peerId });
    inv.pc = rtcBuildPeer({
      onIce: (pc, c) => rtcSend({ type: 'rtc:candidate', targetId: inv.peerId, candidate: c }),
      onTrack: (pc, e) => rtcAttachRemoteStream(pc, e),
      onState: () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') hangupPrivateCall(true); },
      onDisconnected: () => rtcWarnBrokenCall()
    });
    inv.localStream.getTracks().forEach(t => inv.pc.addTrack(t, inv.localStream));
    hideRtcIncomingPopup();
    renderPrivateCallOverlay();
    startPrivateCallTimer(0);
  })();
}

function declinePrivateCall() {
  const inv = rtcPrivate;
  if (!inv || inv.status !== 'ringing') return;
  rtcSend({ type: 'rtc:decline', targetId: inv.peerId });
  hideRtcIncomingPopup();
  rtcClearPrivate();
}

function hangupPrivateCall(remote = false) {
  const inv = rtcPrivate;
  if (!inv) return;
  rtcPlayHangup();
  if (inv.status === 'active' || inv.status === 'outgoing' || inv.status === 'ringing') {
    rtcSend({ type: 'rtc:hangup', targetId: inv.peerId });
  }
  if (!remote && inv.status === 'ringing') {
    // 挂断母版的未接来电也通知对方取消
    rtcSend({ type: 'rtc:cancel', targetId: inv.peerId });
  }
  hideRtcIncomingPopup();
  hideRtcCallOverlay();
  rtcClearPrivate();
}

function rtcClearPrivate() {
  rtcStopRing();
  rtcStopVolumesByPrefix('private:');
  rtcRemoteStream = null;
  if (rtcPrivate) {
    rtcStopStream(rtcPrivate.screenStream);
    rtcStopStream(rtcPrivate.localStream);
    rtcClosePeer(rtcPrivate.pc);
  }
  stopPrivateCallTimer();
  hideRtcIncomingPopup();
  hideRtcCallOverlay();
  rtcPrivate = null;
}

// 桌面音频轨输出路由：未挂到任何 audio/video 元素的远程轨永远无声
// （即便 track.enabled=true 也听不到），必须挂到音频元素上"共享声音"开关才有实际作用。
function routeScreenAudioTrack(elId, track) {
  const el = document.getElementById(elId);
  if (!el) return;
  let ms = el.srcObject;
  if (!(ms instanceof MediaStream)) { ms = new MediaStream(); el.srcObject = ms; }
  // 清理已结束的旧轨（停止共享后重新共享会追加新轨，避免流内轨无限堆积）
  ms.getTracks().forEach(t => { if (t.readyState === 'ended') { try { ms.removeTrack(t); } catch (e) {} } });
  if (!ms.getTracks().includes(track)) ms.addTrack(track);
}

function rtcAttachRemoteStream(pc, e) {
  if (!e || !e.track || !e.streams || !e.streams[0]) return;
  const stream = e.streams[0];
  const inv = rtcPrivate;
  // 识别对端屏幕共享的"桌面音频轨"（音频轨 + 流 id 与 offer 声明的屏幕流一致）：
  // 该轨默认静音——若本机扬声器外放后再被麦克风采集会形成回音环路（防回音核心）。
  if (inv && e.track.kind === 'audio' && inv.screenStreamId && stream.id === inv.screenStreamId) {
    inv.screenAudioTracks = inv.screenAudioTracks || [];
    if (!inv.screenAudioTracks.includes(e.track)) inv.screenAudioTracks.push(e.track);
    routeScreenAudioTrack('rtcScreenAudioOut', e.track); // 挂输出 sink，"共享声音"开关才可听
    e.track.enabled = !!inv.screenAudioEnabled;
    updateScreenAudioBtn();
    return; // 桌面音频不参与远程视频显示与音量监测
  }
  rtcRemoteStream = stream;
  const el = document.getElementById('rtcRemoteVideo');
  if (el) {
    el.srcObject = stream;
    el.classList.toggle('rtc-hidden', !rtcPrivate || rtcPrivate.callType !== 'video');
  }
  rtcSetVolumeWatch('private:remote', stream, (lv) => rtcSetLevel('rtcRemoteLevel', lv));
}

// 私聊通话浮层（绝对定位盖在聊天面板上）
function renderPrivateCallOverlay() {
  const panel = document.getElementById('chatDetailView');
  if (!panel) return;
  hideRtcCallOverlay(); // 先移除旧浮层再重建，避免重复元素
  const inv = rtcPrivate;
  if (!inv) return;
  const name = getChatUserName(inv.peerId);
  const isVideo = inv.callType === 'video';
  const stateText = inv.status === 'outgoing' ? __('rtc.calling') : (inv.status === 'active' ? __('rtc.in_call') : __('rtc.waiting_accept'));
  const div = document.createElement('div');
  div.id = 'rtcCallOverlay';
  div.className = 'rtc-call-overlay';
  div.innerHTML = `
    <div class="rtc-call-box">
      <div class="rtc-call-remote ${isVideo ? '' : 'rtc-voice-mode'}">
        <video id="rtcRemoteVideo" autoplay playsinline></video>
        <div class="rtc-call-audio-indicator">🎧 ${esc(__('rtc.voice_call'))}</div>
      </div>
      <div class="rtc-call-info">
        <strong>${esc(name)}</strong>
        <span id="rtcCallState" class="text-muted2 text-13">${esc(stateText)}</span>
        <span id="rtcCallTimer" class="text-muted2 text-13">${rtcFmtTime(0)}</span>
      </div>
      <div class="rtc-call-levels">
        <div class="rtc-level-row" title="${esc(__('rtc.remote_level'))}"><i>⬇</i><span class="rtc-level-track"><span id="rtcRemoteLevel" class="rtc-level-fill"></span></span></div>
        <div class="rtc-level-row" title="${esc(__('rtc.mic_level'))}"><i>⬆</i><span class="rtc-level-track"><span id="rtcLocalLevel" class="rtc-level-fill"></span></span></div>
      </div>
      <div class="rtc-call-local">
        <video id="rtcLocalVideo" autoplay muted playsinline></video>
      </div>
      <div class="rtc-call-actions">
        ${isVideo ? `<button id="rtcCamBtn" class="btn btn-xs btn-outline" data-action="rtc-toggle-cam">🎥 ${esc(__('rtc.toggle_camera'))}</button>` : ''}
        <button id="rtcScreenBtn" class="btn btn-xs btn-outline" data-action="rtc-toggle-screen">🖥 ${esc(__('rtc.share_screen'))}</button>
        <button id="rtcScreenAudioBtn" class="btn btn-xs btn-outline rtc-hidden" data-action="rtc-toggle-screen-audio">🔇 ${esc(__('rtc.screen_audio'))}</button>
        <button id="rtcHangupBtn" class="btn btn-xs btn-danger" data-action="rtc-hangup">📵 ${esc(__('rtc.hangup'))}</button>
      </div>
      <audio id="rtcScreenAudioOut" autoplay playsinline class="rtc-hidden"></audio>
    </div>`;
  panel.appendChild(div);
  const localVideo = document.getElementById('rtcLocalVideo');
  if (localVideo && inv.localStream) localVideo.srcObject = inv.localStream;
  if (inv.localStream && !isVideo) {
    // 语音通话只取音频：不展示本地视频画面
    localVideo?.classList.add('rtc-hidden');
  }
  rtcSetVolumeWatch('private:local', inv.localStream, (lv) => rtcSetLevel('rtcLocalLevel', lv));
  if (rtcRemoteStream) rtcSetVolumeWatch('private:remote', rtcRemoteStream, (lv) => rtcSetLevel('rtcRemoteLevel', lv));
  // 浮层重建后 srcObject 随元素销毁丢失，需恢复桌面音频轨到输出元素
  if (inv.screenAudioTracks && inv.screenAudioTracks.length) {
    inv.screenAudioTracks.forEach(t => { try { routeScreenAudioTrack('rtcScreenAudioOut', t); } catch (e) {} });
  }
  updateScreenAudioBtn();
}

function hideRtcCallOverlay() {
  const el = document.getElementById('rtcCallOverlay');
  if (el) el.remove();
}

function updateRtcCallState() {
  const inv = rtcPrivate;
  if (!inv) return;
  const stateEl = document.getElementById('rtcCallState');
  const timerEl = document.getElementById('rtcCallTimer');
  if (stateEl) stateEl.textContent = inv.status === 'active' ? __('rtc.in_call') : (inv.status === 'outgoing' ? __('rtc.calling') : __('rtc.waiting_accept'));
  if (timerEl) timerEl.textContent = rtcFmtTime(inv.timer);
}

function startPrivateCallTimer(sec) {
  stopPrivateCallTimer();
  const inv = rtcPrivate;
  if (!inv) return;
  inv.timer = sec || 0;
  updateRtcCallState();
  inv.timerId = setInterval(() => {
    if (!rtcPrivate) { stopPrivateCallTimer(); return; }
    rtcPrivate.timer++;
    updateRtcCallState();
  }, 1000);
}

function stopPrivateCallTimer() {
  if (rtcPrivate && rtcPrivate.timerId) { clearInterval(rtcPrivate.timerId); rtcPrivate.timerId = null; }
}

// ==================== 来电弹窗 ====================
function renderRtcIncomingPopup(msg) {
  const panel = document.getElementById('chatDetailView');
  if (!panel) return;
  hideRtcIncomingPopup();
  const name = (msg.caller && msg.caller.displayName) || getChatUserName(msg.senderId);
  const avatar = (msg.caller && msg.caller.avatarUrl) ? escAttr(msg.caller.avatarUrl) : '/api/avatar/default';
  const isVideo = msg.callType === 'video';
  const div = document.createElement('div');
  div.id = 'rtcIncomingPopup';
  div.className = 'rtc-incoming-popup';
  div.innerHTML = `
    <img src="${avatar}" class="chat-conv-avatar" data-avatar-fail-src="${escAttr((msg.caller && msg.caller.avatarUrl) || '/api/avatar/default')}" />
    <div class="rtc-incoming-info">
      <strong>${esc(name)}</strong>
      <span class="text-muted2 text-13">${isVideo ? '📹 ' : '📞 '}${esc(__('rtc.incoming'))}</span>
    </div>
    <div class="rtc-incoming-actions">
      <button class="btn btn-xs btn-danger" data-action="rtc-decline">✕ ${esc(__('rtc.decline'))}</button>
      <button class="btn btn-xs btn-primary" data-action="rtc-accept">✓ ${esc(__('rtc.accept'))}</button>
    </div>`;
  panel.appendChild(div);
  rtcPlayRing();
}

function hideRtcIncomingPopup() {
  rtcStopRing();
  const el = document.getElementById('rtcIncomingPopup');
  if (el) el.remove();
}

// ==================== 屏幕共享 ====================
// 请求 video+audio：浏览器选择器勾选「分享音频」后回传系统/标签页音频轨（macOS 需 Chrome 141+，
// Linux/Firefox/Safari 不支持系统音频时 aTrack 为 null，仅画面正常共享）
async function rtcToggleScreenShare() {
  const inv = rtcPrivate;
  if (!inv || inv.status !== 'active' || !inv.pc) return;
  if (inv.screenSharing) { rtcStopScreenShare(); return; }
  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { return; } // 用户取消共享
  const vTrack = screenStream.getVideoTracks()[0];
  if (!vTrack) { rtcStopStream(screenStream); return; }
  const aTrack = screenStream.getAudioTracks()[0] || null;
  if (aTrack) toast(__('rtc.screen_audio_tip'), 'info'); // 佩戴耳机可避免共享者本机回音
  vTrack.addEventListener('ended', () => { rtcStopScreenShare(); });
  inv.screenStream = screenStream;
  inv.screenSharing = true;
  const localVideo = document.getElementById('rtcLocalVideo');
  if (localVideo) { localVideo.srcObject = screenStream; localVideo.classList.remove('rtc-hidden'); }
  const pc = inv.pc;
  try {
    const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (vSender) {
      await vSender.replaceTrack(vTrack);
    } else {
      pc.addTrack(vTrack, inv.localStream);
    }
    // 屏幕音频轨（与麦克风并存），保存 sender 引用供停止共享时移除
    if (aTrack) inv.screenAudioSender = pc.addTrack(aTrack, screenStream);
    await pc.createOffer();
    await pc.setLocalDescription();
    // screenStreamId 供对端识别"桌面音频轨"：该轨默认静音防回音（对端外放后再被其麦克风采集会成环）
    rtcSend({ type: 'rtc:offer', targetId: inv.peerId, sdp: pc.localDescription, screenShare: !!(aTrack), screenStreamId: aTrack ? screenStream.id : null });
  } catch (e) {}
}

async function rtcStopScreenShare() {
  const inv = rtcPrivate;
  if (!inv) return;
  if (inv.screenStream) {
    inv.screenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    inv.screenStream = null;
  }
  inv.screenSharing = false;
  const localVideo = document.getElementById('rtcLocalVideo');
  if (localVideo && inv.localStream) {
    localVideo.srcObject = inv.localStream;
    if (inv.callType !== 'video') localVideo.classList.add('rtc-hidden');
  }
  const pc = inv.pc;
  if (!pc) return;
  try {
    if (inv.callType === 'video') {
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      const camTrack = (inv.localStream.getTracks().find(t => t.kind === 'video')) || null;
      if (vSender && camTrack) await vSender.replaceTrack(camTrack);
    } else {
      // 语音通话时共享屏幕是后加的 track，停止后移除并重协商
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vSender) pc.removeTrack(vSender);
    }
    // 移除屏幕音频轨并重协商
    if (inv.screenAudioSender) {
      try { pc.removeTrack(inv.screenAudioSender); } catch (e) {}
      inv.screenAudioSender = null;
    }
    await pc.createOffer();
    await pc.setLocalDescription();
    // 停止共享：通知对端清除屏幕音频静音标记
    rtcSend({ type: 'rtc:offer', targetId: inv.peerId, sdp: pc.localDescription, screenShare: false, screenStreamId: null });
  } catch (e) {}
}

// 私聊"共享声音"开关：控制是否外放对端的桌面音频（默认静音防回音）
function rtcToggleScreenAudio() {
  const inv = rtcPrivate;
  if (!inv || !inv.screenStreamId) { toast(__('rtc.share_screen_first'), 'info'); return; }
  inv.screenAudioEnabled = !inv.screenAudioEnabled;
  (inv.screenAudioTracks || []).forEach(t => { try { t.enabled = inv.screenAudioEnabled; } catch (e) {} });
  updateScreenAudioBtn();
}
function updateScreenAudioBtn() {
  const btn = document.getElementById('rtcScreenAudioBtn');
  if (!btn) return;
  const inv = rtcPrivate;
  const active = !!(inv && inv.screenStreamId);
  const on = !!(inv && inv.screenStreamId && inv.screenAudioEnabled);
  btn.classList.toggle('rtc-hidden', !active);
  btn.classList.toggle('btn-danger', on);
  btn.innerHTML = on ? `🔊 ${esc(__('rtc.screen_audio_on'))}` : `🔇 ${esc(__('rtc.screen_audio'))}`;
}

function rtcToggleCamera() {
  const inv = rtcPrivate;
  if (!inv || !inv.localStream || inv.callType !== 'video') return;
  const vTrack = inv.localStream.getTracks().find(t => t.kind === 'video');
  if (vTrack) vTrack.enabled = !vTrack.enabled;
}

// ==================== 群语音房（mesh） ====================
async function toggleGroupVoiceRoom(groupId) {
  if (rtcGroupRoom && rtcGroupRoom.groupId === groupId) {
    leaveGroupVoiceRoom(groupId);
  } else {
    joinGroupVoiceRoom(groupId);
  }
}

async function joinGroupVoiceRoom(groupId) {
  const gid = parseInt(groupId, 10);
  if (!gid) return;
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (rtcGroupRoom && rtcGroupRoom.groupId === gid) return;
  if (rtcGroupRoom) { toast(__('rtc.in_another_room'), 'error'); return; }
  if (rtcPrivate && rtcPrivate.status !== 'idle') { toast(__('rtc.busy'), 'error'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: false });
  } catch (e) {
    toast(__('rtc.media_error'), 'error');
    return;
  }
  await ensureRtcIce();
  rtcGroupRoom = { groupId: gid, roomKey: null, members: [], peerMap: {}, localStream: stream, screenStream: null, screenSharing: false, screenAudioSenders: {}, timer: 0, timerId: null };
  if (!rtcSend({ type: 'rtc:group:join', groupId: gid })) {
    leaveGroupVoiceRoom(gid);
    toast(__('rtc.ws_down'), 'error');
    return;
  }
  renderGroupVoiceBar();
}

function leaveGroupVoiceRoom(groupId) {
  const room = rtcGroupRoom;
  if (!room) return;
  if (!groupId || room.groupId === groupId) {
    rtcSend({ type: 'rtc:group:leave', groupId: room.groupId });
    rtcClearGroupRoom();
  }
}

function rtcClearGroupRoom() {
  const room = rtcGroupRoom;
  if (!room) return;
  stopGroupVoiceTimer();
  rtcStopVolumesByPrefix('group:');
  rtcStopStream(room.screenStream);
  rtcStopStream(room.localStream);
  Object.keys(room.peerMap || {}).forEach((uid) => rtcClosePeer(room.peerMap[uid]));
  room.peerMap = {};
  rtcGroupRoom = null;
  hideGroupVoiceBar();
  updateGroupVoiceBtn();
}

// mesh 确定性 offerer：userId 较小的一方发 offer，避免双方同时发 offer 造成 glare
function rtcGroupCreatePeer(remoteUserId) {
  const room = rtcGroupRoom;
  if (!room) return null;
  const uid = parseInt(remoteUserId, 10);
  if (room.peerMap[uid]) return room.peerMap[uid];
  const pc = rtcBuildPeer({
    onIce: (pc, c) => rtcSend({ type: 'rtc:group:candidate', groupId: room.groupId, targetId: uid, candidate: c }),
    onTrack: (pc, e) => rtcGroupAttachRemoteStream(uid, pc, e),
    onState: () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        rtcClosePeer(pc);
        if (room.peerMap[uid] === pc) delete room.peerMap[uid];
        renderGroupMemberList();
      }
    },
    onDisconnected: () => rtcWarnBrokenCall()
  });
  room.peerMap[uid] = pc;
  room.localStream.getTracks().forEach(t => pc.addTrack(t, room.localStream));
  // 本端为较小 userId → 作为 offerer 主动发起，否则等对方 offer
  if (Number(currentUser.id) < uid) {
    pc.createOffer().then(() => pc.setLocalDescription()).then(() => {
      rtcSend({ type: 'rtc:group:offer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription });
    }).catch((e) => {});
  }
  return pc;
}

// 群语音房：每位共享者对端一个独立桌面音频输出元素（随成员离开清理），
// 未挂 sink 的远程轨即便 enabled=true 也无声，必须有输出路由"共享声音"开关才可听。
function routeGroupScreenAudioTrack(uid, track) {
  const bar = document.getElementById('groupVoiceBar');
  if (!bar) return;
  let el = document.getElementById('rtcGroupScreenAudioOut_' + uid);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'rtcGroupScreenAudioOut_' + uid;
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    bar.appendChild(el);
  }
  let ms = el.srcObject;
  if (!(ms instanceof MediaStream)) { ms = new MediaStream(); el.srcObject = ms; }
  ms.getTracks().forEach(t => { if (t.readyState === 'ended') { try { ms.removeTrack(t); } catch (e) {} } });
  if (!ms.getTracks().includes(track)) ms.addTrack(track);
}

function rtcGroupAttachRemoteStream(uid, pc, e) {
  if (!e || !e.track || !e.streams || !e.streams[0]) return;
  const stream = e.streams[0];
  const room = rtcGroupRoom;
  // 识别对端屏幕共享的"桌面音频轨"：默认静音防回音（详见 rtcAttachRemoteStream 注释）
  if (room && e.track.kind === 'audio' && room.screenStreamIds && room.screenStreamIds[uid] && stream.id === room.screenStreamIds[uid]) {
    room.screenAudioTracksByUid = room.screenAudioTracksByUid || {};
    room.screenAudioTracksByUid[uid] = room.screenAudioTracksByUid[uid] || [];
    if (!room.screenAudioTracksByUid[uid].includes(e.track)) room.screenAudioTracksByUid[uid].push(e.track);
    routeGroupScreenAudioTrack(uid, e.track); // 挂输出 sink，"共享声音"开关才可听
    e.track.enabled = !!room.screenAudioEnabled;
    updateGroupScreenAudioBtn();
    return; // 桌面音频不参与成员 tile 画面与音量监测
  }
  const tile = document.getElementById('rtcGroupTile_' + uid);
  const video = tile && tile.querySelector('video');
  if (video) {
    video.srcObject = stream;
    video.classList.remove('rtc-hidden');
  }
  const barTile = document.getElementById('rtcGroupBarTile_' + uid);
  const barVideo = barTile && barTile.querySelector('video');
  if (barVideo) {
    barVideo.srcObject = stream;
    barVideo.classList.remove('rtc-hidden');
  }
  rtcSetVolumeWatch('group:' + uid, stream, (lv) => {
    rtcSetLevel('rtcTileLevel_' + uid, lv);
    const t = document.getElementById('rtcGroupBarTile_' + uid);
    if (t) t.classList.toggle('rtc-speaking', lv > 0.12);
  });
}

// 群语音房状态栏（显示成员 + 离开/共享按钮）
function renderGroupVoiceBar() {
  const view = document.getElementById('chatDetailView');
  if (!view) return;
  hideGroupVoiceBar();
  const room = rtcGroupRoom;
  if (!room) return;
  const div = document.createElement('div');
  div.id = 'groupVoiceBar';
  div.className = 'rtc-group-bar';
  div.innerHTML = `
    <div class="rtc-group-joined-label">🎤 ${esc(__('rtc.voice_room'))} <span id="rtcGroupCount">${room.members.length}</span> <span id="rtcGroupTimer" class="rtc-group-timer">${rtcFmtTime(room.timer || 0)}</span></div>
    <div id="rtcGroupMembers" class="rtc-group-members"></div>
    <div class="rtc-group-actions">
      <span class="rtc-level-row rtc-group-mic" title="${esc(__('rtc.mic_level'))}"><i>⬆</i><span class="rtc-level-track"><span id="rtcGroupMicLevel" class="rtc-level-fill"></span></span></span>
      <button id="rtcGroupScreenBtn" class="btn btn-xs btn-outline" data-action="rtc-group-toggle-screen">🖥 ${esc(__('rtc.share_screen'))}</button>
      <button id="rtcGroupScreenAudioBtn" class="btn btn-xs btn-outline rtc-hidden" data-action="rtc-group-toggle-screen-audio">🔇 ${esc(__('rtc.screen_audio'))}</button>
      <button class="btn btn-xs btn-danger" data-action="rtc-group-leave" data-gid="${room.groupId}">📵 ${esc(__('rtc.leave_room'))}</button>
    </div>`;
  const header = document.getElementById('chatDetailHeader');
  if (header && header.nextElementSibling) header.nextElementSibling.insertAdjacentElement('beforebegin', div);
  else view.insertBefore(div, view.firstChild.nextSibling);
  // 加入中（尚无成员列表）时先渲染占位
  renderGroupMemberList();
  updateGroupVoiceBtn();
  startGroupVoiceTimer();
  rtcSetVolumeWatch('group:local', room.localStream, (lv) => rtcSetLevel('rtcGroupMicLevel', lv));
  updateGroupScreenAudioBtn();
}

// 群语音房通话计时（加入即开始，离开停止）
function startGroupVoiceTimer() {
  const room = rtcGroupRoom;
  if (!room || room.timerId) return;
  room.timer = room.timer || 0;
  const el = document.getElementById('rtcGroupTimer');
  if (el) el.textContent = rtcFmtTime(room.timer);
  room.timerId = setInterval(() => {
    if (!rtcGroupRoom) { stopGroupVoiceTimer(); return; }
    rtcGroupRoom.timer++;
    const tEl = document.getElementById('rtcGroupTimer');
    if (tEl) tEl.textContent = rtcFmtTime(rtcGroupRoom.timer);
  }, 1000);
}

function stopGroupVoiceTimer() {
  if (rtcGroupRoom && rtcGroupRoom.timerId) { clearInterval(rtcGroupRoom.timerId); rtcGroupRoom.timerId = null; }
}

function hideGroupVoiceBar() {
  const el = document.getElementById('groupVoiceBar');
  if (el) el.remove();
}

function renderGroupMemberList() {
  const room = rtcGroupRoom;
  if (!room) return;
  const wrap = document.getElementById('rtcGroupMembers');
  if (!wrap) return;
  const countEl = document.getElementById('rtcGroupCount');
  if (countEl) countEl.textContent = room.members.length;
  if (room.members.length === 0) {
    wrap.innerHTML = `<span class="text-muted2 text-12">${esc(__('rtc.room_empty'))}</span>`;
    return;
  }
  wrap.innerHTML = room.members.map((m) => {
    const uid = m.userId;
    const nm = m.displayName || getChatUserName(uid);
    const av = m.avatarUrl ? escAttr(m.avatarUrl) : '/api/avatar/default';
    return `<span id="rtcGroupBarTile_${uid}" class="rtc-group-tile" title="${esc(nm)}">
      <img src="${av}" class="rtc-group-avatar" data-avatar-fail-src="${escAttr(m.avatarUrl || '/api/avatar/default')}" />
      <video class="rtc-hidden" autoplay playsinline></video>
      <span class="rtc-tile-level"><span id="rtcTileLevel_${uid}" class="rtc-tile-level-fill"></span></span>
      <em>${esc(nm)}</em>
    </span>`;
  }).join('');
}

function updateGroupVoiceBtn() {
  const gid = rtcGroupRoom ? rtcGroupRoom.groupId : null;
  document.querySelectorAll('[id^="groupVoiceBtn_"]').forEach((btn) => {
    const btnGid = parseInt(btn.id.split('_')[1], 10);
    const active = gid === btnGid;
    btn.classList.toggle('btn-danger', active);
    btn.classList.toggle('btn-outline', !active);
    btn.innerHTML = active ? `🎤 ${esc(__('rtc.leave_room'))}` : `🎤 ${esc(__('rtc.voice_room'))}`;
  });
}

async function rtcToggleGroupScreenShare() {
  const room = rtcGroupRoom;
  if (!room) return;
  if (room.screenSharing) { rtcStopGroupScreenShare(); return; }
  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { return; }
  const vTrack = screenStream.getVideoTracks()[0];
  if (!vTrack) { rtcStopStream(screenStream); return; }
  const aTrack = screenStream.getAudioTracks()[0] || null;
  if (aTrack) toast(__('rtc.screen_audio_tip'), 'info'); // 佩戴耳机可避免共享者本机回音
  vTrack.addEventListener('ended', () => { rtcStopGroupScreenShare(); });
  room.screenStream = screenStream;
  room.screenSharing = true;
  room.screenAudioSenders = room.screenAudioSenders || {}; // uid -> audio sender
  const ids = Object.keys(room.peerMap);
  for (const uid of ids) {
    const pc = room.peerMap[uid];
    if (!pc) continue;
    try {
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vSender) {
        await vSender.replaceTrack(vTrack);
      } else {
        pc.addTrack(vTrack, room.localStream);
      }
      // 屏幕音频轨（与麦克风并存），保存 sender 引用供停止共享时移除
      if (aTrack && !room.screenAudioSenders[uid]) {
        room.screenAudioSenders[uid] = pc.addTrack(aTrack, screenStream);
      }
      // 每次都对每个对端重协商：新增音轨必须协商，replaceTrack 场景多发一次 offer 无副作用
      await pc.createOffer();
      await pc.setLocalDescription();
      // screenStreamId 供对端识别"桌面音频轨"：该轨默认静音防回音（见 rtcToggleScreenShare 注释）
      rtcSend({ type: 'rtc:group:offer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription, screenShare: !!(aTrack), screenStreamId: aTrack ? screenStream.id : null });
    } catch (e) {}
  }
}

async function rtcStopGroupScreenShare() {
  const room = rtcGroupRoom;
  if (!room) return;
  if (room.screenStream) {
    room.screenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    room.screenStream = null;
  }
  room.screenSharing = false;
  const ids = Object.keys(room.peerMap);
  for (const uid of ids) {
    const pc = room.peerMap[uid];
    if (!pc) continue;
    try {
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vSender) pc.removeTrack(vSender);
      // 移除屏幕音频轨并重协商
      if (room.screenAudioSenders && room.screenAudioSenders[uid]) {
        try { pc.removeTrack(room.screenAudioSenders[uid]); } catch (e) {}
        delete room.screenAudioSenders[uid];
      }
      await pc.createOffer();
      await pc.setLocalDescription();
      // 停止共享：通知对端清除屏幕音频静音标记
      rtcSend({ type: 'rtc:group:offer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription, screenShare: false, screenStreamId: null });
    } catch (e) {}
  }
}

// 群语音房"共享声音"开关：控制是否外放各对端的桌面音频（默认静音防回音）
function rtcToggleGroupScreenAudio() {
  const room = rtcGroupRoom;
  if (!room) return;
  const anyScreen = Object.keys(room.screenStreamIds || {}).some(k => room.screenStreamIds[k]);
  if (!anyScreen) { toast(__('rtc.share_screen_first'), 'info'); return; }
  room.screenAudioEnabled = !room.screenAudioEnabled;
  Object.keys(room.screenAudioTracksByUid || {}).forEach(uid => {
    (room.screenAudioTracksByUid[uid] || []).forEach(t => { try { t.enabled = room.screenAudioEnabled; } catch (e) {} });
  });
  updateGroupScreenAudioBtn();
}
function updateGroupScreenAudioBtn() {
  const btn = document.getElementById('rtcGroupScreenAudioBtn');
  if (!btn) return;
  const room = rtcGroupRoom;
  const active = !!room && Object.keys(room.screenStreamIds || {}).some(k => room.screenStreamIds[k]);
  const on = !!(room && room.screenAudioEnabled && active);
  btn.classList.toggle('rtc-hidden', !active);
  btn.classList.toggle('btn-danger', on);
  btn.innerHTML = on ? `🔊 ${esc(__('rtc.screen_audio_on'))}` : `🔇 ${esc(__('rtc.screen_audio'))}`;
}

// ==================== 按住说话（PTT 语音消息） ====================
// 私聊：POST /api/chat/send（receiverId）；群聊：POST /api/chat/groups/{gid}/messages（msgType=audio）
async function startPttRecording() {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (rtcPttRecorder) return;
  if (!chatActiveUserId && !chatActiveGroupId) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: false });
  } catch (e) {
    toast(__('rtc.media_error'), 'error');
    return;
  }
  let mime = 'audio/webm;codecs=opus';
  if (typeof MediaRecorder !== 'function' || !MediaRecorder.isTypeSupported(mime)) {
    rtcStopStream(stream);
    toast(__('chat.audio_type_error'), 'error');
    return;
  }
  rtcPttChunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime });
  rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) rtcPttChunks.push(e.data); };
  rec.onstop = () => {
    rtcStopStream(stream);
    const blob = new Blob(rtcPttChunks, { type: mime });
    rtcPttChunks = [];
    if (blob.size < 2 * 1024) {
      toast(__('rtc.ptt_too_short'), 'info');
      return;
    }
    uploadPttBlob(blob);
  };
  rec.onerror = () => { rtcStopStream(stream); rtcPttChunks = []; toast(__('rtc.media_error'), 'error'); };
  rec.start(250);
  rtcPttRecorder = rec;
  rtcPttStartedAt = Date.now();
  rtcPlayPttStart();
  renderPttIndicator();
  rtcSetVolumeWatch('ptt', stream, (lv) => rtcSetLevel('rtcPttLevel', lv));
}

function stopPttRecording() {
  if (!rtcPttRecorder) return;
  rtcPlayPttStop();
  rtcStopVolumeWatch('ptt');
  hidePttIndicator();
  try { rtcPttRecorder.stop(); } catch (e) {}
  rtcPttRecorder = null;
}

function renderPttIndicator() {
  const panel = document.getElementById('chatPanel') || document.body;
  hidePttIndicator();
  const div = document.createElement('div');
  div.id = 'rtcPttIndicator';
  div.className = 'rtc-ptt-indicator';
  div.innerHTML = `◉ ${esc(__('rtc.recording'))} <span id="rtcPttTimerText">00:00</span> <span class="rtc-ptt-level"><span id="rtcPttLevel" class="rtc-ptt-level-fill"></span></span>`;
  panel.appendChild(div);
  rtcPttTimer = setInterval(() => {
    const el = document.getElementById('rtcPttTimerText');
    if (el) el.textContent = rtcFmtTime(Math.floor((Date.now() - rtcPttStartedAt) / 1000));
  }, 1000);
}

function hidePttIndicator() {
  const el = document.getElementById('rtcPttIndicator');
  if (el) el.remove();
  if (rtcPttTimer) { clearInterval(rtcPttTimer); rtcPttTimer = 0; }
}

async function uploadPttBlob(blob) {
  const gid = chatActiveGroupId;
  const uid = chatActiveUserId;
  if (!gid && !uid) return;
  const fd = new FormData();
  fd.append('file', blob, 'voice-' + Date.now() + '.webm');
  let url;
  if (gid) { url = `/api/chat/groups/${gid}/messages`; fd.append('msgType', 'audio'); }
  else { url = '/api/chat/send'; fd.append('receiverId', uid); }
  try {
    const res = await apiForm(url, fd);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      toast(errText(d) || __('chat.send_failed'), 'error');
      return;
    }
    const d = await res.json().catch(() => null);
    if (!d || !d.message) return;
    if (gid) appendGroupMessage(d.message);
    else appendReceivedMessage(d.message, true);
  } catch (e) {
    if (!isApiHandledError(e)) toast(__('chat.send_failed'), 'error');
  }
}

function initRtcPttButton() {
  const area = document.getElementById('chatInputArea');
  if (!area || document.getElementById('rtcPttBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'rtcPttBtn';
  btn.type = 'button';
  btn.className = 'btn btn-sm rtc-ptt-btn';
  btn.textContent = '🎙 ' + __('rtc.ptt_hold');
  btn.setAttribute('aria-pressed', 'false');
  const setPressed = (on) => btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); setPressed(true); startPttRecording(); });
  btn.addEventListener('pointerup', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('pointercancel', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('pointerleave', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      setPressed(true);
      startPttRecording();
    }
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setPressed(false);
      stopPttRecording();
    }
  });
  btn.addEventListener('blur', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  const sendBtn = document.getElementById('chatSendBtn');
  if (sendBtn && sendBtn.parentNode) sendBtn.parentNode.insertBefore(btn, sendBtn);
  else area.appendChild(btn);
}

// ==================== RTC 信令分发 ====================
function handleRtcMessage(msg) {
  const type = msg.type || '';
  // ----- 私聊 1v1 -----
  if (type === 'rtc:invite') {
    if (!msg.senderId) return;
    // 忙线：自己在通话中或已在语音房 → 自动拒绝
    if ((rtcPrivate && rtcPrivate.status !== 'idle') || rtcGroupRoom) {
      rtcSend({ type: 'rtc:decline', targetId: msg.senderId });
      toast(__('rtc.busy'), 'info');
      return;
    }
    rtcPrivate = {
      status: 'ringing', peerId: msg.senderId, roomId: msg.roomId || null,
      callType: msg.callType === 'video' ? 'video' : 'voice',
      localStream: null, screenStream: null, pc: null, isCaller: false, timer: 0, screenSharing: false, screenAudioSender: null
    };
    renderRtcIncomingPopup(msg);
    return;
  }
  if (type === 'rtc:invite:failed') {
    toast(errText(msg) || __('rtc.offline'), 'error');
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:accepted') {
    const inv = rtcPrivate;
    if (!inv || inv.status !== 'outgoing') return;
    inv.status = 'active';
    rtcPlayConnected();
    updateRtcCallState();
    renderPrivateCallOverlay();
    // 呼叫方创建 peer 并发出 offer
    inv.pc = rtcBuildPeer({
      onIce: (pc, c) => rtcSend({ type: 'rtc:candidate', targetId: inv.peerId, candidate: c }),
      onTrack: (pc, e) => rtcAttachRemoteStream(pc, e),
      onState: () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') hangupPrivateCall(true); },
      onDisconnected: () => rtcWarnBrokenCall()
    });
    inv.localStream.getTracks().forEach(t => inv.pc.addTrack(t, inv.localStream));
    inv.pc.createOffer().then(() => inv.pc.setLocalDescription()).then(() => {
      rtcSend({ type: 'rtc:offer', targetId: inv.peerId, sdp: inv.pc.localDescription });
    }).catch((e) => {});
    startPrivateCallTimer(0);
    return;
  }
  if (type === 'rtc:declined') {
    toast(__('rtc.declined'), 'info');
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:canceled') {
    hideRtcIncomingPopup();
    if (rtcPrivate && rtcPrivate.status === 'ringing') {
      toast(__('rtc.canceled'), 'info');
    }
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:offer') {
    const inv = rtcPrivate;
    if (!inv || inv.status !== 'active' || !inv.pc) return;
    if (!msg.sdp) return;
    // 记录对端屏幕共享状态：供 onTrack 识别桌面音频轨并默认静音（防回音）
    inv.screenShareActive = !!msg.screenShare;
    inv.screenStreamId = msg.screenStreamId || null;
    if (!inv.screenShareActive) {
      inv.screenAudioEnabled = false;
      inv.screenAudioTracks = [];
      updateScreenAudioBtn(); // 对端已停止共享：立即复位/隐藏"共享声音"按钮
    }
    const asyncWork = async () => {
      await inv.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await inv.pc.createAnswer();
      await inv.pc.setLocalDescription(answer);
      rtcSend({ type: 'rtc:answer', targetId: inv.peerId, sdp: inv.pc.localDescription });
    };
    asyncWork.catch(() => {});
    return;
  }
  if (type === 'rtc:answer') {
    const inv = rtcPrivate;
    if (!inv || !inv.pc || !msg.sdp) return;
    inv.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
    return;
  }
  if (type === 'rtc:candidate') {
    const inv = rtcPrivate;
    if (!inv || !inv.pc || !msg.candidate) return;
    inv.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    return;
  }
  if (type === 'rtc:hangup') {
    if (rtcPrivate && rtcPrivate.peerId === msg.senderId) {
      toast(__('rtc.remote_hangup'), 'info');
    }
    rtcPlayHangup();
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:error') {
    toast(errText(msg) || __('rtc.error'), 'error');
    if (rtcPrivate) {
      rtcPlayHangup();
      rtcClearPrivate();
    }
    return;
  }

  // ----- 群语音房 -----
  if (type === 'rtc:group:joined') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId) return;
    room.roomKey = msg.roomKey || room.roomKey;
    room.members = (msg.members || []).filter(m => m && m.userId !== currentUser.id);
    renderGroupMemberList();
    // 向现有成员逐个建连（mesh 确定性 offerer 策略在 rtcGroupCreatePeer 内实现）
    room.members.forEach(m => rtcGroupCreatePeer(m.userId));
    return;
  }
  if (type === 'rtc:group:member:join') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId) return;
    const mem = msg.member;
    if (!mem) return;
    if (!room.members.some(m => m.userId === mem.userId)) {
      room.members.push(mem);
    }
    renderGroupMemberList();
    rtcGroupCreatePeer(mem.userId);
    appendGroupSystemLine('🎤 ' + (mem.displayName || '') + __('rtc.sys_join'));
    return;
  }
  if (type === 'rtc:group:member:leave') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId) return;
    const uid = msg.userId;
    room.members = room.members.filter(m => m.userId !== uid);
    rtcStopVolumeWatch('group:' + uid);
    rtcClosePeer(room.peerMap[uid]);
    delete room.peerMap[uid];
    // 清理该成员的屏幕共享状态与桌面音频输出，避免成员离开后按钮残留"共享中"
    if (room.screenStreamIds) delete room.screenStreamIds[uid];
    if (room.screenShareBy) delete room.screenShareBy[uid];
    if (room.screenAudioTracksByUid) delete room.screenAudioTracksByUid[uid];
    const screenAudioEl = document.getElementById('rtcGroupScreenAudioOut_' + uid);
    if (screenAudioEl) {
      try { if (screenAudioEl.srcObject) screenAudioEl.srcObject.getTracks().forEach(t => t.stop()); } catch (e) {}
      screenAudioEl.remove();
    }
    updateGroupScreenAudioBtn();
    renderGroupMemberList();
    appendGroupSystemLine(__('rtc.sys_leave'));
    return;
  }
  if (type === 'rtc:group:left') {
    if (rtcGroupRoom && (!msg.groupId || rtcGroupRoom.groupId === msg.groupId)) {
      rtcClearGroupRoom();
    }
    return;
  }
  if (type === 'rtc:group:error') {
    toast(errText(msg) || __('rtc.error'), 'error');
    if (rtcGroupRoom && (!msg.groupId || rtcGroupRoom.groupId === msg.groupId)) rtcClearGroupRoom();
    return;
  }
  if (type === 'rtc:group:offer') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId || !msg.sdp || msg.senderId === currentUser.id) return;
    const uid = msg.senderId;
    // 记录该对端是否在屏幕共享：供 onTrack 识别桌面音频轨并默认静音（防回音）
    room.screenShareBy = room.screenShareBy || {};
    room.screenStreamIds = room.screenStreamIds || {};
    room.screenShareBy[uid] = !!msg.screenShare;
    room.screenStreamIds[uid] = msg.screenStreamId || null;
    if (!room.screenShareBy[uid]) {
      // 对端停止共享：复位其桌面音频轨静音
      if (room.screenAudioTracksByUid && room.screenAudioTracksByUid[uid]) {
        room.screenAudioTracksByUid[uid].forEach(t => { try { t.enabled = false; } catch (e) {} });
      }
      if (room.screenAudioTracksByUid) delete room.screenAudioTracksByUid[uid];
      updateGroupScreenAudioBtn();
    }
    rtcGroupCreatePeer(uid);
    const pc = room.peerMap[uid];
    if (!pc) return;
    const asyncWork = async () => {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      rtcSend({ type: 'rtc:group:answer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription });
    };
    asyncWork.catch(() => {});
    return;
  }
  if (type === 'rtc:group:answer') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId || !msg.sdp || msg.senderId === currentUser.id) return;
    const pc = room.peerMap[msg.senderId];
    if (!pc) return;
    pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
    return;
  }
  if (type === 'rtc:group:candidate') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId || !msg.candidate || msg.senderId === currentUser.id) return;
    const pc = room.peerMap[msg.senderId];
    if (!pc) return;
    pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    return;
  }
}


// ==================== RTC 初始化（M2 自 chat.js DOMContentLoaded 迁入） ====================
(function () {
  function _init() {
    // 用户任意交互即解锁 AudioContext，保证来电铃声/提示音可播
    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
      document.addEventListener(evt, () => rtcEnsureAudio(), { passive: true });
    });
    initRtcPttButton();
    // 离开/刷新页面时尽力广播挂断（不可靠，主要靠对端心跳/信令兜底）
    window.addEventListener('beforeunload', () => {
      try {
        if (rtcPrivate && rtcPrivate.status !== 'idle' && rtcPrivate.peerId) {
          wsClient.send(JSON.stringify({ type: 'rtc:hangup', targetId: rtcPrivate.peerId, userId: currentUser.id }));
          if (rtcPrivate.status === 'ringing') {
            wsClient.send(JSON.stringify({ type: 'rtc:cancel', targetId: rtcPrivate.peerId, userId: currentUser.id }));
          }
        }
        if (rtcGroupRoom && rtcGroupRoom.groupId) {
          wsClient.send(JSON.stringify({ type: 'rtc:group:leave', groupId: rtcGroupRoom.groupId, userId: currentUser.id }));
        }
      } catch (e) {}
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
