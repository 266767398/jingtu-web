#!/usr/bin/env python3
"""Check what map-related i18n keys exist in all 6 languages"""
import re

with open(r'D:\phpstudy_pro\WWW\jingtu-web\public\js\i18n.js', 'r', encoding='utf-8') as f:
    content = f.read()

langs = ['zh', 'en', 'ja', 'fr', 'de', 'ru']
for lang in langs:
    pattern = rf"  {lang}: \{{ name:(.*?)\n  \}},"
    match = re.search(pattern, content, re.DOTALL)
    if match:
        block = match.group(1)
        keys = re.findall(r"'map\.([^']*)'", block)
        print(f"{lang}: {len(keys)} keys - {keys}")

# Also check if the keys used in map.js exist in i18n
used_keys = ['map.stop_sharing', 'map.share_my_location', 'map.sharing_location', 
             'map.unknown_user', 'map.unknown_world', 'map.load_failed', 'map.no_world_events']
for key in used_keys:
    for lang in langs:
        pattern = rf"  {lang}: \{{ name:(.*?)\n  \}},"
        match = re.search(pattern, content, re.DOTALL)
        if match:
            block = match.group(1)
            if f"'{key}':" in block:
                print(f"  ✅ {key} exists in {lang}")
                break
    else:
        print(f"  ❌ {key} MISSING in all languages!")
