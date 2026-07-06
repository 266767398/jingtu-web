#!/usr/bin/env python3
"""精细扫描：仅检测面向用户的硬编码中文（toast/showConfirm/textContent/placeholder/title）"""
import re, os

js_dir = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'
cn_pat = re.compile(r'[\u4e00-\u9fff]')
skip_pat = re.compile(r'__\(')
patterns = [
    (r"toast\(", 'toast'),
    (r"showConfirm\(", 'showConfirm'),
    (r"textContent\s*=\s*['\"]", 'textContent'),
    (r"placeholder\s*[:=]\s*['\"]", 'placeholder'),
    (r"title=['\"]", 'title attr'),
    (r"\.innerHTML\s*[=+]+=", 'innerHTML'),
]

files = ['events.js','auth.js','album.js','profile.js','profile-page.js','posts.js',
         'chat.js','core.js','main.js','map.js','members.js','birthday.js',
         'announcements.js','ui.js','init.js','theme.js','home.js']

total = 0
for fn in sorted(files):
    fp = os.path.join(js_dir, fn)
    if not os.path.exists(fp):
        continue
    with open(fp, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    hits = []
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if skip_pat.search(s):
            continue
        if s.startswith(('//', '*')):
            continue
        if not cn_pat.search(s):
            continue
        # Check if line looks like user-facing code
        is_face = False
        for p, _ in patterns:
            if re.search(p, s):
                is_face = True
                break
        # Also check for template literal with Chinese not in __()
        if '`' in s and cn_pat.search(s):
            is_face = True
        if is_face:
            hits.append((i, s[:120]))
    
    if hits:
        print(f'--- {fn} ({len(hits)}) ---')
        for lno, txt in hits:
            print(f'  L{lno}: {txt}')
        total += len(hits)
    else:
        print(f'--- {fn} (0) ✅ ---')

print(f'\n总计残留: {total}')
