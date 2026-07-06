#!/usr/bin/env python3
"""第七轮收尾 - 纯str替换，简单不嵌套"""
import os, sys, re

JS_DIR = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'
I18N_FILE = os.path.join(JS_DIR, 'i18n.js')

# (file, old, new)
PATCHES = [
    # events.js
    ('events.js',
     "document.getElementById('evtDetTitle').textContent = e.title || '活动';",
     "document.getElementById('evtDetTitle').textContent = e.title || __('events.event');"),
    ('events.js',
     "document.getElementById('bdayModalTitle').textContent = '\U0001f382 创建生日派对';",
     "document.getElementById('bdayModalTitle').textContent = __('events.create_bday_party');"),
    ('events.js',
     "saveBtn.textContent = '创建';",
     "saveBtn.textContent = __('create');"),
    ('events.js',
     "已结束",
     "${__('events.ended')}"),
    
    # birthday.js
    ('birthday.js',
     '\U0001f382 创建派对',
     "${__('birthday.create_party_btn')}"),
    ('birthday.js',
     '\U0001f5d1\ufe0f 删除',
     "${__('birthday.delete_btn')}"),
    
    # ui.js
    ('ui.js',
     "currentUser.displayName || currentUser.loginId || '未知用户'",
     "currentUser.displayName || currentUser.loginId || __('unknown_user')"),
    
    # posts.js
    ('posts.js',
     "d.pinned ? '已置顶' : '已取消置顶'",
     "d.pinned ? __('posts.pinned') : __('posts.unpinned')"),
    
    # profile-page.js
    ('profile-page.js',
     "album.name || '相册'",
     "album.name || __('profile_page.album')"),
    ('profile-page.js',
     "files.length + ' 个文件'",
     "__('profile_page.n_files', {n: files.length})"),
]

EXTRA_KEYS = {
    'events.event': "'活动'",
    'events.create_bday_party': "'🎂 创建生日派对'",
    'events.ended': "'已结束'",
    'birthday.create_party_btn': "'🎂 创建派对'",
    'birthday.delete_btn': "'🗑️ 删除'",
    'unknown_user': "'未知用户'",
    'profile_page.album': "'相册'",
    'profile_page.n_files': "'{n} 个文件'",
}

def main():
    do_apply = '--apply' in sys.argv
    total = 0
    
    for fn, old, new in PATCHES:
        fp = os.path.join(JS_DIR, fn)
        if not os.path.exists(fp):
            continue
        with open(fp, 'r', encoding='utf-8') as f:
            content = f.read()
        
        if old in content:
            c = content.count(old)
            content = content.replace(old, new)
            total += c
            print(f'  ✅ {fn}: {c}处')
            if do_apply:
                with open(fp, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(content)
        else:
            print(f'  ⚠ {fn}: 未匹配: {old[:50]}')
    
    print(f'\n总计: {total}')
    
    if do_apply:
        with open(I18N_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
        locales_start = content.find('LOCALES = {')
        zh_end = content.find('\n  },\n', locales_start + 20)
        lines = [f"    '{k}': {v}," for k, v in sorted(EXTRA_KEYS.items())]
        key_block = '\n' + '\n'.join(lines)
        content = content[:zh_end] + key_block + content[zh_end:]
        with open(I18N_FILE, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
        open_c = content.count('{')
        close_c = content.count('}')
        print(f'i18n +{len(EXTRA_KEYS)} keys, brackets {open_c}={close_c} {"✅" if open_c == close_c else "❌"}')

if __name__ == '__main__':
    main()
