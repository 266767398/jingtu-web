#!/usr/bin/env bash
# 境途同游 Web — Docker 入口脚本
# 职责：自动对齐时区（按出口 IP 判定）→ 等待 MySQL 就绪 → 执行 db_init（建表/迁移）→ 启动 Node 服务
set -euo pipefail

# ---------- 时区自动对齐（按出口 IP 判定国家） ----------
# 背景：基础镜像默认 UTC，容器内 Node 的「今天 / 生日 / 签到日」按 UTC 计算，
# 东八区用户在 0:00-8:00 会整体错到前一天（生日、日统计、日志时间都受影响）。
# 策略：
#   · TZ=<显式值>     → 尊重用户设置（如部署在别的时区可写 TZ=Europe/Berlin）。
#   · TZ=auto（默认）→ 依次采用：a) /app/.env 里持久化的 TZ（后台「时间同步」写入，
#       见 server/routes/system_time.js）；b) 出口 IP 判定：中国 → Asia/Shanghai；
#       c) 判定失败 → 回退 Asia/Shanghai（本站为中文社区，回退东八区比 UTC 更合理，
#       避免容器无外网时日志/签到整体差 8 小时）。
# 说明：Node 内置完整 ICU 时区库，export TZ 后 new Date()/toLocale* 立即按该时区计算，
#       无需安装 tzdata、也无需写 /etc/localtime（容器以非 root 运行，本就无权限写）。
if [ "${TZ:-auto}" = "auto" ] || [ -z "${TZ:-}" ]; then
  # a) 优先读后台按钮持久化的 .env TZ（防止外界覆盖 compose 注入值后仍回到 UTC）
  ENV_FILE_TZ="$(grep -E '^[[:space:]]*TZ=' /app/.env 2>/dev/null | tail -n 1 | cut -d= -f2-)"
  ENV_FILE_TZ="$(printf '%s' "${ENV_FILE_TZ}" | tr -d "\"' \t")"
  if [ -n "${ENV_FILE_TZ:-}" ] && [ "${ENV_FILE_TZ}" != "auto" ]; then
    export TZ="${ENV_FILE_TZ}"
    echo "[entrypoint] 时区：读取 .env 持久化值 → TZ=${TZ}"
  else
    echo "[entrypoint] 正在按出口 IP 自动判定时区（TZ=auto）..."
    IP_COUNTRY="$(node -e '
      const urls = [
        "https://ipinfo.io/country",
        "https://ifconfig.co/country-iso",
        "https://ipapi.co/country/"
      ];
      (async () => {
        for (const u of urls) {
          try {
            const c = await fetch(u, { signal: AbortSignal.timeout(5000) });
            const t = (await c.text()).trim().toUpperCase();
            if (/^[A-Z]{2}$/.test(t)) { process.stdout.write(t); return; }
          } catch (e) { /* 换下一个源 */ }
        }
      })();
    ' 2>/dev/null || true)"
    if [ "${IP_COUNTRY:-}" = "CN" ]; then
      export TZ="Asia/Shanghai"
    else
      # 判定失败或非中国时不再回退 UTC：本站定位中文社区，东八区兜底更贴合实际。
      export TZ="Asia/Shanghai"
    fi
    echo "[entrypoint] 时区判定：出口 IP 国家=${IP_COUNTRY:-未知} → TZ=${TZ}"
  fi
else
  export TZ
  echo "[entrypoint] 时区：使用显式配置 TZ=${TZ}"
fi

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
