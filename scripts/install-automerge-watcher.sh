#!/usr/bin/env bash
# install-automerge-watcher.sh — 把工厂 dev→main 自动合并装成 launchd 轮询守护
#
# GH Actions 版 auto-merge 已下线(FID-117),本脚本是其常驻触发器:
#   - StartInterval 180s 跑一轮 scripts/auto-merge-dev.mjs(脚本内有单实例锁,
#     重叠执行自动让位)
#   - 日志:~/Library/Logs/factory-automerge.log(out+err 合并)
#   - 幂等:重复执行 = 先卸载旧 plist 再装新的
#
# 用法:
#   scripts/install-automerge-watcher.sh             # 安装/重装
#   scripts/install-automerge-watcher.sh --uninstall # 卸载并退出守护
# @fid FID-117-factory-auto-merge @iter 1
set -euo pipefail

LABEL="com.hiredchina.factory-automerge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/factory-automerge.log"
FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"

uninstall() {
    if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)/${LABEL}" || true
        echo "已卸载守护 ${LABEL}"
    else
        echo "守护 ${LABEL} 未在运行"
    fi
    rm -f "$PLIST"
}

if [[ "${1:-}" == "--uninstall" ]]; then
    uninstall
    exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${FACTORY_ROOT}/scripts/auto-merge-dev.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${FACTORY_ROOT}</string>
    <key>StartInterval</key>
    <integer>180</integer>
    <key>StandardOutPath</key>
    <string>${LOG}</string>
    <key>StandardErrorPath</key>
    <string>${LOG}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

# 重装语义:先卸旧的
if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/${LABEL}" || true
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "已安装并启动守护 ${LABEL}"
echo "  轮询:每 180s 一轮  node ${FACTORY_ROOT}/scripts/auto-merge-dev.mjs"
echo "  日志:tail -f ${LOG}"
echo "  卸载:$0 --uninstall"
