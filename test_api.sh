#!/bin/bash
# 境途同游 — API 功能完整性测试 v2

BASE="http://localhost:3456"
PASS=0
FAIL=0
COOKIE_JAR="/tmp/jingtu_cookies2.txt"

cleanup() { rm -f "$COOKIE_JAR"; }
trap cleanup EXIT

cleanup

assert() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  ✅ $desc"
        PASS=$((PASS+1))
    else
        echo "  ❌ $desc (期望: $expected, 实际: $actual)"
        FAIL=$((FAIL+1))
    fi
}

api() {
    curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$@"
}

getStatusCode() {
    curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$1"
}

echo "============================================================"
echo "  📋 境途同游 — API 功能测试 v2"
echo "============================================================"

# 1. 健康检查
echo -e "\n--- 1. 健康检查 ---"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health")
assert "健康检查 200" "200" "$code"

# 2. 未登录 Session
echo -e "\n--- 2. 未登录 Session ---"
resp=$(api "$BASE/api/session")
echo "    Session: $resp"
loggedIn=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loggedIn','?'))" 2>/dev/null)
assert "未登录 loggedIn=false" "false" "$loggedIn"

# 3. CSRF Token
echo -e "\n--- 3. CSRF Token ---"
resp=$(api "$BASE/api/csrf-token")
echo "    CSRF: $resp"
csrf=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
assert "CSRF Token 非空" "1" "$([ -n "$csrf" ] && echo 1 || echo 0)"

# 4. 用户密码登录 (/api/auth/login)
echo -e "\n--- 4. 用户密码登录 ---"
resp=$(api -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $csrf" \
  -d "{\"loginId\":\"${TEST_LOGIN_ID:?请设置 TEST_LOGIN_ID}\",\"password\":\"${TEST_LOGIN_PASSWORD:?请设置 TEST_LOGIN_PASSWORD}\"}")
echo "    登录响应: $resp"
success=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','?'))" 2>/dev/null)
assert "用户登录成功" "true" "$success"

# 重新获取 CSRF token（登录后 session 更新了）
echo -e "\n--- 5. CSRF Token（登录后）---"
resp=$(api "$BASE/api/csrf-token")
csrf=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
assert "登录后 CSRF Token 有效" "1" "$([ -n "$csrf" ] && echo 1 || echo 0)"

# 6. 登录后 Session
echo -e "\n--- 6. 登录后 Session ---"
resp=$(api "$BASE/api/session")
echo "    Session: $resp"
loggedIn=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('loggedIn','?'))" 2>/dev/null)
isAdmin=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('isAdmin','?'))" 2>/dev/null)
assert "登录后 loggedIn=true" "true" "$loggedIn"
assert "超管 isAdmin=true" "true" "$isAdmin"

# 7. 我的资料
echo -e "\n--- 7. 我的资料 ---"
resp=$(api "$BASE/api/users/me/profile")
echo "    资料OK: $(echo $resp | head -c 80)..."
has_name=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('displayName' in d)" 2>/dev/null)
assert "资料包含 displayName" "True" "$has_name"

# 8. 公告
echo -e "\n--- 8. 公告 ---"
# 创建公告
resp=$(api -X POST "$BASE/api/announcements" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $csrf" \
  -d '{"title":"测试公告-API","content":"自动化测试创建的公告"}')
echo "    创建: $resp"
create_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',0))" 2>/dev/null)
if [ "$create_id" != "0" ] && [ -n "$create_id" ]; then
    assert "创建公告成功" "1" "1"
else
    succ=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','false'))" 2>/dev/null)
    assert "创建公告" "true" "$succ"
    create_id=""
fi

# 获取公告列表
code=$(getStatusCode "$BASE/api/announcements")
assert "公告列表 200" "200" "$code"

# 删除测试公告
if [ -n "$create_id" ]; then
    resp=$(api -X DELETE "$BASE/api/announcements/$create_id" -H "X-CSRF-Token: $csrf")
    echo "    删除: $resp"
fi

# 9. 活动
echo -e "\n--- 9. 活动 ---"
code=$(getStatusCode "$BASE/api/events?status=upcoming")
assert "活动列表(upcoming)" "200" "$code"
code=$(getStatusCode "$BASE/api/events?status=ongoing")
assert "活动列表(ongoing)" "200" "$code"
code=$(getStatusCode "$BASE/api/events?status=past")
assert "活动列表(past)" "200" "$code"

# 10. 生日
echo -e "\n--- 10. 生日 ---"
code=$(getStatusCode "$BASE/api/users/birthdays")
assert "生日列表" "200" "$code"
code=$(getStatusCode "$BASE/api/events/birthday-parties")
assert "生日派对" "200" "$code"

# 11. 成员与位置
echo -e "\n--- 11. 成员 ---"
code=$(getStatusCode "$BASE/api/users/locations")
assert "成员位置" "200" "$code"

# 12. 相册
echo -e "\n--- 12. 相册 ---"
code=$(getStatusCode "$BASE/api/album?page=1&cate=0")
assert "相册列表" "200" "$code"

# 13. 权限
echo -e "\n--- 13. 权限 ---"
code=$(getStatusCode "$BASE/api/permissions/me")
assert "我的权限" "200" "$code"

# 14. 改名系统
echo -e "\n--- 14. 改名系统 ---"
code=$(getStatusCode "$BASE/api/name-change/my-requests")
assert "改名我的记录" "200" "$code"
code=$(getStatusCode "$BASE/api/name-change/pending")
assert "改名待审核" "200" "$code"

# 15. 操作日志
echo -e "\n--- 15. 操作日志 ---"
code=$(getStatusCode "$BASE/api/logs")
assert "操作日志" "200" "$code"

# 16. CSRF 豁免的公开 API
echo -e "\n--- 16. 公开 API (无需登录) ---"
# 先注销
api -X POST "$BASE/api/auth/logout" -H "X-CSRF-Token: $csrf" > /dev/null 2>&1

code=$(getStatusCode "$BASE/api/session")
assert "Session 公开访问" "200" "$code"

code=$(getStatusCode "$BASE/api/csrf-token")
assert "CSRF 公开访问" "200" "$code"

# 17. 重新登录后注销
echo -e "\n--- 17. 注销 ---"
resp=$(api "$BASE/api/csrf-token")
csrf=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)
api -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $csrf" \
  -d "{\"loginId\":\"${TEST_LOGIN_ID:?请设置 TEST_LOGIN_ID}\",\"password\":\"${TEST_LOGIN_PASSWORD:?请设置 TEST_LOGIN_PASSWORD}\"}" > /dev/null 2>&1

resp=$(api "$BASE/api/csrf-token")
csrf=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null)

resp=$(api -X POST "$BASE/api/auth/logout" -H "X-CSRF-Token: $csrf")
echo "    注销: $resp"
resp2=$(api "$BASE/api/session")
loggedOut=$(echo "$resp2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loggedIn','?'))" 2>/dev/null)
assert "注销后 loggedIn=false" "false" "$loggedOut"

# ==================== 汇总 ====================
echo ""
echo "============================================================"
echo "  📊 API 测试结果"
echo "  通过: $PASS | 失败: $FAIL"
echo "============================================================"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
