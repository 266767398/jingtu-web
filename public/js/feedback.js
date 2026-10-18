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
      <div class="confirm-msg"><b style="font-size:16px">💡 提交建议 / 反馈</b>
        <div class="text-muted text-12 mt-4">你的建议将帮助我们改进境途同游</div>
      </div>
      <div class="form-group mb-8">
        <label class="form-label">反馈内容</label>
        <textarea id="feedbackContent" rows="5" class="search-box" maxlength="2000" placeholder="请描述你遇到的问题或改进建议..." style="width:100%;box-sizing:border-box;resize:vertical"></textarea>
      </div>
      <div class="form-group mb-8">
        <label class="form-label">联系方式（可选）</label>
        <input type="text" id="feedbackContact" class="search-box" maxlength="255" placeholder="QQ / 邮箱 / VRChat 名" style="width:100%;box-sizing:border-box">
      </div>
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn btn-accent btn-sm" data-action="confirm">提交</button>
        <button class="btn btn-outline btn-sm" data-action="cancel">取消</button>
      </div>
    </div>`, null, null);
  const contentEl = overlay.querySelector('#feedbackContent');
  const contactEl = overlay.querySelector('#feedbackContact');
  const okBtn = overlay.querySelector('[data-action="confirm"]');
  const cancelBtn = overlay.querySelector('[data-action="cancel"]');
  if (contentEl) setTimeout(function () { contentEl.focus({ preventScroll: true }); }, 60);

  okBtn.onclick = async function () {
    const content = (contentEl.value || '').trim();
    if (!content) { toast('请输入反馈内容', 'error'); contentEl.focus(); return; }
    okBtn.disabled = true;
    okBtn.textContent = '提交中...';
    try {
      const res = await api('/api/feedback', {
        method: 'POST',
        body: { content, contact: (contactEl.value || '').trim() },
        timeout: 15000
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err && err.error && err.error.message) || '提交失败'); }
      const d = await res.json();
      toast(d.message || '反馈已提交，感谢您的建议！', 'success');
      overlay._cleanup('confirm');
    } catch (e) {
      if (!isApiHandledError(e)) toast(String(e && e.message) || '提交失败', 'error');
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = '提交';
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
