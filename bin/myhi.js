#!/usr/bin/env node
import { spawn, execSync, execFileSync } from 'child_process';
import { connect } from 'net';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import { randomBytes } from 'crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync, symlinkSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 解析 -p / --port 参数
const args = process.argv.slice(2);
let cmd = null;
let httpOnlyFlag = null; // null=不改；true=切 HTTP-only；false=切回 HTTPS
let hostFlag = null; // null=不改；否则持久化监听地址到 config.json（如 Tailscale IP，公网不可达）
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '-p' || args[i] === '--port') && args[i + 1]) {
    process.env.PORT = args[i + 1];
    args.splice(i, 2); i--;
  } else if (args[i].startsWith('--port=')) {
    process.env.PORT = args[i].split('=')[1];
    args.splice(i, 1); i--;
  } else if ((args[i] === '--host' || args[i].startsWith('--host=')) && args[i].includes('=')) {
    hostFlag = args[i].split('=')[1]; args.splice(i, 1); i--;
  } else if (args[i] === '--host' && args[i + 1]) {
    hostFlag = args[i + 1]; args.splice(i, 2); i--;
  } else if (args[i] === '--http' || args[i] === '--no-https') {
    httpOnlyFlag = true; args.splice(i, 1); i--;
  } else if (args[i] === '--https') {
    httpOnlyFlag = false; args.splice(i, 1); i--;
  } else if (!cmd && (args[i] === 'http' || args[i] === 'https')) {
    // 不带横杠也认：`myhi http` / `myhi https`（以前会被当成「前台启动」，协议根本没切）
    httpOnlyFlag = args[i] === 'http'; args.splice(i, 1); i--;
  } else if (!cmd && !args[i].startsWith('-')) {
    cmd = args[i];
  }
}
if (!cmd) cmd = args[0];

// --version / -v：只打印版本号就退出，绝不启动 server（否则会起孤儿进程霸占端口）
if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
    console.log(pkg.version);
  } catch (e) {
    console.error('读取版本失败:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

const configDir = join(homedir(), '.myhi');
const pidFile = join(configDir, 'daemon.pid');
const logFile = join(configDir, 'daemon.log');
const configFile = join(configDir, 'config.json');

// --http / --https：持久化 HTTP-only 开关到 config.json，server 启动时读取（任何重启都保留，
// 不依赖环境变量从 daemon 往下传）。设完若没显式命令，就自动 restart 让它立刻生效。
if (httpOnlyFlag !== null) {
  try {
    mkdirSync(configDir, { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
    cfg.httpOnly = httpOnlyFlag;
    writeFileSync(configFile, JSON.stringify(cfg, null, 2));
    console.log(`[myhi] 已切换为 ${httpOnlyFlag ? 'HTTP（无 TLS，麦克风/摄像头等在非 localhost 会受限）' : 'HTTPS'} 模式，访问地址：${httpOnlyFlag ? 'http' : 'https'}://localhost:${process.env.PORT || 12300}/`);
    console.log(`[myhi] 配置写在 ${configFile}。若 myhi 是被别的程序（如第三方启动器）拉起的、这里改了不生效：在网页 设置 › 服务 › 访问协议 里切`);
  } catch (e) {
    console.error('[myhi] 写入 config.json 失败:', e.message);
    process.exit(1);
  }
  if (!cmd) cmd = 'restart'; // 无显式命令 → 切完直接重启使其生效
}

// --host <addr>：持久化监听地址到 config.json（server 启动时读取，任何重启都保留）。
// 典型用法：`myhi --host <Tailscale IP>` 把 myhi 只绑内网，公网不可达。设完自动 restart。
if (hostFlag !== null) {
  try {
    mkdirSync(configDir, { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
    cfg.host = hostFlag.trim() || undefined; // 空串 = 回到默认 0.0.0.0
    if (!cfg.host) delete cfg.host;
    writeFileSync(configFile, JSON.stringify(cfg, null, 2));
    console.log(`[myhi] 监听地址已设为 ${cfg.host || '0.0.0.0（全部接口）'}，重启后仍保留`);
  } catch (e) {
    console.error('[myhi] 写入 config.json 失败:', e.message);
    process.exit(1);
  }
  if (!cmd) cmd = 'restart';
}

// ── 工具函数 ──────────────────────────────────────────────

function readPid() {
  try { return parseInt(readFileSync(pidFile, 'utf8').trim(), 10); }
  catch { return null; }
}

// 进程状态：alive / denied / dead。
// denied：进程在，但当前权限探测不了 —— Windows 上 myhi 若是在「以管理员身份运行」的命令行里启动的，
// 普通命令行 process.kill(pid, 0) 会得到 EPERM；以前把它当成「不存在」，status 就误报「未运行」
function procState(pid) {
  if (!pid) return 'dead';
  try { process.kill(pid, 0); return 'alive'; }
  catch (e) { return e.code === 'EPERM' ? 'denied' : 'dead'; }
}
function isRunning(pid) { return procState(pid) !== 'dead'; }
const ELEVATED_TIP = process.platform === 'win32'
  ? '请在「以管理员身份运行」的命令行里执行'
  : '请用启动它的同一用户（如 sudo）执行';

// 端口上有没有程序在监听（pid 文件不在 / 不是本账号启动的 myhi 时，用来给出提示）
function portOpen(port) {
  return new Promise((r) => {
    const sk = connect({ port, host: '127.0.0.1' });
    const done = (v) => { sk.destroy(); r(v); };
    sk.once('connect', () => done(true)); sk.once('error', () => done(false));
    sk.setTimeout(1500, () => done(false));
  });
}
function listenerPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true });
      const line = out.split('\n').find((l) => /LISTENING/i.test(l) && new RegExp(':' + port + '\\s').test(l));
      return line ? parseInt(line.trim().split(/\s+/).pop(), 10) || null : null;
    }
    const out = execSync(`ss -ltnp 'sport = :${port}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const m = /pid=(\d+)/.exec(out); return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

function stopDaemon() {
  const serverPidFile = join(configDir, 'server.pid');
  let stopped = false, denied = false;

  // 停止 daemon 进程
  const daemonPid = readPid();
  if (daemonPid && isRunning(daemonPid)) {
    try {
      process.kill(daemonPid, 'SIGTERM');
      try { unlinkSync(pidFile); } catch {}
      console.log(`[myhi] 已停止 daemon (PID ${daemonPid})`);
      stopped = true;
    } catch {
      console.log(`[myhi] 停不掉 daemon (PID ${daemonPid})：权限不够（它可能是以管理员身份或别的账号启动的），${ELEVATED_TIP} myhi stop`);
      denied = true;
    }
  } else if (daemonPid) {
    try { unlinkSync(pidFile); } catch {}
  }

  // 停止 server 进程（普通模式或残留进程）
  try {
    const serverPid = parseInt(readFileSync(serverPidFile, 'utf8').trim(), 10);
    if (serverPid && isRunning(serverPid)) {
      let ok = true;
      try {
        if (process.platform === 'win32') execSync(`taskkill /PID ${serverPid} /F /T`, { stdio: 'pipe', timeout: 5000, windowsHide: true });
        else process.kill(serverPid, 'SIGTERM');
      } catch { ok = false; }
      if (ok) {
        try { unlinkSync(serverPidFile); } catch {}
        console.log(`[myhi] 已停止 server (PID ${serverPid})`);
        stopped = true;
      } else {
        console.log(`[myhi] 停不掉 server (PID ${serverPid})：权限不够（它可能是以管理员身份或别的账号启动的），${ELEVATED_TIP} myhi stop`);
        denied = true;
      }
    } else if (serverPid) {
      try { unlinkSync(serverPidFile); } catch {}
    }
  } catch {}

  if (!stopped && !denied) console.log('[myhi] 没有正在运行的 myhi 进程');
  return stopped;
}

function startDaemon() {
  mkdirSync(configDir, { recursive: true });
  const out = openSync(logFile, 'a');
  // 启动守护进程（daemon.js），由它管理 server 子进程
  const child = spawn(process.execPath, [join(__dirname, 'daemon.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: process.cwd(),
    env: { ...process.env },
    windowsHide: true,
  });
  child.unref();
  console.log(`[myhi] 已在后台启动 (PID ${child.pid})`);

  // 等待 server 启动，显示日志
  let waited = 0;
  const poll = setInterval(() => {
    waited += 500;
    try {
      const content = readFileSync(logFile, 'utf8');
      const lines = content.split('\n');
      // 找到最新的启动信息
      let startIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].includes('━━━━')) { startIdx = i; break; } }
      if (startIdx >= 0) {
        clearInterval(poll);
        // 显示从启动横幅开始的日志
        const recent = lines.slice(Math.max(0, startIdx - 1));
        console.log(recent.join('\n'));
        process.exit(0);
      }
    } catch {}
    if (waited > 10000) {
      clearInterval(poll);
      console.log(`[myhi] 停止: myhi stop`);
      console.log(`[myhi] 日志: myhi log`);
      console.log(`[myhi] 管理: http://localhost:${process.env.PORT || 12300}/admin`);
      process.exit(0);
    }
  }, 500);
}

// ── 命令分发 ──────────────────────────────────────────────

if (cmd === 'attach') {
  process.argv.splice(2, 1);
  await import('../dist/attach.js');

} else if (cmd === 'stop') {
  stopDaemon();

} else if (cmd === 'restart') {
  stopDaemon();
  await new Promise(r => setTimeout(r, 500));
  startDaemon();
  process.exit(0);

} else if (cmd === 'status') {
  const pkgVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;
  const daemonPid = readPid();
  let serverPid = null;
  try { serverPid = parseInt(readFileSync(join(configDir, 'server.pid'), 'utf8').trim(), 10); } catch {}
  const dState = procState(daemonPid), sState = procState(serverPid);
  const daemonAlive = dState !== 'dead';
  const serverAlive = sState !== 'dead';
  if (daemonAlive || serverAlive) {
    const mode = daemonAlive ? 'daemon' : '前台';
    const pid = daemonAlive ? daemonPid : serverPid;
    let httpOnly = false; try { httpOnly = !!JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')).httpOnly; } catch {}
    console.log(`[myhi] v${pkgVersion} 运行中 (${mode}, PID ${pid})，访问地址 ${httpOnly ? 'http' : 'https'}://localhost:${process.env.PORT || 12300}/`);
    if ((daemonAlive ? dState : sState) === 'denied') console.log(`[myhi] 注意：它是以更高权限（管理员 / 别的账号）启动的，${ELEVATED_TIP} myhi stop / restart 才能管理它`);
  } else {
    const port = parseInt(process.env.PORT || '12300', 10);
    if (await portOpen(port)) {
      const lp = listenerPid(port);
      console.log(`[myhi] v${pkgVersion} 本账号没有记录到运行中的 myhi，但端口 ${port} 正在被${lp ? ` PID ${lp} ` : '某个程序'}监听`);
      console.log(`[myhi] 多半是 myhi 以管理员身份、或用另一个系统账号启动的，${ELEVATED_TIP} myhi status / myhi stop`);
      if (process.platform === 'win32' && lp) console.log(`[myhi] 也可以在管理员命令行里直接结束它：taskkill /PID ${lp} /F /T`);
    } else {
      console.log(`[myhi] v${pkgVersion} 未运行`);
    }
  }

} else if (cmd === 'log' || cmd === 'logs') {
  try {
    const content = readFileSync(logFile, 'utf8');
    const lines = content.split('\n');
    const n = parseInt(process.argv[3], 10) || 50;
    console.log(lines.slice(-n).join('\n'));
  } catch {
    console.log('[myhi] 日志文件不存在');
  }

} else if (cmd === 'exclusive') {
  // 独占模式开关
  const { existsSync } = await import('fs');
  const usersFile = join(configDir, 'users.json');
  function loadCfg() {
    try { if (existsSync(usersFile)) return JSON.parse(readFileSync(usersFile, 'utf8')); } catch {}
    return { users: {} };
  }
  function saveCfg(data) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(usersFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  const sub = args[args.indexOf('exclusive') + 1] || process.argv[3];
  if (sub === 'on' || sub === 'enable') {
    const data = loadCfg();
    data.exclusive = true;
    saveCfg(data);
    console.log('[myhi] 独占模式已开启（同一时间只允许一个账号登录）');
  } else if (sub === 'off' || sub === 'disable') {
    const data = loadCfg();
    data.exclusive = false;
    saveCfg(data);
    console.log('[myhi] 独占模式已关闭（允许多人同时登录）');
  } else {
    const data = loadCfg();
    const mode = data.exclusive ? '开启' : '关闭';
    console.log(`[myhi] 独占模式: ${mode}`);
    console.log(`\n用法:
  myhi exclusive on     开启独占模式（同一时间只允许一个账号）
  myhi exclusive off    关闭独占模式（允许多人同时登录）`);
  }

} else if (cmd === 'user') {
  // 用户管理：直接读写 ~/.myhi/users.json，不依赖 src/
  const { existsSync } = await import('fs');
  const usersFile = join(configDir, 'users.json');

  function loadUsersFile() {
    try {
      if (existsSync(usersFile)) return JSON.parse(readFileSync(usersFile, 'utf8'));
    } catch {}
    return { users: {} };
  }
  function saveUsersFile(data) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(usersFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  const sub = args[args.indexOf('user') + 1] || process.argv[3];
  if (sub === 'list' || sub === 'ls') {
    const data = loadUsersFile();
    const entries = Object.entries(data.users || {});
    if (entries.length === 0) {
      console.log('[myhi] 还没有用户，使用 myhi user add <密码> <名称> <目录> 添加');
    } else {
      console.log('\n  密码\t\t名称\t\t目录');
      console.log('  ────\t\t────\t\t────');
      for (const [pwd, info] of entries) {
        const masked = pwd.slice(0, 2) + '*'.repeat(pwd.length - 2);
        console.log(`  ${masked}\t\t${info.name}\t\t${info.dir}`);
      }
      console.log();
    }
  } else if (sub === 'add') {
    const pwd  = process.argv[4];
    const name = process.argv[5];
    const dir  = process.argv[6];
    if (!pwd || !name || !dir) {
      console.log('用法: myhi user add <密码> <名称> <目录>');
      console.log('示例: myhi user add 1234 张三 D:\\project\\app1');
      process.exit(1);
    }
    mkdirSync(dir, { recursive: true });
    // 为用户创建独立的 git 配置（隔离凭据）
    const gitconfigPath = join(dir, '.gitconfig');
    const gitcredPath = join(dir, '.git-credentials');
    if (!existsSync(gitconfigPath)) {
      writeFileSync(gitconfigPath, `[credential]\n\thelper = store --file ${gitcredPath.replace(/\\/g, '/')}\n[user]\n\tname = ${name}\n`, { mode: 0o600 });
      console.log(`[myhi] 已创建 git 配置: ${gitconfigPath}`);
    }
    const data = loadUsersFile();
    data.users[pwd] = { name, dir };
    saveUsersFile(data);
    console.log(`[myhi] 已添加用户 "${name}" (目录: ${dir})`);
  } else if (sub === 'remove' || sub === 'rm') {
    const pwd = process.argv[4];
    if (!pwd) {
      console.log('用法: myhi user remove <密码>');
      process.exit(1);
    }
    const data = loadUsersFile();
    if (data.users[pwd]) {
      delete data.users[pwd];
      saveUsersFile(data);
      console.log(`[myhi] 已删除用户`);
    } else {
      console.log('[myhi] 未找到该密码对应的用户');
    }
  } else {
    console.log(`
用户管理命令:
  myhi user list                      列出所有用户
  myhi user add <密码> <名称> <目录>  添加用户
  myhi user remove <密码>             删除用户

示例:
  myhi user add 1234 张三 D:\\project\\app1
  myhi user add 5678 李四 D:\\project\\app2
  myhi user list
  myhi user remove 1234
`);
  }

} else if (cmd === 'ssh') {
  // SSH 账号管理：为 myhi 用户创建系统 SSH 账号，隔离目录权限
  const { existsSync } = await import('fs');
  const { platform } = await import('os');
  const usersFile = join(configDir, 'users.json');
  const isWindows = platform() === 'win32';

  function loadUsersFile() {
    try { if (existsSync(usersFile)) return JSON.parse(readFileSync(usersFile, 'utf8')); } catch {}
    return { users: {} };
  }
  function saveUsersFile(data) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(usersFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  function run(cmd, opts = {}) {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts }).trim();
    } catch (e) {
      if (!opts.ignoreError) { console.error(`[myhi] 命令失败: ${cmd}\n${e.stderr || e.message}`); process.exit(1); }
      return '';
    }
  }

  // 以参数数组执行，不经 shell：用户名 / 目录 / 密码里的 $()、引号都只是普通字符
  function runArgs(file, args, opts = {}) {
    try {
      return String(execFileSync(file, args, { encoding: 'utf8', stdio: opts.input != null ? ['pipe', 'pipe', 'pipe'] : 'pipe', input: opts.input })).trim();
    } catch (e) {
      if (!opts.ignoreError) { console.error(`[myhi] 命令失败: ${file} ${args.join(' ')}\n${e.stderr || e.message}`); process.exit(1); }
      return '';
    }
  }

  function findUserByName(name) {
    const data = loadUsersFile();
    for (const [pwd, info] of Object.entries(data.users || {})) {
      if (info.name === name) return { pwd, ...info };
    }
    return null;
  }

  const sub = args[args.indexOf('ssh') + 1] || process.argv[3];

  if (sub === 'add' || sub === 'setup') {
    const myName = process.argv[4];
    const sshPass = process.argv[5];
    if (!myName) {
      console.log('用法: myhi ssh add <myhi用户名> [SSH密码]');
      console.log('示例: myhi ssh add 张三 mypassword');
      console.log('\n将为 myhi 用户创建系统 SSH 账号，绑定到该用户的项目目录');
      process.exit(1);
    }

    const user = findUserByName(myName);
    if (!user) { console.log(`[myhi] 未找到 myhi 用户 "${myName}"，请先 myhi user add`); process.exit(1); }

    const dir = user.dir;
    // 目录要是普通的绝对路径：它会被 chown -R / chmod，以 root 执行
    if (!dir || typeof dir !== 'string' || !isAbsolute(dir) || /[\0\r\n]/.test(dir) || dir === '/' || /^[A-Za-z]:\\?$/.test(dir)) {
      console.log(`[myhi] 用户 "${myName}" 的项目目录不合法：${dir || '（空）'}`); process.exit(1);
    }
    // SSH 用户名：myhi-<name> (ASCII 化)
    const rnd = (n) => randomBytes(n).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, n);
    const sshUser = ('myhi-' + myName.replace(/[^a-zA-Z0-9_-]/g, '') || 'myhi-') + (/^[a-zA-Z0-9_-]+$/.test(myName) ? '' : '-' + rnd(4).toLowerCase());
    const sshPassword = sshPass || rnd(16) + 'A1!';
    if (/[:\r\n]/.test(sshPassword)) { console.log('[myhi] SSH 密码不能含冒号或换行'); process.exit(1); }

    console.log(`[myhi] 创建 SSH 账号...`);
    console.log(`  myhi 用户: ${myName}`);
    console.log(`  项目目录:  ${dir}`);
    console.log(`  SSH 用户:  ${sshUser}`);

    if (isWindows) {
      // ── Windows ──
      // 创建本地用户
      runArgs('net', ['user', sshUser, sshPassword, '/add', '/y'], { ignoreError: true });
      runArgs('net', ['user', sshUser, sshPassword, '/y'], { ignoreError: true });

      // 设置目录权限
      mkdirSync(dir, { recursive: true });
      // 上级目录：允许穿越（Traverse）但不允许列目录
      const parent = join(dir, '..');
      runArgs('icacls', [parent, '/grant', `${sshUser}:(RC,S,X,RA,REA)`], { ignoreError: true });
      // 用户自己的目录：完全控制
      runArgs('icacls', [dir, '/grant', `${sshUser}:(OI)(CI)F`]);

      // 在用户 home 下创建 project 符号链接
      const userHome = `C:\\Users\\${sshUser}`;
      if (!existsSync(userHome)) mkdirSync(userHome, { recursive: true });
      const link = join(userHome, 'project');
      if (!existsSync(link)) {
        try { symlinkSync(dir, link, 'dir'); } catch {}
      }

      // 确保 OpenSSH Server 已启动
      run('powershell -Command "Start-Service sshd 2>$null; Set-Service -Name sshd -StartupType Automatic 2>$null"', { silent: true, ignoreError: true });

    } else {
      // ── Linux / Ubuntu ──
      // 创建系统用户，home 指向项目目录
      if (!runArgs('id', ['-u', sshUser], { ignoreError: true })) runArgs('useradd', ['-m', '-d', `/home/${sshUser}`, '-s', '/bin/bash', sshUser], { ignoreError: true });
      runArgs('chpasswd', [], { input: `${sshUser}:${sshPassword}\n` });   // 密码走 stdin，不进命令行

      mkdirSync(dir, { recursive: true });

      // 在用户 home 下创建 project 符号链接
      const homeDir = `/home/${sshUser}`;
      const link = `${homeDir}/project`;
      runArgs('ln', ['-sfn', '--', dir, link], { ignoreError: true });
      runArgs('chown', ['-h', `${sshUser}:${sshUser}`, '--', link], { ignoreError: true });

      // 项目目录：设置为该用户所有
      runArgs('chown', ['-R', `${sshUser}:${sshUser}`, '--', dir], { ignoreError: true });

      // 上级目录权限：移除 others 的读和执行
      const parent = join(dir, '..');
      runArgs('chmod', ['711', '--', parent], { ignoreError: true });
      // 用户自己的目录
      runArgs('chmod', ['700', '--', dir], { ignoreError: true });

      // 确保 SSH 服务运行
      run('systemctl enable ssh 2>/dev/null; systemctl start ssh 2>/dev/null || service ssh start 2>/dev/null', { silent: true, ignoreError: true });
    }

    // 保存 SSH 映射到 users.json
    const data = loadUsersFile();
    if (data.users[user.pwd]) {
      data.users[user.pwd].sshUser = sshUser;
      saveUsersFile(data);
    }

    console.log(`\n  ✓ SSH 账号创建成功！`);
    console.log(`  ┌─────────────────────────────────`);
    console.log(`  │ SSH 用户名: ${sshUser}`);
    console.log(`  │ SSH 密码:   ${sshPassword}`);
    console.log(`  │ 项目目录:   ${dir}`);
    console.log(`  └─────────────────────────────────`);
    console.log(`\n  VS Code 连接方式:`);
    console.log(`    1. 安装 Remote-SSH 扩展`);
    console.log(`    2. 按 F1 → "Remote-SSH: Connect to Host"`);
    console.log(`    3. 输入: ${sshUser}@<服务器IP>`);
    console.log(`    4. 打开目录: ~/project`);

  } else if (sub === 'list' || sub === 'ls') {
    const data = loadUsersFile();
    const entries = Object.entries(data.users || {}).filter(([, info]) => info.sshUser);
    if (entries.length === 0) {
      console.log('[myhi] 还没有 SSH 账号，使用 myhi ssh add <用户名> 创建');
    } else {
      console.log('\n  myhi用户\tSSH账号\t\t\t目录');
      console.log('  ────────\t───────\t\t\t────');
      for (const [, info] of entries) {
        console.log(`  ${info.name}\t\t${info.sshUser}\t\t${info.dir}`);
      }
      console.log();
    }

  } else if (sub === 'remove' || sub === 'rm') {
    const myName = process.argv[4];
    if (!myName) { console.log('用法: myhi ssh remove <myhi用户名>'); process.exit(1); }

    const user = findUserByName(myName);
    if (!user || !user.sshUser) { console.log(`[myhi] 未找到 "${myName}" 的 SSH 账号`); process.exit(1); }

    const sshUser = user.sshUser;
    console.log(`[myhi] 删除 SSH 账号: ${sshUser}`);

    if (isWindows) {
      run(`net user "${sshUser}" /delete`, { silent: true, ignoreError: true });
    } else {
      run(`userdel "${sshUser}" 2>/dev/null`, { silent: true, ignoreError: true });
      // 不删除 home，避免误删项目数据
    }

    const data = loadUsersFile();
    if (data.users[user.pwd]) {
      delete data.users[user.pwd].sshUser;
      saveUsersFile(data);
    }
    console.log(`[myhi] 已删除 SSH 账号 "${sshUser}"（项目目录保留）`);

  } else {
    console.log(`
SSH 账号管理：为 myhi 用户创建独立的 SSH 开发账号

  myhi ssh add <用户名> [密码]    创建 SSH 账号（绑定到 myhi 用户的项目目录）
  myhi ssh list                   列出所有 SSH 账号
  myhi ssh remove <用户名>        删除 SSH 账号（保留项目目录）

示例:
  myhi user add 1234 张三 /data/projects/zhangsan   # 先添加 myhi 用户
  myhi ssh add 张三 sshpass123                       # 再创建 SSH 账号
  myhi ssh list                                      # 查看所有 SSH 账号

员工使用 VS Code Remote-SSH 连接后打开 ~/project 即可开发。
每个用户只能访问自己的项目目录，无法查看其他用户的文件。
`);
  }

} else if (cmd === 'kick') {
  // 踢出会话中的用户
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const { io } = require('socket.io-client');
  const { createInterface } = await import('readline');

  const SERVER = process.env.MYHI_SERVER || 'http://localhost:12300';
  let token;
  try {
    token = readFileSync(join(configDir, 'token'), 'utf8').trim();
  } catch {
    console.log('[myhi] 未找到 token，请先启动服务器');
    process.exit(1);
  }

  const socket = io(SERVER, { auth: { token }, reconnection: false });

  socket.on('connect_error', (err) => {
    console.log(`[myhi] 连接失败: ${err.message}`);
    process.exit(1);
  });

  socket.on('connect', () => {
    // 获取所有会话
    socket.emit('sessions', null, (sessions) => {
      // sessions 事件可能不存在，用 HTTP 回退
    });

    // 通过 HTTP 获取会话列表
    fetch(`${SERVER}/api/sessions?token=${token}`)
      .then(r => r.json())
      .then(async (sessions) => {
        const alive = sessions.filter(s => s.alive);
        if (alive.length === 0) {
          console.log('[myhi] 没有活跃的会话');
          socket.disconnect();
          process.exit(0);
        }

        // 收集所有会话的在线用户
        const allViewers = [];
        for (const session of alive) {
          const result = await new Promise(resolve => {
            socket.emit('join', session.id);
            socket.emit('list-viewers', { sessionId: session.id }, resolve);
          });
          if (result.ok) {
            for (const v of result.viewers) {
              allViewers.push({ ...v, sessionId: session.id, sessionTitle: session.title });
            }
          }
        }

        if (allViewers.length === 0) {
          console.log('[myhi] 没有在线用户');
          socket.disconnect();
          process.exit(0);
        }

        // 去重（同一个 socket 可能只在一个会话中）
        const unique = [...new Map(allViewers.map(v => [v.socketId, v])).values()];

        console.log('\n  在线用户：');
        console.log('  ────────────────────────────────────────');
        unique.forEach((v, i) => {
          const ctrl = v.isController ? ' [控制中]' : '';
          console.log(`  [${i + 1}] ${v.userName} (${v.role})${ctrl}  会话: ${v.sessionTitle}`);
        });
        console.log();

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question('  输入序号踢出用户（0 取消）: ', (answer) => {
          rl.close();
          const idx = parseInt(answer, 10);
          if (!idx || idx < 1 || idx > unique.length) {
            console.log('[myhi] 已取消');
            socket.disconnect();
            process.exit(0);
          }
          const target = unique[idx - 1];
          socket.emit('kick-user', { socketId: target.socketId, sessionId: target.sessionId }, (res) => {
            if (res.ok) {
              console.log(`[myhi] 已踢出用户 "${res.name}"`);
            } else {
              console.log(`[myhi] 踢出失败: ${res.error}`);
            }
            socket.disconnect();
            process.exit(0);
          });
        });
      })
      .catch((err) => {
        console.log(`[myhi] 获取会话失败: ${err.message}`);
        socket.disconnect();
        process.exit(1);
      });
  });

} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  const isMac = process.platform === 'darwin';
  const platform = isWin ? 'Windows' : isMac ? 'macOS' : 'Linux';
  const configPath = isWin ? '%USERPROFILE%\\.myhi\\' : '~/.myhi/';
  const sep = isWin ? '\\' : '/';

  let help = `
myhi — 基于 Web 的终端共享工具 (${platform})
通过局域网或 Tailscale 在手机/平板上控制电脑终端，无需中继服务器。

启动服务：
  myhi                 前台启动服务器
  myhi start           前台启动服务器
  myhi -p <port>       指定监听端口（默认 12300）
  myhi -d              后台启动（日志写入 ${configPath}daemon.log）
  myhi http            切为纯 HTTP（无 TLS）并重启，持久生效（同 --http）
  myhi https           切回 HTTPS（默认）并重启（同 --https）
                       也可在网页 设置 › 服务 › 访问协议 里点选
  myhi stop            停止后台服务器
  myhi restart         重启后台服务器
  myhi status          查看运行状态
  myhi log [N]         查看后台日志（最后 N 行，默认 50）
`;

  if (isLinux) {
    help += `
系统服务（systemd）：
  sudo myhi service install     安装为系统服务（开机自启）
  sudo myhi service uninstall   卸载系统服务
  myhi service status           查看服务状态

  提示: 使用 systemd 管理时，不要混用 myhi -d / myhi stop
        统一用 systemctl start/stop/restart myhi
`;
  }

  help += `
用户管理：
  myhi user list                      列出所有用户
  myhi user add <密码> <名称> <目录>  添加用户
  myhi user remove <密码>             删除用户
  myhi exclusive on                   开启独占模式（一次只能一个账号）
  myhi exclusive off                  关闭独占模式（多人同时使用，默认）
`;

  if (!isWin) {
    help += `
SSH 开发：
  myhi ssh add <用户名> [密码]    为 myhi 用户创建 SSH 账号
  myhi ssh list                   列出所有 SSH 账号
  myhi ssh remove <用户名>        删除 SSH 账号
`;
  }

  help += `
远程连接：
  myhi attach                        交互式选择会话并附加
  myhi attach <id>                   直接附加到指定会话
  myhi attach --new                  创建新会话并附加
  myhi attach --password <密码>      用指定用户身份连接
  myhi kick                          踢出在线用户

快捷键（attach 模式）：
  Ctrl+]               分离终端（退出但不关闭会话）

选项：
  -p, --port <port>    监听端口（默认 12300）

环境变量：
  PORT                 监听端口（默认 12300）
  HOST                 监听地址（默认 0.0.0.0）
  MYHI_AUTO_ATTACH     启动时自动创建会话（默认 1，设 0 关闭）
  MYHI_CWD             会话工作目录（默认当前目录）
  MYHI_SERVER          attach 连接的服务器地址（默认 http://localhost:12300）

配置目录：${configPath}
  token                认证令牌（自动生成）
  password             登录密码（自动生成，可手动修改）
  users.json           独占用户配置
  roles.json           多用户角色配置（可选）
  sessions.json        会话持久化数据
  daemon.pid           后台进程 PID
  daemon.log           后台运行日志

示例：`;

  if (isWin) {
    help += `
  myhi                                # 启动后扫描二维码即可在手机上操作
  myhi -p 8080                        # 指定 8080 端口启动
  myhi -p 8080 -d                     # 8080 端口后台启动
  set MYHI_CWD=D:\\project && myhi     # 指定工作目录
  myhi attach                         # 从另一台机器连接
  myhi user add 1234 张三 D:\\project  # 添加用户`;
  } else if (isLinux) {
    help += `
  myhi                                # 启动后扫描二维码即可在手机上操作
  myhi -p 8080                        # 指定 8080 端口启动
  sudo myhi service install           # 安装为系统服务（推荐）
  MYHI_CWD=/project myhi              # 指定工作目录
  myhi attach                         # 从另一台机器连接
  myhi user add 1234 张三 /home/me   # 添加用户`;
  } else {
    help += `
  myhi                                # 启动后扫描二维码即可在手机上操作
  myhi -p 8080                        # 指定 8080 端口启动
  myhi -p 8080 -d                     # 8080 端口后台启动
  MYHI_CWD=/project myhi              # 指定工作目录
  myhi attach                         # 从另一台机器连接
  myhi user add 1234 张三 /Users/dev  # 添加用户`;
  }

  console.log(help + '\n');

} else if (cmd === 'service') {
  // systemd service 管理
  const subCmd = args[1] || 'install';
  const { execSync: ex } = await import('child_process');

  if (process.platform !== 'linux') {
    console.log('[myhi] service 命令仅支持 Linux (systemd)');
    process.exit(1);
  }

  // 找到 myhi 可执行文件路径
  let myhiBin;
  try { myhiBin = ex('which myhi', { encoding: 'utf8' }).trim(); } catch { myhiBin = '/usr/local/bin/myhi'; }

  // sudo 运行时用 SUDO_USER 获取真实用户
  const user = process.env.SUDO_USER || process.env.USER || 'root';
  let home;
  if (process.env.SUDO_USER) {
    // sudo 时 homedir() 返回 root 的 home，需要查真实用户的 home
    try { home = ex(`getent passwd ${process.env.SUDO_USER}`, { encoding: 'utf8' }).trim().split(':')[5]; } catch { home = `/home/${process.env.SUDO_USER}`; }
  } else {
    home = homedir();
  }
  const cwd = process.env.MYHI_CWD || (process.env.SUDO_USER ? home : process.cwd());
  const port = process.env.PORT || '12300';
  const serviceFile = '/etc/systemd/system/myhi.service';
  // 代理地址（可能带账号密码）、网关地址和 API Key 写进只有 root 能读的环境文件；unit 文件是 0644，谁都能读
  const envFile = '/etc/myhi/myhi.env';
  const ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'];

  // 找到 node 和 daemon.js 的路径，用 Type=simple 直接前台运行 daemon
  let nodeBin;
  try { nodeBin = ex('which node', { encoding: 'utf8' }).trim(); } catch { nodeBin = '/usr/bin/node'; }
  // myhi bin 可能是 symlink，解析真实路径后找到同目录的 daemon.js
  let realMyhiBin;
  try { realMyhiBin = ex(`readlink -f ${myhiBin}`, { encoding: 'utf8' }).trim(); } catch { realMyhiBin = myhiBin; }
  const daemonScript = join(dirname(realMyhiBin), 'daemon.js');

  const unitContent = `[Unit]
Description=myhi - Web Terminal Sharing
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${daemonScript}
ExecStop=${myhiBin} stop
WorkingDirectory=${cwd}
Restart=on-failure
RestartSec=10
User=${user}
Environment=PORT=${port}
Environment=HOME=${home}
EnvironmentFile=-${envFile}

[Install]
WantedBy=multi-user.target
`;

  if (subCmd === 'install') {
    try {
      writeFileSync(serviceFile, unitContent);
      const envLines = ENV_KEYS.filter((k) => process.env[k] && !/[\r\n]/.test(process.env[k])).map((k) => `${k}=${process.env[k]}`);
      mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
      writeFileSync(envFile, envLines.join('\n') + '\n', { mode: 0o600 });
      chmodSync(envFile, 0o600);
    } catch (e) {
      if (e.code === 'EACCES') {
        console.log('[myhi] 需要 root 权限，请使用: sudo myhi service install');
        process.exit(1);
      }
      throw e;
    }
    console.log(`[myhi] 已创建 ${serviceFile}`);
    console.log(`  User: ${user}`);
    console.log(`  Port: ${port}`);
    console.log(`  WorkingDirectory: ${cwd}`);
    console.log(`  ExecStart: ${myhiBin} -d`);

    // 配置 sudoers 让服务用户可以自升级和重启
    if (user !== 'root') {
      const sudoersFile = `/etc/sudoers.d/myhi-${user}`;
      // 只放行参数写死的重启 / 停止。以前还有一条 `npm install -g @wendongfly/myhi*`：sudoers 里的 * 能匹配空格，
      // 追加任意包 / 本地 tarball 就以 root 跑它的安装脚本 → 有终端的人都能提权。网页升级早就不走 sudo npm，故删掉
      const sudoersContent = `# myhi: allow ${user} to restart / stop the service\n${user} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart myhi.service\n${user} ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop myhi.service\n`;
      try {
        writeFileSync(sudoersFile, sudoersContent, { mode: 0o440 });
        console.log(`[myhi] 已配置 sudoers: ${sudoersFile}`);
      } catch {
        console.log(`[myhi] 提示: 如需网页上重启服务，请手动配置 sudoers:`);
        console.log(`  echo '${user} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart myhi.service' | sudo tee ${sudoersFile}`);
      }
    }

    console.log('');
    try {
      ex('systemctl daemon-reload', { stdio: 'inherit' });
      ex('systemctl enable myhi.service', { stdio: 'inherit' });
      ex('systemctl start myhi.service', { stdio: 'inherit' });
      console.log('');
      console.log('[myhi] 服务已启动并设为开机自启');
      console.log('  查看状态: systemctl status myhi.service');
      console.log('  查看日志: journalctl -u myhi -f');
      console.log('  停止服务: sudo systemctl stop myhi.service');
      console.log('  Web 端升级: 会话页 ⬆ 按钮一键升级');
    } catch (e) {
      console.log('[myhi] systemctl 执行失败，请手动运行:');
      console.log('  sudo systemctl daemon-reload');
      console.log('  sudo systemctl enable myhi.service');
      console.log('  sudo systemctl start myhi.service');
    }

  } else if (subCmd === 'uninstall' || subCmd === 'remove') {
    try {
      ex('systemctl stop myhi.service', { stdio: 'pipe' });
      ex('systemctl disable myhi.service', { stdio: 'pipe' });
    } catch {}
    try {
      unlinkSync(serviceFile);
      // 清理 sudoers 与环境文件
      try { unlinkSync(`/etc/sudoers.d/myhi-${user}`); } catch {}
      try { unlinkSync(envFile); } catch {}
      ex('systemctl daemon-reload', { stdio: 'pipe' });
      console.log('[myhi] 已卸载 systemd 服务');
    } catch (e) {
      if (e.code === 'EACCES') {
        console.log('[myhi] 需要 root 权限，请使用: sudo myhi service uninstall');
      } else if (e.code === 'ENOENT') {
        console.log('[myhi] 服务文件不存在');
      } else {
        console.log('[myhi] 卸载失败:', e.message);
      }
    }

  } else if (subCmd === 'status') {
    try {
      ex('systemctl status myhi.service', { stdio: 'inherit' });
    } catch {}

  } else {
    console.log('用法: myhi service [install|uninstall|status]');
  }
  process.exit(0);

} else if (cmd === '-d' || cmd === '--daemon' || cmd === 'daemon') {
  startDaemon();
  process.exit(0);

} else {
  // 默认 / 'start'：前台运行
  await import('../dist/index.js');
}
