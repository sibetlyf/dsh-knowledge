#!/usr/bin/env bash
# 一键安装/升级独立团队知识库服务。
# 支持 Debian/Ubuntu、RHEL/CentOS/Rocky/Alma/Fedora、Alpine、Arch 等常见 Linux。
# 默认安装 systemd 服务；数据、环境文件和旧应用目录都会保留。
set -Eeuo pipefail

APP_NAME="team-kb"
DEFAULT_ARCHIVE="https://raw.githubusercontent.com/sibetlyf/dsh-knowledge/main/release/dsh-knowledge-2.22.10-custom.1.tgz"
NODE_VERSION="${NODE_VERSION:-24.9.0}"
ARCHIVE="${TEAM_ARCHIVE:-$DEFAULT_ARCHIVE}"
APP_DIR="${TEAM_APP_DIR:-/opt/team-kb/app}"
BASE_DIR="${TEAM_BASE_DIR:-/opt/team-kb}"
DATA_DIR="${TEAM_DATA_DIR:-$BASE_DIR/data}"
ENV_FILE="${TEAM_ENV_FILE:-/etc/team-kb.env}"
SERVICE="${TEAM_SERVICE:-team-kb}"
OWNER="${TEAM_SERVICE_USER:-teamkb}"
PORT="${TEAM_PORT:-8787}"
HOST="${TEAM_HOST:-127.0.0.1}"
DOMAIN="${TEAM_DOMAIN:-}"
ADMIN_EMAIL="${TEAM_ADMIN_EMAIL:-admin@team.local}"
ADMIN_PASSWORD="${TEAM_ADMIN_PASSWORD:-}"
START_SERVICE=1
PORT_SET=0
HOST_SET=0
DATA_SET=0
TMP="$(mktemp -d)"
BACKUP=""
CREATED_ADMIN_PASSWORD=0

usage() {
  cat <<'EOF'
用法：
  sudo bash cloud/deploy/install.sh [选项]
  curl -fsSL https://raw.githubusercontent.com/sibetlyf/dsh-knowledge/main/cloud/deploy/install.sh | sudo bash

选项：
  --archive <URL|文件>   安装包地址，默认 GitHub release
  --domain <域名>        设置 TEAM_PUBLIC_ORIGIN=https://<域名>
  --port <端口>          服务端口，默认 8787
  --host <地址>          监听地址，默认 127.0.0.1
  --data-dir <目录>      数据目录，默认 /opt/team-kb/data
  --app-dir <目录>       应用目录，默认 /opt/team-kb/app
  --env-file <文件>      环境文件，默认 /etc/team-kb.env
  --service <名称>       systemd 服务名，默认 team-kb
  --user <用户>          服务用户，默认 teamkb
  --admin-email <邮箱>   首次安装管理员邮箱
  --admin-password <密码> 首次安装管理员密码；留空自动生成
  --no-start             安装后不启动服务
  -h, --help             显示帮助

环境变量同样可用：TEAM_ARCHIVE、TEAM_DOMAIN、TEAM_PORT、TEAM_DATA_DIR 等。
需要 root；没有 systemd 的环境请使用 Docker 路径（cloud/Dockerfile / cloud/README.md）。
EOF
}

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\n[警告] %s\n' "$*" >&2; }
die() { printf '\n[失败] %s\n' "$*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="${2:?}"; shift 2 ;;
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; PORT_SET=1; shift 2 ;;
    --host) HOST="${2:?}"; HOST_SET=1; shift 2 ;;
    --data-dir) DATA_DIR="${2:?}"; DATA_SET=1; shift 2 ;;
    --app-dir) APP_DIR="${2:?}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --service) SERVICE="${2:?}"; shift 2 ;;
    --user) OWNER="${2:?}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:?}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:?}"; shift 2 ;;
    --no-start) START_SERVICE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知选项：$1；使用 --help 查看用法" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请使用 sudo 运行"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  [ "$PORT_SET" -eq 0 ] && PORT="${TEAM_PORT:-$PORT}"
  [ "$HOST_SET" -eq 0 ] && HOST="${TEAM_HOST:-$HOST}"
  [ "$DATA_SET" -eq 0 ] && DATA_DIR="${TEAM_DATA_DIR:-$DATA_DIR}"
fi

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

ensure_tools() {
  local missing=0
  for tool in curl tar xz sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || missing=1
  done
  if [ "$missing" -eq 1 ]; then
    log "安装基础工具"
    install_tools
  fi
  command -v curl >/dev/null 2>&1 || die "缺少 curl；请手动安装"
  command -v tar >/dev/null 2>&1 || die "缺少 tar；请手动安装"
}

install_packages() {
  local packages=("$@")
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y --no-install-recommends "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "${packages[@]}"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "${packages[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed "${packages[@]}"
  else
    die "无法识别包管理器；请手动安装：${packages[*]}"
  fi
}

install_tools() {
  if command -v apt-get >/dev/null 2>&1; then
    install_packages curl ca-certificates tar xz-utils coreutils
  elif command -v apk >/dev/null 2>&1; then
    install_packages curl ca-certificates tar xz coreutils
  else
    install_packages curl ca-certificates tar xz coreutils
  fi
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then echo 0; return; fi
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

ensure_node() {
  local major
  major="$(node_major)"
  if [ "$major" -ge 24 ]; then
    log "Node.js $(node -v) 已满足要求"
    return
  fi
  log "安装 Node.js ${NODE_VERSION}"
  if command -v apk >/dev/null 2>&1; then
    install_packages nodejs npm curl tar xz
    major="$(node_major)"
    [ "$major" -ge 24 ] || die "Alpine 当前 nodejs 低于 24；请使用 Docker 或升级 Alpine 仓库"
    return
  fi
  install_tools
  case "$(uname -m)" in
    x86_64|amd64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    armv7l) node_arch=armv7l ;;
    *) die "不支持的 CPU 架构：$(uname -m)" ;;
  esac
  local file="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  local base="https://nodejs.org/dist/v${NODE_VERSION}"
  curl -fL --retry 3 --connect-timeout 15 "$base/$file" -o "$TMP/$file" \
    || die "下载 Node.js 失败：$base/$file"
  if curl -fsSL --max-time 20 "$base/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"; then
    (cd "$TMP" && grep " ${file}$" SHASUMS256.txt | sha256sum -c -) || die "Node.js 校验失败"
  fi
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$TMP/$file" -C /usr/local/lib/nodejs
  local dir="/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${node_arch}"
  ln -sf "$dir/bin/node" /usr/local/bin/node
  ln -sf "$dir/bin/npm" /usr/local/bin/npm
  ln -sf "$dir/bin/npx" /usr/local/bin/npx
  hash -r
  major="$(node_major)"
  [ "$major" -ge 24 ] || die "Node.js 安装后仍低于 24"
}

prepare_owner() {
  if ! id "$OWNER" >/dev/null 2>&1; then
    log "创建系统用户 $OWNER"
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --home "$BASE_DIR" --shell /usr/sbin/nologin "$OWNER" 2>/dev/null \
        || useradd --system --home "$BASE_DIR" --shell /sbin/nologin "$OWNER"
    elif command -v adduser >/dev/null 2>&1; then
      adduser -S -D -H -h "$BASE_DIR" -s /sbin/nologin "$OWNER"
    else
      die "无法创建用户 $OWNER；请手动创建或使用 --user"
    fi
  fi
}

stop_existing() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    log "停止现有服务 $SERVICE"
    systemctl stop "$SERVICE"
  fi
}

download_archive() {
  case "$ARCHIVE" in
    http://*|https://*)
      log "下载安装包"
      curl -fL --retry 3 --connect-timeout 15 "$ARCHIVE" -o "$TMP/package.tgz" \
        || die "下载安装包失败：$ARCHIVE"
      ;;
    *)
      [ -f "$ARCHIVE" ] || die "安装包不存在：$ARCHIVE"
      cp "$ARCHIVE" "$TMP/package.tgz"
      ;;
  esac
  tar -xzf "$TMP/package.tgz" -C "$TMP" || die "安装包不是有效 tgz"
  [ -f "$TMP/package/cloud/server.mjs" ] || die "安装包缺少 cloud/server.mjs"
  [ -f "$TMP/package/cloud/public/app.js" ] || die "安装包缺少 cloud/public/app.js"
}

write_env_if_missing() {
  if [ -f "$ENV_FILE" ]; then
    chmod 640 "$ENV_FILE" 2>/dev/null || true
    log "保留现有环境文件 $ENV_FILE"
    return
  fi
  log "生成本机环境文件 $ENV_FILE"
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-24)"
    CREATED_ADMIN_PASSWORD=1
  fi
  local origin="${TEAM_PUBLIC_ORIGIN:-http://127.0.0.1:$PORT}"
  if [ -n "$DOMAIN" ]; then origin="https://$DOMAIN"; fi
  umask 077
  cat > "$ENV_FILE" <<EOF
# 由 cloud/deploy/install.sh 生成；敏感文件，权限 640。
TEAM_DATA_DIR=$DATA_DIR
TEAM_HOST=$HOST
TEAM_PORT=$PORT
TEAM_PUBLIC_ORIGIN=$origin
TEAM_TITLE=团队知识库
TEAM_ADMIN_EMAIL=$ADMIN_EMAIL
TEAM_ADMIN_PASSWORD=$ADMIN_PASSWORD
TEAM_AUTO_WIKI=1
TEAM_AUTO_WORKLOG=1
TEAM_WORKLOG_BASE=default
TEAM_WORKLOG_SUMMARY_HOUR=19
TEAM_AUTO_INTERVAL_MINUTES=30
EOF
  chown root:"$OWNER" "$ENV_FILE" 2>/dev/null || chown root:root "$ENV_FILE"
  chmod 640 "$ENV_FILE"
}

install_app() {
  mkdir -p "$BASE_DIR" "$DATA_DIR" "$(dirname "$APP_DIR")"
  chown "$OWNER":"$OWNER" "$BASE_DIR" "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  if [ -d "$APP_DIR/cloud-data" ]; then
    die "数据目录位于应用目录内：$APP_DIR/cloud-data；请先迁移到 $DATA_DIR，避免升级丢失"
  fi
  if [ -d "$APP_DIR" ]; then
    BACKUP="${APP_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
    log "备份现有应用到 $BACKUP"
    cp -a "$APP_DIR" "$BACKUP"
  fi
  rm -rf "$APP_DIR"
  cp -a "$TMP/package" "$APP_DIR"
  chown -R "$OWNER":"$OWNER" "$APP_DIR"
  chmod -R u+rwX,go+rX "$APP_DIR"
  log "安装 Node 生产依赖（PDF/Office 解析）"
  if ! (cd "$APP_DIR" && npm install --omit=dev --ignore-scripts --no-audit --no-fund); then
    if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
      rm -rf "$APP_DIR"; cp -a "$BACKUP" "$APP_DIR"
      chown -R "$OWNER":"$OWNER" "$APP_DIR"
    fi
    die "依赖安装失败；已回滚（如存在备份）"
  fi
  chown -R "$OWNER":"$OWNER" "$APP_DIR"
}

write_service() {
  command -v systemctl >/dev/null 2>&1 || die "当前环境没有 systemd；请使用 Docker 路径"
  local node_bin
  node_bin="$(command -v node)"
  log "写入 systemd 服务 $SERVICE"
  cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Team Knowledge standalone service
After=network.target

[Service]
Type=simple
User=$OWNER
Group=$OWNER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$node_bin $APP_DIR/cloud/server.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null
}

health_url() {
  local probe_host="$HOST"
  case "$probe_host" in 0.0.0.0|::) probe_host=127.0.0.1 ;; esac
  printf 'http://%s:%s/knowledge-api/v1/health' "$probe_host" "$PORT"
}

wait_health() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 2 "$(health_url)" >"$TMP/health.json" 2>/dev/null; then
      cat "$TMP/health.json"; echo
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback_and_fail() {
  warn "健康检查失败"
  systemctl stop "$SERVICE" 2>/dev/null || true
  if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
    rm -rf "$APP_DIR"; cp -a "$BACKUP" "$APP_DIR"
    chown -R "$OWNER":"$OWNER" "$APP_DIR"
    systemctl start "$SERVICE" 2>/dev/null || true
    warn "已回滚到 $BACKUP；查看 journalctl -u $SERVICE -n 100 --no-pager"
  fi
  exit 1
}

finish() {
  if [ "$START_SERVICE" -eq 1 ]; then
    systemctl restart "$SERVICE"
    if ! wait_health; then rollback_and_fail; fi
  fi
  if [ "$CREATED_ADMIN_PASSWORD" -eq 1 ]; then
    printf '%s\n' "管理员邮箱：$ADMIN_EMAIL" "管理员密码：$ADMIN_PASSWORD" > /root/team-kb-admin.txt
    chmod 600 /root/team-kb-admin.txt
    # 管理员已创建，密码不再需要常驻环境文件；保留凭据文件。
    sed -i '/^TEAM_ADMIN_PASSWORD=/d' "$ENV_FILE" 2>/dev/null || true
  fi
  echo
  echo "安装完成"
  echo "  访问地址：http://127.0.0.1:$PORT"
  echo "  数据目录：$DATA_DIR"
  echo "  环境文件：$ENV_FILE"
  echo "  服务命令：systemctl status $SERVICE"
  if [ "$CREATED_ADMIN_PASSWORD" -eq 1 ]; then
    echo "  首次管理员：$ADMIN_EMAIL"
    echo "  凭据文件：/root/team-kb-admin.txt（登录后请删除）"
  fi
  if [ -n "$DOMAIN" ]; then
    echo "  公网域名：https://$DOMAIN；请配置 Caddy/Nginx 反向代理到 127.0.0.1:$PORT"
  fi
}

log "环境：$(uname -s) $(uname -m)"
if [ "$START_SERVICE" -eq 1 ] && ! command -v systemctl >/dev/null 2>&1; then
  die "当前环境没有 systemd；请使用 Docker 部署，或使用 --no-start 仅安装文件"
fi
ensure_tools
ensure_node
command -v npm >/dev/null 2>&1 || die "缺少 npm；请重新安装 Node.js 24"
prepare_owner
download_archive
write_env_if_missing
stop_existing
install_app
if [ "$START_SERVICE" -eq 1 ]; then
  write_service
else
  log "跳过 systemd 服务安装（--no-start）"
fi

if [ "$START_SERVICE" -eq 0 ]; then
  log "已安装但未启动（--no-start）"
  exit 0
fi
finish
