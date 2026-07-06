#!/usr/bin/env python3
"""
=== 第五轮综合替换 (v5) ===
覆盖剩余 17 个 JS 文件中的所有硬编码中文。
用法: python _replace_v5.py [--dry-run] [--apply]
"""

import os
import re
import sys

JS_DIR = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'
I18N_FILE = os.path.join(JS_DIR, 'i18n.js')

RULES = {}

# ==================== events.js (87处) ====================
RULES['events.js'] = [
    # 日历
    ('''const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];''',
     '''const monthNames = [__('events.month_1'), __('events.month_2'), __('events.month_3'), __('events.month_4'), __('events.month_5'), __('events.month_6'), __('events.month_7'), __('events.month_8'), __('events.month_9'), __('events.month_10'), __('events.month_11'), __('events.month_12')];'''),
    ('''['日', '一', '二', '三', '四', '五', '六']''',
     '''[__('events.day_sun'), __('events.day_mon'), __('events.day_tue'), __('events.day_wed'), __('events.day_thu'), __('events.day_fri'), __('events.day_sat')]'''),
    ('''`${count}个活动`''',
     '''__('events.count_events', {n: count})'''),
    # 事件卡
    ('''<div class="empty-state"><div class="empty-icon">📅</div><div>暂无活动</div></div>''',
     '''<div class="empty-state"><div class="empty-icon">📅</div><div>${__('events.no_events')}</div></div>'''),
    ('''<div class="text-center p-16 text-muted">加载中...</div>''',
     '''<div class="text-center p-16 text-muted">${__('events.loading')}</div>'''),
    ('''加载失败''', '''${__('events.load_failed')}'''),
    ('''<span class="tag tag-green">${e.isPublic ? '🌐 公开' : '🔒 成员专属'}</span>''',
     '''<span class="tag tag-green">${e.isPublic ? __('events.public') : __('events.member_only')}</span>'''),
    ('''签到''', '''${__('events.sign_in')}'''),
    ('''${r.hasSignedIn ? '✅ 已签到' : '⬜ 未签到'}''',
     '''${r.hasSignedIn ? __('events.signed') : __('events.not_signed')}'''),
    ('''🗑️ 删除''', '''${__('events.delete')}'''),
    ('''✏️ 编辑''', '''${__('events.edit')}'''),
    # toast
    ('''toast('请填写活动标题和时间', 'error')''', '''toast(__('events.title_time_required'), 'error')'''),
    ('''toast('活动标题不能为空', 'error')''', '''toast(__('events.title_required'), 'error')'''),
    ('''toast('活动开始时间不能为空', 'error')''', '''toast(__('events.start_time_required'), 'error')'''),
    ('''toast('活动结束时间不能为空', 'error')''', '''toast(__('events.end_time_required'), 'error')'''),
    ('''toast('活动已更新', 'success')''', '''toast(__('events.updated'), 'success')'''),
    ('''toast('活动已删除', 'success')''', '''toast(__('events.deleted'), 'success')'''),
    ('''toast('活动已发布', 'success')''', '''toast(__('events.created'), 'success')'''),
    ('''toast('活动发布失败：' + err.message, 'error')''', '''toast(__('events.create_failed') + ': ' + err.message, 'error')'''),
    ('''toast('活动已取消发布', 'info')''', '''toast(__('events.unpublished'), 'info')'''),
    ('''toast('评论已删除', 'success')''', '''toast(__('events.comment_deleted'), 'success')'''),
    ('''toast('删除失败', 'error')''', '''toast(__('events.delete_failed'), 'error')'''),
    ('''toast('操作失败', 'error')''', '''toast(__('events.op_failed'), 'error')'''),
    ('''showConfirm('确定删除此评论？', async () => {''', '''showConfirm(__('events.confirm_delete_comment'), async () => {'''),
    ('''showConfirm('标记该活动全员签到？', async () => {''', '''showConfirm(__('events.confirm_sign_all'), async () => {'''),
    ('''toast('全员签到成功！', 'success')''', '''toast(__('events.sign_all_ok'), 'success')'''),
    ('''暂无评论''', '''${__('events.no_comments')}'''),
    ('''暂无报名''', '''${__('events.no_signups')}'''),
    ('''暂无签到''', '''${__('events.no_signins')}'''),
    ('''扫码签到''', '''${__('events.qr_signin')}'''),
    ('''签到二维码''', '''${__('events.qr_title')}'''),
    ('''📱 签到二维码''', '''${__('events.qr_label')}'''),
    # 活动详情
    ('''🌐 公开''', '''${__('events.public')}'''),
    ('''🔒 成员专属''', '''${__('events.member_only')}'''),
    ('''✅ 已签到''', '''${__('events.signed')}'''),
    ('''⬜ 未签到''', '''${__('events.not_signed')}'''),
    ('''📅 开始时间：''', '''${__('events.start_time')}'''),
    ('''📅 结束时间：''', '''${__('events.end_time')}'''),
    ('''📍 地点：''', '''${__('events.location')}'''),
    ('''👥 已报名 (''', '''${__('events.signed_up')} ('''),
    ('''👥 已签到 (''', '''${__('events.signed_in')} ('''),
]

# ==================== profile-page.js (61处) ====================
RULES['profile-page.js'] = [
    ('''加载中...''', '''${__('profile_page.loading')}'''),
    ('''暂无内容''', '''${__('profile_page.no_content')}'''),
    ('''✏️ 编辑资料''', '''${__('profile_page.edit_profile')}'''),
    ('''📷 新建相册''', '''${__('profile_page.new_album')}'''),
    ('''🎬 上传视频''', '''${__('profile_page.upload_video')}'''),
    ('''上传中...''', '''${__('profile_page.uploading')}'''),
    ('''上传文件中...''', '''${__('profile_page.uploading_file')}'''),
    ('''处理中...''', '''${__('profile_page.processing')}'''),
    ('''确定删除该相册？此操作不可恢复。''', '''${__('profile_page.confirm_delete_album')}'''),
    ('''确定删除该视频？''', '''${__('profile_page.confirm_delete_video')}'''),
    ('''🌍 公开''', '''${__('profile_page.public')}'''),
    ('''👥 成员''', '''${__('profile_page.member')}'''),
    ('''🔒 私密''', '''${__('profile_page.private')}'''),
    ('''未知用户''', '''${__('profile_page.unknown_user')}'''),
    ('''未命名视频''', '''${__('profile_page.unnamed_video')}'''),
    ('''尚未填写个人简介...''', '''${__('profile_page.no_bio')}'''),
    ('''toast('头像已更新', 'success')''', '''toast(__('profile_page.avatar_updated'), 'success')'''),
    ('''toast('头像上传失败', 'error')''', '''toast(__('profile_page.avatar_upload_failed'), 'error')'''),
    ('''toast('资料已更新', 'success')''', '''toast(__('profile_page.profile_updated'), 'success')'''),
    ('''toast('更新失败', 'error')''', '''toast(__('profile_page.update_failed'), 'error')'''),
    ('''toast('姓名不能为空', 'error')''', '''toast(__('profile_page.name_required'), 'error')'''),
    ('''toast('相册已创建', 'success')''', '''toast(__('profile_page.album_created'), 'success')'''),
    ('''toast('相册已删除', 'success')''', '''toast(__('profile_page.album_deleted'), 'success')'''),
    ('''toast('视频已上传', 'success')''', '''toast(__('profile_page.video_uploaded'), 'success')'''),
    ('''toast('视频已删除', 'success')''', '''toast(__('profile_page.video_deleted'), 'success')'''),
    ('''加载失败''', '''${__('profile_page.load_failed')}'''),
]

# ==================== album.js (57处) ====================
RULES['album.js'] = [
    ('''全部分类''', '''${__('album.all_categories')}'''),
    ('''暂无照片''', '''${__('album.no_photos')}'''),
    ('''无描述''', '''${__('album.no_desc')}'''),
    ('''toast('已点赞', 'success')''', '''toast(__('album.liked'), 'success')'''),
    ('''toast('点赞失败', 'error')''', '''toast(__('album.like_failed'), 'error')'''),
    ('''toast('链接已复制', 'info')''', '''toast(__('album.link_copied'), 'info')'''),
    ('''toast('批量删除', '')''', '''toast(__('album.batch_delete'), '')'''),
    ('''回收站空空如也''', '''${__('album.trash_empty')}'''),
    ('''上传者：''', '''${__('album.uploader')}'''),
    ('''↩ 恢复''', '''${__('album.restore')}'''),
    ('''🗑 永久删除''', '''${__('album.permanent_delete')}'''),
    ('''请输入新分类名称：''', '''${__('album.enter_category_name')}'''),
    ('''没有可删除的分类''', '''${__('album.no_category_to_delete')}'''),
    ('''选择要删除的分类：''', '''${__('album.select_category_delete')}'''),
    ('''该分类下的照片将移至"未分类"。''', '''${__('album.delete_category_warn')}'''),
    ('''showConfirm('确定删除所选 N 张照片？（会移入回收站）', async () => {''',
     '''showConfirm(__('album.confirm_batch_delete'), async () => {'''),
    ('''showConfirm('确定删除以下分类？该分类下的照片将移至"未分类"。', async () => {''',
     '''showConfirm(__('album.confirm_delete_category'), async () => {'''),
    ('''toast('分类已删除', 'success')''', '''toast(__('album.category_deleted'), 'success')'''),
    ('''toast('名称不能为空', 'warning')''', '''toast(__('album.name_required'), 'warning')'''),
    ('''暂无公告''', '''${__('album.no_announcements')}'''),
]

# ==================== profile.js (54处) ====================
RULES['profile.js'] = [
    ('''toast('签名已保存', 'success')''', '''toast(__('profile.motto_saved'), 'success')'''),
    ('''toast('简介已保存', 'success')''', '''toast(__('profile.bio_saved'), 'success')'''),
    ('''toast('头像已更新', 'success')''', '''toast(__('profile.avatar_updated'), 'success')'''),
    ('''toast('已切换为 VRChat 头像', 'success')''', '''toast(__('profile.avatar_switched_vrc'), 'success')'''),
    ('''toast('更新失败', 'error')''', '''toast(__('profile.update_failed'), 'error')'''),
    ('''showConfirm('确定移除头像？', async () => {''', '''showConfirm(__('profile.confirm_remove_avatar'), async () => {'''),
    ('''toast('头像已移除', 'success')''', '''toast(__('profile.avatar_removed'), 'success')'''),
    ('''请输入 VRChat 用户名''', '''${__('profile.enter_vrc_username')}'''),
    ('''请输入 VRChat 密码''', '''${__('profile.enter_vrc_password')}'''),
    ('''验证中...''', '''${__('profile.verifying')}'''),
    ('''绑定成功！''', '''${__('profile.bind_success')}'''),
    ('''请先登录''', '''${__('profile.login_first')}'''),
    ('''您的浏览器不支持定位功能''', '''${__('profile.gps_not_supported')}'''),
    ('''正在获取位置…''', '''${__('profile.gps_getting')}'''),
    ('''位置已更新''', '''${__('profile.gps_updated')}'''),
    ('''请填写当前密码和新密码''', '''${__('profile.enter_passwords')}'''),
    ('''两次密码不一致''', '''${__('profile.passwords_not_match')}'''),
    ('''修改失败''', '''${__('profile.change_failed')}'''),
    ('''改名申请已提交''', '''${__('profile.name_change_submitted')}'''),
    ('''加载中...''', '''${__('profile.loading')}'''),
    ('''暂未报名任何活动''', '''${__('profile.no_events')}'''),
    ('''加载失败''', '''${__('profile.load_failed')}'''),
    ('''toast('绑定失败：' + err.message, 'error')''', '''toast(__('profile.bind_failed') + ': ' + err.message, 'error')'''),
    ('''toast('密码修改失败：' + err.message, 'error')''', '''toast(__('profile.pwd_change_failed') + ': ' + err.message, 'error')'''),
    ('''toast('改名失败', 'error')''', '''toast(__('profile.name_change_failed'), 'error')'''),
    ('''toast('已绑定 VRChat', 'success')''', '''toast(__('profile.vrc_bound'), 'success')'''),
]

# ==================== posts.js (46处) ====================
RULES['posts.js'] = [
    ('''加载中...''', '''${__('posts.loading')}'''),
    ('''加载失败''', '''${__('posts.load_failed')}'''),
    ('''还没有动态，来发布第一条''', '''${__('posts.empty')}'''),
    ('''💬 评论''', '''${__('posts.comment_btn')}'''),
    ('''📌 置顶''', '''${__('posts.pin')}'''),
    ('''🗑️ 删除''', '''${__('posts.delete')}'''),
    ('''placeholder="分享你的日常..."''', '''placeholder="${__('posts.share_placeholder')}"'''),
    ('''placeholder="说点什么..."''', '''placeholder="${__('posts.placeholder')}"'''),
    ('''toast('请先登录', 'error')''', '''toast(__('posts.login_first'), 'error')'''),
    ('''toast('操作失败', 'error')''', '''toast(__('posts.op_failed'), 'error')'''),
    ('''toast('评论失败', 'error')''', '''toast(__('posts.comment_failed'), 'error')'''),
    ('''toast('已删除', 'success')''', '''toast(__('posts.deleted'), 'success')'''),
    ('''toast('已置顶', 'success')''', '''toast(__('posts.pinned'), 'success')'''),
    ('''‹ 上一张''', '''${__('posts.prev')}'''),
    ('''下一张 ›''', '''${__('posts.next')}'''),
    ('''showConfirm('确定删除此动态？', async () => {''', '''showConfirm(__('posts.confirm_delete'), async () => {'''),
    ('''showConfirm('确定删除此评论？', async () => {''', '''showConfirm(__('posts.confirm_delete_comment'), async () => {'''),
    ('''toast('已取消置顶', 'success')''', '''toast(__('posts.unpinned'), 'success')'''),
    ('''toast('暂无更多动态', 'info')''', '''toast(__('posts.no_more'), 'info')'''),
    ('''暂无更多动态''', '''${__('posts.no_more')}'''),
]

# ==================== auth.js (41处) ====================
RULES['auth.js'] = [
    ('''toast('登录成功', 'success')''', '''toast(__('auth.login_ok'), 'success')'''),
    ('''toast('登录失败：' + err.message, 'error')''', '''toast(__('auth.login_failed') + ': ' + err.message, 'error')'''),
    ('''toast('账号已被禁用', 'error')''', '''toast(__('auth.account_disabled'), 'error')'''),
    ('''toast('会话已过期', 'error')''', '''toast(__('auth.session_expired'), 'error')'''),
    ('''toast('输入验证码', 'error')''', '''toast(__('auth.enter_code'), 'error')'''),
    ('''toast('请先发送验证码', 'error')''', '''toast(__('auth.send_code_first'), 'error')'''),
    ('''toast('请求超时，请重试', 'error')''', '''toast(__('auth.timeout_retry'), 'error')'''),
    ('''toast('VRChat 登录成功', 'success')''', '''toast(__('auth.vrc_login_ok'), 'success')'''),
    ('''toast('网络错误：' + err.message, 'error')''', '''toast(__('auth.network_error') + ': ' + err.message, 'error')'''),
    ('''toast(errData.error || '登录失败', 'error')''', '''toast(errData.error || __('auth.login_failed'), 'error')'''),
    ('''textContent = '登录中...' ''', '''textContent = __('auth.logging_in') '''),
    ('''textContent = '发送中...' ''', '''textContent = __('auth.sending') '''),
    ('''textContent = '发送验证码' ''', '''textContent = __('auth.send_code') '''),
    ('''textContent = '重新发送' ''', '''textContent = __('auth.resend') '''),
    ('''textContent = '登录成功！' ''', '''textContent = __('auth.login_ok_excl') '''),
    ('''已绑定 VRChat，可直接使用 VRChat 登录''', '''${__('auth.vrc_bound_hint')}'''),
]

# ==================== chat.js (35处) ====================
RULES['chat.js'] = [
    ('''👥 群聊''', '''${__('chat.group_chat')}'''),
    ('''💬 私信''', '''${__('chat.dm')}'''),
    ('''暂无聊天记录''', '''${__('chat.no_history')}'''),
    ('''发送第一条消息吧 👋''', '''${__('chat.first_message_emoji')}'''),
    ('''群聊开始 👋''', '''${__('chat.group_start')}'''),
    ('''➕ 创建群聊''', '''${__('chat.create_group')}'''),
    ('''群聊名称''', '''${__('chat.group_name')}'''),
    ('''选择成员''', '''${__('chat.select_members')}'''),
    ('''← 返回''', '''${__('chat.back')}'''),
    ('''📍 实时共享位置''', '''${__('chat.share_location')}'''),
    ('''toast('浏览器不支持定位', 'error')''', '''toast(__('chat.gps_not_supported'), 'error')'''),
    ('''toast('定位权限被拒', 'error')''', '''toast(__('chat.gps_permission_denied'), 'error')'''),
    ('''toast('获取位置失败', 'error')''', '''toast(__('chat.gps_failed'), 'error')'''),
    ('''toast('已停止共享位置', 'info')''', '''toast(__('chat.location_stopped'), 'info')'''),
    ('''📍 位置共享''', '''${__('chat.location_sharing')}'''),
    ('''📍 我开启了实时位置共享''', '''${__('chat.location_started_msg')}'''),
    ('''📍 已关闭实时位置共享''', '''${__('chat.location_stopped_msg')}'''),
    ('''该用户未开启位置共享''', '''${__('chat.user_no_location')}'''),
    ('''获取位置信息失败''', '''${__('chat.gps_info_failed')}'''),
    ('''toast('创建成功', 'success')''', '''toast(__('chat.create_ok'), 'success')'''),
    ('''toast('加载失败', 'error')''', '''toast(__('chat.load_failed'), 'error')'''),
]

# ==================== core.js (30处) ====================
RULES['core.js'] = [
    ('''toast('会话已过期，请重新登录', 'error')''', '''toast(__('session_expired'), 'error')'''),
    ('''toast('会话已过期', 'error')''', '''toast(__('session_expired'), 'error')'''),
    ('''toast(errData.error || '权限不足', 'error')''', '''toast(errData.error || __('permission_denied'), 'error')'''),
    ('''toast('操作过于频繁，请稍后再试', 'error')''', '''toast(__('rate_limited'), 'error')'''),
    ('''toast('服务器错误，请稍后重试', 'error')''', '''toast(__('server_error'), 'error')'''),
    ('''toast('网络请求超时', 'error')''', '''toast(__('request_timeout'), 'error')'''),
    ('''toast('网络连接失败', 'error')''', '''toast(__('network_error'), 'error')'''),
    ('''toast('上传已取消', 'info')''', '''toast(__('upload_cancelled'), 'info')'''),
    ('''toast('上传超时', 'error')''', '''toast(__('upload_timeout'), 'error')'''),
    ('''return '未知';''', '''return __('unknown');'''),
]

# ==================== map.js (27处) ====================
RULES['map.js'] = [
    ('''地图加载失败，请检查网络''', '''${__('map.load_failed')}'''),
    ('''⚠️ 地图加载失败，请刷新重试''', '''${__('map.load_failed_retry')}'''),
    ('''💬 发消息''', '''${__('map.send_message')}'''),
    ('''🟢 位置共享中''', '''${__('map.sharing_location')}'''),
    ('''📍 共享我的位置''', '''${__('map.share_my_location')}'''),
    ('''🔴 停止共享''', '''${__('map.stop_sharing')}'''),
    ('''未知用户''', '''${__('map.unknown_user')}'''),
    ('''暂无关联 World 的活动''', '''${__('map.no_world_events')}'''),
    ('''未知世界''', '''${__('map.unknown_world')}'''),
    ('''加载失败''', '''${__('map.load_failed')}'''),
    ('''toast('位置上传失败', 'error')''', '''toast(__('map.location_upload_failed'), 'error')'''),
    ('''toast('位置获取失败', 'error')''', '''toast(__('map.location_fetch_failed'), 'error')'''),
]

# ==================== main.js (25处) ====================
RULES['main.js'] = [
    ('''${msg.count || 0} 在线''', '''${__('main.online_count', {n: msg.count || 0})}'''),
    ('''未知用户''', '''${__('main.unknown_user')}'''),
    ('''（我）''', '''${__('main.me')}'''),
    ('''title="在线"''', '''title="${__('main.online')}"'''),
    ('''aria-label="在线"''', '''aria-label="${__('main.online')}"'''),
    ('''🟢 当前在线 <span id="onlineUsersCount" class="text-accent"></span> 人''', '''${__('main.online_users')} <span id="onlineUsersCount" class="text-accent"></span>'''),
    ('''关闭''', '''${__('main.close')}'''),
    ('''未找到相关结果''', '''${__('main.no_results')}'''),
    ('''搜索失败''', '''${__('main.search_failed')}'''),
    ('''toast('上传失败：' + err.message, 'error')''', '''toast(__('main.upload_failed') + ': ' + err.message, 'error')'''),
    ('''showConfirm('确定报名此活动？', async () => {''', '''showConfirm(__('main.confirm_signup'), async () => {'''),
    ('''toast('报名失败：' + err.message, 'error')''', '''toast(__('main.signup_failed') + ': ' + err.message, 'error')'''),
    ('''showConfirm('确定取消报名？', async () => {''', '''showConfirm(__('main.confirm_cancel_signup'), async () => {'''),
    ('''toast('已取消报名', 'info')''', '''toast(__('main.signup_cancelled'), 'info')'''),
    ('''toast('操作失败：' + err.message, 'error')''', '''toast(__('main.op_failed') + ': ' + err.message, 'error')'''),
    ('''toast('请选择图片或视频文件', 'error')''', '''toast(__('main.select_media'), 'error')'''),
    ('''上传中...''', '''${__('main.uploading')}'''),
    ('''处理中...''', '''${__('main.processing')}'''),
    ('''toast('上传成功', 'success')''', '''toast(__('main.upload_ok'), 'success')'''),
]

# ==================== birthday.js (24处) ====================
RULES['birthday.js'] = [
    ('''暂无生日信息''', '''${__('birthday.no_birthdays')}'''),
    ('''暂无生日派对''', '''${__('birthday.no_parties')}'''),
    ('''🎉 今天生日!''', '''${__('birthday.today')}'''),
    ('''为 N 创建生日派对活动？''', '''${__('birthday.create_party_prompt')}'''),
    ('''🎂 N 的生日派对''', '''${__('birthday.party_title')}'''),
    ('''一起来庆祝吧！''', '''${__('birthday.celebrate')}'''),
    ('''toast('创建失败', 'error')''', '''toast(__('birthday.create_failed'), 'error')'''),
    ('''toast('加载失败', 'error')''', '''toast(__('birthday.load_failed'), 'error')'''),
    ('''toast('生日派对已更新', 'success')''', '''toast(__('birthday.party_updated'), 'success')'''),
    ('''toast('生日派对已删除', 'success')''', '''toast(__('birthday.party_deleted'), 'success')'''),
    ('''✏️ 编辑生日派对''', '''${__('birthday.edit_party')}'''),
    ('''🎂 创建生日派对''', '''${__('birthday.create_party')}'''),
    ('''showConfirm('确定删除此生日派对？', async () => {''', '''showConfirm(__('birthday.confirm_delete_party'), async () => {'''),
]

# ==================== announcements.js (17处) ====================
RULES['announcements.js'] = [
    ('''暂无公告''', '''${__('announcements.no_announcements')}'''),
    ('''📌 置顶''', '''${__('announcements.pin')}'''),
    ('''🌐 公开''', '''${__('announcements.public')}'''),
    ('''🔒 成员专属''', '''${__('announcements.member_only')}'''),
    ('''toast('详情弹窗不在页面中', 'error')''', '''toast(__('announcements.modal_not_found'), 'error')'''),
    ('''📅 发布于''', '''${__('announcements.published_at')}'''),
    ('''✏️ 编辑''', '''${__('announcements.edit')}'''),
    ('''🗑️ 删除''', '''${__('announcements.delete')}'''),
    ('''✏️ 编辑公告''', '''${__('announcements.edit_title')}'''),
    ('''📢 发布公告''', '''${__('announcements.publish_title')}'''),
    ('''showConfirm('确定删除此公告？', async () => {''', '''showConfirm(__('announcements.confirm_delete'), async () => {'''),
]

# ==================== ui.js (13处) ====================
RULES['ui.js'] = [
    ('''currentUser.displayName || currentUser.loginId || '未知用户' ''', '''currentUser.displayName || currentUser.loginId || __('unknown') '''),
    ('''暂无通知''', '''${__('ui.no_notifications')}'''),
    ('''title="删除"''', '''title="${__('ui.delete')}"'''),
    ('''toast('已全部标记已读', 'success')''', '''toast(__('ui.all_read'), 'success')'''),
    ('''toast('操作失败', 'error')''', '''toast(__('ui.op_failed'), 'error')'''),
    ('''toast('删除失败', 'error')''', '''toast(__('ui.delete_failed'), 'error')'''),
    ('''showConfirm('确定清空所有通知？此操作不可恢复', async () => {''', '''showConfirm(__('ui.confirm_clear_notifications'), async () => {'''),
    ('''toast('已清空所有通知', 'info')''', '''toast(__('ui.notifications_cleared'), 'info')'''),
    ('''const labels = ['', '弱', '中', '强', '非常强'];''', '''const labels = ['', __('ui.weak'), __('ui.medium'), __('ui.strong'), __('ui.very_strong')];'''),
    ('''match.textContent = pwd1 === pwd2 ? '✅ 密码一致' : '❌ 密码不一致';''', '''match.textContent = pwd1 === pwd2 ? __('ui.pwd_match') : __('ui.pwd_not_match');'''),
    ('''toast('主题已重置为默认', 'success')''', '''toast(__('ui.theme_reset'), 'success')'''),
]

# ==================== members.js (13处) ====================
RULES['members.js'] = [
    ('''暂无成员''', '''${__('members.no_members')}'''),
    ('''📍 位置''', '''${__('members.location')}'''),
    ('''👤 名片''', '''${__('members.card')}'''),
    ('''🎮 VRChat：''', '''${__('members.vrc')}'''),
    ('''📅 加入：''', '''${__('members.joined')}'''),
    ('''N 个活动''', '''${__('members.n_events')}'''),
    ('''N 张照片''', '''${__('members.n_photos')}'''),
    ('''✏️ 编辑资料''', '''${__('members.edit_profile')}'''),
    ('''📋 完整资料''', '''${__('members.full_profile')}'''),
    ('''toast('正在加载该用户的活动...', 'info')''', '''toast(__('members.loading_events'), 'info')'''),
    ('''toast('正在加载该用户的照片...', 'info')''', '''toast(__('members.loading_photos'), 'info')'''),
]

# ==================== init.js (7处) ====================
RULES['init.js'] = [
    ('''toast('请填写登录ID和密码', 'error')''', '''toast(__('init.fill_id_pwd'), 'error')'''),
    ('''toast('两次密码输入不一致', 'error')''', '''toast(__('init.pwds_not_match'), 'error')'''),
    ('''toast('密码强度不足（需至少8位，含大小写字母、数字、特殊字符）', 'error')''',
     '''toast(__('init.pwd_weak'), 'error')'''),
    ('''toast('超级管理员创建成功！正在登录...', 'success')''', '''toast(__('init.create_ok'), 'success')'''),
    ('''toast(data.error || '初始化失败', 'error')''', '''toast(data.error || __('init.init_failed'), 'error')'''),
    ('''toast('初始化请求失败：' + err.message, 'error')''', '''toast(__('init.init_req_failed') + ': ' + err.message, 'error')'''),
]


# ==================== 核心替换引擎 ====================

def load_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        return f.read()

def save_file(filepath, content):
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

def apply_rules(content, rules, filename):
    applied = []
    modified = content
    for old, new in rules:
        if old in modified:
            count = modified.count(old)
            modified = modified.replace(old, new)
            applied.append((old[:60], new[:60], count))
        else:
            print(f"  ⚠ [{filename}] 未匹配: {old[:70]}")
    return modified, applied

def generate_all_keys():
    """生成所有需要添加的 i18n 键（zh）"""
    keys = {}
    
    # events
    events = {
        'events.month_1': "'一月'", 'events.month_2': "'二月'", 'events.month_3': "'三月'",
        'events.month_4': "'四月'", 'events.month_5': "'五月'", 'events.month_6': "'六月'",
        'events.month_7': "'七月'", 'events.month_8': "'八月'", 'events.month_9': "'九月'",
        'events.month_10': "'十月'", 'events.month_11': "'十一月'", 'events.month_12': "'十二月'",
        'events.day_sun': "'日'", 'events.day_mon': "'一'", 'events.day_tue': "'二'",
        'events.day_wed': "'三'", 'events.day_thu': "'四'", 'events.day_fri': "'五'", 'events.day_sat': "'六'",
        'events.count_events': "'{n}个活动'",
        'events.no_events': "'暂无活动'",
        'events.loading': "'加载中...'",
        'events.load_failed': "'加载失败'",
        'events.public': "'🌐 公开'",
        'events.member_only': "'🔒 成员专属'",
        'events.sign_in': "'签到'",
        'events.signed': "'✅ 已签到'",
        'events.not_signed': "'⬜ 未签到'",
        'events.delete': "'🗑️ 删除'",
        'events.edit': "'✏️ 编辑'",
        'events.title_time_required': "'请填写活动标题和时间'",
        'events.title_required': "'活动标题不能为空'",
        'events.start_time_required': "'活动开始时间不能为空'",
        'events.end_time_required': "'活动结束时间不能为空'",
        'events.updated': "'活动已更新'",
        'events.deleted': "'活动已删除'",
        'events.created': "'活动已发布'",
        'events.create_failed': "'活动发布失败'",
        'events.unpublished': "'活动已取消发布'",
        'events.comment_deleted': "'评论已删除'",
        'events.delete_failed': "'删除失败'",
        'events.op_failed': "'操作失败'",
        'events.confirm_delete_comment': "'确定删除此评论？'",
        'events.confirm_sign_all': "'标记该活动全员签到？'",
        'events.sign_all_ok': "'全员签到成功！'",
        'events.no_comments': "'暂无评论'",
        'events.no_signups': "'暂无报名'",
        'events.no_signins': "'暂无签到'",
        'events.qr_signin': "'扫码签到'",
        'events.qr_title': "'签到二维码'",
        'events.qr_label': "'📱 签到二维码'",
        'events.start_time': "'📅 开始时间：'",
        'events.end_time': "'📅 结束时间：'",
        'events.location': "'📍 地点：'",
        'events.signed_up': "'👥 已报名'",
        'events.signed_in': "'👥 已签到'",
    }
    keys.update(events)
    
    # profile_page
    pp = {
        'profile_page.loading': "'加载中...'",
        'profile_page.no_content': "'暂无内容'",
        'profile_page.edit_profile': "'✏️ 编辑资料'",
        'profile_page.new_album': "'📷 新建相册'",
        'profile_page.upload_video': "'🎬 上传视频'",
        'profile_page.uploading': "'上传中...'",
        'profile_page.uploading_file': "'上传文件中...'",
        'profile_page.processing': "'处理中...'",
        'profile_page.confirm_delete_album': "'确定删除该相册？此操作不可恢复。'",
        'profile_page.confirm_delete_video': "'确定删除该视频？'",
        'profile_page.public': "'🌍 公开'",
        'profile_page.member': "'👥 成员'",
        'profile_page.private': "'🔒 私密'",
        'profile_page.unknown_user': "'未知用户'",
        'profile_page.unnamed_video': "'未命名视频'",
        'profile_page.no_bio': "'尚未填写个人简介...'",
        'profile_page.avatar_updated': "'头像已更新'",
        'profile_page.avatar_upload_failed': "'头像上传失败'",
        'profile_page.profile_updated': "'资料已更新'",
        'profile_page.update_failed': "'更新失败'",
        'profile_page.name_required': "'姓名不能为空'",
        'profile_page.album_created': "'相册已创建'",
        'profile_page.album_deleted': "'相册已删除'",
        'profile_page.video_uploaded': "'视频已上传'",
        'profile_page.video_deleted': "'视频已删除'",
        'profile_page.load_failed': "'加载失败'",
    }
    keys.update(pp)
    
    # album
    album = {
        'album.all_categories': "'全部分类'",
        'album.no_photos': "'暂无照片'",
        'album.no_desc': "'无描述'",
        'album.liked': "'已点赞'",
        'album.like_failed': "'点赞失败'",
        'album.link_copied': "'链接已复制'",
        'album.batch_delete': "'批量删除'",
        'album.trash_empty': "'回收站空空如也'",
        'album.uploader': "'上传者：'",
        'album.restore': "'↩ 恢复'",
        'album.permanent_delete': "'🗑 永久删除'",
        'album.enter_category_name': "'请输入新分类名称：'",
        'album.no_category_to_delete': "'没有可删除的分类'",
        'album.select_category_delete': "'选择要删除的分类：'",
        'album.delete_category_warn': "'该分类下的照片将移至\"未分类\"。'",
        'album.confirm_batch_delete': "'确定删除所选照片？（会移入回收站）'",
        'album.confirm_delete_category': "'确定删除以下分类？该分类下的照片将移至\"未分类\"。'",
        'album.category_deleted': "'分类已删除'",
        'album.name_required': "'名称不能为空'",
        'album.no_announcements': "'暂无公告'",
    }
    keys.update(album)
    
    # profile
    prof = {
        'profile.motto_saved': "'签名已保存'",
        'profile.bio_saved': "'简介已保存'",
        'profile.avatar_updated': "'头像已更新'",
        'profile.avatar_switched_vrc': "'已切换为 VRChat 头像'",
        'profile.update_failed': "'更新失败'",
        'profile.confirm_remove_avatar': "'确定移除头像？'",
        'profile.avatar_removed': "'头像已移除'",
        'profile.enter_vrc_username': "'请输入 VRChat 用户名'",
        'profile.enter_vrc_password': "'请输入 VRChat 密码'",
        'profile.verifying': "'验证中...'",
        'profile.bind_success': "'绑定成功！'",
        'profile.login_first': "'请先登录'",
        'profile.gps_not_supported': "'您的浏览器不支持定位功能'",
        'profile.gps_getting': "'正在获取位置…'",
        'profile.gps_updated': "'位置已更新'",
        'profile.enter_passwords': "'请填写当前密码和新密码'",
        'profile.passwords_not_match': "'两次密码不一致'",
        'profile.change_failed': "'修改失败'",
        'profile.name_change_submitted': "'改名申请已提交'",
        'profile.loading': "'加载中...'",
        'profile.no_events': "'暂未报名任何活动'",
        'profile.load_failed': "'加载失败'",
        'profile.bind_failed': "'绑定失败'",
        'profile.pwd_change_failed': "'密码修改失败'",
        'profile.name_change_failed': "'改名失败'",
        'profile.vrc_bound': "'已绑定 VRChat'",
    }
    keys.update(prof)
    
    # posts
    posts = {
        'posts.loading': "'加载中...'",
        'posts.load_failed': "'加载失败'",
        'posts.empty': "'还没有动态，来发布第一条'",
        'posts.comment_btn': "'💬 评论'",
        'posts.pin': "'📌 置顶'",
        'posts.delete': "'🗑️ 删除'",
        'posts.share_placeholder': "'分享你的日常...'",
        'posts.login_first': "'请先登录'",
        'posts.op_failed': "'操作失败'",
        'posts.comment_failed': "'评论失败'",
        'posts.deleted': "'已删除'",
        'posts.pinned': "'已置顶'",
        'posts.prev': "'‹ 上一张'",
        'posts.next': "'下一张 ›'",
        'posts.confirm_delete': "'确定删除此动态？'",
        'posts.confirm_delete_comment': "'确定删除此评论？'",
        'posts.unpinned': "'已取消置顶'",
        'posts.no_more': "'暂无更多动态'",
    }
    keys.update(posts)
    
    # auth
    auth = {
        'auth.login_ok': "'登录成功'",
        'auth.login_failed': "'登录失败'",
        'auth.account_disabled': "'账号已被禁用'",
        'auth.session_expired': "'会话已过期'",
        'auth.enter_code': "'输入验证码'",
        'auth.send_code_first': "'请先发送验证码'",
        'auth.timeout_retry': "'请求超时，请重试'",
        'auth.vrc_login_ok': "'VRChat 登录成功'",
        'auth.network_error': "'网络错误'",
        'auth.logging_in': "'登录中...'",
        'auth.sending': "'发送中...'",
        'auth.send_code': "'发送验证码'",
        'auth.resend': "'重新发送'",
        'auth.login_ok_excl': "'登录成功！'",
        'auth.vrc_bound_hint': "'已绑定 VRChat，可直接使用 VRChat 登录'",
    }
    keys.update(auth)
    
    # chat
    chat = {
        'chat.group_chat': "'👥 群聊'",
        'chat.dm': "'💬 私信'",
        'chat.no_history': "'暂无聊天记录'",
        'chat.first_message_emoji': "'发送第一条消息吧 👋'",
        'chat.group_start': "'群聊开始 👋'",
        'chat.create_group': "'➕ 创建群聊'",
        'chat.group_name': "'群聊名称'",
        'chat.select_members': "'选择成员'",
        'chat.back': "'← 返回'",
        'chat.share_location': "'📍 实时共享位置'",
        'chat.gps_not_supported': "'浏览器不支持定位'",
        'chat.gps_permission_denied': "'定位权限被拒'",
        'chat.gps_failed': "'获取位置失败'",
        'chat.location_stopped': "'已停止共享位置'",
        'chat.location_sharing': "'📍 位置共享'",
        'chat.location_started_msg': "'📍 我开启了实时位置共享'",
        'chat.location_stopped_msg': "'📍 已关闭实时位置共享'",
        'chat.user_no_location': "'该用户未开启位置共享'",
        'chat.gps_info_failed': "'获取位置信息失败'",
        'chat.create_ok': "'创建成功'",
        'chat.load_failed': "'加载失败'",
    }
    keys.update(chat)
    
    # main
    main_keys = {
        'main.online_count': "'{n} 在线'",
        'main.unknown_user': "'未知用户'",
        'main.me': "'（我）'",
        'main.online': "'在线'",
        'main.online_users': "'🟢 当前在线'",
        'main.close': "'关闭'",
        'main.no_results': "'未找到相关结果'",
        'main.search_failed': "'搜索失败'",
        'main.upload_failed': "'上传失败'",
        'main.confirm_signup': "'确定报名此活动？'",
        'main.signup_failed': "'报名失败'",
        'main.confirm_cancel_signup': "'确定取消报名？'",
        'main.signup_cancelled': "'已取消报名'",
        'main.op_failed': "'操作失败'",
        'main.select_media': "'请选择图片或视频文件'",
        'main.uploading': "'上传中...'",
        'main.processing': "'处理中...'",
        'main.upload_ok': "'上传成功'",
    }
    keys.update(main_keys)
    
    # map
    map_keys = {
        'map.load_failed': "'加载失败'",
        'map.load_failed_retry': "'⚠️ 地图加载失败，请刷新重试'",
        'map.send_message': "'💬 发消息'",
        'map.sharing_location': "'🟢 位置共享中'",
        'map.share_my_location': "'📍 共享我的位置'",
        'map.stop_sharing': "'🔴 停止共享'",
        'map.unknown_user': "'未知用户'",
        'map.no_world_events': "'暂无关联 World 的活动'",
        'map.unknown_world': "'未知世界'",
        'map.location_upload_failed': "'位置上传失败'",
        'map.location_fetch_failed': "'位置获取失败'",
    }
    keys.update(map_keys)
    
    # birthday
    bday = {
        'birthday.no_birthdays': "'暂无生日信息'",
        'birthday.no_parties': "'暂无生日派对'",
        'birthday.create_party_prompt': "'为Ta创建生日派对活动？'",
        'birthday.party_title': "'🎂 的生日派对'",
        'birthday.celebrate': "'一起来庆祝吧！'",
        'birthday.create_failed': "'创建失败'",
        'birthday.party_updated': "'生日派对已更新'",
        'birthday.party_deleted': "'生日派对已删除'",
        'birthday.edit_party': "'✏️ 编辑生日派对'",
        'birthday.create_party': "'🎂 创建生日派对'",
        'birthday.confirm_delete_party': "'确定删除此生日派对？'",
    }
    keys.update(bday)
    
    # announcements
    ann = {
        'announcements.no_announcements': "'暂无公告'",
        'announcements.pin': "'📌 置顶'",
        'announcements.public': "'🌐 公开'",
        'announcements.member_only': "'🔒 成员专属'",
        'announcements.modal_not_found': "'详情弹窗不在页面中'",
        'announcements.published_at': "'📅 发布于'",
        'announcements.edit': "'✏️ 编辑'",
        'announcements.delete': "'🗑️ 删除'",
        'announcements.edit_title': "'✏️ 编辑公告'",
        'announcements.publish_title': "'📢 发布公告'",
        'announcements.confirm_delete': "'确定删除此公告？'",
    }
    keys.update(ann)
    
    # ui
    ui = {
        'ui.no_notifications': "'暂无通知'",
        'ui.delete': "'删除'",
        'ui.all_read': "'已全部标记已读'",
        'ui.op_failed': "'操作失败'",
        'ui.delete_failed': "'删除失败'",
        'ui.confirm_clear_notifications': "'确定清空所有通知？此操作不可恢复'",
        'ui.notifications_cleared': "'已清空所有通知'",
        'ui.weak': "'弱'",
        'ui.medium': "'中'",
        'ui.strong': "'强'",
        'ui.very_strong': "'非常强'",
        'ui.pwd_match': "'✅ 密码一致'",
        'ui.pwd_not_match': "'❌ 密码不一致'",
        'ui.theme_reset': "'主题已重置为默认'",
    }
    keys.update(ui)
    
    # members
    members = {
        'members.no_members': "'暂无成员'",
        'members.location': "'📍 位置'",
        'members.card': "'👤 名片'",
        'members.vrc': "'🎮 VRChat：'",
        'members.joined': "'📅 加入：'",
        'members.n_events': "'{n} 个活动'",
        'members.n_photos': "'{n} 张照片'",
        'members.edit_profile': "'✏️ 编辑资料'",
        'members.full_profile': "'📋 完整资料'",
        'members.loading_events': "'正在加载该用户的活动...'",
        'members.loading_photos': "'正在加载该用户的照片...'",
    }
    keys.update(members)
    
    # init
    init = {
        'init.fill_id_pwd': "'请填写登录ID和密码'",
        'init.pwds_not_match': "'两次密码输入不一致'",
        'init.pwd_weak': "'密码强度不足（需至少8位，含大小写字母、数字、特殊字符）'",
        'init.create_ok': "'超级管理员创建成功！正在登录...'",
        'init.init_failed': "'初始化失败'",
        'init.init_req_failed': "'初始化请求失败'",
    }
    keys.update(init)
    
    # upload
    upload = {
        'upload_cancelled': "'上传已取消'",
        'upload_timeout': "'上传超时'",
    }
    keys.update(upload)
    
    return keys


def add_keys_to_i18n(content, keys):
    """向 i18n.js LOCALES.zh 块末尾插入新键"""
    locales_start = content.find('LOCALES = {')
    
    # 找到 zh 块的 lang.ru 行，在其后 \n  }, 前插入
    zh_ru_pos = content.find("'lang.ru': 'Русский'", 0, locales_start + 1100)
    if zh_ru_pos == -1:
        # 如果已经扩展过了，找 lang.ru', （新的格式）
        zh_ru_pos = content.find("'lang.ru': 'Русский',", 0, locales_start + 2000)
    if zh_ru_pos == -1:
        print("  [错误] 找不到 zh 语言块末尾")
        return content
    
    # 找下个闭括号 
    block_close = content.find('\n  },', zh_ru_pos)
    if block_close == -1:
        block_close = content.find('\n  }', zh_ru_pos)
    if block_close == -1:
        print("  [错误] 找不到 zh 块闭括号")
        return content
    
    # 构建 key 块
    key_lines = []
    for k in sorted(keys.keys()):
        key_lines.append(f"    '{k}': {keys[k]},")
    key_block = '\n' + '\n'.join(key_lines)
    
    return content[:block_close] + key_block + content[block_close:]


# ==================== 英文翻译 ====================
EN_TRANSLATIONS = {
    'events.month_1': "'January'", 'events.month_2': "'February'", 'events.month_3': "'March'",
    'events.month_4': "'April'", 'events.month_5': "'May'", 'events.month_6': "'June'",
    'events.month_7': "'July'", 'events.month_8': "'August'", 'events.month_9': "'September'",
    'events.month_10': "'October'", 'events.month_11': "'November'", 'events.month_12': "'December'",
    'events.day_sun': "'Sun'", 'events.day_mon': "'Mon'", 'events.day_tue': "'Tue'",
    'events.day_wed': "'Wed'", 'events.day_thu': "'Thu'", 'events.day_fri': "'Fri'",
    'events.day_sat': "'Sat'",
    'events.count_events': "'{n} events'",
    'events.no_events': "'No events'",
    'events.loading': "'Loading...'",
    'events.load_failed': "'Load failed'",
    'events.public': "'🌐 Public'",
    'events.member_only': "'🔒 Members'",
    'events.sign_in': "'Sign in'",
    'events.signed': "'✅ Signed in'",
    'events.not_signed': "'⬜ Not signed'",
    'events.delete': "'🗑️ Delete'",
    'events.edit': "'✏️ Edit'",
    'events.title_time_required': "'Please fill in title and time'",
    'events.title_required': "'Title is required'",
    'events.start_time_required': "'Start time is required'",
    'events.end_time_required': "'End time is required'",
    'events.updated': "'Event updated'",
    'events.deleted': "'Event deleted'",
    'events.created': "'Event published'",
    'events.create_failed': "'Failed to publish event: '",
    'events.unpublished': "'Event unpublished'",
    'events.comment_deleted': "'Comment deleted'",
    'events.delete_failed': "'Delete failed'",
    'events.op_failed': "'Operation failed'",
    'events.confirm_delete_comment': "'Delete this comment?'",
    'events.confirm_sign_all': "'Mark all attendees as signed in?'",
    'events.sign_all_ok': "'All signed in!'",
    'events.no_comments': "'No comments'",
    'events.no_signups': "'No signups'",
    'events.no_signins': "'No sign-ins'",
    'events.qr_signin': "'QR Sign-in'",
    'events.qr_title': "'Sign-in QR Code'",
    'events.qr_label': "'📱 Sign-in QR'",
    'events.start_time': "'📅 Start: '",
    'events.end_time': "'📅 End: '",
    'events.location': "'📍 Location: '",
    'events.signed_up': "'👥 Signed up ('",
    'events.signed_in': "'👥 Signed in ('",

    'profile_page.loading': "'Loading...'",
    'profile_page.no_content': "'No content'",
    'profile_page.edit_profile': "'✏️ Edit Profile'",
    'profile_page.new_album': "'📷 New Album'",
    'profile_page.upload_video': "'🎬 Upload Video'",
    'profile_page.uploading': "'Uploading...'",
    'profile_page.uploading_file': "'Uploading file...'",
    'profile_page.processing': "'Processing...'",
    'profile_page.confirm_delete_album': "'Delete this album? This cannot be undone.'",
    'profile_page.confirm_delete_video': "'Delete this video?'",
    'profile_page.public': "'🌍 Public'",
    'profile_page.member': "'👥 Members'",
    'profile_page.private': "'🔒 Private'",
    'profile_page.unknown_user': "'Unknown user'",
    'profile_page.unnamed_video': "'Unnamed video'",
    'profile_page.no_bio': "'No bio yet...'",
    'profile_page.avatar_updated': "'Avatar updated'",
    'profile_page.avatar_upload_failed': "'Avatar upload failed'",
    'profile_page.profile_updated': "'Profile updated'",
    'profile_page.update_failed': "'Update failed'",
    'profile_page.name_required': "'Name is required'",
    'profile_page.album_created': "'Album created'",
    'profile_page.album_deleted': "'Album deleted'",
    'profile_page.video_uploaded': "'Video uploaded'",
    'profile_page.video_deleted': "'Video deleted'",
    'profile_page.load_failed': "'Load failed'",

    'album.all_categories': "'All Categories'",
    'album.no_photos': "'No photos'",
    'album.no_desc': "'No description'",
    'album.liked': "'Liked'",
    'album.like_failed': "'Like failed'",
    'album.link_copied': "'Link copied'",
    'album.batch_delete': "'Batch delete'",
    'album.trash_empty': "'Trash is empty'",
    'album.uploader': "'Uploader: '",
    'album.restore': "'↩ Restore'",
    'album.permanent_delete': "'🗑 Delete Permanently'",
    'album.enter_category_name': "'Enter new category name: '",
    'album.no_category_to_delete': "'No categories to delete'",
    'album.select_category_delete': "'Select category to delete: '",
    'album.delete_category_warn': "'Photos in this category will be moved to Uncategorized.'",
    'album.confirm_batch_delete': "'Delete selected photos? (Moved to trash)'",
    'album.confirm_delete_category': "'Delete this category? Photos will be moved to Uncategorized.'",
    'album.category_deleted': "'Category deleted'",
    'album.name_required': "'Name is required'",
    'album.no_announcements': "'No announcements'",

    'profile.motto_saved': "'Motto saved'",
    'profile.bio_saved': "'Bio saved'",
    'profile.avatar_updated': "'Avatar updated'",
    'profile.avatar_switched_vrc': "'Switched to VRChat avatar'",
    'profile.update_failed': "'Update failed'",
    'profile.confirm_remove_avatar': "'Remove avatar?'",
    'profile.avatar_removed': "'Avatar removed'",
    'profile.enter_vrc_username': "'Enter VRChat username'",
    'profile.enter_vrc_password': "'Enter VRChat password'",
    'profile.verifying': "'Verifying...'",
    'profile.bind_success': "'Bound successfully!'",
    'profile.login_first': "'Please log in first'",
    'profile.gps_not_supported': "'Your browser does not support GPS'",
    'profile.gps_getting': "'Getting location...'",
    'profile.gps_updated': "'Location updated'",
    'profile.enter_passwords': "'Enter current and new passwords'",
    'profile.passwords_not_match': "'Passwords do not match'",
    'profile.change_failed': "'Change failed'",
    'profile.name_change_submitted': "'Name change submitted'",
    'profile.loading': "'Loading...'",
    'profile.no_events': "'No events registered'",
    'profile.load_failed': "'Load failed'",
    'profile.bind_failed': "'Bind failed: '",
    'profile.pwd_change_failed': "'Password change failed: '",
    'profile.name_change_failed': "'Name change failed'",
    'profile.vrc_bound': "'VRChat bound'",

    'posts.loading': "'Loading...'",
    'posts.load_failed': "'Load failed'",
    'posts.empty': "'No posts yet, be the first!'",
    'posts.comment_btn': "'💬 Comment'",
    'posts.pin': "'📌 Pin'",
    'posts.delete': "'🗑️ Delete'",
    'posts.share_placeholder': "'Share your day...'",
    'posts.login_first': "'Please log in first'",
    'posts.op_failed': "'Operation failed'",
    'posts.comment_failed': "'Comment failed'",
    'posts.deleted': "'Deleted'",
    'posts.pinned': "'Pinned'",
    'posts.prev': "'‹ Previous'",
    'posts.next': "'Next ›'",
    'posts.confirm_delete': "'Delete this post?'",
    'posts.confirm_delete_comment': "'Delete this comment?'",
    'posts.unpinned': "'Unpinned'",
    'posts.no_more': "'No more posts'",

    'auth.login_ok': "'Login successful'",
    'auth.login_failed': "'Login failed'",
    'auth.account_disabled': "'Account disabled'",
    'auth.session_expired': "'Session expired'",
    'auth.enter_code': "'Enter verification code'",
    'auth.send_code_first': "'Send code first'",
    'auth.timeout_retry': "'Request timed out, please retry'",
    'auth.vrc_login_ok': "'VRChat login successful'",
    'auth.network_error': "'Network error'",
    'auth.logging_in': "'Logging in...'",
    'auth.sending': "'Sending...'",
    'auth.send_code': "'Send Code'",
    'auth.resend': "'Resend'",
    'auth.login_ok_excl': "'Login successful!'",
    'auth.vrc_bound_hint': "'VRChat bound, you can use VRChat login directly'",

    'chat.group_chat': "'👥 Group'",
    'chat.dm': "'💬 DM'",
    'chat.no_history': "'No chat history'",
    'chat.first_message_emoji': "'Send the first message 👋'",
    'chat.group_start': "'Group started 👋'",
    'chat.create_group': "'➕ Create Group'",
    'chat.group_name': "'Group Name'",
    'chat.select_members': "'Select Members'",
    'chat.back': "'← Back'",
    'chat.share_location': "'📍 Share Location'",
    'chat.gps_not_supported': "'Browser does not support GPS'",
    'chat.gps_permission_denied': "'GPS permission denied'",
    'chat.gps_failed': "'Failed to get location'",
    'chat.location_stopped': "'Location sharing stopped'",
    'chat.location_sharing': "'📍 Location Sharing'",
    'chat.location_started_msg': "'📍 Started location sharing'",
    'chat.location_stopped_msg': "'📍 Stopped location sharing'",
    'chat.user_no_location': "'This user is not sharing location'",
    'chat.gps_info_failed': "'Failed to get location info'",
    'chat.create_ok': "'Created successfully'",
    'chat.load_failed': "'Load failed'",

    'main.online_count': "'{n} online'",
    'main.unknown_user': "'Unknown user'",
    'main.me': "'(Me)'",
    'main.online': "'Online'",
    'main.online_users': "'🟢 Currently Online'",
    'main.close': "'Close'",
    'main.no_results': "'No results found'",
    'main.search_failed': "'Search failed'",
    'main.upload_failed': "'Upload failed: '",
    'main.confirm_signup': "'Confirm sign up for this event?'",
    'main.signup_failed': "'Sign up failed: '",
    'main.confirm_cancel_signup': "'Cancel sign up?'",
    'main.signup_cancelled': "'Sign up cancelled'",
    'main.op_failed': "'Operation failed: '",
    'main.select_media': "'Please select image or video file'",
    'main.uploading': "'Uploading...'",
    'main.processing': "'Processing...'",
    'main.upload_ok': "'Upload successful'",

    'map.load_failed': "'Map load failed'",
    'map.load_failed_retry': "'⚠️ Map load failed, please refresh'",
    'map.send_message': "'💬 Send Message'",
    'map.sharing_location': "'🟢 Sharing Location'",
    'map.share_my_location': "'📍 Share My Location'",
    'map.stop_sharing': "'🔴 Stop Sharing'",
    'map.unknown_user': "'Unknown user'",
    'map.no_world_events': "'No events linked to this World'",
    'map.unknown_world': "'Unknown World'",
    'map.location_upload_failed': "'Location upload failed'",
    'map.location_fetch_failed': "'Failed to fetch location'",

    'birthday.no_birthdays': "'No birthday info'",
    'birthday.no_parties': "'No birthday parties'",
    'birthday.create_party_prompt': "'Create a birthday party for them?'",
    'birthday.party_title': "'🎂 Birthday Party'",
    'birthday.celebrate': "'Let's celebrate together!'",
    'birthday.create_failed': "'Create failed'",
    'birthday.party_updated': "'Party updated'",
    'birthday.party_deleted': "'Party deleted'",
    'birthday.edit_party': "'✏️ Edit Party'",
    'birthday.create_party': "'🎂 Create Party'",
    'birthday.confirm_delete_party': "'Delete this birthday party?'",

    'announcements.no_announcements': "'No announcements'",
    'announcements.pin': "'📌 Pin'",
    'announcements.public': "'🌐 Public'",
    'announcements.member_only': "'🔒 Members'",
    'announcements.modal_not_found': "'Detail modal not found in page'",
    'announcements.published_at': "'📅 Published at '",
    'announcements.edit': "'✏️ Edit'",
    'announcements.delete': "'🗑️ Delete'",
    'announcements.edit_title': "'✏️ Edit Announcement'",
    'announcements.publish_title': "'📢 Publish Announcement'",
    'announcements.confirm_delete': "'Delete this announcement?'",

    'ui.no_notifications': "'No notifications'",
    'ui.delete': "'Delete'",
    'ui.all_read': "'All marked as read'",
    'ui.op_failed': "'Operation failed'",
    'ui.delete_failed': "'Delete failed'",
    'ui.confirm_clear_notifications': "'Clear all notifications? This cannot be undone.'",
    'ui.notifications_cleared': "'All notifications cleared'",
    'ui.weak': "'Weak'",
    'ui.medium': "'Medium'",
    'ui.strong': "'Strong'",
    'ui.very_strong': "'Very Strong'",
    'ui.pwd_match': "'✅ Passwords match'",
    'ui.pwd_not_match': "'❌ Passwords do not match'",
    'ui.theme_reset': "'Theme reset to default'",

    'members.no_members': "'No members'",
    'members.location': "'📍 Location'",
    'members.card': "'👤 Card'",
    'members.vrc': "'🎮 VRChat: '",
    'members.joined': "'📅 Joined: '",
    'members.n_events': "'{n} events'",
    'members.n_photos': "'{n} photos'",
    'members.edit_profile': "'✏️ Edit Profile'",
    'members.full_profile': "'📋 Full Profile'",
    'members.loading_events': "'Loading events...'",
    'members.loading_photos': "'Loading photos...'",

    'init.fill_id_pwd': "'Please enter login ID and password'",
    'init.pwds_not_match': "'Passwords do not match'",
    'init.pwd_weak': "'Password too weak (min 8 chars, upper+lower+digit+special)'",
    'init.create_ok': "'Super admin created! Logging in...'",
    'init.init_failed': "'Initialization failed'",
    'init.init_req_failed': "'Initialization request failed: '",

    'upload_cancelled': "'Upload cancelled'",
    'upload_timeout': "'Upload timeout'",
}


def add_keys_to_all_langs(content, keys, translations):
    """向所有非 zh 语言块添加英文翻译键"""
    langs = ['en', 'ja', 'fr', 'de', 'ru']
    locales_start = content.find('LOCALES = {')
    
    key_block_lines = []
    for k in sorted(keys.keys()):
        val = translations.get(k, "'MISSING'")
        key_block_lines.append(f"    '{k}': {val},")
    key_block = '\n' + '\n'.join(key_block_lines)
    
    for lang in langs:
        pattern = f"  {lang}: {{"
        idx = content.find(pattern, locales_start)
        if idx == -1:
            print(f"  [跳过] 未找到 {lang}")
            continue
        lang_ru_pos = content.find("'lang.ru':", idx)
        if lang_ru_pos == -1:
            print(f"  [跳过] {lang} 无 lang.ru")
            continue
        block_close = content.find('\n  },', lang_ru_pos)
        if block_close == -1:
            block_close = content.find('\n  }', lang_ru_pos)
        if block_close == -1:
            continue
        content = content[:block_close] + key_block + content[block_close:]
        print(f"  ✅ {lang}: +{len(keys)} keys")
    
    return content


def main():
    dry_run = '--dry-run' in sys.argv
    do_apply = '--apply' in sys.argv
    
    if dry_run:
        print("=== 演练模式 ===\n")
    elif not do_apply:
        print("用法: python _replace_v5.py [--dry-run] [--apply]")
        return
    
    total_applied = 0
    total_files = 0
    
    for filename, rules in sorted(RULES.items()):
        filepath = os.path.join(JS_DIR, filename)
        if not os.path.exists(filepath):
            print(f"[跳过] {filename} 不存在")
            continue
        
        content = load_file(filepath).replace('\r\n', '\n')
        modified, applied = apply_rules(content, rules, filename)
        
        if applied:
            print(f"\n--- {filename} ({len(applied)} matched) ---")
            for old_preview, new_preview, cnt in applied:
                print(f"  ✅ {cnt}处: ...{old_preview[:55]}... → ...{new_preview[:55]}...")
                total_applied += cnt
            total_files += 1
            
            if do_apply:
                save_file(filepath, modified)
    
    print(f"\n{'='*60}")
    print(f"总计处理: {total_files}/{len(RULES)} 个文件, {total_applied} 处替换")
    
    # 生成键
    keys = generate_all_keys()
    print(f"新 i18n 键: {len(keys)} 个")
    
    if do_apply:
        # 添加到 i18n.js
        i18n_content = load_file(I18N_FILE)
        i18n_content = add_keys_to_i18n(i18n_content, keys)
        i18n_content = add_keys_to_all_langs(i18n_content, keys, EN_TRANSLATIONS)
        save_file(I18N_FILE, i18n_content)
        print(f"已完成 i18n 字典更新（{len(keys)} 个新键 × 6 语言）")
        print("请验证大括号平衡。")

if __name__ == '__main__':
    main()
