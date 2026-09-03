#!/usr/bin/env bash
# ============================================================
# 境途同游 网站导出打包工具（Linux / macOS 版）
# 与 Windows 版 jingtu.ps1 的 export 子命令功能等价。
# 注意：服务启停(网站/面板)仅 Windows 支持，本脚本只做"导出打包"。
#
# 用法:
#   ./jingtu.sh                      # 默认输出到项目根的上一级目录
#   ./jingtu.sh -o /backup           # 指定输出目录
#   ./jingtu.sh -n my-site.zip       # 指定压缩包文件名
#   ./jingtu.sh -d                   # 额外包含相册/头像/上传等用户数据
#   ./jingtu.sh -h                   # 帮助
#
# 先给执行权限: chmod +x jingtu.sh
# ============================================================
set -u

# ---------- 定位项目根（脚本所在目录） ----------
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
ROOT="$(cd "$(dirname "$SCRIPT_PATH")" >/dev/null 2>&1 && pwd)"
[ -z "$ROOT" ] && ROOT="$(pwd)"

# ---------- 参数解析 ----------
OUTDIR="$(dirname "$ROOT")"   # 默认输出到项目根的上一级（与 Windows 版一致）
NAME=""
INCLUDE_DATA=0
HELP=0

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--outdir) OUTDIR="$2"; shift 2 ;;
    -n|--name)   NAME="$2";   shift 2 ;;
    -d|--includedata) INCLUDE_DATA=1; shift ;;
    -h|--help)   HELP=1; shift ;;
    *) echo "[WARN] 忽略未知参数: $1"; shift ;;
  esac
done

if [ "$HELP" -eq 1 ]; then
  echo "用法: ./jingtu.sh [-o <输出目录>] [-n <文件名.zip>] [-d] [-h]"
  echo "  -o  输出目录（默认: 项目根的上一级）"
  echo "  -n  压缩包文件名（默认: jingtu-web-YYYYMMDD-HHmmss.zip）"
  echo "  -d  额外包含用户数据（相册/头像/上传）"
  exit 0
fi

if [ -z "$NAME" ]; then
  NAME="jingtu-web-$(date +%Y%m%d-%H%M%S).zip"
fi
OUTFILE="$OUTDIR/$NAME"
STAGING="$(mktemp -d -t jingtu-export.XXXXXX)"

echo "========================================"
echo "  境途同游 网站导出打包工具 (Linux/macOS)"
echo "========================================"
echo "  项目根: $ROOT"
echo "  输出到: $OUTFILE"
if [ "$INCLUDE_DATA" -eq 1 ]; then echo "  包含用户数据: 是 (相册/头像/上传)"; else echo "  包含用户数据: 否"; fi
echo ""

# ---------- 复制封装 ----------
have_rsync=0; command -v rsync >/dev/null 2>&1 && have_rsync=1

copy_tree() {
  # $1=src $2=dst $3=exclude-dirs(空格分隔) $4=exclude-files(空格分隔)
  local src="$1" dst="$2" edirs="$3" efiles="$4"
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  if [ "$have_rsync" -eq 1 ]; then
    local args=()
    for d in $edirs; do args+=(--exclude "/$d"); done
    for f in $efiles; do args+=(--exclude "$f"); done
    rsync -a --prune-empty-dirs "${args[@]}" "$src/" "$dst/"
  else
    # 退化为 cp + find 排除（简单近似）
    cp -a "$src/." "$dst/" 2>/dev/null || cp -R "$src/." "$dst/" 2>/dev/null
    for d in $edirs; do find "$dst" -type d -name "$d" -prune -exec rm -rf {} + 2>/dev/null; done
    for f in $efiles; do find "$dst" -type f -name "$f" -delete 2>/dev/null; done
  fi
}

step() { echo "  [导出] $1"; }

step "复制 server 后端代码..."
copy_tree "$ROOT/server" "$STAGING/server" "node_modules coverage __tests__ test logs" "*.log session.json _*.js _*.php _*.ps1 out.log"

step "复制 public 前端资源..."
copy_tree "$ROOT/public" "$STAGING/public" "ai-scratch" ""

step "复制 assets 媒体资源..."
if [ "$INCLUDE_DATA" -eq 1 ]; then
  copy_tree "$ROOT/assets" "$STAGING/assets" "" ""
else
  copy_tree "$ROOT/assets" "$STAGING/assets" "album avatar-cache" ""
fi

step "复制 docs / deploy / tools..."
copy_tree "$ROOT/docs"   "$STAGING/docs"   "" ""
copy_tree "$ROOT/deploy" "$STAGING/deploy" "" ""
copy_tree "$ROOT/tools"  "$STAGING/tools"  "" "_*.py _*.js _*.png _*.md"

if [ "$INCLUDE_DATA" -eq 1 ]; then
  step "复制 uploads 上传文件..."
  copy_tree "$ROOT/uploads" "$STAGING/uploads" "" ""
fi

step "复制根目录配置文件..."
ROOT_FILES=".env.example .gitignore .dockerignore .htaccess DEPLOY.md Dockerfile docker-compose.yml docker-entrypoint.sh docker.env.example ecosystem.config.js install.sh panel-config.json jingtu.bat jingtu.ps1 jingtu.sh start-services.sh"
for f in $ROOT_FILES; do
  if [ -f "$ROOT/$f" ]; then cp -a "$ROOT/$f" "$STAGING/$f"; fi
done

# ---------- 打包 ----------
step "创建压缩包..."
mkdir -p "$OUTDIR"
[ -f "$OUTFILE" ] && rm -f "$OUTFILE"

FILE_COUNT=$(find "$STAGING" -type f | wc -l | tr -d ' ')
if command -v zip >/dev/null 2>&1; then
  ( cd "$STAGING" && zip -qr "$OUTFILE" . )
else
  echo "  [提示] 未找到 zip，改用 tar.gz 打包。"
  OUTFILE="${OUTFILE%.zip}.tar.gz"
  ( cd "$STAGING" && tar -czf "$OUTFILE" . )
fi

PKG_SIZE=$(du -m "$OUTFILE" 2>/dev/null | cut -f1)

# ---------- 清理 ----------
rm -rf "$STAGING"

echo ""
echo "========================================"
echo "  导出完成 ✔"
echo "  文件数: $FILE_COUNT"
echo "  包大小: ${PKG_SIZE} MB"
echo "  位置:   $OUTFILE"
echo "========================================"
echo ""
