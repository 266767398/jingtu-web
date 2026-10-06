// ==================== 系统初始化模块 (V7.00 步骤式向导) ====================

let initStep = 0;
let initCheckRunning = false;
const INIT_STEPS = [
  { id: 0, key: 'check', label: __('init.step_check'), icon: '🔍' },
  { id: 1, key: 'admin', label: __('init.step_admin'), icon: '👤' },
  { id: 2, key: 'done', label: __('init.step_done'), icon: '✅' },
];

function setInitStep(step) {
  initStep = step;
  for (const s of INIT_STEPS) {
    const el = document.getElementById(`initStep${s.id}`);
    if (!el) continue;
    el.classList.remove('active', 'completed');
    if (s.id === step) el.classList.add('active');
    else if (s.id < step) el.classList.add('completed');
  }
  const panels = ['initStepCheck', 'initStepAdmin', 'initStepDone'];
  panels.forEach((id, i) => {
    const panel = document.getElementById(id);
    if (panel) {
      panel.classList.toggle('d-none', i !== step);
      panel.style.removeProperty('display');
    }
  });
}

async function runEnvCheck() {
  const statusEl = document.getElementById('initEnvStatus');
  const nextBtn = document.getElementById('initNextBtn');
  if (!statusEl || !nextBtn) return;

  if (initCheckRunning) return;
  initCheckRunning = true;
  nextBtn.disabled = true;
  nextBtn.textContent = __('init.checking');

  const checks = [
    { name: __('init.check_api'), url: '/api/auth/init', method: 'GET' },
    { name: __('init.check_db'), url: '/api/health', method: 'GET' },
  ];

  const results = [];
  try {
    for (const check of checks) {
      try {
        const res = await api(check.url, { method: check.method });
        results.push({ name: check.name, ok: res.ok });
      } catch {
        results.push({ name: check.name, ok: false });
      }
    }

    const allOk = results.every(r => r.ok);
    statusEl.innerHTML = results.map(r =>
      `<div class="init-check-item ${r.ok ? 'ok' : 'fail'}">
        <span class="init-check-icon">${r.ok ? '✅' : '❌'}</span>
        <span class="init-check-name">${r.name}</span>
        <span class="init-check-status">${r.ok ? __('init.status_ok') : __('init.status_fail')}</span>
      </div>`
    ).join('');

    if (allOk) {
      nextBtn.textContent = __('init.next_admin');
      nextBtn.onclick = () => setInitStep(1);
    } else {
      nextBtn.textContent = __('init.retry');
      nextBtn.onclick = runEnvCheck;
      const failCount = results.filter(r => !r.ok).length;
      toast(__('init.env_failed', {count: failCount}), 'error');
    }
  } finally {
    // 必须无条件恢复：检查失败时按钮要变成「重试」，
    // 如果留在 disabled 状态，用户就再也点不动，初始化向导彻底卡死。
    initCheckRunning = false;
    nextBtn.disabled = false;
  }
}

async function doInit() {
  const loginId = document.getElementById('initLoginId')?.value?.trim();
  const password = document.getElementById('initPassword')?.value;
  const password2 = document.getElementById('initPassword2')?.value;
  const displayName = document.getElementById('initDisplayName')?.value?.trim();

  const errors = [];
  if (!loginId || loginId.length < 3) errors.push(__('init.err_login_id'));
  if (!displayName || displayName.length < 2) errors.push(__('init.err_display_name'));
  if (!password) errors.push(__('init.err_pwd_required'));
  if (password && !validatePasswordStrength(password).valid) errors.push(__('init.err_pwd_strength'));
  if (password && password2 && password !== password2) errors.push(__('init.err_pwd_match'));

  const hints = {
    initIdHint: errors.find(e => e === __('init.err_login_id')) || '',
    initNameHint: errors.find(e => e === __('init.err_display_name')) || '',
    initPwdMatch: errors.find(e => e === __('init.err_pwd_match') || e === __('init.err_pwd_required') || e === __('init.err_pwd_strength')) || '',
  };

  for (const [id, msg] of Object.entries(hints)) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = msg || '';
      el.style.color = msg ? 'var(--error)' : '';
    }
  }

  if (errors.length > 0) {
    toast(errors[0], 'error');
    return;
  }

  const submitBtn = document.getElementById('initSubmitBtn');
  if (submitBtn) {
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = __('init.creating');
  }

  let created = false;
  try {
    const res = await api('/api/auth/init', { method: 'POST', body: { loginId, password, displayName } });

    if (res.ok) {
      const data = await res.json();
      created = true;
      toast(__('init.super_admin_created'), 'success');

      currentUser = data.user || { id: -1, loginId, displayName, role: 'super_admin' };

      const steps = document.getElementById('initStepsContainer');
      if (steps) steps.style.display = 'none';
      setInitStep(2);

      const finalId = document.getElementById('initFinalLoginId');
      if (finalId) finalId.textContent = loginId;
      const finalName = document.getElementById('initFinalDisplayName');
      if (finalName) finalName.textContent = displayName;

      const finishBtn = document.getElementById('initFinishBtn');
      if (finishBtn) {
        finishBtn.onclick = async () => {
          finishBtn.disabled = true;
          await ensureCsrf();
          showApp();
        };
      }
    } else {
      const data = await res.json().catch(() => ({}));
      toast(errText(data) || __('init.create_failed'), 'error');
    }
  } catch (err) {
    toast(__('init.request_failed') + ': ' + err.message, 'error');
  } finally {
    // 只要没建成，按钮就必须能再点一次；
    // 恢复写在 finally，避免今后新增 return 分支时漏掉某一条路径。
    if (submitBtn && !created) {
      submitBtn.disabled = false;
      submitBtn.textContent = __('init.create_super_admin');
    }
  }
}

function startInitWizard() {
  setInitStep(0);
  setTimeout(runEnvCheck, 300);
}