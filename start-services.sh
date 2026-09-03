#!/usr/bin/env bash
# =============================================================================
# 境途同游 (jingtu-web) 服务管理脚本 —— Linux / 宝塔 版
# 功能对标 Windows 的 start-services.bat / start-services.ps1（数字菜单）。
#
# 用法：  bash start-services.sh        （或提交后 chmod +x 后 ./start-services.sh）
# 说明：  启动/停止默认用 nohup+pidfile；若检测到 pm2 则优先用 pm2。
#         所有高危操作均有二次确认或指定字符串确认；关键操作写入 logs/panel-audit.log。
# 注意：  本脚本为服务器本地/SSH 运维工具，无 Web 鉴权（破窗用途）。
# =============================================================================
cd "$(dirname "$0")"

APP="jingtu-web"
PIDFILE="server/jingtu.pid"
LOGFILE="logs/jingtu.out"
LOGS_DIR="logs"
DATA_DIR="uploads"
BACKUP_DIR="backup"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)"
PORT="${PORT:-3456}"

mkdir -p "$LOGS_DIR" "$BACKUP_DIR"

# ---- 审计 ----
audit() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $1" >> "$LOGS_DIR/panel-audit.log"; }

# ---- 提示色 ----
ok()  { echo -e "\033[32m✓ $1\033[0m"; }
warn(){ echo -e "\033[33m⚠ $1\033[0m"; }
err() { echo -e "\033[31m✗ $1\033[0m"; }
info(){ echo -e "\033[36m$1\033[0m"; }

confirm_yn() {
  local ans
  read -r -p "$1 [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}
confirm_exact() {
  local expect="$1" ans
  read -r -p "请输入确认字符串 [$expect] 以继续（大小写严格匹配）： " ans
  [[ "$ans" == "$expect" ]]
}

# ===================== 启动 / 停止 / 重启 =====================
proc_running() {
  if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP\""; then
    return 0
  fi
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

do_start() {
  if proc_running; then ok "服务已在运行"; return; fi
  if command -v pm2 >/dev/null 2>&1; then
    info "▶ 使用 pm2 启动..."
    pm2 start server/server.js --name "$APP" --output "$LOGFILE" --error "$LOGFILE"
  else
    info "▶ 使用 nohup 启动 node server/server.js ..."
    nohup node server/server.js > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then ok "已启动 (PID $(cat "$PIDFILE"))，日志见 $LOGFILE"; else err "启动失败，请查看 $LOGFILE"; fi
  fi
  audit "启动服务"
}
do_stop() {
  if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP\""; then
    pm2 stop "$APP" 2>/dev/null; pm2 delete "$APP" 2>/dev/null; ok "已停止 (pm2)"; audit "停止服务(pm2)"; return
  fi
  if [[ -f "$PIDFILE" ]]; then
    PID="$(cat "$PIDFILE")"
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null; sleep 1
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
      ok "已停止 (PID $PID)"
    else warn "进程不存在，清理 pid 文件"; fi
    rm -f "$PIDFILE"
  else warn "未找到 pid 文件，服务可能未以本脚本启动"; fi
  audit "停止服务"
}
do_restart() { do_stop; sleep 1; do_start; }

# ===================== 1. 重置初始化（建站引导） =====================
do_reset_wizard() {
  warn "此操作仅删除 setup-wizard.json（建站引导进度/草稿），不影响 .env 与数据库。"
  if confirm_yn "确认重置建站引导？"; then
    rm -f setup-wizard.json
    ok "建站引导数据已重置（站点其他配置不受影响）"; audit "重置建站引导"
  else info "· 已取消"; fi
}

# ===================== 5. 运行状态 =====================
do_status() {
  info "===== 服务运行状态 ====="
  if proc_running; then
    if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP\""; then
      pm2 list | grep "$APP" || true
    else
      PID="$(cat "$PIDFILE")"
      mem="$(ps -o rss= -p "$PID" 2>/dev/null | awk '{printf "%.1fMB", $1/1024}')"
      ok "$APP  端口 $PORT  PID=$PID  内存=${mem:-未知}"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/health" 2>/dev/null || echo '000')"
    if [[ "$code" == "200" ]]; then ok "健康检查通过 (HTTP 200)"; else warn "健康检查未通过（HTTP $code，服务可能仍在预热）"; fi
  else err "$APP 未运行"; fi
}

# ===================== 6. 查看最近日志 =====================
do_tail_logs() {
  shopt -s nullglob
  local logs=("$LOGS_DIR"/*.log)
  shopt -u nullglob
  if [[ ${#logs[@]} -eq 0 ]]; then warn "暂无日志文件"; return; fi
  info "===== 最近日志（每文件末尾 50 行） ====="
  for lf in "${logs[@]}"; do
    [[ "$(basename "$lf")" == panel-audit.log ]] && continue
    echo "----- $(basename "$lf") -----"
    tail -n 50 "$lf"
  done
}

# ===================== 7. 搜索日志错误 =====================
do_search_errors() {
  shopt -s nullglob
  local logs=("$LOGS_DIR"/*.log)
  shopt -u nullglob
  if [[ ${#logs[@]} -eq 0 ]]; then warn "暂无日志"; return; fi
  info "===== 错误日志（最多 200 行） ====="
  grep -E "ERROR|FATAL|Exception|失败|Error:" "${logs[@]}" 2>/dev/null | grep -v panel-audit.log | head -n 200 || warn "未检索到错误记录"
}

# ===================== 8. 清理全部日志 =====================
do_clean_logs() {
  if ! confirm_yn "将删除 logs 下全部日志（保留 audit 审计日志与目录），确认？"; then info "· 已取消"; return; fi
  local n=0
  shopt -s nullglob
  for lf in "$LOGS_DIR"/*.log; do
    [[ "$(basename "$lf")" == panel-audit.log ]] && continue
    rm -f "$lf" && n=$((n+1))
  done
  shopt -u nullglob
  ok "已清理 $n 个日志文件"; audit "清理日志：$n 个"
}

# ===================== 9/11/12. 备份 / 列表 / 恢复 =====================
do_backup() {
  if [[ ! -d "$DATA_DIR" ]]; then err "用户数据目录不存在：$DATA_DIR"; return; fi
  if proc_running; then warn "服务正在运行，部分文件可能被占用，备份可能不一致。"; confirm_yn "仍然继续备份？" || { info "· 已取消"; return; }; fi
  local stamp; stamp="$(date '+%Y%m%d-%H%M%S')"
  local arc="$BACKUP_DIR/userdata-$stamp.tar.gz"
  info "正在备份 $DATA_DIR ..."
  tar -czf "$arc" "$DATA_DIR" 2>/dev/null && ok "备份完成：$arc" || { err "备份失败"; return; }
  # 保留策略：最近 10 个
  ls -1t "$BACKUP_DIR"/userdata-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
  audit "备份用户数据：成功 $arc"
}
do_backup_list() {
  shopt -s nullglob
  local fs=("$BACKUP_DIR"/*.tar.gz "$BACKUP_DIR"/config-*.bak)
  shopt -u nullglob
  if [[ ${#fs[@]} -eq 0 ]]; then warn "暂无备份"; return; fi
  info "===== 备份列表 ====="
  for f in "${fs[@]}"; do printf "  %-40s %8sMB  %s\n" "$(basename "$f")" "$(du -m "$f" | cut -f1)" "$(date -r "$f" '+%Y-%m-%d %H:%M')"; done
}
do_restore() {
  shopt -s nullglob
  local bks=("$BACKUP_DIR"/userdata-*.tar.gz)
  shopt -u nullglob
  if [[ ${#bks[@]} -eq 0 ]]; then warn "暂无用户数据备份"; return; fi
  if proc_running; then err "❌ 服务必须停止才能恢复数据，请先关闭服务（选项 3）"; return; fi
  info "===== 可用备份 ====="
  local i=0
  for b in "${bks[@]}"; do echo "  [$i] $(basename "$b")  $(date -r "$b" '+%Y-%m-%d %H:%M')"; i=$((i+1)); done
  read -r -p "请输入要恢复的备份序号： " sel
  if ! [[ "$sel" =~ ^[0-9]+$ ]] || [[ "$sel" -ge ${#bks[@]} ]]; then err "无效序号"; return; fi
  local target="${bks[$sel]}"
  # 先快照当前数据作回退兜底
  local snap="$BACKUP_DIR/userdata-snapshot-$(date '+%Y%m%d-%H%M%S').tar.gz"
  [[ -d "$DATA_DIR" ]] && tar -czf "$snap" "$DATA_DIR" 2>/dev/null && warn "已生成当前数据快照（回退兜底）：$snap"
  if ! confirm_exact "CONFIRM-RESTORE-FROM-BACKUP"; then info "· 确认字符串不匹配，已取消"; return; fi
  rm -rf "$DATA_DIR"/* 2>/dev/null
  tar -xzf "$target" -C . && ok "恢复完成（来自 $target）" && audit "从备份恢复数据：成功 $target（快照 $snap）" || err "恢复异常，可用快照回退：$snap"
}

# ===================== 10. 清除用户数据【高危】 =====================
do_clear_data() {
  if proc_running; then err "❌ 服务正在运行，禁止清除用户数据。请先关闭服务（选项 3）。"; return; fi
  echo -e "\033[31m!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\033[0m"
  echo -e "\033[31m  高危操作：将永久删除 $DATA_DIR 内全部内容！\033[0m"
  echo -e "\033[31m  建议优先执行「9 - 备份用户数据」。\033[0m"
  echo -e "\033[31m!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\033[0m"
  if ! confirm_exact "CONFIRM-DELETE-ALL-DATA"; then info "· 确认字符串不匹配，已取消"; return; fi
  [[ -d "$DATA_DIR" ]] && rm -rf "$DATA_DIR"/* 2>/dev/null
  ok "用户数据已清空（目录已保留）"; audit "清除用户数据：高危操作完成"
}

# ===================== 13. 运行环境依赖检查 =====================
do_check_env() {
  info "===== 运行环境依赖检查 ====="
  local items=("node:$(command -v node && node -v)" "npm:$(command -v npm && npm -v)" "mysql客户端:$(command -v mysql || echo 缺失)")
  for it in "${items[@]}"; do
    local name="${it%%:*}" val="${it#*:}"
    [[ "$val" == *缺失* || -z "$val" ]] && err "  ❌ $name (缺失/不可达)" || ok "  ✅ $name -> $val"
  done
  for f in server/server.js .env public node_modules; do
    [[ -e "$f" ]] && ok "  ✅ 关键文件/目录: $f" || err "  ❌ 关键文件/目录缺失: $f"
  done
}

# ===================== 14/15. 端口检测 / 释放 =====================
pid_by_port() {
  ss -ltnp 2>/dev/null | grep -oP "pid=\K[0-9]+(?=.*:${1}\b)" | head -1
  [[ -z "$(ss -ltnp 2>/dev/null | grep ":${1}\b")" ]] && lsof -ti ":$1" 2>/dev/null | head -1
}
do_port_check() {
  read -r -p "请输入端口（直接回车使用默认 $PORT）： " inp
  local port="${inp:-$PORT}"
  local pid; pid="$(pid_by_port "$port")"
  [[ -z "$pid" ]] && { ok "端口 $port 空闲"; return; }
  local pname; pname="$(ps -o comm= -p "$pid" 2>/dev/null || echo 未知)"
  warn "端口 $port 被占用：PID=$pid 进程=$pname"
}
do_release_port() {
  read -r -p "请输入要释放的端口： " port
  [[ "$port" =~ ^[0-9]+$ ]] || { err "无效端口"; return; }
  local pid; pid="$(pid_by_port "$port")"
  [[ -z "$pid" ]] && { ok "端口 $port 空闲，无需释放"; return; }
  local pname; pname="$(ps -o comm= -p "$pid" 2>/dev/null || echo 未知)"
  warn "端口 $port 占用进程：PID=$pid 名称=$pname"
  case "$port" in 22|80|443|3306) err "该端口为系统/常用服务端口，禁止操作"; return;; esac
  confirm_yn "确认终止该进程以释放端口？" || { info "· 已取消"; return; }
  kill "$pid" 2>/dev/null && sleep 2
  if [[ -z "$(pid_by_port "$port")" ]]; then ok "✅ 端口 $port 已释放"; audit "释放端口：$port 成功(PID=$pid)"; else warn "端口仍未释放，请手动检查"; fi
}

# ===================== 16. 内网访问 IP =====================
do_show_ip() {
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "$ip" ]] && ip="$(ip route get 1 2>/dev/null | awk '{print $7; exit}')"
  if [[ -n "$ip" ]]; then ok "本机内网IPv4地址：$ip"; info "访问示例：http://$ip:$PORT  或  http://localhost:$PORT"; else err "获取失败"; fi
}

# ===================== 17. 磁盘剩余空间 =====================
do_disk() {
  local free; free="$(df -h . | awk 'NR==2 {print $4}')"
  [[ -n "$free" ]] && ok "磁盘剩余空间：$free" || err "读取异常"
}

# ===================== 18. 清理项目缓存 =====================
do_clean_cache() {
  confirm_yn "将清理项目内临时/缓存目录（node_modules/.cache、temp、cache 等，不触碰用户数据与配置），确认？" || { info "· 已取消"; return; }
  local n=0
  for t in node_modules/.cache temp cache; do
    if [[ -e "$t" ]]; then rm -rf "$t" && n=$((n+1)); fi
  done
  ok "已清理 $n 类缓存目录"; audit "清理缓存：$n 类"
}

# ===================== 19. 审计日志 =====================
do_view_audit() {
  if [[ -f "$LOGS_DIR/panel-audit.log" ]]; then info "===== 审计日志 ====="; cat "$LOGS_DIR/panel-audit.log"; else warn "暂无审计日志"; fi
}

# ===================== 20. 导出配置备份（含密钥！） =====================
do_export_config() {
  if [[ ! -f .env ]]; then err ".env 不存在"; return; fi
  local dest="$BACKUP_DIR/config-$(date '+%Y%m%d-%H%M%S').bak"
  cp .env "$dest" && warn "配置备份已导出：$dest（⚠ 含数据库密码等密钥，请妥善保管，勿提交/外传）" && audit "导出配置备份：$dest"
}

# ===================== 21. 快速健康检查 =====================
do_health() {
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/health" 2>/dev/null || echo '000')"
  [[ "$code" == "200" ]] && ok "健康检查通过 (HTTP 200)" || err "健康检查未通过 (HTTP $code)"
}

# ===================== 22. 重置超级管理员密码（破窗恢复） =====================
do_reset_superadmin() {
  warn "⚠ 破窗恢复：将重置/创建超级管理员账号并生成临时密码（无需 Web 登录）。"
  confirm_yn "确认重置超级管理员密码？" || { info "· 已取消"; return; }
  if command -v node >/dev/null 2>&1; then node server/scripts/reset-superadmin.js; else err "未找到 node，无法执行重置脚本"; fi
}

# ===================== 菜单 =====================
while true; do
  echo ""
  info "========== $APP 服务管理（Linux/宝塔） =========="
  echo "  1)   重置初始化（建站引导，仅清引导数据）"
  echo "  2)   启动服务"
  echo "  3)   关闭服务"
  echo "  4)   重启服务"
  echo "  5)   查看服务运行状态"
  echo "  6)   查看最近日志"
  echo "  7)   搜索日志错误"
  echo "  8)   清理全部日志（保留审计）"
  echo "  9)   备份用户数据"
  echo " 10)   清除用户数据【高危】"
  echo " 11)   查看备份列表"
  echo " 12)   从备份恢复数据【高危】"
  echo " 13)   检查运行环境依赖"
  echo " 14)   检测端口占用"
  echo " 15)   释放占用端口【高危】"
  echo " 16)   获取内网访问IP"
  echo " 17)   检查磁盘剩余空间"
  echo " 18)   清理项目缓存"
  echo " 19)   查看审计日志"
  echo " 20)   导出配置备份（含密钥！）"
  echo " 21)   快速健康检查"
  echo " 22)   重置超级管理员密码（破窗恢复）"
  echo "  0)   退出"
  info "=================================================="
  read -r -p "请选择 [0-22]: " choice
  case "$choice" in
    1)  do_reset_wizard ;;
    2)  do_start ;;
    3)  do_stop ;;
    4)  do_restart ;;
    5)  do_status ;;
    6)  do_tail_logs ;;
    7)  do_search_errors ;;
    8)  do_clean_logs ;;
    9)  do_backup ;;
    10) do_clear_data ;;
    11) do_backup_list ;;
    12) do_restore ;;
    13) do_check_env ;;
    14) do_port_check ;;
    15) do_release_port ;;
    16) do_show_ip ;;
    17) do_disk ;;
    18) do_clean_cache ;;
    19) do_view_audit ;;
    20) do_export_config ;;
    21) do_health ;;
    22) do_reset_superadmin ;;
    0)  echo "再见。"; exit 0 ;;
    *)  warn "无效选择，请输入 0-22" ;;
  esac
done
