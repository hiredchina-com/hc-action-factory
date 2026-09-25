#!/usr/bin/env node
/**
 * local-pipeline.mjs — 工厂本地 CI/Release 运行器(FID-117 Phase B/C)
 *
 * 背景:hunter-mate 等仓的 ci.yml/release.yml 是瘦 dispatcher,重计算在工厂仓
 * GH Actions(pnpm-ci/pnpm-release)。org 账单/runner 故障会让整条链停摆,
 * 本脚本把执行迁到本机。参数契约与 dispatcher 发送的 params 一致:
 *
 *   CI:main 有新提交 → install → scripts → verify → 记 state(同 sha 跳过);
 *       失败开/追加 gh issue(去重),成功回写 commit status(ci_status_context)。
 *   Release:version_file 版本 > 最新 v* tag → 同 CI 序列 → 逐包 publish
 *       (skip 已存在,拓扑序 publish_packages)→ GitHub Release/tag →
 *       七牛镜像(qiniu-release-mirror.mjs,增强通道)→ npmmirror 同步触发。
 *
 * secrets 从本机环境取(NPM_TOKEN / QINIU_ACCESS_KEY 等 / WECOM_WEBHOOK_URL),可放工厂
 * worktree 的 .env.local(gitignored)。缺 NPM_TOKEN 时 release 停在 publish
 * 前打 BLOCKED 并开 issue 提醒;CI 不受影响。--dry-run 跑到 publish 前停。
 *
 * 用法:
 *   node scripts/local-pipeline.mjs                  # 全注册管道一轮(CI+release)
 *   node scripts/local-pipeline.mjs --repo hunter-mate
 *   node scripts/local-pipeline.mjs --ci-only | --release-only
 *   node scripts/local-pipeline.mjs --repo hunter-mate --dry-run
 *
 * 环境变量:FACTORY_PIPELINE_CONFIG(注册表 JSON 替换)、FACTORY_PIPELINE_ROOT
 * (构建克隆/状态根,默认 <factory>/.cache/pipeline)、FACTORY_GH。
 * @fid FID-117-factory-auto-merge @iter 2
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = path.resolve(SCRIPT_DIR, "..");
// 延迟读取(测试可在 import 后改 env;每次调用取最新)
const root = () =>
  process.env.FACTORY_PIPELINE_ROOT ||
  path.join(FACTORY_ROOT, ".cache", "pipeline");
const ghBin = () => process.env.FACTORY_GH || "gh";

// 发布/构建门禁(与 hunter-mate ci.yml / release.yml dispatcher 的 VERIFY 一致)
const HM_VERIFY = `
node scripts/check-server-deps-sync.mjs || { echo "✗ server↔CLI 依赖漂移,拒绝发布"; exit 1; }
test -f packages/cli/dist/index.js
test -f packages/shared/dist/index.js
head -1 packages/cli/dist/index.js | grep -q '#!/usr/bin/env node' || { echo "✗ cli dist 缺 shebang"; exit 1; }
test -f packages/cli/dist/assets/server/main.js || { echo "✗ 缺 bundled server 资产"; exit 1; }
test -f packages/cli/dist/assets/extension/manifest.json || { echo "✗ 缺 bundled extension 资产"; exit 1; }
echo "✓ dist 完整"
cd packages/cli
node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const files = d[0]?.files?.map(f => f.path) || [];
  for (const p of ["dist/assets/server/main.js", "dist/assets/extension/manifest.json"]) {
    if (!files.some(f => f.includes(p))) { console.error("✗ npm pack 缺 " + p); process.exit(1); }
  }
  console.log("✓ npm pack 清单含 server/extension 资产 (" + files.length + " files)");
' < <(npm pack --dry-run --json 2>/dev/null)
`;

const DEFAULT_PIPELINES = [
  {
    name: "hunter-mate",
    remote: "git@github.com:hiredchina-com/hunter-mate.git",
    github: "hiredchina-com/hunter-mate",
    main_branch: "main",
    version_file: "packages/cli/package.json",
    // 发布拓扑序:被依赖者在前(shared → sync-entities → kit → cli)
    publish_packages: [
      "packages/shared",
      "packages/sync-entities",
      "packages/extension-kit",
      "packages/cli",
    ],
    install: "pnpm install --frozen-lockfile",
    scripts: ["lint", "typecheck", "test", "build"],
    verify: HM_VERIFY,
    release_name: "hunter-mate",
    install_cmd: "npm install -g hunter-mate",
    cdn_mirror: {
      package_dir: "packages/cli",
      bucket: "hiredchina",
      key_prefix: "hunter-mate-releases",
      keep: 5,
      base_url: "https://image.hiredchina.com",
    },
    ci_status_context: "factory/pnpm-ci",
  },
];

// ---- 工具 ----
function ts() {
  return new Date().toISOString();
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}
function run(cmd, args, { allowFail = false, env, cwd } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: env || process.env,
    cwd: cwd || undefined,
  });
  if (r.error) {
    if (allowFail) return { code: 127, stdout: "", stderr: String(r.error) };
    throw new Error(`${cmd} ${args.join(" ")} → ${r.error.message}`);
  }
  const out = { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
  if (out.code !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} rc=${out.code}\n${out.stderr.trim().slice(0, 800)}`);
  }
  return out;
}
function bash(script, opts = {}) {
  return run("bash", ["-euo", "pipefail", "-c", script], opts);
}
export function loadPipelines() {
  const p = process.env.FACTORY_PIPELINE_CONFIG;
  return p ? JSON.parse(fs.readFileSync(p, "utf8")) : DEFAULT_PIPELINES;
}

// ---- 锁(与 auto-merge-dev.mjs 同构;持锁者活着返回 null)----
function acquireLock(name) {
  fs.mkdirSync(root(), { recursive: true });
  const dir = path.join(root(), `${name}.lock`);
  try {
    fs.mkdirSync(dir);
  } catch {
    let holder = null;
    try {
      holder = parseInt(fs.readFileSync(path.join(dir, "pid"), "utf8").trim(), 10);
    } catch { /* pid 缺失按死锁 */ }
    if (holder && Number.isFinite(holder)) {
      try {
        process.kill(holder, 0);
        return null;
      } catch { /* 已死回收 */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
  }
  fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  return () => fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 构建克隆(持久,node_modules 跨轮复用;与 auto-merge 缓存克隆隔离)----
function ensureBuildClone(p) {
  const dir = path.join(root(), p.name);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`${p.name}: 首次构建克隆 ← ${p.remote}`);
    run("git", ["clone", p.remote, dir]);
    run("git", ["-C", dir, "config", "user.name", "factory-pipeline[bot]"]);
    run("git", ["-C", dir, "config", "user.email", "factory-pipeline@hiredchina.local"]);
  }
  run("git", ["-C", dir, "fetch", "origin", p.main_branch, "--tags", "--prune"]);
  run("git", ["-C", dir, "checkout", "-B", p.main_branch, `origin/${p.main_branch}`]);
  return dir;
}
function gitC(dir, args, opts) {
  return run("git", ["-C", dir, ...args], opts);
}

// ---- 状态 ----
function stateFile(p, kind) {
  return path.join(root(), `${p.name}.${kind}.json`);
}
function readState(p, kind) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(p, kind), "utf8"));
  } catch {
    return {};
  }
}
function writeState(p, kind, s) {
  fs.writeFileSync(stateFile(p, kind), JSON.stringify(s, null, 2));
}

// ---- 失败上报(按标题去重 issue)----
function reportFailure(p, title, body) {
  try {
    const existing = run(ghBin(), [
      "issue", "list", "--repo", p.github, "--state", "open",
      "--search", `in:title "${title}"`, "--json", "number", "--jq", ".[0].number",
    ], { allowFail: true }).stdout.trim();
    if (existing) {
      run(ghBin(), ["issue", "comment", existing, "--repo", p.github, "--body", body]);
      log(`${p.name}: 已在 issue #${existing} 追加`);
    } else {
      run(ghBin(), ["issue", "create", "--repo", p.github, "--title", title, "--body", body]);
      log(`${p.name}: 已新开 issue`);
    }
  } catch (e) {
    log(`${p.name}: ⚠️ gh 上报失败: ${e.message.split("\n")[0]}`);
  }
}

function writeStatus(p, sha, state, description) {
  if (!p.ci_status_context) return;
  run(ghBin(), [
    "api", "--method=POST", `repos/${p.github}/statuses/${sha}`,
    "-f", `state=${state}`, "-f", `context=${p.ci_status_context}`,
    "-f", `description=${description.slice(0, 140)}`,
  ], { allowFail: true });
}

function notifyWecom(text) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return;
  run("curl", [
    "-fsS", "--max-time", "10", "-X", "POST",
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
    url,
  ], { allowFail: true });
}

// ---- 核心序列:install → scripts → verify ----
function buildAndVerify(p, dir) {
  bash(p.install, { cwd: dir });
  for (const s of p.scripts) {
    log(`${p.name}: pnpm run ${s}`);
    bash(`pnpm run ${s}`, { cwd: dir });
  }
  if (p.verify) {
    log(`${p.name}: verify 门禁`);
    bash(p.verify, { cwd: dir });
  }
}

// ---- 发布检测:version_file 版本 vs 最新 v* tag ----
export function detectRelease(p, dir) {
  const cur = JSON.parse(
    fs.readFileSync(path.join(dir, p.version_file), "utf8")
  ).version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(cur)) {
    return { changed: false, version: cur, prev: null, reason: "非法 semver" };
  }
  const prev = gitC(dir, ["tag", "--list", "v*", "--sort=-v:refname"], { allowFail: true })
    .stdout.split("\n")[0].trim().replace(/^v/, "");
  if (prev && prev === cur) {
    return { changed: false, version: cur, prev, reason: "版本未变化" };
  }
  return { changed: true, version: cur, prev: prev || null };
}

function pkgInfo(dir, pkgDir) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, pkgDir, "package.json"), "utf8"));
  return { dir: pkgDir, name: p.name, version: p.version };
}

// ---- CI ----
export function runCi(p) {
  const releaseLock = acquireLock(`${p.name}-ci`);
  if (!releaseLock) {
    log(`${p.name}-ci: 持锁中,跳过`);
    return "locked";
  }
  try {
    const dir = ensureBuildClone(p);
    const sha = gitC(dir, ["rev-parse", `origin/${p.main_branch}`]).stdout.trim();
    const st = readState(p, "ci");
    if (st.sha === sha && st.ok) {
      log(`${p.name}: CI 已覆盖 ${sha.slice(0, 8)},跳过`);
      return "uptodate";
    }
    log(`${p.name}: CI 开始 ${sha.slice(0, 8)}`);
    try {
      buildAndVerify(p, dir);
      writeState(p, "ci", { sha, ok: true, at: ts() });
      writeStatus(p, sha, "success", "factory local CI pass");
      log(`${p.name}: ✓ CI 通过`);
      return "passed";
    } catch (e) {
      writeState(p, "ci", { sha, ok: false, at: ts() });
      writeStatus(p, sha, "failure", "factory local CI fail");
      reportFailure(p, `factory CI 失败: ${p.name}`, `\`${p.name}\` main@${sha.slice(0, 8)} 本地工厂 CI 失败:\n\n\`\`\`\n${e.message.slice(0, 800)}\n\`\`\`\n\n修复后 push dev,工厂合并+CI 会自动重跑。`);
      log(`${p.name}: ✗ CI 失败: ${e.message.split("\n")[0]}`);
      return "failed";
    }
  } finally {
    releaseLock();
  }
}

// ---- Release ----
export function runRelease(p, { dryRun = false, force = false } = {}) {
  const releaseLock = acquireLock(`${p.name}-rel`);
  if (!releaseLock) {
    log(`${p.name}-rel: 持锁中,跳过`);
    return "locked";
  }
  try {
    const dir = ensureBuildClone(p);
    const det = detectRelease(p, dir);
    if (!det.changed && !force) {
      log(`${p.name}: release 跳过(${det.reason})`);
      return "skipped";
    }
    log(`${p.name}: release ${det.prev ?? "<首发>"} → ${det.version}${dryRun ? " (dry-run)" : ""}`);
    buildAndVerify(p, dir);

    const pkgs = (p.publish_packages || [path.dirname(p.version_file)]).map((d) => pkgInfo(dir, d));
    log(`${p.name}: 发布集 ${pkgs.map((m) => `${m.name}@${m.version}`).join(", ")}`);

    if (dryRun) {
      log(`${p.name}: dry-run — 止于 publish 前`);
      return "dryrun";
    }
    if (!process.env.NPM_TOKEN) {
      log(`${p.name}: ⚠️ BLOCKED — 缺 NPM_TOKEN(见 factory/.env.local),publish/Release/镜像跳过`);
      reportFailure(p, `factory release BLOCKED: ${p.name}`, `\`${p.name}\` v${det.version} 构建+verify 已过,但本机缺 \`NPM_TOKEN\`,publish 未执行。\n\n补齐:工厂 worktree 建 \`.env.local\`(\`NPM_TOKEN=...\`,可选 \`QINIU_ACCESS_KEY/SECRET\`、\`WECOM_WEBHOOK_URL\`),然后 \`node scripts/local-pipeline.mjs --repo ${p.name} --release-only --force\` 重跑。`);
      return "blocked";
    }
    for (const m of pkgs) {
      const exists = run("npm", ["view", `${m.name}@${m.version}`, "version"], { allowFail: true, cwd: dir }).code === 0;
      if (exists) {
        log(`${p.name}: ${m.name}@${m.version} 已发布,跳过`);
        continue;
      }
      log(`${p.name}: 发布 ${m.name}@${m.version}`);
      run("pnpm", ["publish", "--access", "public", "--no-git-checks"], {
        cwd: path.join(dir, m.dir),
        env: { ...process.env, NODE_AUTH_TOKEN: process.env.NPM_TOKEN },
      });
      for (let i = 0; i < 12; i++) {
        if (run("npm", ["view", `${m.name}@${m.version}`, "version"], { allowFail: true, cwd: dir }).code === 0) break;
        run("sleep", ["5"]);
      }
    }
    // GitHub Release + tag(tag 是本 pipeline 的自洽发布基准)
    const tag = `v${det.version}`;
    const hasTag = run(ghBin(), ["api", `repos/${p.github}/git/ref/tags/${tag}`], { allowFail: true }).code === 0;
    if (!hasTag) {
      const prevTag = det.prev ? `v${det.prev}` : "";
      const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
      const notes = [
        `## ${p.release_name || p.name} ${det.version}`, "",
        "### Commits", "",
        gitC(dir, ["log", "-n", "50", "--pretty=format:- %s (%h)", range]).stdout,
        "",
        ...(p.install_cmd ? ["### Install", "", "```bash", `${p.install_cmd}@${det.version}`, "```", ""] : []),
        "### 说明", "",
        "- 此版本由 hc-action-factory 本地 pipeline 自动发布(FID-117)",
      ].join("\n");
      const notesFile = path.join(os.tmpdir(), `relnotes-${p.name}-${det.version}.md`);
      fs.writeFileSync(notesFile, notes);
      const sha = gitC(dir, ["rev-parse", `origin/${p.main_branch}`]).stdout.trim();
      const r = run(ghBin(), ["release", "create", tag, "--repo", p.github, "--target", sha, "--title", `${p.release_name || p.name} ${det.version}`, "--notes-file", notesFile], { allowFail: true });
      log(`${p.name}: GitHub Release ${tag} ${r.code === 0 ? "✓" : "⚠️ " + r.stderr.trim().slice(0, 120)}`);
    }
    // 七牛镜像(增强通道,失败不阻断)
    if (p.cdn_mirror && process.env.QINIU_ACCESS_KEY && process.env.QINIU_SECRET_KEY) {
      const m = p.cdn_mirror;
      const r = run("node", [
        path.join(SCRIPT_DIR, "qiniu-release-mirror.mjs"),
        "--dir", path.join(dir, m.package_dir),
        "--version", det.version,
        "--bucket", m.bucket,
        "--key-prefix", m.key_prefix,
        "--keep", String(m.keep),
        "--base-url", m.base_url,
      ], { allowFail: true, env: { ...process.env }, cwd: FACTORY_ROOT });
      log(`${p.name}: 七牛镜像 ${r.code === 0 ? "✓" : "⚠️ 失败(不阻断): " + r.stderr.trim().slice(0, 120)}`);
    } else if (p.cdn_mirror) {
      log(`${p.name}: ⚠️ 缺 QINIU_ACCESS_KEY/SECRET,跳过七牛镜像(CLI 自更新回退通道不可用)`);
    }
    // npmmirror 同步(公开接口,best-effort,防爬虫漏同步)
    run("node", [path.join(SCRIPT_DIR, "npmmirror-sync.mjs"), ...pkgs.map((m) => m.name)], {
      allowFail: true,
      cwd: FACTORY_ROOT,
    });
    writeState(p, "rel", { version: det.version, sha: gitC(dir, ["rev-parse", `origin/${p.main_branch}`]).stdout.trim(), at: ts() });
    notifyWecom(`**[OK] ${p.github} release ${det.version}**\n\n本地工厂 pipeline 发布完成(npm + GitHub Release${p.cdn_mirror ? " + 七牛镜像" : ""})。`);
    log(`${p.name}: ✓ release ${det.version} 完成`);
    return "released";
  } finally {
    releaseLock();
  }
}

// ---- 入口 ----
export function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const only = val("--repo");
  const dryRun = flag("--dry-run");
  const ciOnly = flag("--ci-only");
  const relOnly = flag("--release-only");
  const force = flag("--force");

  let pipes = loadPipelines();
  if (only) {
    pipes = pipes.filter((p) => p.name === only);
    if (!pipes.length) {
      console.error(`--repo ${only} 不在注册表`);
      process.exit(2);
    }
  }
  fs.mkdirSync(root(), { recursive: true });

  // .env.local(工厂 worktree 内,gitignored)注入 secrets
  const envLocal = path.join(FACTORY_ROOT, ".env.local");
  if (fs.existsSync(envLocal)) {
    for (const line of fs.readFileSync(envLocal, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }

  let bad = 0;
  for (const p of pipes) {
    try {
      if (!relOnly) {
        if (runCi(p) === "failed") bad += 1;
      }
      if (!ciOnly) {
        const r = runRelease(p, { dryRun, force });
        if (r === "failed" || r === "blocked") bad += 1;
      }
    } catch (e) {
      bad += 1;
      log(`${p.name}: ✗ ${e.message.split("\n")[0]}`);
    }
  }
  process.exitCode = bad > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
