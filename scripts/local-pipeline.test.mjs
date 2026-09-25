#!/usr/bin/env node
/**
 * local-pipeline.test.mjs — local-pipeline.mjs 决策逻辑测试(全本地)
 *
 * tmp 造 bare origin + seed(main 带 version_file),注入
 * FACTORY_PIPELINE_CONFIG / FACTORY_PIPELINE_ROOT / FACTORY_GH(模块级常量,
 * 必须在动态 import 前设置)。
 * 覆盖:发布检测(tag 基准)、CI 通过+幂等跳过、release dry-run/BLOCKED 门。
 * @fid FID-117-factory-auto-merge @iter 2
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
  "local-pipeline.mjs"
);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} rc=${r.status}\n${r.stderr}`);
  }
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function commitAll(dir, msg) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", msg]);
}

async function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lp-${t.name}-`));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const origin = path.join(tmp, "origin.git");
  fs.mkdirSync(origin);
  git(tmp, ["init", "--bare", "origin.git"]);

  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  git(tmp, ["init", "-b", "main", "seed"]);
  fs.writeFileSync(
    path.join(seed, "package.json"),
    JSON.stringify({
      name: "fake-pkg",
      version: "0.1.0",
      scripts: { lint: "true", typecheck: "true", test: "true", build: "true" },
    })
  );
  fs.writeFileSync(path.join(seed, "index.js"), "module.exports=1;\n");
  commitAll(seed, "init");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "origin", "main"]);

  // fake gh:issue list 已存在时返回 7;其余静默成功
  const ghLog = path.join(tmp, "gh.log");
  const ghBin = path.join(tmp, "gh");
  fs.writeFileSync(
    ghBin,
    `#!/bin/sh
echo "$*" >> "${ghLog}"
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  if grep -q "issue create" "${ghLog}" 2>/dev/null; then echo "7"; fi
  exit 0
fi
exit 0
`
  );
  fs.chmodSync(ghBin, 0o755);

  const config = path.join(tmp, "pipelines.json");
  fs.writeFileSync(
    config,
    JSON.stringify([
      {
        name: "fake-pkg",
        remote: origin,
        github: "acme/fake-pkg",
        main_branch: "main",
        version_file: "package.json",
        publish_packages: ["."],
        install: "true",
        scripts: ["lint", "typecheck", "test", "build"],
        verify: "",
        release_name: "fake-pkg",
        ci_status_context: "",
      },
    ])
  );

  process.env.FACTORY_PIPELINE_CONFIG = config;
  process.env.FACTORY_PIPELINE_ROOT = path.join(tmp, "state");
  process.env.FACTORY_GH = ghBin;
  delete process.env.NPM_TOKEN;

  const lp = await import(SCRIPT);
  const p = lp.loadPipelines()[0];
  return { tmp, origin, seed, ghLog, lp, p };
}

test("发布检测:无 tag → 首发;打完 v0.1.0 → 版本未变化", async (t) => {
  const { lp, p, seed } = await setup(t);
  const dir = seed;
  const first = lp.detectRelease(p, dir);
  assert.equal(first.changed, true);
  assert.equal(first.version, "0.1.0");
  assert.equal(first.prev, null);

  git(seed, ["tag", "v0.1.0"]);
  const again = lp.detectRelease(p, dir);
  assert.equal(again.changed, false);
  assert.equal(again.reason, "版本未变化");
});

test("CI:通过 + 同 sha 幂等跳过;脚本失败 → failed 并上报 issue", async (t) => {
  const { lp, p, seed, ghLog } = await setup(t);
  const r1 = lp.runCi(p);
  assert.equal(r1, "passed");

  fs.writeFileSync(path.join(seed, "b.txt"), "x\n");
  commitAll(seed, "more");
  git(seed, ["push", "origin", "main"]);
  const r2 = lp.runCi(p);
  assert.equal(r2, "passed");

  // 同一 sha 再跑 → uptodate
  const r3 = lp.runCi(p);
  assert.equal(r3, "uptodate");

  // 改坏脚本 → failed + issue(注意必须重新 loadPipelines,否则沿用旧 p)
  const cfg = JSON.parse(fs.readFileSync(process.env.FACTORY_PIPELINE_CONFIG, "utf8"));
  cfg[0].scripts = ["lint", "typecheck", "test", "boom"];
  fs.writeFileSync(process.env.FACTORY_PIPELINE_CONFIG, JSON.stringify(cfg));
  const p2 = lp.loadPipelines()[0];
  fs.writeFileSync(path.join(seed, "c.txt"), "y\n");
  commitAll(seed, "break");
  git(seed, ["push", "origin", "main"]);
  const r4 = lp.runCi(p2);
  assert.equal(r4, "failed");
  const calls = fs.readFileSync(ghLog, "utf8");
  assert.match(calls, /issue create/, "CI 失败应开 issue");
});

test("release:dry-run 止于 publish 前;缺 NPM_TOKEN → blocked 并开 issue", async (t) => {
  const { lp, p, ghLog } = await setup(t);
  // 无 tag → 触发 release 检测
  const d = lp.runRelease(p, { dryRun: true });
  assert.equal(d, "dryrun");

  const b = lp.runRelease(p, {});
  assert.equal(b, "blocked");
  const calls = fs.readFileSync(ghLog, "utf8");
  assert.match(calls, /issue create/, "BLOCKED 应开 issue 提醒补 NPM_TOKEN");
});
