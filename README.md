# hc-action-factory

Internal CI infrastructure. 工厂 = 本机执行的 CI 替代层,摆脱 GitHub Actions
runner 依赖(org 账单/额度故障、runner 饥饿都会让 GH 侧 CI 整体停摆)。

## scripts/auto-merge-dev.mjs

dev → main 自动合并的 **SSOT**(原 `.github/workflows/auto-merge-dev.yml`
已从 hunter-mate / hunter-mate-harness 移除)。

- 注册仓:hunter-mate、hunter-mate-harness(dev → main)
- 每仓一个持久缓存克隆(`.cache/auto-merge/<name>`),与工作区完全隔离
- 语义与原 GH workflow 一致:`merge --no-edit` + push;冲突时 abort 并
  开/追加 gh issue;已最新跳过;推送竞态自动重试一次
- 退出码:0 = 全部成功/已最新,1 = 存在冲突或失败

```bash
node scripts/auto-merge-dev.mjs                       # 全部注册仓一轮
node scripts/auto-merge-dev.mjs --repo hunter-mate    # 单仓
node --test scripts/auto-merge-dev.test.mjs           # 测试(全本地,4 例)
```

## scripts/install-automerge-watcher.sh

把合并轮询装成 launchd 守护(默认每 180s 一轮,日志
`~/Library/Logs/factory-automerge.log`):

```bash
scripts/install-automerge-watcher.sh             # 安装/重装
scripts/install-automerge-watcher.sh --uninstall # 卸载
```

## scripts/qiniu-release-mirror.mjs

hunter-mate 发版七牛镜像:release workflow 把发布产物(tgz + latest.json +
原生依赖 nativeDeps)传到 `image.hiredchina.com/hunter-mate-releases`。
