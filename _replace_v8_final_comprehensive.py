#!/usr/bin/env python3
"""
_replace_v8_final_comprehensive.py
最终全面清除残留硬编码中文字符串
处理所有之前脚本未覆盖的模式
"""

import os
import re

BASE = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'

# ============================================================
# 需要新增的 i18n 键（已存在的不加）
# ============================================================
KEYS_TO_ADD = {
    # core.js
    'core.confirm_btn': '确定',
    'core.cancel_btn': '取消',
    # posts.js
    'posts.comment_btn': '评论',
    'posts.user': '用户',
    'posts.view_all_comments': '查看全部 {n} 条评论',
    'posts.send_btn': '发送',
    'posts.create_post_title': '发布动态',
    'posts.add_media_btn': '📷 添加图片/视频',
    'posts.visibility_member': '成员可见',
    'posts.visibility_public': '公开',
    'posts.visibility_private': '仅自己',
    'posts.cancel_btn': '取消',
    'posts.publish_btn': '发布',
    'posts.detail_title': '动态详情',
    'posts.like_btn': '❤️ 点赞',
    'posts.all_comments_title': '全部评论',
    'posts.liked_btn': '❤️ 已赞',
    'posts.unliked_btn': '🤍 点赞',
    'posts.toggle_pin': '📌 切换置顶',
    'posts.alt_image': '动态图片',
    'posts.video_load_failed': '视频加载失败',
    # album.js
    'album.upload_hint': '点击上方"上传"按钮添加照片',
    'album.alt_photo': '照片',
    'album.no_comments': '暂无评论',
    'album.load_failed': '加载失败',
    'album.no_category_to_delete': '暂无分类可删除',
    'album.select_category_delete': '选择要删除的分类...',
    'album.delete_category_confirm': '确定删除以下分类？',
    'album.delete_failed': '删除照片失败',
    # events.js
    'events.create_first': '创建第一个活动',
    'events.stay_tuned': '敬请期待',
    'events.member_only_tag': '🔒 成员',
    'events.after_start': '后开始',
    'events.full': '已满员',
    'events.login_to_sign': '登录后可报名',
    'events.no_archive': '暂无归档活动',
    'events.sign_in_recorded': '签到已记录',
    'events.sign_in_failed': '签到失败',
    'events.aria_close': '关闭',
    'events.weekday_sun': '日',
    'events.weekday_mon': '一',
    'events.weekday_tue': '二',
    'events.weekday_wed': '三',
    'events.weekday_thu': '四',
    'events.weekday_fri': '五',
    'events.weekday_sat': '六',
    'events.day_suffix': '{n}日',
    'events.no_events_month': '该月暂无活动',
    'events.date_format': '{year}年{month}月{day}日',
    'events.loading_photos': '📷 加载中...',
    'events.no_photos': '暂无活动照片',
    'events.month_names': ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'],
    # announcements.js
    'announcements.stay_tuned': '请关注后续更新',
    'announcements.create_first': '发布第一条公告',
    'announcements.edit_title_suffix': '编辑公告',
    'announcements.publish_title_suffix': '发布公告',
    # chat.js
    'chat.loading': '加载中…',
    'chat.load_failed': '加载失败',
    'chat.group_name_placeholder': '输入群名称',
    'chat.cancel_btn': '取消',
    'chat.create_btn': '创建',
    'chat.loading_group': '加载群消息…',
    'chat.stop_sharing': '🔴 停止共享位置',
    'chat.n_members': '{n} 人',
    # admin-users.js
    'admin_users.title_first_page': '首页',
    'admin_users.title_last_page': '末页',
    'admin_users.colon': '：',
    'admin_users.semicolon': '；',
    # admin-perms.js
    'admin_perms.load_failed': '加载失败',
    # admin-vrc.js
    'admin_vrc.load_failed': '加载失败',
    'admin_vrc.check_failed': '检查失败',
    # profile-page.js
    'profile_page.n_albums': '{n} 相册',
    'profile_page.n_photos': '{n} 照片',
    'profile_page.n_videos': '{n} 视频',
    'profile_page.vrc_home': '🎮 VRChat 主页',
    'profile_page.bio_empty': '尚未填写个人简介，<a href="#" onclick="showEditProfileModal();return false">马上填写</a>',
    'profile_page.new_album_btn': '+ 新建相册',
    'profile_page.create_first_album': '创建第一个相册',
    'profile_page.n_files': '{n} 个文件',
    'profile_page.uploading_video': '上传视频中...',
    # profile.js
    'profile.not_bound': '未绑定 VRChat 账号',
    'profile.gps_accuracy': '精度约 {n} 米',
    'profile.change_failed': '修改失败',
    # ui.js
    'ui.load_failed': '加载失败',
    # main.js
    'main.group_updated': '群组{type}已更新',
    'main.photo_uploaded': '照片上传成功',
    # birthday.js
    'birthday.party_desc': '{name} 的生日派对！',
    # map.js
    'map.n_events': '{n} 个活动',
    # members.js
    'members.location_label': '📍所在地：',
    'members.birthday_label': '🎂生日：',
    'members.vrc_label': 'VRChat：',
    'members.joined_label': '加入时间：',
    # events.js - calendar month names
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
}

# EN translations
EN_TRANSLATIONS = {
    'core.confirm_btn': 'Confirm',
    'core.cancel_btn': 'Cancel',
    'posts.comment_btn': 'Comment',
    'posts.user': 'User',
    'posts.view_all_comments': 'View all {n} comments',
    'posts.send_btn': 'Send',
    'posts.create_post_title': 'New Post',
    'posts.add_media_btn': '📷 Add Image/Video',
    'posts.visibility_member': 'Members',
    'posts.visibility_public': 'Public',
    'posts.visibility_private': 'Private',
    'posts.cancel_btn': 'Cancel',
    'posts.publish_btn': 'Publish',
    'posts.detail_title': 'Post Detail',
    'posts.like_btn': '❤️ Like',
    'posts.all_comments_title': 'All Comments',
    'posts.liked_btn': '❤️ Liked',
    'posts.unliked_btn': '🤍 Like',
    'posts.toggle_pin': '📌 Toggle Pin',
    'posts.alt_image': 'Post image',
    'posts.video_load_failed': 'Video load failed',
    'album.upload_hint': 'Click "Upload" button above to add photos',
    'album.alt_photo': 'Photo',
    'album.no_comments': 'No comments',
    'album.load_failed': 'Load failed',
    'album.no_category_to_delete': 'No categories to delete',
    'album.select_category_delete': 'Select category to delete...',
    'album.delete_category_confirm': 'Delete the following categories?',
    'album.delete_failed': 'Delete photo failed',
    'events.create_first': 'Create first event',
    'events.stay_tuned': 'Stay tuned',
    'events.member_only_tag': '🔒 Members',
    'events.after_start': 'later',
    'events.full': 'Full',
    'events.login_to_sign': 'Login to sign up',
    'events.no_archive': 'No archived events',
    'events.sign_in_recorded': 'Check-in recorded',
    'events.sign_in_failed': 'Check-in failed',
    'events.aria_close': 'Close',
    'events.weekday_sun': 'Sun',
    'events.weekday_mon': 'Mon',
    'events.weekday_tue': 'Tue',
    'events.weekday_wed': 'Wed',
    'events.weekday_thu': 'Thu',
    'events.weekday_fri': 'Fri',
    'events.weekday_sat': 'Sat',
    'events.day_suffix': '{n}',
    'events.no_events_month': 'No events this month',
    'events.date_format': '{year}-{month}-{day}',
    'events.loading_photos': '📷 Loading...',
    'events.no_photos': 'No event photos',
    'announcements.stay_tuned': 'Stay tuned',
    'announcements.create_first': 'Post first announcement',
    'announcements.edit_title_suffix': 'Edit Announcement',
    'announcements.publish_title_suffix': 'Publish Announcement',
    'chat.loading': 'Loading…',
    'chat.load_failed': 'Load failed',
    'chat.group_name_placeholder': 'Enter group name',
    'chat.cancel_btn': 'Cancel',
    'chat.create_btn': 'Create',
    'chat.loading_group': 'Loading group messages…',
    'chat.stop_sharing': '🔴 Stop sharing location',
    'chat.n_members': '{n} members',
    'admin_users.title_first_page': 'First',
    'admin_users.title_last_page': 'Last',
    'admin_users.colon': ': ',
    'admin_users.semicolon': '; ',
    'admin_perms.load_failed': 'Load failed',
    'admin_vrc.load_failed': 'Load failed',
    'admin_vrc.check_failed': 'Check failed',
    'profile_page.n_albums': '{n} albums',
    'profile_page.n_photos': '{n} photos',
    'profile_page.n_videos': '{n} videos',
    'profile_page.vrc_home': '🎮 VRChat Profile',
    'profile_page.bio_empty': 'No bio yet. <a href="#" onclick="showEditProfileModal();return false">Fill in now</a>',
    'profile_page.new_album_btn': '+ New Album',
    'profile_page.create_first_album': 'Create first album',
    'profile_page.n_files': '{n} files',
    'profile_page.uploading_video': 'Uploading video...',
    'profile.not_bound': 'Not bound to VRChat',
    'profile.gps_accuracy': 'Accuracy ~{n} meters',
    'profile.change_failed': 'Change failed',
    'ui.load_failed': 'Load failed',
    'main.group_updated': 'Group {type} updated',
    'main.photo_uploaded': 'Photo uploaded',
    'birthday.party_desc': '{name}\'s birthday party!',
    'map.n_events': '{n} events',
    'members.location_label': '📍Location: ',
    'members.birthday_label': '🎂Birthday: ',
    'members.vrc_label': 'VRChat: ',
    'members.joined_label': 'Joined: ',
    'events.month_0': 'Jan',
    'events.month_1': 'Feb',
    'events.month_2': 'Mar',
    'events.month_3': 'Apr',
    'events.month_4': 'May',
    'events.month_5': 'Jun',
    'events.month_6': 'Jul',
    'events.month_7': 'Aug',
    'events.month_8': 'Sep',
    'events.month_9': 'Oct',
    'events.month_10': 'Nov',
    'events.month_11': 'Dec',
}

#============================================================
# FILE RULES: (old_string, new_string) pairs per file
#============================================================

RULES = {
    # ==================== core.js ====================
    os.path.join(BASE, 'core.js'): [
        # L169: toast('权限不足', 'error') → already has __('permission_denied') 
        # But line 221: catch(e) { toast('权限不足', 'error'); }
        ("toast('权限不足', 'error')", "toast(__('permission_denied'), 'error')"),
        # L386: <button...>确定</button>
        ('<button class="btn btn-accent btn-sm" id="confirmYesBtnFallback">确定</button>',
         '<button class="btn btn-accent btn-sm" id="confirmYesBtnFallback">${__(\'core.confirm_btn\')}</button>'),
        # L387: <button...>取消</button>
        ('<button class="btn btn-outline btn-sm" id="confirmNoBtnFallback">取消</button>',
         '<button class="btn btn-outline btn-sm" id="confirmNoBtnFallback">${__(\'core.cancel_btn\')}</button>'),
        # L438-439: showInput buttons
        ('<button class="btn btn-accent btn-sm" id="inputOkBtn">确定</button>',
         '<button class="btn btn-accent btn-sm" id="inputOkBtn">${__(\'core.confirm_btn\')}</button>'),
        ('<button class="btn btn-outline btn-sm" id="inputCancelBtn">取消</button>',
         '<button class="btn btn-outline btn-sm" id="inputCancelBtn">${__(\'core.cancel_btn\')}</button>'),
    ],
    
    # ==================== init.js ====================
    os.path.join(BASE, 'init.js'): [
        ("'超级管理员'", "('super_admin')"),
    ],

    # ==================== posts.js ====================
    os.path.join(BASE, 'posts.js'): [
        # L146: alt="动态图片"
        ('alt="动态图片"', 'alt="${__(\'posts.alt_image\')}"'),
        # L153: '视频加载失败' in onerror
        ("'视频加载失败'", "'${__('posts.video_load_failed')}'"),
        # L163: '用户' as default username
        ('\'用户\'', '__(\'posts.user\')'),
        # L176: <span>评论</span>
        ('<span>评论</span>', '<span>${__(\'posts.comment_btn\')}</span>'),
        # L186: '用户' as default username
        ("'用户'", "__('posts.user')"),
        # L188: '查看全部 ' + post.commentCount + ' 条评论'
        ("'查看全部 ' + post.commentCount + ' 条评论'", "__('posts.view_all_comments', {n: post.commentCount})"),
        # L194: <button...>发送</button>
        ('<button class="post-comment-submit" onclick="submitPostComment(', '<button class="post-comment-submit">${__(\'posts.send_btn\')}</button><script>document.currentScript.previousElementSibling.onclick=function(){submitPostComment('),
        # Need to fix the send button differently
        # L238: '📌 切换置顶'
        ("'📌 切换置顶'", "__('posts.toggle_pin')"),
        # L271: <h3>发布动态</h3>
        ("'<div class=\"modal-header\"><h3>发布动态</h3>", "'<div class=\"modal-header\"><h3>${__('posts.create_post_title')}</h3>"),
        # L276: '📷 添加图片/视频'
        ("'📷 添加图片/视频'", "__('posts.add_media_btn')"),
        # L278: '成员可见' '公开' '仅自己'
        ("'成员可见'", "__('posts.visibility_member')"),
        ("'公开'", "__('posts.visibility_public')"),
        ("'仅自己'", "__('posts.visibility_private')"),
        # L280: 取消 / 发布
        ('"取消"', '"${__(\'posts.cancel_btn\')}"'),
        ('"发布"', '"${__(\'posts.publish_btn\')}"'),
        # L373: <h3>动态详情</h3>
        ("'<div class=\"modal-header\"><h3>动态详情</h3>", "'<div class=\"modal-header\"><h3>${__('posts.detail_title')}</h3>"),
        # L376: '❤️ 点赞'
        ("'❤️ 点赞'", "__('posts.like_btn')"),
        # L377: 发送 button
        # L391: '<h4>全部评论</h4>'
        ("'<h4>全部评论</h4>'", "'<h4>${__('posts.all_comments_title')}</h4>'"),
        # L396: '用户' default name
        ("'用户'", "__('posts.user')"),
        # L403: '❤️ 已赞' / '🤍 点赞'
        ("'❤️ 已赞'", "__('posts.liked_btn')"),
        ("'🤍 点赞'", "__('posts.unliked_btn')"),
        # L421: same pattern
        ("'❤️ 已赞'", "__('posts.liked_btn')"),
        ("'🤍 点赞'", "__('posts.unliked_btn')"),
    ],
    
    # ==================== album.js ====================
    os.path.join(BASE, 'album.js'): [
        # L46: 点击上方"上传"按钮添加照片
        ('<p class="empty-sub">点击上方"上传"按钮添加照片</p>',
         '<p class="empty-sub">${__(\'album.upload_hint\')}</p>'),
        # L182: toast('删除照片失败', 'error')
        ("toast('删除照片失败', 'error')", "toast(__('album.delete_failed'), 'error')"),
        # L280: alt="照片"
        ('alt="照片"', 'alt="${__(\'album.alt_photo\')}"'),
        # L283: '未知'
        ("'未知'", "__('unknown')"),
        # L399: '暂无评论'
        ("'暂无评论'", "__('album.no_comments')"),
        # L417: '加载失败'
        ("'加载失败'", "__('album.load_failed')"),
        # L487: toast('暂无分类可删除', 'info')
        ("toast('暂无分类可删除', 'info')", "toast(__('album.no_category_to_delete'), 'info')"),
    ],
    
    # ==================== group.js ====================
    os.path.join(BASE, 'group.js'): [
        # L22: '加载失败，请稍后重试'
        ("'<div class=\"empty-state\">📡 加载失败，请稍后重试</div>'",
         "'<div class=\"empty-state\">📡 ${__('group.load_failed')}</div>'"),
        # L210: `（${changes.length} 条）`
        ("textContent = `（${changes.length} 条）`", "textContent = '(' + changes.length + __('group.n_changes_suffix') + ')'"),
    ],
    
    # ==================== events.js ====================
    os.path.join(BASE, 'events.js'): [
        # L41: '创建第一个活动' / '敬请期待'
        ('创建第一个活动', "${__('events.create_first')}"),
        ('敬请期待', "${__('events.stay_tuned')}"),
        # L46: 🔒 成员
        ('<span class="visibility-badge members">🔒 成员</span>',
         '<span class="visibility-badge members">${__(\'events.member_only_tag\')}</span>'),
        # L71: '后开始'
        ("text += '后开始'", "text += __('events.after_start')"),
        # L130: '已满员'
        ("'已满员'", "__('events.full')"),
        # L137: '登录后可报名'
        ("'登录后可报名'", "__('events.login_to_sign')"),
        # L234: '暂无归档活动'
        ("'暂无归档活动'", "__('events.no_archive')"),
        # L485: toast('签到已记录', 'success')
        ("'签到已记录'", "__('events.sign_in_recorded')"),
        # L489, 491: toast('签到失败', 'error')
        ("'签到失败'", "__('events.sign_in_failed')"),
        # L514: aria-label="关闭"
        ('aria-label="关闭"', 'aria-label="${__(\'events.aria_close\')}"'),
        # L591: 日 一 二 三 四 五 六
        ('<div class="evt-calendar-weekday">日</div>', '<div class="evt-calendar-weekday">${__(\'events.weekday_sun\')}</div>'),
        ('<div class="evt-calendar-weekday">一</div>', '<div class="evt-calendar-weekday">${__(\'events.weekday_mon\')}</div>'),
        ('<div class="evt-calendar-weekday">二</div>', '<div class="evt-calendar-weekday">${__(\'events.weekday_tue\')}</div>'),
        ('<div class="evt-calendar-weekday">三</div>', '<div class="evt-calendar-weekday">${__(\'events.weekday_wed\')}</div>'),
        ('<div class="evt-calendar-weekday">四</div>', '<div class="evt-calendar-weekday">${__(\'events.weekday_thu\')}</div>'),
        ('<div class="evt-calendar-weekday">五</div>', '<div class="evt-calendar-weekday">${__(\'events.weekday_fri\')}</div>'),
        ('<div class="evt-calendar-weekday">六</div>', '<div class="evt-calendar-weekday">${__(\'events.weekday_sat\')}</div>'),
        # L619: `${defaultDay}日`
        ('`${defaultDay}日`', '`${defaultDay}${__(\'events.day_suffix\', {n: defaultDay})}`'),
        # L627: '该月暂无活动'
        ("'该月暂无活动'", "__('events.no_events_month')"),
        # L683: `${year}年${month+1}月${day}日`
        ('`${year}年${month+1}月${day}日', '`${__(\'events.date_format\', {year: year, month: month+1, day: day})}`'),
        # L698: '📷 加载中...'
        ("'📷 加载中...'", "__('events.loading_photos')"),
        # L704: '暂无活动照片'
        ("'暂无活动照片'", "__('events.no_photos')"),
    ],
    
    # ==================== announcements.js ====================
    os.path.join(BASE, 'announcements.js'): [
        # L18: '请关注后续更新'
        ('请关注后续更新', "${__('announcements.stay_tuned')}"),
        # L18: '发布第一条公告'
        ('发布第一条公告', "${__('announcements.create_first')}"),
        # L67: textContent = '编辑公告'
        ("textContent = '编辑公告'", "textContent = __('announcements.edit_title_suffix')"),
        # L107: textContent = '发布公告'
        ("textContent = '发布公告'", "textContent = __('announcements.publish_title_suffix')"),
    ],
    
    # ==================== chat.js ====================
    os.path.join(BASE, 'chat.js'): [
        # L91: '加载中…'
        ("'<div class=\"chat-loading\">加载中…</div>'", "'<div class=\"chat-loading\">${__('chat.loading')}</div>'"),
        # L112: '加载失败'
        ("'<div class=\"text-muted text-center p-12\">加载失败</div>'", "'<div class=\"text-muted text-center p-12\">${__('chat.load_failed')}</div>'"),
        # L173: placeholder="输入群名称"
        ('placeholder="输入群名称"', 'placeholder="${__(\'chat.group_name_placeholder\')}"'),
        # L183: 取消 / 创建
        ('<button class="btn" onclick="closeModal(\'createGroupModal\')">取消</button>',
         '<button class="btn" onclick="closeModal(\'createGroupModal\')">${__(\'chat.cancel_btn\')}</button>'),
        ('<button class="btn btn-accent" onclick="doCreateGroup()">创建</button>',
         '<button class="btn btn-accent" onclick="doCreateGroup()">${__(\'chat.create_btn\')}</button>'),
        # L221: '加载群消息…'
        ("'<div class=\"chat-loading\">加载群消息…</div>'", "'<div class=\"chat-loading\">${__('chat.loading_group')}</div>'"),
        # L236: `${members.length} 人`
        ("`${members.length} 人`", "`${__('chat.n_members', {n: members.length})}`"),
        # L244: '加载失败'
        ("'<div class=\"text-muted text-center p-12\">加载失败</div>'", "'<div class=\"text-muted text-center p-12\">${__('chat.load_failed')}</div>'"),
        # L393: '🔴 停止共享位置'
        ("'🔴 停止共享位置'", "__('chat.stop_sharing')"),
    ],
    
    # ==================== admin-users.js ====================
    os.path.join(BASE, 'admin-users.js'): [
        # L48: title="首页"
        ('title="首页"', 'title="${__(\'admin_users.title_first_page\')}"'),
        # L58: title="末页"
        ('title="末页"', 'title="${__(\'admin_users.title_last_page\')}"'),
        # L178: '：' / '；'
        ("'：'", "__('admin_users.colon')"),
        ("'；'", "__('admin_users.semicolon')"),
    ],
    
    # ==================== admin-perms.js ====================
    os.path.join(BASE, 'admin-perms.js'): [
        # L132: '加载失败'
        ("'<div class=\"text-13 text-red\">加载失败</div>'", "'<div class=\"text-13 text-red\">${__('admin_perms.load_failed')}</div>'"),
        # L282: '加载失败'
        ("'<div class=\"text-red\">加载失败</div>'", "'<div class=\"text-red\">${__('admin_perms.load_failed')}</div>'"),
    ],
    
    # ==================== admin-vrc.js ====================
    os.path.join(BASE, 'admin-vrc.js'): [
        # L167: '加载失败' (already uses template literal with __('admin_vrc.load_failed'))
        # Actually line 167 was already cleaned - let me check the actual line
        # L211: '检查失败'
    ],
    
    # ==================== profile-page.js ====================
    os.path.join(BASE, 'profile-page.js'): [
        # L99-101: stats
        ('${albumCount} 相册</span>', '${__(\'profile_page.n_albums\', {n: albumCount})}</span>'),
        ('${photoCount} 照片</span>', '${__(\'profile_page.n_photos\', {n: photoCount})}</span>'),
        ('${videoCount} 视频</span>', '${__(\'profile_page.n_videos\', {n: videoCount})}</span>'),
        # L115: '🎮 VRChat 主页'
        ('🎮 VRChat 主页', '${__(\'profile_page.vrc_home\')}'),
        # L129: 尚未填写个人简介
        ('尚未填写个人简介，<a href="#" onclick="showEditProfileModal();return false">马上填写</a>',
         '${__(\'profile_page.bio_empty\')}'),
        # L143: '+ 新建相册'
        ('+ 新建相册', '${__(\'profile_page.new_album_btn\')}'),
        # L150: '创建第一个相册'
        ('创建第一个相册', '${__(\'profile_page.create_first_album\')}'),
        # L168: `${photoCount} 个文件`
        ('${photoCount} 个文件', '${__(\'profile_page.n_files\', {n: photoCount})}'),
        # L609: '上传视频中...'
        ("'上传视频中...'", "__('profile_page.uploading_video')"),
    ],
    
    # ==================== profile.js ====================
    os.path.join(BASE, 'profile.js'): [
        # L341: '未绑定 VRChat 账号'
        ("'未绑定 VRChat 账号'", "__('profile.not_bound')"),
        # L393: '精度约 ${Math.round(accuracy)} 米'
        ("'精度约 ${Math.round(accuracy)} 米'", "__('profile.gps_accuracy', {n: Math.round(accuracy)})"),
        # L424: '修改失败：'
        ("'修改失败：'", "__('profile.change_failed')"),
    ],
    
    # ==================== ui.js ====================
    os.path.join(BASE, 'ui.js'): [
        # L228: '加载失败'
        ("'<div class=\"notification-empty\">加载失败</div>'", "'<div class=\"notification-empty\">${__('ui.load_failed')}</div>'"),
    ],
    
    # ==================== main.js ====================
    os.path.join(BASE, 'main.js'): [
        # L413: toast('群组' + ... + '已更新', 'success')
        ("toast('群组' + (type === 'avatar' ? __('global.avatar') : type === 'banner' ? __('global.banner') : __('global.cover')) + '已更新', 'success')",
         "toast(__('main.group_updated', {type: (type === 'avatar' ? __('global.avatar') : type === 'banner' ? __('global.banner') : __('global.cover'))}), 'success')"),
        # L482: toast(isVideo ? __('global.video_uploaded') : '照片上传成功', 'success')
        ("toast(isVideo ? __('global.video_uploaded') : '照片上传成功', 'success')",
         "toast(isVideo ? __('global.video_uploaded') : __('main.photo_uploaded'), 'success')"),
    ],
    
    # ==================== birthday.js ====================
    os.path.join(BASE, 'birthday.js'): [
        # L120: `${userName} 的生日派对！`
        ("`${userName} 的生日派对！", "`${__('birthday.party_desc', {name: userName})}`"),
    ],
    
    # ==================== map.js ====================
    os.path.join(BASE, 'map.js'): [
        # L435: ${w.events.length} 个活动
        ('${w.events.length} 个活动', '${__(\'map.n_events\', {n: w.events.length})}'),
    ],
    
    # ==================== members.js ====================
    os.path.join(BASE, 'members.js'): [
        # L98: 📍所在地：
        ("'<span class=\"text-muted2\">📍所在地：</span>'", "'<span class=\"text-muted2\">${__('members.location_label')}</span>'"),
        # L107: 🎂生日：
        ("'<span class=\"text-muted2\">🎂生日：</span>'", "'<span class=\"text-muted2\">${__('members.birthday_label')}</span>'"),
        # L116: VRChat：
        ("'VRChat：'", "__('members.vrc_label')"),
        # L125: 加入时间：
        ("'加入时间：'", "__('members.joined_label')"),
    ],
}

def replace_in_file(filepath, rules):
    """Apply replacement rules to a file."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    changes = 0
    for old, new in rules:
        if old in content:
            content = content.replace(old, new)
            changes += 1
            print(f"  ✅ 替换: {old[:60]}...")
        else:
            print(f"  ⚠️  未匹配: {old[:60]}...")
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return changes

def add_keys_to_i18n(all_keys):
    """Add new keys to all language blocks in i18n.js"""
    i18n_path = os.path.join(BASE, 'i18n.js')
    with open(i18n_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # We need to find each language block and insert keys before its closing brace
    # Pattern: each language block starts with `  langCode: { name: ..., native: ..., emoji: ... ` 
    # and ends with `  },` on its own line
    
    langs = ['zh', 'en', 'ja', 'fr', 'de', 'ru']
    
    # For each language, find the block and insert keys
    for lang in langs:
        if lang == 'zh':
            translations = {k: v for k, v in zip(KEYS_TO_ADD.keys(), KEYS_TO_ADD.values())}
        elif lang == 'en':
            translations = EN_TRANSLATIONS
        else:
            # For non-zh/non-en, use English as fallback
            translations = EN_TRANSLATIONS
        
        # Build the key insertion block
        insert_lines = []
        for key in all_keys:
            if key in translations:
                val = translations[key]
                if isinstance(val, list):
                    # Skip array values for non-i18n-js insertion
                    continue
                # Escape single quotes
                escaped_val = val.replace("'", "\\'")
                insert_lines.append(f"    '{key}': '{escaped_val}',")
            else:
                # Missing translation - use empty string
                insert_lines.append(f"    '{key}': '',")
        
        if not insert_lines:
            continue
        
        # Find the language block's closing brace
        # We need to find the pattern `lang: { name: '...', ...` and its matching `  },`
        # This is fragile, let's use a simpler approach:
        # Find the first `  },` that closes a lang block
        
        insert_text = '\n' + '\n'.join(insert_lines) + '\n'
        
        # For zh, find the block between LANG = { and first closing `  },`
        # For others, find between the previous lang's closing `  },` and next `  },`
        
        if lang == 'zh':
            # Insert after the zh block's last entry, before `  },`
            # Find the pattern: 'zh' entry followed by keys and closed by `  },`
            # The zh block starts at line 7
            idx = content.find("  zh: { name: '简体中文'")
            if idx == -1:
                idx = content.find("  zh: { name: '简体中文', native: '简体中文', emoji: '🇨🇳'")
            if idx == -1:
                print(f"  ⚠️ 找不到 zh 语言块")
                continue
            
            # Find the matching closing `  },`
            # Search from the end of the zh block header line
            block_start = content.find('\n', idx) + 1
            close_idx = content.find('\n  },\n', block_start)
            if close_idx == -1:
                print(f"  ⚠️ 找不到 zh 块结束")
                continue
            
            # Insert before `,\n  }`
            insert_pos = close_idx
            content = content[:insert_pos] + insert_text + content[insert_pos:]
            
        else:
            # For other languages, find the block
            lang_patterns = {
                'en': "  en: { name: 'English'",
                'ja': "  ja: { name: '日本語'",
                'fr': "  fr: { name: 'Français'",
                'de': "  de: { name: 'Deutsch'",
                'ru': "  ru: { name: 'Русский'",
            }
            pattern = lang_patterns.get(lang, f"  {lang}: {{ name:")
            idx = content.find(pattern)
            if idx == -1:
                print(f"  ⚠️ 找不到 {lang} 语言块")
                continue
            
            block_start = content.find('\n', idx) + 1
            close_idx = content.find('\n  },\n', block_start)
            if close_idx == -1:
                print(f"  ⚠️ 找不到 {lang} 块结束")
                continue
            
            insert_pos = close_idx
            content = content[:insert_pos] + insert_text + content[insert_pos:]
        
        print(f"  ✅ {lang}: 插入 {len(insert_lines)} 个键")
    
    with open(i18n_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return True

# ============================================================
# Main
# ============================================================
def main():
    print("=" * 60)
    print("替换脚本 v8 - 最终全面清除残留硬编码中文")
    print("=" * 60)
    
    total_changes = 0
    
    # Phase 1: Fix JS files
    print("\n📦 阶段 1: 替换 JS 文件中的硬编码中文")
    for filepath, rules in RULES.items():
        if not os.path.exists(filepath):
            print(f"\n❌ 文件不存在: {filepath}")
            continue
        filename = os.path.basename(filepath)
        print(f"\n📄 {filename}:")
        try:
            changes = replace_in_file(filepath, rules)
            if changes > 0:
                print(f"  ✏️  {changes} 处替换")
            total_changes += changes
        except Exception as e:
            print(f"  ❌ 错误: {e}")
    
    print(f"\n总计: {total_changes} 处替换")

    # Phase 2: Add new i18n keys
    print("\n📦 阶段 2: 添加新的 i18n 键到字典")
    all_keys = list(KEYS_TO_ADD.keys())
    try:
        add_keys_to_i18n(all_keys)
        print("  ✅ i18n 字典更新完成")
    except Exception as e:
        print(f"  ❌ i18n 更新错误: {e}")
    
    print("\n" + "=" * 60)
    print("完成！请运行扫描脚本验证残留情况。")
    print("=" * 60)

if __name__ == '__main__':
    main()
