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

set -uo pipefail

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

echo "========================================"
echo "      境途同游 Web — 部署脚本"
echo "========================================"

DOMAIN=$(prompt DOMAIN "网站域名（如 jingtu.example.com，留空用服务器IP）" "")
DB_NAME=$(prompt DB_NAME "数据库名" "jingtu_group")
DB_USER=$(prompt DB_USER "数据库用户名" "jingtu_user")
DB_PASS=$(prompt DB_PASS "数据库密码" "")
MYSQL_ROOT_PASSWORD=$(prompt MYSQL_ROOT_PASSWORD "MySQL root 密码（留空则跳过自动建库）" "")
PORT=$(prompt PORT "站点端口（Node 监听）" "3456")
REPO_URL=${REPO_URL:-""}

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
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
      && apt-get install -y nodejs \
      && ok "Node.js 安装完成：$(node -v)" && return 0
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
  GROUP_ID=${GROUP_ID:-grp_7a45b436-159c-4d9c-8303-e186ec25fc35}
  VRC_GROUP_URL=${VRC_GROUP_URL:-https://vrchat.com/home/group/$GROUP_ID}
  cat > "$ENV_FILE" <<EOF
# 由 install.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 生成
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=${DB_USER}
MYSQL_PASSWORD=${DB_PASS}
MYSQL_DATABASE=${DB_NAME}

SESSION_SECRET=${SESSION_SECRET}
ENCRYPT_KEY=${ENCRYPT_KEY}

NODE_ENV=production
PORT=${PORT}
TRUST_PROXY=1
LOG_LEVEL=INFO

GROUP_ID=${GROUP_ID}
VRC_GROUP_URL=${VRC_GROUP_URL}
VRC_API_KEY=${VRC_API_KEY:-}
KOOK_URL=${KOOK_URL:-https://www.kookapp.cn/}
OOPZ_URL=${OOPZ_URL:-https://www.oopz.cc/}

CORS_ORIGINS=${CORS_ORIGINS:-}
RTMP_HOST=${RTMP_HOST:-}
RTMP_PORT=1935
RTMP_APP=live
HLS_BASE_URL=${HLS_BASE_URL:-}
EOF
  chmod 600 "$ENV_FILE"
  ok ".env 已生成（权限 600）"
fi

# ---------- 可选：创建数据库与账号 ----------
if [ -n "$MYSQL_ROOT_PASSWORD" ]; then
  info "尝试创建数据库与账号（需要本地 mysql 客户端）..."
  if command -v mysql >/dev/null 2>&1; then
    mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL || warn "建库失败，请通过宝塔手动创建数据库 $DB_NAME / 用户 $DB_USER，并确保密码一致。"
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
    ok "数据库初始化 SQL 已执行"
  else
    warn "未找到 mysql 客户端，跳过自动建库。请通过宝塔数据库面板手动创建："
    warn "  数据库名=$DB_NAME  用户名=$DB_USER  密码=$DB_PASS  权限=本地(127.0.0.1/localhost)"
  fi
else
  warn "未提供 MYSQL_ROOT_PASSWORD，跳过自动建库。"
  warn "请通过宝塔数据库面板先创建：数据库名=$DB_NAME 用户名=$DB_USER 密码=$DB_PASS"
fi

# ---------- 初始化数据表 / 迁移 ----------
info "执行 db_init.js（建表 / 应用迁移）..."
node db_init.js && ok "db_init 完成" || warn "db_init 返回非零，请检查上方日志后重试；无库时应用会以未就绪状态监听。"

# ---------- 生成 PM2 ecosystem 配置 ----------
info "生成 PM2 配置 ecosystem.config.js ..."
cat > "$PROJECT_DIR/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
    name: 'jingtu-web',
    cwd: '${PROJECT_DIR}/server',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1024M',
    env: { NODE_ENV: 'production' }
  }]
};
EOF
ok "ecosystem.config.js 已生成"

# ---------- 生成 Nginx 反向代理配置 ----------
NGINX_DIR="$PROJECT_DIR/deploy/nginx"
mkdir -p "$NGINX_DIR"
CERT_DIR="/www/server/panel/vhost/cert/${DOMAIN:-jingtu}"
cat > "$NGINX_DIR/jingtu.conf" <<EOF
# 境途同游 Web — Nginx 反向代理配置
# 适用：宝塔「网站 → 设置 → 配置文件」整体替换，或独立 Nginx 引入。
# 站点根目录请设为：${PROJECT_DIR}/public （静态资源由 Node 提供，此处仅作反代）

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

    client_max_body_size 200m;

    # 屏蔽公开的 API 文档（生产安全）
    location = /api-docs.json { return 404; }
    location ^~ /api-docs { return 404; }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF
ok "Nginx 配置已生成：$NGINX_DIR/jingtu.conf"

# ---------- 启动服务（PM2） ----------
if command -v pm2 >/dev/null 2>&1; then
  info "通过 PM2 启动服务 ..."
  cd "$PROJECT_DIR"
  pm2 start ecosystem.config.js
  pm2 save
  ok "PM2 已启动 jingtu-web（pm2 status 查看）"
else
  warn "未检测到 pm2，使用 nohup 后台启动（不保证开机自启）。"
  cd "$PROJECT_DIR/server"
  nohup node server.js > "$PROJECT_DIR/logs/app.log" 2>&1 &
  ok "已后台启动（日志：$PROJECT_DIR/logs/app.log）"
  warn "建议安装 PM2 以获得进程守护与开机自启：npm i -g pm2 && pm2 startup"
fi

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
echo "     或直接用生成的配置：网站 → 设置 → 配置文件，整体替换为 $NGINX_DIR/jingtu.conf"
echo "  3) 网站 → SSL：申请/部署证书（路径已写入 jingtu.conf）"
echo "  4) 确认防火墙只开放 80/443 及必要端口，3306 不暴露公网"
echo ""
echo "健康检查："
echo "  curl -fsS http://127.0.0.1:${PORT}/api/health/ready"
echo "========================================"
