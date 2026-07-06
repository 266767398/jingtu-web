#!/usr/bin/env python3
"""
=== 第六轮终结合替换 (v6) ===
覆盖剩余约 170 处面向用户硬编码中文。
用法: python _replace_v6.py [--dry-run] [--apply]
"""
import os, sys

JS_DIR = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'
RULES = {}

# ==================== album.js (32处) ====================
RULES['album.js'] = [
    ("alt=\"${esc(p.caption || '视频')}\"", "alt=\"${esc(p.caption || __('album.video'))}\""),
    ("alt=\"${esc(p.caption || '照片')}\"", "alt=\"${esc(p.caption || __('album.photo'))}\""),
    ("btn.textContent = '▶ 幻灯片'", "btn.textContent = __('album.slideshow')"),
    ("toast('至少需要2张照片', 'info')", "toast(__('album.need_2_photos'), 'info')"),
    ("btn.textContent = '⏸ 停止'", "btn.textContent = __('album.slideshow_stop')"),
    ("btn.textContent = '❌ 取消'", "btn.textContent = __('album.cancel_select')"),
    ("btn.textContent = '☑️ 选择'", "btn.textContent = __('album.select_btn')"),
    ("toast(err.error || '链接：' + url, 'info')", "toast(__('album.link_prefix') + url, 'info')"),
    ("toast(`已删除 ${data.count || selectedPhotoIds.size} 张照片`, 'success')", "toast(__('album.deleted_n', {n: data.count || selectedPhotoIds.size}), 'success')"),
    ("document.getElementById('albumSelectBtn').textContent = '☑️ 选择'", "document.getElementById('albumSelectBtn').textContent = __('album.select_btn')"),
    ("toast('批量删除失败：' + err.message, 'error')", "toast(__('album.batch_delete_failed') + ': ' + err.message, 'error')"),
    ("toast('加载回收站失败：' + err.message, 'error')", "toast(__('album.load_trash_failed') + ': ' + err.message, 'error')"),
    ("if (res.ok) { toast('已恢复', 'success'); showRecycle(); }", "if (res.ok) { toast(__('album.restored'), 'success'); showRecycle(); }"),
    ("toast('恢复失败：' + err.message, 'error')", "toast(__('album.restore_failed') + ': ' + err.message, 'error')"),
    ("if (res.ok) { toast('已永久删除', 'success'); showRecycle(); }", "if (res.ok) { toast(__('album.permanently_deleted'), 'success'); showRecycle(); }"),
    ("toast('删除失败：' + err.message, 'error')", "toast(__('album.delete_failed') + ': ' + err.message, 'error')"),
    ("toast('描述已更新', 'success')", "toast(__('album.desc_updated'), 'success')"),
    ("toast('更新描述失败：' + err.message, 'error')", "toast(__('album.desc_update_failed') + ': ' + err.message, 'error')"),
    ("if (!text) { toast('请输入评论', 'error')", "if (!text) { toast(__('album.enter_comment'), 'error')"),
    ("toast('评论已发布', 'success')", "toast(__('album.comment_posted'), 'success')"),
    ("toast('评论发布失败', 'error')", "toast(__('album.comment_post_failed'), 'error')"),
    ("toast('已取消点赞', 'info')", "toast(__('album.unliked'), 'info')"),
    ("toast('取消点赞失败', 'error')", "toast(__('album.unlike_failed'), 'error')"),
    ("showConfirm('确定删除此评论？', async () => {", "showConfirm(__('album.confirm_delete_comment'), async () => {"),
    ("toast('评论已删除', 'success')", "toast(__('album.comment_deleted'), 'success')"),
    ("toast('删除评论失败', 'error')", "toast(__('album.delete_comment_failed'), 'error')"),
    ("toast('分类已创建', 'success')", "toast(__('album.category_created'), 'success')"),
    ("toast('创建失败', 'error')", "toast(__('album.create_failed'), 'error')"),
    ("if (indices.length === 0) { toast('无效选择', 'error')", "if (indices.length === 0) { toast(__('album.invalid_selection'), 'error')"),
    ("toast('加载用户照片失败', 'error')", "toast(__('album.load_user_photos_failed'), 'error')"),
    (")删除</button>", ")${__('album.delete_comment_btn')}</button>"),
    ("toast('删除评论失败', 'error');", "toast(__('album.delete_comment_failed'), 'error');"),
]

# ==================== profile.js (23处) ====================
RULES['profile.js'] = [
    ("toast('更新失败：' + err.message, 'error')", "toast(__('profile.update_failed') + ': ' + err.message, 'error')"),
    ("toast('保存失败：' + err.message, 'error')", "toast(__('profile.save_failed') + ': ' + err.message, 'error')"),
    ("toast('上传失败：' + err.message, 'error')", "toast(__('profile.upload_failed') + ': ' + err.message, 'error')"),
    ("toast('头像已移除', 'info')", "toast(__('profile.avatar_removed'), 'info')"),
    ("toast('操作失败：' + err.message, 'error')", "toast(__('profile.op_failed') + ': ' + err.message, 'error')"),
    ("toast('切换失败：' + err.message, 'error')", "toast(__('profile.switch_failed') + ': ' + err.message, 'error')"),
    ("toast(err.error || '绑定失败', 'error')", "toast(err.error || __('profile.bind_failed'), 'error')"),
    ("btn.textContent = '📧 发送验证码'", "btn.textContent = __('profile.send_code')"),
    ("if (!code) { toast('请输入验证码', 'error')", "if (!code) { toast(__('profile.enter_code'), 'error')"),
    ("toast(err.error || '验证失败', 'error')", "toast(err.error || __('profile.verify_failed'), 'error')"),
    ("toast('验证失败：' + err.message, 'error')", "toast(__('profile.verify_failed_msg') + ': ' + err.message, 'error')"),
    ("toast('VRChat 账号已解绑', 'info')", "toast(__('profile.vrc_unbound'), 'info')"),
    ("toast('解绑失败：' + err.message, 'error')", "toast(__('profile.unbind_failed') + ': ' + err.message, 'error')"),
    ("toast('切换位置可见性失败', 'error')", "toast(__('profile.gps_visibility_failed'), 'error')"),
    ("btn.textContent = '⏳ 获取中…'", "btn.textContent = __('profile.gps_getting')"),
    ("toast('定位失败：' + err.message, 'error')", "toast(__('profile.gps_failed') + ': ' + err.message, 'error')"),
    ("status.textContent = '❌ 定位失败'", "status.textContent = __('profile.gps_failed_status')"),
    ("btn.textContent = '📍 更新我的位置'", "btn.textContent = __('profile.gps_update_btn')"),
    ("if (!requestedName) { toast('请输入想要改的名字', 'error')", "if (!requestedName) { toast(__('profile.enter_name_change'), 'error')"),
    ("toast('提交失败：' + err.message, 'error')", "toast(__('profile.submit_failed') + ': ' + err.message, 'error')"),
    ("toast(visible ? '位置已公开，请点击「更新我的位置」上传坐标' : '位置已隐藏，服务器位置数据已删除', 'info')",
     "toast(visible ? __('profile.gps_visible_msg') : __('profile.gps_hidden_msg'), 'info')"),
]

# ==================== profile-page.js (24处) ====================
RULES['profile-page.js'] = [
    ("document.title = `境途同游 - 用户资料`", "document.title = __('app.title') + ' - ' + __('profile_page.user_profile')"),
    ("toast('加载相册失败', 'error')", "toast(__('profile_page.load_albums_failed'), 'error')"),
    ("toast('视频不存在', 'error')", "toast(__('profile_page.video_not_found'), 'error')"),
    ("toast('视频链接无效', 'error')", "toast(__('profile_page.invalid_video_url'), 'error')"),
    ("toast('请选择图片文件', 'error')", "toast(__('profile_page.select_image'), 'error')"),
    ("toast('没有需要更新的内容', 'info')", "toast(__('profile_page.nothing_to_update'), 'info')"),
    ("toast('保存失败：' + err.message, 'error')", "toast(__('profile_page.save_failed') + ': ' + err.message, 'error')"),
    ("titleEl.textContent = '✏️ 编辑相册'", "titleEl.textContent = __('profile_page.edit_album')"),
    ("if (!name) { toast('请输入相册名称', 'error')", "if (!name) { toast(__('profile_page.enter_album_name'), 'error')"),
    ("toast(albumId ? '相册已更新' : '相册已创建', 'success')", "toast(albumId ? __('profile_page.album_updated') : __('profile_page.album_created_new'), 'success')"),
    ("toast('保存失败：' + err.message, 'error')", "toast(__('profile_page.save_failed') + ': ' + err.message, 'error')"),
    ("toast(`已上传 ${data.count || data.photos?.length || files.length} 个文件`, 'success')", "toast(__('profile_page.uploaded_n', {n: data.count || data.photos?.length || files.length}), 'success')"),
    ("toast('上传失败：' + err.message, 'error')", "toast(__('profile_page.upload_failed') + ': ' + err.message, 'error')"),
    ("btn.textContent = '保存'", "btn.textContent = __('save')"),
    ("toast('请选择视频文件', 'error')", "toast(__('profile_page.select_video'), 'error')"),
    ("progressText.textContent = '上传视频中...'", "progressText.textContent = __('profile_page.uploading_video')"),
    ("toast('视频上传成功', 'success')", "toast(__('profile_page.video_uploaded'), 'success')"),
    ("toast('上传失败：' + err.message, 'error')", "toast(__('profile_page.upload_failed') + ': ' + err.message, 'error')"),
    ("if (!endpoint) { toast('未知类型', 'error')", "if (!endpoint) { toast(__('profile_page.unknown_type'), 'error')"),
    ("toast('隐私设置已更新', 'success')", "toast(__('profile_page.privacy_updated'), 'success')"),
    ("toast('更新失败：' + err.message, 'error')", "toast(__('profile_page.update_failed') + ': ' + err.message, 'error')"),
    ("toast('删除失败：' + err.message, 'error')", "toast(__('profile_page.delete_failed') + ': ' + err.message, 'error')"),
]

# ==================== events.js (31处) ====================
RULES['events.js'] = [
    ("const monthNames = [\n    __('events.month_1'), __('events.month_2'), __('events.month_3'), __('events.month_4'), __('events.month_5'), __('events.month_6'), __('events.month_7'), __('events.month_8'), __('events.month_9'), __('events.month_10'), __('events.month_11'), __('events.month_12')\n  ];",
     "const monthNames = [__('events.month_1'),__('events.month_2'),__('events.month_3'),__('events.month_4'),__('events.month_5'),__('events.month_6'),__('events.month_7'),__('events.month_8'),__('events.month_9'),__('events.month_10'),__('events.month_11'),__('events.month_12')];"),
    ("暂无活动", "${__('events.no_events')}"),
    # 倒计时天数
    ("`${days}天`", "__('events.days', {n: days})"),
    ("`${hours}小时`", "__('events.hours', {n: hours})"),
    ("`${mins}分`", "__('events.minutes', {n: mins})"),
    ("进行中", "${__('events.ongoing')}"),
    ("已结束", "${__('events.ended')}"),
    ("toast('详情弹窗不在页面中', 'error')", "toast(__('events.modal_not_found'), 'error')"),
    ("${esc(c.user_name || '管理员')}", "${__('events.admin_label', {n: ''})}"),
    ("✅ 已报名 取消", "${__('events.signed_cancel')}"),
    ("📝 报名参加", "${__('events.sign_up_btn')}"),
    ("/ ${e.maxSign} 人上限", "/ ${__('events.limit', {n: e.maxSign})}"),
    ("👤 ${esc(s.user_name || '用户')}", "${__('events.user_prefix')}${esc(s.user_name || __('events.user'))}"),
    ("toast('加载活动详情失败', 'error')", "toast(__('events.load_detail_failed'), 'error')"),
    ("toast('生日派对已创建', 'success')", "toast(__('events.bday_party_created'), 'success')"),
    ("toast('活动数据未加载，请先返回列表', 'error')", "toast(__('events.data_not_loaded'), 'error')"),
    ("if (!id) { toast('无法获取活动 ID', 'error')", "if (!id) { toast(__('events.cannot_get_id'), 'error')"),
    ("if (!title || !time) { toast('标题和时间不能为空', 'error')", "if (!title || !time) { toast(__('events.title_time_required'), 'error')"),
    ("toast('编辑失败', 'error')", "toast(__('events.edit_failed'), 'error')"),
    ("if (!text) { toast('请输入评论内容', 'error')", "if (!text) { toast(__('events.enter_comment'), 'error')"),
    ("if (!eventId) { toast('无法获取活动ID', 'error')", "if (!eventId) { toast(__('events.cannot_get_id'), 'error')"),
    ("toast('评论发布失败', 'error')", "toast(__('events.comment_post_failed'), 'error')"),
    ("toast('删除评论失败', 'error')", "toast(__('events.delete_comment_failed'), 'error')"),
    ("toast('无法获取活动ID', 'error')", "toast(__('events.cannot_get_id'), 'error')"),
    ("今天", "${__('events.today')}"),
    ("toast('加载用户活动失败', 'error')", "toast(__('events.load_user_events_failed'), 'error')"),
    ("toast('请填写完整', 'error')", "toast(__('events.fill_complete'), 'error')"),
    ("toast('参数错误', 'error')", "toast(__('events.param_error'), 'error')"),
]

# ==================== auth.js (18处) ====================
RULES['auth.js'] = [
    ("toast('登录超时', 'error')", "toast(__('auth.login_timeout'), 'error')"),
    ("btn.textContent = '登录'", "btn.textContent = __('auth.login_btn')"),
    ("toast('已登出', 'info')", "toast(__('auth.logged_out'), 'info')"),
    ("if (!loginId || !password) { toast('请输入账号和密码', 'error')", "if (!loginId || !password) { toast(__('auth.enter_account_pwd'), 'error')"),
    ("toast('🎮 绑定 VRChat 账号后可一键登录', 'info')", "toast(__('auth.vrc_bind_hint'), 'info')"),
    ("if (!vrchatUser || !vrchatPass) { toast('请输入 VRChat 账号和密码', 'error')", "if (!vrchatUser || !vrchatPass) { toast(__('auth.enter_vrc_account'), 'error')"),
    ("toast('🔗 该 VRChat 账号尚未绑定本地账号。请先用密码登录，系统将自动引导绑定', 'warn')", "toast(__('auth.vrc_not_bound_warn'), 'warn')"),
    ("toast(data.message || '验证码已发送', 'success')", "toast(data.message || __('auth.code_sent'), 'success')"),
    ('toast(\'无需验证码，点击"登录"按钮即可进入\', \'info\')', "toast(__('auth.no_code_needed'), 'info')"),
    ("btn.querySelector('.login-btn-text').textContent = '已就绪'", "btn.querySelector('.login-btn-text').textContent = __('auth.ready')"),
    ("toast(err.error || 'VRChat 登录失败', 'error')", "toast(err.error || __('auth.vrc_login_failed'), 'error')"),
    ("catch { toast('VRChat 登录失败', 'error'); }", "catch { toast(__('auth.vrc_login_failed'), 'error'); }"),
    ("btn.querySelector('.login-btn-text').textContent = `${seconds}s 后可重发`", "btn.querySelector('.login-btn-text').textContent = __('auth.cooldown', {n: seconds})"),
    ("btn.querySelector('.login-btn-text').textContent = '登录'", "btn.querySelector('.login-btn-text').textContent = __('auth.login_btn')"),
    ("if (!code || code.length < 4) { toast('请输入完整验证码', 'error')", "if (!code || code.length < 4) { toast(__('auth.enter_full_code'), 'error')"),
    ("catch { toast(err.error || '登录失败', 'error'); }", "catch { toast(err.error || __('auth.login_failed'), 'error'); }"),
    ("catch { toast('登录失败', 'error'); }", "catch { toast(__('auth.login_failed'), 'error'); }"),
]

# ==================== posts.js (11处) ====================
RULES['posts.js'] = [
    ("toast('加载更多失败', 'error')", "toast(__('posts.load_more_failed'), 'error')"),
    ("toast('请先登录', 'warning')", "toast(__('posts.login_first'), 'warning')"),
    ("toast('删除失败', 'error')", "toast(__('posts.delete_failed'), 'error')"),
    ("toast('已置顶', 'success')", "toast(__('posts.pinned'), 'success')"),
    ("toast('已取消置顶', 'success')", "toast(__('posts.unpinned'), 'success')"),
    ("toast('发布失败', 'error')", "toast(__('posts.post_failed'), 'error')"),
    ("暂无评论", "${__('posts.no_comments')}"),
    ("toast('请先登录', 'warning')", "toast(__('posts.login_first'), 'warning')"),
]

# ==================== birthday.js (10处) ====================
RULES['birthday.js'] = [
    ("showConfirm(`为 ${userName} 创建生日派对活动？时间：${startStr}`, async () => {", "showConfirm(__('birthday.confirm_create_party', {name: userName, time: startStr}), async () => {"),
    ("title: `🎂 ${userName} 的生日派对`,", "title: __('birthday.party_title_for', {name: userName}),"),
    ("toast('加载活动数据失败', 'error')", "toast(__('birthday.load_data_failed'), 'error')"),
    ("document.getElementById('bdaySaveBtn').textContent = '保存'", "document.getElementById('bdaySaveBtn').textContent = __('save')"),
    ("if (!title || !eventTime) { toast('请填写完整', 'error')", "if (!title || !eventTime) { toast(__('birthday.fill_complete'), 'error')"),
    ("toast('更新失败', 'error')", "toast(__('birthday.update_failed'), 'error')"),
    ("toast('删除失败', 'error')", "toast(__('birthday.delete_failed'), 'error')"),
    ("document.getElementById('bdaySaveBtn').textContent = '创建'", "document.getElementById('bdaySaveBtn').textContent = __('create')"),
]

# ==================== chat.js (4处) ====================
RULES['chat.js'] = [
    ("📍 查看位置", "${__('chat.view_location')}"),
    ("toast('加载用户列表失败', 'error')", "toast(__('chat.load_users_failed'), 'error')"),
    ("if (err.code === 1) toast('请授予定位权限', 'error')", "if (err.code === 1) toast(__('chat.grant_location_permission'), 'error')"),
    ("toast('📍 已停止共享位置', 'info')", "toast(__('chat.location_stopped_icon'), 'info')"),
]

# ==================== core.js (5处) ====================
RULES['core.js'] = [
    ("toast('操作频繁', 'error')", "toast(__('rate_limited'), 'error')"),
    ("toast('服务器错误', 'error')", "toast(__('server_error'), 'error')"),
    ("toast('上传已取消', 'error')", "toast(__('upload_cancelled'), 'error')"),
]

# ==================== members.js (5处) ====================
RULES['members.js'] = [
    ("countEl.textContent = `找到 ${filtered.length} / ${total} 位成员`", "countEl.textContent = __('members.found_count', {found: filtered.length, total: total})"),
    ("countEl.textContent = `共 ${total} 位成员`", "countEl.textContent = __('members.total_count', {n: total})"),
    ("${m.locationVisible ? `<div class=\"member-location\">📍 ${esc(m.location || '未知')}</div>` : ''}", "${m.locationVisible ? `<div class=\"member-location\">📍 ${esc(m.location || __('members.unknown_location'))}</div>` : ''}"),
    ("`📅 ${u.evtCount} 个活动`", "`📅 ${__('members.n_events', {n: u.evtCount})}`"),
    ("`📷 ${u.photoCount} 张照片`", "`📷 ${__('members.n_photos', {n: u.photoCount})}`"),
]

# ==================== announcements.js (5处) ====================
RULES['announcements.js'] = [
    ("toast('加载公告详情失败', 'error')", "toast(__('announcements.load_detail_failed'), 'error')"),
    ("document.getElementById('annSaveBtn').textContent = '保存'", "document.getElementById('annSaveBtn').textContent = __('save')"),
    ("toast('更新失败', 'error')", "toast(__('announcements.update_failed'), 'error')"),
    ("toast('删除失败', 'error')", "toast(__('announcements.delete_failed'), 'error')"),
    ("document.getElementById('annSaveBtn').textContent = '发布'", "document.getElementById('annSaveBtn').textContent = __('announcements.publish_btn')"),
]

# ==================== map.js (1处) ====================
RULES['map.js'] = [
    ("toast('您的浏览器不支持定位功能', 'error')", "toast(__('profile.gps_not_supported'), 'error')"),
]

# ==================== theme.js (1处) ====================
RULES['theme.js'] = [
    ("toast('主题已重置为默认', 'success')", "toast(__('ui.theme_reset'), 'success')"),
]

# ==================== 处理引擎 ====================
def load_file(fp):
    with open(fp, 'r', encoding='utf-8') as f:
        return f.read().replace('\r\n', '\n')

def save_file(fp, content):
    with open(fp, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

def apply(content, rules, fn):
    modified = content
    applied = []
    for old, new in rules:
        if old in modified:
            c = modified.count(old)
            modified = modified.replace(old, new)
            applied.append((old[:60], new[:60], c))
        else:
            print(f"  ⚠ [{fn}] 未匹配: {old[:70]}")
    return modified, applied

def main():
    dry_run = '--dry-run' in sys.argv
    do_apply = '--apply' in sys.argv
    
    total_applied = 0
    for fn, rules in sorted(RULES.items()):
        fp = os.path.join(JS_DIR, fn)
        if not os.path.exists(fp):
            continue
        content = load_file(fp)
        modified, applied = apply(content, rules, fn)
        if applied:
            for old_p, new_p, c in applied:
                print(f"  ✅ {fn}: {c}处 ...{old_p[:50]}...")
                total_applied += c
            if do_apply:
                save_file(fp, modified)
    
    print(f"\n总计: {total_applied} 处")
    
    if not do_apply and not dry_run:
        print("用法: --dry-run 预览, --apply 应用")

if __name__ == '__main__':
    main()
