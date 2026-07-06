#!/usr/bin/env python3
"""
_replace_v9_precise_remaining.py
基于扫描结果精确修复剩余硬编码中文
"""
import os

BASE = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'

RULES = {}

# ==================== events.js (26处残留) ====================
RULES[os.path.join(BASE, 'events.js')] = [
    # L51: 即将开始
    ("'<span class=\"event-countdown upcoming\">📅 即将开始</span>'",
     "'<span class=\"event-countdown upcoming\">📅 ${__('events.about_to_start')}</span>'"),
    # L59: 人上限
    (" 人上限</span>", "${__('events.max_people')}</span>"),
    # L92: 于
    ("`<span class=\"text-muted2 text-11\">${__('events.edit')}于 ${fmtDate(e.updatedAt)}</span>\`",
     "`<span class=\"text-muted2 text-11\">${__('events.edit')} ${fmtDate(e.updatedAt)}</span>\`"),
    # L119: 暂无
    ("'暂无${__('events.sign_in')}</div>'",
     "'${__('events.no_sign_ins')}</div>'"),
    # L122: 人已
    ("`${e.checkinCount || 0} 人已${__('events.sign_in')}`",
     "`${__('events.n_checked_in', {n: e.checkinCount || 0})}`"),
    # L130: 已满员
    ("'<span class=\"text-muted\">已满员</span>'",
     "'<span class=\"text-muted\">${__('events.full')}</span>'"),
    # L137: 登录后可报名
    ("'<span class=\"text-muted\">登录后可报名</span>'",
     "'<span class=\"text-muted\">${__('events.login_to_sign')}</span>'"),
    # L234: 暂无归档活动
    ("'暂无归档活动</div>'",
     "'${__('events.no_archive')}</div>'"),
    # L449: 用户 (default username in comments)
    ("esc(c.userName || '用户')",
     "esc(c.userName || __('unknown_user'))"),
    # L459: 评论加载失败
    ("'评论${__('events.load_failed')}</div>'",
     "'${__('events.load_failed')}</div>'"),
    # L481: 标记该活动全员
    ("'标记该活动全员${__('events.sign_in')}？'",
     "'${__('events.mark_all_checkin')}'"),
    # L485: 签到已记录
    ("'${__('events.sign_in')}已记录'",
     "__('events.sign_in_recorded')"),
    # L489: 签到失败 (err.error || '签到失败')
    ("err.error || '${__('events.sign_in')}失败'",
     "err.error || __('events.sign_in_failed')"),
    # L491: 签到失败
    ("'${__('events.sign_in')}失败'",
     "__('events.sign_in_failed')"),
    # L504: 扫码签到
    ("<p class=\"text-13 text-muted mb-8\">扫码${__('events.sign_in')}</p>",
     "<p class=\"text-13 text-muted mb-8\">${__('events.scan_to_checkin')}</p>"),
    # L505: 签到二维码
    ("alt=\"${__('events.sign_in')}二维码\"",
     "alt=\"${__('events.checkin_qr')}\""),
    # L506: 或手动签到 / 立即签到
    ("<p class=\"text-12 text-muted2 mt-8\">或手动${__('events.sign_in')}：<button class=\"btn btn-xs btn-accent\" onclick=\"window.doSignIn()\">✅ 立即${__('events.sign_in')}</button></p>",
     "<p class=\"text-12 text-muted2 mt-8\">${__('events.or_manual_checkin')}：<button class=\"btn btn-xs btn-accent\" onclick=\"window.doSignIn()\">${__('events.checkin_now')}</button></p>"),
    # L514: 签到二维码 (modal header)
    ("📱 ${__('events.sign_in')}二维码",
     "📱 ${__('events.checkin_qr')}"),
    # L554: 正在加载...
    ("'正在加载...'", "__('events.loading_calendar')"),
    # L578: monthNames
    ("const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];",
     "const monthNames =Array.from({length:12},(_,i)=>__('events.month_'+i));"),
    # L585: title="回到今天"
    ("title=\"回到${__('events.today')}\"",
     "title=\"${__('events.back_to_today')}\""),
    # L619: defaultDay日
    ("📌 ${defaultDay}日 (${__('events.count_events', {n: evtMap[defaultDay].length})})",
     "📌 ${__('events.day_suffix', {n: defaultDay})} (${__('events.count_events', {n: evtMap[defaultDay].length})})"),
    # L627: 该月暂无活动
    ("'该月${__('events.no_events')}</div>'",
     "'${__('events.no_events')}</div>'"),
    # L680: 该日暂无活动
    ("'该日${__('events.no_events')}</div>'",
     "'${__('events.no_events')}</div>'"),
    # L683: 年月日
    ("📌 ${year}年${month+1}月${day}日",
     "📌 ${__('events.date_format', {year: year, month: month+1, day: day})}"),
    # L704: 暂无活动照片
    ("${__('events.no_events')}照片</div>'",
     "${__('events.no_photos')}</div>'"),
]

# ==================== admin-perms.js (PERM_LABELS + 2处) ====================
RULES[os.path.join(BASE, 'admin-perms.js')] = [
    # L153: 继承自
    ("继承自", "__('admin_perms.inherited_from')"),
    # L255: 确定...？ 
    # showConfirm(`确定${__('admin_perms.delete_group_confirm')}「${g ? g.name : id}」？${__('admin_perms.delete_group_warn')}`
    ("showConfirm(`确定${__('admin_perms.delete_group_confirm')}「${g ? g.name : id}」？${__('admin_perms.delete_group_warn')}`",
     "showConfirm(`${__('admin_perms.delete_group_confirm')}「${g ? g.name : id}」？${__('admin_perms.delete_group_warn')}`"),
]

# ==================== profile.js (8处残留) ====================
RULES[os.path.join(BASE, 'profile.js')] = [
    # L132: 已结束 / 进行中/未开始
    ("'已结束'", "__('events.status_ended')"),
    ("'进行中/未开始'", "__('events.status_ongoing_or_not_started')"),
    # L224: 已使用 VRChat 账号登录
    ("'🎉 ${__('profile.bind_success')}已使用 VRChat 账号登录'",
     "'🎉 ${__('profile.bind_success')}'"),
    # L280: same pattern
    ("'🎉 ${__('profile.bind_success')}已使用 VRChat 账号登录'",
     "'🎉 ${__('profile.bind_success')}'"),
    # L324: 已绑定 VRChat 账号
    ("'已绑定 VRChat 账号'", "__('profile.bound')"),
    # L341: 未绑定 VRChat 账号 (already handled by v8)
    # L393: 精度约...米
    ("`✅ ${__('profile.gps_updated')}（精度约 ${Math.round(accuracy)} 米）`",
     "`✅ ${__('profile.gps_updated')}（${__('profile.gps_accuracy', {n: Math.round(accuracy)})}）`"),
    # L395: 到服务器
    ("'📍 ${__('profile.gps_updated')}到服务器'",
     "'📍 ${__('profile.gps_updated')}'"),
    # L424: 修改失败：(already handled by v8)
    # L441: ，请等待审核
    ("'${__('profile.name_change_submitted')}，请等待审核'",
     "'${__('profile.name_change_submitted')}'"),
]

# ==================== posts.js (9处残留) ====================
RULES[os.path.join(BASE, 'posts.js')] = [
    # L102: 吧！
    ("${__('posts.empty')}吧！</div>",
     "${__('posts.empty')}</div>"),
    # L153: 视频加载失败
    ("视频${__('posts.load_failed')}",
     "${__('posts.video_load_failed')}"),
    # L188: 查看全部 X 条评论
    ("'查看全部 ' + post.commentCount + ' 条评论'",
     "__('posts.view_all_comments', {n: post.commentCount})"),
    # L194: 发送
    ("'>${__('posts.send_btn')}</button><script>", "'><span>${__('posts.comment_send_btn')}</span></button>"),
    # Actually we need to check the current state of line 194
    # L238: 切换置顶
    ("📌 切换置顶</div>",
     "${__('posts.toggle_pin')}</div>"),
    # L276: 添加图片/视频
    ("📷 添加图片/视频",
     "${__('posts.add_media_btn')}"),
    # L278: 成员可见/公开/仅自己
    ("成员可见", "${__('posts.visibility_member')}"),
    ("公开", "${__('posts.visibility_public')}"),
    ("仅自己", "${__('posts.visibility_private')}"),
    # L280: 取消/发布 buttons in modal
    ("\">取消</button>", "\">${__('posts.cancel_btn')}</button>"),
    ("\">发布</button>", "\">${__('posts.publish_btn')}</button>"),
    # L377: 发送 (detail comment)
    ("\">发送</button>", "\">${__('posts.send_btn')}</button>"),
]

# ==================== album.js (5处残留) ====================
RULES[os.path.join(BASE, 'album.js')] = [
    # L399: 暂无评论
    ("'暂无评论'", "__('album.no_comments')"),
    # L407: 用户 (default username)
    ("esc(c.userName || '用户')", "esc(c.userName || __('unknown_user'))"),
    # L417: 加载失败
    ("'加载失败'", "__('album.load_failed')"),
    # L488: 输入编号（多个用逗号分隔）
    ("'\\n\\n输入编号（多个用逗号分隔）：'", "'\\n\\n' + __('album.enter_indices')"),
    # L494: 确定删除以下分类？
    ("确定删除以下分类？${__('album.delete_category_warn')}", "${__('album.delete_category_confirm')}${__('album.delete_category_warn')}"),
]

# ==================== announcements.js (2处残留) ====================
RULES[os.path.join(BASE, 'announcements.js')] = [
    # L42: 于
    ("${__('announcements.edit')}于 ", "${__('announcements.edit_at')} "),
    # L67: 公告
    ("'${__('announcements.edit')}公告'", "'${__('announcements.edit_title_suffix')}'"),
]

# ==================== birthday.js (5处残留) ====================
RULES[os.path.join(BASE, 'birthday.js')] = [
    # L36: 未知
    ("b.birthday || '未知'", "b.birthday || __('unknown')"),
    # L79: 生日派对！
    ("p.description || '生日派对！'", "p.description || __('birthday.party_default')"),
    # L82: 已结束 / 进行中 / 即将
    ("'<span class=\"tag tag-past\">⚪ 已结束</span>'",
     "'<span class=\"tag tag-past\">⚪ ${__('birthday.status_ended')}</span>'"),
    ("'<span class=\"tag tag-ongoing\">🔴 进行中</span>'",
     "'<span class=\"tag tag-ongoing\">🔴 ${__('birthday.status_ongoing')}</span>'"),
    ("'<span class=\"tag tag-upcoming\">🟢 即将</span>'",
     "'<span class=\"tag tag-upcoming\">🟢 ${__('birthday.status_upcoming')}</span>'"),
    # L90: 查看详情 →
    ("'查看详情 →'", "__('birthday.view_detail')"),
]

# ==================== chat.js (2处残留) ====================
RULES[os.path.join(BASE, 'chat.js')] = [
    # L49: 暂无消息
    ("'暂无消息'", "__('chat.no_messages')"),
    # L101: 用户 (default displayName)
    ("user.displayName || '用户'", "user.displayName || __('unknown_user')"),
]

# ==================== group.js ====================
# group.js L210: textContent = （...条）was already changed by v8, need to check
# ==================== main.js ====================
# main.js: already handled

def replace_in_file(filepath, rules):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    changes = 0
    for old, new in rules:
        if old in content:
            content = content.replace(old, new)
            changes += 1
            print(f"  ✅ {old[:50]}...")
        else:
            print(f"  ⚠️  {old[:50]}...")
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return changes

def main():
    print("=" * 60)
    print("v9 - 精确修复剩余硬编码中文")
    print("=" * 60)
    
    total = 0
    for filepath, rules in RULES.items():
        if not os.path.exists(filepath):
            print(f"\n❌ {os.path.basename(filepath)} 不存在")
            continue
        print(f"\n📄 {os.path.basename(filepath)}:")
        c = replace_in_file(filepath, rules)
        total += c
    
    print(f"\n总计替换: {total} 处")
    print("=" * 60)
    
    # New i18n keys needed
    print("\n📦 新增 i18n 键:")
    new_keys = [
        "'events.about_to_start': '即将开始',",
        "'events.max_people': '人上限',",
        "'events.no_sign_ins': '暂无签到',",
        "'events.n_checked_in': '{n}人已签到',",
        "'events.loading_calendar': '正在加载...',",
        "'events.back_to_today': '回到今天',",
        "'events.scan_to_checkin': '扫码签到',",
        "'events.checkin_qr': '签到二维码',",
        "'events.or_manual_checkin': '或手动签到',",
        "'events.checkin_now': '✅ 立即签到',",
        "'events.mark_all_checkin': '标记该活动全员签到？',",
        "'events.status_ongoing_or_not_started': '进行中/未开始',",
        "'events.month_0': '一月',",
        "'events.month_1': '二月',",
        "'events.month_2': '三月',",
        "'events.month_3': '四月',",
        "'events.month_4': '五月',",
        "'events.month_5': '六月',",
        "'events.month_6': '七月',",
        "'events.month_7': '八月',",
        "'events.month_8': '九月',",
        "'events.month_9': '十月',",
        "'events.month_10': '十一月',",
        "'events.month_11': '十二月',",
        "'admin_perms.inherited_from': '继承自',",
        "'profile.bound': '已绑定 VRChat 账号',",
        "'birthday.party_default': '生日派对！',",
        "'birthday.status_ongoing': '进行中',",
        "'birthday.status_upcoming': '即将',",
        "'birthday.view_detail': '查看详情 →',",
        "'chat.no_messages': '暂无消息',",
        "'posts.comment_send_btn': '发送',",
        "'album.enter_indices': '输入编号（多个用逗号分隔）',",
        "'album.delete_category_confirm': '确定删除以下分类？',",
        "'announcements.edit_at': '编辑于 ',",  # note trailing space
        "'events.load_failed_comment': '评论加载失败',",
    ]
    for k in new_keys:
        print(f"    {k}")

if __name__ == '__main__':
    main()
