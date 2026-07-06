#!/usr/bin/env python3
"""Add last 3 missing i18n keys"""
BASE = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'

NEW_KEYS = {
    'zh': {
        'album.deleted_at': '删除于',
        'admin_perms.permissions_label': '权限',
        'chat.n_members_label': '{n} 人',
    },
    'en': {
        'album.deleted_at': 'Deleted at',
        'admin_perms.permissions_label': 'Permissions',
        'chat.n_members_label': '{n} members',
    },
}

path = BASE + '/i18n.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

langs = ['zh', 'en', 'ja', 'fr', 'de', 'ru']
headers = {l: f"  {l}: {{ name:" for l in langs}

for lang in langs:
    if lang == 'zh':
        keys = NEW_KEYS['zh']
    else:
        keys = NEW_KEYS['en']
    
    # find header
    idx = content.find(headers[lang])
    if idx == -1:
        print(f"  ❌ {lang} header not found")
        continue
    
    block_start = content.find('\n', idx) + 1
    close_marker = '\n  },\n'
    close_idx = content.find(close_marker, block_start)
    if close_idx == -1:
        print(f"  ❌ {lang} close not found")
        continue
    
    block = content[block_start:close_idx]
    new_lines = []
    for k, v in keys.items():
        if f"'{k}':" in block:
            continue
        escaped = v.replace("'", "\\'")
        new_lines.append(f"    '{k}': '{escaped}',")
    
    if new_lines:
        insert = '\n' + '\n'.join(new_lines)
        content = content[:close_idx] + insert + content[close_idx:]
        print(f"  ✅ {lang}: +{len(new_lines)} keys")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print(" ✅ Done")
