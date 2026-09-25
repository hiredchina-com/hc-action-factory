#!/usr/bin/env node
/**
 * auto-merge-dev.mjs — 工厂侧 dev → main 自动合并(FID-117 SSOT)
 *
 * 背景:GitHub Actions 版 auto-merge(.github/workflows/auto-merge-dev.yml)依赖
 * org runner——2026-09 账单/额度故障 + 2026-09-13 runner 饥饿两次让 dev→main
 * 停摆。本脚本把合并执行迁到工厂(本机),零 runner 依赖:
 *   - 每个仓一个持久缓存克隆(.cache/auto-merge/<name>),与工作区/其他 worktree
 *     完全隔离;上一轮中断/冲突残留自动清理(reset --hard + clean)
 *   - 合并语义与原 GH workflow 一致:checkout -B main origin/main →
 *     merge --no-edit origin/dev → push main;冲突时 abort + 开/追加 gh issue
 *   - 单实例锁(mkdir + pid),launchd 轮询重叠时后到者直接退出
 *   - gh CLI 只用于冲突上报(本地凭据),合并不依赖 GitHub API
 *
 * 用法:
 *   node scripts/auto-merge-dev.mjs              # 全部注册仓一轮
 *   node scripts/auto-merge-dev.mjs --repo hunter-mate-harness
 *
 * 环境变量(测试/排障用):
 *   FACTORY_AUTOMERGE_CONFIG   注册表 JSON 路径(默认内置 hunter-mate / hunter-mate-harness)
 *   FACTORY_CACHE_ROOT         缓存克隆根目录(默认 <factory>/.cache/auto-merge)
 *   FACTORY_LOCAL_POOL         本地 bare 池路径,存在则首次克隆走本地(默认 hc-hw repos/)
 *   FACTORY_GH                 gh 可执行文件(测试注入 fake)
 *
 * 退出码:0 = 全部已最新/合并成功;1 = 存在冲突或失败(详情见输出)。
 * @fid FID-117-factory-auto-merge @iter 1
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = path.resolve(SCRIPT_DIR, "..");

const DEFAULT_REPOS = [
  {
    name: "hunter-mate",
    remote: "git@github.com:hiredchina-com/hunter-mate.git",
    github: "hiredchina-com/hunter-mate",
  },
  {
    name: "hunter-mate-harness",
    remote: "git@github.com:hiredchina-com/hunter-mate-harness.git",
    github: "hiredchina-com/hunter-mate-harness",
  },
  {
    name: "chromepilot",
    remote: "git@github.com:hiredchina-com/chromepilot.git",
    github: "hiredchina-com/chromepilot",
  },
  {
    name: "dev-ops",
    remote: "git@github.com:hiredchina-com/dev-ops.git",
    github: "hiredchina-com/dev-ops",
  },
  {
    name: "job-pages",
    remote: "git@github.com:hiredchina-com/job-pages.git",
    github: "hiredchina-com/job-pages",
  },
];

const CACHE_ROOT =
  process.env.FACTORY_CACHE_ROOT ||
  path.join(FACTORY_ROOT, ".cache", "auto-merge");
const LOCAL_POOL = process.env.FACTORY_LOCAL_POOL || "/Users/thomas/Projects/hc-hw/repos";
const GH_BIN = process.env.FACTORY_GH || "gh";
const CONFLICT_TITLE = "dev → main auto-merge 冲突(工厂)";

// ---- 基础工具 ----
function ts() {
  return new Date().toISOString();
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}
function run(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    if (allowFail) return { code: 127, stdout: "", stderr: String(r.error) };
    throw new Error(`${cmd} ${args.join(" ")} → ${r.error.message}`);
  }
  const code = r.status === null ? 1 : r.status;
  const out = {
    code,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
  if (code !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.join(" ")} rc=${code}\n${out.stderr.trim().slice(0, 500)}`
    );
  }
  return out;
}

function loadRepos() {
  const cfgPath = process.env.FACTORY_AUTOMERGE_CONFIG;
  if (cfgPath) {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  }
  return DEFAULT_REPOS;
}

// ---- 单实例锁(mkdir 原子 + pid 活性检测)----
function acquireLock() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const lockDir = path.join(CACHE_ROOT, ".lock");
  try {
    fs.mkdirSync(lockDir);
  } catch {
    // 锁已存在:持有者还活着就让位退出;死了就回收
    let holder = null;
    try {
      holder = parseInt(
        fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim(),
        10
      );
    } catch {
      /* pid 文件缺失按死锁处理 */
    }
    if (holder && Number.isFinite(holder)) {
      try {
        process.kill(holder, 0);
        log(`已有实例运行(pid=${holder}),本趟退出`);
        process.exit(0);
      } catch {
        /* 持有者已死 */
      }
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
  return () => fs.rmSync(lockDir, { recursive: true, force: true });
}

// ---- 缓存克隆:首次从本地 bare 池(快)或远端克隆,随后始终对远端 fetch/push ----
function ensureClone(repo) {
  const dir = path.join(CACHE_ROOT, repo.name);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    const local = path.join(LOCAL_POOL, `${repo.name}.git`);
    const src = fs.existsSync(local) ? local : repo.remote;
    log(`${repo.name}: 首次克隆 ← ${src}`);
    run("git", ["clone", src, dir]);
    run("git", ["-C", dir, "remote", "set-url", "origin", repo.remote]);
    run("git", ["-C", dir, "config", "user.name", "factory-automerge[bot]"]);
    run("git", [
      "-C",
      dir,
      "config",
      "user.email",
      "factory-automerge@hiredchina.local",
    ]);
  }
  return dir;
}

// ---- 冲突上报:开/追加 gh issue,失败只告警不影响合并中止语义 ----
function reportConflict(repo) {
  const body =
    `工厂轮询合并失败:\`${repo.name}\` 的 dev 合进 main 存在冲突,已中止。\n\n` +
    `人工处理:\n\`\`\`bash\ngit checkout main && git merge origin/dev\n\`\`\``;
  try {
    const existing = run(
      GH_BIN,
      [
        "issue", "list",
        "--repo", repo.github,
        "--state", "open",
        "--search", `in:title "${CONFLICT_TITLE}"`,
        "--json", "number",
        "--jq", ".[0].number",
      ],
      { allowFail: true }
    ).stdout.trim();
    if (existing) {
      run(GH_BIN, [
        "issue", "comment", existing,
        "--repo", repo.github,
        "--body", body,
      ]);
      log(`${repo.name}: 已在冲突 issue #${existing} 追加评论`);
    } else {
      run(GH_BIN, [
        "issue", "create",
        "--repo", repo.github,
        "--title", CONFLICT_TITLE,
        "--body", body,
      ]);
      log(`${repo.name}: 已新开冲突 issue`);
    }
  } catch (e) {
    log(`${repo.name}: ⚠️ gh issue 上报失败(合并已中止,需人工关注): ${e.message}`);
  }
}

// ---- 单仓合并:返回 merged | uptodate | conflict ----
function mergeRepo(repo) {
  const dir = ensureClone(repo);
  // 清上一轮残留(中断/冲突),保证从 origin 状态确定性出发
  run("git", ["-C", dir, "merge", "--abort"], { allowFail: true });
  run("git", ["-C", dir, "reset", "--hard"], { allowFail: true });
  run("git", ["-C", dir, "clean", "-fdq"], { allowFail: true });
  run("git", ["-C", dir, "fetch", "origin", "main", "dev", "--prune"]);
  run("git", ["-C", dir, "checkout", "-B", "main", "origin/main"]);

  // origin/dev 已是 main 祖先 → 无需合并
  const isAncestor = run(
    "git",
    ["-C", dir, "merge-base", "--is-ancestor", "origin/dev", "main"],
    { allowFail: true }
  ).code;
  if (isAncestor === 0) {
    return "uptodate";
  }

  try {
    run("git", ["-C", dir, "merge", "--no-edit", "origin/dev"]);
  } catch (e) {
    run("git", ["-C", dir, "merge", "--abort"], { allowFail: true });
    log(`${repo.name}: ✗ 合并冲突,已中止并上报 issue`);
    reportConflict(repo);
    return "conflict";
  }

  const before = run("git", ["-C", dir, "rev-parse", "origin/main"]).stdout.trim();
  const after = run("git", ["-C", dir, "rev-parse", "main"]).stdout.trim();
  if (before === after) {
    return "uptodate"; // merge 实际无变化(防御)
  }

  // 推送,防 main 被他人推进的非快进竞态:重抓重合一趟再推
  try {
    run("git", ["-C", dir, "push", "origin", "main"]);
  } catch (e1) {
    log(`${repo.name}: 首次推送被拒(竞态?),重抓重试一次`);
    run("git", ["-C", dir, "fetch", "origin", "main"]);
    run("git", ["-C", dir, "checkout", "-B", "main", "origin/main"]);
    run("git", ["-C", dir, "merge", "--no-edit", "origin/dev"]);
    run("git", ["-C", dir, "push", "origin", "main"]);
  }
  const short = run("git", ["-C", dir, "rev-parse", "--short", "main"]).stdout.trim();
  log(`${repo.name}: ✓ 已合并并推送 main → ${short}`);
  return "merged";
}

// ---- 入口 ----
function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf("--repo");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

  let repos = loadRepos();
  if (only) {
    repos = repos.filter((r) => r.name === only);
    if (repos.length === 0) {
      console.error(`--repo ${only} 不在注册表中`);
      process.exit(2);
    }
  }

  const releaseLock = acquireLock();
  try {
    let failures = 0;
    for (const repo of repos) {
      try {
        const status = mergeRepo(repo);
        if (status === "uptodate") {
          log(`${repo.name}: main 已是最新,跳过`);
        } else if (status === "conflict") {
          failures += 1;
        }
      } catch (e) {
        failures += 1;
        log(`${repo.name}: ✗ 失败: ${e.message.split("\n")[0]}`);
      }
    }
    process.exitCode = failures > 0 ? 1 : 0;
  } finally {
    releaseLock();
  }
}

main();
