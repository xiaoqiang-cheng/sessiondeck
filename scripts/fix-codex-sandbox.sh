#!/usr/bin/env bash
# Lets Codex's Linux sandbox (bubblewrap) create user namespaces on Ubuntu
# 23.10+, where kernel.apparmor_restrict_unprivileged_userns=1 denies that to
# any binary without an AppArmor profile. Every Codex command then fails before
# it runs with "bwrap: setting up uid map: Permission denied".
#
# The fix is the one Ubuntu itself uses for Chrome, Docker and others: give
# /usr/bin/bwrap an unconfined profile that grants `userns`. The sandbox stays
# on; only the namespace creation is permitted. Run this once in a terminal;
# it needs sudo and nothing else. Nothing is restarted.
set -euo pipefail

profile=/etc/apparmor.d/bwrap
bwrap=/usr/bin/bwrap

if [[ ! -x "$bwrap" ]]; then
  echo "未找到 $bwrap；请先安装 bubblewrap：sudo apt install bubblewrap" >&2
  exit 1
fi

if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != 1 ]]; then
  echo "本机没有启用 AppArmor 的非特权用户命名空间限制，Codex 沙箱应该已经可用。"
  echo "如果仍然报 bwrap 错误，请把下面这条命令的输出发给我："
  echo "  $bwrap --ro-bind / / --unshare-user --uid 1000 -- /usr/bin/id"
  exit 0
fi

if ! command -v apparmor_parser >/dev/null 2>&1; then
  echo "安装 apparmor-utils（提供 apparmor_parser）…"
  sudo apt-get install -y apparmor-utils
fi

echo "写入 $profile …"
sudo tee "$profile" >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

# bubblewrap is the sandbox Codex (and others) use on Linux. Ubuntu denies
# user-namespace creation to unprofiled binaries; this grants exactly that.
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
EOF

echo "加载配置文件…"
sudo apparmor_parser -r "$profile"

echo "验证：在用户命名空间里运行 id …"
if "$bwrap" --ro-bind / / --unshare-user --uid 1000 -- /usr/bin/id >/dev/null 2>&1; then
  echo "完成。Codex 沙箱现在可以创建用户命名空间；已打开的 Codex 会话直接继续用，不需要重启 SessionDeck。"
else
  echo "配置已加载，但 bwrap 仍然失败。请把下面这条命令的完整输出发给我：" >&2
  echo "  $bwrap --ro-bind / / --unshare-user --uid 1000 -- /usr/bin/id" >&2
  exit 1
fi
