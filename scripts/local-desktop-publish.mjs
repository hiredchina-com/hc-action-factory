#!/usr/bin/env node
// local-desktop-publish.mjs — HunterMate 桌面版本机直传发布(2026-11-15 定案)
//
// 背景:工厂 handoff 腿(jp 服务器 ssh 编排,分段拉 GitHub 工件)自 2026-11-14 起
// 稳定死亡——8 分段全部恰死于 13056 字节,3 试 3 败必现,根因未定位且 ssh 调试
// 未获授权。v0.3.11 走本机直传全链实战成功(8 分钟发完 1.7GB,读回全绿)。
// 用户裁定(2026-11-15):发布链改本地,本脚本把当日手工 SOP 固化成可重复工具,
// 工厂砍 handoff 腿;后续任何 green build 不会再因 jp→GitHub 拉取死亡而搁浅。
//
// 链路(与 qiniu-desktop-release.mjs 串接):
//   ①gh api 解析 run 的 5 个工件(arm64 dmg+zip+blockmap / x64 dmg+zip+blockmap /
//     win exe+blockmap / appcast-arm64 / appcast-x64)
//   ②curl -sI 取 archive_download_url 的重定向签名 URL(只用一次,见坑③)
//   ③三主工件并行 curl 整拉(~2.3MB/s 聚合);解压
//   ④实算 sha256/sha512-b64/size/blockMapSize,按线上 live 形状生成
//     latest.yml / latest-mac.yml(electron-updater 清单,根目录)
//   ⑤调 qiniu-desktop-release.mjs 一把梭(顺序铁律在其内部:主包→载体→清单→latest.json)
//   ⑥效应端读回(hard-rule 32):CDN latest.json + dev-ops API 双版本一致 +
//     二进制首 4MB range 拉与本地逐字节一致
//
// 用法:
//   node scripts/local-desktop-publish.mjs --run <run-id> [--notes "…"] [--dry-run]
//   node scripts/local-desktop-publish.mjs --watch          # 常驻:自动发布新 green build
//
// 环境:gh CLI 已登录(拉工件签名 URL);QINIU_ACCESS_KEY/QINIU_SECRET_KEY 来自
// 环境变量或工厂仓 .env.local(0600,不进 git)。watch 模式建议 launchd 常驻:
//   scripts/hmd-local-publish-watch.plist(本目录) → ~/Library/LaunchAgents + launchctl load
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO = 'hiredchina-com/hc-action-factory';
const CDN_BASE = 'https://npm.hiredchina.com';
const KEY_PREFIX = 'packages/huntermate-desktop-releases';
const DEVOPS_API = 'https://dev-ops.hiredchina.com/api/desktop-releases/latest';
const WATCH_STATE = path.join(os.homedir(), '.config/hc-hw/hmd-local-publish/state.json');
const WATCH_INTERVAL_S = 120;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const RUN_ID = arg('run', '');
const NOTES = arg('notes', '');
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const WATCH = process.argv.includes('--watch');

// ── 钥匙:环境变量优先,回落工厂 .env.local(0600 本机配置,不回显)──────────
function loadKeys() {
  if (!process.env.QINIU_ACCESS_KEY || !process.env.QINIU_SECRET_KEY) {
    const envLocal = path.join(FACTORY_ROOT, '.env.local');
    if (fs.existsSync(envLocal)) {
      for (const line of fs.readFileSync(envLocal, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  if (!process.env.QINIU_ACCESS_KEY || !process.env.QINIU_SECRET_KEY) {
    die('缺 QINIU_ACCESS_KEY/QINIU_SECRET_KEY:export 注入或放工厂仓 .env.local(0600)');
  }
}

function log(msg) { console.log(`[hmd-local-publish] ${msg}`); }
function die(msg) { console.error(`✗ [hmd-local-publish] ${msg}`); process.exit(1); }
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
// 二进制输出禁 utf8 解码(编码字符串会毁字节,range 读回校验必须走这个)
// maxBuffer 必须 > 4MB range 载荷(execFileSync 默认 1MB,2026-11-15 实战 ENOBUFS)
function shRaw(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function ghJson(apiPath) {
  const p = apiPath.startsWith('/') ? apiPath : `/repos/${REPO}/${apiPath}`;
  return JSON.parse(sh('gh', ['api', p]));
}
function hashFile(algo, file) {
  const h = createHash(algo);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h;
}
function sha256Hex(file) { return hashFile('sha256', file).digest('hex'); }
function sha512B64(file) { return hashFile('sha512', file).digest('base64'); }

// ── 工件下载(坑:签名 URL 每解析一次=一个新 zip 代际,但跨代际字节实测确定;
//    仍遵守「单次下载只解析一次」纪律。curl 直拉可见可控,gh run download 假死)──
function resolveSignedUrl(artifactId) {
  const head = sh('curl', ['-sS', '-I', '-H', `Authorization: Bearer ${sh('gh', ['auth', 'token']).trim()}`,
    `https://api.github.com/repos/${REPO}/actions/artifacts/${artifactId}/zip`]);
  const loc = head.split('\n').find((l) => l.toLowerCase().startsWith('location:'));
  if (!loc) die(`工件 ${artifactId} 未返回重定向(gh token 失效?)`);
  return loc.slice(loc.indexOf(':') + 1).trim();
}

function zipIntact(file) {
  try { execFileSync('unzip', ['-tqq', file], { stdio: 'ignore' }); return true; } catch { return false; }
}
// 单连接 ~0.1MB/s(2026-11-15 晚高峰实测),整文件并行也只 0.3MB/s 聚合;
// 必须分段:SEGMENTS 段 ×N 文件并发。每段独立重试,URL 老化(>480s,SAS ~605s
// 过期见 v0.3.6 定案)或段失败即重解析。段文件攒齐后拼装机。
const SEGMENTS = 8;

function curlRange(url, start, end, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl', ['-fsS', '--max-time', '1800', '-r', `${start}-${end}`, '-o', dest, url],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split('\n')[0] || `curl exit ${code}`))));
  });
}

async function downloadSegmented(art, signedUrl, destZip, segmentsDir) {
  const total = art.size_in_bytes;
  const bounds = [];
  const step = Math.ceil(total / SEGMENTS);
  for (let i = 0; i < SEGMENTS; i += 1) {
    const start = i * step;
    const end = Math.min(start + step, total) - 1;
    if (start > end) break;
    bounds.push([i, start, end]);
  }
  let url = signedUrl;
  let urlAt = Date.now();
  await Promise.all(bounds.map(async ([i, start, end]) => {
    const part = path.join(segmentsDir, `seg-${i}`);
    const want = end - start + 1;
    for (let attempt = 0; ; attempt += 1) {
      const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (have > want) { fs.rmSync(part); continue; }
      if (have === want) return; // 该段已齐
      if (Date.now() - urlAt > 480_000 || attempt > 0) {
        url = resolveSignedUrl(art.id); // SAS 老化/段失败 → 重解析(代际字节确定,可续)
        urlAt = Date.now();
      }
      const s = start + have;
      try {
        await curlRange(url, s, end, have ? `${part}.inc` : part);
        if (have) {
          fs.appendFileSync(part, fs.readFileSync(`${part}.inc`));
          fs.rmSync(`${part}.inc`);
        }
        if (fs.statSync(part).size === want) return;
      } catch (e) {
        if (have && fs.existsSync(`${part}.inc`)) {
          fs.appendFileSync(part, fs.readFileSync(`${part}.inc`));
          fs.rmSync(`${part}.inc`);
        }
        if (attempt >= 6) throw new Error(`段 ${i} 重试 7 次仍失败:${e.message}`);
      }
    }
  }));
  // 拼装机
  const fd = fs.openSync(destZip, 'w');
  try {
    for (const [i] of bounds) fs.writeSync(fd, fs.readFileSync(path.join(segmentsDir, `seg-${i}`)));
  } finally { fs.closeSync(fd); }
  fs.rmSync(segmentsDir, { recursive: true, force: true });
  if (fs.statSync(destZip).size !== total) die(`${art.name} 拼装后大小不符:${fs.statSync(destZip).size} ≠ ${total}`);
}

function downloadArtifact(art, destZip) {
  // 断点续传陷阱:存在≠完整(上次被杀留下半截)。unzip -t 验不过就删了重下。
  if (fs.existsSync(destZip) && fs.statSync(destZip).size > 0 && zipIntact(destZip)) {
    log(`  已存在且完整,跳过下载:${path.basename(destZip)}`);
    return Promise.resolve();
  }
  if (fs.existsSync(destZip)) {
    log(`  存在但 zip 不完整(上次中断),删了重下:${path.basename(destZip)}`);
    fs.rmSync(destZip);
  }
  const segmentsDir = `${destZip}.segs`;
  fs.rmSync(segmentsDir, { recursive: true, force: true });
  fs.mkdirSync(segmentsDir, { recursive: true });
  const t0 = Date.now();
  log(`  开始下载 ${art.name} (${(art.size_in_bytes / 1048576).toFixed(0)}MB,${SEGMENTS} 段并行)→ ${path.basename(destZip)}`);
  const signedUrl = resolveSignedUrl(art.id);
  return downloadSegmented(art, signedUrl, destZip, segmentsDir).then(() => {
    const mb = fs.statSync(destZip).size / 1048576;
    log(`  ✓ ${art.name} ${mb.toFixed(0)}MB in ${((Date.now() - t0) / 1000).toFixed(0)}s (${(mb / ((Date.now() - t0) / 1000)).toFixed(1)}MB/s)`);
  });
}

// ── 清单生成(形状 = 线上 live 0.3.11 实证版,electron-updater generic provider)──
function yamlFileEntry(u, sha, size, blockMapSize) {
  const lines = [`  - url: ${u}`, `    sha512: '${sha}'`, `    size: ${size}`];
  if (blockMapSize != null) lines.push(`    blockMapSize: ${blockMapSize}`);
  return lines.join('\n');
}
function writeManifests(wd, v, files) {
  // latest-mac.yml:files = arm64 zip → x64 zip → arm64 dmg → x64 dmg(与 live 一致)
  const mac = files;
  const macYml = [
    `version: ${v}`,
    'files:',
    yamlFileEntry(`v${v}/${mac.arm64Zip.name}`, mac.arm64Zip.sha512, mac.arm64Zip.size, mac.arm64Zip.blockMapSize),
    yamlFileEntry(`v${v}/${mac.x64Zip.name}`, mac.x64Zip.sha512, mac.x64Zip.size, mac.x64Zip.blockMapSize),
    yamlFileEntry(`v${v}/${mac.arm64Dmg.name}`, mac.arm64Dmg.sha512, mac.arm64Dmg.size),
    yamlFileEntry(`v${v}/${mac.x64Dmg.name}`, mac.x64Dmg.sha512, mac.x64Dmg.size),
    `path: v${v}/${mac.arm64Zip.name}`,
    `sha512: '${mac.arm64Zip.sha512}'`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(wd, 'latest-mac.yml'), macYml);
  const winYml = [
    `version: ${v}`,
    'files:',
    yamlFileEntry(`v${v}/${files.winExe.name}`, files.winExe.sha512, files.winExe.size, files.winExe.blockMapSize),
    `path: v${v}/${files.winExe.name}`,
    `sha512: '${files.winExe.sha512}'`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(wd, 'latest.yml'), winYml);
}

function statBMS(fileOrNull) {
  return fileOrNull && fs.existsSync(fileOrNull) ? fs.statSync(fileOrNull).size : null;
}

function globOne(dir, re) {
  const hit = fs.readdirSync(dir).filter((f) => re.test(f));
  if (hit.length !== 1) die(`工件目录 ${dir} 内匹配 ${re} 的文件数=${hit.length}(期望 1):${hit.join(', ')}`);
  return path.join(dir, hit[0]);
}

// ── 主流程:一次发布 ─────────────────────────────────────────────
async function publishOne(runId, watchNotes, force) {
  log(`═══ 发布 run ${runId} ${DRY_RUN ? '(dry-run,不上传)' : ''} ═══`);
  const run = ghJson(`actions/runs/${runId}`);
  // 常规只放 green build;--force 例外(handoff 腿时代构建全绿但 run conclusion
  // 含已死的 handoff=failure,抢救历史 run 用,须人工确认工件齐全;watch 模式
  // 传 force 但已由 runHasDesktopBuildJobs 在 job 级把过构建腿)
  if (run.conclusion !== 'success' && !force) die(`run ${runId} conclusion=${run.conclusion},只发布 green build(抢救加 --force)`);
  const arts = ghJson(`actions/runs/${runId}/artifacts?per_page=30`).artifacts;
  const pick = (name) => {
    const a = arts.find((x) => x.name === name);
    if (!a) die(`工件缺失:${name}(本次产物 ${arts.map((x) => x.name).join(', ')})`);
    return a;
  };
  const artArm = pick('mac-arm64'), artX64 = pick('mac-x64'), artWin = pick('win-exe');
  const artCastA = pick('appcast-arm64'), artCastX = pick('appcast-x64');

  // 版本号从 arm64 dmg 工件名解析(单一事实源,避免参数漂移)
  const wd = path.join('/tmp', `hmd-local-release-${runId}`);
  fs.mkdirSync(wd, { recursive: true });
  const dirArm = path.join(wd, 'mac-arm64'), dirX64 = path.join(wd, 'mac-x64'),
    dirWin = path.join(wd, 'win-exe'), dirCastA = path.join(wd, 'appcast-arm64'), dirCastX = path.join(wd, 'appcast-x64');
  for (const d of [dirArm, dirX64, dirWin, dirCastA, dirCastX]) fs.mkdirSync(d, { recursive: true });

  await Promise.all([
    downloadArtifact(artArm, path.join(wd, 'mac-arm64.zip')),
    downloadArtifact(artX64, path.join(wd, 'mac-x64.zip')),
    downloadArtifact(artWin, path.join(wd, 'win-exe.zip')),
    downloadArtifact(artCastA, path.join(wd, 'appcast-arm64.zip')),
    downloadArtifact(artCastX, path.join(wd, 'appcast-x64.zip')),
  ]);
  for (const [zip, dir] of [[path.join(wd, 'mac-arm64.zip'), dirArm], [path.join(wd, 'mac-x64.zip'), dirX64],
    [path.join(wd, 'win-exe.zip'), dirWin], [path.join(wd, 'appcast-arm64.zip'), dirCastA],
    [path.join(wd, 'appcast-x64.zip'), dirCastX]]) {
    sh('unzip', ['-o', '-q', zip, '-d', dir]);
  }

  const v = (() => {
    const m = path.basename(globOne(dirArm, /\.dmg$/)).match(/-(\d+\.\d+\.\d+)-?/);
    return m ? m[1] : die('从 dmg 文件名解析版本失败');
  })();

  const files = {
    arm64Dmg: { path: globOne(dirArm, /-arm64\.dmg$/) },
    arm64Zip: { path: globOne(dirArm, /-mac-arm64\.zip$/) },
    arm64ZipBM: globOne(dirArm, /-mac-arm64\.zip\.blockmap$/),
    x64Dmg: { path: globOne(dirX64, /-x64\.dmg$/) },
    x64Zip: { path: globOne(dirX64, /-mac-x64\.zip$/) },
    x64ZipBM: globOne(dirX64, /-mac-x64\.zip\.blockmap$/),
    winExe: { path: globOne(dirWin, /\.exe$/) },
    winExeBM: globOne(dirWin, /\.exe\.blockmap$/),
  };
  for (const key of ['arm64Dmg', 'arm64Zip', 'x64Dmg', 'x64Zip', 'winExe']) {
    const f = files[key];
    f.name = path.basename(f.path);
    f.size = fs.statSync(f.path).size;
    f.sha256 = sha256Hex(f.path);
    f.sha512 = sha512B64(f.path);
  }
  files.arm64Zip.blockMapSize = statBMS(files.arm64ZipBM);
  files.x64Zip.blockMapSize = statBMS(files.x64ZipBM);
  files.winExe.blockMapSize = statBMS(files.winExeBM);
  writeManifests(wd, v, files);
  log(`✓ 清单生成 latest.yml/latest-mac.yml(version=${v})`);
  log(`  arm64 dmg ${(files.arm64Dmg.size / 1048576).toFixed(0)}MB sha256=${files.arm64Dmg.sha256.slice(0, 12)}…`);
  log(`  x64   dmg ${(files.x64Dmg.size / 1048576).toFixed(0)}MB sha256=${files.x64Dmg.sha256.slice(0, 12)}…`);
  log(`  win   exe ${(files.winExe.size / 1048576).toFixed(0)}MB sha256=${files.winExe.sha256.slice(0, 12)}…`);

  if (DRY_RUN) {
    log('dry-run:止步上传。清单与哈希已落 ' + wd);
    return { version: v, workdir: wd, files };
  }

  // ── 上传(qiniu-desktop-release.mjs:退出 2=已发布但降级,可接受;1=硬失败)──
  const castA = globOne(dirCastA, /^appcast-.*\.xml$/), castX = globOne(dirCastX, /^appcast-.*\.xml$/);
  const args = [
    path.join(SCRIPT_DIR, 'qiniu-desktop-release.mjs'),
    '--version', v,
    '--mac-file', files.arm64Dmg.path,
    '--mac-x64-file', files.x64Dmg.path,
    '--win-file', files.winExe.path,
    '--mac-sha256', files.arm64Dmg.sha256,
    '--mac-x64-sha256', files.x64Dmg.sha256,
    '--win-sha256', files.winExe.sha256,
    '--extra-file', files.arm64Zip.path,
    '--extra-file', files.x64Zip.path,
    '--extra-file', files.arm64ZipBM,
    '--extra-file', files.x64ZipBM,
    '--extra-file', files.winExeBM,
    '--root-file', path.join(wd, 'latest.yml'),
    '--root-file', path.join(wd, 'latest-mac.yml'),
    '--root-file', castA,
    '--root-file', castX,
    '--bucket', 'hiredchina-npm-mirror',
    '--key-prefix', KEY_PREFIX,
    '--keep', '5',
    '--base-url', CDN_BASE,
    '--notes', watchNotes || NOTES || `v${v}`,
  ];
  const up = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (up.status === 1) die('七牛上传硬失败(见上方日志)');
  if (up.status === 2) log('⚠ 上传完成但有降级(IAM 无 list/fusion 权限,旧版清理/CDN 刷新跳过——已知,不阻断)');

  // ── 效应端读回(hard-rule 32:断言成功必须读回,不看退出码)─────────────────
  readback(v, files);
  log(`✅ v${v} 发布完成并已读回验证`);
  // 成功即清工件(每版本 ~3.4GB,/tmp 不养闲人);失败保留现场供排查
  fs.rmSync(wd, { recursive: true, force: true });
  log(`  工件已清理:${wd}`);
  return { version: v, workdir: wd, files };
}

function readback(v, files) {
  const bust = `?_=${Date.now()}`;
  const cdn = JSON.parse(sh('curl', ['-fsS', '--max-time', '30', `${CDN_BASE}/${KEY_PREFIX}/latest.json${bust}`]));
  if (cdn.version !== v) die(`CDN latest.json 版本=${cdn.version} ≠ ${v}(上传未生效?)`);
  const api = JSON.parse(sh('curl', ['-fsS', '--max-time', '30', DEVOPS_API]));
  if (api.version !== v) die(`dev-ops API 版本=${api.version} ≠ ${v}`);
  log(`✓ 读回:CDN latest.json + dev-ops API 均为 v${v}`);
  // 二进制首 4MB range 拉与本地逐字节一致(防清单对、包错/半同步)
  const RANGE = 4 * 1024 * 1024;
  for (const [key, f] of [['mac arm64 dmg', files.arm64Dmg], ['mac x64 dmg', files.x64Dmg], ['win exe', files.winExe]]) {
    const url = `${CDN_BASE}/${KEY_PREFIX}/v${v}/${encodeURIComponent(f.name)}`;
    const remote = shRaw('curl', ['-fsS', '--max-time', '60', '-r', `0-${RANGE - 1}`, url]);
    const fd = fs.openSync(f.path, 'r');
    const local = Buffer.alloc(RANGE);
    const n = fs.readSync(fd, local, 0, RANGE, 0);
    fs.closeSync(fd);
    const localHead = local.subarray(0, n);
    if (remote.length !== localHead.length || !remote.equals(localHead)) {
      die(`${key} 首 ${RANGE / 1048576}MB CDN 与本地逐字节不一致(半同步/错包!)`);
    }
    log(`✓ 读回:${key} 首 ${RANGE / 1048576}MB 逐字节一致`);
  }
}

// ── watch 模式:轮询新 green build,自动发布(可重入:状态文件记已处理 run)──
function loadState() {
  try { return JSON.parse(fs.readFileSync(WATCH_STATE, 'utf8')); } catch { return { handled: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(WATCH_STATE), { recursive: true });
  fs.writeFileSync(WATCH_STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function liveVersion() {
  try {
    return JSON.parse(sh('curl', ['-fsS', '--max-time', '15', `${CDN_BASE}/${KEY_PREFIX}/latest.json?_=${Date.now()}`])).version;
  } catch { return null; }
}

// desktop-build 无独立 run(workflow_call 归入 router run,工件也挂在 router run 下),
// 只能靠 job 名识别;旧 handoff 时代的成功构建 run conclusion=failure(含已死 handoff),
// 故只看构建腿 job 成败 + 工件齐全 + 版本未在线,三重护栏,不依赖 run conclusion。
function runHasDesktopBuildJobs(runId) {
  const jobs = ghJson(`actions/runs/${runId}/jobs?per_page=50`).jobs;
  // job 名带 "desktop-build / " 前缀(workflow_call 归属),匹配核心名即可
  const legs = jobs.filter((j) => /mac dmg\+zip|win nsis/.test(j.name));
  if (legs.length === 0) return null; // 非 desktop-build 触发的 router run
  const ok = legs.filter((j) => j.conclusion === 'success').length;
  return { legs: legs.length, ok };
}

async function watch() {
  loadKeys();
  log(`watch 模式启动:每 ${WATCH_INTERVAL_S}s 扫一次 ${REPO} router runs(desktop-build job 识别)`);
  for (;;) {
    try {
      const state = loadState();
      const due = (r) => {
        const h = state.handled[r.id];
        if (!h) return true;                       // 未处理
        if (!h.retryAfterMs) return false;         // 已处理/跳过/已发布,不再碰
        return Date.now() - new Date(h.failedAt).getTime() >= h.retryAfterMs; // 冷却到点
      };
      const runs = ghJson('actions/runs?per_page=10').workflow_runs.filter((r) => due(r));
      for (const r of runs) {
        const legs = runHasDesktopBuildJobs(r.id);
        if (!legs) { state.handled[r.id] = { skipped: 'non-desktop' }; saveState(state); continue; }
        if (legs.ok !== legs.legs) continue;         // 构建腿未全绿,等 release-watch 重试救活
        const live = liveVersion();
        try {
          const res = await publishOne(r.id, '', true);
          if (res.version === live) {
            log(`run ${r.id} → v${res.version} 已在线,标记处理(幂等)`);
            state.handled[r.id] = { version: res.version, alreadyLive: true };
          } else {
            state.handled[r.id] = { version: res.version, publishedAt: new Date().toISOString() };
          }
        } catch (e) {
          log(`❌ run ${r.id} 自动发布失败:${e.message}(冷却 30min 后重试)`);
          state.handled[r.id] = { failedAt: new Date().toISOString(), retryAfterMs: 30 * 60 * 1000 };
        }
        saveState(state);
      }
      if (runs.length === 0) saveState(state);
    } catch (e) {
      log(`⚠ 本轮扫描异常(下轮继续):${e.message}`);
    }
    // 清理:只保留最近 20 条 handled 记录,防无限膨胀
    const st = loadState();
    const keys = Object.keys(st.handled);
    if (keys.length > 20) {
      for (const k of keys.slice(0, keys.length - 20)) delete st.handled[k];
      saveState(st);
    }
    execFileSync('sleep', [String(WATCH_INTERVAL_S)]);
  }
}

// ── 入口 ──────────────────────────────────────────────────────
if (WATCH) {
  watch().catch((e) => die(`watch 模式致命异常:${e.message}`));
} else {
  if (!RUN_ID) die('--run <run-id> 或 --watch 二选一');
  loadKeys();
  publishOne(RUN_ID, '', FORCE).catch((e) => die(e.message));
}
