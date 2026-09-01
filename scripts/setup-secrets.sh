#!/usr/bin/env bash
# setup-secrets.sh — hc-action-factory secrets 一键配置(由有权限的人执行)
#
# 前置 1:用 harness-bot 账号创建 fine-grained PAT:
#   https://github.com/settings/personal-access-tokens/new
#   - Repository access: Only select repositories →
#     hc-action-factory, chromepilot, hunter-mate, hunter-mate-harness, dev-ops, job-pages
#   - Permissions:
#       Contents: Read and write        (checkout 私有代码 / 推 tag / 推 sync 分支 / dispatch)
#       Commit statuses: Read and write (回写 factory/* 状态)
#       Pull requests: Read and write   (sync-deps 开 PR)
#       Issues: Read and write          (预留,与现有 auto-merge 一致)
#   (若现有 HARNESS_BOT_TOKEN 已是满足上述范围的 PAT,可直接复用其值)
#
# 前置 2:export 下列环境变量后执行本脚本:
#   export FACTORY_PAT="<上一步的 PAT>"
#   export NPM_TOKEN="<与 hunter-mate/chromepilot 仓库 secret 同值>"
#   export ALIYUN_ACR_USERNAME="<与 dev-ops/job-pages 仓库 secret 同值>"
#   export ALIYUN_ACR_PASSWORD="<同上>"
#   export JP_DEPLOY_SSH_KEY="$(cat <CI 部署私钥路径>)"   # 与 dev-ops/job-pages 仓库 secret 同值
#   export JP_SERVER_HOST_KEY="<与 dev-ops/job-pages 仓库 secret 同值>"
#   export WECOM_WEBHOOK_URL="<企微群机器人 webhook,与 org secret 同值>"
#
#   bash scripts/setup-secrets.sh
#
set -euo pipefail

FACTORY="hiredchina-com/hc-action-factory"
DISPATCH_REPOS=(hunter-mate-harness dev-ops job-pages)   # chromepilot / hunter-mate 已有 HARNESS_BOT_TOKEN

need() { [[ -n "${!1:-}" ]] || { echo "✗ 缺少环境变量: $1"; exit 1; }; }

echo "== 1/3 校验环境变量 =="
for v in FACTORY_PAT NPM_TOKEN ALIYUN_ACR_USERNAME ALIYUN_ACR_PASSWORD JP_DEPLOY_SSH_KEY JP_SERVER_HOST_KEY WECOM_WEBHOOK_URL; do
  need "$v"
done
echo "✓ 全部就绪"

echo "== 2/3 写入工厂仓 secrets =="
for v in FACTORY_PAT NPM_TOKEN ALIYUN_ACR_USERNAME ALIYUN_ACR_PASSWORD JP_DEPLOY_SSH_KEY JP_SERVER_HOST_KEY WECOM_WEBHOOK_URL; do
  gh secret set "$v" -R "$FACTORY" --body "${!v}"
  echo "✓ $FACTORY ← $v"
done

echo "== 3/3 补齐私有仓 dispatch token(HARNESS_BOT_TOKEN) =="
for r in "${DISPATCH_REPOS[@]}"; do
  if gh secret list -R "hiredchina-com/$r" | grep -q '^HARNESS_BOT_TOKEN'; then
    echo "- hiredchina-com/$r 已有 HARNESS_BOT_TOKEN,跳过"
  else
    gh secret set HARNESS_BOT_TOKEN -R "hiredchina-com/$r" --body "$FACTORY_PAT"
    echo "✓ hiredchina-com/$r ← HARNESS_BOT_TOKEN"
  fi
done

echo
echo "== 结果 =="
gh secret list -R "$FACTORY"
echo
echo "下一步:gh workflow run self-test.yml -R $FACTORY 验证链路"
