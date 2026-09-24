#!/usr/bin/env node
/**
 * auto-merge-dev.test.mjs — auto-merge-dev.mjs 的 node:test 测试
 *
 * 全本地:tmp 下建 bare origin + seed 克隆 + fake gh(只记录调用),
 * 通过 FACTORY_AUTOMERGE_CONFIG / FACTORY_CACHE_ROOT / FACTORY_GH 注入。
 * 覆盖:干净合并、已最新幂等、冲突中止 + issue 去重上报、--repo 过滤。
 * @fid FID-117-factory-auto-merge @iter 1
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "auto-merge-dev.mjs"
);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} rc=${r.status}\n${r.stderr}`);
  }
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function commitAll(dir, msg) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", msg]);
}
function runScript(env, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/**
 * 造一个本地"远程仓":bare origin + seed 克隆(main + dev 同点)。
 * 返回 { tmp, origin, seed, env, ghLog }。
 */
function makeRemote(t, name = "t-repo") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `am-${t.name}-`));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const origin = path.join(tmp, "origin.git");
  fs.mkdirSync(origin);
  git(tmp, ["init", "--bare", "origin.git"]);

  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  git(tmp, ["init", "-b", "main", "seed"]);
  fs.writeFileSync(path.join(seed, "a.txt"), "base\n");
  commitAll(seed, "init");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "origin", "main"]);
  git(seed, ["checkout", "-b", "dev"]);
  git(seed, ["push", "origin", "dev"]);

  // fake gh:记录全部调用;issue list 在已有 create 后返回 #1(模拟 issue 已存在)
  const ghLog = path.join(tmp, "gh.log");
  const ghBin = path.join(tmp, "gh");
  fs.writeFileSync(
    ghBin,
    `#!/bin/sh
echo "$*" >> "${ghLog}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  if grep -q "issue create" "${ghLog}" 2>/dev/null; then echo "1"; fi
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  echo "https://github.com/acme/t-repo/issues/1"; exit 0
fi
exit 0
`
  );
  fs.chmodSync(ghBin, 0o755);

  const config = path.join(tmp, "repos.json");
  fs.writeFileSync(
    config,
    JSON.stringify([{ name, remote: origin, github: "acme/t-repo" }])
  );

  const env = {
    FACTORY_AUTOMERGE_CONFIG: config,
    FACTORY_CACHE_ROOT: path.join(tmp, "cache"),
    FACTORY_LOCAL_POOL: path.join(tmp, "no-such-pool"),
    FACTORY_GH: ghBin,
  };
  return { tmp, origin, seed, env, ghLog };
}

function remoteSha(origin, ref) {
  return git(origin, ["rev-parse", ref]).stdout.trim();
}

test("干净合并:main 落后 dev → 合并提交并推送", (t) => {
  const { origin, seed, env } = makeRemote(t);
  const mainBefore = remoteSha(origin, "main");

  fs.writeFileSync(path.join(seed, "feat.txt"), "new\n");
  commitAll(seed, "dev work");
  git(seed, ["push", "origin", "dev"]);

  const r = runScript(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已合并并推送 main/);

  const mainAfter = remoteSha(origin, "main");
  assert.notEqual(mainAfter, mainBefore);
  // dev 已是 main 祖先(合并语义正确)
  assert.equal(
    git(origin, ["merge-base", "--is-ancestor", "dev", "main"]).code,
    0
  );
});

test("幂等:已最新时跳过,不推不改", (t) => {
  const { origin, seed, env } = makeRemote(t);
  fs.writeFileSync(path.join(seed, "feat.txt"), "new\n");
  commitAll(seed, "dev work");
  git(seed, ["push", "origin", "dev"]);
  assert.equal(runScript(env).status, 0);

  const mainBefore = remoteSha(origin, "main");
  const r = runScript(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已是最新,跳过/);
  assert.equal(remoteSha(origin, "main"), mainBefore);
});

test("冲突:中止合并,main 不动,issue 首跑 create 再跑 comment 去重", (t) => {
  const { origin, seed, env, ghLog } = makeRemote(t);

  // dev 先改 a.txt
  fs.writeFileSync(path.join(seed, "a.txt"), "dev version\n");
  commitAll(seed, "dev change");
  git(seed, ["push", "origin", "dev"]);
  // main 再改同一文件(直接提交 main 模拟 hotfix)
  git(seed, ["checkout", "main"]);
  fs.writeFileSync(path.join(seed, "a.txt"), "main version\n");
  commitAll(seed, "main hotfix");
  git(seed, ["push", "origin", "main"]);
  git(seed, ["checkout", "dev"]);

  const mainBefore = remoteSha(origin, "main");
  const r1 = runScript(env);
  assert.equal(r1.status, 1, "冲突应退出 1");
  assert.equal(remoteSha(origin, "main"), mainBefore, "main 不得被推动");
  let ghCalls = fs.readFileSync(ghLog, "utf8");
  assert.match(ghCalls, /issue create/, "首跑应开 issue");

  const r2 = runScript(env);
  assert.equal(r2.status, 1);
  ghCalls = fs.readFileSync(ghLog, "utf8");
  assert.equal(
    ghCalls.split("\n").filter((l) => l.includes("issue create")).length,
    1,
    "不应重复开 issue"
  );
  assert.match(ghCalls, /issue comment 1 /, "再跑应改为追加评论");
});

test("--repo 过滤:只处理指定仓", (t) => {
  const a = makeRemote(t, "repo-a");
  const b = makeRemote(t, "repo-b");
  // 两个仓共用一个 config/cache,用同一 fake gh
  const config = path.join(a.tmp, "repos.json");
  fs.writeFileSync(
    config,
    JSON.stringify([
      { name: "repo-a", remote: a.origin, github: "acme/repo-a" },
      { name: "repo-b", remote: b.origin, github: "acme/repo-b" },
    ])
  );
  const env = {
    ...a.env,
    FACTORY_AUTOMERGE_CONFIG: config,
    FACTORY_CACHE_ROOT: path.join(a.tmp, "cache"),
  };
  for (const s of [a.seed, b.seed]) {
    fs.writeFileSync(path.join(s, "f.txt"), "x\n");
  }
  commitAll(a.seed, "a work");
  git(a.seed, ["push", "origin", "dev"]);
  commitAll(b.seed, "b work");
  git(b.seed, ["push", "origin", "dev"]);

  const mainA = remoteSha(a.origin, "main");
  const mainB = remoteSha(b.origin, "main");
  const r = runScript(env, ["--repo", "repo-a"]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(remoteSha(a.origin, "main"), mainA, "repo-a 应被合并");
  assert.equal(remoteSha(b.origin, "main"), mainB, "repo-b 不得被动");
});
