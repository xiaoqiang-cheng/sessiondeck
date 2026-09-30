#!/usr/bin/env bash
# Restarts SessionDeck on this machine, safe to run from a shell that
# SessionDeck itself hosts (the bottom terminal, even over remote access).
#
# The work runs detached in its own session, so stopping the service does not
# kill the restart halfway. Every running agent session is stopped with the
# service; contacts keep their native IDs and resume from their cards.
set -euo pipefail

project_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
port="${SESSIONDECK_PORT:-${PORT:-4317}}"
log="${TMPDIR:-/tmp}/sessiondeck-restart.log"

if ! systemctl --user cat sessiondeck.service >/dev/null 2>&1; then
  echo "尚未安装 systemd 单元，先执行 scripts/install-service.sh" >&2
  exit 1
fi

if [[ "${1:-}" != --detached ]]; then
  setsid nohup "$0" --detached >"$log" 2>&1 < /dev/null &
  echo "正在后台重启 SessionDeck，日志：$log"
  echo "这个终端会随旧服务一起关闭；十几秒后刷新页面即可。"
  exit 0
fi

# Only stop a listener that is provably this project's server, never by port alone.
pid="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$pid" ]]; then
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$cmd" != *server/index.ts* || "$cwd" != "$project_dir" ]]; then
    echo "端口 $port 上的进程 $pid 不是本项目的 SessionDeck（$cmd），已放弃。" >&2
    exit 1
  fi
  unit_pid="$(systemctl --user show sessiondeck -p MainPID --value 2>/dev/null || echo 0)"
  if [[ "$unit_pid" == "$pid" ]]; then
    echo "$(date '+%F %T') 通过 systemd 重启"
    exec systemctl --user restart sessiondeck
  fi
  echo "$(date '+%F %T') 停止旧实例 $pid（$cmd）"
  kill -TERM "$pid"
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then echo "旧实例 30 秒内未退出，放弃启动新实例。" >&2; exit 1; fi
fi
for _ in $(seq 1 20); do
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
echo "$(date '+%F %T') 启动 systemd 服务"
systemctl --user enable --now sessiondeck
sleep 2
systemctl --user --no-pager --lines=5 status sessiondeck || true
