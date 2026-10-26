#!/usr/bin/env node
// qiniu-hmweb-release.mjs — hunter-mate web 云端静态资源发布到七牛 CDN
//
// hm-web-cloud 产物分发(hm web build:cloud 的 _next/ 资源面):
//   1. 递归上传 <dist>/_next/** 到 <bucket>:<key-prefix>/_next/**
//   2. insertOnly=1:资源文件名即内容哈希,已存在即跳过——天然免清理免失效
//   3. 打印 assetPrefix 约定,供 hunter-mate 构建/部署核对
//
// HTML 面不进 CDN:由 dev-ops /hm/ 伺服(SPA fallback + placeholder 兜底在服务端)。
// 回退:HM_WEB_ASSET_PREFIX 置空重发,资源改由 dev-ops 同源伺服,CDN 故障零锁死。
//
// 上传链与 qiniu-hmh-release.mjs 同构(curl + up 主机 fallback,FID-121 教训内消化);
// GitHub runner 出口被封时由 jp 侧自治兜底(参照 dev-ops infra/qiniu-mirror)。
//
// 退出码:0 全绿;2 有降级(部分文件已存在/刷新失败);1 硬失败。
// 用法:
//   node scripts/qiniu-hmweb-release.mjs \
//     --dist ../hunter-mate/packages/web/dist \
//     --bucket hiredchina --key-prefix hm-web \
//     [--base-url https://image.hiredchina.com]
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const DIST = path.resolve(arg('dist', ''));
const BUCKET = arg('bucket', 'hiredchina');
const KEY_PREFIX = arg('key-prefix', 'hm-web').replace(/\/+$/, '');
const BASE_URL = arg('base-url', 'https://image.hiredchina.com').replace(/\/+$/, '');
const UPLOAD_HOSTS = ['up-z2.qiniup.com', 'up-z0.qiniup.com', 'up.qiniup.com'];

const AK = process.env.QINIU_ACCESS_KEY || '';
const SK = process.env.QINIU_SECRET_KEY || '';
if (!AK || !SK) { console.error('✗ QINIU_ACCESS_KEY/QINIU_SECRET_KEY 未设置'); process.exit(1); }
if (!DIST || !fs.existsSync(path.join(DIST, '_next'))) {
  console.error(`✗ --dist 必须指向 build:cloud 产物(含 _next/): ${DIST || '(缺)'}`);
  process.exit(1);
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
const hmac = (data) => createHmac('sha1', SK).update(data).digest();

function uploadToken(key) {
  // insertOnly=1:内容哈希文件名,已存在即跳过——幂等可重跑,不覆盖防事故
  const policy = JSON.stringify({ scope: `${BUCKET}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600, insertOnly: 1 });
  const encoded = b64u(Buffer.from(policy));
  return `${AK}:${b64u(hmac(encoded))}:${encoded}`;
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) out.push(...walk(abs, base));
    else out.push({ abs, rel: path.relative(base, abs) });
  }
  return out;
}

function upload(file) {
  const key = `${KEY_PREFIX}/_next/${file.rel.split(path.sep).join('/')}`;
  const token = uploadToken(key);
  let lastErr = '';
  for (const host of UPLOAD_HOSTS) {
    try {
      // 不用 -f:insertOnly=1 命中已存在时七牛回 614 + JSON 错误体,
      // 须读 body 判别"已存在跳过"与真失败
      const out = execFileSync(
        'curl',
        [
          '-sS', '--max-time', '120',
          `https://${host}/`,
          '-F', `token=${token}`,
          '-F', `key=${key}`,
          '-F', `file=@${file.abs}`,
          '-w', '\n%{http_code}',
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const nl = out.lastIndexOf('\n');
      const body = out.slice(0, nl);
      const code = out.slice(nl + 1).trim();
      if (code === '200') return { ok: true };
      if (body.includes('file exists') || body.includes('"code":614')) return { existed: true };
      lastErr = `HTTP ${code} ${body.slice(0, 100)}`;
    } catch (e) {
      lastErr = String(e).slice(0, 120);
    }
  }
  return { ok: false, err: lastErr };
}

const files = walk(path.join(DIST, '_next'));
if (!files.length) { console.error('✗ _next/ 下无文件'); process.exit(1); }

console.log(`上传 ${files.length} 个资源文件 → ${BUCKET}:${KEY_PREFIX}/_next/`);
let uploaded = 0;
let skipped = 0;
const failed = [];
for (const f of files) {
  const r = upload(f);
  if (r.ok) { uploaded++; }
  else if (r.existed) { skipped++; }
  else { failed.push(`${f.rel}: ${r.err}`); }
  if ((uploaded + skipped + failed.length) % 100 === 0) {
    console.log(`  进度 ${uploaded + skipped + failed.length}/${files.length}`);
  }
}

console.log(`完成:新传 ${uploaded},跳过(冲突视为已存在) ${skipped},失败 ${failed.length}`);
if (failed.length) {
  failed.slice(0, 10).forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`assetPrefix 约定: ${BASE_URL}/${KEY_PREFIX}`);
