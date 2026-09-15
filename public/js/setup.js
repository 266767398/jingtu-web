// ==================== 境途同游 配置向导 setup.js ====================
// 从 setup.html 内联 <script> 提取（S-12 CSP 外联改造）
// 2026-08-16 增强：支持「重走建站引导」——
//   · reconfigure 模式（已配置时进入，仅更新修改项）
//   · 引导进度/草稿隔离持久化（setup-wizard.json，不含任何密码/密钥）
//   · 步骤指示器可点击回退重编辑
//   · 校验放宽（重走时密码/密钥可留空=沿用）；顶部错误汇总；非破坏性横幅（不再禁用整张表单）

// ==================== 状态 ====================
let currentStep = 1;
let maxStepReached = 1;
let reconfigureMode = false;
let isSuperAdmin = false;   // 当前会话是否为超级管理员（控制「重走建站引导」按钮可见性）
const TOTAL_STEPS = 6;
const config = {
  dbHost: '127.0.0.1', dbPort: '3306', dbName: 'jingtu_group', dbUser: 'jingtu_user', dbPass: '',
  sitePort: '3456', sessionSecret: '', encryptKey: '', nodeEnv: 'production',
  adminUser: '', adminDisplayName: '', adminPass: '', adminPassConfirm: '', adminEmail: '',
  groupId: '', groupUrl: '', vrcApiKey: '', smtpHost: '', smtpPort: '587', smtpUser: '', smtpPass: '', smtpFrom: '', smtpSecure: 'false'
};

// 非敏感草稿键（与后端白名单一致；密码/密钥绝不入草稿）
const DRAFT_KEYS = [
  'dbHost', 'dbPort', 'dbName', 'dbUser', 'sitePort', 'nodeEnv',
  'adminUser', 'adminDisplayName', 'adminEmail',
  'groupId', 'groupUrl', 'vrcApiKey', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'smtpSecure'
];

// P2-97：统一带超时的 fetch。旧实现只有 checkConfigured/test-db/test-email/save
// 挂了 AbortController，state 读写与 reset 均为裸 fetch——网络半挂起时 Promise
// 永不 resolve，向导会无声卡死在加载/保存中间态。
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } finally {
    clearTimeout(timeoutId);
  }
}

// ==================== 事件委托 ====================
function initSetupEventDelegates() {
  // 挂到 .container 以同时捕获「重走建站引导」横幅按钮（横幅是 .form-box 的兄弟节点）
  const container = document.querySelector('.container');
  if (!container || container._setupDelegateInit) return;
  container._setupDelegateInit = true;
  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-setup-action]');
    if (!el) return;
    const action = el.dataset.setupAction;
    const step = parseInt(el.dataset.step) || 0;
    const field = el.dataset.field;
    switch (action) {
      case 'test-database': testDatabase(); break;
      case 'test-email': testEmail(); break;
      case 'prev-step': prevStep(); break;
      case 'next-step': nextStep(step); break;
      case 'skip-step': skipStep(step); break;
      case 'generate-secret': generateSecret(field); break;
      case 'save-and-start': saveAndStart(); break;
      case 'reset-wizard': resetWizard(); break;
    }
  });
}
initSetupEventDelegates();

// ==================== 检查是否已安装 ====================
async function checkConfigured() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('/api/setup/check', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.status === 403) {
      // 理论上已放宽，兜底仍可重走
      reconfigureMode = true;
      isSuperAdmin = false;
      showReconfigureBanner();
      await loadWizardState();
      return;
    }
    const data = await response.json();
    isSuperAdmin = !!(data && data.isSuperAdmin);
    if (!data.configured) {
      // 首次安装（无 .env）：保持首次安装模式
      reconfigureMode = false;
    } else if (data.envValid === false) {
      // .env 存在但缺少必需项（损坏）：按「首次安装」重新配置，原文件由后端自动备份
      reconfigureMode = false;
      showEnvBrokenBanner(data.missingEnvKeys || []);
    } else {
      reconfigureMode = true;
      showReconfigureBanner();
    }
    await loadWizardState();
  } catch (e) {
    console.error(__('auto_setup_1'), e);
    showConnectionError();
  }
}

// 加载引导隔离状态并预填（仅非敏感项）；重走模式下密钥/密码留空（沿用现有值）
async function loadWizardState() {
  try {
    const r = await fetchWithTimeout('/api/setup/state', {}, 5000);
    const st = await r.json();
    const drafts = (st.wizard && st.wizard.drafts) || {};
    applyDrafts(drafts);
    const step = (st.wizard && st.wizard.step) || 1;
    maxStepReached = Math.max(1, Math.min(step, TOTAL_STEPS));
    const start = Math.min(step, TOTAL_STEPS);
    showStep(start);
    refillStep(start);
  } catch (_) {
    // 网络异常：保持默认，下面按模式处理
  }
  // 仅在「首次安装」模式下自动生成密钥；重走模式保留现有值（输入框留空=沿用）
  if (!reconfigureMode) {
    generateSecret('sessionSecret');
    generateSecret('encryptKey');
    document.getElementById('sessionSecret').dispatchEvent(new Event('input'));
    document.getElementById('encryptKey').dispatchEvent(new Event('input'));
  }
}

// 把非敏感草稿回填到表单与 config
function applyDrafts(d) {
  if (!d) return;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  setVal('dbHost', d.dbHost); setVal('dbPort', d.dbPort); setVal('dbName', d.dbName); setVal('dbUser', d.dbUser);
  setVal('sitePort', d.sitePort);
  if (d.nodeEnv) { const sel = document.getElementById('nodeEnv'); if (sel) sel.value = d.nodeEnv; }
  setVal('adminUser', d.adminUser); setVal('adminDisplayName', d.adminDisplayName); setVal('adminEmail', d.adminEmail);
  setVal('groupId', d.groupId); setVal('groupUrl', d.groupUrl); setVal('vrcApiKey', d.vrcApiKey);
  setVal('smtpHost', d.smtpHost); setVal('smtpPort', d.smtpPort); setVal('smtpUser', d.smtpUser); setVal('smtpFrom', d.smtpFrom);
  if (d.smtpSecure) { const sel = document.getElementById('smtpSecure'); if (sel) sel.value = d.smtpSecure; }
  Object.assign(config, {
    dbHost: d.dbHost || config.dbHost, dbPort: d.dbPort || config.dbPort, dbName: d.dbName || config.dbName, dbUser: d.dbUser || config.dbUser,
    sitePort: d.sitePort || config.sitePort, nodeEnv: d.nodeEnv || config.nodeEnv,
    adminUser: d.adminUser || config.adminUser, adminDisplayName: d.adminDisplayName || config.adminDisplayName, adminEmail: d.adminEmail || config.adminEmail,
    groupId: d.groupId || config.groupId, groupUrl: d.groupUrl || config.groupUrl, vrcApiKey: d.vrcApiKey || config.vrcApiKey,
    smtpHost: d.smtpHost || '', smtpPort: d.smtpPort || config.smtpPort, smtpUser: d.smtpUser || '', smtpFrom: d.smtpFrom || '', smtpSecure: d.smtpSecure || config.smtpSecure
  });
}

// 非破坏性横幅：已配置时提示「重走建站引导」，不再禁用整张表单
function showReconfigureBanner() {
  const formBox = document.querySelector('.form-box');
  if (!formBox || document.getElementById('reconfigureBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'reconfigureBanner';
  banner.style.cssText = 'background:var(--notice-success-bg);border:1px solid var(--notice-success-border);color:var(--notice-success-text);padding:14px 16px;border-radius:10px;margin-bottom:20px;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap';
  const span = document.createElement('span');
  span.innerHTML = __('setup.banner_configured');
  banner.appendChild(span);
  if (isSuperAdmin) {
    // 超级管理员：提供「重走建站引导」按钮
    const btn = document.createElement('button');
    btn.className = 'btn btn-skip';
    btn.style.cssText = 'flex:0 0 auto';
    btn.dataset.setupAction = 'reset-wizard';
    btn.textContent = __('setup.rewalk_btn');
    banner.appendChild(btn);
  } else {
    // 非超级管理员（或未登录）：不提供重置入口，仅提示权限限制
    const lock = document.createElement('span');
    lock.style.cssText = 'flex:0 0 auto;color:var(--rose);font-size:12px';
    lock.textContent = __('setup.rewalk_admin_only');
    banner.appendChild(lock);
  }
  formBox.parentNode.insertBefore(banner, formBox);
}

// 警告横幅：.env 存在但缺少必需项（损坏），按首次安装重新配置，原文件会自动备份
function showEnvBrokenBanner(missingKeys) {
  const formBox = document.querySelector('.form-box');
  if (!formBox || document.getElementById('envBrokenBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'envBrokenBanner';
  banner.style.cssText = 'background:var(--notice-warning-bg);border:1px solid var(--notice-warning-border);color:var(--notice-warning-text);padding:14px 16px;border-radius:10px;margin-bottom:20px;font-size:13px;line-height:1.7';
  let html = __('setup.env_broken');
  if (missingKeys && missingKeys.length) {
    html += '<br><code style="opacity:.85;word-break:break-all">' + missingKeys.join(', ') + '</code>';
  }
  banner.innerHTML = html;
  formBox.parentNode.insertBefore(banner, formBox);
}

function showConnectionError() {
  const formBox = document.querySelector('.form-box');
  if (!formBox || document.getElementById('connErrorBanner')) return;
  const errDiv = document.createElement('div');
  errDiv.id = 'connErrorBanner';
  errDiv.style.cssText = 'background:var(--notice-danger-bg);border:1px solid var(--notice-danger-border);color:var(--notice-danger-text);padding:12px;border-radius:8px;margin-bottom:16px;font-size:13px;text-align:center';
  errDiv.innerHTML = __('setup.conn_error');
  formBox.parentNode.insertBefore(errDiv, formBox);
}

// ==================== 密钥生成（crypto.getRandomValues 安全随机，浏览器原生）====================
function generateSecret(fieldId) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const input = document.getElementById(fieldId);
  if (!input) return;
  input.value = hex;
  input.dispatchEvent(new Event('input'));
}

// ==================== 密码强度检测（与后端校验规则一致：长度8+大小写+数字）====================
function checkPasswordStrength(password) {
  if (!password) return { score: 0, label: '', bars: [], cls: '' };
  const lenOk = password.length >= 8;
  const caseOk = /[a-z]/.test(password) && /[A-Z]/.test(password);
  const numOk = /[0-9]/.test(password);
  const longBonus = password.length >= 12;
  const specBonus = /[^a-zA-Z0-9]/.test(password);
  const baseScore = (lenOk ? 1 : 0) + (caseOk ? 1 : 0) + (numOk ? 1 : 0);
  const bonusScore = (longBonus ? 1 : 0) + (specBonus ? 1 : 0);
  if (baseScore < 3) return { score: 1, label: __('setup.pw_weak'), bars: [1], cls: 'weak' };
  if (bonusScore === 0) return { score: 2, label: __('setup.pw_medium'), bars: [1, 1], cls: 'medium' };
  if (bonusScore === 1) return { score: 3, label: __('setup.pw_good'), bars: [1, 1, 1], cls: 'strong' };
  return { score: 3, label: __('setup.pw_strong'), bars: [1, 1, 1], cls: 'strong' };
}
function updatePasswordStrengthUI(inputId, strengthBoxId, textId) {
  const input = document.getElementById(inputId);
  const strengthBox = document.getElementById(strengthBoxId);
  const textEl = document.getElementById(textId);
  if (!input || !strengthBox || !textEl) return;
  const result = checkPasswordStrength(input.value);
  const bars = strengthBox.querySelectorAll('.bar');
  bars.forEach(b => b.classList.remove('weak', 'medium', 'strong'));
  result.bars.forEach((_, idx) => { if (bars[idx]) bars[idx].classList.add(result.cls); });
  textEl.textContent = result.label ? __('setup.pw_strength', { label: result.label }) : '';
  textEl.classList.remove('weak', 'medium', 'strong');
  if (result.cls) textEl.classList.add(result.cls);
}

// ==================== 表单校验 ====================
function showFieldError(fieldId, msg) {
  const errEl = document.getElementById('err_' + fieldId);
  const input = document.getElementById(fieldId);
  if (errEl) { errEl.textContent = msg; errEl.classList.add('show'); }
  if (input) input.classList.add('error');
}
function clearFieldError(fieldId) {
  const errEl = document.getElementById('err_' + fieldId);
  const input = document.getElementById(fieldId);
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
  if (input) input.classList.remove('error');
}
function clearAllErrors(prefix) {
  document.querySelectorAll('.error-msg.show').forEach(el => {
    if (!prefix || el.id.startsWith('err_' + prefix)) { el.classList.remove('show'); el.textContent = ''; }
  });
  document.querySelectorAll('input.error').forEach(el => {
    if (!prefix || el.id === prefix || el.id.startsWith(prefix)) el.classList.remove('error');
  });
}
function showErrorSummary(list) {
  const box = document.getElementById('errorSummary');
  if (!box) return;
  box.innerHTML = __('setup.fix_issues') + '<ul style="margin:6px 0 0 18px">' +
    list.map(x => `<li>${escapeHtml(x)}</li>`).join('') + '</ul>';
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function clearErrorSummary() {
  const b = document.getElementById('errorSummary');
  if (b) { b.style.display = 'none'; b.innerHTML = ''; }
}
function showErrorSummaryForStep() {
  const msgs = [];
  document.querySelectorAll('.error-msg.show').forEach(el => { if (el.textContent) msgs.push(el.textContent); });
  if (msgs.length) showErrorSummary(msgs);
}

// 校验：当前步骤输入框是否填写（重走模式放宽密码/密钥必填）
function validateStep(step) {
  clearAllErrors();
  clearErrorSummary();
  let ok = true;
  if (step === 1) {
    const required = ['dbHost', 'dbPort', 'dbName', 'dbUser'];
    required.forEach(id => {
      if (!document.getElementById(id).value.trim()) { showFieldError(id, __('setup.req_field')); ok = false; }
    });
    if (!reconfigureMode && !document.getElementById('dbPass').value) { showFieldError('dbPass', __('setup.req_field')); ok = false; }
    const port = parseInt(document.getElementById('dbPort').value);
    if (ok && (!Number.isFinite(port) || port < 1 || port > 65535)) { showFieldError('dbPort', __('setup.port_range')); ok = false; }
  } else if (step === 2) {
    const port = parseInt(document.getElementById('sitePort').value);
    if (!document.getElementById('sitePort').value.trim()) { showFieldError('sitePort', __('setup.fill_port')); ok = false; }
    else if (!Number.isFinite(port) || port < 1 || port > 65535) { showFieldError('sitePort', __('setup.port_range')); ok = false; }
    const ss = document.getElementById('sessionSecret').value.trim();
    if (!reconfigureMode || ss.length > 0) {
      if (ss.length < 32) { showFieldError('sessionSecret', __('setup.secret_min_32')); ok = false; }
    }
    const ek = document.getElementById('encryptKey').value.trim();
    if (!reconfigureMode || ek.length > 0) {
      if (ek.length !== 64) { showFieldError('encryptKey', __('setup.encrypt_64_hex')); ok = false; }
    }
  } else if (step === 3) {
    const user = document.getElementById('adminUser').value.trim();
    if (!user || user.length < 3 || user.length > 50) { showFieldError('adminUser', __('setup.username_len')); ok = false; }
    else if (!/^[a-zA-Z0-9_]+$/.test(user)) { showFieldError('adminUser', __('setup.username_charset')); ok = false; }
    const disp = document.getElementById('adminDisplayName').value.trim();
    if (!disp) { showFieldError('adminDisplayName', __('setup.fill_display')); ok = false; }
    const pass = document.getElementById('adminPass').value;
    // 重走模式：密码可留空（沿用）
    if (!reconfigureMode || pass.length > 0) {
      if (pass.length < 8) { showFieldError('adminPass', __('setup.pass_min')); ok = false; }
      else if (!/[a-z]/.test(pass) || !/[A-Z]/.test(pass) || !/[0-9]/.test(pass)) { showFieldError('adminPass', __('setup.pass_complex')); ok = false; }
      const pass2 = document.getElementById('adminPassConfirm').value;
      if (pass2 !== pass) { showFieldError('adminPassConfirm', __('setup.pass_mismatch')); ok = false; }
    }
    const email = document.getElementById('adminEmail').value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFieldError('adminEmail', __('setup.email_invalid')); ok = false; }
  }
  return ok;
}

// ==================== 步骤切换 ====================
function showStep(step) {
  if (step < 1 || step > TOTAL_STEPS) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab${step}`).classList.add('active');
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const num = document.getElementById(`step${i}-num`);
    const text = document.getElementById(`step${i}-text`);
    if (i < step) {
      num.classList.remove('active'); num.classList.add('done');
      text.classList.remove('active');
    } else if (i === step) {
      num.classList.add('active'); num.classList.remove('done');
      text.classList.add('active');
    } else {
      num.classList.remove('active', 'done');
      text.classList.remove('active');
    }
  }
  document.getElementById('progressBar').style.width = `${((step - 1) / (TOTAL_STEPS - 1)) * 100}%`;
  const prevBtn = document.querySelector(`#tab${step} [data-setup-action="prev-step"]`);
  if (prevBtn) prevBtn.disabled = (step === 1);
  currentStep = step;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function collectStep(step) {
  if (step === 1) {
    config.dbHost = document.getElementById('dbHost').value.trim();
    config.dbPort = document.getElementById('dbPort').value.trim();
    config.dbName = document.getElementById('dbName').value.trim();
    config.dbUser = document.getElementById('dbUser').value.trim();
    config.dbPass = document.getElementById('dbPass').value;
  } else if (step === 2) {
    config.sitePort = document.getElementById('sitePort').value.trim();
    config.sessionSecret = document.getElementById('sessionSecret').value.trim();
    config.encryptKey = document.getElementById('encryptKey').value.trim();
    config.nodeEnv = document.getElementById('nodeEnv').value;
  } else if (step === 3) {
    config.adminUser = document.getElementById('adminUser').value.trim();
    config.adminDisplayName = document.getElementById('adminDisplayName').value.trim();
    config.adminPass = document.getElementById('adminPass').value;
    config.adminEmail = document.getElementById('adminEmail').value.trim();
  } else if (step === 4) {
    config.groupId = document.getElementById('groupId').value.trim();
    config.groupUrl = document.getElementById('groupUrl').value.trim();
    config.vrcApiKey = document.getElementById('vrcApiKey').value.trim();
  } else if (step === 5) {
    config.smtpHost = document.getElementById('smtpHost').value.trim();
    config.smtpPort = document.getElementById('smtpPort').value.trim();
    config.smtpUser = document.getElementById('smtpUser').value.trim();
    config.smtpPass = document.getElementById('smtpPass').value;
    config.smtpFrom = document.getElementById('smtpFrom').value.trim();
    config.smtpSecure = document.getElementById('smtpSecure').value;
  }
}
function refillStep(step) {
  // P2-97：密码/API Key/SMTP 口令等敏感值不再回填 DOM。旧实现会把 config 中的
  // dbPass/adminPass/vrcApiKey/smtpPass 写回输入框的 value，明文残留在 DOM 里
  // （他人 shoulder-surfing、浏览器表单自动填充、恶意扩展读 DOM 均是暴露面）。
  // 留空语义与重走模式一致：保存时后端对空值沿用 .env 现有配置。
  if (step === 1) {
    document.getElementById('dbHost').value = config.dbHost || '127.0.0.1';
    document.getElementById('dbPort').value = config.dbPort || '3306';
    document.getElementById('dbName').value = config.dbName || 'jingtu_group';
    document.getElementById('dbUser').value = config.dbUser || 'jingtu_user';
    document.getElementById('dbPass').value = '';
  } else if (step === 2) {
    document.getElementById('sitePort').value = config.sitePort || '3456';
    document.getElementById('sessionSecret').value = config.sessionSecret || '';
    document.getElementById('encryptKey').value = config.encryptKey || '';
    document.getElementById('nodeEnv').value = config.nodeEnv || 'production';
  } else if (step === 3) {
    document.getElementById('adminUser').value = config.adminUser || '';
    document.getElementById('adminDisplayName').value = config.adminDisplayName || '';
    document.getElementById('adminPass').value = '';
    document.getElementById('adminPassConfirm').value = '';
    document.getElementById('adminEmail').value = config.adminEmail || '';
  } else if (step === 4) {
    document.getElementById('groupId').value = config.groupId || 'grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
    document.getElementById('groupUrl').value = config.groupUrl || 'https://vrchat.com/home/group/grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
    document.getElementById('vrcApiKey').value = '';
  } else if (step === 5) {
    document.getElementById('smtpHost').value = config.smtpHost || '';
    document.getElementById('smtpPort').value = config.smtpPort || '587';
    document.getElementById('smtpUser').value = config.smtpUser || '';
    document.getElementById('smtpPass').value = '';
    document.getElementById('smtpFrom').value = config.smtpFrom || '';
    document.getElementById('smtpSecure').value = config.smtpSecure || 'false';
  }
}

// 持久化引导进度 + 非敏感草稿（隔离存储）
function saveDraft() {
  const drafts = {};
  for (const k of DRAFT_KEYS) {
    if (config[k] !== undefined && config[k] !== '') drafts[k] = config[k];
  }
  // P2-97：草稿持久化为 fire-and-forget，失败静默不影响主流程；
  // 改用带超时版本并显式 catch，避免网络半挂起时留下永不 resolve 的请求与未处理 rejection
  fetchWithTimeout('/api/setup/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: currentStep, drafts })
  }, 10000).catch(() => { /* 草稿持久化失败不影响主流程 */ });
}

function nextStep(step) {
  if (!validateStep(step)) { showErrorSummaryForStep(); return; }
  collectStep(step);
  saveDraft();
  if (step === TOTAL_STEPS - 1) renderAdminSummary();
  maxStepReached = Math.max(maxStepReached, step + 1);
  showStep(step + 1);
}
function skipStep(step) {
  if (step === 4) {
    config.groupId = 'grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
    config.groupUrl = 'https://vrchat.com/home/group/grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
    config.vrcApiKey = '';
  } else if (step === 5) {
    config.smtpHost = ''; config.smtpPort = '587'; config.smtpUser = '';
    config.smtpPass = ''; config.smtpFrom = ''; config.smtpSecure = 'false';
  }
  collectStep(step);
  saveDraft();
  if (step === TOTAL_STEPS - 1) renderAdminSummary();
  maxStepReached = Math.max(maxStepReached, step + 1);
  showStep(step + 1);
}
function prevStep() {
  if (currentStep > 1) {
    collectStep(currentStep);
    saveDraft();
    showStep(currentStep - 1);
    refillStep(currentStep - 1);
  }
}
// 点击步骤指示器回退重编辑（仅允许跳到已到达的步骤）
function goToStep(n) {
  if (n < 1 || n > TOTAL_STEPS || n > maxStepReached) return;
  collectStep(currentStep);
  saveDraft();
  showStep(n);
  refillStep(n);
}

function renderAdminSummary() {
  const el = document.getElementById('adminInfoSummary');
  if (!el) return;
  const pwdNote = (reconfigureMode && !config.adminPass)
    ? '<div style="margin-top:10px;padding:8px 12px;background:var(--notice-success-bg);border:1px solid var(--notice-success-border);border-radius:6px;color:var(--notice-success-text);font-size:12px;">' + __('setup.admin_pwd_keep') + '</div>'
    : '<div style="margin-top:10px;padding:8px 12px;background:var(--notice-warning-bg);border:1px solid var(--notice-warning-border);border-radius:6px;color:var(--notice-warning-text);font-size:12px;">' + __('setup.admin_pwd_warning') + '</div>';
  el.innerHTML = `
    <div><strong>${__('setup.sum_admin_user')}</strong>${escapeHtml(config.adminUser)}</div>
    <div><strong>${__('setup.sum_display')}</strong>${escapeHtml(config.adminDisplayName)}</div>
    ${config.adminEmail ? `<div><strong>${__('setup.sum_email')}</strong>${escapeHtml(config.adminEmail)}</div>` : ''}
    ${pwdNote}
  `;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ==================== 测试数据库 ====================
async function testDatabase() {
  collectStep(1);
  const resultDiv = document.getElementById('dbTestResult');
  if (!config.dbHost || !config.dbPort || !config.dbName || !config.dbUser) {
    resultDiv.style.display = 'block'; resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.db_incomplete'); return;
  }
  // 重走且未填密码：提示将沿用现有配置
  if (!config.dbPass && reconfigureMode) {
    resultDiv.style.display = 'block'; resultDiv.className = 'test-result';
    resultDiv.innerHTML = __('setup.db_pass_keep');
    return;
  }
  if (!config.dbPass) {
    resultDiv.style.display = 'block'; resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.db_pass_required'); return;
  }
  resultDiv.style.display = 'block'; resultDiv.className = 'test-result';
  resultDiv.innerHTML = '<span class="loading"></span> ' + __('setup.testing_db');
  const controller = new AbortController();
  let timeoutId;
  try {
    timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('/api/setup/test-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: config.dbHost, port: parseInt(config.dbPort), database: config.dbName,
        user: config.dbUser, password: config.dbPass, reconfigure: reconfigureMode
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    if (data.success) {
      resultDiv.className = 'test-result success';
      resultDiv.innerHTML = __('setup.db_ok');
    } else {
      resultDiv.className = 'test-result error';
      resultDiv.innerHTML = __('setup.db_conn_fail', { err: escapeHtml(data.error || data.message || __('setup.unknown_err')) });
    }
  } catch (e) {
    clearTimeout(timeoutId);
    resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.request_fail', { err: escapeHtml(e.message) });
  }
}

// ==================== 测试邮件 ====================
async function testEmail() {
  collectStep(5);
  const resultDiv = document.getElementById('emailTestResult');
  if (!config.smtpHost || !config.smtpUser) {
    resultDiv.style.display = 'block'; resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.smtp_incomplete'); return;
  }
  if (!config.smtpPass && reconfigureMode) {
    resultDiv.style.display = 'block'; resultDiv.className = 'test-result';
    resultDiv.innerHTML = __('setup.smtp_pass_keep');
    return;
  }
  if (!config.smtpPass) {
    resultDiv.style.display = 'block'; resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.smtp_pass_required'); return;
  }
  resultDiv.style.display = 'block'; resultDiv.className = 'test-result';
  resultDiv.innerHTML = '<span class="loading"></span> ' + __('setup.sending_email');
  const controller = new AbortController();
  let timeoutId;
  try {
    timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('/api/setup/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: config.smtpHost, port: parseInt(config.smtpPort), secure: config.smtpSecure === 'true',
        user: config.smtpUser, pass: config.smtpPass, from: config.smtpFrom || 'JingTu <noreply@jingtu.com>',
        to: config.smtpUser, reconfigure: reconfigureMode
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    if (data.success) {
      resultDiv.className = 'test-result success';
      resultDiv.innerHTML = __('setup.email_ok');
    } else {
      resultDiv.className = 'test-result error';
      resultDiv.innerHTML = __('setup.email_send_fail', { err: escapeHtml(data.error || data.message || __('setup.unknown_err')) });
    }
  } catch (e) {
    clearTimeout(timeoutId);
    resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.request_fail', { err: escapeHtml(e.message) });
  }
}

// ==================== 保存并启动 ====================
function collectAll() { for (let s = 1; s <= 5; s++) collectStep(s); }

async function saveAndStart() {
  // 校验（重走模式放宽）
  if (reconfigureMode) {
    collectStep(2);
    if (!validateStep(2)) { showStep(2); refillStep(2); showErrorSummaryForStep(); return; }
    collectStep(3);
    if (!config.adminUser || !config.adminDisplayName) {
      showStep(3); refillStep(3); showErrorSummary([__('setup.fill_admin')]); return;
    }
    if (config.adminPass && config.adminPass !== document.getElementById('adminPassConfirm').value) {
      showStep(3); refillStep(3); showFieldError('adminPassConfirm', __('setup.pass_mismatch')); return;
    }
  } else {
    if (!validateStep(3)) { showStep(3); refillStep(3); showErrorSummaryForStep(); return; }
  }
  collectAll();

  // 重走模式（已配置）仅超级管理员可保存；首次安装（无 .env）任何人都可完成
  if (reconfigureMode && !isSuperAdmin) {
    const resultDiv = document.getElementById('saveResult');
    resultDiv.style.display = 'block';
    resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.rewalk_admin_only_err');
    return;
  }

  const resultDiv = document.getElementById('saveResult');
  const btn = document.getElementById('saveBtn');
  resultDiv.style.display = 'block';
  resultDiv.className = 'test-result';
  resultDiv.innerHTML = '<span class="loading"></span> ' + __('setup.stage1_writing');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading"></span> ' + __('setup.saving');
  const stageTimer = setTimeout(() => {
    resultDiv.innerHTML = '<span class="loading"></span> ' + __('setup.stage2_db');
  }, 500);
  const controller = new AbortController();
  let timeoutId;
  try {
    // 保存链路含建库/建表/bcrypt 哈希，15s 过短易误报超时，放宽到 60s
    timeoutId = setTimeout(() => controller.abort(), 60000);
    const response = await fetch('/api/setup/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, config, { reconfigure: reconfigureMode })),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    clearTimeout(stageTimer);
    if (data.success) {
      resultDiv.className = 'test-result success';
      if (reconfigureMode) {
        const adminMsg = data.adminUpdated ? __('setup.admin_updated') : (data.adminCreated ? __('setup.admin_created') : '');
        resultDiv.innerHTML = __('setup.config_updated', { msg: adminMsg });
      } else {
        const adminMsg = data.adminCreated ? __('setup.admin_created')
          : (data.adminError ? __('setup.admin_create_fail', { err: data.adminError }) : '');
        resultDiv.innerHTML = __('setup.config_saved', { msg: adminMsg });
      }
      setTimeout(() => { window.location.href = '/'; }, 2500);
    } else {
      resultDiv.className = 'test-result error';
      resultDiv.innerHTML = __('setup.save_fail', { err: escapeHtml(data.error || data.message || __('setup.unknown_err')) });
      btn.disabled = false;
      btn.innerHTML = __('setup.save_start');
    }
  } catch (e) {
    clearTimeout(stageTimer);
    clearTimeout(timeoutId);
    resultDiv.className = 'test-result error';
    resultDiv.innerHTML = __('setup.request_fail', { err: escapeHtml(e.message) });
    btn.disabled = false;
    btn.innerHTML = __('setup.save_start');
  }
}

// ==================== 重走建站引导（单独重置引导数据）====================
async function resetWizard() {
  if (!isSuperAdmin) { alert(__('setup.rewalk_admin_only_alert')); return; }
  if (!window.confirm(__('setup.rewalk_confirm'))) return;
  const btn = document.querySelector('[data-setup-action="reset-wizard"]');
  if (btn) { btn.disabled = true; btn.textContent = __('setup.resetting'); }
  try {
    const r = await fetchWithTimeout('/api/setup/reset', { method: 'POST', credentials: 'same-origin' }, 15000);
    const data = await r.json();
    if (data.success) {
      const st = await (await fetchWithTimeout('/api/setup/state', {}, 5000)).json();
      // 敏感字段留空（沿用现有值）
      config.adminPass = ''; config.dbPass = ''; config.smtpPass = ''; config.sessionSecret = ''; config.encryptKey = '';
      maxStepReached = 1;
      applyDrafts(st.wizard.drafts);
      showStep(1); refillStep(1);
      showErrorSummary([__('setup.reset_done')]);
    } else {
      alert(__('setup.reset_fail', { err: data.error || __('setup.unknown_err') }));
    }
  } catch (e) {
    alert(__('setup.reset_req_fail', { err: e.message }));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = __('setup.rewalk_btn'); }
  }
}

// ==================== 输入实时反馈 ====================
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'adminPass') updatePasswordStrengthUI('adminPass', 'adminPassStrength', 'adminPassStrengthText');
  if (id) clearFieldError(id);
});

// ==================== 步骤指示器可点击回退重编辑 ====================
function initStepClicks() {
  document.querySelectorAll('.step').forEach(stepEl => {
    stepEl.style.cursor = 'pointer';
    stepEl.addEventListener('click', () => {
      const n = parseInt(stepEl.dataset.step) || 0;
      if (n > 0 && n <= maxStepReached) goToStep(n);
    });
  });
}
initStepClicks();

// ==================== 初始化：检查配置状态（决定 fresh / reconfigure）====================
checkConfigured();
