#!/usr/bin/env node
// qiniu-hmh-release.mjs — hunter-mate-harness(hmh)base 包发布到七牛 CDN
//
// hmd(huntermate-desktop)内置工作区三层物化的 base 层来源。与
// qiniu-desktop-release.mjs 同签名/同上传链(curl + up 主机 fallback,FID-121
// 教训内消化),但产物是单 tarball:
//   1. 上传 v<version>/hmh-<version>.tar.gz
//   2. 写并上传 latest.json = {version, url, sha256, publishedAt, notes?}
//      —— hmd 侧 src/main/lib/hmh-cdn.js 的 fetchLatest 契约字段:version/url/sha256
//   3. semver 降序清理超出 --keep 的旧 v*/ 目录
//   4. CDN 刷新 latest.json(失败 exit 2 打 warning 不阻断)
//
// 退出码:0 全绿;2 有降级;1 硬失败。
// 用法:
//   node scripts/qiniu-hmh-release.mjs \
//     --version 1.0.0 --file hmh-1.0.0.tar.gz --sha256 <hex> \
//     --bucket hiredchina-npm-mirror --key-prefix packages/hmh-releases \
//     --keep 10 --base-url https://npm.hiredchina.com [--notes "…"]
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
const FILE = arg('file', '');
const SHA = arg('sha256', '');
const NOTES = arg('notes', '');
const BUCKET = arg('bucket', 'hiredchina-npm-mirror');
const KEY_PREFIX = arg('key-prefix', 'packages/hmh-releases').replace(/\/+$/, '');
const KEEP = Math.max(1, parseInt(arg('keep', '10'), 10) || 10);
const BASE_URL = arg('base-url', 'https://npm.hiredchina.com').replace(/\/+$/, '');
const UPLOAD_HOSTS = ['up-z2.qiniup.com', 'up-z0.qiniup.com', 'up.qiniup.com'];

const AK = process.env.QINIU_ACCESS_KEY || '';
const SK = process.env.QINIU_SECRET_KEY || '';
if (!AK || !SK) { console.error('✗ QINIU_ACCESS_KEY/QINIU_SECRET_KEY 未设置'); process.exit(1); }
if (!VERSION) { console.error('✗ --version 必填'); process.exit(1); }
if (!FILE || !fs.existsSync(FILE)) { console.error(`✗ --file 不存在: ${FILE}`); process.exit(1); }
if (!/^[0-9a-f]{64}$/i.test(SHA)) { console.error('✗ --sha256 必须是 64 位 hex'); process.exit(1); }

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
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

async function uploadFile(key, filePath) {
  let last = null;
  for (const host of UPLOAD_HOSTS) {
    try {
      return await withRetry(`upload ${key}@${host}`, async () => {
        const out = execFileSync('curl', [
          '-fsS', '--max-time', '300', '-X', 'POST', `https://${host}`,
          '-F', `token=${uploadToken(key)}`,
          '-F', `key=${key}`,
          '-F', `file=@${filePath}`,
        ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 330_000 }).trim();
        return JSON.parse(out);
      }, 2);
    } catch (e) { last = e; console.log(`✗ ${host} 上传失败: ${e.message}`); }
  }
  throw last;
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
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
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
  const name = path.basename(FILE);
  const key = `${KEY_PREFIX}/${versionDir}/${name}`;

  await withRetry(`upload ${key}`, () => uploadFile(key, FILE));
  console.log(`✓ 上传 ${key}(${fs.statSync(FILE).size} 字节)`);

  // latest.json 契约(hmd hmh-cdn.js fetchLatest):version/url/sha256 三字段必备
  const latest = {
    version: VERSION,
    url: `${BASE_URL}/${key}`,
    sha256: SHA.toLowerCase(),
    publishedAt,
    ...(NOTES ? { notes: NOTES } : {}),
  };
  const latestKey = `${KEY_PREFIX}/latest.json`;
  const tmp = path.join(os.tmpdir(), `hmh-latest-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(latest, null, 2));
  await withRetry(`upload ${latestKey}`, () => uploadFile(latestKey, tmp));
  console.log(`✓ 上传 ${latestKey}`);

  // 清理旧版本目录(best-effort:无管理权限时 401 降级 exit 2)
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

  console.log(`✓ hmh release ${VERSION} 发布完成`);
  process.exit(degraded ? 2 : 0);
})().catch((e) => { console.error(`✗ 发布硬失败: ${e.message}`); process.exit(1); });
