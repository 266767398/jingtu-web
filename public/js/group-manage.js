// ==================== 群聊管理（M2 拆分自 chat.js） ====================
// 原 chat.js L343-396（建组）+ L1088-1327（群设置/管理员/踢人/退出/解散/邀请码）抽出。
// 依赖 chat.js 保留函数（全局）：openGroupChat / closeChatDetail / loadChatConversations；
// 依赖全局词法状态：chatActiveGroupId / chatGroupRoles。由 loader.js 随 chat Tab 同批加载。

async function showCreateGroupModal() {
  // 弹出选择成员对话框
  try {
    const res = await api('/api/users/list', { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json();
    const users = data.users || [];
    const html = `
      <div class="modal" id="createGroupModal">
        <div class="modal-content" style="max-width:420px">
          <h3 class="section-title">${__('chat.create_group')}</h3>
          <div class="form-group"><label>${__('chat.group_name')}</label><input type="text" id="newGroupName" class="form-input" placeholder="${__('chat.group_name_placeholder')}"></div>
          <div class="form-group"><label class="flex-row items-center gap-4" style="cursor:pointer"><input type="checkbox" id="newGroupPrivate"> <span>${__('chat.private_group')}</span></label><span class="text-xs text-muted">${__('chat.private_group_hint')}</span></div>
          <div class="form-group"><label>${__('chat.select_members')}</label>
            <div style="max-height:200px;overflow-y:auto">${users.filter(u => u.id !== currentUser.id).map(u => `
              <label class="flex-row gap-4 items-center p-4" style="cursor:pointer">
                <input type="checkbox" class="group-member-checkbox" value="${u.id}">
                <span>${esc(u.displayName || __('chat.someone'))}</span>
              </label>`).join('')}
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-action="chat-close-create-group">${__('chat.cancel_btn')}</button>
            <button class="btn btn-accent" data-action="chat-do-create-group">${__('chat.create_btn')}</button>
          </div>
        </div>
      </div>`;
    // 添加到 body
    const existing = document.getElementById('createGroupModal');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
    showModal('createGroupModal');
  } catch (e) { toast(__('chat.load_users_failed'), 'error'); }
}

async function doCreateGroup() {
  const name = document.getElementById('newGroupName')?.value?.trim();
  if (!name) { toast(__('chat.group_name_required'), 'error'); return; }
  const checks = document.querySelectorAll('.group-member-checkbox:checked');
  const memberIds = Array.from(checks).map(c => parseInt(c.value)).filter(v => v);
  const isPrivate = document.getElementById('newGroupPrivate')?.checked;
  try {
    const res = await api('/api/chat/groups', { method: 'POST', body: JSON.stringify({ name, memberIds, isPublic: !isPrivate }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(isPrivate ? __('chat.group_created_private') : __('chat.group_created'), 'success');
      closeModal('createGroupModal');
      loadChatConversations();
      if (data.inviteCode) showInviteCodeModal(data.inviteCode, data.name);
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.create_failed'), 'error'); }
}

// ==================== 群聊设置 V6.15 ====================
async function showGroupSettings(groupId) {
  try {
    const [grpRes, adminRes] = await Promise.all([
      api(`/api/chat/groups/${groupId}`, { method: 'GET' }),
      api(`/api/chat/groups/${groupId}/admins`, { method: 'GET' })
    ]);
    if (!grpRes.ok || !adminRes.ok) return;
    const grp = await grpRes.json();
    const adminData = await adminRes.json();
    const group = grp.group;
    const members = grp.members || [];
    const admins = adminData.admins || [];
    const isCreator = group.creatorId === currentUser.id;
    const isAdmin = admins.some(a => a.id === currentUser.id);

    let html = `<div class="modal" id="groupSettingsModal">
      <div class="modal-content" style="max-width:500px">
        <h3 class="section-title">${__('chat.group_settings')}</h3>
        <div class="form-group"><label>${__('chat.group_name')}</label><strong>${esc(group.name)}</strong></div>
        <div class="form-group"><label>${__('chat.group_creator')}</label><strong>${esc(members.find(m => m.id === group.creatorId)?.displayName || __('unknown_user'))}</strong></div>
        <div class="form-group"><label>${__('chat.member_list')} (${members.length})</label>
          <div style="max-height:250px;overflow-y:auto">${members.map(m => {
            const isMemberAdmin = admins.some(a => a.id === m.id);
            const isMe = m.id === currentUser.id;
            let actions = '';
            if (isCreator && !isMe) {
              actions += `<button class="btn btn-xs ml-2" data-action="chat-toggle-admin" data-gid="${groupId}" data-uid="${m.id}" data-add="${!isMemberAdmin ? 1 : 0}">${isMemberAdmin ? __('chat.remove_admin') : __('chat.add_admin')}</button>`;
              if (!isMemberAdmin) {
                actions += `<button class="btn btn-xs btn-danger ml-2" data-action="chat-kick" data-gid="${groupId}" data-uid="${m.id}">${__('chat.kick')}</button>`;
              }
            } else if (isAdmin && !isMe && !isMemberAdmin && !isCreator) {
              actions += `<button class="btn btn-xs btn-danger ml-2" data-action="chat-kick" data-gid="${groupId}" data-uid="${m.id}">${__('chat.kick')}</button>`;
            }
            return `<div class="flex-row items-center p-3 border-b border-border">
              <img src="${m.avatarUrl ? escAttr(m.avatarUrl) : '/api/avatar/default'}" class="chat-mini-avatar" data-avatar-fail-src="${escAttr(m.avatarUrl || '/api/avatar/default')}">
              <span>${esc(m.displayName)}</span>
              ${isMemberAdmin ? '<span class="badge badge-accent ml-auto">' + __('chat.admin_badge') + '</span>' : ''}
              ${isMe ? '<span class="badge badge-success ml-auto">' + __('chat.me_badge') + '</span>' : ''}
              ${actions}
            </div>`;
          }).join('')}</div>
        </div>`;

    // §P1-6: 群主可见隐私设置与邀请码管理
    if (isCreator) {
      html += `<div class="form-group mt-4"><label>${__('chat.group_privacy')}</label>`;
      if (group.isPublic) {
        html += `<button class="btn btn-outline" data-action="chat-set-privacy" data-gid="${groupId}" data-is-public="0">${__('chat.make_private')}</button>`;
      } else {
        html += `<div class="flex-row items-center flex-wrap gap-4">
          <code style="font-family:monospace;font-size:1.1rem;letter-spacing:1px;background:var(--bg);padding:4px 8px;border-radius:6px" id="grpInviteCode">${escAttr(group.inviteCode || '')}</code>
          <button class="btn btn-xs" data-action="chat-copy-invite" data-code="${escAttr(group.inviteCode || '')}">${__('chat.copy_code')}</button>
          <button class="btn btn-xs" data-action="chat-regen-invite" data-gid="${groupId}">${__('chat.regen_code')}</button>
          <button class="btn btn-xs btn-outline" data-action="chat-set-privacy" data-gid="${groupId}" data-is-public="1">${__('chat.make_public')}</button>
        </div>`;
      }
      html += `</div>`;
    }

    if (!isCreator) {
      html += `<button class="btn btn-danger w-full mt-4" data-action="chat-leave-group" data-gid="${groupId}">${__('chat.leave_group')}</button>`;
    } else {
      html += `<button class="btn btn-danger w-full mt-4" data-action="chat-dissolve-group" data-gid="${groupId}">${__('chat.dissolve_group')}</button>`;
    }

    html += `<button class="btn w-full mt-2" data-action="chat-close-group-settings">${__('chat.close')}</button></div></div>`;

    const existing = document.getElementById('groupSettingsModal');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
    showModal('groupSettingsModal');
  } catch (e) { toast(__('chat.load_failed'), 'error'); }
}

async function toggleGroupAdmin(groupId, userId, add) {
  try {
    const res = add
      ? await api(`/api/chat/groups/${groupId}/admins`, { method: 'POST', body: JSON.stringify({ userId }) })
      : await api(`/api/chat/groups/${groupId}/admins/${userId}`, { method: 'DELETE' });
    if (res.ok) {
      toast(add ? __('chat.admin_added') : __('chat.admin_removed'), 'success');
      showGroupSettings(groupId);
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

async function kickGroupMember(groupId, userId) {
  showConfirm(__('chat.kick_confirm'), async () => {
    try {
      const res = await api(`/api/chat/groups/${groupId}/kick`, { method: 'POST', body: JSON.stringify({ userId }) });
      if (res.ok) {
        toast(__('chat.kicked'), 'success');
        showGroupSettings(groupId);
      }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
  });
}

async function leaveGroup(groupId) {
  showConfirm(__('chat.leave_confirm'), async () => {
    try {
      const res = await api(`/api/chat/groups/${groupId}/leave`, { method: 'POST' });
      if (res.ok) {
        toast(__('chat.left_group'), 'success');
        closeModal('groupSettingsModal');
        closeChatDetail();
        loadChatConversations();
      }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
  });
}

// 解散群组（仅群主）：二次确认后物理删除群及全部数据
async function dissolveGroup(groupId) {
  showConfirm(__('chat.dissolve_confirm'), async () => {
    try {
      const res = await api(`/api/chat/groups/${groupId}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('chat.dissolved'), 'success');
        closeModal('groupSettingsModal');
        if (chatActiveGroupId === groupId) closeChatDetail();
        delete chatGroupRoles[groupId];
        loadChatConversations();
      }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
  });
}

// ==================== 凭邀请码加入私密群 §P1-6 ====================
function showJoinByCodeModal() {
  const div = document.createElement('div');
  div.innerHTML = `<div class="modal" id="joinByCodeModal">
    <div class="modal-content" style="max-width:420px">
      <h3 class="section-title">${__('chat.join_by_code')}</h3>
      <p class="text-sm text-muted">${__('chat.join_by_code_hint')}</p>
      <div class="form-group"><input type="text" id="joinCodeInput" class="form-input" placeholder="${__('chat.invite_code')}" style="text-transform:uppercase" maxlength="32"></div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="chat-close-join-code">${__('chat.cancel_btn')}</button>
        <button class="btn btn-accent" data-action="chat-do-join-code">${__('chat.join')}</button>
      </div>
    </div>
  </div>`;
  const existing = document.getElementById('joinByCodeModal');
  if (existing) existing.remove();
  document.body.appendChild(div.firstElementChild);
  showModal('joinByCodeModal');
}

async function doJoinByCode() {
  const code = document.getElementById('joinCodeInput')?.value?.trim();
  if (!code) { toast(__('chat.enter_code'), 'error'); return; }
  try {
    const res = await api('/api/chat/groups/join-by-code', { method: 'POST', body: JSON.stringify({ inviteCode: code }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(__('chat.joined'), 'success');
      closeModal('joinByCodeModal');
      loadChatConversations();
      if (data.groupId) openGroupChat(data.groupId);
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.join_failed'), 'error'); }
}

// ==================== 群隐私 / 邀请码管理 §P1-6 ====================
async function setGroupPrivacy(groupId, isPublic) {
  try {
    const res = await api(`/api/chat/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify({ isPublic }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(isPublic ? __('chat.now_public') : __('chat.now_private'), 'success');
      showGroupSettings(groupId);
      if (data.inviteCode) showInviteCodeModal(data.inviteCode, '');
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

async function regenerateInvite(groupId) {
  try {
    const res = await api(`/api/chat/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify({ regenerateCode: true }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.inviteCode) {
        const el = document.getElementById('grpInviteCode');
        if (el) el.textContent = data.inviteCode;
        showInviteCodeModal(data.inviteCode, '');
        toast(__('chat.code_regenerated'), 'success');
      }
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

// 剪贴板统一走 core.js 全局 copyTextToClipboard（含 execCommand 降级）

function copyGroupInvite(code) {
  if (!code) { toast(__('chat.copy_failed'), 'error'); return; }
  copyTextToClipboard(String(code))
    .then(() => toast(__('chat.copied'), 'success'))
    .catch(() => toast(__('chat.copy_failed'), 'error'));
}

function showInviteCodeModal(code, name) {
  const div = document.createElement('div');
  div.innerHTML = `<div class="modal" id="inviteCodeModal">
    <div class="modal-content" style="max-width:420px">
      <h3 class="section-title">${esc(name || __('chat.private_group'))} · ${__('chat.invite_code')}</h3>
      <p class="text-sm text-muted">${__('chat.invite_code_hint')}</p>
      <div class="flex-row items-center gap-4 p-4">
        <code style="font-family:monospace;font-size:1.2rem;letter-spacing:1px;background:var(--bg);padding:6px 10px;border-radius:6px" id="inviteCodeText">${esc(code)}</code>
        <button class="btn btn-accent" data-action="chat-copy-invite" data-code="${escAttr(code)}">${__('chat.copy_code')}</button>
      </div>
      <button class="btn w-full mt-2" data-action="chat-close-invite-code">${__('chat.close')}</button>
    </div>
  </div>`;
  const existing = document.getElementById('inviteCodeModal');
  if (existing) existing.remove();
  document.body.appendChild(div.firstElementChild);
  showModal('inviteCodeModal');
}