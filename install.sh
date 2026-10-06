#!/usr/bin/env bash
# =============================================================================
# 境途同游 Web — 宝塔 / 裸机 一键部署脚本（改进版）
# -----------------------------------------------------------------------------
# 能力：
#   1. 支持在「已克隆的项目目录内」直接部署，或按 REPO_URL 克隆到 /www/wwwroot。
#   2. 检测并（在 Debian/Ubuntu 上）自动安装 Node.js 20（也可改用宝塔的 Node 版本管理器）。
#   3. 安装依赖（有 lockfile 用 npm ci，否则 npm install）。
#   4. 可选：用 MySQL 客户端创建数据库与账号（提供 root 密码时）。
#   5. 生成根目录 .env（密钥自动随机生成，未提供时）。
#   6. 执行 db_init.js 建表 / 迁移。
#   7. 生成 PM2 的 ecosystem.config.js 并启动（若已安装 pm2）。
#   8. 生成 Nginx 反向代理配置（deploy/nginx/jingtu.conf），供宝塔「配置文件」导入。
#
# 非交互用法（推荐服务器上用）：
#   REPO_URL=https://github.com/你的名/jingtu-web.git \
#   DOMAIN=jingtu.example.com DB_NAME=jingtu_group DB_USER=jingtu_user \
#   DB_PASS='强密码' MYSQL_ROOT_PASSWORD='root强密码' \
#   bash install.sh
#
# 交互用法：
#   bash install.sh
# =============================================================================

# P1-17：补上 -e ——旧实现仅 -u，中间步骤失败（如写文件失败、子命令失败）会被忽略，
# 脚本照样走到末尾打印「部署完成」。各失败点均有显式 || 兜底，errexit 只作安全网。
set -euo pipefail

# ---------- 颜色 ----------
if [ -t 1 ]; then
  C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YEL='\033[0;33m'; C_CYN='\033[0;36m'; C_RST='\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_CYN=''; C_RST=''
fi
info()  { echo -e "${C_CYN}[INFO]${C_RST} $*"; }
ok()    { echo -e "${C_GRN}[ OK ]${C_RST} $*"; }
warn()  { echo -e "${C_YEL}[WARN]${C_RST} $*"; }
err()   { echo -e "${C_RED}[FAIL]${C_RST} $*"; }

# ---------- 读取参数（环境变量优先，缺失时交互询问） ----------
prompt() {
  # $1=变量名 $2=提示语 $3=默认值
  local var="$1" text="$2" def="${3:-}" val
  if [ -n "${!var:-}" ]; then val="${!var}"; else
    if [ -t 0 ]; then
      read -r -p "$text${def:+ [$def]}: " val
      val="${val:-$def}"
    else
      val="$def"
    fi
  fi
  printf '%s' "$val"
}

# P2-92：秘密输入专用——read -s 不回显，避免密码进终端屏幕与 shell 历史
prompt_secret() {
  # $1=变量名 $2=提示语
  local var="$1" text="$2" val
  if [ -n "${!var:-}" ]; then val="${!var}"; else
    if [ -t 0 ]; then
      read -r -s -p "$text: " val; echo "" >&2
    else
      val=""
    fi
  fi
  printf '%s' "$val"
}

echo "========================================"
echo "      境途同游 Web — 部署脚本"
echo "========================================"

DOMAIN=$(prompt DOMAIN "网站域名（如 jingtu.example.com，留空用服务器IP）" "")
DB_NAME=$(prompt DB_NAME "数据库名" "jingtu_group")
DB_USER=$(prompt DB_USER "数据库用户名" "jingtu_user")
DB_PASS=$(prompt_secret DB_PASS "数据库密码")
# P3-21 ①：DB_PASS 必填——非交互环境下 prompt_secret 返回空串，
# 空密码生成的 MYSQL_PASSWORD= 会让应用连库必失败，直接终止而非带病部署。
if [ -z "$DB_PASS" ]; then
  err "数据库密码不能为空（DB_PASS）。"
  exit 1
fi
# P4-sweep：DB_PASS 仅允许可打印字符——拒绝反斜杠（MySQL 按转义序列解析，会造成
# 实际存储密码与 .env 不一致）、换行/控制字符（可向 .env 注入额外键污染配置）。
if printf '%s' "$DB_PASS" | grep -Eq '[\\\x00-\x1F]' || ! printf '%s' "$DB_PASS" | grep -Eq '^[[:print:]]+$'; then
  err "数据库密码含非法字符（不允许反斜杠、换行与控制字符，建议字母+数字+符号）。"
  exit 1
fi
MYSQL_ROOT_PASSWORD=$(prompt_secret MYSQL_ROOT_PASSWORD "MySQL root 密码（留空则跳过自动建库）")
PORT=$(prompt PORT "站点端口（Node 监听）" "3456")
REPO_URL=${REPO_URL:-""}

# P2-92：库名/用户名字符白名单——两者会被拼进 SQL heredoc（标识符/字符串字面量），
# 白名单校验比事后转义可靠；不合法直接终止，不做静默清洗。
if ! printf '%s' "$DB_NAME" | grep -Eq '^[A-Za-z0-9_]+$'; then
  err "数据库名非法（仅允许字母、数字、下划线）：$DB_NAME"
  exit 1
fi
if ! printf '%s' "$DB_USER" | grep -Eq '^[A-Za-z0-9_]+$'; then
  err "数据库用户名非法（仅允许字母、数字、下划线）：$DB_USER"
  exit 1
fi
# P2-104/P3-21：DOMAIN 会被拼进 nginx heredoc（server_name）与 CERT_DIR 路径——
# 无白名单时含 $( ) 被二次展开（命令注入）、含 ../ 造成证书目录穿越。
# 域名仅允许字母、数字、-、.（可带端口号；留空=用服务器 IP）。
# P4-sweep：显式拒绝 .. 与首尾 . / -，杜绝 "."、".."、"a..b" 等上溯/污染 CERT_DIR。
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]+)?$'; then
  err "网站域名非法（仅允许标准域名/子域名，可选端口号）：$DOMAIN"
  exit 1
fi
# P2-104/P3-21：PORT 会被拼进 nginx heredoc 与 .env，仅允许 1-65535 的数字。
if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  err "站点端口非法（仅允许 1-65535 的数字）：$PORT"
  exit 1
fi

# ---------- 确定项目目录 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/server/server.js" ]; then
  PROJECT_DIR="$SCRIPT_DIR"
  info "在当前目录部署：$PROJECT_DIR"
elif [ -n "$REPO_URL" ]; then
  DEFAULT_WWW="/www/wwwroot"
  TARGET="$DEFAULT_WWW/jingtu-web"
  info "克隆仓库到 $TARGET ..."
  command -v git >/dev/null 2>&1 || { err "未找到 git，请先安装 git 后重试。"; exit 1; }
  mkdir -p "$DEFAULT_WWW"
  if [ -d "$TARGET/.git" ]; then
    info "目标已存在，执行 git pull ..."
    git -C "$TARGET" pull --ff-only || warn "git pull 失败，继续使用现有代码"
  else
    git clone "$REPO_URL" "$TARGET" || { err "克隆失败，请检查 REPO_URL 与网络。"; exit 1; }
  fi
  PROJECT_DIR="$TARGET"
else
  err "当前目录不是项目根（缺少 server/server.js），且未提供 REPO_URL。"
  err "请在已克隆的项目目录内运行，或设置 REPO_URL 环境变量后重试。"
  exit 1
fi

# ---------- 安装 Node.js 20（如缺失或版本过低） ----------
require_node() {
  local need=20 have="" have_major=""
  if command -v node >/dev/null 2>&1; then
    have=$(node -v 2>/dev/null | sed 's/^v//')
    have_major=$(echo "$have" | cut -d. -f1)
  fi
  if [ -n "$have_major" ] && [ "$have_major" -ge "$need" ]; then
    ok "Node.js 已满足要求：v$have"
    return 0
  fi
  warn "需要 Node.js >= $need，当前为 ${have:-未安装}。尝试自动安装 ..."
  if command -v apt-get >>/dev/null 2>&1; then
    # P1-17：原为「curl | bash - && apt-get … && ok … && return 0」长链——
    # 在 set -e 下链中失败会直接触发 errexit 终止脚本，改写成 if 形式保留
    # 「安装失败 → 打印手动安装指引 → exit 1」的原有流程。
    if curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
        && apt-get install -y nodejs; then
      ok "Node.js 安装完成：$(node -v)"
      return 0
    fi
    err "通过 NodeSource 自动安装失败。"
  else
    err "当前系统非 apt（Debian/Ubuntu），无法自动安装 Node。"
  fi
  warn "请通过以下任一种方式安装 Node.js 20+ 后重新运行本脚本："
  warn "  - 宝塔面板 → 软件商店 → Node.js 版本管理器，安装 20.x 并设为默认；"
  warn "  - 或访问 https://nodejs.org 下载安装。"
  exit 1
}
require_node

# ---------- 安装依赖 ----------
info "安装 Node 依赖（server/）..."
cd "$PROJECT_DIR/server"
if [ -f package-lock.json ]; then
  npm ci || { err "npm ci 失败，尝试 npm install ..."; npm install || { err "依赖安装失败。"; exit 1; }; }
else
  npm install || { err "依赖安装失败。"; exit 1; }
fi
ok "依赖安装完成"

# ---------- 生成 .env ----------
ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  warn "已存在 .env，保留不覆盖（如要重新生成请先备份删除）。"
else
  info "生成根目录 .env ..."
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  ENCRYPT_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  # P2-105：恢复令牌随机生成（≥32 字节 hex）——避免默认空值导致 /api/system/db-recover 永久 503。
  # 令牌仅写入 .env（权限 600），脚本不打印明文；需要时可自行从 .env 读取。
  RECOVERY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  GROUP_ID=${GROUP_ID:-grp_7a45b436-159c-4d9c-8303-e186ec25fc35}
  VRC_GROUP_URL=${VRC_GROUP_URL:-https://vrchat.com/home/group/$GROUP_ID}
  # P2-104：全部动态值改用 printf %s 字面写入——未加引号的 heredoc 会对 ${VAR} 二次展开，
  # 变量含反引号 / $( ) 时会被当作命令执行（注入到生成文件）；printf 仅做字面拼接，无此风险。
  # 静态行用 <<'EOF'（引号定界）同样不做任何展开。DB_USER/DB_NAME 已在上文做白名单校验。
  cat > "$ENV_FILE" <<'EOF'
# 由 install.sh 生成
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
EOF
  printf 'MYSQL_USER=%s\n' "$DB_USER" >> "$ENV_FILE"
  printf 'MYSQL_DATABASE=%s\n' "$DB_NAME" >> "$ENV_FILE"
  printf 'MYSQL_PASSWORD=%s\n' "$DB_PASS" >> "$ENV_FILE"
  printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET" >> "$ENV_FILE"
  printf 'ENCRYPT_KEY=%s\n' "$ENCRYPT_KEY" >> "$ENV_FILE"
  cat >> "$ENV_FILE" <<'EOF'
NODE_ENV=production
TRUST_PROXY=1
LOG_LEVEL=INFO
EOF
  printf 'PORT=%s\n' "$PORT" >> "$ENV_FILE"
  printf 'GROUP_ID=%s\n' "$GROUP_ID" >> "$ENV_FILE"
  printf 'VRC_GROUP_URL=%s\n' "$VRC_GROUP_URL" >> "$ENV_FILE"
  printf 'VRC_API_KEY=%s\n' "${VRC_API_KEY:-}" >> "$ENV_FILE"
  printf 'KOOK_URL=%s\n' "${KOOK_URL:-https://www.kookapp.cn/}" >> "$ENV_FILE"
  printf 'OOPZ_URL=%s\n' "${OOPZ_URL:-https://www.oopz.cc/}" >> "$ENV_FILE"
  printf 'CORS_ORIGINS=%s\n' "${CORS_ORIGINS:-}" >> "$ENV_FILE"
  printf 'RTMP_HOST=%s\n' "${RTMP_HOST:-}" >> "$ENV_FILE"
  printf 'RTMP_PORT=%s\n' "${RTMP_PORT:-1935}" >> "$ENV_FILE"
  printf 'RTMP_APP=%s\n' "${RTMP_APP:-live}" >> "$ENV_FILE"
  printf 'HLS_BASE_URL=%s\n' "${HLS_BASE_URL:-}" >> "$ENV_FILE"
  # P2-105：补齐代码实际消费的关键变量（站点地址/恢复通道/SMTP/保留策略/面板/激活码/VRC 数据源）
  printf 'APP_URL=%s\n' "${APP_URL:-}" >> "$ENV_FILE"
  printf 'SITEMAP_BASE_URL=%s\n' "${SITEMAP_BASE_URL:-}" >> "$ENV_FILE"
  printf 'APP_BASE_URL=%s\n' "${APP_BASE_URL:-}" >> "$ENV_FILE"
  printf 'WS_URL=%s\n' "${WS_URL:-}" >> "$ENV_FILE"
  printf 'RECOVERY_TOKEN=%s\n' "$RECOVERY_TOKEN" >> "$ENV_FILE"
  printf 'SMTP_HOST=%s\n' "${SMTP_HOST:-}" >> "$ENV_FILE"
  printf 'SMTP_PORT=%s\n' "${SMTP_PORT:-587}" >> "$ENV_FILE"
  printf 'SMTP_USER=%s\n' "${SMTP_USER:-}" >> "$ENV_FILE"
  printf 'SMTP_PASS=%s\n' "${SMTP_PASS:-}" >> "$ENV_FILE"
  printf 'SMTP_PASSWORD=%s\n' "${SMTP_PASSWORD:-}" >> "$ENV_FILE"
  printf 'SMTP_SECURE=%s\n' "${SMTP_SECURE:-false}" >> "$ENV_FILE"
  printf 'SMTP_FROM=%s\n' "${SMTP_FROM:-}" >> "$ENV_FILE"
  printf 'ADMIN_EMAIL=%s\n' "${ADMIN_EMAIL:-}" >> "$ENV_FILE"
  printf 'FILE_RETENTION_DAYS=%s\n' "${FILE_RETENTION_DAYS:-90}" >> "$ENV_FILE"
  printf 'NOTIFICATION_RETENTION_DAYS=%s\n' "${NOTIFICATION_RETENTION_DAYS:-30}" >> "$ENV_FILE"
  printf 'BACKUP_RETENTION_DAYS=%s\n' "${BACKUP_RETENTION_DAYS:-7}" >> "$ENV_FILE"
  printf 'PANEL_PORT=%s\n' "${PANEL_PORT:-3457}" >> "$ENV_FILE"
  printf 'ACTIVATION_CODES_FILE=%s\n' "${ACTIVATION_CODES_FILE:-}" >> "$ENV_FILE"
  printf 'VRC_USER_AGENT=%s\n' "${VRC_USER_AGENT:-}" >> "$ENV_FILE"
  printf 'VRCX_SEARCH_URL=%s\n' "${VRCX_SEARCH_URL:-}" >> "$ENV_FILE"
  # 第九批：补齐 cache.js 消费的 Redis 系与 db.js 消费的 SQLite 模式键（空值=关闭/MySQL，对齐 .env.example）
  printf 'REDIS_HOST=%s\n' "${REDIS_HOST:-}" >> "$ENV_FILE"
  printf 'REDIS_PORT=%s\n' "${REDIS_PORT:-6379}" >> "$ENV_FILE"
  printf 'REDIS_PASSWORD=%s\n' "${REDIS_PASSWORD:-}" >> "$ENV_FILE"
  printf 'REDIS_DB=%s\n' "${REDIS_DB:-0}" >> "$ENV_FILE"
  printf 'JINGTU_DB_ENGINE=%s\n' "${JINGTU_DB_ENGINE:-}" >> "$ENV_FILE"
  printf 'JINGTU_SQLITE_PATH=%s\n' "${JINGTU_SQLITE_PATH:-}" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env 已生成（权限 600）"
  # P2-105：未配置项提示——关键变量留空时的行为与补充指引
  if [ -z "${APP_URL:-}" ]; then
    warn "APP_URL 未设置：邮件内重置/通知链接将回退 http://localhost:3456，生产请编辑 $ENV_FILE 补全"
  fi
  if [ -z "${SMTP_HOST:-}" ]; then
    warn "SMTP_HOST 未设置：全部邮件功能静默关闭（密码重置、系统通知、告警邮件均不会发送）"
  fi
fi

# ---------- 可选：创建数据库与账号 ----------
if [ -n "$MYSQL_ROOT_PASSWORD" ]; then
  info "尝试创建数据库与账号（需要本地 mysql 客户端）..."
  if command -v mysql >/dev/null 2>&1; then
    # P2-80：密码改走 --defaults-extra-file（0600 临时文件）——旧实现 `-p"$PASS"`
    # 虽已加引号，但仍会出现在 /proc 进程列表里，同机任意用户可见。
    # SQL 字面量里的密码需把单引号翻倍转义，否则含 ' 的密码会截断语句。
    MYSQL_CNF=$(mktemp)
    # P2-94：此临时文件内含 MySQL root 明文密码。旧实现只在 mysql 成功后 rm，
    # 一旦中途报错退出（set -e）就会把带密码的文件留在 /tmp。改为 EXIT trap 兜底。
    cleanup_mysql_cnf() {
      local p="${MYSQL_CNF:-}"
      [ -n "$p" ] && rm -f -- "$p"
      return 0
    }
    trap cleanup_mysql_cnf EXIT
    chmod 600 "$MYSQL_CNF"
    printf '[client]\nuser=root\npassword=%s\n' "$MYSQL_ROOT_PASSWORD" > "$MYSQL_CNF"
    DB_PASS_ESC=${DB_PASS//\'/\'\'}
    # P2-104：SQL heredoc 同步改为 printf 字面注入——未加引号的 <<SQL 会对 ${DB_PASS_ESC}
    # 二次展开，密码含反引号 / $( ) 时会被当作命令执行；printf %s 仅做字面拼接。
    # DB_NAME/DB_USER 已在上文白名单校验（仅字母数字下划线）。
    {
      printf 'CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n' "$DB_NAME"
      printf "CREATE USER IF NOT EXISTS '%s'@'127.0.0.1' IDENTIFIED BY '%s';\n" "$DB_USER" "$DB_PASS_ESC"
      printf "GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'127.0.0.1';\n" "$DB_NAME" "$DB_USER"
      printf "CREATE USER IF NOT EXISTS '%s'@'localhost' IDENTIFIED BY '%s';\n" "$DB_USER" "$DB_PASS_ESC"
      printf "GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'localhost';\n" "$DB_NAME" "$DB_USER"
      printf 'FLUSH PRIVILEGES;\n'
    } | mysql --defaults-extra-file="$MYSQL_CNF" || warn "建库失败，请通过宝塔手动创建数据库 $DB_NAME / 用户 $DB_USER，并确保密码一致。"
    rm -f -- "$MYSQL_CNF"
    ok "数据库初始化 SQL 已执行"
  else
    warn "未找到 mysql 客户端，跳过自动建库。请通过宝塔数据库面板手动创建："
    warn "  数据库名=$DB_NAME  用户名=$DB_USER  权限=本地(127.0.0.1/localhost)"
    warn "  密码：不在此回显，请从 $ENV_FILE 的 MYSQL_PASSWORD 行取值保持一致（P2-92）。"
  fi
else
  warn "未提供 MYSQL_ROOT_PASSWORD，跳过自动建库。"
  # P2-92：密码不再屏显回显，终端历史记录/截屏/远程会话日志都会带走明文。
  warn "请通过宝塔数据库面板先创建：数据库名=$DB_NAME 用户名=$DB_USER"
  warn "  密码：不在此回显，请从 $ENV_FILE 的 MYSQL_PASSWORD 行取值保持一致。"
fi

# ---------- 初始化数据表 / 迁移 ----------
info "执行 db_init.js（建表 / 应用迁移）..."
node db_init.js && ok "db_init 完成" || warn "db_init 返回非零，请检查上方日志后重试；无库时应用会以未就绪状态监听。"

# ---------- 生成 PM2 ecosystem 配置 ----------
# P2-80：ecosystem.config.js 是 git 跟踪文件（仓库版含 PM2 日志落盘配置），
# 旧实现无条件覆盖会弄脏工作树并丢掉日志配置。已存在则保留。
if [ -f "$PROJECT_DIR/ecosystem.config.js" ]; then
  ok "已存在 ecosystem.config.js（仓库自带标准版，含 PM2 日志配置），保留不覆盖"
else
  info "生成 PM2 配置 ecosystem.config.js ..."
  # P2-104：heredoc 引号定界 + printf 字面注入（PROJECT_DIR 若含 $( )/反引号不再被执行）
  printf "module.exports = {\n  apps: [{\n    name: 'jingtu-web',\n    cwd: '%s',\n    script: 'server.js',\n    instances: 1,\n    exec_mode: 'fork',\n    autorestart: true,\n    exp_backoff_restart_delay: 500,\n    watch: false,\n    max_memory_restart: '1024M',\n    out_file: '%s',\n    error_file: '%s',\n    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',\n    merge_logs: true,\n    env: { NODE_ENV: 'production' }\n  }]\n};\n" "$PROJECT_DIR/server" "$PROJECT_DIR/logs/pm2-out.log" "$PROJECT_DIR/logs/pm2-error.log" > "$PROJECT_DIR/ecosystem.config.js"
  ok "ecosystem.config.js 已生成"
fi

# ---------- 生成 Nginx 反向代理配置 ----------
NGINX_DIR="$PROJECT_DIR/deploy/nginx"
mkdir -p "$NGINX_DIR"
CERT_DIR="/www/server/panel/vhost/cert/${DOMAIN:-jingtu}"
# P2-80：deploy/nginx/jingtu.conf 同为 git 跟踪文件，已存在时不覆盖，
# 生成到 jingtu.conf.generated，由运维 diff 后自行替换。
if [ -f "$NGINX_DIR/jingtu.conf" ]; then
  NGINX_CONF="$NGINX_DIR/jingtu.conf.generated"
  warn "已存在 $NGINX_DIR/jingtu.conf（仓库跟踪文件），不覆盖；本次生成到 jingtu.conf.generated，请 diff 后自行替换。"
else
  NGINX_CONF="$NGINX_DIR/jingtu.conf"
fi
cat > "$NGINX_CONF" <<EOF
# 境途同游 Web — Nginx 反向代理配置
# 适用：宝塔「网站 → 设置 → 配置文件」整体替换，或独立 Nginx 引入。
# 站点根目录请设为：${PROJECT_DIR}/public （静态资源由 Node 提供，此处仅作反代）
# P2-91/P2-92 级联：本生成块与 deploy/nginx/jingtu.conf 模板保持同步。

# P2-91：Upgrade 头联动 Connection——避免硬编码 Connection "upgrade" 破坏普通 HTTP keep-alive。
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

# P2-91：接口级限流（登录/注册 5r/m，其余 API 30r/s 突发 60），仅作用于 API。
limit_req_zone \$binary_remote_addr zone=jingtu_api:10m rate=30r/s;
limit_req_zone \$binary_remote_addr zone=jingtu_auth:10m rate=5r/m;

server {
    listen 80;
    server_name ${DOMAIN:-_};
    # 证书申请后由 443 段接管，这里仅做跳转
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN:-_};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 500m;

    # P2-91：安全响应头（CSP / X-Frame-Options / HSTS / nosniff / Referrer-Policy）
    # 由 Node 统一设置（server/server.js 安全头中间件，含面板路径豁免），
    # 这里刻意不用 add_header 重复添加，避免双份头与豁免冲突。

    # 屏蔽公开的 API 文档（生产安全）
    location = /api-docs.json { return 404; }
    location ^~ /api-docs { return 404; }

    # P2-91：登录/注册等认证接口单独限流（防撞库），超出直接 429
    location ^~ /api/auth/ {
        limit_req zone=jingtu_auth burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # P2-91：其余 API 匀速限流，容忍突发
    location ^~ /api/ {
        limit_req zone=jingtu_api burst=60 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # WebSocket（/ws）与常规请求共用反代
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF
ok "Nginx 配置已生成：$NGINX_CONF"

# ---------- 启动服务（PM2） ----------
# P1-17：logs/ 必须先行创建——旧脚本仅在个别条件分支里 mkdir，
# nohup 重定向到不存在的 $PROJECT_DIR/logs/app.log 会直接失败，
# 服务根本没起来，末尾却照样打印「部署完成」。
mkdir -p "$PROJECT_DIR/logs"
if command -v pm2 >/dev/null 2>&1; then
  info "通过 PM2 启动服务 ..."
  cd "$PROJECT_DIR"
  pm2 start ecosystem.config.js || { err "pm2 start 失败，请检查上方输出与 $PROJECT_DIR/logs/pm2-error.log。"; exit 1; }
  pm2 save || warn "pm2 save 失败（开机自启可能未写入），可稍后手动重试：pm2 save"
  # P2-80：pm2-*.log 自身无按大小轮转，依赖 pm2-logrotate 模块；装不上只警告不阻断。
  pm2 install pm2-logrotate >/dev/null 2>&1 || warn "pm2-logrotate 模块安装失败，PM2 日志不会自动轮转，建议手动执行：pm2 install pm2-logrotate"
  ok "PM2 已启动 jingtu-web（pm2 status 查看）"
else
  warn "未检测到 pm2，使用 nohup 后台启动（不保证开机自启）。"
  cd "$PROJECT_DIR/server"
  nohup node server.js > "$PROJECT_DIR/logs/app.log" 2>&1 &
  ok "已后台启动（日志：$PROJECT_DIR/logs/app.log）"
  warn "建议安装 PM2 以获得进程守护与开机自启：npm i -g pm2 && pm2 startup"
fi

# ---------- 健康探测（P1-17：探活通过才宣布部署完成） ----------
info "健康探测 http://127.0.0.1:${PORT}/api/health/live（最长约 30s）..."
health_ok=0
for _i in $(seq 1 15); do
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:${PORT}/api/health/live" >/dev/null 2>&1 && { health_ok=1; break; }
  else
    node -e "require('http').get('http://127.0.0.1:${PORT}/api/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" && { health_ok=1; break; }
  fi
  sleep 2
done
if [ "$health_ok" -ne 1 ]; then
  err "服务未在 30s 内通过健康探测，部署未确认成功。"
  err "排查：pm2 logs jingtu-web  或  tail -n 50 $PROJECT_DIR/logs/app.log"
  err "修复后再确认：curl -fsS http://127.0.0.1:${PORT}/api/health/ready"
  exit 1
fi
ok "服务健康探测通过"

# ---------- 完成提示 ----------
echo ""
echo "========================================"
echo "      部署完成！"
echo "========================================"
echo "项目目录 : $PROJECT_DIR"
echo "Node 端口: $PORT"
echo "访问地址 : http://${DOMAIN:-服务器IP}/"
echo ""
echo "首次使用请访问建站向导完成初始化："
echo "  http://${DOMAIN:-服务器IP}/setup.html"
echo ""
echo "宝塔后续步骤："
echo "  1) 网站 → 创建站点（域名 ${DOMAIN:-服务器IP}，根目录 ${PROJECT_DIR}/public）"
echo "  2) 网站 → 设置 → 反向代理：目标 http://127.0.0.1:${PORT}"
echo "     或直接用生成的配置：网站 → 设置 → 配置文件，整体替换为 $NGINX_CONF"
echo "  3) 网站 → SSL：申请/部署证书（路径已写入 jingtu.conf）"
echo "  4) 确认防火墙只开放 80/443 及必要端口，3306 不暴露公网"
echo ""
echo "健康检查："
echo "  curl -fsS http://127.0.0.1:${PORT}/api/health/ready"
echo "========================================"
