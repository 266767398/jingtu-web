// ==================== 反馈/建议（左下角悬浮按钮） ====================
// 点击弹出对话框，填写反馈内容（+ 可选联系方式），提交到 /api/feedback。

function initFeedbackButton() {
  const btn = document.getElementById('feedbackBtn');
  if (!btn || btn._feedbackInit) return;
  btn._feedbackInit = true;
  btn.addEventListener('click', showFeedbackDialog);
}

function showFeedbackDialog() {
  const overlay = createOverlayDialog(`
    <div class="confirm-dialog" style="max-width:460px">
      <div class="confirm-msg"><b style="font-size:16px">${__('feedback.title')}</b>
        <div class="text-muted text-12 mt-4">${__('feedback.subtitle')}</div>
      </div>
      <div class="form-group mb-8">
        <label class="form-label">${__('feedback.content_label')}</label>
        <textarea id="feedbackContent" rows="5" class="search-box" maxlength="2000" placeholder="${__('feedback.content_placeholder')}" style="width:100%;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div class="form-group mb-8">
        <label class="form-label">${__('feedback.contact_label')}</label>
        <input type="text" id="feedbackContact" class="search-box" maxlength="255" placeholder="${__('feedback.contact_placeholder')}" style="width:100%;box-sizing:border-box">
      </div>
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn btn-accent btn-sm" data-action="confirm">${__('feedback.submit')}</button>
        <button class="btn btn-outline btn-sm" data-action="cancel">${__('common.cancel')}</button>
      </div>
    </div>`, null, null);
  const contentEl = overlay.querySelector('#feedbackContent');
  const contactEl = overlay.querySelector('#feedbackContact');
  const okBtn = overlay.querySelector('[data-action="confirm"]');
  const cancelBtn = overlay.querySelector('[data-action="cancel"]');
  if (contentEl) setTimeout(function () { contentEl.focus({ preventScroll: true }); }, 60);

  okBtn.onclick = async function () {
    const content = (contentEl.value || '').trim();
    if (!content) { toast(__('feedback.empty'), 'error'); contentEl.focus(); return; }
    okBtn.disabled = true;
    okBtn.textContent = __('feedback.submitting');
    try {
      const res = await api('/api/feedback', {
        method: 'POST',
        body: { content, contact: (contactEl.value || '').trim() },
        timeout: 15000
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err && err.error && err.error.message) || __('feedback.failed')); }
      const d = await res.json();
      toast(d.message || __('feedback.success'), 'success');
      overlay._cleanup('confirm');
    } catch (e) {
      if (!isApiHandledError(e)) toast(String(e && e.message) || __('feedback.failed'), 'error');
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = __('feedback.submit');
    }
  };
  cancelBtn.onclick = function () { overlay._cleanup('cancel'); };
  overlay.onclick = function (e) { if (e.target === overlay) overlay._cleanup('cancel'); };
  overlay.addEventListener('keydown', function (e) {
    const tag = e.target && e.target.tagName;
    if (e.key === 'Escape') overlay._cleanup('cancel');
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && tag === 'TEXTAREA') {
      e.preventDefault();
      okBtn.click();
    }
  });
}

// 页面加载完成后绑定（createOverlayDialog / api / toast 均在 core.js 中已就绪）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFeedbackButton);
} else {
  initFeedbackButton();
}
