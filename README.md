# hc-action-factory

Internal CI infrastructure. 工厂 = 本机执行的 CI 替代层,摆脱 GitHub Actions
runner 依赖(org 账单/额度故障、runner 饥饿都会让 GH 侧 CI 整体停摆)。

## scripts/auto-merge-dev.mjs

dev → main 自动合并的 **SSOT**(原 `.github/workflows/auto-merge-dev.yml`
已从 hunter-mate / hunter-mate-harness 移除)。

- 注册仓:hunter-mate、hunter-mate-harness、chromepilot、dev-ops、job-pages
  (dev → main;FID-117 iter2 起全覆盖)
- 每仓一个持久缓存克隆(`.cache/auto-merge/<name>`),与工作区完全隔离
- 语义与原 GH workflow 一致:`merge --no-edit` + push;冲突时 abort 并
  开/追加 gh issue;已最新跳过;推送竞态自动重试一次
- 退出码:0 = 全部成功/已最新,1 = 存在冲突或失败

```bash
node scripts/auto-merge-dev.mjs                       # 全部注册仓一轮
node scripts/auto-merge-dev.mjs --repo hunter-mate    # 单仓
node --test scripts/auto-merge-dev.test.mjs           # 测试(全本地,4 例)
```

## scripts/local-pipeline.mjs

本地 CI/Release 运行器(参数契约与原 dispatcher 发工厂仓的 params 一致):

- **CI**:main 新提交 → install → lint/typecheck/test/build → verify 门禁 →
  记 state(同 sha 跳过);失败开/追加 gh issue,成功回写 commit status;
- **Release**:version_file 版本 > 最新 v* tag → 同 CI 序列 → 逐包 publish
  (拓扑序、skip 已存在)→ GitHub Release/tag → 七牛镜像 → npmmirror 同步;
- secrets 走本机环境,放工厂 worktree `.env.local`(gitignored):
  `NPM_TOKEN`(必需)、`QINIU_ACCESS_KEY/SECRET`(七牛镜像)、
  `WECOM_WEBHOOK_URL`(企微通知);缺 NPM_TOKEN 时 release 打 BLOCKED
  并开 issue,CI 不受影响;
- 测试:`node --test scripts/local-pipeline.test.mjs`(3 例,全本地)。

```bash
node scripts/local-pipeline.mjs                 # CI+release 一轮(全注册)
node scripts/local-pipeline.mjs --repo hunter-mate --ci-only
node scripts/local-pipeline.mjs --dry-run       # 跑到 publish 前停
```

## scripts/npmmirror-sync.mjs

npm publish 后对 npmmirror 发 on-demand 同步(防其爬虫漏同步导致国内
安装 E404,`@hunter-mate/sync-entities` 9 天漏同步事故):
`node scripts/npmmirror-sync.mjs <pkg> [pkg...]`。已被 local-pipeline
在发布后自动调用。

## scripts/install-automerge-watcher.sh

把合并轮询装成 launchd 守护(两个 job,幂等重装):

```bash
scripts/install-automerge-watcher.sh             # 安装/重装
scripts/install-automerge-watcher.sh --uninstall # 卸载
```

- `com.hiredchina.factory-automerge`:每 180s 合并轮询,
  日志 `~/Library/Logs/factory-automerge.log`;
- `com.hiredchina.factory-pipeline`:每 300s CI/release 轮询,
  日志 `~/Library/Logs/factory-pipeline.log`。

## scripts/qiniu-release-mirror.mjs

hunter-mate 发版七牛镜像:release workflow 把发布产物(tgz + latest.json +
原生依赖 nativeDeps)传到 `image.hiredchina.com/hunter-mate-releases`。
