#!/usr/bin/env bash
set -euo pipefail

DATA="${1:-/opt/team-kb/data}"
DEST_ROOT="${2:-/var/backups/team-kb}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$DEST_ROOT/$STAMP"

command -v sqlite3 >/dev/null || { echo "需要 sqlite3 命令" >&2; exit 2; }
mkdir -p "$DEST"

# .backup 对运行中的 WAL 数据库是一致的快照，比直接 cp 安全。
sqlite3 "$DATA/knowledge.sqlite" ".backup '$DEST/knowledge.sqlite'"
sqlite3 "$DATA/team.sqlite" ".backup '$DEST/team.sqlite'"

chmod 600 "$DEST/knowledge.sqlite" "$DEST/team.sqlite"

# 任意类型文件单独打包；.backup 抓不到文件正文。
if [ -d "$DATA/files" ]; then
  tar -czf "$DEST/files.tar.gz" -C "$DATA" files
  chmod 600 "$DEST/files.tar.gz"
fi

printf '%s\n' "$DEST"
