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
        // FID-137:封禁窗口内带宽极低,314MB dmg 需要长超时;120s 上限是 v0.1.5 双平台
        // 构建全绿但发布连败的根因。管理接口(qbox/fusion)仍用 30s 短超时不受影响。
        const out = execFileSync('curl', [
          '-fsS', '--max-time', '900', '-X', 'POST', `https://${host}`,
          '-F', `token=${uploadToken(key)}`,
          '-F', `key=${key}`,
          '-F', `file=@${filePath}`,
        ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 960_000 }).trim();
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
