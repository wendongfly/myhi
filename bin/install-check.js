// 升级后校验安装是否完整。npm 被中断、Windows 上文件被锁（EBUSY）、杀毒软件（360 等）拦截，
// 都会留下缺文件的半成品——带着它重启，新进程起不来，服务就挂了（测试机缺 dist/login.html 即此类）。
// server（网页升级）和 daemon（Windows 停服升级）共用。
import { existsSync, readFileSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';

export const REQUIRED_FILES = [
  'package.json', 'bin/myhi.js', 'bin/daemon.js',
  'dist/index.js', 'dist/lib',
  'dist/login.html', 'dist/index.html', 'dist/chat.html', 'dist/admin.html', 'dist/grid.html', 'dist/terminal.html',
];

// pkgRoot：@wendongfly/myhi 安装目录；expectVersion：期望装上的版本（不知道就不比）
export function checkInstall(pkgRoot, expectVersion) {
  const missing = REQUIRED_FILES.filter((f) => !existsSync(join(pkgRoot, f)));
  let version = null;
  try { version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version; } catch {}
  let error = null;
  if (missing.length) error = `安装不完整，缺少 ${missing.join('、')}（可能被杀毒软件拦截或安装被中断）`;
  else if (expectVersion && version !== expectVersion) error = `安装后版本是 ${version || '未知'}，不是期望的 ${expectVersion}（npm 可能装到了别的目录或镜像未同步）`;
  return { ok: !error, version, missing, error };
}

// 上次升级结果，落 ~/.myhi/upgrade-status.json：重启后的新进程（或 daemon 停服升级时）靠它把成败告诉网页
export function upgradeStatusFile(configDir) { return join(configDir, 'upgrade-status.json'); }

// ── 升级命令（server 网页升级、daemon 停服升级共用）────────────────────────
// 以前直接跑 PATH 里的 `npm install -g`：机器上装了不止一套 Node（典型：宿主启动器自带一套 Node，
// 系统另装了一套）时，PATH 里先找到的 npm 会把新版装进**它自己的**全局目录，而 myhi 从原目录重启
// → 永远还是旧版，网页报「npm 可能装到了别的目录」。现在：
//   ① 优先用和当前 myhi **同一套 Node** 自带的 npm（node 可执行文件旁边的 npm / npm.cmd）；
//   ② 用 --prefix 明确装回 myhi **当前所在**的全局目录，原地覆盖。
// 认不出全局安装布局（如开发时从源码目录跑）就不加 --prefix，行为同以前。

/** pkgRoot 所在的 npm 全局前缀；Windows：<prefix>\node_modules\@wendongfly\myhi，其他：<prefix>/lib/node_modules/@wendongfly/myhi */
export function globalPrefixOf(pkgRoot) {
  const r = resolve(pkgRoot);
  const nm = dirname(dirname(r));
  if (basename(dirname(r)) !== '@wendongfly' || basename(nm) !== 'node_modules') return null;
  if (process.platform === 'win32') return dirname(nm);
  return basename(dirname(nm)) === 'lib' ? dirname(dirname(nm)) : null;
}

// registry：本次用哪个下载源（见下面 upgradeCandidates）；装的是该源上的 latest
export function npmUpgradeCmd(pkgRoot, registry = REGISTRIES.official) {
  const win = process.platform === 'win32';
  const local = join(dirname(process.execPath), win ? 'npm.cmd' : 'npm');
  const npm = existsSync(local) ? `"${local}"` : (win ? 'npm.cmd' : 'npm');
  const prefix = globalPrefixOf(pkgRoot);
  return `${npm} install -g @wendongfly/myhi@latest --registry ${registry}${prefix ? ` --prefix "${prefix}"` : ''}`;
}

// ── 下载源：官方 / 国内镜像 自动兼容（myhi 升级、Claude 升级共用）──────────────
// 国内网络常连不上 / 很慢 registry.npmjs.org；而镜像同步有延迟（几分钟～几小时）。
// 「查新版」和「安装」必须对齐到同一个源，否则会「提示有新版、装上的却是旧版」。
// config.json 的 npmRegistry：auto（默认：先官方，连不上 / 装失败再国内镜像）/ official / mirror / 自定义 URL
export const REGISTRIES = { official: 'https://registry.npmjs.org', mirror: 'https://registry.npmmirror.com' };
export const registryName = (r) => r === REGISTRIES.official ? '官方源' : r === REGISTRIES.mirror ? '国内镜像' : r;

export function registryOrder(pref) {
  if (pref === 'official') return [REGISTRIES.official];
  if (pref === 'mirror') return [REGISTRIES.mirror];
  if (pref && /^https?:\/\//.test(pref)) return [String(pref).replace(/\/+$/, '')];
  return [REGISTRIES.official, REGISTRIES.mirror];
}

export async function fetchLatest(registry, pkg, ms = 8000) {
  try {
    const r = await fetch(`${registry}/${pkg}/latest`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    return r.ok ? (await r.json()).version || null : null;
  } catch { return null; }
}

export function versionGt(a, b) {
  const pa = String(a || '').split(/[.-]/).map(Number), pb = String(b || '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}

/** 查最新版：按顺序问各源，第一个答上来的为准 → { version, registry } | null */
export async function latestVersion(pkg, pref) {
  for (const registry of registryOrder(pref)) {
    const version = await fetchLatest(registry, pkg);
    if (version) return { version, registry };
  }
  return null;
}

/**
 * 升级要尝试的源：比当前版本新的才算（镜像没同步到就跳过它）。
 * → { candidates: [{registry, version}], reachable: [...], note }
 *   candidates 为空时 note 说明原因：都连不上 / 已是最新 / 镜像还没同步
 */
export async function upgradeCandidates(pkg, current, pref) {
  const order = registryOrder(pref);
  const got = await Promise.all(order.map(async (registry) => ({ registry, version: await fetchLatest(registry, pkg) })));
  const reachable = got.filter((g) => g.version);
  const candidates = reachable.filter((g) => !current || versionGt(g.version, current));
  let note = null;
  if (!candidates.length) {
    if (!reachable.length) note = `${order.map(registryName).join('和')}${order.length > 1 ? '都' : ''}连不上，请检查网络（或在 设置 › 服务 › 升级下载源 换一个）`;
    else note = `已经是最新版本 ${current}` + (reachable.some((g) => g.registry !== REGISTRIES.official) && !reachable.some((g) => g.registry === REGISTRIES.official)
      ? '（官方源连不上，以国内镜像为准；镜像可能还没同步到最新，过一会儿再试）' : '');
  }
  return { candidates, reachable, note };
}

