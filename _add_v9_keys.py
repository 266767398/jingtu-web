#!/usr/bin/env python3
"""Add v9 new i18n keys to i18n.js"""
import re

BASE = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'

# New keys needed
NEW_KEYS_ZH = {
    'events.about_to_start': '即将开始',
    'events.max_people': '人上限',
    'events.no_sign_ins': '暂无签到',
    'events.n_checked_in': '{n}人已签到',
    'events.loading_calendar': '正在加载...',
    'events.back_to_today': '回到今天',
    'events.scan_to_checkin': '扫码签到',
    'events.checkin_qr': '签到二维码',
    'events.or_manual_checkin': '或手动签到',
    'events.checkin_now': '✅ 立即签到',
    'events.mark_all_checkin': '标记该活动全员签到？',
    'events.status_ongoing_or_not_started': '进行中/未开始',
    'events.month_0': '一月',
    'events.month_1': '二月',
    'events.month_2': '三月',
    'events.month_3': '四月',
    'events.month_4': '五月',
    'events.month_5': '六月',
    'events.month_6': '七月',
    'events.month_7': '八月',
    'events.month_8': '九月',
    'events.month_9': '十月',
    'events.month_10': '十一月',
    'events.month_11': '十二月',
    'admin_perms.inherited_from': '继承自',
    'admin_perms.perm_create_album': '创建相册',
    'admin_perms.perm_create_photo': '上传照片',
    'admin_perms.perm_delete_photo': '删除照片',
    'admin_perms.perm_create_announcement': '发布公告',
    'admin_perms.perm_edit_announcement': '编辑公告',
    'admin_perms.perm_delete_announcement': '删除公告',
    'admin_perms.perm_create_event': '创建活动',
    'admin_perms.perm_edit_event': '编辑活动',
    'admin_perms.perm_delete_event': '删除活动',
    'admin_perms.perm_sign_event': '报名活动',
    'admin_perms.perm_comment_event': '活动评论',
    'admin_perms.perm_manage_roles': '管理角色',
    'admin_perms.perm_manage_rosters': '管理名册',
    'admin_perms.perm_upload_group_image': '上传群图',
    'admin_perms.perm_edit_profile': '编辑资料',
    'admin_perms.perm_change_password': '修改密码',
    'admin_perms.perm_view_members': '查看成员',
    'admin_perms.perm_view_map': '查看地图',
    'admin_perms.perm_view_album': '查看相册',
    'admin_perms.perm_view_events': '查看活动',
    'admin_perms.perm_create_album_category': '创建相册分类',
    'profile.bound': '已绑定 VRChat 账号',
    'birthday.party_default': '生日派对！',
    'birthday.status_upcoming': '即将',
    'birthday.view_detail': '查看详情 →',
    'chat.no_messages': '暂无消息',
    'chat.n_members_label': '人',
    'album.enter_indices': '输入编号（多个用逗号分隔）',
    'album.delete_category_confirm': '确定删除以下分类？',
    'announcements.edit_at': '编辑于 ',
    'posts.toggle_pin': '📌 切换置顶',
    'posts.add_media_btn': '📷 添加图片/视频',
    'posts.video_load_failed': '视频加载失败',
    'posts.liked_btn': '❤️ 已赞',
    'posts.unliked_btn': '🤍 点赞',
    'posts.like_btn': '❤️ 点赞',
    'posts.send_btn': '发送',
    'posts.cancel_btn': '取消',
    'posts.publish_btn': '发布',
    'posts.view_all_comments': '查看全部 {n} 条评论',
}

NEW_KEYS_EN = {k: v for k, v in {
    'events.about_to_start': 'Starting soon',
    'events.max_people': 'max',
    'events.no_sign_ins': 'No check-ins',
    'events.n_checked_in': '{n} checked in',
    'events.loading_calendar': 'Loading...',
    'events.back_to_today': 'Back to today',
    'events.scan_to_checkin': 'Scan to check in',
    'events.checkin_qr': 'Check-in QR Code',
    'events.or_manual_checkin': 'Or check in manually',
    'events.checkin_now': '✅ Check in now',
    'events.mark_all_checkin': 'Mark all attendees as checked in?',
    'events.status_ongoing_or_not_started': 'Ongoing/Not started',
    'events.month_0': 'January',
    'events.month_1': 'February',
    'events.month_2': 'March',
    'events.month_3': 'April',
    'events.month_4': 'May',
    'events.month_5': 'June',
    'events.month_6': 'July',
    'events.month_7': 'August',
    'events.month_8': 'September',
    'events.month_9': 'October',
    'events.month_10': 'November',
    'events.month_11': 'December',
    'admin_perms.inherited_from': 'Inherited from',
    'admin_perms.perm_create_album': 'Create Album',
    'admin_perms.perm_create_photo': 'Upload Photos',
    'admin_perms.perm_delete_photo': 'Delete Photos',
    'admin_perms.perm_create_announcement': 'Post Announcements',
    'admin_perms.perm_edit_announcement': 'Edit Announcements',
    'admin_perms.perm_delete_announcement': 'Delete Announcements',
    'admin_perms.perm_create_event': 'Create Events',
    'admin_perms.perm_edit_event': 'Edit Events',
    'admin_perms.perm_delete_event': 'Delete Events',
    'admin_perms.perm_sign_event': 'Sign Up for Events',
    'admin_perms.perm_comment_event': 'Event Comments',
    'admin_perms.perm_manage_roles': 'Manage Roles',
    'admin_perms.perm_manage_rosters': 'Manage Rosters',
    'admin_perms.perm_upload_group_image': 'Upload Group Image',
    'admin_perms.perm_edit_profile': 'Edit Profile',
    'admin_perms.perm_change_password': 'Change Password',
    'admin_perms.perm_view_members': 'View Members',
    'admin_perms.perm_view_map': 'View Map',
    'admin_perms.perm_view_album': 'View Album',
    'admin_perms.perm_view_events': 'View Events',
    'admin_perms.perm_create_album_category': 'Create Album Category',
    'profile.bound': 'Bound to VRChat',
    'birthday.party_default': 'Birthday Party!',
    'birthday.status_upcoming': 'Upcoming',
    'birthday.view_detail': 'View Details →',
    'chat.no_messages': 'No messages',
    'chat.n_members_label': 'members',
    'album.enter_indices': 'Enter index (comma separated for multiple)',
    'album.delete_category_confirm': 'Delete the following categories?',
    'announcements.edit_at': 'Edited at ',
    'posts.toggle_pin': '📌 Toggle Pin',
    'posts.add_media_btn': '📷 Add Image/Video',
    'posts.video_load_failed': 'Video load failed',
    'posts.liked_btn': '❤️ Liked',
    'posts.unliked_btn': '🤍 Like',
    'posts.like_btn': '❤️ Like',
    'posts.send_btn': 'Send',
    'posts.cancel_btn': 'Cancel',
    'posts.publish_btn': 'Publish',
    'posts.view_all_comments': 'View all {n} comments',
}.items()}

def add_keys():
    path = BASE + '/i18n.js'
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    langs = ['zh', 'en', 'ja', 'fr', 'de', 'ru']
    lang_headers = {
        'zh': "  zh: { name: '简体中文', native: '简体中文', emoji: '🇨🇳'",
        'en': "  en: { name: 'English', native: 'English', emoji: '🇬🇧'",
        'ja': "  ja: { name: '日本語', native: '日本語', emoji: '🇯🇵'",
        'fr': "  fr: { name: 'Français', native: 'Français', emoji: '🇫🇷'",
        'de': "  de: { name: 'Deutsch', native: 'Deutsch', emoji: '🇩🇪'",
        'ru': "  ru: { name: 'Русский', native: 'Русский', emoji: '🇷🇺'",
    }
    
    for lang in langs:
        header = lang_headers[lang]
        if lang == 'zh':
            trans = NEW_KEYS_ZH
        elif lang == 'en':
            trans = NEW_KEYS_EN
        else:
            trans = NEW_KEYS_EN  # fallback to English for non-zh
        
        idx = content.find(header)
        if idx == -1:
            print(f"  ❌ 找不到 {lang} 头")
            continue
        
        # Find the end of this language block
        block_start = content.find('\n', idx) + 1
        close_marker = '\n  },\n'
        close_idx = content.find(close_marker, block_start)
        if close_idx == -1:
            print(f"  ❌ 找不到 {lang} 块结束")
            continue
        
        # Read existing keys at the end of this block
        block_end_lines = content[block_start:close_idx].rstrip()
        
        # Build insertion string
        insert_lines = []
        for k, v in trans.items():
            # Check if key already exists
            if f"'{k}':" in content[block_start:close_idx]:
                continue
            escaped_v = v.replace("'", "\\'")
            insert_lines.append(f"    '{k}': '{escaped_v}',")
        
        if not insert_lines:
            print(f"  ➡️ {lang}: 无新增键")
            continue
        
        insert_text = '\n' + '\n'.join(insert_lines)
        content = content[:close_idx] + insert_text + content[close_idx:]
        print(f"  ✅ {lang}: 插入 {len(insert_lines)} 个键")
    
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("  ✅ 写入完成")

add_keys()
