#!/usr/bin/env node
/**
 * npmmirror-sync.mjs — 发布后对 npmmirror 发 on-demand 同步请求(FID-117)
 *
 * 背景:@hunter-mate/sync-entities 2026-09-16 发布后 npmmirror 爬虫 9 天未同步,
 * 安装侧 E404。npmmirror 公开同步接口:PUT /-/package/<name>/syncs,触发后
 * 秒级补齐(已实证)。本脚本在 npm publish 后对本发布涉及的所有包逐个触发,
 * best-effort:单个失败只告警不阻断。
 *
 * 用法:node scripts/npmmirror-sync.mjs <pkg> [pkg...]
 * @fid FID-117-factory-auto-merge @iter 2
 */
const BASE = "https://registry.npmmirror.com";

function enc(name) {
  return name.startsWith("@") ? name.replace("/", "%2f") : name;
}

async function main() {
  const pkgs = process.argv.slice(2);
  if (pkgs.length === 0) {
    console.error("用法: npmmirror-sync.mjs <pkg> [pkg...]");
    process.exit(2);
  }
  let failed = 0;
  for (const name of pkgs) {
    try {
      const r = await fetch(`${BASE}/-/package/${enc(name)}/syncs`, {
        method: "PUT",
        signal: AbortSignal.timeout(30_000),
      });
      const body = await r.text().catch(() => "");
      if (r.ok) {
        console.log(`✓ ${name}: sync 已触发 (${body.slice(0, 80)})`);
      } else {
        failed += 1;
        console.log(`⚠ ${name}: sync 请求返回 ${r.status} (${body.slice(0, 120)})`);
      }
    } catch (e) {
      failed += 1;
      console.log(`⚠ ${name}: sync 请求失败: ${e.message}`);
    }
  }
  // best-effort:至少触发过就算 0;全挂才 1
  process.exitCode = failed === pkgs.length ? 1 : 0;
}

main();
