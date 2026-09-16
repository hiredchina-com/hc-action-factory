#!/usr/bin/env node
// qiniu-release-mirror.mjs — 发布后把 npm 包 tgz 镜像到七牛 CDN(FID-102)
//
// 用途:CLI 自更新的 CDN 回退通道。hunter-mate CLI(updater.ts CDN_RELEASES_BASE)
// 在 npm registry 不可达时回退到这里读 latest.json + 下载 tgz。
//
// 行为:
//   1. npm pack <package_dir> 产出 <name>-<version>.tgz
//   2. 上传到 <bucket>:<key_prefix>/<tgz>
//   3. 写并上传 <key_prefix>/latest.json = {version, tgz, publishedAt}
//   4. 列出现有 *.tgz,semver 降序,删除超出 --keep 的旧版本
//   5. CDN 刷新 latest.json 与 tgz URL(覆盖旧缓存)
//
// 退出码:任何失败 exit 1(发布主流程里本步骤 continue-on-error,失败不阻断 release)。
//
// 用法:
//   node scripts/qiniu-release-mirror.mjs \
//     --dir packages/cli --version 0.1.15 \
//     --bucket hiredchina --key-prefix hunter-mate-releases \
//     --keep 5 --base-url https://image.hiredchina.com
//
// 环境变量(工厂仓 GitHub Secrets):
//   QINIU_ACCESS_KEY / QINIU_SECRET_KEY
//
// 签名约定(lessons:签名原文与实发头必须在同一处构造):
//   - upload token = ak:urlsafeBase64(HMAC-SHA1(sk, urlsafeB64(policy))):urlsafeB64(policy)
//   - QBox 管理接口 = Authorization: QBox ak:urlsafeB64(HMAC-SHA1(sk, signingStr))
//     signingStr = "{METHOD} {pathAndQuery}\nHost: {host}\n[Content-Type: {ct}\n]\n"
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- args ----------
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const PKG_DIR = arg('dir', 'packages/cli');
const VERSION = arg('version', '');
const BUCKET = arg('bucket', 'hiredchina');
const KEY_PREFIX = arg('key-prefix', 'hunter-mate-releases').replace(/\/+$/, '');
const KEEP = Math.max(1, parseInt(arg('keep', '5'), 10) || 5);
const BASE_URL = arg('base-url', 'https://image.hiredchina.com').replace(/\/+$/, '');
// 上传主机必须与 bucket 所在区域一致:hiredchina/hcweb-temp-file 都在 z2(华南),默认 up-z2
const UPLOAD_HOST = arg('upload-host', 'up-z2.qiniup.com');

const AK = process.env.QINIU_ACCESS_KEY || '';
const SK = process.env.QINIU_SECRET_KEY || '';
if (!AK || !SK) { console.error('✗ QINIU_ACCESS_KEY/QINIU_SECRET_KEY 未设置'); process.exit(1); }
if (!VERSION) { console.error('✗ --version 必填'); process.exit(1); }

// ---------- qiniu signing ----------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
const hmac = (data) => createHmac('sha1', SK).update(data).digest();

/** QBox 管理接口签名;headers 为实际随请求发送的头(键名小写) */
function qboxSign(method, pathAndQuery, host, headers = {}, body = '') {
  let s = `${method.toUpperCase()} ${pathAndQuery}\nHost: ${host}\n`;
  const ct = headers['content-type'];
  if (ct) s += `Content-Type: ${ct}\n`;
  s += '\n';
  if (body && ct) s += body;
  return `QBox ${AK}:${b64u(hmac(s))}`;
}

/** 表单上传 token(insertOnly=0 允许同版本重传覆盖) */
function uploadToken(key) {
  const policy = JSON.stringify({ scope: `${BUCKET}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600, insertOnly: 0 });
  const encoded = b64u(policy);
  return `${AK}:${b64u(hmac(encoded))}:${encoded}`;
}

async function uploadFile(key, filePath) {
  const form = new FormData();
  form.set('token', uploadToken(key));
  form.set('key', key);
  form.set('file', new Blob([fs.readFileSync(filePath)]));
  const res = await fetch(`https://${UPLOAD_HOST}`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload ${key} 失败: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function listTgz() {
  const pathAndQuery = `/list?bucket=${encodeURIComponent(BUCKET)}&prefix=${encodeURIComponent(`${KEY_PREFIX}/`)}&limit=1000`;
  const res = await fetch(`https://rsf.qiniu.com${pathAndQuery}`, {
    headers: { Authorization: qboxSign('GET', pathAndQuery, 'rsf.qiniu.com') },
  });
  if (!res.ok) throw new Error(`list 失败: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const items = data.items || [];
  return items
    .map((it) => it.key)
    .filter((k) => k.endsWith('.tgz'))
    .map((k) => {
      const m = k.match(/-(\d+\.\d+\.\d+)\.tgz$/);
      return m ? { key: k, ver: m[1] } : null;
    })
    .filter(Boolean);
}

async function deleteKey(key) {
  const entry = b64u(`${BUCKET}:${key}`);
  const pathAndQuery = `/delete/${entry}`;
  const res = await fetch(`https://rs.qiniu.com${pathAndQuery}`, {
    method: 'POST',
    headers: { Authorization: qboxSign('POST', pathAndQuery, 'rs.qiniu.com') },
  });
  if (!res.ok) throw new Error(`delete ${key} 失败: HTTP ${res.status} ${await res.text()}`);
}

async function cdnRefresh(urls) {
  const body = JSON.stringify({ urls });
  const headers = { 'Content-Type': 'application/json', Authorization: qboxSign('POST', '/refresh', 'fusion.qiniu.com', { 'content-type': 'application/json' }, body) };
  const res = await fetch('https://fusion.qiniu.com/refresh', { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`CDN refresh 失败: HTTP ${res.status} ${await res.text()}`);
}

// ---------- main ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-mirror-'));
try {
  // 1) npm pack(产出名:<name>-<version>.tgz)
  const out = execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: PKG_DIR, encoding: 'utf-8' }).trim().split('\n').pop().trim();
  const tgzPath = path.join(tmp, out);
  if (!fs.existsSync(tgzPath)) throw new Error(`npm pack 产物不存在: ${tgzPath}`);
  const key = `${KEY_PREFIX}/${out}`;
  console.log(`== pack: ${out} (${(fs.statSync(tgzPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // 2) 上传 tgz
  await uploadFile(key, tgzPath);
  console.log(`✓ uploaded ${BUCKET}:${key}`);

  // 3) latest.json(tgz 上传成功后才写,避免指向不存在的包)
  const manifest = { version: VERSION, tgz: out, publishedAt: new Date().toISOString() };
  const manifestPath = path.join(tmp, 'latest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await uploadFile(`${KEY_PREFIX}/latest.json`, manifestPath);
  console.log(`✓ uploaded ${BUCKET}:${KEY_PREFIX}/latest.json = ${JSON.stringify(manifest)}`);

  // 4) 清理:semver 降序,保留最近 KEEP 个(管理接口不可用时不阻断——上传主链已完成)
  try {
    const all = await listTgz();
    all.sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }));
    const stale = all.slice(KEEP);
    for (const it of stale) {
      await deleteKey(it.key);
      console.log(`✓ pruned ${it.key} (keep=${KEEP})`);
    }
    if (!stale.length) console.log(`✓ 无需清理(现存 ${all.length} ≤ keep=${KEEP})`);
  } catch (err) {
    console.warn(`⚠ 清理跳过(管理接口不可用,${err.message})`);
  }

  // 5) CDN 刷新(latest.json 覆盖必须刷,否则边缘节点还是旧清单;失败降级为告警)
  try {
    await cdnRefresh([`${BASE_URL}/${key}`, `${BASE_URL}/${KEY_PREFIX}/latest.json`]);
    console.log('✓ CDN refreshed');
  } catch (err) {
    console.warn(`⚠ CDN 刷新失败(可能读到旧 latest.json,${err.message})`);
  }
  console.log(`✓ mirror done: ${BASE_URL}/${KEY_PREFIX}/latest.json`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
