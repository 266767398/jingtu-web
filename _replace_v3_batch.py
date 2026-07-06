#!/usr/bin/env python3
"""
=== 第三轮硬编码中文替换 ===
批量扫描 JS 文件中的硬编码中文并替换为 __('key') 调用。
同时收集新键，验证 i18n.js LOCALES.zh 需要补充的条目。

用法: python _replace_v3_batch.py [--dry-run] [--apply]
"""

import os
import re
import sys
import json
from collections import OrderedDict

JS_DIR = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'
I18N_FILE = os.path.join(JS_DIR, 'i18n.js')

# ==================== 替换规则（按文件索引） ====================
# 格式: {file: [(old_string, new_string_with_key, new_key_for_i18n), ...]}
# new_key_for_i18n 为 None 表示键已存在

REPLACEMENTS = {}

# ==================== admin-vrc.js (46处) ====================
REPLACEMENTS['admin-vrc.js'] = [
    # L33 - 动态计数 toast
    ('''toast(`同步完成！新增 ${data.added || 0} 个活动`, 'success')''',
     '''toast(__('admin_vrc.synced_events', {n: data.added || 0}), 'success')''',
     "'admin_vrc.synced_events': '同步完成！新增 {n} 个活动'"),
    # L36
    ('''toast('同步失败：' + err.message, 'error')''',
     """toast(__('admin_vrc.sync_failed') + err.message, 'error')""",
     "'admin_vrc.sync_failed': '同步失败：'"),
    # L47
    ("""toast('仅超级管理员可审核改名申请', 'error')""",
     """toast(__('admin_vrc.name_review_denied'), 'error')""",
     "'admin_vrc.name_review_denied': '仅超级管理员可审核改名申请'"),
    # L56
    ("""toast('加载改名申请失败：' + err.message, 'error')""",
     """toast(__('admin_vrc.load_name_requests_failed') + err.message, 'error')""",
     "'admin_vrc.load_name_requests_failed': '加载改名申请失败：'"),
    # L63
    ("""<div>暂无待审核申请</div>""",
     """<div>${__('admin_vrc.no_pending_requests')}</div>""",
     "'admin_vrc.no_pending_requests': '暂无待审核申请'"),
    # L72 - 申请于
    ('''<div class="name-change-time">申请于 ${fmtDate(r.createdAt)}</div>''',
     '''<div class="name-change-time">${__('admin_vrc.applied_at')} ${fmtDate(r.createdAt)}</div>''',
     "'admin_vrc.applied_at': '申请于'"),
    # L76 - 当前名字
    ('''<div>当前名字：<strong>${esc(r.currentName || '')}</strong></div>''',
     '''<div>${__('admin_vrc.current_name')}<strong>${esc(r.currentName || '')}</strong></div>''',
     "'admin_vrc.current_name': '当前名字：'"),
    # L77 - 申请改为
    ('''<div>申请改为：<strong>${esc(r.requestedName || '')}</strong></div>''',
     '''<div>${__('admin_vrc.requested_name')}<strong>${esc(r.requestedName || '')}</strong></div>''',
     "'admin_vrc.requested_name': '申请改为：'"),
    # L78 - 理由
    ('''${r.reason ? `<div class="name-change-reason">理由：${esc(r.reason)}</div>` : ''}''',
     '''${r.reason ? `<div class="name-change-reason">${__('admin_vrc.reason')}${esc(r.reason)}</div>` : ''}''',
     "'admin_vrc.reason': '理由：'"),
    # L89 - showConfirm 确定批准/拒绝
    ('''showConfirm(`确定${action === 'approve' ? '批准' : '拒绝'}此申请？`, async () => {''',
     '''showConfirm(__('admin_vrc.confirm_review', {action: action === 'approve' ? __('admin.approve') : __('admin.reject')}), async () => {''',
     "'admin_vrc.confirm_review': '确定{action}此申请？'"),
    # L96 - 已批准/已拒绝
    ('''toast(`已${action === 'approve' ? '批准' : '拒绝'}`, 'success')''',
     '''toast(action === 'approve' ? __('admin_vrc.approved') : __('admin_vrc.rejected'), 'success')''',
     None),  # 下面分开定义
    # L99
    ("""toast('操作失败：' + err.message, 'error')""",
     """toast(__('admin_vrc.operation_failed') + err.message, 'error')""",
     "'admin_vrc.operation_failed': '操作失败：'"),
    # L112 - 计数待审核
    ('''preview.textContent = count > 0 ? `📝 ${count} 条待审核申请` : __('admin.no_pending_requests');''',
     '''preview.textContent = count > 0 ? __('admin_vrc.pending_count', {n: count}) : __('admin.no_pending_requests');''',
     "'admin_vrc.pending_count': '📝 {n} 条待审核申请'"),
    # L155
    ("""container.innerHTML = '<div class="text-muted text-13 p-8">暂无匹配的操作日志</div>'""",
     """container.innerHTML = '<div class="text-muted text-13 p-8">' + __('admin_vrc.no_oper_log') + '</div>'""",
     "'admin_vrc.no_oper_log': '暂无匹配的操作日志'"),
    # L167
    ("""container.innerHTML = '<div class="text-muted text-13 p-8">加载失败</div>'""",
     """container.innerHTML = '<div class="text-muted text-13 p-8">' + __('admin_vrc.load_failed') + '</div>'""",
     None),  # admin_vrc.load_failed 下面定义
    # L176 - 共 N 条
    ('''let html = `<span class="text-12 text-muted2 mr-4">共 ${data.total} 条</span>`;''',
     '''let html = `<span class="text-12 text-muted2 mr-4">${__('admin_vrc.total_entries', {n: data.total})}</span>`;''',
     "'admin_vrc.total_entries': '共 {n} 条'"),
    # L178 - 首页
    ('''onclick="loadOperLog(1)" title="首页"''',
     '''onclick="loadOperLog(1)" title="${__('admin_vrc.first_page')}"''',
     "'admin_vrc.first_page': '首页'"),
    # L188 - 末页
    ('''onclick="loadOperLog(${total})" title="末页"''',
     '''onclick="loadOperLog(${total})" title="${__('admin_vrc.last_page')}"''',
     "'admin_vrc.last_page': '末页'"),
    # L204 - 已登录
    ('''statusEl.innerHTML = '<span class="text-green">🟢 已登录</span>';''',
     '''statusEl.innerHTML = `<span class="text-green">🟢 ${__('admin_vrc.logged_in')}</span>`;''',
     "'admin_vrc.logged_in': '已登录'"),
    # L205 - 刷新/退出按钮
    ('''if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-outline" onclick="hideSystemVrcLogin()">刷新</button><button class="btn btn-sm btn-danger ml-6" onclick="doSystemVrcLogout()">退出</button>';''',
     '''if (actionsEl) actionsEl.innerHTML = `<button class="btn btn-sm btn-outline" onclick="hideSystemVrcLogin()">${__('admin_vrc.refresh')}</button><button class="btn btn-sm btn-danger ml-6" onclick="doSystemVrcLogout()">${__('admin_vrc.logout')}</button>`;''',
     None),
    # L207 - 未登录
    ('''statusEl.innerHTML = '<span class="text-muted">🔴 未登录</span>';''',
     '''statusEl.innerHTML = `<span class="text-muted">🔴 ${__('admin_vrc.not_logged_in')}</span>`;''',
     None),
    # L208 - 登录 VRChat
    ('''if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-accent" onclick="showSystemVrcLogin()">登录 VRChat</button>';''',
     '''if (actionsEl) actionsEl.innerHTML = `<button class="btn btn-sm btn-accent" onclick="showSystemVrcLogin()">${__('admin_vrc.login_vrc')}</button>`;''',
     "'admin_vrc.login_vrc': '登录 VRChat'"),
    # L211 - 检查失败
    ('''document.getElementById('systemVrcStatus').innerHTML = '<span class="text-red">检查失败</span>'""",
     '''document.getElementById('systemVrcStatus').innerHTML = `<span class="text-red">${__('admin_vrc.check_failed')}</span>`""",
     "'admin_vrc.check_failed': '检查失败'"),
    # L216 - 仅超级管理员可使用系统VRChat登录
    ("""toast('仅超级管理员可使用系统VRChat登录', 'error')""",
     """toast(__('admin_vrc.super_admin_only'), 'error')""",
     "'admin_vrc.super_admin_only': '仅超级管理员可使用系统VRChat登录'"),
    # L230 - 同上（重复）
    # L247 - 需要两步验证
    ("""toast('需要两步验证', 'info')""",
     """toast(__('admin_vrc.need_2fa'), 'info')""",
     "'admin_vrc.need_2fa': '需要两步验证'"),
    # L251 - VRChat 登录成功
    ("""toast('VRChat 登录成功', 'success')""",
     """toast(__('admin_vrc.login_success_vrc'), 'success')""",
     "'admin_vrc.login_success_vrc': 'VRChat 登录成功'"),
    # L257 - 登录失败
    ('''if (errEl) { errEl.textContent = errData.error || '登录失败'; errEl.classList.remove('d-none'); }''',
     '''if (errEl) { errEl.textContent = errData.error || __('admin_vrc.login_failed'); errEl.classList.remove('d-none'); }''',
     "'admin_vrc.login_failed': '登录失败'"),
    # L259 - VRChat 登录失败：
    ('''toast('VRChat 登录失败：' + err.message, 'error')''',
     '''toast(__('admin_vrc.login_failed_vrc') + err.message, 'error')''',
     "'admin_vrc.login_failed_vrc': 'VRChat 登录失败：'"),
    # L268 - 请输入完整验证码
    ("""if (!code || code.length < 4) { toast('请输入完整验证码', 'error'); return; }""",
     """if (!code || code.length < 4) { toast(__('admin_vrc.enter_full_code'), 'error'); return; }""",
     "'admin_vrc.enter_full_code': '请输入完整验证码'"),
    # L277 - VRChat 登录成功！
    ("""toast('VRChat 登录成功！', 'success')""",
     """toast(__('admin_vrc.login_success_vrc_excl'), 'success')""",
     "'admin_vrc.login_success_vrc_excl': 'VRChat 登录成功！'"),
    # L283 - 验证码错误
    ('''if (errEl2) { errEl2.textContent = '验证码错误'; errEl2.classList.remove('d-none'); }''',
     '''if (errEl2) { errEl2.textContent = __('admin_vrc.wrong_code'); errEl2.classList.remove('d-none'); }''',
     "'admin_vrc.wrong_code': '验证码错误'"),
    # L285 - 2FA 验证失败
    ("""toast('2FA 验证失败', 'error')""",
     """toast(__('admin_vrc.fa_failed'), 'error')""",
     "'admin_vrc.fa_failed': '2FA 验证失败'"),
    # L293 - 权限不足
    ("""toast('权限不足', 'error')""",
     """toast(__('permission_denied'), 'error')""",
     None),  # 已有 permission_denied
    # L297 - 同步中...
    ('''if (btn) { btn.disabled = true; btn.textContent = '同步中...'; }''',
     '''if (btn) { btn.disabled = true; btn.textContent = __('admin_vrc.syncing'); }''',
     "'admin_vrc.syncing': '同步中...'"),
    # L299 - 正在同步群组成员...
    ("""toast('正在同步群组成员...', 'info')""",
     """toast(__('admin_vrc.syncing_group_members'), 'info')""",
     "'admin_vrc.syncing_group_members': '正在同步群组成员...'"),
    # L303 - 同步完成！共 N 个成员
    ('''toast(`✅ 同步完成！共 ${data.total || 0} 个成员`, 'success')''',
     '''toast(__('admin_vrc.synced_members', {n: data.total || 0}), 'success')''',
     "'admin_vrc.synced_members': '✅ 同步完成！共 {n} 个成员'"),
    # L306 - 同步失败
    ("""toast(err.error || '同步失败', 'error')""",
     """toast(err.error || __('admin_vrc.sync_err'), 'error')""",
     "'admin_vrc.sync_err': '同步失败'"),
    # L308 - 同步失败：err.message
    ("""toast('同步失败：' + err.message, 'error')""",
     """toast(__('admin_vrc.sync_failed_msg') + err.message, 'error')""",
     "'admin_vrc.sync_failed_msg': '同步失败：'"),
    # L310 - 🔄 同步群组
    ('''if (btn) { btn.disabled = false; btn.textContent = '🔄 同步群组'; }''',
     '''if (btn) { btn.disabled = false; btn.textContent = __('admin_vrc.sync_group_btn'); }''',
     "'admin_vrc.sync_group_btn': '🔄 同步群组'"),
    # L371 - 境途同游 (fallback)
    ('''if (pt) pt.textContent = document.getElementById('cfgHeroTitle')?.value?.trim() || '境途同游';''',
     '''if (pt) pt.textContent = document.getElementById('cfgHeroTitle')?.value?.trim() || __('app.title');''',
     None),  # 已有 app.title
    # L387 - 仅超级管理员可修改系统设置
    ("""toast('仅超级管理员可修改系统设置', 'error')""",
     """toast(__('admin_vrc.super_admin_only_setting'), 'error')""",
     "'admin_vrc.super_admin_only_setting': '仅超级管理员可修改系统设置'"),
    # L426 - 保存失败
    ("""toast('保存失败：' + err.message, 'error')""",
     """toast(__('admin_vrc.save_failed') + err.message, 'error')""",
     "'admin_vrc.save_failed': '保存失败：'"),
    # L431 - 仅超级管理员可使用此功能
    ("""toast('仅超级管理员可使用此功能', 'error')""",
     """toast(__('admin_vrc.super_admin_only_feature'), 'error')""",
     "'admin_vrc.super_admin_only_feature': '仅超级管理员可使用此功能'"),
    # L434 - 确定登出系统 VRChat 账号？
    ("""showConfirm('确定登出系统 VRChat 账号？', async () => {""",
     """showConfirm(__('admin_vrc.confirm_logout_system_vrc'), async () => {""",
     "'admin_vrc.confirm_logout_system_vrc': '确定登出系统 VRChat 账号？'"),
    # L438 - VRChat 已登出
    ("""toast('VRChat 已登出', 'info')""",
     """toast(__('admin_vrc.logged_out_vrc'), 'info')""",
     "'admin_vrc.logged_out_vrc': 'VRChat 已登出'"),
]

# ==================== 额外定义的键（简化） ====================
# 有些键没有被直接的字符串匹配覆盖，但被编码在代码中
EXTRA_ADMIN_VRC_KEYS = {
    "'admin_vrc.approved'": "'已批准'",
    "'admin_vrc.rejected'": "'已拒绝'",
    "'admin_vrc.refresh'": "'刷新'",
    "'admin_vrc.logout'": "'退出'",
    "'admin_vrc.not_logged_in'": "'未登录'",
    "'admin_vrc.load_failed'": "'加载失败'",
}

# ==================== 应用替换 ====================
def apply_replacements(file_path, rules, dry_run=True):
    """对单个文件应用替换规则"""
    if not os.path.exists(file_path):
        print(f"  [跳过] 文件不存在: {file_path}")
        return [], ""
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    applied = []
    for old_str, new_str, _ in rules:
        if old_str in content:
            count = content.count(old_str)
            content = content.replace(old_str, new_str)
            applied.append((old_str[:60], new_str[:60], count))
        else:
            print(f"  [未匹配] {old_str[:80]}...")
    
    if not dry_run and applied:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
    
    return applied, content


def collect_new_keys(rules):
    """收集需要添加到 i18n.js 的新键"""
    keys = {}
    for _, _, key_info in rules:
        if key_info and key_info not in keys:
            keys[key_info.split(':')[0].strip().strip("'")] = key_info
    for k, v in EXTRA_ADMIN_VRC_KEYS.items():
        key_name = k.strip().strip("'")
        if key_name not in keys:
            keys[key_name] = f"{k}: {v}"
    return keys


def main():
    dry_run = '--dry-run' in sys.argv or '--dry_run' in sys.argv
    do_apply = '--apply' in sys.argv
    
    if dry_run:
        print("=== 演练模式（仅显示） ===\n")
    
    total_applied = 0
    total_files = 0
    all_new_keys = {}
    
    for filename, rules in REPLACEMENTS.items():
        file_path = os.path.join(JS_DIR, filename)
        print(f"\n--- {filename} ---")
        applied, _ = apply_replacements(file_path, rules, dry_run=dry_run)
        
        if applied:
            for old_preview, new_preview, cnt in applied:
                print(f"  ✅ {cnt}处: {old_preview[:50]} → {new_preview[:50]}")
                total_applied += cnt
            total_files += 1
        
        # 收集新键
        file_keys = collect_new_keys(rules)
        all_new_keys.update(file_keys)
    
    print(f"\n{'='*60}")
    print(f"总计处理: {total_files} 个文件, {total_applied} 处替换")
    print(f"新 i18n 键: {len(all_new_keys)} 个")
    
    if all_new_keys:
        print("\n需要添加到 i18n.js LOCALES.zh 的键:")
        for key_name in sorted(all_new_keys.keys()):
            print(f"    {all_new_keys[key_name]},")
    
    if dry_run:
        print(f"\n运行 `python _replace_v3_batch.py --apply` 来实际应用替换。")
    elif do_apply:
        print("\n替换已应用!")

if __name__ == '__main__':
    main()
