#!/usr/bin/env bash
# install-automerge-watcher.sh — 把工厂本地 CI 装成 launchd 轮询守护(两个 job)
#
# GH Actions 版 auto-merge/release/CI 已下线(FID-117),本脚本是常驻触发器:
#   - com.hiredchina.factory-automerge :每 180s 跑 auto-merge-dev.mjs
#     (dev→main 合并;脚本内单实例锁,重叠自动让位)
#   - com.hiredchina.factory-pipeline  :每 300s 跑 local-pipeline.mjs
#     (main 新提交 → 本地 CI;version_file 版本变化 → npm publish + Release
#      + 七牛镜像 + npmmirror 同步;各自独立锁)
#   - 日志:~/Library/Logs/factory-automerge.log / factory-pipeline.log
#   - 幂等:重复执行 = 先卸载旧 plist 再装新的
#
# 用法:
#   scripts/install-automerge-watcher.sh             # 安装/重装两个 job
#   scripts/install-automerge-watcher.sh --uninstall # 全部卸载
# @fid FID-117-factory-auto-merge @iter 2
set -euo pipefail

FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
UID_N="$(id -u)"

install_job() {
    local label="$1" interval="$2" script="$3" log="$4"
    local plist="$HOME/Library/LaunchAgents/${label}.plist"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${FACTORY_ROOT}/scripts/${script}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${FACTORY_ROOT}</string>
    <key>StartInterval</key>
    <integer>${interval}</integer>
    <key>StandardOutPath</key>
    <string>${log}</string>
    <key>StandardErrorPath</key>
    <string>${log}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.local/bin:${HOME}/.n/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF
    if launchctl print "gui/${UID_N}/${label}" >/dev/null 2>&1; then
        launchctl bootout "gui/${UID_N}/${label}" || true
    fi
    launchctl bootstrap "gui/${UID_N}" "$plist"
    echo "已安装并启动 ${label}(每 ${interval}s → ${script})"
}

uninstall_job() {
    local label="$1"
    if launchctl print "gui/${UID_N}/${label}" >/dev/null 2>&1; then
        launchctl bootout "gui/${UID_N}/${label}" || true
        echo "已卸载 ${label}"
    else
        echo "${label} 未在运行"
    fi
    rm -f "$HOME/Library/LaunchAgents/${label}.plist"
}

if [[ "${1:-}" == "--uninstall" ]]; then
    uninstall_job "com.hiredchina.factory-automerge"
    uninstall_job "com.hiredchina.factory-pipeline"
    exit 0
fi

install_job "com.hiredchina.factory-automerge" 180 "auto-merge-dev.mjs" "$HOME/Library/Logs/factory-automerge.log"
install_job "com.hiredchina.factory-pipeline" 300 "local-pipeline.mjs" "$HOME/Library/Logs/factory-pipeline.log"

echo
echo "日志:tail -f ~/Library/Logs/factory-automerge.log ~/Library/Logs/factory-pipeline.log"
echo "卸载:$0 --uninstall"
echo "发布 secrets:在 ${FACTORY_ROOT}/.env.local 写 NPM_TOKEN / QINIU_ACCESS_KEY / QINIU_SECRET_KEY / WECOM_WEBHOOK_URL"
