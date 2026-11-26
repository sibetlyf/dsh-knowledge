#!/usr/bin/env bash
# 安全更新独立团队知识库的 /opt/team-kb/app，保留 data 与 /etc/team-kb.env。
# 用法：sudo bash cloud/deploy/update-app.sh /tmp/lemoncat7-dsh-knowledge-*.tgz
set -euo pipefail

TARBALL="${1:?用法: update-app.sh <package.tgz>}"
ENV_FILE="${TEAM_ENV_FILE:-/etc/team-kb.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
APP_DIR="${TEAM_APP_DIR:-/opt/team-kb/app}"
SERVICE="${TEAM_SERVICE:-team-kb}"
DATA_DIR="${TEAM_DATA_DIR:-/opt/team-kb/data}"
OWNER="${TEAM_SERVICE_USER:-teamkb}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
BACKUP="${APP_DIR}.backup.${STAMP}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行" >&2
  exit 2
fi

# 旧部署可能没有设置 TEAM_DATA_DIR，SQLite 实际在 app/cloud-data。
# 替换 app 前必须拒绝，避免把知识库一起删掉。
if [ -d "$APP_DIR/cloud-data" ]; then
  cat >&2 <<EOF
检测到数据目录位于应用目录内：$APP_DIR/cloud-data
替换 $APP_DIR 会删除知识库，已中止，未做任何修改。

请先把数据迁到独立目录，例如：
  sudo systemctl stop $SERVICE
  sudo mkdir -p /opt/team-kb/data
  sudo cp -a "$APP_DIR/cloud-data/." /opt/team-kb/data/
  sudo chown -R $OWNER:$OWNER /opt/team-kb/data
  # 确认 /etc/team-kb.env 中 TEAM_DATA_DIR=/opt/team-kb/data
  sudo systemctl start $SERVICE
然后再运行本脚本。
EOF
  exit 2
fi

for file in "$TARBALL" "$APP_DIR/cloud/server.mjs" "$DATA_DIR"; do
  if [ ! -e "$file" ]; then echo "找不到: $file" >&2; exit 2; fi
done

echo "1/6 停止服务 $SERVICE"
systemctl stop "$SERVICE"

echo "2/6 备份 $APP_DIR -> $BACKUP"
cp -a "$APP_DIR" "$BACKUP"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "3/6 解包并校验"
tar -xzf "$TARBALL" -C "$TMP"
[ -f "$TMP/package/cloud/server.mjs" ] || { echo "包内缺少 cloud/server.mjs" >&2; exit 2; }
[ -f "$TMP/package/cloud/public/app.js" ] || { echo "包内缺少 cloud/public/app.js" >&2; exit 2; }

echo "4/6 替换应用目录（data 与环境文件不动）"
rm -rf "$APP_DIR"
cp -a "$TMP/package" "$APP_DIR"
chown -R "$OWNER:$OWNER" "$APP_DIR"
chmod -R u+rwX,go+rX "$APP_DIR"

echo "5/6 启动服务"
systemctl start "$SERVICE"

echo "6/6 健康检查"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS "http://127.0.0.1:${TEAM_PORT:-8787}/knowledge-api/v1/health" >/tmp/team-kb-health.json 2>/dev/null; then
    cat /tmp/team-kb-health.json
    echo
    echo "更新完成；回滚备份: $BACKUP"
    exit 0
  fi
done

echo "健康检查失败，回滚到 $BACKUP" >&2
systemctl stop "$SERVICE" || true
rm -rf "$APP_DIR"
cp -a "$BACKUP" "$APP_DIR"
chown -R "$OWNER:$OWNER" "$APP_DIR"
systemctl start "$SERVICE"
echo "已回滚；请查看 journalctl -u $SERVICE -n 100 --no-pager" >&2
exit 1
