// ==================== 系统初始化模块 ====================

async function doInit() {
  const loginId = document.getElementById('initLoginId')?.value;
  const password = document.getElementById('initPassword')?.value;
  const password2 = document.getElementById('initPassword2')?.value;
  const displayName = document.getElementById('initDisplayName')?.value || ('super_admin');

  if (!loginId || !password) { toast(__('init.fill_id_pwd'), 'error'); return; }
  if (password !== password2) { toast(__('init.pwds_not_match'), 'error'); return; }
  if (!validatePasswordStrength(password)) { toast(__('init.pwd_weak'), 'error'); return; }

  try {
    // 注意：初始化接口在无用户时调用，此时无 session/CSRF，必须用裸 fetch
    const res = await fetch('/api/auth/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId, password, displayName }),
      credentials: 'include'
    });

    if (res.ok) {
      toast(__('init.create_ok'), 'success');
      // V6.6: 自动登录 → 登录成功后由 doPasswordLogin → promptVrcBind 自动引导绑定 VRChat
      document.getElementById('loginModePassword')?.classList.remove('d-none');
      document.getElementById('loginModeVrc')?.classList.remove('d-none');
      switchLoginMode('password');
      document.getElementById('loginId').value = loginId;
      document.getElementById('loginPassword').value = password;
      // 自动触发登录，登录流程自然触发 VRChat 绑定检查
      await doPasswordLogin();
    } else {
      const data = await res.json();
      toast(data.error || __('init.init_failed'), 'error');
    }
  } catch (err) {
    toast(__('init.init_req_failed') + ': ' + err.message, 'error');
  }
}
