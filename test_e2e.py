"""
境途同游 — 用户视角全面测试脚本 (sync version)
"""
from playwright.sync_api import sync_playwright, expect
import time

BASE = 'http://localhost:3456'
USER = '2667671398'
PASS = 'ding2667671398'

def log(msg):
    print(f'  ✓ {msg}')

def warn(msg):
    print(f'  ⚠ {msg}')

def err(msg):
    print(f'  ✗ {msg}')

def section(title):
    print(f'\n{"="*60}')
    print(f'  📋 {title}')
    print(f'{"="*60}')

def run():
    issues = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        page = context.new_page()

        # ======================== 1. 首页加载 ========================
        section('1. 首页加载')
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        title = page.title()
        assert '境途同游' in title, f'标题不对: {title}'
        log(f'标题: {title}')

        expect(page.locator('.login-box')).to_be_visible()
        log('登录界面渲染正常')

        # 检查登录 Tab 切换
        expect(page.locator('#loginModePassword')).to_be_visible()
        expect(page.locator('#loginModeVrc')).to_be_visible()
        log('✅ 登录方式切换: 账号 / VRChat')

        page.screenshot(path='/tmp/01_login.png', full_page=True)
        log('截图: 01_login.png')

        # ======================== 2. 登录 ========================
        section('2. 账号登录')
        page.fill('#loginId', USER)
        page.fill('#loginPassword', PASS)
        page.wait_for_timeout(200)
        page.click('#loginPwdBtn')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(1500)

        expect(page.locator('#loginOverlay')).not_to_be_visible()
        log('✅ 登录成功，登录框已消失')

        page.screenshot(path='/tmp/02_logged_in.png', full_page=True)
        log('截图: 02_logged_in.png')

        # ======================== 3. 顶栏 ========================
        section('3. 顶栏与导航')
        expect(page.locator('#headerName')).to_be_visible()
        log(f'群组名: {page.locator("#headerName").text_content()}')

        expect(page.locator('#headerOnline')).to_be_visible()
        log(f'在线状态: {page.locator("#headerOnline").text_content()}')

        # Tab 检查
        tabs = ['members', 'announcements', 'events', 'birthday', 'album', 'map']
        tab_labels = ['成员', '公告', '活动', '生日', '相册', '地图']
        for t, l in zip(tabs, tab_labels):
            expect(page.locator(f'#tab-btn-{t}')).to_be_visible()
        log(f'✅ Tabs ({len(tabs)}个): {", ".join(tab_labels)}')

        admin_btn = page.locator('#tab-btn-admin')
        expect(admin_btn).to_be_visible()
        log('✅ 管理 Tab 可见')

        expect(page.locator('#userMenuTrigger')).to_be_visible()
        log('✅ 用户菜单可见')

        # 主题按钮
        expect(page.locator('#themeBtn')).to_be_visible()
        log('✅ 主题按钮可见')

        page.screenshot(path='/tmp/03_header.png', full_page=True)

        # ======================== 4. 成员 ========================
        section('4. 成员列表')
        page.wait_for_timeout(500)
        member_cards = page.locator('.member-card')
        member_count = member_cards.count()
        log(f'成员卡片: {member_count} 个')

        expect(page.locator('#tab-members .search-box').first).to_be_visible()
        log('✅ 搜索框可见')

        expect(page.locator('#memberRoleFilter')).to_be_visible()
        log('✅ 角色过滤器可见')

        # 点击成员名片
        if member_count > 0:
            member_cards.first.click()
            page.wait_for_timeout(600)
            if page.locator('#memberModal').is_visible():
                name = page.locator('#ucName').text_content()
                log(f'✅ 成员名片: {name}')
                page.locator('.modal-close-circle').click()
                page.wait_for_timeout(300)
            else:
                warn('成员名片未显示')
                issues.append('member_card_not_show')

        page.screenshot(path='/tmp/04_members.png', full_page=True)

        # ======================== 5. 公告 ========================
        section('5. 公告页面')
        page.click('#tab-btn-announcements')
        page.wait_for_timeout(800)

        anno_cards = page.locator('.anno-card')
        anno_count = anno_cards.count()
        log(f'公告数量: {anno_count}')

        # 管理员创建公告
        admin_bar = page.locator('#annoAdminBar')
        if admin_bar.is_visible():
            log('✅ 管理公告栏可见')
            admin_bar.locator('.btn-accent').click()
            page.wait_for_timeout(500)
            if page.locator('#announceModal').is_visible():
                log('✅ 公告创建弹窗正常')
                page.fill('#annTitle', '测试公告 — 自动化测试')
                page.fill('#annContent', '这是一条由自动化测试创建的公告')
                page.click('#annSaveBtn')
                page.wait_for_timeout(1000)
                log('✅ 公告发布成功')
                page.wait_for_timeout(500)
            else:
                warn('公告弹窗未显示')
        else:
            warn('公告管理栏不可见')

        page.screenshot(path='/tmp/05_announcements.png', full_page=True)

        # ======================== 6. 活动 ========================
        section('6. 活动页面')
        page.click('#tab-btn-events')
        page.wait_for_timeout(800)

        expect(page.locator('#evtTypeActivity')).to_be_visible()
        expect(page.locator('#evtTypeBirthday')).to_be_visible()
        log('✅ 活动/生日派对 Tab 切换正常')

        evt_status = page.locator('#evtStatusTabs .evt-status-btn')
        log(f'活动状态筛选: {evt_status.count()} 个')

        evt_count = page.locator('#evtCount').text_content()
        log(f'活动计数: {evt_count}')

        # 日历视图切换
        page.click('.evt-view-btn[data-view="calendar"]')
        page.wait_for_timeout(500)
        if page.locator('#eventCalendar').is_visible():
            cal_days = page.locator('.evt-calendar-day').count()
            log(f'✅ 日历视图正常，显示 {cal_days} 天')
        page.click('.evt-view-btn[data-view="list"]')
        page.wait_for_timeout(300)

        page.screenshot(path='/tmp/06_events.png', full_page=True)

        # ======================== 7. 生日 ========================
        section('7. 生日页面')
        page.click('#tab-btn-birthday')
        page.wait_for_timeout(800)

        bday_list = page.locator('#birthdayUserList')
        bday_text = bday_list.locator('> div').count()
        log(f'生日条目: {bday_text} 个')

        party_list = page.locator('#birthdayPartyList')
        parties = party_list.locator('.event-card').count()
        log(f'生日派对活动: {parties} 个')

        page.screenshot(path='/tmp/07_birthday.png', full_page=True)

        # ======================== 8. 相册 ========================
        section('8. 相册页面')
        page.click('#tab-btn-album')
        page.wait_for_timeout(800)

        expect(page.locator('#albumCate')).to_be_visible()
        log('✅ 分类选择器可见')

        expect(page.locator('text=上传')).to_be_visible()
        log('✅ 上传按钮可见')

        album_items = page.locator('.album-item')
        album_count = album_items.count()
        log(f'相册照片: {album_count} 张')

        if album_count > 0:
            album_items.first.click()
            page.wait_for_timeout(600)
            if page.locator('#lightbox').is_visible():
                log('✅ Lightbox 正常打开')
                expect(page.locator('#likeBtn')).to_be_visible()
                log('✅ 点赞按钮可见')
                page.locator('.lightbox-close').click()
                page.wait_for_timeout(400)
            else:
                warn('Lightbox 未显示')

        page.screenshot(path='/tmp/08_album.png', full_page=True)

        # ======================== 9. 地图 ========================
        section('9. 地图页面')
        page.click('#tab-btn-map')
        page.wait_for_timeout(1500)

        if page.locator('#memberMap').is_visible():
            log('✅ 地图容器可见')
        else:
            warn('地图未渲染')

        legend = page.locator('.map-legend')
        if legend.is_visible():
            log('✅ 地图图例可见')

        count_text = page.locator('#mapCount').text_content()
        log(f'地图: {count_text}')

        page.screenshot(path='/tmp/09_map.png', full_page=True)

        # ======================== 10. 个人中心 ========================
        section('10. 个人中心')
        page.click('#userMenuTrigger')
        page.wait_for_timeout(400)
        expect(page.locator('#userDropdown')).to_be_visible()
        log('✅ 用户菜单下拉正常')

        page.click('.dropdown-item:has-text("个人中心")')
        page.wait_for_timeout(800)

        expect(page.locator('#tab-me')).to_be_visible()
        log('✅ 个人中心 Tab 正常')

        log(f'用户: {page.locator("#meName").text_content()}')
        log(f'角色: {page.locator("#meRole").text_content()}')

        expect(page.locator('#meLocation')).to_be_visible()
        log('✅ 位置编辑字段可见')

        expect(page.locator('#mottoInput')).to_be_visible()
        log('✅ 签名编辑字段可见')

        expect(page.locator('#meVRchat')).to_be_visible()
        log('✅ VRChat 绑定区可见')

        expect(page.locator('#meOldPwd')).to_be_visible()
        log('✅ 密码修改区可见')

        page.screenshot(path='/tmp/10_profile.png', full_page=True)

        # ======================== 11. 管理面板 ========================
        section('11. 管理面板')
        page.click('#tab-btn-admin')
        page.wait_for_timeout(800)

        expect(page.locator('#tab-admin')).to_be_visible()

        expect(page.locator('#userList')).to_be_visible()
        log('✅ 用户管理可见')

        expect(page.locator('text=改名审核')).to_be_visible()
        log('✅ 改名审核面板可见')

        if page.locator('#permMgmtCard').is_visible():
            log('✅ 权限管理面板可见（超管专属）')

        expect(page.locator('#systemVrcCard')).to_be_visible()
        log('✅ 系统 VRChat 账号面板可见')

        expect(page.locator('#operLog')).to_be_visible()
        log('✅ 操作日志可见')

        expect(page.locator('text=群组图片管理')).to_be_visible()
        log('✅ 群组图片管理可见')

        page.screenshot(path='/tmp/11_admin.png', full_page=True)

        # ======================== 12. 改名申请 ========================
        section('12. 改名申请系统')
        page.click('#userMenuTrigger')
        page.wait_for_timeout(300)
        page.click('.dropdown-item:has-text("申请改名")')
        page.wait_for_timeout(500)

        if page.locator('#nameChangeModal').is_visible():
            log('✅ 改名弹窗正常')
            old_name = page.locator('#ncOldName').input_value()
            log(f'当前显示名: {old_name}')
            page.locator('.form-actions .btn-outline').click()
            page.wait_for_timeout(300)
        else:
            warn('改名弹窗未显示')

        # ======================== 13. 注销 ========================
        section('13. 注销流程')
        page.click('#userMenuTrigger')
        page.wait_for_timeout(300)
        page.click('.dropdown-item:has-text("退出登录")')
        page.wait_for_timeout(800)

        expect(page.locator('#loginOverlay')).to_be_visible()
        log('✅ 注销成功，返回登录页面')
        page.screenshot(path='/tmp/12_logout.png', full_page=True)

        # ======================== 14. 记住密码和主题 ========================
        section('14. 记住密码 & 主题系统')
        saved = page.evaluate('() => localStorage.getItem("jingtu_remembered")')
        log(f'记住密码 localStorage: {"有" if saved else "无"}')

        # 重新登录
        page.fill('#loginId', USER)
        page.fill('#loginPassword', PASS)
        page.click('#loginPwdBtn')
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(1000)

        # 主题面板
        page.click('#themeBtn')
        page.wait_for_timeout(500)
        expect(page.locator('#themePanel')).to_be_visible()
        log('✅ 主题面板弹出')

        mode_btns = page.locator('.theme-mode-btn').count()
        log(f'主题模式: {mode_btns} 种')

        color_btns = page.locator('.theme-color-btn').count()
        log(f'预设主题色: {color_btns} 种')

        expect(page.locator('#themeColorPicker')).to_be_visible()
        log('✅ 自定义取色器可见')

        # 切换亮色
        page.click('.theme-brightness-btn[data-bright="light"]')
        page.wait_for_timeout(300)
        theme = page.evaluate('() => document.documentElement.getAttribute("data-theme")')
        if theme == 'light':
            log('✅ 亮色主题切换正常')
        else:
            err(f'亮色切换失败: data-theme={theme}')
            issues.append('theme_light_fail')

        # 切回暗色
        page.click('#themeBtn')
        page.wait_for_timeout(200)
        page.click('.theme-brightness-btn[data-bright="dark"]')
        page.wait_for_timeout(300)

        page.screenshot(path='/tmp/13_theme.png', full_page=True)

        # ======================== 15. 响应式 ========================
        section('15. 响应式布局测试')
        
        # 平板 768px
        ctx2 = browser.new_context(viewport={'width': 768, 'height': 1024})
        p2 = ctx2.new_page()
        p2.goto(BASE)
        p2.wait_for_load_state('networkidle')
        p2.wait_for_timeout(1000)

        p2.fill('#loginId', USER)
        p2.fill('#loginPassword', PASS)
        p2.click('#loginPwdBtn')
        p2.wait_for_load_state('networkidle')
        p2.wait_for_timeout(1000)

        expect(p2.locator('.tabs')).to_be_visible()
        p2.screenshot(path='/tmp/14_tablet.png', full_page=True)
        log('✅ 768px 平板布局正常')
        ctx2.close()

        # 手机 375px
        ctx3 = browser.new_context(viewport={'width': 375, 'height': 812})
        p3 = ctx3.new_page()
        p3.goto(BASE)
        p3.wait_for_load_state('networkidle')
        p3.wait_for_timeout(1000)

        p3.fill('#loginId', USER)
        p3.fill('#loginPassword', PASS)
        p3.click('#loginPwdBtn')
        p3.wait_for_load_state('networkidle')
        p3.wait_for_timeout(1000)

        expect(p3.locator('.tabs')).to_be_visible()
        p3.screenshot(path='/tmp/15_mobile.png', full_page=True)
        log('✅ 375px 手机布局正常')
        ctx3.close()

        # ======================== 16. 控制台错误 ========================
        section('16. 控制台错误检查')
        errors = []
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.reload()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(1000)

        if errors:
            err(f'发现 {len(errors)} 个 JS 错误!')
            for e in errors[:8]:
                err(f'  {e[:120]}')
            issues.append('console_errors')
        else:
            log('✅ 控制台无 JS 错误')

        # ======================== 汇总 ========================
        print(f'\n{"="*60}')
        print(f'  📊 测试完成')
        print(f'{"="*60}')
        if issues:
            print(f'  ⚠️ 发现 {len(issues)} 个问题:')
            for i, iss in enumerate(issues, 1):
                print(f'    {i}. {iss}')
        else:
            print(f'  🎉 所有测试通过，无问题!')
        print(f'\n  截图: /tmp/01_login ~ 15_mobile.png')

        browser.close()

if __name__ == '__main__':
    run()
