#!/usr/bin/env bash
# 境途同游 Web — Docker 入口脚本
# 职责：等待 MySQL 就绪 → 执行 db_init（建表/迁移）→ 启动 Node 服务
set -euo pipefail

cd /app/server

# ---------- 等待数据库就绪 ----------
# P2-74：默认值对齐 db.js 中 `process.env.MYSQL_HOST || '127.0.0.1'` 的代码默认。
# 旧实现 MYSQL_HOST 为空时整段「跳过等待」，但应用照样会去连 127.0.0.1——
# 等待缺口毫无意义，容器首启时反而更容易撞上数据库未就绪。改为恒等待。
DB_HOST="${MYSQL_HOST:-127.0.0.1}"
DB_PORT="${MYSQL_PORT:-3306}"

echo "[entrypoint] 等待数据库 ${DB_HOST}:${DB_PORT} 就绪（最长 120 秒）..."
ready=0
for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/"${DB_HOST}"/"${DB_PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    echo "[entrypoint] 数据库端口已可达"
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "[entrypoint] 警告：等待数据库超时（120s），仍尝试继续启动（服务将以未就绪状态监听）"
fi

# ---------- 初始化数据库（建表 / 应用迁移） ----------
# 失败不阻断启动：无数据库时服务仍监听以便访问 /setup 向导；
# 就绪状态请以 /api/health/ready 为准。
echo "[entrypoint] 执行 db_init.js ..."
if node db_init.js; then
  echo "[entrypoint] db_init 完成"
else
  echo "[entrypoint] db_init 返回非零（详见上方日志），继续启动服务"
fi

# ---------- 启动服务 ----------
echo "[entrypoint] 启动 Node 服务 (PORT=${PORT:-3456}) ..."
exec node server.js
