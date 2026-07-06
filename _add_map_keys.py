#!/usr/bin/env python3
"""Add missing map i18n keys to zh/en/ja/fr/de"""
import re

BASE = r'D:\phpstudy_pro\WWW\jingtu-web\public\js'

MAP_KEYS_ZH = {
    'map.title': '🗺️ 地图',
    'map.members_view': '成员位置',
    'map.worlds_view': '活动世界',
    'map.no_data': '暂无数据',
    'map.my_location': '我的位置',
    'map.stop_sharing': '🔴 停止共享位置',
    'map.sharing': '🔵 位置共享中',
    'map.load_failed': '加载失败',
    'map.my_pos': '我的位置',
    'map.other_pos': '其他成员位置',
    'map.send_msg': '发送消息',
    'map.loading': '加载中...',
    'map.no_worlds': '暂无活动世界',
    'map.enable_gps': '请授予定位权限',
    'map.gps_not_supported': '此设备不支持GPS定位',
    'map.tracking_on': '🟢 定位追踪中',
    'map.tracking_off': '🔴 定位已关闭',
    'map.load_failed_retry': '加载失败，请重试',
    'map.location_fetch_failed': '获取位置失败',
    'map.location_upload_failed': '上传位置失败',
    'map.no_world_events': '暂无活动',
    'map.send_message': '💬 发送消息',
    'map.share_my_location': '📍 共享我的位置',
    'map.sharing_location': '🔵 正在共享位置',
    'map.unknown_user': '未知用户',
    'map.unknown_world': '未知世界',
    'map.n_events': '{n} 个活动',
    'map.load_failed_msg': '地图加载失败，请刷新页面',
    'map.unknown_location': '未知位置',
    'map.visible_count': '{n} 个成员可见',
}

MAP_KEYS_EN = {
    'map.title': '🗺️ Map',
    'map.members_view': 'Member Locations',
    'map.worlds_view': 'Event Worlds',
    'map.no_data': 'No data',
    'map.my_location': 'My Location',
    'map.stop_sharing': '🔴 Stop Sharing',
    'map.sharing': '🔵 Sharing Location',
    'map.load_failed': 'Load failed',
    'map.my_pos': 'My Position',
    'map.other_pos': 'Other Members',
    'map.send_msg': 'Send Message',
    'map.loading': 'Loading...',
    'map.no_worlds': 'No event worlds',
    'map.enable_gps': 'Enable GPS',
    'map.gps_not_supported': 'GPS not supported',
    'map.tracking_on': '🟢 Tracking',
    'map.tracking_off': '🔴 Tracking Off',
    'map.load_failed_retry': 'Load failed, retry',
    'map.location_fetch_failed': 'Failed to get location',
    'map.location_upload_failed': 'Failed to upload location',
    'map.no_world_events': 'No events',
    'map.send_message': '💬 Send Message',
    'map.share_my_location': '📍 Share My Location',
    'map.sharing_location': '🔵 Sharing Location',
    'map.unknown_user': 'Unknown user',
    'map.unknown_world': 'Unknown world',
    'map.n_events': '{n} events',
    'map.load_failed_msg': 'Map loaded failed, refresh page',
    'map.unknown_location': 'Unknown location',
    'map.visible_count': '{n} members visible',
}

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
    keys = MAP_KEYS_ZH if lang == 'zh' else MAP_KEYS_EN
    header = lang_headers[lang]
    
    idx = content.find(header)
    if idx == -1:
        print(f"  ❌ Cannot find {lang} header")
        continue
    
    block_start = content.find('\n', idx) + 1
    close_marker = '\n  },\n'
    close_idx = content.find(close_marker, block_start)
    if close_idx == -1:
        print(f"  ❌ Cannot find {lang} closing")
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
        print(f"  ✅ {lang}: added {len(new_lines)} map keys")
    else:
        print(f"  ➡️ {lang}: all map keys already exist")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print(" ✅ Done")
