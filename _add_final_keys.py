#!/usr/bin/env python3
"""Add final remaining new i18n keys"""
BASE = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'

NEW_KEYS = {
    'zh': {
        'events.edit_party': '编辑派对',
        'events.edit_event': '编辑活动',
        'events.sign_count': '{n}人参加',
        'announcements.edited_at': '编辑于 {time}',
        'admin_perms.delete_group_confirm_full': '确定删除"{name}"权限组？{warn}',
    },
    'en': {
        'events.edit_party': 'Edit Party',
        'events.edit_event': 'Edit Event',
        'events.sign_count': '{n} attending',
        'announcements.edited_at': 'Edited at {time}',
        'admin_perms.delete_group_confirm_full': 'Delete permission group "{name}"? {warn}',
    },
}

def add():
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
            keys = NEW_KEYS['zh']
        elif lang == 'en':
            keys = NEW_KEYS['en']
        else:
            keys = NEW_KEYS['en']
        
        idx = content.find(header)
        if idx == -1:
            continue
        block_start = content.find('\n', idx) + 1
        close_idx = content.find('\n  },\n', block_start)
        if close_idx == -1:
            continue
        
        block_content = content[block_start:close_idx]
        new_lines = []
        for k, v in keys.items():
            if f"'{k}':" in block_content:
                continue
            escaped = v.replace("'", "\\'")
            new_lines.append(f"    '{k}': '{escaped}',")
        
        if new_lines:
            insert = '\n' + '\n'.join(new_lines)
            content = content[:close_idx] + insert + content[close_idx:]
            print(f"  ✅ {lang}: +{len(new_lines)} keys")
        else:
            print(f"  ➡️ {lang}: 0 new")
    
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(" ✅ 写入完成")

add()
