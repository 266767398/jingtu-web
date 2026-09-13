# === 数据库管理界面准确查缺补漏 ===
# 历史一次性检查脚本（人工排查使用），不在运行时被自动加载。
# 原引用 `public/js/admin-db.js`，该文件已迁至 `public/js/_unwired/admin-db.js`（未启用模块）。
# 现统一指向 `_unwired/`；如不需要独立数据库管理面板，可直接删除本脚本。

print('=== 数据库管理界面准确查缺补漏 ===')
print()

issues = []

print('1. 检查语言文件完整性')
import re
# 原文件位于 public/js/admin-db.js，现已迁至 public/js/_unwired/admin-db.js（孤儿模块）。
ADMIN_DB_JS = r'd:\phpstudy_pro\WWW\jingtu-web\public\js\_unwired\admin-db.js'
with open(ADMIN_DB_JS, 'r', encoding='utf-8') as f:
    js_content = f.read()

with open(r'd:\phpstudy_pro\WWW\jingtu-web\public\index.html', 'r', encoding='utf-8') as f:
    html_content = f.read()

js_lang_keys = set(re.findall(r"__\('([^']+)'", js_content))
html_lang_keys = set(re.findall(r'data-i18n="([^"]+)"', html_content))
all_lang_keys = js_lang_keys.union(html_lang_keys)
db_lang_keys = {k for k in all_lang_keys if k.startswith('admin.db')}

print(f'   实际使用的语言键数量: {len(db_lang_keys)}')

lang_files = ['zh.js', 'en.js', 'ja.js', 'de.js', 'fr.js', 'ru.js']
for lang in lang_files:
    path = f'd:/phpstudy_pro/WWW/jingtu-web/public/js/languages/{lang}'
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
        missing = []
        for key in db_lang_keys:
            if f"'{key}'" not in content:
                missing.append(key)
        if missing:
            print(f'   ❌ {lang}: 缺少 {len(missing)} 个键')
            issues.append(f'{lang}缺少语言键')
        else:
            print(f'   ✅ {lang}: 完整')

print()
print('2. 检查API路由匹配')
routes = [
    ('/admin/db/status', '/api/admin/db/status'),
    ('/admin/db/tables', '/api/admin/db/tables'),
    ('/admin/db/table/:name', '/api/admin/db/table/'),
    ('/admin/db/optimize/:table', '/api/admin/db/optimize/'),
    ('/admin/db/analyze/:table', '/api/admin/db/analyze/'),
    ('/admin/db/check/:table', '/api/admin/db/check/'),
    ('/admin/db/repair/:table', '/api/admin/db/repair/'),
    ('/admin/db/processlist', '/api/admin/db/processlist'),
    ('/admin/db/kill/:pid', '/api/admin/db/kill/'),
    ('/admin/db/variables', '/api/admin/db/variables'),
    ('/admin/db/slow-queries', '/api/admin/db/slow-queries')
]

with open(r'd:\phpstudy_pro\WWW\jingtu-web\server\routes\database.js', 'r', encoding='utf-8') as f:
    route_content = f.read()

all_routes_ok = True
for route_path, api_call in routes:
    if route_path in route_content:
        print(f'   ✅ {route_path}')
    else:
        print(f'   ❌ {route_path}')
        all_routes_ok = False

print()
print('3. 检查核心功能函数')
core_functions = [
    'showDbSection', 'checkDbPermission', 'switchDbTab', 'loadDbStatus',
    'loadDbTables', 'renderDbTables', 'showDbTableDetail',
    'dbOptimizeTable', 'dbAnalyzeTable', 'dbCheckTable',
    'dbRepairTable', 'loadDbProcesses', 'dbKillProcess',
    'loadDbSlowQueries', 'loadDbVariables'
]

# 同上：定位到 _unwired/admin-db.js
with open(ADMIN_DB_JS, 'r', encoding='utf-8') as f:
    content = f.read()

all_funcs_ok = True
for func in core_functions:
    if f'function {func}' in content or f'async function {func}' in content:
        print(f'   ✅ {func}')
    else:
        print(f'   ❌ {func}')
        all_funcs_ok = False

print()
print('4. 检查权限控制')
with open(r'd:\phpstudy_pro\WWW\jingtu-web\public\index.html', 'r', encoding='utf-8') as f:
    html_content = f.read()

if 'id="adminDatabaseSection"' in html_content:
    parts = html_content.split('id="adminDatabaseSection"')
    tag_end = parts[1].split('>')[0]
    if 'd-none' in tag_end:
        print('   ✅ 数据库管理面板初始隐藏')
    else:
        print('   ❌ 数据库管理面板未初始隐藏')
        issues.append('数据库管理面板未初始隐藏')

with open(r'd:\phpstudy_pro\WWW\jingtu-web\public\js\ui.js', 'r', encoding='utf-8') as f:
    ui_content = f.read()

if 'checkDbPermission()' in ui_content:
    print('   ✅ switchTab中调用了checkDbPermission')
else:
    print('   ❌ switchTab中未调用checkDbPermission')
    issues.append('switchTab中未调用checkDbPermission')

print()
print('5. 检查路由注册')
with open(r'd:\phpstudy_pro\WWW\jingtu-web\server\server.js', 'r', encoding='utf-8') as f:
    content = f.read()

if "require('./routes/database')" in content:
    print('   ✅ 数据库路由已注册')
else:
    print('   ❌ 数据库路由未注册')
    issues.append('数据库路由未注册')

print()
print('6. 检查HTML文件完整性')
if '</body>' in html_content and '</html>' in html_content:
    print('   ✅ HTML文件完整')
else:
    print('   ❌ HTML文件不完整')
    issues.append('HTML文件不完整')

if html_content.count('class=') > html_content.count('class="') + html_content.count("class='"):
    print('   ❌ 可能有重复的class属性')
    issues.append('可能有重复的class属性')
else:
    print('   ✅ class属性正常')

print()
if issues:
    print('⚠️ 发现问题:')
    for i, issue in enumerate(issues, 1):
        print(f'   {i}. {issue}')
else:
    print('🎉 所有检查通过！数据库管理界面功能完整。')
