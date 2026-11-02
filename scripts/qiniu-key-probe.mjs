// qiniu-key-probe.mjs — QINIU 钥匙自助体检:向 env 文件指定的测试桶传一个 64B 对象再读回
// 判定:PUT 2xx + GET body 一致 = 钥匙对该桶有效;401 = 钥匙死/无权限(与 hiredchina-npm-mirror
// 的 401 对比,区分"钥匙死" vs "桶级权限")。用法:node scripts/qiniu-key-probe.mjs <env文件>
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const envFile = process.argv[2];
if (!envFile) { console.error('usage: node qiniu-key-probe.mjs <env-file>'); process.exit(1); }
const env = {};
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const AK = env.QINIU_ACCESS_KEY, SK = env.QINIU_SECRET_KEY;
const BUCKET = env.QINIU_BUCKET, KEY = env.QINIU_TEST_OBJECT_KEY || 'key-probe.txt';
const UP = (env.QINIU_UPLOAD_URL || 'https://up-z2.qiniup.com').replace(/\/+$/, '');
const DL = env.QINIU_TEST_DOWNLOAD_URL || env.QINIU_DOWNLOAD_BASE_URL;
if (!AK || !SK || !BUCKET) { console.error('✗ env 缺 QINIU_ACCESS_KEY/SECRET_KEY/BUCKET'); process.exit(1); }

// 2026-11-03 实证:去 padding 的 token 在 form 上传被拒(bad token),带 padding 才通——
// padding 敏感性取决于 policy JSON 长度 mod 3,v0.1.5 当年纯属碰巧能跑。
const b64pad = (b) => Buffer.from(b).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
const putPolicy = b64pad(JSON.stringify({ scope: `${BUCKET}:${KEY}`, deadline: Math.floor(Date.now() / 1000) + 600, insertOnly: 0 }));
const sign = b64pad(createHmac('sha1', SK).update(putPolicy).digest());
const token = `${AK}:${sign}:${putPolicy}`;
const body = `probe ${Date.now()}`;

const form = new FormData();
form.append('token', token);
form.append('key', KEY);
form.append('file', new Blob([body]), 'probe.txt');

const t0 = Date.now();
const put = await fetch(`${UP}/`, { method: 'POST', body: form }).catch((e) => ({ status: 'NET', err: e.message }));
console.log(`PUT ${UP}/ → ${put.status ?? put.err} (${Date.now() - t0}ms)`);
if (put.status !== 200) {
  console.log(`响应体: ${(await put.text?.().catch(() => '')) || '(none)'}`);
  console.log('✗ 结论:钥匙对该桶上传 401/失败 → 钥匙本身死或无 bucket 写权限');
  process.exit(1);
}
if (DL) {
  // QINIU_TEST_DOWNLOAD_URL 本就含完整 key 路径,原样用(只加 cache-buster)
  const url = `${DL}${DL.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const get = await fetch(url).catch((e) => ({ status: 'NET', err: e.message }));
  const txt = get.status === 200 ? await get.text() : '';
  console.log(`GET ${url} → ${get.status ?? get.err},body 匹配=${txt === body}`);
  console.log(txt === body ? '✓ 结论:钥匙有效(上传+读回一致)' : `⚠ 上传成功但读回不一致(${txt.slice(0, 50)})`);
} else {
  console.log('✓ 上传成功(无 QINIU_TEST_DOWNLOAD_URL,跳过读回)');
}
