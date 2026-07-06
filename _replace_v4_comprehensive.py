#!/usr/bin/env python3
"""
=== 第四轮全面硬编码中文替换 ===
覆盖所有 JS 文件中的 toast()、showConfirm()、textContent、innerHTML 等模式。
支持 --dry-run 预览和 --apply 实际应用。

用法: python _replace_v4_comprehensive.py [--dry-run] [--apply]
"""

import os
import re
import sys

JS_DIR = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'
I18N_FILE = os.path.join(JS_DIR, 'i18n.js')

# ==================== 替换规则 (file -> list of (old_string, new_string)) ====================
RULES = {}

# ==================== admin-vrc.js (56处) ====================
RULES['admin-vrc.js'] = [
    # 系统状态
    ('''toast(`同步完成！新增 ${data.added || 0} 个活动`, 'success')''',
     '''toast(__('admin_vrc.synced_events', {n: data.added || 0}), 'success')'''),
    ('''toast('同步失败：' + err.message, 'error')''',
     '''toast(__('admin_vrc.sync_failed') + ': ' + err.message, 'error')'''),
    # 改名审核
    ('''toast('仅超级管理员可审核改名申请', 'error')''',
     '''toast(__('admin_vrc.name_review_denied'), 'error')'''),
    ('''toast('加载改名申请失败：' + err.message, 'error')''',
     '''toast(__('admin_vrc.load_name_failed') + ': ' + err.message, 'error')'''),
    # 空状态
    ('''<div>暂无待审核申请</div>''',
     '''<div>${__('admin_vrc.no_pending_requests')}</div>'''),
    # 改名申请卡片
    ('''<div class="name-change-time">申请于 ${fmtDate(r.createdAt)}</div>''',
     '''<div class="name-change-time">${__('admin_vrc.applied_at')} ${fmtDate(r.createdAt)}</div>'''),
    ('''<div>当前名字：<strong>${esc(r.currentName || '')}</strong></div>''',
     '''<div>${__('admin_vrc.current_name')}<strong>${esc(r.currentName || '')}</strong></div>'''),
    ('''<div>申请改为：<strong>${esc(r.requestedName || '')}</strong></div>''',
     '''<div>${__('admin_vrc.requested_name')}<strong>${esc(r.requestedName || '')}</strong></div>'''),
    ('''理由：''', '''${__('admin_vrc.reason')}'''),
    # 审核确认
    ('''showConfirm(`确定${action === 'approve' ? '批准' : '拒绝'}此申请？`''',
     '''showConfirm(action === 'approve' ? __('admin_vrc.confirm_approve') : __('admin_vrc.confirm_reject')'''),
    ('''toast(`已${action === 'approve' ? '批准' : '拒绝'}`, 'success')''',
     '''toast(action === 'approve' ? __('admin_vrc.approved') : __('admin_vrc.rejected'), 'success')'''),
    ('''toast('操作失败：' + err.message, 'error')''',
     '''toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error')'''),
    # 改名预览
    ('''preview.textContent = count > 0 ? `📝 ${count} 条待审核申请` : __('admin.no_pending_requests');''',
     '''preview.textContent = count > 0 ? __('admin_vrc.pending_count', {n: count}) : __('admin.no_pending_requests');'''),
    # 操作日志
    ('''暂无匹配的操作日志''',
     '''${__('admin_vrc.no_oper_log')}'''),
    ('''加载失败''', '''${__('admin_vrc.load_failed')}'''),
    ('''共 ${data.total} 条''', '''${__('admin_vrc.total_entries', {n: data.total})}'''),
    ('''首页''', '''${__('admin_vrc.first_page')}'''),
    ('''末页''', '''${__('admin_vrc.last_page')}'''),
    # 系统 VRChat 状态
    ('''<span class="text-green">🟢 已登录</span>''',
     '''<span class="text-green">🟢 ${__('admin_vrc.logged_in')}</span>'''),
    ('''<span class="text-muted">🔴 未登录</span>''',
     '''<span class="text-muted">🔴 ${__('admin_vrc.not_logged_in')}</span>'''),
    ('''<button class="btn btn-sm btn-outline" onclick="hideSystemVrcLogin()">刷新</button>''',
     '''<button class="btn btn-sm btn-outline" onclick="hideSystemVrcLogin()">${__('admin_vrc.refresh')}</button>'''),
    ('''<button class="btn btn-sm btn-danger ml-6" onclick="doSystemVrcLogout()">退出</button>''',
     '''<button class="btn btn-sm btn-danger ml-6" onclick="doSystemVrcLogout()">${__('admin_vrc.logout')}</button>'''),
    ('''<button class="btn btn-sm btn-accent" onclick="showSystemVrcLogin()">登录 VRChat</button>''',
     '''<button class="btn btn-sm btn-accent" onclick="showSystemVrcLogin()">${__('admin_vrc.login_vrc')}</button>'''),
    ('''<span class="text-red">检查失败</span>''',
     '''<span class="text-red">${__('admin_vrc.check_failed')}</span>'''),
    # 登录流程
    ('''toast('仅超级管理员可使用系统VRChat登录', 'error')''',
     '''toast(__('admin_vrc.super_admin_only'), 'error')'''),
    ('''toast('需要两步验证', 'info');''',
     '''toast(__('admin_vrc.need_2fa'), 'info');'''),
    ('''toast('VRChat 登录成功', 'success');''',
     '''toast(__('admin_vrc.login_ok_vrc'), 'success');'''),
    ('''errData.error || '登录失败'; ''',
     '''errData.error || __('admin_vrc.login_failed'); '''),
    ('''toast('VRChat 登录失败：' + err.message, 'error')''',
     '''toast(__('admin_vrc.login_failed_msg') + ': ' + err.message, 'error')'''),
    ('''toast('请输入完整验证码', 'error'); return;''',
     '''toast(__('admin_vrc.enter_full_code'), 'error'); return;'''),
    ('''toast('VRChat 登录成功！', 'success');''',
     '''toast(__('admin_vrc.login_ok_excl'), 'success');'''),
    ('''errEl2.textContent = '验证码错误';''',
     '''errEl2.textContent = __('admin_vrc.wrong_code');'''),
    ('''toast('2FA 验证失败', 'error')''',
     '''toast(__('admin_vrc.fa_failed'), 'error')'''),
    ('''btn.textContent = '同步中...';''',
     '''btn.textContent = __('admin_vrc.syncing');'''),
    ('''toast('正在同步群组成员...', 'info')''',
     '''toast(__('admin_vrc.syncing_group'), 'info')'''),
    ('''toast(`✅ 同步完成！共 ${data.total || 0} 个成员`, 'success')''',
     '''toast(__('admin_vrc.synced_members', {n: data.total || 0}), 'success')'''),
    ('''toast(err.error || '同步失败', 'error')''',
     '''toast(err.error || __('admin_vrc.sync_err'), 'error')'''),
    ('''toast('同步失败：' + err.message, 'error')''',
     '''toast(__('admin_vrc.sync_failed_msg') + ': ' + err.message, 'error')'''),
    ('''btn.textContent = '🔄 同步群组';''',
     '''btn.textContent = __('admin_vrc.sync_group_btn');'''),
    ('''toast('仅超级管理员可修改系统设置', 'error')''',
     '''toast(__('admin_vrc.super_admin_setting'), 'error')'''),
    ('''toast('保存失败：' + err.message, 'error')''',
     '''toast(__('admin_vrc.save_failed') + ': ' + err.message, 'error')'''),
    ('''toast('仅超级管理员可使用此功能', 'error')''',
     '''toast(__('admin_vrc.super_admin_feature'), 'error')'''),
    ('''showConfirm('确定登出系统 VRChat 账号？', ''',
     '''showConfirm(__('admin_vrc.confirm_logout_vrc'), '''),
    ('''toast('VRChat 已登出', 'info')''',
     '''toast(__('admin_vrc.logged_out_vrc'), 'info')'''),
]

# ==================== admin-users.js (26处) ====================
RULES['admin-users.js'] = [
    ('''toast('加载用户列表失败：' + err.message, 'error')''',
     '''toast(__('admin_users.load_failed') + ': ' + err.message, 'error')'''),
    ('''暂无匹配的用户''', '''${__('admin_users.no_match')}'''),
    ('''登录名：''', '''${__('admin_users.login_id')}: '''),
    ('''角色：''', '''${__('admin_users.role')}: '''),
    ('''状态：''', '''${__('admin_users.status')}: '''),
    ('''toast('已批准', 'success')''', '''toast(__('admin_users.approved'), 'success')'''),
    ('''toast('操作失败：' + err.message, 'error')''', '''toast(__('admin_users.op_failed') + ': ' + err.message, 'error')'''),
    ('''toast('已封禁', 'success')''', '''toast(__('admin_users.banned'), 'success')'''),
    ('''toast('已解封', 'success')''', '''toast(__('admin_users.unbanned'), 'success')'''),
    ('''toast('已删除', 'success')''', '''toast(__('admin_users.deleted'), 'success')'''),
    ('''toast('用户已创建', 'success')''', '''toast(__('admin_users.created'), 'success')'''),
    ('''`创建失败 (${res.status})`''', '''`${__('admin_users.create_failed')} (${res.status})`'''),
    ('''err.message || '创建失败';''', '''err.message || __('admin_users.create_failed');'''),
    ('''toast('创建失败：' + err.message, 'error')''', '''toast(__('admin_users.create_failed') + ': ' + err.message, 'error')'''),
    ('''toast('用户ID无效', 'error')''', '''toast(__('admin_users.invalid_id'), 'error')'''),
    ('''toast('用户已更新', 'success')''', '''toast(__('admin_users.updated'), 'success')'''),
    ('''toast('更新失败：' + err.message, 'error')''', '''toast(__('admin_users.update_failed') + ': ' + err.message, 'error')'''),
    ('''toast('密码至少8位', 'error')''', '''toast(__('admin_users.pwd_min_length'), 'error')'''),
    ('''toast(data.message || '密码已重置', 'success')''', '''toast(data.message || __('admin_users.pwd_reset'), 'success')'''),
    ('''err.message === 'RATE_LIMITED' ? '操作过于频繁，请稍后重试' : (err.message || '操作失败')''',
     '''err.message === 'RATE_LIMITED' ? __('admin_users.rate_limited') : (err.message || __('admin_users.op_failed'))'''),
    ('''toast('重置失败：' + errMsg, 'error')''', '''toast(__('admin_users.reset_failed') + ': ' + errMsg, 'error')'''),
]

# ==================== admin-perms.js 部分 (高频toast) ====================
RULES['admin-perms.js'] = [
    ('''toast('加载权限失败：' + err.message, 'error');''',
     '''toast(__('admin_perms.load_failed') + ': ' + err.message, 'error');'''),
    ('''toast(`权限已${value ? '开启' : '关闭'}`, 'success');''',
     '''toast(value ? __('admin_perms.perm_on') : __('admin_perms.perm_off'), 'success');'''),
    ('''toast('操作失败：' + err.message, 'error');''',
     '''toast(__('admin_perms.op_failed') + ': ' + err.message, 'error');'''),
    ('''暂无权限组''', '''${__('admin_perms.no_groups')}'''),
    ('''🔒 系统''', '''${__('admin_perms.system_group')}'''),
    ('''📌 默认''', '''${__('admin_perms.default_group')}'''),
    ('''btn-danger" onclick="deletePermGroup(${g.id})">删除</button>''',
     '''btn-danger" onclick="deletePermGroup(${g.id})">${__('admin_perms.delete_group')}</button>'''),
    ('''无描述''', '''${__('admin_perms.no_desc')}'''),
    ('''${enabledCount}/${permCount} 项已启用''',
     '''${__('admin_perms.perm_enabled_count', {enabled: enabledCount, total: permCount})}'''),
    ('''btn-accent" onclick="showEditPermGroupPerms(${g.id}, '${esc(g.name)}')">设置权限</button>''',
     '''btn-accent" onclick="showEditPermGroupPerms(${g.id}, '${esc(g.name)}')">${__('admin_perms.set_perms')}</button>'''),
    ('''btn-outline" onclick="showEditPermGroup(${g.id})">编辑</button>''',
     '''btn-outline" onclick="showEditPermGroup(${g.id})">${__('admin_perms.edit_group')}</button>'''),
    ('''无父组''', '''${__('admin_perms.no_parent')}'''),
    ('''toast('参数错误', 'error'); return;''',
     '''toast(__('admin_perms.invalid_param'), 'error'); return;'''),
    ('''toast('权限组已更新', 'success');''',
     '''toast(__('admin_perms.group_updated'), 'success');'''),
    ('''删除权限组「''',
     '''${__('admin_perms.delete_group_confirm')}「'''),
    ('''该组下的用户将被移回默认组。''',
     '''${__('admin_perms.delete_group_warn')}'''),
    ('''toast('删除失败', 'error');''',
     '''toast(__('admin_perms.delete_failed'), 'error');'''),
    ('''toast('更新失败', 'error');''',
     '''toast(__('admin_perms.update_failed'), 'error');'''),
    ('''管理组''', '''${__('admin_perms.manage_groups')}'''),
    ('''未找到用户''', '''${__('admin_perms.user_not_found')}'''),
    ('''用户：''', '''${__('admin_perms.user_prefix')}'''),
    ('''未加入任何权限组''', '''${__('admin_perms.not_in_any_group')}'''),
    ('''已加入所有权限组''', '''${__('admin_perms.in_all_groups')}'''),
    ('''toast('用户已加入权限组', 'success');''', '''toast(__('admin_perms.user_joined_group'), 'success');'''),
    ('''toast('用户已从权限组移除', 'success');''', '''toast(__('admin_perms.user_left_group'), 'success');'''),
    ('''toast('操作失败', 'error');''', '''toast(__('admin_perms.op_failed'), 'error');'''),
]

# ==================== vrc.js (4处) ====================
RULES['vrc.js'] = [
    ('''暂无搜索结果''', '''${__('vrc.no_results')}'''),
    ('''by ${esc(w.authorName || '未知')}</div>''', '''${__('vrc.by_author')} ${esc(w.authorName || __('unknown'))}</div>'''),
    ('''${w.capacity || 0}人''', '''${__('vrc.players', {n: w.capacity || 0})}'''),
    ('''toast('已选择 World：' + worldName, 'success')''', '''toast(__('vrc.world_selected') + worldName, 'success')'''),
]

# ==================== group.js 部分 ====================
RULES['group.js'] = [
    ('''请先同步成员数据''', '''${__('group.sync_first')}'''),
    ('''const map = { 'active': '🟢 在线''', '''const map = { 'active': '🟢 '''),
    (''', 'join me': '🔵 可加入''', ''', 'join me': '🔵 '''),
    (''', 'ask me': '🟡 询问加入''', ''', 'ask me': '🟡 '''),
    (''', 'busy': '🔴 忙碌''', ''', 'busy': '🔴 '''),
    (''', 'offline': '⚫ 离线' };''', ''', 'offline': '⚫ '''),
    ('''return map[s] || s || '⚫ 离线';''', '''return map[s] || s || '⚫ ' + __('group.offline');'''),
    ('''Math.floor(diff / 60000) + '分钟前';''', '''Math.floor(diff / 60000) + __('group.minutes_ago_short');'''),
    ('''Math.floor(diff / 3600000) + '小时前';''', '''Math.floor(diff / 3600000) + __('group.hours_ago_short');'''),
    ('''Math.floor(diff / 86400000) + '天前';''', '''Math.floor(diff / 86400000) + __('group.days_ago_short');'''),
    ('''syncEl.textContent = '同步于 ' + ''', '''syncEl.textContent = __('group.synced_at') + ' '''),
    ('''btn.textContent = '⏳ 刷新中...';''', '''btn.textContent = __('group.refreshing');'''),
    ('''toast('请先在个人中心绑定VRChat账号，绑定后即可使用群组功能', 'warn')''', '''toast(__('group.bind_first'), 'warn')'''),
    ('''toast(errData.error || '刷新失败', 'error')''', '''toast(errData.error || __('group.refresh_failed'), 'error')'''),
    ('''toast('刷新失败', 'error')''', '''toast(__('group.refresh_failed'), 'error')'''),
    ('''btn.textContent = '🔄 刷新状态';''', '''btn.textContent = __('group.refresh_btn');'''),
    ('''toast(`刷新完成：${data.online} 在线 / ${data.offline} 离线 / ${data.total} 总计`, 'success')''',
     '''toast(__('group.refresh_done', {online: data.online, offline: data.offline, total: data.total}), 'success')'''),
    ('''toast('刷新失败，请稍后重试', 'error')''', '''toast(__('group.refresh_retry'), 'error')'''),
    ('''btn.textContent = '⏳ 同步中...';''', '''btn.textContent = __('group.syncing');'''),
    ('''toast(errData.error || '同步失败', 'error')''', '''toast(errData.error || __('group.sync_failed'), 'error')'''),
    ('''toast('同步失败，请确保系统已登录 VRChat', 'error')''', '''toast(__('group.sync_failed_vrc'), 'error')'''),
    ('''btn.textContent = '📥 同步成员';''', '''btn.textContent = __('group.sync_btn');'''),
    ('''`同步完成：${data.total} 名成员`''', '''`${__('group.sync_done', {n: data.total})}`'''),
    ('''${data.joined} 新加入''', '''${__('group.new_joined', {n: data.joined})}'''),
    ('''${data.left} 已离开''', '''${__('group.left_count', {n: data.left})}'''),
    ('''暂无变动记录''', '''${__('group.no_changes')}'''),
    ('''const typeLabel = c.changeType === 'joined' ? '加入' : c.changeType === 'left' ? '离开' : '变动';''',
     '''const typeLabel = c.changeType === 'joined' ? __('group.status_joined') : c.changeType === 'left' ? __('group.status_left') : __('group.status_changed');'''),
]

# ==================== 通用模式 (在多个文件中重复) ====================
# 这些匹配所有文件中的常见模式
COMMON_PATTERNS = {
    # toast('...!', 'success')
}

def load_file_content(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        return f.read()

def save_file_content(filepath, content):
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

def apply_rules(content, rules, filename):
    """应用替换规则，返回修改后的内容和统计"""
    applied = []
    modified = content
    for old, new in rules:
        if old in modified:
            count = modified.count(old)
            modified = modified.replace(old, new)
            applied.append((old[:50], new[:50], count))
        else:
            print(f"  ⚠ [{filename}] 未匹配: {old[:60]}")
    return modified, applied

def generate_i18n_keys():
    """基于替换规则生成需要添加的 i18n 键"""
    keys = {}
    
    # admin_vrc 键
    admin_vrc_keys = {
        'admin_vrc.synced_events': "'同步完成！新增 {n} 个活动'",
        'admin_vrc.sync_failed': "'同步失败'",
        'admin_vrc.name_review_denied': "'仅超级管理员可审核改名申请'",
        'admin_vrc.load_name_failed': "'加载改名申请失败'",
        'admin_vrc.no_pending_requests': "'暂无待审核申请'",
        'admin_vrc.applied_at': "'申请于'",
        'admin_vrc.current_name': "'当前名字：'",
        'admin_vrc.requested_name': "'申请改为：'",
        'admin_vrc.reason': "'理由：'",
        'admin_vrc.confirm_approve': "'确定批准此申请？'",
        'admin_vrc.confirm_reject': "'确定拒绝此申请？'",
        'admin_vrc.approved': "'已批准'",
        'admin_vrc.rejected': "'已拒绝'",
        'admin_vrc.op_failed': "'操作失败'",
        'admin_vrc.pending_count': "'📝 {n} 条待审核申请'",
        'admin_vrc.no_oper_log': "'暂无匹配的操作日志'",
        'admin_vrc.load_failed': "'加载失败'",
        'admin_vrc.total_entries': "'共 {n} 条'",
        'admin_vrc.first_page': "'首页'",
        'admin_vrc.last_page': "'末页'",
        'admin_vrc.logged_in': "'已登录'",
        'admin_vrc.not_logged_in': "'未登录'",
        'admin_vrc.refresh': "'刷新'",
        'admin_vrc.logout': "'退出'",
        'admin_vrc.login_vrc': "'登录 VRChat'",
        'admin_vrc.check_failed': "'检查失败'",
        'admin_vrc.super_admin_only': "'仅超级管理员可使用系统VRChat登录'",
        'admin_vrc.need_2fa': "'需要两步验证'",
        'admin_vrc.login_ok_vrc': "'VRChat 登录成功'",
        'admin_vrc.login_failed': "'登录失败'",
        'admin_vrc.login_failed_msg': "'VRChat 登录失败'",
        'admin_vrc.enter_full_code': "'请输入完整验证码'",
        'admin_vrc.login_ok_excl': "'VRChat 登录成功！'",
        'admin_vrc.wrong_code': "'验证码错误'",
        'admin_vrc.fa_failed': "'2FA 验证失败'",
        'admin_vrc.syncing': "'同步中...'",
        'admin_vrc.syncing_group': "'正在同步群组成员...'",
        'admin_vrc.synced_members': "'✅ 同步完成！共 {n} 个成员'",
        'admin_vrc.sync_err': "'同步失败'",
        'admin_vrc.sync_failed_msg': "'同步失败'",
        'admin_vrc.sync_group_btn': "'🔄 同步群组'",
        'admin_vrc.super_admin_setting': "'仅超级管理员可修改系统设置'",
        'admin_vrc.save_failed': "'保存失败'",
        'admin_vrc.super_admin_feature': "'仅超级管理员可使用此功能'",
        'admin_vrc.confirm_logout_vrc': "'确定登出系统 VRChat 账号？'",
        'admin_vrc.logged_out_vrc': "'VRChat 已登出'",
    }
    keys.update(admin_vrc_keys)
    
    # admin_users 键
    admin_users_keys = {
        'admin_users.load_failed': "'加载用户列表失败'",
        'admin_users.no_match': "'暂无匹配的用户'",
        'admin_users.login_id': "'登录名'",
        'admin_users.role': "'角色'",
        'admin_users.status': "'状态'",
        'admin_users.approved': "'已批准'",
        'admin_users.banned': "'已封禁'",
        'admin_users.unbanned': "'已解封'",
        'admin_users.deleted': "'已删除'",
        'admin_users.created': "'用户已创建'",
        'admin_users.create_failed': "'创建失败'",
        'admin_users.invalid_id': "'用户ID无效'",
        'admin_users.updated': "'用户已更新'",
        'admin_users.update_failed': "'更新失败'",
        'admin_users.pwd_min_length': "'密码至少8位'",
        'admin_users.pwd_reset': "'密码已重置'",
        'admin_users.rate_limited': "'操作过于频繁，请稍后重试'",
        'admin_users.reset_failed': "'重置失败'",
    }
    keys.update(admin_users_keys)
    
    # admin_perms 键
    admin_perms_keys = {
        'admin_perms.load_failed': "'加载权限失败'",
        'admin_perms.perm_on': "'权限已开启'",
        'admin_perms.perm_off': "'权限已关闭'",
        'admin_perms.op_failed': "'操作失败'",
        'admin_perms.no_groups': "'暂无权限组'",
        'admin_perms.system_group': "'🔒 系统'",
        'admin_perms.default_group': "'📌 默认'",
        'admin_perms.delete_group': "'删除'",
        'admin_perms.no_desc': "'无描述'",
        'admin_perms.perm_enabled_count': "'{enabled}/{total} 项已启用'",
        'admin_perms.set_perms': "'设置权限'",
        'admin_perms.edit_group': "'编辑'",
        'admin_perms.no_parent': "'无父组'",
        'admin_perms.invalid_param': "'参数错误'",
        'admin_perms.group_updated': "'权限组已更新'",
        'admin_perms.delete_group_confirm': "'确定删除权限组'",
        'admin_perms.delete_group_warn': "'该组下的用户将被移回默认组。'",
        'admin_perms.delete_failed': "'删除失败'",
        'admin_perms.update_failed': "'更新失败'",
        'admin_perms.manage_groups': "'管理组'",
        'admin_perms.user_not_found': "'未找到用户'",
        'admin_perms.user_prefix': "'用户：'",
        'admin_perms.not_in_any_group': "'未加入任何权限组'",
        'admin_perms.in_all_groups': "'已加入所有权限组'",
        'admin_perms.user_joined_group': "'用户已加入权限组'",
        'admin_perms.user_left_group': "'用户已从权限组移除'",
    }
    keys.update(admin_perms_keys)
    
    # vrc 键
    vrc_keys = {
        'vrc.no_results': "'暂无搜索结果'",
        'vrc.by_author': "'创建者：'",
        'vrc.players': "'{n}人'",
        'vrc.world_selected': "'已选择 World：'",
    }
    keys.update(vrc_keys)
    
    # group 附加键
    group_extra = {
        'group.sync_first': "'请先同步成员数据'",
        'group.offline': "'离线'",
        'group.minutes_ago_short': "'分钟前'",
        'group.hours_ago_short': "'小时前'",
        'group.days_ago_short': "'天前'",
        'group.synced_at': "'同步于'",
        'group.refreshing': "'⏳ 刷新中...'",
        'group.refresh_failed': "'刷新失败'",
        'group.refresh_btn': "'🔄 刷新状态'",
        'group.refresh_done': "'刷新完成：{online} 在线 / {offline} 离线 / {total} 总计'",
        'group.refresh_retry': "'刷新失败，请稍后重试'",
        'group.syncing': "'⏳ 同步中...'",
        'group.sync_failed': "'同步失败'",
        'group.sync_failed_vrc': "'同步失败，请确保系统已登录 VRChat'",
        'group.sync_btn': "'📥 同步成员'",
        'group.sync_done': "'同步完成：{n} 名成员'",
        'group.new_joined': "'{n} 新加入'",
        'group.left_count': "'{n} 已离开'",
        'group.no_changes': "'暂无变动记录'",
        'group.status_joined': "'加入'",
        'group.status_left': "'离开'",
        'group.status_changed': "'变动'",
    }
    keys.update(group_extra)
    
    return keys

def add_keys_to_i18n(keys):
    """将新键添加到 i18n.js 的 LOCALES.zh 区块"""
    content = load_file_content(I18N_FILE)
    
    # 找到 zh LOCALES 块的结束位置
    # 寻找 "lang.ru': 'Русский'" 或类似标记（zh 部分最后一个专用键）
    # 或者找 "// ---- 语言 ----" 段落后面的空白行
    
    # 更可靠的方法: 找到第一个 "en: {" 之前的最后一行的位置
    en_start = content.find("\n  en: {")
    zh_section = content[:en_start]
    
    # 在 zh 部分末尾（lang.ru 后面），在闭合 }) 之前插入新键
    zh_end_marker = "'lang.ru': 'Русский'"
    insert_pos = content.find(zh_end_marker, 0, en_start)
    if insert_pos == -1:
        print("错误: 无法找到 zh 语言段的末尾标记")
        return False
    
    # 找到该行末尾的换行符后，开始查找 }, 或 }
    insert_line_end = content.find('\n', insert_pos)
    rest_after_lang = content[insert_line_end:]
    # 找到第一个 } 或 }, （在 zh 内部）
    
    # 更精确: 在 'lang.ru': 'Русский' 之后找到 }, 行
    closing_brace_pos = rest_after_lang.find('\n  },')
    if closing_brace_pos == -1:
        closing_brace_pos = rest_after_lang.find('\n  }')
    if closing_brace_pos == -1:
        print("错误: 无法找到 zh 段的闭合括号")
        return False
    
    actual_pos = insert_line_end + closing_brace_pos
    
    # 构建新键字符串
    new_keys_str = ''
    for key in sorted(keys.keys()):
        val = keys[key]
        new_keys_str += f"    '{key}': {val},\n"
    
    # 在 }, 之前插入
    new_content = content[:actual_pos] + '\n' + new_keys_str + content[actual_pos:]
    
    save_file_content(I18N_FILE, new_content)
    print(f"\n已向 i18n.js 添加 {len(keys)} 个新键")
    return True

def main():
    dry_run = '--dry-run' in sys.argv
    do_apply = '--apply' in sys.argv
    
    if dry_run:
        print("=== 演练模式（仅显示，不改动） ===\n")
    
    total_applied = 0
    total_files = 0
    
    for filename, rules in sorted(RULES.items()):
        filepath = os.path.join(JS_DIR, filename)
        if not os.path.exists(filepath):
            print(f"[跳过] 文件不存在: {filename}")
            continue
        
        content = load_file_content(filepath)
        modified, applied = apply_rules(content, rules, filename)
        
        if applied:
            print(f"\n--- {filename} ({len(applied)} 条规则) ---")
            for old_preview, new_preview, cnt in applied:
                print(f"  ✅ {cnt}处: ...{old_preview}... → ...{new_preview}...")
                total_applied += cnt
            total_files += 1
            
            if do_apply:
                save_file_content(filepath, modified)
    
    print(f"\n{'='*60}")
    print(f"总计处理: {total_files} 个文件, {total_applied} 处替换")
    
    # 生成并显示 i18n 键
    keys = generate_i18n_keys()
    print(f"需要添加的 i18n 新键: {len(keys)} 个")
    
    if do_apply:
        # 添加键到 i18n.js
        add_keys_to_i18n(keys)
        print("\n所有替换已应用! 请运行 _validate_i18n.js 验证括号平衡。")
    
    if dry_run:
        print(f"\n运行 `python _replace_v4_comprehensive.py --apply` 来实际应用替换和添加 i18n 键。")

if __name__ == '__main__':
    main()
