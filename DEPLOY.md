# 境途同游 Web — 部署指南（Docker / 宝塔 / 裸机）

> 适用版本：server `1.3.0` / 启动日志 `V7.10`
> 本文覆盖三种部署方式，并列出生产必检项。更底层的架构与运维细节见 `docs/03-部署与运维.md`（完整文档索引见 `docs/README.md`）。

---

## 〇、部署前准备（三种方式通用）

### 1. 运行环境要求

| 组件 | 要求 |
|---|---|
| Node.js | **20.9.0+**（sharp@0.35 需要） |
| MySQL | 5.7+ 或 8.0+（必需；代码使用 JSON 列） |
| Redis | 可选，当前处于休眠状态，无需部署 |
| Nginx / 宝塔 | 仅用于反向代理与 TLS 终结（推荐） |

### 2. 必填密钥（务必生成并持久保存，重启不变）

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPT_KEY (64位十六进制)
```

> `SESSION_SECRET` / `ENCRYPT_KEY` 缺失时应用会生成临时值（仅适合初始化），
> 重启后会导致会话失效或已加密数据无法解密。**生产必须持久化并纳入密钥备份/轮换。**

### 3. 数据库准备

```sql
CREATE DATABASE jingtu_group CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'jingtu_user'@'127.0.0.1' IDENTIFIED BY '强密码';
GRANT ALL PRIVILEGES ON jingtu_group.* TO 'jingtu_user'@'127.0.0.1';
FLUSH PRIVILEGES;
```

`db_init.js` 会在服务启动时自动建表/应用迁移；显式先跑一次便于提前发现错误：
`cd server && node db_init.js`。

### 4. 端口约定

| 端口 | 用途 |
|---|---|
| 3456 | Node 应用（容器内/本机） |
| 80 / 443 | 由 Nginx / 宝塔 反代并终结 TLS |
| 3306 | 仅本机/内网，不暴露公网 |

---

## 一、Docker（推荐，最快起站）

### 1.0 面板一键安装（最快，无需 .env）

Docker 面板（1Panel / 宝塔「Docker → Compose」/ Portainer）直接上传仓库根目录
[`docker-compose.standalone.yml`](docker-compose.standalone.yml)，勾选「创建项目后立即启动」即可；
内置体验默认密钥，正式使用前请在面板「环境变量」中设置同名变量覆盖
（`MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` / `SESSION_SECRET` / `ENCRYPT_KEY`，设置即生效，无需改文件）。
详见 `docs/01-快速开始.md`。

### 1.1 准备环境变量（生产 / 命令行方式）

```bash
cp docker.env.example .env.docker        # 或保持原名，用 --env-file 指定
# 编辑 .env.docker，填好 JINGTU_DB_*, SESSION_SECRET, ENCRYPT_KEY
```

> 用 `--env-file` 加载，不会触碰 Node 自用的根目录 `.env`，二者互不干扰。
> `JINGTU_DB_ROOT_PASSWORD` / `JINGTU_DB_PASSWORD` 为必填（compose 用 `${VAR:?}` 校验，
> 缺失直接报错拒启，无占位默认值）。应用端口默认只绑 `127.0.0.1`（公网流量走本机反代，
> 变量表中 `TRUST_PROXY=1` 即对应此姿势）；确需无反代直连暴露时设 `APP_BIND=0.0.0.0`
> 并把 `TRUST_PROXY=0`。

### 1.2 启动

```bash
docker compose --env-file docker.env.example up -d --build
# 就绪检查
curl -fsS http://127.0.0.1:3456/api/health/ready
```

### 1.3 镜像说明（`Dockerfile`）

- 多阶段构建（`node:22-slim`，Node 20 已于 2026-04 EOL），仅运行阶段保留依赖，体积更小。
- 应用以 **非 root**（node 用户）运行；`uploads/backups/logs/assets/server/data` 为命名卷
  （`server/data` 存放激活码文件与 SQLite 模式库，容器重建/删除后数据不丢），可持久化与备份。
  日志默认轮转（单文件 ≤50m，保留 5 份）避免无限增长。
- 启动顺序由 `docker-entrypoint.sh` 保证：等待 MySQL 端口 → 执行 `db_init.js` → 启动 `node server.js`。
- 生产环境 Swagger 不加载，镜像已用 `npm ci --omit=dev` 精简依赖（devDependencies 不进入运行镜像）。

### 1.4 公网 TLS

Docker 内应用只暴露 3456。生产请在宿主机用 宝塔 / Nginx 反代并申签证书，
参考 `deploy/nginx/jingtu.conf`。也可另写一个 `docker-compose.override.yml` 加一个
独立的 `nginx` 服务对外暴露 80/443（证书用 volume 挂载）。

### 1.5 运维

```bash
docker compose logs -f app          # 查看日志
docker compose exec app node db_init.js   # 手动迁移
docker compose down                 # 停止（数据在卷中保留）
docker compose pull && docker compose up -d --build   # 升级
```

---

## 二、宝塔面板（含一键脚本）

### 2.1 一键脚本 `install.sh`（推荐）

脚本会：检测/安装 Node 20 → 安装依赖 → 生成 `.env`（密钥自动随机）→ 可选建库 →
`db_init.js` → 生成 PM2 配置并启动 → 生成 Nginx 反代配置。

**非交互（服务器上最稳）：**

```bash
REPO_URL=https://github.com/你的名/jingtu-web.git \
DOMAIN=jingtu.example.com DB_NAME=jingtu_group DB_USER=jingtu_user \
DB_PASS='强密码' MYSQL_ROOT_PASSWORD='root强密码' \
bash install.sh
```

**交互：** 直接 `bash install.sh`，按提示输入即可。若已在克隆好的目录内运行，则跳过克隆。

> 脚本把 Nginx 模板写到 `deploy/nginx/jingtu.conf`，并提示在宝塔「网站 → 设置 → 配置文件」中整体替换。

### 2.2 宝塔手动部署（不用脚本）

1. **网站**：创建站点，域名 `jingtu.example.com`，根目录 `/www/wwwroot/jingtu-web/public`。
2. **数据库**：建库 `jingtu_group`、用户 `jingtu_user`、密码，权限本地。
3. **Node 项目**（宝塔软件商店的 Node 版本管理器）：
   - 启动文件 `/www/wwwroot/jingtu-web/server/server.js`；
   - 运行目录 `/www/wwwroot/jingtu-web/server`；
   - 实例数 **1**（不要多实例/cluster，详见下方限制）。
4. **反向代理**：名称 `jingtu`，目标 `http://127.0.0.1:3456`；或把 `deploy/nginx/jingtu.conf` 内容粘进站点「配置文件」。
5. **SSL**：申请/部署证书（路径已写入 `jingtu.conf`）。
6. **根目录 `.env`**：按 `.env.example` 填写 `MYSQL_*`、`SESSION_SECRET`、`ENCRYPT_KEY`、`CORS_ORIGINS` 等。

### 2.3 进程守护（PM2 / systemd）

仓库提供 `ecosystem.config.js`（单实例、cwd=server）：

```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

> **禁止 cluster / 多副本**：CSRF Token、WebSocket 在线用户映射、VRChat pipeline 状态都在进程内存，
> Redis 也未初始化，多实例会导致状态不一致。

---

## 三、Nginx 反代与 TLS（通用）

模板见 `deploy/nginx/jingtu.conf`，要点：

- `proxy_pass http://127.0.0.1:3456`，并透传 `X-Forwarded-For` / `X-Forwarded-Proto` / `Upgrade`。
- `client_max_body_size 200m`（头像/相册上传）。
- 生产**屏蔽** `/api-docs` 与 `/api-docs.json`（避免泄露接口结构）。
- HTTP 全部 301 到 HTTPS；HSTS 由应用安全头设置（仅全站 HTTPS 后启用）。

应用侧已新增 `trust proxy` 支持：反代后 `req.ip`、限流、IP 告警才能正确反映真实客户端；
Cookie `secure` 改为 `'auto'`，经 HTTPS 时自动加 `Secure`。**反代上线前必须验证这两项。**

---

## 四、环境变量速查

| 变量 | 作用 | 必填 |
|---|---|---|
| `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` | 数据库连接 | 是 |
| `SESSION_SECRET` | 会话签名密钥（≥48字节随机） | 是 |
| `ENCRYPT_KEY` | VRChat Cookie AES-256-GCM 密钥（64位十六进制） | 是 |
| `NODE_ENV` | `production` 关闭 Swagger、启用 HSTS | 是 |
| `PORT` | 监听端口，默认 3456 | 否 |
| `TRUST_PROXY` | 反代信任（代码默认不信任；Docker compose 默认 `0`，反代部署须显式设 `1`） | 否 |
| `CORS_ORIGINS` | 允许的跨域来源，逗号分隔；生产必须设 | 强烈建议 |
| `GROUP_ID` / `VRC_API_KEY` / `VRC_GROUP_URL` | VRChat 群组 | 可选 |
| `KOOK_URL` / `OOPZ_URL` | 社区外链 | 可选 |
| `RTMP_HOST` / `RTMP_PORT` / `RTMP_APP` / `HLS_BASE_URL` | 直播推流 | 可选 |

> Swagger 包在 `devDependencies`，但生产已不再加载，因此 `npm ci --omit=dev` 现在可用。

---

## 五、健康检查、升级与回滚

### 5.1 健康端点

```bash
curl -fsS http://127.0.0.1:3456/api/health/live    # 存活
curl -fsS http://127.0.0.1:3456/api/health/ready   # 就绪（数据库可用才 200）
```

### 5.2 升级

```bash
git pull --ff-only
cd server && npm ci && node db_init.js
pm2 restart jingtu-web          # 或 docker compose up -d --build
curl -fsS http://127.0.0.1:3456/api/health/ready
```

### 5.3 回滚

部署经过标记的版本，按变更方案处理数据库；不要对共享仓库强制重置未提交改动。

---

## 六、生产安全必检

1. `SESSION_SECRET` / `ENCRYPT_KEY` 持久化、权限 `600`、安全备份与轮换。
2. `CORS_ORIGINS` 限定具体域名；未设置生产会告警并接受任意来源。
3. TLS + `trust proxy` + Cookie `secure` 联合验证：登录后 `connect.sid` 应带 `Secure; HttpOnly; SameSite=Lax`。
4. 防火墙只开放 80/443（及必要 SSH）；`3456`、`3306` 不暴露公网。
5. 屏蔽 `/api-docs`、`/api-docs.json` 公网访问。
6. 自动化备份覆盖 MySQL + `uploads/` + 密钥，并做恢复演练。
7. 服务账号只写 `uploads/backups/logs`，不递归写整个仓库。

---

## 七、文件清单（部署相关）

| 文件 | 用途 |
|---|---|
| `Dockerfile` / `.dockerignore` / `docker-entrypoint.sh` | Docker 构建与启动 |
| `docker-compose.yml` / `docker.env.example` | Docker Compose（app + mysql） |
| `install.sh` | 宝塔 / 裸机一键部署 |
| `ecosystem.config.js` | PM2 进程守护（单实例） |
| `deploy/nginx/jingtu.conf` | Nginx 反代模板（宝塔可导入） |
| `docs/03-部署与运维.md` | 部署/运维/安全必检（更详细） |
