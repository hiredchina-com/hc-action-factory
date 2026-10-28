#!/usr/bin/env node
// qiniu-desktop-release.mjs — HunterMate 桌面安装包发布到七牛 CDN
//
// 用途:dev-ops 公开下载页(/downloads)的清单源。与 qiniu-release-mirror.mjs
// 同签名约定,但上传物是本地构建产物(dmg/exe)而非 npm tgz:
//   1. 上传 v<version>/HunterMate-*.{dmg,exe}(sha256 清单由 pipeline 侧算好传参)
//   2. 写并上传 latest.json = {version, publishedAt, notes, assets:{mac,win}}
//   3. 列出现有 v*/ 主包,semver 降序,删除超出 --keep 的旧版本目录
//   4. CDN 刷新 latest.json(fusion;失败 exit 2 打 warning 不阻断)
//
// 退出码:0 全绿;2 有降级;1 硬失败(任一上传失败)。
//
// 用法:
//   node scripts/qiniu-desktop-release.mjs \
//     --version 0.1.0 --mac-file dist/HunterMate-0.1.0-arm64.dmg \
//     --win-file "dist/HunterMate Setup 0.1.0.exe" \
//     --bucket hiredchina-npm-mirror --key-prefix packages/huntermate-desktop-releases \
//     --keep 5 --base-url https://npm.hiredchina.com \
//     --mac-sha256 <hex> --win-sha256 <hex> [--notes "…"]
//
// 环境变量(工厂仓 GitHub Secrets):QINIU_ACCESS_KEY / QINIU_SECRET_KEY
// FID-121 教训:runner→七牛上传域间歇被封,走 curl + up 主机 fallback 链。
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const VERSION = arg('version', '');
const MAC_FILE = arg('mac-file', '');
const WIN_FILE = arg('win-file', '');
const MAC_SHA = arg('mac-sha256', '');
const WIN_SHA = arg('win-sha256', '');
const NOTES = arg('notes', '');
const BUCKET = arg('bucket', 'hiredchina-npm-mirror');
const KEY_PREFIX = arg('key-prefix', 'packages/huntermate-desktop-releases').replace(/\/+$/, '');
const KEEP = Math.max(1, parseInt(arg('keep', '5'), 10) || 5);
const BASE_URL = arg('base-url', 'https://npm.hiredchina.com').replace(/\/+$/, '');
const UPLOAD_HOSTS = ['up-z2.qiniup.com', 'up-z0.qiniup.com', 'up.qiniup.com'];

const AK = process.env.QINIU_ACCESS_KEY || '';
const SK = process.env.QINIU_SECRET_KEY || '';
if (!AK || !SK) { console.error('✗ QINIU_ACCESS_KEY/QINIU_SECRET_KEY 未设置'); process.exit(1); }
if (!VERSION) { console.error('✗ --version 必填'); process.exit(1); }
if (!MAC_FILE && !WIN_FILE) { console.error('✗ --mac-file/--win-file 至少其一'); process.exit(1); }

// qiniu base64url 规范:无 padding;v2 分片 API 对 token 第三段严格解码,留 = 即
// 400 illegal base64(2026-10-25 v0.1.5 实证);form 上传容忍但一并按规范剥离
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\//g, '_').replace(/\+/g, '-').replace(/=+$/, '');
const hmac = (data) => createHmac('sha1', SK).update(data).digest();

function qboxSign(method, pathAndQuery, host, headers = {}, body = '') {
  let s = `${method.toUpperCase()} ${pathAndQuery}\nHost: ${host}\n`;
  const ct = headers['content-type'];
  if (ct) s += `Content-Type: ${ct}\n`;
  s += '\n';
  if (body && ct) s += body;
  return `QBox ${AK}:${b64u(hmac(s))}`;
}

function uploadToken(key) {
  const policy = JSON.stringify({ scope: `${BUCKET}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600, insertOnly: 0 });
  const encoded = b64u(policy);
  return `${AK}:${b64u(hmac(encoded))}:${encoded}`;
}

// FID-137 续:封禁窗口内握手可通但单连接被节流到 <0.35MB/s,314MB dmg 单次 POST 永无可能在
// 900s 内跑完(v0.1.5 实证:窗口开放期连探 3h 无一次成功)。改七牛分片上传 v2:
// initParts → 每片独立 PUT(失败按主机轮换,吃满抖动窗口)→ completeParts;
// 单片的重试粒度把"整文件一次押注"拆成几十次小押注,任一片超时不再拖死整文件。
const PART_SIZE = 8 * 1024 * 1024;
const PART_MAX_TIME = '300';
const PART_TIMEOUT = 330_000;

function upCurl(host, args, opts = {}) {
  const tmp = path.join(os.tmpdir(), `qiniu-res-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const maxTime = opts.maxTime || PART_MAX_TIME;
  const hardTimeout = opts.timeout || PART_TIMEOUT;
  try {
    // 诊断优先:失败必须看到 HTTP 状态码+响应体(-f 会吞掉 4xx body,故用 -w 取码)
    const code = execFileSync('curl', ['-sS', '--max-time', maxTime, '-o', tmp, '-w', '%{http_code}', ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: hardTimeout,
    }).trim();
    const body = fs.readFileSync(tmp, 'utf8');
    if (!code.startsWith('2')) throw new Error(`HTTP ${code}: ${body.slice(0, 300) || '<空>'}`);
    return body;
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function withRetry(label, fn, attempts = 5) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      console.log(`⚠ ${label} 第 ${i}/${attempts} 次失败: ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last;
}

/** 单连接 form 上传(保底路径):v0.1.4/0.1.5 实证可用的最后手段;FID-137 节流下靠
 *  长超时 + 跨主机轮询赌快窗,慢但必达(<=314MB 实证;0.2.0 起 dmg ~650MB 超出
 *  节流下单连接 900s 押注上限,优先走 v1 分块)。maxTime 提到 5400s 兜底。 */
async function uploadFileMonolithic(key, filePath) {
  let last = null;
  for (const host of UPLOAD_HOSTS) {
    try {
      return await withRetry(`upload ${key}@${host}`, async () => {
        const out = upCurl(host, [
          '-X', 'POST', `https://${host}`,
          '-F', `token=${uploadToken(key)}`,
          '-F', `key=${key}`,
          '-F', `file=@${filePath}`,
        ], { maxTime: '5400', timeout: 5_460_000 }).trim();
        return JSON.parse(out);
      }, 2);
    } catch (e) { last = e; console.log(`✗ ${host} 上传失败: ${e.message}`); }
  }
  throw last;
}

/** v1 分块上传(mkblk/mkfile):与 form 上传同套 UpToken 认证(FID-137 实证 form 认证
 *  可用,而分片 v2 init 对该 bucket 恒 401 原因未查明)——绕开 v2 认证坑,兼得
 *  分块重试粒度。块 4MB(mkblk 单 POST 上限),多连接并行(节流按单连接计,
 *  QINIU_BLOCK_CONCURRENCY 默认 6,聚合 ~2MB/s 时 650MB ≈ 6min),块 ctx 全部落齐后
 *  mkfile 一次组装。任一 4MB 块失败只重传该块,不拖死整文件。 */
const BLOCK_SIZE = 4 * 1024 * 1024;
const BLOCK_CONCURRENCY = Math.max(1, parseInt(process.env.QINIU_BLOCK_CONCURRENCY || '6', 10) || 6);
const BLOCK_PART_MAX_TIME = '300';
const BLOCK_PART_TIMEOUT = 330_000;

async function uploadFileV1Blocks(key, filePath) {
  const token = uploadToken(key);
  const size = fs.statSync(filePath).size;
  const totalBlocks = Math.max(1, Math.ceil(size / BLOCK_SIZE));
  const ctxs = new Array(totalBlocks).fill(null);
  const fd = fs.openSync(filePath, 'r');
  const b64Key = b64u(Buffer.from(key, 'utf8'));
  try {
    for (let round = 1; round <= 3 && ctxs.some((c) => !c); round++) {
      let progressed = false;
      for (const host of UPLOAD_HOSTS) {
        try {
          let next = 0;
          const worker = async () => {
            for (;;) {
              const idx = next++;
              if (idx >= totalBlocks) return;
              if (ctxs[idx]) continue;
              const off = idx * BLOCK_SIZE;
              const len = Math.min(BLOCK_SIZE, size - off);
              const buf = Buffer.alloc(len);
              fs.readSync(fd, buf, 0, len, off);
              const tmp = path.join(os.tmpdir(), `qiniu-blk-${process.pid}-${idx}`);
              fs.writeFileSync(tmp, buf);
              try {
                const out = upCurl(host, [
                  '-X', 'POST', `https://${host}/mkblk/${len}`,
                  '-H', `Authorization: UpToken ${token}`,
                  '-H', 'Content-Type: application/octet-stream',
                  '--data-binary', `@${tmp}`,
                ], { maxTime: BLOCK_PART_MAX_TIME, timeout: BLOCK_PART_TIMEOUT });
                ctxs[idx] = JSON.parse(out).ctx;
                progressed = true;
                if ((idx + 1) % 10 === 0 || idx + 1 === totalBlocks) console.log(`✓ blk ${idx + 1}/${totalBlocks}`);
              } catch (e) {
                console.log(`⚠ blk ${idx + 1}/${totalBlocks}@${host}: ${e.message}`);
              } finally { fs.rmSync(tmp, { force: true }); }
            }
          };
          await Promise.all(Array.from({ length: Math.min(BLOCK_CONCURRENCY, totalBlocks) }, worker));
          if (ctxs.every(Boolean)) {
            const done = upCurl(host, [
              '-X', 'POST', `https://${host}/mkfile/${size}/key/${b64Key}`,
              '-H', `Authorization: UpToken ${token}`,
              '-H', 'Content-Type: text/plain',
              '--data-binary', ctxs.join(','),
            ], { maxTime: '120', timeout: 130_000 });
            return JSON.parse(done);
          }
        } catch (e) { console.log(`⚠ ${host} v1 round ${round}: ${e.message}`); }
        if (ctxs.every(Boolean)) break;
      }
      if (!progressed) console.log(`⚠ v1 round ${round} 无进展,退避后重试`);
      if (round < 3) await new Promise((r) => setTimeout(r, Math.min(60_000, 5000 * round)));
    }
    throw new Error(`v1 分块 3 轮仍未完成(${ctxs.filter(Boolean).length}/${totalBlocks} 块)`);
  } finally { fs.closeSync(fd); }
}

async function uploadFile(key, filePath) {
  try {
    return await uploadFileMultipart(key, filePath);
  } catch (e) {
    console.log(`⚠ 分片 v2 不可用(${e.message}),改 v1 分块(mkblk/mkfile)`);
  }
  try {
    return await uploadFileV1Blocks(key, filePath);
  } catch (e) {
    console.log(`⚠ v1 分块失败(${e.message}),回退单连接 form 上传(慢但保底)`);
    return uploadFileMonolithic(key, filePath);
  }
}

async function uploadFileMultipart(key, filePath) {
  const MULTI_PART_ROUNDS = 2;
  const token = uploadToken(key);
  const size = fs.statSync(filePath).size;
  // 对象名编码两种候选(qiniu 文档/SDK 版本间不一致,社区实证并存):
  //   A) encodeURIComponent   B) URLSafeBase64(key)
  // 每轮按序试,任一 init 成功即锁定;一次运行内自适应收敛。
  const encCandidates = [
    encodeURIComponent(key),
    b64u(Buffer.from(key, 'utf8')),
  ];
  let encIdx = 0;
  const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
  const etags = new Array(totalParts).fill(null);
  let uploadId = null;
  const fd = fs.openSync(filePath, 'r');
  try {
    // 多轮×多主机:同一 uploadId 跨主机续传(片已落服务器的跳过),吃满封禁抖动窗口
    for (let round = 1; round <= MULTI_PART_ROUNDS; round++) {
      let progressed = false;
      for (const host of UPLOAD_HOSTS) {
        // 编码锁定(uploadId 已建)→ 只用锁定值;未锁定 → 逐候选试 init
        const eiList = uploadId ? [encIdx] : encCandidates.map((_, i) => i);
        for (const ei of eiList) {
          const encKey = encCandidates[ei];
          const base = `https://${host}/buckets/${BUCKET}/objects/${encKey}/uploads`;
          try {
            if (!uploadId) {
              uploadId = JSON.parse(upCurl(host, ['-X', 'POST', base, '-H', `Authorization: UpToken ${token}`])).uploadId;
              encIdx = ei;
              console.log(`✓ init uploadId=${uploadId.slice(0, 12)}…(${totalParts} 片, 编码=${ei === 0 ? 'urlenc' : 'b64'})`);
            }
            for (let part = 1; part <= totalParts; part++) {
            if (etags[part - 1]) continue;
            const buf = Buffer.alloc(Math.min(PART_SIZE, size - (part - 1) * PART_SIZE));
            fs.readSync(fd, buf, 0, buf.length, (part - 1) * PART_SIZE);
            const tmp = path.join(os.tmpdir(), `qiniu-part-${process.pid}-${part}`);
            fs.writeFileSync(tmp, buf);
            try {
              const etag = upCurl(host, [
                '-X', 'PUT', `${base}/${uploadId}/${part}`,
                '-H', `Authorization: UpToken ${token}`,
                '-H', 'Content-Type: application/octet-stream',
                '--data-binary', `@${tmp}`,
              ]);
              etags[part - 1] = JSON.parse(etag).etag;
              progressed = true;
              if (part % 5 === 0 || part === totalParts) console.log(`✓ part ${part}/${totalParts}`);
            } catch (e) {
              console.log(`⚠ part ${part}/${totalParts}@${host}: ${e.message}`);
            } finally { fs.rmSync(tmp, { force: true }); }
          }
          if (etags.every(Boolean)) {
            const body = JSON.stringify({ parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })) });
            const done = upCurl(host, [
              '-X', 'POST', `${base}/${uploadId}/complete`,
              '-H', `Authorization: UpToken ${token}`,
              '-H', 'Content-Type: application/json',
              '--data', body,
            ]);
            return JSON.parse(done);
          }
        } catch (e) { console.log(`⚠ ${host} round ${round}: ${e.message}`); }
        }
      }
      if (!progressed) console.log(`⚠ round ${round} 无进展,退避后重试`);
      if (round < MULTI_PART_ROUNDS) await new Promise((r) => setTimeout(r, Math.min(60_000, 5000 * round)));
    }
    throw new Error(`分片上传 ${MULTI_PART_ROUNDS} 轮仍未完成(${etags.filter(Boolean).length}/${totalParts} 片)`);
  } finally { fs.closeSync(fd); }
}

/** QBox 管理接口:列目录 */
function qboxList(prefix) {
  const pathAndQuery = `/list?bucket=${BUCKET}&prefix=${encodeURIComponent(prefix)}&limit=200`;
  const auth = qboxSign('POST', pathAndQuery, 'rs.qiniu.com', { 'content-type': 'application/x-www-form-urlencoded' });
  const out = execFileSync('curl', ['-fsS', '--max-time', '30', '-X', 'POST', `https://rs.qiniu.com${pathAndQuery}`,
    '-H', `Authorization: ${auth}`, '-H', 'Content-Type: application/x-www-form-urlencoded'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

/** QBox 管理接口:删文件 */
function qboxDelete(key) {
  const auth = qboxSign('POST', '/batch', 'rs.qiniu.com', { 'content-type': 'application/x-www-form-urlencoded' }, `op=/remove/${BUCKET}:${key}`);
  execFileSync('curl', ['-fsS', '--max-time', '30', '-X', 'POST', 'https://rs.qiniu.com/batch',
    '-H', `Authorization: ${auth}`, '-H', 'Content-Type: application/x-www-form-urlencoded',
    '--data', `op=/remove/${BUCKET}:${key}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fusionRefresh(urls) {
  const body = JSON.stringify({ urls: urls.map((u) => `${BASE_URL}/${u}`) });
  const host = 'fusion.qiniuapi.com';
  const auth = qboxSign('POST', '/v2/tune/refresh', host, { 'content-type': 'application/json' }, body);
  execFileSync('curl', ['-fsS', '--max-time', '30', '-X', 'POST', `https://${host}/v2/tune/refresh`,
    '-H', `Authorization: ${auth}`, '-H', 'Content-Type: application/json', '--data', body],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function semverDesc(a, b) {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---------- main ----------
(async () => {
  const publishedAt = new Date().toISOString();
  const versionDir = `v${VERSION}`;
  const assets = {};

  const uploads = [];
  if (MAC_FILE) {
    if (!fs.existsSync(MAC_FILE)) { console.error(`✗ mac 安装包不存在: ${MAC_FILE}`); process.exit(1); }
    uploads.push(['mac', MAC_FILE, path.basename(MAC_FILE), MAC_SHA]);
  }
  if (WIN_FILE) {
    if (!fs.existsSync(WIN_FILE)) { console.error(`✗ win 安装包不存在: ${WIN_FILE}`); process.exit(1); }
    uploads.push(['win', WIN_FILE, path.basename(WIN_FILE), WIN_SHA]);
  }

  for (const [kind, file, name, sha] of uploads) {
    const key = `${KEY_PREFIX}/${versionDir}/${name}`;
    await withRetry(`upload ${key}`, () => uploadFile(key, file));
    assets[kind] = {
      url: `${BASE_URL}/${key}`,
      sha256: sha,
      size: fs.statSync(file).size,
    };
    console.log(`✓ 上传 ${key}(${assets[kind].size} 字节)`);
  }

  const latest = { version: VERSION, publishedAt, notes: NOTES || undefined, assets };
  const latestKey = `${KEY_PREFIX}/latest.json`;
  const tmp = path.join(os.tmpdir(), `hmd-latest-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(latest, null, 2));
  await withRetry(`upload ${latestKey}`, () => uploadFile(latestKey, tmp));
  console.log(`✓ 上传 ${latestKey}`);

  // 清理旧版本目录(best-effort:AK/SK 无管理权限时 401 降级 exit 2)
  let degraded = false;
  try {
    const listed = qboxList(`${KEY_PREFIX}/`);
    const versions = [...new Set((listed.items || []).map((it) => {
      const m = it.key.slice(KEY_PREFIX.length + 1).match(/^(v[^/]+)\//);
      return m?.[1];
    }).filter(Boolean))].sort(semverDesc);
    for (const old of versions.slice(KEEP)) {
      for (const it of (qboxList(`${KEY_PREFIX}/${old}/`).items || [])) {
        qboxDelete(it.key);
        console.log(`✓ 清理旧版本 ${it.key}`);
      }
    }
  } catch (e) {
    console.log(`⚠ 旧版本清理降级(已知七牛 key 无管理权限 401 场景): ${e.message}`);
    degraded = true;
  }

  try { fusionRefresh([latestKey]); console.log('✓ CDN 刷新 latest.json'); }
  catch (e) { console.log(`⚠ fusion 刷新失败: ${e.message}`); degraded = true; }

  console.log(`✓ desktop release ${VERSION} 发布完成(${Object.keys(assets).join('+') || '无产物'})`);
  process.exit(degraded ? 2 : 0);
})().catch((e) => { console.error(`✗ 发布硬失败: ${e.message}`); process.exit(1); });
