#!/usr/bin/env python3
"""
向 i18n.js 中各非 zh 语言块末尾添加新键（英文翻译）。
"""
import re

I18N_FILE = r'D:\phpstudy_pro\WWW\jingtu-web\public\js\i18n.js'

EN_KEYS = {
    'admin_vrc.synced_events': "'Sync completed! {n} events added'",
    'admin_vrc.sync_failed': "'Sync failed: '",
    'admin_vrc.name_review_denied': "'Only super admins can review name changes'",
    'admin_vrc.load_name_failed': "'Failed to load name change requests: '",
    'admin_vrc.no_pending_requests': "'No pending requests'",
    'admin_vrc.applied_at': "'Applied at '",
    'admin_vrc.current_name': "'Current name: '",
    'admin_vrc.requested_name': "'Requested name: '",
    'admin_vrc.reason': "'Reason: '",
    'admin_vrc.confirm_approve': "'Confirm approval?'",
    'admin_vrc.confirm_reject': "'Confirm rejection?'",
    'admin_vrc.approved': "'Approved'",
    'admin_vrc.rejected': "'Rejected'",
    'admin_vrc.op_failed': "'Operation failed: '",
    'admin_vrc.pending_count': "'📝 {n} pending'",
    'admin_vrc.no_oper_log': "'No matching operation logs'",
    'admin_vrc.load_failed': "'Load failed'",
    'admin_vrc.total_entries': "'Total {n} entries'",
    'admin_vrc.first_page': "'First page'",
    'admin_vrc.last_page': "'Last page'",
    'admin_vrc.logged_in': "'Logged in'",
    'admin_vrc.not_logged_in': "'Not logged in'",
    'admin_vrc.refresh': "'Refresh'",
    'admin_vrc.logout': "'Logout'",
    'admin_vrc.login_vrc': "'Login VRChat'",
    'admin_vrc.check_failed': "'Check failed'",
    'admin_vrc.super_admin_only': "'Only super admins can use system VRChat login'",
    'admin_vrc.need_2fa': "'2FA required'",
    'admin_vrc.login_ok_vrc': "'VRChat login successful'",
    'admin_vrc.login_failed': "'Login failed'",
    'admin_vrc.login_failed_msg': "'VRChat login failed: '",
    'admin_vrc.enter_full_code': "'Please enter the full verification code'",
    'admin_vrc.login_ok_excl': "'VRChat login successful!'",
    'admin_vrc.wrong_code': "'Wrong verification code'",
    'admin_vrc.fa_failed': "'2FA verification failed'",
    'admin_vrc.syncing': "'Syncing...'",
    'admin_vrc.syncing_group': "'Syncing group members...'",
    'admin_vrc.synced_members': "'✅ Sync completed! {n} members'",
    'admin_vrc.sync_err': "'Sync failed'",
    'admin_vrc.sync_failed_msg': "'Sync failed: '",
    'admin_vrc.sync_group_btn': "'🔄 Sync Group'",
    'admin_vrc.super_admin_setting': "'Only super admins can modify system settings'",
    'admin_vrc.save_failed': "'Save failed: '",
    'admin_vrc.super_admin_feature': "'Only super admins can use this feature'",
    'admin_vrc.confirm_logout_vrc': "'Confirm logout of system VRChat account?'",
    'admin_vrc.logged_out_vrc': "'VRChat logged out'",
    'admin_users.load_failed': "'Failed to load user list: '",
    'admin_users.no_match': "'No matching users'",
    'admin_users.login_id': "'Login ID'",
    'admin_users.role': "'Role'",
    'admin_users.status': "'Status'",
    'admin_users.approved': "'Approved'",
    'admin_users.banned': "'Banned'",
    'admin_users.unbanned': "'Unbanned'",
    'admin_users.deleted': "'Deleted'",
    'admin_users.created': "'User created'",
    'admin_users.create_failed': "'Create failed'",
    'admin_users.invalid_id': "'Invalid user ID'",
    'admin_users.updated': "'User updated'",
    'admin_users.update_failed': "'Update failed: '",
    'admin_users.pwd_min_length': "'Password must be at least 8 characters'",
    'admin_users.pwd_reset': "'Password reset'",
    'admin_users.rate_limited': "'Too many requests, please try again later'",
    'admin_users.reset_failed': "'Reset failed: '",
    'admin_perms.load_failed': "'Failed to load permissions: '",
    'admin_perms.perm_on': "'Permission enabled'",
    'admin_perms.perm_off': "'Permission disabled'",
    'admin_perms.op_failed': "'Operation failed: '",
    'admin_perms.no_groups': "'No permission groups'",
    'admin_perms.system_group': "'🔒 System'",
    'admin_perms.default_group': "'📌 Default'",
    'admin_perms.delete_group': "'Delete'",
    'admin_perms.no_desc': "'No description'",
    'admin_perms.perm_enabled_count': "'{enabled}/{total} enabled'",
    'admin_perms.set_perms': "'Set Permissions'",
    'admin_perms.edit_group': "'Edit'",
    'admin_perms.no_parent': "'No parent'",
    'admin_perms.invalid_param': "'Invalid parameter'",
    'admin_perms.group_updated': "'Permission group updated'",
    'admin_perms.delete_group_confirm': "'Delete permission group'",
    'admin_perms.delete_group_warn': "'Users in this group will be moved to default.'",
    'admin_perms.delete_failed': "'Delete failed'",
    'admin_perms.update_failed': "'Update failed'",
    'admin_perms.manage_groups': "'Manage Groups'",
    'admin_perms.user_not_found': "'User not found'",
    'admin_perms.user_prefix': "'User: '",
    'admin_perms.not_in_any_group': "'Not in any permission group'",
    'admin_perms.in_all_groups': "'In all permission groups'",
    'admin_perms.user_joined_group': "'User joined permission group'",
    'admin_perms.user_left_group': "'User removed from permission group'",
    'vrc.no_results': "'No search results'",
    'vrc.by_author': "'By '",
    'vrc.players': "'{n}p'",
    'vrc.world_selected': "'Selected World: '",
    'group.sync_first': "'Sync member data first'",
    'group.offline': "'Offline'",
    'group.minutes_ago_short': "'m ago'",
    'group.hours_ago_short': "'h ago'",
    'group.days_ago_short': "'d ago'",
    'group.synced_at': "'Synced at '",
    'group.refreshing': "'⏳ Refreshing...'",
    'group.refresh_failed': "'Refresh failed'",
    'group.refresh_btn': "'🔄 Refresh'",
    'group.refresh_done': "'Refresh: {online} online / {offline} offline / {total} total'",
    'group.refresh_retry': "'Refresh failed, try again later'",
    'group.syncing': "'⏳ Syncing...'",
    'group.sync_failed': "'Sync failed'",
    'group.sync_failed_vrc': "'Sync failed, ensure VRChat is logged in'",
    'group.sync_btn': "'📥 Sync Members'",
    'group.sync_done': "'Sync completed: {n} members'",
    'group.new_joined': "'{n} joined'",
    'group.left_count': "'{n} left'",
    'group.no_changes': "'No changes'",
    'group.status_joined': "'Joined'",
    'group.status_left': "'Left'",
    'group.status_changed': "'Changed'",
}

def main():
    with open(I18N_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
    
    locales_start = content.find('LOCALES = {')
    langs = ['en', 'ja', 'fr', 'de', 'ru']
    
    key_block_lines = []
    for k in sorted(EN_KEYS.keys()):
        key_block_lines.append(f"    '{k}': {EN_KEYS[k]},")
    key_block = '\n' + '\n'.join(key_block_lines)
    
    for lang in langs:
        # Find the lang block inside LOCALES
        pattern = f"  {lang}: {{"
        idx = content.find(pattern, locales_start)
        if idx == -1:
            print(f"  [错误] 未找到 {lang} 块")
            continue
        
        # Find the closing of this block: `  },`
        # Starting from idx, find the `\n  },` or `\n  }` that's NOT the one after lang.ru inside
        # Actually find: the block looks like ...'lang.ru': 'RUSSIAN'\n  },\n
        # So we find 'lang.ru' within this block first
        lang_ru_pos = content.find("'lang.ru':", idx)
        if lang_ru_pos == -1:
            print(f"  [错误] {lang} 块中找不到 lang.ru")
            continue
        
        # Find the `\n  },` after lang.ru
        block_close = content.find('\n  },', lang_ru_pos)
        if block_close == -1:
            block_close = content.find('\n  }', lang_ru_pos)
        if block_close == -1:
            print(f"  [错误] {lang} 块找不到闭合")
            continue
        
        content = content[:block_close] + key_block + content[block_close:]
        print(f"  ✅ {lang}: 插入 {len(EN_KEYS)} 个键于 {block_close} 位置")
    
    with open(I18N_FILE, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"\n完成！")

if __name__ == '__main__':
    main()
