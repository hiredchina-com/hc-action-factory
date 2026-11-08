#!/usr/bin/env node
// qiniu-cu-release.mjs — hmd 电脑操控组件(computer-use)双组件发布到七牛 CDN
//
// hmd 侧契约(src/main/lib/computer-use.js fetchComponentLatest):
//   <cdnBase>/packages/cu-releases/<platformKey>/{plugin,driver}-latest.json
//     → { version, url, sha256 }
//   tarball 根 = 组件根(driver 含 cua-driver[.exe]/CuaDriver.app,plugin 为 JS 包)。
//
// 与 qiniu-hmh-release.mjs 同签名/同上传链(b64u 保留 padding,FID-137 定案),
// 但按 manifest 批量上传:每平台 2 tarball + 2 latest.json,共 4 平台。
//
// 退出码:0 全绿;2 有降级(清理/fusion 刷新无管理权限,发布本体已成功);1 硬失败。
// 用法:
//   node scripts/qiniu-cu-release.mjs \
//     --manifest /path/manifest.json \
//     --bucket hiredchina-npm-mirror --key-prefix packages/cu-releases \
//     --keep 3 --base-url https://npm.hiredchina.com
//
// manifest.json:
//   { "platforms": { "<platformKey>": {
//       "plugin": { "version": "0.3.2", "file": "/abs/plugin.tar.gz" },
//       "driver": { "version": "0.43.2", "file": "/abs/driver-darwin-x64.tar.gz" } } } }
import { createHmac, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const MANIFEST = arg('manifest', '');
const BUCKET = arg('bucket', 'hiredchina-npm-mirror');
const KEY_PREFIX = arg('key-prefix', 'packages/cu-releases').replace(/\/+$/, '');
const KEEP = Math.max(1, parseInt(arg('keep', '3'), 10) || 3);
const BASE_URL = arg('base-url', 'https://npm.hiredchina.com').replace(/\/+$/, '');
const UPLOAD_HOSTS = ['up-z2.qiniup.com', 'up-z0.qiniup.com', 'up.qiniup.com'];

const AK = process.env.QINIU_ACCESS_KEY || '';
const SK = process.env.QINIU_SECRET_KEY || '';
if (!AK || !SK) { console.error('✗ QINIU_ACCESS_KEY/QINIU_SECRET_KEY 未设置'); process.exit(1); }
if (!MANIFEST || !fs.existsSync(MANIFEST)) { console.error(`✗ --manifest 不存在: ${MANIFEST}`); process.exit(1); }

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

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------- main ----------
(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const platforms = manifest.platforms || {};
  const platformKeys = Object.keys(platforms);
  if (platformKeys.length === 0) { console.error('✗ manifest.platforms 为空'); process.exit(1); }

  const publishedAt = new Date().toISOString();
  const degradedReasons = [];
  const latestKeys = [];

  for (const pk of platformKeys) {
    for (const component of ['plugin', 'driver']) {
      const entry = platforms[pk][component];
      if (!entry || !entry.file || !fs.existsSync(entry.file)) {
        console.error(`✗ manifest 缺 ${pk}/${component}.file`); process.exit(1);
      }
      if (!/^\d+\.\d+\.\d+/.test(entry.version || '')) {
        console.error(`✗ ${pk}/${component}.version 非法: '${entry.version}'`); process.exit(1);
      }
      const versionDir = `v${entry.version}`;
      const name = `${component}-${entry.version}.tar.gz`;
      const key = `${KEY_PREFIX}/${pk}/${versionDir}/${name}`;

      await withRetry(`upload ${key}`, () => uploadFile(key, entry.file));
      console.log(`✓ 上传 ${key}(${fs.statSync(entry.file).size} 字节)`);

      // latest.json 契约(hmd computer-use.js fetchComponentLatest):version/url/sha256
      const latest = {
        version: entry.version,
        url: `${BASE_URL}/${key}`,
        sha256: sha256(entry.file),
        publishedAt,
        ...(entry.notes ? { notes: entry.notes } : {}),
      };
      const latestKey = `${KEY_PREFIX}/${pk}/${component}-latest.json`;
      const tmp = path.join(os.tmpdir(), `cu-latest-${pk}-${component}-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(latest, null, 2));
      await withRetry(`upload ${latestKey}`, () => uploadFile(latestKey, tmp));
      console.log(`✓ 上传 ${latestKey}`);
      latestKeys.push(latestKey);

      // 该平台该组件的旧版本清理(best-effort:无管理权限时 401 降级)
      try {
        const listed = qboxList(`${KEY_PREFIX}/${pk}/`);
        const versions = [...new Set((listed.items || []).map((it) => {
          const m = it.key.slice(`${KEY_PREFIX}/${pk}/`.length).match(/^(v[^/]+)\//);
          return m?.[1];
        }).filter(Boolean))].sort(semverDesc);
        for (const old of versions.slice(KEEP)) {
          for (const it of (qboxList(`${KEY_PREFIX}/${pk}/${old}/`).items || [])) {
            if (!it.key.includes(`/${component}-`)) continue;
            qboxDelete(it.key);
            console.log(`✓ 清理旧版本 ${it.key}`);
          }
        }
      } catch (e) {
        console.log(`⚠ ${pk}/${component} 旧版本清理降级(已知七牛 key 无管理权限 401 场景): ${e.message}`);
        degradedReasons.push(`${pk}/${component} 清理`);
      }
    }
  }

  try { fusionRefresh(latestKeys); console.log('✓ CDN 刷新 latest.json 集合'); }
  catch (e) { console.log(`⚠ fusion 刷新失败: ${e.message}`); degradedReasons.push('fusion 刷新'); }

  console.log(`✓ cu release 发布完成:${platformKeys.join(', ')}`);
  process.exit(degradedReasons.length ? 2 : 0);
})().catch((e) => { console.error(`✗ 发布硬失败: ${e.message}`); process.exit(1); });
