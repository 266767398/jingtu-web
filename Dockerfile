# ==================== 境途同游 Web — Dockerfile ====================
# 多阶段构建：builder 阶段完成依赖安装，runtime 阶段仅保留运行所需。
# 要求 Node.js 20+（sharp@0.35 需要）。详见仓库 DEPLOY.md。
#
# 构建并运行：
#   docker compose up -d --build
# 或单独构建镜像：
#   docker build -t jingtu-web:latest .

# ---------- 阶段 1：依赖安装 ----------
FROM node:20-slim AS builder
WORKDIR /app/server
# 先拷贝依赖清单，利用层缓存
COPY server/package.json server/package-lock.json ./
RUN npm ci
# 再拷贝源码（sharp 等包的 postinstall 已在 npm ci 阶段完成）
COPY server/ ./

# ---------- 阶段 2：运行 ----------
FROM node:20-slim AS runtime
LABEL org.opencontainers.image.title="境途同游 Web" \
      org.opencontainers.image.description="VRChat 群组网站 (Node.js + MySQL)" \
      org.opencontainers.image.licenses="ISC"

# 运行时环境变量（可被 docker-compose / -e 覆盖）
ENV NODE_ENV=production \
    PORT=3456 \
    TRUST_PROXY=1

WORKDIR /app

# 运行时共享库：sharp 预编译包自带 libvips，这里仅补充常见依赖与基础工具
RUN apt-get update \
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
RUN mkdir -p uploads backups logs \
 && chown -R node:node uploads backups logs
VOLUME ["/app/uploads", "/app/backups", "/app/logs"]

# 以非 root 用户运行
USER node

EXPOSE 3456

# 入口：等待数据库就绪 → 执行 db_init → 启动服务
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
