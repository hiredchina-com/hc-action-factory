#!/usr/bin/env node
// qiniu-release-mirror.mjs — 发布后把 npm 包 tgz 镜像到七牛 CDN(FID-102)
//
// 用途:CLI 自更新的 CDN 回退通道。hunter-mate CLI(updater.ts CDN_RELEASES_BASE)
// 在 npm registry 不可达时回退到这里读 latest.json + 下载 tgz。
//
// 行为:
//   1. 主包 tgz 二选一:
//      - 优先(带 --pack-spec name@version):从 npm registry 拉【已发布】的 tgz
//        (hmh#58/0.1.17 发布实证:本地 npm pack 源码目录会打出残缺包——
//        files 字段限定 dist/ 而 mirror job 只检出源码不构建,2.4kB 3 文件
//        坏包直接上 CDN latest.json;registry 拉取才保证镜像===用户实际装到
//        的包;发布岗位刚写完元数据,索引有秒级延迟,12×5s 重试)
//      - 回退(--pack-spec 省略):npm pack <package_dir> 本地打包(仅当目录
//        已构建时安全)
//   2. 上传到 <bucket>:<key_prefix>/<tgz>
//   3. 镜像原生依赖(FID-116):发布包 dependencies/optionalDependencies 里的包
//      及一层内带 install 脚本的原生传递依赖,npm tarball 传到 <key_prefix>/native/,
//      登记进 latest.json.nativeDeps,供国内安装路径零 registry 下载
//      (版本区间经 `npm view` 解析——registry URL 路径只收精确版本/tag,直接拼
//      range 会 404,0.1.16 发布实证 better-sqlite3@^13.0.3 全跳过)。
//      网络操作全部 5 次退避重试(0.1.17 补发实证 runner 出网抖动裸 fetch failed);
//      【所有】登记 nativeDeps(含可选 keytar)镜像失败=硬失败 exit 1——用户裁定:
//      可选性由运行时降级承担(如 keychain.ts 0o600 文件兜底),镜像层的承诺是
//      "CDN 通道零 registry 安装",差异化降级=通道自打脸,重试后仍失败值得阻断。
//   4. 写并上传 <key_prefix>/latest.json = {version, tgz, publishedAt, nativeDeps?}
//   5. 列出现有主包 *.tgz(native/ 子目录不参与),semver 降序,删除超出 --keep 的旧版本
//      (该 AK/SK 无 rsf/rs 管理权限,已知 401 降级,FID-102;清理靠 keep 上限容忍)
//   6. CDN 刷新 latest.json 与 tgz URL(fusion /v2/tune/refresh;失败 exit 2 打
//      ::warning:: 注解可见,不阻断 release——job 级 continue-on-error)
//
// 退出码:0 全绿;2 有降级(清理 401/刷新失败等通道增强项),job 显红不阻断;
//        1 硬失败(主包上传失败 / 任一 nativeDeps 镜像失败——hmh#58 补发实证:
//          better-sqlite3 缺份让所有用户 server 起不来;keytar 缺份让 CDN 通道
//          承诺的"零 registry 安装"破裂,同样是硬失败)。
//
// 用法:
//   node scripts/qiniu-release-mirror.mjs \
//     --dir packages/cli --pack-spec hunter-mate@0.1.17 --version 0.1.17 \
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
const PACK_SPEC = arg('pack-spec', ''); // name@version:从 registry 拉已发布 tgz(默认推荐)
const VERSION = arg('version', '');
const BUCKET = arg('bucket', 'hiredchina');
const KEY_PREFIX = arg('key-prefix', 'hunter-mate-releases').replace(/\/+$/, '');
const KEEP = Math.max(1, parseInt(arg('keep', '5'), 10) || 5);
const BASE_URL = arg('base-url', 'https://image.hiredchina.com').replace(/\/+$/, '');
// 上传主机必须与 bucket 所在区域一致:hiredchina/hcweb-temp-file 都在 z2(华南),默认 up-z2。
// 但 0.1.18 实证 runner→up-z2 路径会被整段掐死(5×60s 全超时,而 2 小时前 0.1.17 同
// 路径正常 = 出口/WAF 按目标域封禁的间歇性行为,非配置错)。upload token 区域无关,
// 任一 up 主机都可收单——故默认走主机 fallback 链,单域被封自动换域;--upload-host
// 显式指定时退回单主机(调试/锁定用途)。
const UPLOAD_HOSTS = arg('upload-host', '')
  ? [arg('upload-host', '')]
  : ['up-z2.qiniup.com', 'up-z0.qiniup.com', 'up.qiniup.com'];

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

/** fetch 全局超时:连接挂起无 reject,withRetry 救不了——0.1.18 镜像 job 实证
 * npm pack 步骤无超时挂死 20+ 分钟(job 级默认 360min 才杀)。所有 fetch 与
 * npm 子进程都必须带超时,把"挂死"变成"可重试的错误"。 */
const FETCH_TIMEOUT = 60_000;

/** 网络抖动重试(fetch failed 是 undici 瞬时错误,0.1.17 补发实证 runner 出网
 * 对部分目标不稳定;重试必须尽量吃掉抖动——残留失败=真问题,直接硬失败) */
async function withRetry(label, fn, attempts = 5) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      console.log(`⚠ ${label} 第 ${i}/${attempts} 次失败: ${err.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last;
}

async function uploadFile(key, filePath) {
  const form = new FormData();
  form.set('token', uploadToken(key));
  form.set('key', key);
  form.set('file', new Blob([fs.readFileSync(filePath)]));
  // 逐主机尝试,每主机 2 次(总上限 ~6 分钟);token 区域无关,跨域收单后数据仍落本桶
  let last = null;
  for (const host of UPLOAD_HOSTS) {
    try {
      return await withRetry(`upload ${key}@${host}`, async () => {
        const res = await fetch(`https://${host}`, { method: 'POST', body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
        return res.json();
      }, 2);
    } catch (err) { last = err; }
  }
  throw last;
}

async function listTgz() {
  const pathAndQuery = `/list?bucket=${encodeURIComponent(BUCKET)}&prefix=${encodeURIComponent(`${KEY_PREFIX}/`)}&limit=1000`;
  const res = await fetch(`https://rsf.qiniu.com${pathAndQuery}`, {
    headers: { Authorization: qboxSign('GET', pathAndQuery, 'rsf.qiniu.com') },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`list 失败: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const items = data.items || [];
  return items
    .map((it) => it.key)
    // 只统计主包 tgz;native/ 子目录是原生依赖镜像,独立生命周期,不参与主包清理
    .filter((k) => k.endsWith('.tgz') && !k.includes('/native/'))
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`delete ${key} 失败: HTTP ${res.status} ${await res.text()}`);
}

async function cdnRefresh(urls) {
  // 官方路径 /v2/tune/refresh;主机必须用现行域 fusion.qiniuapi.com——
  // 旧域 fusion.qiniu.com 已 NXDOMAIN(2026-10 本机+GitHub runner 双端实证:
  // 0.1.17 run 仍 fetch failed;rs.qiniu.com/up-z2 正常,仅 fusion 旧域被回收),
  // rs.qiniu.com 系未动。签名 Host 头与 fetch 主机必须同域(签名原文与实发头同构造)。
  const body = JSON.stringify({ urls });
  const pathAndQuery = '/v2/tune/refresh';
  const FUSION_HOST = 'fusion.qiniuapi.com';
  const headers = { 'Content-Type': 'application/json', Authorization: qboxSign('POST', pathAndQuery, FUSION_HOST, { 'content-type': 'application/json' }, body) };
  const res = await fetch(`https://${FUSION_HOST}${pathAndQuery}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const text = await res.text();
  if (!res.ok) throw new Error(`CDN refresh 失败: HTTP ${res.status} ${text}`);
  // fusion 业务错误也返回 HTTP 200 + body.code != 200,必须查体
  const data = JSON.parse(text);
  if (data.code !== 200) throw new Error(`CDN refresh 失败: code=${data.code} ${text}`);
  return data;
}

// ---------- 原生依赖镜像(FID-116:bundle 后用户机器只装原生外置模块) ----------
// 把发布包 dependencies + optionalDependencies 里的包(及其一层内带 install
// 脚本的传递依赖,如 better-sqlite3 → node-addon-api)的 npm tarball 一并镜像到
// <key-prefix>/native/,并登记进 latest.json.nativeDeps,供国内安装路径零
// registry 下载。任何一个失败不阻断主包镜像(降级告警,回退走 npm registry)。
async function npmView(name, range, fields) {
  // registry URL 路径(<name>/<version>)只接受精确版本或 dist-tag,semver range 会 404
  // (0.1.16 发布实证 better-sqlite3@^13.0.3 → HTTP 404 全跳过)。版本解析交给 npm:
  const spec = range ? `${name}@${range}` : name;
  let out;
  try {
    out = execFileSync('npm', ['view', spec, '--json', '--fetch-retries=2', ...fields], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }).trim();
  } catch (err) {
    const stderr = String(err.stderr || '').trim().split('\n').pop();
    throw new Error(`npm view ${spec} 失败: ${stderr || err.message}`);
  }
  if (!out) throw new Error(`npm view ${spec}: 空输出`);
  let d = JSON.parse(out);
  // range 匹配多版本时 npm 输出升序数组(npm view node-addon-api@^8 实证 15 项),
  // 取最后一项 = 最大满足版本(与 npm install 解析一致);单匹配输出裸对象/标量
  if (Array.isArray(d)) d = d[d.length - 1];
  // 单字段时 npm 直接输出该字段的值(可能是对象,如 dependencies 图),统一包一层
  return fields.length === 1 ? { [fields[0]]: d } : d;
}

async function downloadTo(url, dest) {
  await withRetry(`download ${url}`, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  });
}

async function mirrorNativeDeps(pkgDir, tmp) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  const nativeDeps = {};
  const urls = [];

  async function mirrorOne(name, range, optional) {
    try {
      const info = await npmView(name, range, ['version', 'dist']);
      const ver = info.version;
      const tarball = info.dist && info.dist.tarball;
      if (!ver || !tarball) throw new Error('缺 version/dist.tarball');
      const fname = `${name.replace('/', '-').replace('@', '')}-${ver}.tgz`;
      const key = `${KEY_PREFIX}/native/${fname}`;
      const local = path.join(tmp, fname);
      await downloadTo(tarball, local);
      await uploadFile(key, local);
      nativeDeps[name] = { version: ver, tgz: `native/${fname}`, optional: !!optional };
      urls.push(`${BASE_URL}/${key}`);
      console.log(`✓ native mirrored ${name}@${ver} -> ${key}`);
      // 一层递归:该包的 dependencies 里带 install/preinstall 脚本的原生包
      // (一次 npm view 取全 scripts+version+dist,省一次 registry 往返)
      const childDeps = (await npmView(name, ver, ['dependencies'])).dependencies || {};
      for (const [cn, cr] of Object.entries(childDeps)) {
        try {
          const cs = await npmView(cn, cr, ['scripts', 'version', 'dist']);
          const s = cs.scripts || {};
          if (!s.install && !s.preinstall) continue; // 纯 JS 传递依赖,bundle/安装期不需要单独镜像
          if (nativeDeps[cn]) continue;
          const cver = cs.version;
          const ctar = cs.dist && cs.dist.tarball;
          if (!cver || !ctar) throw new Error('缺 version/dist.tarball');
          const cfname = `${cn.replace('/', '-').replace('@', '')}-${cver}.tgz`;
          const ckey = `${KEY_PREFIX}/native/${cfname}`;
          const clocal = path.join(tmp, cfname);
          await downloadTo(ctar, clocal);
          await uploadFile(ckey, clocal);
          nativeDeps[cn] = { version: cver, tgz: `native/${cfname}`, transitive: true };
          urls.push(`${BASE_URL}/${ckey}`);
          console.log(`✓ native mirrored(传递) ${cn}@${cver} -> ${ckey}`);
        } catch (err) {
          throw new Error(`native 传递依赖 ${cn}@${cr} 镜像失败(重试后仍不可达): ${err.message}`);
        }
      }
    } catch (err) {
      // 无软硬之分:凡登记进 latest.json.nativeDeps 的条目缺份,CDN 通道承诺
      // 即破裂(可选依赖的运行时降级不豁免镜像完整性),一律硬失败
      throw new Error(`native ${name}@${range} 镜像失败(重试后仍不可达): ${err.message}`);
    }
  }

  for (const [name, range] of Object.entries(pkg.dependencies || {})) await mirrorOne(name, range, false);
  for (const [name, range] of Object.entries(pkg.optionalDependencies || {})) await mirrorOne(name, range, true);
  return { nativeDeps, urls };
}

// ---------- main ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-mirror-'));
const degraded = []; // 降级项描述,末尾统一 ::warning:: + exit 2
try {
  // 1) 主包 tgz:优先 registry 拉已发布件(==用户实际装到的包);无 --pack-spec
  //    时回退本地 npm pack(仅当该目录已构建才安全)
  let out;
  if (PACK_SPEC) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        out = execFileSync('npm', ['pack', PACK_SPEC, '--pack-destination', tmp],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
          .trim().split('\n').pop().trim();
        break;
      } catch (err) {
        lastErr = err;
        const stderr = String(err.stderr || '').trim().split('\n').pop();
        console.log(`registry pack ${PACK_SPEC} 第 ${attempt}/12 次未就绪: ${stderr || err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!out) throw new Error(`npm pack ${PACK_SPEC} 失败(registry 索引延迟或发布未成功)`);
  } else {
    out = execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: PKG_DIR, encoding: 'utf-8', timeout: 180_000 }).trim().split('\n').pop().trim();
  }
  const tgzPath = path.join(tmp, out);
  if (!fs.existsSync(tgzPath)) throw new Error(`npm pack 产物不存在: ${tgzPath}`);
  if (fs.statSync(tgzPath).size < 10 * 1024) throw new Error(`主包 tgz 异常小(${fs.statSync(tgzPath).size}B,疑似源码未构建的残缺包)——拒绝上 CDN`);
  const key = `${KEY_PREFIX}/${out}`;
  console.log(`== pack: ${out} (${(fs.statSync(tgzPath).size / 1024 / 1024).toFixed(1)} MB${PACK_SPEC ? ` ← registry ${PACK_SPEC}` : ' ← local'})`);

  // 2) 上传 tgz
  await uploadFile(key, tgzPath);
  console.log(`✓ uploaded ${BUCKET}:${key}`);

  // 2.5) 原生依赖镜像(FID-116;任一失败降级告警,主包镜像不受影响)
  const { nativeDeps, urls: nativeUrls } = await mirrorNativeDeps(PKG_DIR, tmp);

  // 3) latest.json(tgz 上传成功后才写,避免指向不存在的包)
  const manifest = { version: VERSION, tgz: out, publishedAt: new Date().toISOString() };
  if (Object.keys(nativeDeps).length) manifest.nativeDeps = nativeDeps;
  const manifestPath = path.join(tmp, 'latest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await uploadFile(`${KEY_PREFIX}/latest.json`, manifestPath);
  console.log(`✓ uploaded ${BUCKET}:${KEY_PREFIX}/latest.json = ${JSON.stringify(manifest)}`);

  // 4) 清理:semver 降序,保留最近 KEEP 个(管理接口对该 AK/SK 无权限是已知限制
  //    (FID-102,401 BadToken),降级告警;清理靠 keep 上限容忍)
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
    console.warn(`⚠ 清理跳过(${err.message})`);
    degraded.push(`旧版本清理未执行(${err.message})`);
  }

  // 5) CDN 刷新(latest.json 覆盖必须刷,否则边缘节点还是旧清单;失败打告警显红)
  try {
    const r = await cdnRefresh([`${BASE_URL}/${key}`, `${BASE_URL}/${KEY_PREFIX}/latest.json`, ...nativeUrls]);
    console.log(`✓ CDN refreshed (requestId=${r.requestId || '?'} surplusDay=${r.surplusDay ?? '?'})`);
  } catch (err) {
    console.warn(`⚠ CDN 刷新失败(可能读到旧 latest.json,${err.message})`);
    degraded.push(`CDN 边缘缓存刷新失败(${err.message})`);
  }
  console.log(`✓ mirror done: ${BASE_URL}/${KEY_PREFIX}/latest.json`);

  if (degraded.length) {
    for (const d of degraded) console.log(`::warning::[qiniu-mirror] ${d}`);
    console.error(`✗ mirror 降级完成:${degraded.length} 项(见上方 ⚠)`);
    process.exit(2);
  }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
