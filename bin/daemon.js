#!/usr/bin/env node
/**
 * myhi 守护进程
 * 负责 fork/管理 server 子进程，处理升级和重启
 * daemon 本身不会被升级影响，保证服务连续性
 */
import { fork, execSync, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { checkInstall, upgradeStatusFile, npmUpgradeCmd, REGISTRIES, registryName } from './install-check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const configDir  = join(homedir(), '.myhi');
const pidFile    = join(configDir, 'daemon.pid');
const serverEntry = join(__dirname, '../dist/index.js');
const pkgRoot    = join(__dirname, '..');
// 告诉 server 本 daemon 支持哪些能力（server 按它选升级方式；老 daemon 没这个变量 → server 走旧路）
const DAEMON_CAPS = 'graceful,upgrade-v2';

mkdirSync(configDir, { recursive: true });

// 单例守卫：如果已有活 daemon，先 SIGTERM 它再启动。否则双 daemon 会让各自的
// server child 因互读 server.pid 而互杀，触发"连续崩溃 5 次"熔断（实际升级时遇到过）
(function killOldDaemon() {
  let oldPid;
  try { oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10); } catch { return; }
  if (!oldPid || oldPid === process.pid) return;
  let alive = false;
  try { process.kill(oldPid, 0); alive = true; } catch {}
  if (!alive) return;
  process.stderr.write(`[daemon] 检测到已运行的 daemon (PID ${oldPid})，先停止...\n`);
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${oldPid} /F /T`, { stdio: 'pipe', timeout: 5000 });
    else process.kill(oldPid, 'SIGTERM');
  } catch {}
  // 等最多 5 秒
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(oldPid, 0); } catch { return; }
    const end = Date.now() + 200;
    while (Date.now() < end) {} // busy-wait, 此处无事件循环可用
  }
  let stillAlive = false;
  try { process.kill(oldPid, 0); stillAlive = true; } catch {}
  if (stillAlive) {
    process.stderr.write(`[daemon] 无法停止旧 daemon (PID ${oldPid})，本进程退出避免冲突\n`);
    process.exit(1);
  }
})();

writeFileSync(pidFile, String(process.pid));

let child = null;
let restarting = false;
let stopping = false;
let crashCount = 0;
let childStartedAt = 0;
let upgrading = false;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[daemon ${ts}] ${msg}\n`);
}

function startServer() {
  log('启动 server 子进程...');
  childStartedAt = Date.now();
  child = fork(serverEntry, process.argv.slice(2), {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, MYHI_DAEMON: '1', MYHI_DAEMON_PID: String(process.pid), MYHI_DAEMON_CAPS: DAEMON_CAPS },
    windowsHide: true,
  });

  child.on('message', (msg) => {
    if (msg?.type === 'upgrade') doUpgrade(msg.target, msg.candidates);
    else if (msg?.type === 'restart') doRestart();
  });

  const thisChild = child;
  child.on('exit', (code, signal) => {
    if (child === thisChild) child = null; // 只清自己的引用
    if (restarting || stopping || upgrading) return; // 主动重启/停止/升级中，不自动恢复

    // 崩溃退避：起来跑满 60 秒算稳定，计数清零；否则 1s→2s→4s…封顶 60s 一直重试。
    // 以前是「10 秒内崩 5 次 daemon 就退出」——升级装出半成品时整个服务彻底停掉，只能上机器手动救；
    // 现在 daemon 永不放弃，修好文件（重装）后自己就能起来。
    if (Date.now() - childStartedAt > 60000) crashCount = 0;
    crashCount++;
    const delay = Math.min(60000, 1000 * 2 ** (crashCount - 1));
    log(`server 退出 (code=${code}, signal=${signal})，第 ${crashCount} 次，${Math.round(delay / 1000)} 秒后重启...`);
    if (crashCount >= 3) {
      const chk = checkInstall(pkgRoot);
      if (!chk.ok) log(`⚠ ${chk.error}——请重新安装：npm i -g @wendongfly/myhi@latest（Windows 先把 myhi 目录加入杀毒软件信任区）`);
    }
    setTimeout(startServer, delay);
  });
}

// 让 server 自己收尾后退出（保存会话、停掉 claude 子进程）。Windows 上 kill('SIGTERM') 等于直接结束进程，
// server 的 SIGTERM 处理根本不执行 → 改走 IPC 让它自己退；4 秒没退再 SIGTERM，8 秒强杀。
function stopChild(cb) {
  const c = child;
  child = null; // 清引用，防止 exit handler 当成崩溃再拉起
  if (!c) { cb?.(); return; }
  let done = false;
  c.once('exit', () => { if (!done) { done = true; cb?.(); } });
  try { if (c.connected) c.send({ type: 'shutdown' }); else c.kill('SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch {} }
  setTimeout(() => { if (!done) { try { c.kill('SIGTERM'); } catch {} } }, 4000);
  setTimeout(() => { if (!done) { try { c.kill('SIGKILL'); } catch {} } }, 8000);
}

function doRestart() {
  if (upgrading) { log('升级进行中，忽略重启请求'); return; }
  log('收到重启请求');
  restarting = true;
  crashCount = 0;
  stopChild(() => { restarting = false; setTimeout(startServer, 500); });
}

// 停服升级：先让 server 退出（释放 node-pty 的 pty.node，Windows 上它被占用时 npm 覆盖会 EBUSY、
// 装出半成品），再 npm install，装完校验文件齐全 + 版本对，最后拉起 server。
// 不论成败都拉起 server（失败时 npm 一般已回滚，旧版照常跑）；结果写 upgrade-status.json 给网页看。
// candidates：server 算好的下载源顺序 [{registry, version}]（官方 → 国内镜像），装失败就换下一个
function doUpgrade(target, candidates) {
  if (upgrading) { log('升级已在进行中，忽略'); return; }
  upgrading = true;
  const from = (() => { try { return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version; } catch { return null; } })();
  log(`收到升级请求（${from} → ${target || 'latest'}），先停 server 释放文件占用...`);
  const list = Array.isArray(candidates) && candidates.length ? candidates : [{ registry: REGISTRIES.official, version: target }];
  const fails = [];
  stopChild(() => tryNext(0));
  function tryNext(i) {
    if (i >= list.length) return finish({ ok: false, from, to: target || null, error: fails.join('\n\n') });
    const c = list[i];
    const cmd = npmUpgradeCmd(pkgRoot, c.registry);   // 同一套 Node 的 npm + 装回 myhi 当前目录（见 install-check.js）
    log(`从${registryName(c.registry)}安装，执行: ` + cmd);
    exec(cmd, { timeout: 600000, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || stdout || err.message).split('\n').filter((l) => l.trim()).slice(-4).join('\n');
        fails.push(`${registryName(c.registry)}：npm install 失败\n${tail}`);
        return tryNext(i + 1);
      }
      const chk = checkInstall(pkgRoot, c.version || target);
      if (!chk.ok) { fails.push(`${registryName(c.registry)}：${chk.error}`); return tryNext(i + 1); }
      finish({ ok: true, from, to: chk.version });
    });
  }
  // 不论成败都拉起 server（失败时 npm 一般已回滚，旧版照常跑）；结果写 upgrade-status.json 给网页看
  function finish(result) {
    result.at = Date.now();
    log(result.ok ? `升级成功：${from} → ${result.to}` : `升级失败：${result.error}`);
    try { writeFileSync(upgradeStatusFile(configDir), JSON.stringify(result, null, 2)); } catch {}
    upgrading = false;
    crashCount = 0;
    startServer();
  }
}

function cleanup() {
  try {
    const savedPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (savedPid === process.pid) unlinkSync(pidFile);
  } catch {}
}

// 信号处理
function shutdown(sig) {
  log(`收到 ${sig}，停止...`);
  stopping = true;
  cleanup();
  stopChild(() => process.exit(0));
  setTimeout(() => process.exit(0), 9000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Windows: 通过 stdin 消息（无 SIGUSR2 支持）
if (process.platform === 'win32') {
  process.on('message', (msg) => {
    if (msg === 'upgrade') doUpgrade();
    else if (msg === 'restart') doRestart();
  });
}

log(`daemon 启动 (PID ${process.pid})`);
// 前台运行的 myhi 网页升级/重启时会拉起本 daemon 接班（MYHI_WAIT_PID=旧进程）：
// 等旧进程退出、端口释放后再起 server，否则新 server 撞端口会改用下一个端口
const waitPid = parseInt(process.env.MYHI_WAIT_PID || '0', 10);
if (waitPid) {
  delete process.env.MYHI_WAIT_PID;
  const t0 = Date.now();
  const tick = () => {
    let alive = false;
    try { process.kill(waitPid, 0); alive = true; } catch {}
    if (alive && Date.now() - t0 < 20000) return setTimeout(tick, 300);
    startServer();
  };
  tick();
} else {
  startServer();
}
