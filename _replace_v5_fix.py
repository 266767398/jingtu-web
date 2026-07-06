#!/usr/bin/env python3
"""
=== 第五轮补充修复 (v5-fix) ===
修复 v5 中未匹配的约 50 处规则。

用法: python _replace_v5_fix.py [--dry-run] [--apply]
"""

import os
import sys

JS_DIR = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'
I18N_FILE = os.path.join(JS_DIR, 'i18n.js')

RULES = {}

# ==================== events.js 补丁 ====================
RULES['events.js'] = [
    # 日历月份 - 多行定义（实际文件中的格式）
    ('''const monthNames = [\n    '一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'\n  ];''',
     '''const monthNames = [\n    __('events.month_1'), __('events.month_2'), __('events.month_3'), __('events.month_4'), __('events.month_5'), __('events.month_6'), __('events.month_7'), __('events.month_8'), __('events.month_9'), __('events.month_10'), __('events.month_11'), __('events.month_12')\n  ];'''),
    # 日历星期
    ('''['日', '一', '二', '三', '四', '五', '六']''',
     '''[__('events.day_sun'), __('events.day_mon'), __('events.day_tue'), __('events.day_wed'), __('events.day_thu'), __('events.day_fri'), __('events.day_sat')]'''),
    # 个活动
    ('''${evtMap[day].length}个活动''',
     '''${__('events.count_events', {n: evtMap[day].length})}'''),
    ('''${evtMap[defaultDay].length}个活动''',
     '''${__('events.count_events', {n: evtMap[defaultDay].length})}'''),
    ('''${dayEvents.length}个活动''',
     '''${__('events.count_events', {n: dayEvents.length})}'''),
    # 加载中
    ('''📷 加载中...''',
     '''📷 ${__('events.loading')}'''),
    # 签到 - 已报到没有 showConfirm 匹配，但有 toast 匹配
    ('''签到已记录''',
     '''${__('events.sign_recorded')}'''),
    # 暂无签到 / 扫码签到 / 签到二维码
    ('''暂无签到''',
     '''${__('events.no_signins')}'''),
    ('''扫码签到''',
     '''${__('events.qr_signin')}'''),
    ('''alt="签到二维码"''',
     '''alt="${__('events.qr_title')}"'''),
    ('''📱 签到二维码''',
     '''${__('events.qr_label')}'''),
    # 已报名 / 已签到
    ('''${e.signCount || 0} 人已报名''',
     '''${__('events.signed_up_count', {n: e.signCount || 0})}'''),
    ('''${e.checkinCount || 0} 人已签到''',
     '''${__('events.signed_in_count', {n: e.checkinCount || 0})}'''),
    # 操作失败 toast 替换 (这些可能已经 __() 化了)
    # 标记该活动全员签到
    ('''showConfirm('标记该活动全员签到？', async () => {''',
     '''showConfirm(__('events.confirm_sign_all'), async () => {'''),
    # toast('签到已记录', 'success')
    ('''toast('签到已记录', 'success')''',
     '''toast(__('events.sign_recorded'), 'success')'''),
    # 活动标题/时间 toast
    ('''toast('活动标题不能为空', 'error')''',
     '''toast(__('events.title_required'), 'error')'''),
    ('''toast('活动开始时间不能为空', 'error')''',
     '''toast(__('events.start_time_required'), 'error')'''),
    ('''toast('活动结束时间不能为空', 'error')''',
     '''toast(__('events.end_time_required'), 'error')'''),
    # 参与者计数
    ('''${e.participants || 0} 人参加''',
     '''${__('events.participants', {n: e.participants || 0})}'''),
    ('''/ ${e.maxParticipants || 0} 人上限''',
     '''/ ${__('events.participants_limit', {n: e.maxParticipants || 0})}'''),
    # 详情模态框中的文本
    ('''📅 开始''',
     '''${__('events.start_label')}'''),
    ('''📅 结束''',
     '''${__('events.end_label')}'''),
    ('''📍 地点''',
     '''${__('events.location_label')}'''),
]

# ==================== auth.js 补丁 ====================
RULES['auth.js'] = [
    # btn.textContent / btn.querySelector('.login-btn-text').textContent
    ('''btn.querySelector('.login-btn-text').textContent = '登录中...';''',
     '''btn.querySelector('.login-btn-text').textContent = __('auth.logging_in');'''),
    ('''btn.querySelector('.login-btn-text').textContent = '发送中...';''',
     '''btn.querySelector('.login-btn-text').textContent = __('auth.sending');'''),
    ('''btn.querySelector('.login-btn-text').textContent = '发送验证码';''',
     '''btn.querySelector('.login-btn-text').textContent = __('auth.send_code');'''),
    ('''btn.querySelector('.login-btn-text').textContent = '重新发送';''',
     '''btn.querySelector('.login-btn-text').textContent = __('auth.resend');'''),
    # 登录按钮
    ('''loginPwdBtn.textContent = '登录中...';''',
     '''loginPwdBtn.textContent = __('auth.logging_in');'''),
    # data.error || '登录失败'
    ('''toast(data.error || '登录失败', 'error');''',
     '''toast(data.error || __('auth.login_failed'), 'error');'''),
    ('''toast(data.error || 'VRChat 登录失败', 'error');''',
     '''toast(data.error || __('auth.login_failed_vrc'), 'error');'''),
    # 登录成功 - VRChat
    ('''toast('VRChat 登录成功', 'success');''',
     '''toast(__('auth.vrc_login_ok'), 'success');'''),
]

# ==================== album.js 补丁 ====================
RULES['album.js'] = [
    # 链接已复制
    ('''toast('链接已复制', 'success')''',
     '''toast(__('album.link_copied'), 'success')'''),
    # 批量删除按钮
    ('''delBtn.textContent = selectedPhotoIds.size > 0 ? `🗑️ 删除 (${selectedPhotoIds.size})` : '🗑️ 批量删除';''',
     '''delBtn.textContent = selectedPhotoIds.size > 0 ? `🗑️ ${__('album.delete')} (${selectedPhotoIds.size})` : __('album.batch_delete_btn');'''),
    # 批量删除确认
    ('''showConfirm(`确定删除所选 ${selectedPhotoIds.size} 张照片？（会移入回收站）`, async () => {''',
     '''showConfirm(__('album.confirm_batch_delete_n', {n: selectedPhotoIds.size}), async () => {'''),
    # 删除分类确认
    ('''showConfirm(`确定删除以下分类？该分类下的照片将移至"未分类"。\\n${toDelete.map(c => '· ' + c.name).join('\\n')}`, async () => {''',
     '''showConfirm(__('album.confirm_delete_categories') + '\\n' + toDelete.map(c => '· ' + c.name).join('\\n'), async () => {'''),
]

# ==================== profile.js 补丁 ====================
RULES['profile.js'] = [
    ('''toast('更新失败', 'error')''',
     '''toast(__('profile.update_failed'), 'error')'''),
    ('''toast('头像已移除', 'success')''',
     '''toast(__('profile.avatar_removed'), 'success')'''),
    ('''toast('密码修改失败：' + err.message, 'error')''',
     '''toast(__('profile.pwd_change_failed') + ': ' + err.message, 'error')'''),
    ('''toast('改名失败', 'error')''',
     '''toast(__('profile.name_change_failed'), 'error')'''),
    ('''toast('已绑定 VRChat', 'success')''',
     '''toast(__('profile.vrc_bound'), 'success')'''),
]

# ==================== profile-page.js 补丁 ====================
RULES['profile-page.js'] = [
    ('''toast('更新失败', 'error')''',
     '''toast(__('profile_page.update_failed'), 'error')'''),
    ('''toast('姓名不能为空', 'error')''',
     '''toast(__('profile_page.name_required'), 'error')'''),
    ('''toast('相册已创建', 'success')''',
     '''toast(__('profile_page.album_created'), 'success')'''),
    ('''toast('视频已上传', 'success')''',
     '''toast(__('profile_page.video_uploaded'), 'success')'''),
    ('''尚未填写个人简介...''',
     '''${__('profile_page.no_bio')}'''),
]

# ==================== posts.js 补丁 ====================
RULES['posts.js'] = [
    ('''💬 评论''',
     '''${__('posts.comment_btn')}'''),
    ('''toast('请先登录', 'error')''',
     '''toast(__('posts.login_first'), 'error')'''),
    ('''toast('已置顶', 'success')''',
     '''toast(__('posts.pinned'), 'success')'''),
    ('''showConfirm('确定删除此动态？', async () => {''',
     '''showConfirm(__('posts.confirm_delete'), async () => {'''),
    ('''showConfirm('确定删除此评论？', async () => {''',
     '''showConfirm(__('posts.confirm_delete_comment'), async () => {'''),
    ('''toast('已取消置顶', 'success')''',
     '''toast(__('posts.unpinned'), 'success')'''),
    ('''toast('暂无更多动态', 'info')''',
     '''toast(__('posts.no_more'), 'info')'''),
    ('''暂无更多动态''',
     '''${__('posts.no_more')}'''),
]

# ==================== chat.js 补丁 ====================
RULES['chat.js'] = [
    ('''toast('已停止共享位置', 'info')''',
     '''toast(__('chat.location_stopped'), 'info')'''),
    ('''toast('创建成功', 'success')''',
     '''toast(__('chat.create_ok'), 'success')'''),
    ('''toast('加载失败', 'error')''',
     '''toast(__('chat.load_failed'), 'error')'''),
]

# ==================== core.js 补丁 ====================
RULES['core.js'] = [
    ('''toast('上传已取消', 'info')''',
     '''toast(__('upload_cancelled'), 'info')'''),
]

# ==================== main.js 补丁 ====================
RULES['main.js'] = [
    ('''toast('上传成功', 'success')''',
     '''toast(__('main.upload_ok'), 'success')'''),
]

# ==================== map.js 补丁 ====================
RULES['map.js'] = [
    ('''toast('位置上传失败', 'error')''',
     '''toast(__('map.location_upload_failed'), 'error')'''),
    ('''toast('位置获取失败', 'error')''',
     '''toast(__('map.location_fetch_failed'), 'error')'''),
]

# ==================== members.js 补丁 ====================
RULES['members.js'] = [
    ('''📍 位置''',
     '''${__('members.location')}'''),
    ('''N 个活动''',
     '''${__('members.n_events')}'''),
    ('''N 张照片''',
     '''${__('members.n_photos')}'''),
]

# ==================== birthday.js 补丁 ====================
RULES['birthday.js'] = [
    ('''为 N 创建生日派对活动？''',
     '''${__('birthday.create_party_prompt')}'''),
    ('''🎂 N 的生日派对''',  
     '''${__('birthday.party_title')}'''),
    ('''showConfirm('确定删除此生日派对？', async () => {''',
     '''showConfirm(__('birthday.confirm_delete_party'), async () => {'''),
]

# ==================== ui.js 补丁 ====================
RULES['ui.js'] = [
    ('''currentUser.displayName || currentUser.loginId || '未知用户',''',
     '''currentUser.displayName || currentUser.loginId || __('unknown'),'''),
    ('''toast('主题已重置为默认', 'success')''',
     '''toast(__('ui.theme_reset'), 'success')'''),
]

# ==================== announcements.js 补丁 ====================
RULES['announcements.js'] = [
    ('''✏️ 编辑公告''',
     '''${__('announcements.edit_title')}'''),
]


def load_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        return f.read().replace('\r\n', '\n')

def save_file(filepath, content):
    with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

def apply_rules(content, rules, filename):
    applied = []
    modified = content
    for old, new in rules:
        if old in modified:
            count = modified.count(old)
            modified = modified.replace(old, new)
            applied.append((old[:65], new[:65], count))
        else:
            print(f"  ⚠ [{filename}] 仍未匹配: {old[:70]}")
    return modified, applied


FIX_KEYS = {
    # events
    'events.sign_recorded': "'签到已记录'",
    'events.participants': "'{n} 人参加'",
    'events.participants_limit': "'{n} 人上限'",
    'events.start_label': "'📅 开始'",
    'events.end_label': "'📅 结束'",
    'events.location_label': "'📍 地点'",
    'events.signed_up_count': "'{n} 人已报名'",
    'events.signed_in_count': "'{n} 人已签到'",
    # auth
    'auth.login_failed_vrc': "'VRChat 登录失败'",
    # album
    'album.delete': "'删除'",
    'album.batch_delete_btn': "'🗑️ 批量删除'",
    'album.confirm_batch_delete_n': "'确定删除所选 {n} 张照片？（会移入回收站）'",
    'album.confirm_delete_categories': "'确定删除以下分类？该分类下的照片将移至\"未分类\"。'",
}

def add_fix_keys_to_zh(content):
    locales_start = content.find('LOCALES = {')
    # Find the last key of zh block - look for the comment marker after our new keys
    zh_ru_pos = content.find("'lang.ru': 'Русский',", 0, locales_start + 3000)
    if zh_ru_pos == -1:
        zh_ru_pos = content.find("'lang.ru': 'Русский'", 0, locales_start + 3000)
    block_close = content.find('\n  },', zh_ru_pos)
    if block_close == -1:
        block_close = content.find('\n  }', zh_ru_pos)
    
    key_lines = []
    for k in sorted(FIX_KEYS.keys()):
        key_lines.append(f"    '{k}': {FIX_KEYS[k]},")
    key_block = '\n' + '\n'.join(key_lines)
    
    return content[:block_close] + key_block + content[block_close:]


def main():
    dry_run = '--dry-run' in sys.argv
    do_apply = '--apply' in sys.argv
    
    total_applied = 0
    
    for filename, rules in sorted(RULES.items()):
        filepath = os.path.join(JS_DIR, filename)
        if not os.path.exists(filepath):
            continue
        
        content = load_file(filepath)
        modified, applied = apply_rules(content, rules, filename)
        
        if applied:
            for old_preview, new_preview, cnt in applied:
                print(f"  ✅ {cnt}处: ...{old_preview[:50]}... → ...{new_preview[:50]}...")
                total_applied += cnt
            
            if do_apply:
                save_file(filepath, modified)
    
    print(f"\n总计补充: {total_applied} 处")
    
    if do_apply:
        i18n_content = load_file(I18N_FILE)
        i18n_content = add_fix_keys_to_zh(i18n_content)
        save_file(I18N_FILE, i18n_content)
        print(f"已向 i18n.js zh 块添加 {len(FIX_KEYS)} 个补充键")

if __name__ == '__main__':
    main()
