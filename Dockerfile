# ==================== 境途同游 Web — Dockerfile ====================
# 多阶段构建：builder 阶段完成依赖安装，runtime 阶段仅保留运行所需。
# 要求 Node.js 20+（sharp@0.35 需要）。详见仓库 DEPLOY.md。
#
# 构建并运行：
#   docker compose up -d --build
# 或单独构建镜像：
#   docker build -t jingtu-web:latest .

# ---------- 阶段 1：依赖安装 ----------
# P2-96：基础镜像由 ARG 统一钉定、两阶段共用，升级只改一处。
# Node 20 已于 2026-04 EOL，迁移到 node:22-slim（CI matrix 已覆盖 22 并验证）。
# P4：默认走 DaoCloud 国内加速（docker.m.daocloud.io），飞牛 NAS 等国内机器
# 不再依赖 Docker Hub 慢速通道；需要官方源时用 --build-arg NODE_IMAGE=node:22-slim。
# 如需更强供应链保障，用 `docker buildx imagetools inspect node:22-slim`
# 取当前 digest，再以 node:22-slim@sha256:<digest> 形式替换。
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-slim
FROM ${NODE_IMAGE} AS builder
WORKDIR /app/server
# 先拷贝依赖清单，利用层缓存；runtime 阶段直接复用这里的 node_modules，
# devDependencies（测试/工具链）不进镜像，缩小体积与攻击面
# P4：npm 源默认切 npmmirror（registry.npmjs.org 在国内 / 飞牛 NAS 拉包极慢）。
# 构建时可用 --build-arg NPM_REGISTRY=https://registry.npmjs.org 换回官方源。
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY}
# 再拷贝源码（sharp 等包的 postinstall 已在 npm ci 阶段完成）
COPY server/ ./

# ---------- 阶段 2：运行 ----------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="境途同游 Web" \
      org.opencontainers.image.description="VRChat 群组网站 (Node.js + MySQL)" \
      org.opencontainers.image.licenses="ISC"

# 运行时环境变量（可被 docker-compose / -e 覆盖）
# P3-25：TRUST_PROXY 默认 0（不信任代理），与 server.js 安全默认一致；反代部署请显式设 1。
ENV NODE_ENV=production \
    PORT=3456 \
    TRUST_PROXY=0

WORKDIR /app

# 运行时共享库：sharp 预编译包自带 libvips，这里仅补充常见依赖与基础工具。
# P4：apt 源默认切阿里云镜像（deb.debian.org 在国内 / 飞牛 NAS 拉包极慢）。
# 构建时可用 --build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn 一键换镜像。
ARG APT_MIRROR=mirrors.aliyun.com
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
 && rm -rf /var/lib/apt/lists/*

# 复制已安装的依赖（含原生模块）
COPY --from=builder /app/server/node_modules ./server/node_modules
# 复制应用代码与静态资源
COPY server/ ./server/
COPY public/ ./public/
COPY assets/ ./assets/
# P2-74：容器采用「不可变配置」设计——环境变量（docker-compose / -e）是唯一配置来源。
# 应用中三条写 .env 的通道（/setup 向导、配置管理页、db-recover 写回）在容器内
# 会因代码目录属 root、进程跑 node 用户而写入失败，这是刻意保留的：
# 容器进程不应能自行修改自身配置。改配置的正确姿势是编辑 docker.env.example /
# compose 文件后 `docker compose up -d --build` 重建容器，下面的模板仅供阅读变量清单。
# 暴露 .env 模板（真实配置优先通过环境变量注入）
COPY .env.example /app/.env.example

# 运行时需要可写的目录（同时声明为卷，便于持久化与备份）
# P2-101/102：assets（相册落盘 + 头像代理缓存）与 server/data（激活码离线存储 +
# SQLite 模式库文件）一并 chown 给 node——否则 USER node 后 mkdirSync/写入必 EACCES。
# server/data 必须随卷持久化：容器重建/删除后激活码与 SQLite 数据不丢
# （docker-compose.yml / docker-compose.standalone.yml 已挂载 data:/app/server/data）。
# 预创建空的 /app/.env 并 chown 给 node：容器内环境变量仍是唯一配置来源
# （/setup 向导、/api/auth/init 落盘的 .env 值不覆盖已注入的环境变量），但 .env
# 存在且可写后，登录页「初始化管理员」/ 建站向导在容器内可正常完成超管创建与
# 数据库建表，无需在 compose 里手填数据库信息；重走向导同样可写（仅作用于磁盘草稿）。
RUN mkdir -p uploads backups logs server/data \
 && touch /app/.env \
 && chown node:node /app \
 && chown -R node:node uploads backups logs assets server/data \
 && chown node:node /app/.env
VOLUME ["/app/uploads", "/app/backups", "/app/logs", "/app/server/data"]

# 入口脚本：等待数据库就绪 → 执行 db_init → 启动服务。
# 必须在 USER node 之前以 root 复制并加执行权限（/usr/local/bin 属 root，
# 切换 node 用户后无权 chmod，否则构建报 "Operation not permitted"）。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 以非 root 用户运行
USER node

EXPOSE 3456

# P2-96：存活探针指向 /api/health/live（routes/health.js，纯进程存活、
# 不依赖 MySQL/Redis），避免数据库瞬时抖动触发容器重启风暴；
# 入口脚本需等库就绪并执行 db_init，故给足 start-period。
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3456}/api/health/live" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
