#!/usr/bin/env bash
# Installs SessionDeck as a systemd --user service so it can be restarted from
# anywhere (including a SessionDeck shell opened remotely) and comes back after
# a reboot. This never stops a running instance; see restart-service.sh.
set -euo pipefail

project_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(dirname -- "$(command -v node)")"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"

cat > "$unit_dir/sessiondeck.service" <<EOF
[Unit]
Description=SessionDeck (local-first home for coding agent sessions)
After=network.target

[Service]
Type=exec
WorkingDirectory=$project_dir
Environment=PATH=$node_bin:/usr/local/bin:/usr/bin:/bin
# start.sh installs missing deps, builds atomically, then execs the server so
# SIGTERM reaches Node and running agents are shut down cleanly.
ExecStart=$project_dir/start.sh
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=mixed

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemd-analyze --user verify "$unit_dir/sessiondeck.service" 2>&1 | grep -v '^$' || true
# Keep user services alive without an interactive login (needed after reboot).
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
  loginctl enable-linger "$USER" 2>/dev/null && echo "已启用 linger：重启电脑后服务会自动启动。" || echo "提示：loginctl enable-linger 需要权限，稍后可用 sudo loginctl enable-linger $USER。"
fi
echo "已安装 sessiondeck.service（未启动）。迁移正在运行的实例：scripts/restart-service.sh"
