/**
 * myhi - 基于 Tailscale 的 Web 终端服务器
 */
import express from 'express';
import { createServer, request as httpRequest } from 'http';
import { createServer as createHttpsServer, request as httpsRequest } from 'https';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, normalize, sep, isAbsolute, extname } from 'path';
import { createRequire } from 'module';
import { randomBytes, createHash } from 'crypto';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, statSync, unlinkSync, renameSync, createReadStream,
  lstatSync, realpathSync, rmSync, openSync, readSync, closeSync, fstatSync, copyFileSync
} from 'fs';
import { execSync, exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { homedir, hostname, networkInterfaces, tmpdir } from 'os';
import QRCode from 'qrcode';
import multer from 'multer';
import { gzipSync } from 'zlib';
import selfsigned from 'selfsigned';
import { SessionManager } from './sessions.js';
import { sweepUploads } from './uploads-gc.js';
import {
  loadRoles, lookupPassword, hasPermission, isMultiUserMode,
  getDefaultRole, loadUsers, lookupUser, isExclusiveMode,
  hasUsers, listUsers, addUser, removeUser, setExclusiveMode, changeUserPassword, isMultiUser, memberRole, isReservedPassword
} from './roles.js';
import { listLocalClaudeSessions, getSessionHealth, getClaudeVersion, resetClaudeLauncher, probeInteractive, findClaude, buildBaseClaudeEnv, gatewaySettingsArgs } from './agent.js';
import { SCENES, SCENE_HINTS, readSceneModels, sceneModel, listGatewayModels, resolveGateway } from './models.js';
import { askAside } from './aside.js';
import { listSkills, packSkill, normalizePack, installPack, skillExists, deleteSkill, saveSkill, encodeShareCode, decodeShareCode, scanPack, scanSecrets, packHash, createShareStore, createSubStore, withRepo, scanRepoDir, publishToRepo } from './skills.js';
import { readTranscript } from './transcript.js';
import { exportPreview, exportTask, readManifest, importPack, PACK_EXT, EXCLUDE_DIRS, bundlePreview, exportBundle, importBundle } from './migrate.js';
import { studioConfig, startJob, getJob, cancelJob, listJobs, jobFile, saveToProject, publicJob, deleteJob as studioDelete, purgeJobs as studioPurge, allJobIds as studioAllIds } from './studio.js';
import * as minutes from './minutes.js';
import { collectZipFiles, writeZip, ZIP_MAX_BYTES, ZIP_MAX_FILES } from './zip.js';
import { secretsOverview, listSecrets, upsertSecret, deleteSecret, upsertManyProject, normCwd } from './secrets.js';
// 环境 / 启动参数变了：给受影响的 AI 任务打标记，它们的下一条消息前用新设置重启 AI 进程（对话保留，见 AgentSession.markEnvDirty）
//   cwd 为空 = 所有任务（全局密钥、网关、场景模型）；否则只标这个项目的任务（项目密钥）
function markEnvDirty(reason, cwd = null) {
  const key = cwd ? normCwd(cwd) : null;
  for (const s of manager._agentSessions?.values?.() || []) {
    if (!key || normCwd(s.cwd) === key) { try { s.markEnvDirty(reason); } catch {} }
  }
}
import { getProjectGuard, setProjectGuard, upsertEntity, deleteEntity, upsertManyEntities, loadAudit } from './pseudo.js';
import { listDrafts, loadDrafts, addDraft, updateDraft, removeDraft, syncSessionTitle, rebindDrafts, reorderDrafts, mergeDrafts, unmergeDraft, buildDraftPrompt, draftDisplayText } from './inbox.js';
import { checkInstall, upgradeStatusFile, npmUpgradeCmd, REGISTRIES, registryName, latestVersion, upgradeCandidates } from '../bin/install-check.js';

// ---------------------------------------------------------------------------
// Constants & Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
let PORT = parseInt(process.env.PORT, 10) || 12300;
// HOST 在下方 _configString('host') 区定义（env > config.json > 0.0.0.0）
const PORT_EXPLICIT = !!process.env.PORT;
const configDir = join(homedir(), '.myhi');
mkdirSync(configDir, { recursive: true });

let httpsServer = null;
let httpServer = null; // HTTP redirect-only（TLS 可用时）或 fallback HTTP（TLS 不可用时）

function getOrCreateCert() {
  const certPath = join(configDir, 'cert.pem');
  const keyPath = join(configDir, 'key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
    } catch {}
  }
  // 优先用纯 Node.js 生成（不依赖系统 openssl，Windows/Linux 均可用）
  try {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'myhi' }], {
      days: 3650, keySize: 2048,
    });
    writeFileSync(certPath, pems.cert, 'utf8');
    writeFileSync(keyPath, pems.private, 'utf8');
    console.log('[myhi] 自签名 HTTPS 证书已生成');
    return { cert: pems.cert, key: pems.private };
  } catch (e) {
    // 降级到 openssl（如果 selfsigned 在极少数环境下失败）
  }
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=myhi"`,
      { stdio: 'pipe', timeout: 10000 }
    );
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch (err) {
    console.warn(`[myhi] 生成 HTTPS 证书失败: ${err.message?.split('\n')[0] || err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single-instance protection
// ---------------------------------------------------------------------------

const pidFile = join(configDir, 'server.pid');
const daemonPidFile = join(configDir, 'daemon.pid');
const IS_DAEMON_CHILD = !!process.env.MYHI_DAEMON;

function killOldProcess(pid, label) {
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (!alive) return true;

  console.log(`[myhi] 检测到已运行的${label} (PID ${pid})，正在停止...`);
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe', timeout: 5000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}

  // 等待最多 5 秒
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    const waitUntil = Date.now() + 200;
    while (Date.now() < waitUntil) {}
  }

  let stillAlive = false;
  try { process.kill(pid, 0); stillAlive = true; } catch {}
  return !stillAlive;
}

(function checkSingleInstance() {
  // 1. 检查是否有 daemon 在运行
  try {
    const daemonPid = parseInt(readFileSync(daemonPidFile, 'utf8').trim(), 10);
    if (daemonPid && daemonPid !== process.pid && daemonPid !== parseInt(process.env.MYHI_DAEMON_PID || '0', 10)) {
      let alive = false;
      try { process.kill(daemonPid, 0); alive = true; } catch {}
      if (alive) {
        if (!IS_DAEMON_CHILD) {
          // 普通模式启动，但 daemon 在运行 → 先停 daemon
          console.log('[myhi] 检测到后台 daemon 在运行，先停止...');
          if (!killOldProcess(daemonPid, 'daemon')) {
            console.error('[myhi] 无法停止 daemon，请先运行: myhi stop');
            process.exit(1);
          }
          try { unlinkSync(daemonPidFile); } catch {}
        }
      }
    }
  } catch {}

  // 2. 检查是否有其他 server 进程在运行
  // 重要：daemon 子进程跳过本步，避免双 daemon 时各自 child 互读 server.pid 互杀的死循环
  // （daemon-level 单例守卫已在 bin/daemon.js 启动时保证全局只剩一个 daemon，
  //  daemon 已经独占管理它的 server child，server-level 互杀守卫反而有害）
  if (!IS_DAEMON_CHILD) {
    try {
      const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        if (!killOldProcess(oldPid, '实例')) {
          console.error(`[myhi] 无法停止旧进程 (PID ${oldPid})，请手动执行：`);
          console.error('  myhi stop');
          console.error(`  或: ${process.platform === 'win32' ? `taskkill /PID ${oldPid} /F` : `kill -9 ${oldPid}`}`);
          process.exit(1);
        }
      }
    } catch {}
  }

  // 3. 检查端口是否被占用（可能是残留的 myhi 或其他程序）
  // 端口检查在 tryListen 的 EADDRINUSE 处理中进行

  // 写入当前 server PID
  writeFileSync(pidFile, String(process.pid));
})();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function cleanupPid() {
  try {
    if (parseInt(readFileSync(pidFile, 'utf8').trim(), 10) === process.pid) {
      unlinkSync(pidFile);
    }
  } catch {}
  // daemon 模式下不清理 daemon.pid（由 daemon.js 管理）
}

function gracefulShutdown() {
  try {
    if (typeof manager !== 'undefined') {
      try { manager.persist(); } catch {}
      for (const s of manager.listSessions()) {
        try { s.kill(); } catch {}
      }
    }
  } catch {}
  cleanupPid();
}

process.on('exit', cleanupPid);
process.on('SIGTERM', () => { gracefulShutdown(); process.exit(0); });
// daemon 要求收尾退出（重启/升级）。Windows 上信号等于强杀、上面的 SIGTERM 处理不会执行，靠这条 IPC 才能存好会话再退
process.on('message', (m) => { if (m?.type === 'shutdown') { gracefulShutdown(); process.exit(0); } });
process.on('SIGINT', () => { gracefulShutdown(); process.exit(0); });
// 一次文件 IO / 连接错误不该把整台服务器连同所有终端会话一起带走。
// 这些错误码都只意味着"这一个请求失败了"，进程状态仍然完好，记日志继续跑。
// （下载端点曾因裸 createReadStream().pipe(res) 无 error 监听，把整个 myhi 打挂）
const RECOVERABLE_ERRNO = new Set([
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT',
  'ENOENT', 'EBUSY', 'EACCES', 'EPERM', 'EISDIR',
  'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_HTTP_HEADERS_SENT',
]);
process.on('uncaughtException', (err) => {
  if (RECOVERABLE_ERRNO.has(err?.code)) {
    console.error(`[myhi] 已忽略可恢复异常(${err.code}):`, err.message);
    return;
  }
  console.error('[myhi] 未捕获异常:', err.message);
  gracefulShutdown();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[myhi] 未处理的 Promise 拒绝:', err);
});

// ---------------------------------------------------------------------------
// Token / Password generation helpers
// ---------------------------------------------------------------------------

function readOrCreate(filePath, generator) {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf8').trim();
    }
  } catch {}
  const value = generator();
  writeFileSync(filePath, value, { mode: 0o600 });
  return value;
}

// 默认外观：新装（第一次运行，还没生成 token / 密码）默认浅色；已经在用的老机器保持原来的深色。
// 只在 config.json 里还没有 defaultTheme 时判定一次并写死，之后不再变。用户自己在设置里选过的以用户为准（浏览器本地）。
(function initDefaultTheme() {
  try {
    const fresh = !existsSync(join(configDir, 'token')) && !existsSync(join(configDir, 'password'));
    const cfg = _readConfig();
    if (cfg.defaultTheme) return;
    cfg.defaultTheme = fresh ? 'light' : 'dark';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg, null, 2));
  } catch {}
})();

const TOKEN = readOrCreate(join(configDir, 'token'), () =>
  randomBytes(16).toString('hex')
);

let PASSWORD = readOrCreate(join(configDir, 'password'), () =>
  String(Math.floor(1000 + Math.random() * 9000))
);

// ---------------------------------------------------------------------------
// Load roles & users
// ---------------------------------------------------------------------------

loadRoles();
loadUsers();

let activeUser = null;

const userSessions = new Map();
userSessions.set(TOKEN, { role: 'admin', name: '管理员', permanent: true });

const SESSION_MAX_AGE = 10080 * 60 * 1000; // 7 days
setInterval(() => {
  const now = Date.now();
  for (const [key, sess] of userSessions) {
    if (sess.permanent) continue;
    if (!sess.lastUsed || now - sess.lastUsed > SESSION_MAX_AGE) {
      userSessions.delete(key);
    }
  }
}, 3600 * 1000);

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function getTailscaleIP() {
  try {
    return execSync('tailscale ip -4', { timeout: 3000, stdio: 'pipe' })
      .toString().trim().split('\n')[0];
  } catch {}

  try {
    if (process.platform === 'win32') {
      const match = execSync('route print 0.0.0.0', { timeout: 3000, stdio: 'pipe' })
        .toString()
        .match(/0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d+\.\d+\.\d+\.\d+)/);
      if (match) return match[1];
    } else {
      try {
        const match = execSync('ip route get 1.1.1.1', { timeout: 3000, stdio: 'pipe' })
          .toString()
          .match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) return match[1];
      } catch {
        const routeOutput = execSync(
          'route -n get default 2>/dev/null || route -n 2>/dev/null',
          { timeout: 3000, stdio: 'pipe' }
        ).toString();
        const ifMatch = routeOutput.match(/interface:\s*(\S+)/i) ||
          routeOutput.match(/0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
        if (ifMatch) {
          const ifaces = networkInterfaces()[ifMatch[1]];
          if (ifaces) {
            const ipv4 = ifaces.find(i => i.family === 'IPv4' && !i.internal);
            if (ipv4) return ipv4.address;
          }
          if (/^\d+\.\d+\.\d+\.\d+$/.test(ifMatch[1])) return ifMatch[1];
        }
      }
    }
  } catch {}

  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// ---------------------------------------------------------------------------
// Cookie-based auth helpers
// ---------------------------------------------------------------------------

function parseCookies(str = '') {
  const cookies = {};
  for (const part of str.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  return cookies;
}

const SESSION_COOKIE = 'myhi_sid';
// HTTP 下用另一个名字：之前在 HTTPS 下登录过，浏览器里留着同名的 Secure cookie，而浏览器不允许
// 普通 http 页面覆盖同名 Secure cookie → 切到 HTTP 后输对密码也登不进（新 cookie 被静默丢弃）
const SESSION_COOKIE_HTTP = 'myhi_sid_h';
const COOKIE_OPTS_BASE = 'HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000';
const isSecureReq = (req) => !!(req?.secure || req?.headers?.['x-forwarded-proto'] === 'https');

function cookieOpts(req) {
  return isSecureReq(req) ? COOKIE_OPTS_BASE + '; Secure' : COOKIE_OPTS_BASE;
}

function setSessionCookie(res, token, req) {
  res.setHeader('Set-Cookie', `${isSecureReq(req) ? SESSION_COOKIE : SESSION_COOKIE_HTTP}=${token || TOKEN}; ${cookieOpts(req)}`);
}
// 退出登录 / 会话失效：两个名字都清
const CLEAR_SESSION_COOKIES = [SESSION_COOKIE, SESSION_COOKIE_HTTP].map((n) => `${n}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);

function getSessionToken(cookieHeader) {
  // HTTPS 下两个都可能带上来：优先用仍然有效的那个
  const c = parseCookies(cookieHeader);
  const cands = [c[SESSION_COOKIE], c[SESSION_COOKIE_HTTP]].filter(Boolean);
  return cands.find((t) => userSessions.has(t)) || cands[0] || null;
}

function hasValidSession(cookieHeader) {
  const token = getSessionToken(cookieHeader);
  if (token && userSessions.has(token)) {
    const sess = userSessions.get(token);
    if (sess) sess.lastUsed = Date.now();
    return true;
  }
  return false;
}

function getUserInfo(cookieHeader) {
  const token = getSessionToken(cookieHeader);
  return token ? userSessions.get(token) : null;
}

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// ── 访问控制（集中在这里，不靠每个路由各自记得检查）──
// 会话归属：与会话列表的可见规则一致（sessions.js list）—— 管理员全可见；其他人只能碰无主会话和自己的会话。
// 以前只有列表做了过滤，拿到别人的会话 id（/api/usage、广播里都有）就能 join / 接管 / 读写文件和密钥。
function canAccessSession(user, sess) {
  if (!sess) return false;
  if (!user || user.role === 'admin') return true;
  return !sess.owner || sess.owner === user.name;
}
function _hasAdminBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && _adminTokens.has(h.slice(7));
}
// 只读账号（viewer）允许的非 GET 请求：登录 / 登出 / 改自己密码 / 个人偏好 / 生成预览和下载票据 / 语音转文字（问一问）
const VIEWER_WRITE_OK = [
  /^\/login$/, /^\/logout$/, /^\/api\/user\/password$/, /^\/api\/prefs$/,
  /^\/api\/files\/[^/]+\/(view-token|zip-ticket)$/, /^\/api\/skills\/(export|preview)$/,
  /^\/api\/voice-transcribe$/, /^\/api\/voice-assist\/organize$/, /^\/api\/admin\//,
];
// 路径里带会话 id 的路由
const SESSION_PATH_RE = /^\/(?:terminal|terminal-raw|qr)\/([^/]+)|^\/api\/(?:migrate|sessions|agent\/history|files|session)\/([^/]+)/;
function sessionDenied(res) { return res.status(403).json({ ok: false, error: '没有访问这个任务的权限' }); }
app.use((req, res, next) => {
  if (_hasAdminBearer(req)) return next();                    // 后台令牌 = 管理员
  if (!hasValidSession(req.headers.cookie)) return next();    // 未登录：交给各路由自己的认证
  const user = getUserInfo(req.headers.cookie);
  if (!user) return next();
  // ① 只读账号：写操作默认全拒（以前只在 socket 里拦，HTTP 接口 viewer 能建会话带 initCmd 执行命令、写 hooks、删文件、推 git）
  if (req.method !== 'GET' && req.method !== 'HEAD' && !hasPermission(user.role, 'operator')
      && !VIEWER_WRITE_OK.some((re) => re.test(req.path))) {
    return res.status(403).json({ ok: false, error: '只读账号不能执行此操作' });
  }
  // ② 会话归属：路径 / query 里的会话 id（请求体里的由 sessBodyGuard 在解析 JSON 后检查）
  const m = SESSION_PATH_RE.exec(req.path);
  for (const id of [m && (m[1] || m[2]), req.query.sessionId]) {
    if (typeof id !== 'string' || !id) continue;
    const sess = manager.get(id);
    if (sess && !canAccessSession(user, sess)) return sessionDenied(res);
  }
  next();
});
// 请求体里的 sessionId：挂在 express.json() 之后
function sessBodyGuard(req, res, next) {
  const id = req.body?.sessionId;
  if (typeof id === 'string' && id && !_hasAdminBearer(req)) {
    const sess = manager.get(id);
    if (sess && !canAccessSession(getUserInfo(req.headers.cookie), sess)) return sessionDenied(res);
  }
  next();
}

// HTTP-only 开关：环境变量 MYHI_NO_HTTPS（兼容）或 ~/.myhi/config.json 的 httpOnly（`myhi --http`
// 持久化）。监听地址同理：HOST 环境变量优先，否则 config.json 的 host（`myhi --host <addr>` 持久化，
// 用于把 myhi 只绑在 Tailscale 内网地址上、公网不可达）。
// 读 config.json（不存在/坏了返回 {}）。剥掉开头的 UTF-8 BOM：Windows 用户用记事本 / PS5.1
// `Set-Content -Encoding UTF8` 手改后必带 BOM，JSON.parse 会抛错 → 配置静默回落默认值。
function _readConfig() {
  try { return JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')) || {}; }
  catch { return {}; }
}
// 读 config.json 里的字符串字段（不存在/类型不对返回 null）
function _configString(key) {
  const v = _readConfig()[key];
  return typeof v === 'string' && v ? v : null;
}
const HOST = process.env.HOST || _configString('host') || '0.0.0.0';
const _tlsOpts = (process.env.MYHI_NO_HTTPS || _readConfig().httpOnly) ? null : getOrCreateCert();
if (_tlsOpts) {
  // HTTPS 是主服务器，挂 full app + socket.io
  httpsServer = createHttpsServer(_tlsOpts, app);
  // HTTP 只做 301 重定向，不挂 socket.io 也不挂 app
  httpServer = createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
    res.end();
  });
} else {
  // 设置里选了 HTTP（config.json httpOnly / 环境变量 MYHI_NO_HTTPS），或 TLS 不可用（如 openssl 缺失）降级
  if (process.env.MYHI_NO_HTTPS || _readConfig().httpOnly) console.log('[myhi] 按设置以 HTTP 模式运行（手机等非本机浏览器不能用麦克风 / 摄像头）；切回 HTTPS：网页 设置 › 服务 › 访问协议，或 myhi --https');
  else console.warn('[myhi] TLS 不可用，以 HTTP 模式运行（麦克风/摄像头等浏览器安全功能受限）');
  httpServer = createServer(app);
}

// Node 默认 keepAliveTimeout=5s：空闲连接一到期服务端就关，浏览器若恰好在这瞬间
// 复用该连接发请求（尤其 POST，浏览器不会自动重试），fetch 直接报
// TypeError: Failed to fetch —— 症状就是「存草稿偶尔失败」。拉长窗口避开这个竞态。
for (const _s of [httpsServer, httpServer]) {
  if (_s) { _s.keepAliveTimeout = 72000; _s.headersTimeout = 76000; }
}

const _corsAllowed =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)(:\d+)?$/;

const io = new Server({
  // 消息压缩（WebSocket permessage-deflate）：进任务时推的历史动辄几百 KB～1MB，压缩后约 1/3；
  // 网络一般时这是首屏和断线重连最大的一笔。1KB 以下的小消息（流式文字增量）不压，省 CPU
  perMessageDeflate: { threshold: 1024 },
  // 关闭 socket.io 自带的 client JS serve：它内部走 path.join(__dirname, '../client-dist/', f)，
  // ncc 打包后 __dirname=<install>/dist/，结果找到 <install>/client-dist/ 这个不存在的目录，
  // stream ENOENT 中途断连导致浏览器 ERR_EMPTY_RESPONSE。改由下面的 express.static 显式服务。
  serveClient: false,
  cors: {
    origin: (origin, cb) => {
      if (!origin || _corsAllowed.test(origin)) return cb(null, true);
      cb(new Error('CORS 不允许此来源'), false);
    },
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 5e6,
});
if (httpsServer) {
  io.attach(httpsServer);
} else {
  io.attach(httpServer);
}

// ---------------------------------------------------------------------------
// SessionManager instantiation
// ---------------------------------------------------------------------------

const manager = new SessionManager();

// ---------------------------------------------------------------------------
// Auto-attach terminal window
// ---------------------------------------------------------------------------

const AUTO_ATTACH = process.env.MYHI_AUTO_ATTACH !== '0';
const _autoSpawned = new Set();

function spawnLocalTerminal(sessionId, title) {
  if (!AUTO_ATTACH || _autoSpawned.has(sessionId) ||
    (!process.env.DISPLAY && process.platform === 'linux')) return;

  _autoSpawned.add(sessionId);

  const attachScript = join(__dirname, 'attach.js');
  const nodeExe = process.execPath;
  const windowTitle = title || 'myhi';

  if (process.platform === 'win32') {
    const cmd = `"${nodeExe}" "${attachScript}" ${sessionId}`;
    const proc = spawn('wt.exe', [
      '-w', '0', 'new-tab', '--title', windowTitle, '--',
      'cmd', '/k', cmd
    ], { detached: true, stdio: 'ignore' });
    proc.unref();
    proc.on('error', (err) => {
      console.warn('[attach] wt.exe 失败，回退到 cmd:', err.message);
      spawn('cmd.exe', ['/c', 'start', `"${windowTitle}"`, 'cmd', '/k', cmd], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    });
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "${nodeExe} ${attachScript} ${sessionId}"`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const cmd = `${nodeExe} "${attachScript}" ${sessionId}`;
    for (const [bin, args] of [
      ['gnome-terminal', ['--', 'bash', '-c', `${cmd}; exec bash`]],
      ['xterm', ['-title', windowTitle, '-e', cmd]],
      ['konsole', ['--new-tab', '-e', cmd]],
    ]) {
      const proc = spawn(bin, args, { detached: true, stdio: 'ignore' });
      proc.unref();
      proc.on('error', () => {});
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Upload directory
// ---------------------------------------------------------------------------

const uploadDir = join(configDir, 'uploads');
mkdirSync(uploadDir, { recursive: true });

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function checkAuth(req, res, next) {
  const queryToken = req.query.token;

  // Token in query string (e.g. QR code link)
  if (queryToken && (queryToken === TOKEN || userSessions.has(queryToken))) {
    const sess = userSessions.get(queryToken);
    if (sess?.onetime) {
      userSessions.delete(queryToken);
      const newToken = randomBytes(16).toString('hex');
      const { onetime, permanent, ...ident } = sess;
      userSessions.set(newToken, { ...ident, lastUsed: Date.now() });
      setSessionCookie(res, newToken, req);
    } else {
      setSessionCookie(res, queryToken === TOKEN ? TOKEN : queryToken, req);
    }
    // Redirect without token param
    const remainingParams = Object.keys(req.query).filter(k => k !== 'token');
    const cleanPath = req.path + (
      remainingParams.length
        ? '?' + new URLSearchParams(
            Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'token'))
          )
        : ''
    );
    return res.redirect(cleanPath);
  }

  // Cookie auth
  if (hasValidSession(req.headers.cookie)) {
    if (isExclusiveMode() && activeUser) {
      const token = getSessionToken(req.headers.cookie);
      if (token !== TOKEN) {
        const sess = userSessions.get(token);
        if (!sess || sess.name !== activeUser.name) {
          res.setHeader('Set-Cookie', CLEAR_SESSION_COOKIES);
          return res.redirect('/login');
        }
      }
    }
    return next();
  }

  res.redirect('/login');
}

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);

function pkgDirSafe(pkg) {
  try {
    return dirname(_require.resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
}

const libDir = join(__dirname, 'lib');
const staticOpts = { maxAge: 86400000 }; // 1 day

// 各页面（含登录页，所以不要登录）在 <head> 最前面同步加载：浏览器没选过主题时用这里的默认值，首屏不闪
app.get('/theme.js', (req, res) => {
  const t = _configString('defaultTheme');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`window.MYHI_DEFAULT_THEME=${JSON.stringify(['light', 'dark', 'black', 'system'].includes(t) ? t : 'dark')};`);
});

app.use('/lib/xterm',
  express.static(pkgDirSafe('xterm') || join(libDir, 'xterm'), staticOpts));
app.use('/lib/xterm-fit',
  express.static(pkgDirSafe('xterm-addon-fit') || join(libDir, 'xterm-fit'), staticOpts));
app.use('/lib/xterm-links',
  express.static(pkgDirSafe('xterm-addon-web-links') || join(libDir, 'xterm-links'), staticOpts));

// socket.io client JS：必须用非 /socket.io/ 路径！engine.io 6 把 /socket.io/ 整段
// 路径前缀都接管去做 transport 校验，缺 ?EIO=&transport= 直接 400 Bad Request，
// Express 中间件根本接不到。改挂在 /sio-client/ 下，HTML 里 <script src> 也对齐。
app.use('/sio-client',
  express.static(join(__dirname, 'client-dist'), {
    maxAge: '1h',
    index: false,
    setHeaders: (res, p) => {
      if (p.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    },
  }));

// 顶层资源 (manifest.json / icon)：build.js 已复制进 dist/，这里加显式路由避免 PWA 加载 404
app.get('/manifest.json', (req, res) => res.sendFile(join(__dirname, 'manifest.json')));
app.get('/icon.png', (req, res) => res.sendFile(join(__dirname, 'icon.png')));
app.get('/icon.svg', (req, res) => res.sendFile(join(__dirname, 'icon.svg')));

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------

const _loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 300 * 1000; // 5 min

function checkLoginRate(ip) {
  const now = Date.now();
  const entry = _loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) return true;
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = _loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    _loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_LOCKOUT_MS });
  } else {
    entry.count++;
  }
}

function clearLoginFailures(ip) {
  _loginAttempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _loginAttempts) {
    if (now > entry.resetAt) _loginAttempts.delete(ip);
  }
}, 600 * 1000);

// ---------------------------------------------------------------------------
// Login / Logout routes
// ---------------------------------------------------------------------------

app.get('/login', (req, res) => {
  sendPage(req, res, 'login.html');
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip;
  if (!checkLoginRate(ip)) {
    return res.redirect('/login?error=locked');
  }

  loadRoles();
  loadUsers();

  const password = req.body?.password;
  const from = req.query.from;
  // 只许站内路径：浏览器把 /\evil.com 当成 //evil.com，以前只拦了 // → 开放重定向
  const redirectTo = (typeof from === 'string' && /^\/(?![\/\\])/.test(from) && !/[\r\n]/.test(from)) ? from : '/';

  // 先认账号密码（users.json）。不是账号密码再往下认 roles.json / 管理密码 —— 以前有账号时
  // 直接判错，管理员在首页用管理密码反而登不进（/admin 上写着「管理密码登录权限不变」）
  const user = hasUsers() ? lookupUser(password) : null;
  if (user) {
    if (isExclusiveMode() && activeUser && activeUser.name !== user.name) {
      return res.redirect('/login?error=occupied&user=' + encodeURIComponent(activeUser.name));
    }
    clearLoginFailures(ip);
    const sessionToken = randomBytes(16).toString('hex');
    // member：账号登录的标记 —— 单用户 / 多用户切换时据此改角色（syncMemberRoles）
    userSessions.set(sessionToken, {
      role: memberRole(), member: true, name: user.name, dir: user.dir, lastUsed: Date.now(),
    });
    if (isExclusiveMode()) {
      if (activeUser) {
        activeUser.tokens.add(sessionToken);
      } else {
        activeUser = {
          name: user.name, dir: user.dir,
          tokens: new Set([sessionToken]), loginAt: Date.now(),
        };
      }
    }
    setSessionCookie(res, sessionToken, req);
    console.log(`[登录] ${user.name} 登录（${!isMultiUser() ? '单用户' : isExclusiveMode() ? '独占' : '共享'}模式）`);
    return res.redirect(redirectTo);
  }

  // Check roles.json passwords
  const roleUser = lookupPassword(password);
  if (roleUser) {
    clearLoginFailures(ip);
    const sessionToken = randomBytes(16).toString('hex');
    userSessions.set(sessionToken, {
      role: roleUser.role, name: roleUser.name, lastUsed: Date.now(),
    });
    setSessionCookie(res, sessionToken, req);
    return res.redirect(redirectTo);
  }

  // Check global password
  if (password === PASSWORD) {
    clearLoginFailures(ip);
    const sessionToken = randomBytes(16).toString('hex');
    userSessions.set(sessionToken, {
      role: 'admin', name: '管理员', lastUsed: Date.now(),
    });
    setSessionCookie(res, sessionToken, req);
    return res.redirect(redirectTo);
  }

  recordLoginFailure(ip);
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  const token = getSessionToken(req.headers.cookie);
  if (token) {
    if (activeUser && activeUser.tokens.has(token)) {
      activeUser.tokens.delete(token);
      if (activeUser.tokens.size === 0) {
        console.log(`[退出] ${activeUser.name} 全部设备退出，释放登录状态（会话保留）`);
        activeUser = null;
      } else {
        console.log(`[退出] ${activeUser.name} 一个设备退出（剩余 ${activeUser.tokens.size} 个）`);
      }
    }
    userSessions.delete(token);
  }
  res.setHeader('Set-Cookie', CLEAR_SESSION_COOKIES);
  res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Status route (public, no auth)
// ---------------------------------------------------------------------------

app.get('/api/status', (req, res) => {
  if (isExclusiveMode() && activeUser) {
    return res.json({
      occupied: true,
      userName: activeUser.name,
      releasing: !!_exclusiveReleaseTimer,
    });
  }
  if (isMultiUser() && !isExclusiveMode()) {
    const online = new Set();
    for (const [, socket] of io.sockets.sockets) {
      if (!socket.data.userName || socket.data.userName === '管理员') continue;
      const cookie = socket.handshake.headers.cookie;
      if (cookie && !hasValidSession(cookie)) continue;
      online.add(socket.data.userName);
    }
    return res.json({ occupied: false, onlineUsers: [...online] });
  }
  res.json({ occupied: false });
});

// ---------------------------------------------------------------------------
// Admin page (no auth required for page itself)
// ---------------------------------------------------------------------------

// 页面文件：构建时已预压缩成 .gz（scripts/build.js），浏览器支持 gzip 就发压缩版（chat.html 490KB → 约 130KB）
// 压缩版是否与 html 对得上：核对 gzip 尾部记录的原文件大小（ISIZE）。不能比修改时间——npm 安装按任意顺序解压，
// .gz 常比 .html 早写几百毫秒，按时间判会把每个 npm 装的版本都当成「过时」、压缩永不生效（1.3.203 实机踩到）
const _gzFresh = new Map();   // file → { key, ok }
function gzFresh(file) {
  try {
    const st = statSync(file);
    const key = st.size + ':' + st.mtimeMs;
    const c = _gzFresh.get(file);
    if (c && c.key === key) return c.ok;
    const fd = openSync(file + '.gz', 'r');
    const b = Buffer.alloc(4);
    try { readSync(fd, b, 0, 4, fstatSync(fd).size - 4); } finally { closeSync(fd); }
    const ok = b.readUInt32LE(0) === (st.size >>> 0);
    _gzFresh.set(file, { key, ok });
    return ok;
  } catch { return false; }
}
function sendPage(req, res, name) {
  const file = join(__dirname, name);
  if (gzFresh(file) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    return res.sendFile(file + '.gz');
  }
  res.sendFile(file);
}
app.get('/admin', (req, res) => sendPage(req, res, 'admin.html'));

// ---------------------------------------------------------------------------
// Protected routes — pages
// ---------------------------------------------------------------------------

app.get('/', checkAuth, (req, res) =>
  sendPage(req, res, 'index.html'));

app.get('/terminal/:id', checkAuth, (req, res) =>
  sendPage(req, res, 'chat.html'));

app.get('/grid', checkAuth, (req, res) =>
  sendPage(req, res, 'grid.html'));

// ── 出图（/studio）：填需求 → 云端出图 → 文字比对 + 看图复核 → 不合格自动重生成，见 src/studio.js ──
app.get('/studio', checkAuth, (req, res) => sendPage(req, res, 'studio.html'));
// 能保存到的项目：自己能看到的 AI 任务的项目目录（去重）
function studioProjects(req) {
  const user = getUserInfo(req.headers.cookie);
  const seen = new Map();
  for (const s of manager.list(user?.name, !user || user.role === 'admin')) {
    if (s.mode !== 'agent' || !s.cwd || seen.has(s.cwd)) continue;
    seen.set(s.cwd, { cwd: s.cwd, name: String(s.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop(), title: s.title || '' });
  }
  return [...seen.values()];
}
const studioOwner = (req) => getUserInfo(req.headers.cookie)?.name || null;
const studioCanSee = (req, job) => { const u = getUserInfo(req.headers.cookie); return !!job && (!u || u.role === 'admin' || job.owner === u.name); };
app.get('/api/studio/config', checkAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await studioConfig()), projects: studioProjects(req) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/studio/jobs', checkAuth, express.json({ limit: '12mb' }), sessBodyGuard, async (req, res) => {   // 可带参考图（data URI）
  const user = getUserInfo(req.headers.cookie);
  if (user && !hasPermission(user.role, 'operator')) return res.status(403).json({ ok: false, error: '只读账号不能出图' });
  const body = req.body || {};
  if (body.saveTo && !studioProjects(req).some((p) => p.cwd === body.saveTo)) return res.status(400).json({ ok: false, error: '只能保存到你的任务所在的项目' });
  try { const job = await startJob(body, { owner: studioOwner(req) }); res.json({ ok: true, job: publicJob(job) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/studio/jobs', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  res.json({ ok: true, jobs: listJobs({ owner: user?.name || null, all: !user || user.role === 'admin' }) });
});
app.get('/api/studio/jobs/:id', checkAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!studioCanSee(req, job)) return res.status(404).json({ ok: false, error: '找不到这次出图' });
  res.json({ ok: true, job: publicJob(job) });
});
app.get('/api/studio/jobs/:id/file/:name', checkAuth, (req, res) => {
  const job = getJob(req.params.id);
  const f = studioCanSee(req, job) && jobFile(job, req.params.name);
  if (!f) return res.status(404).end();
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((job.need.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || '出图') + '-' + req.params.name)}`);
  res.sendFile(f);
});
app.post('/api/studio/jobs/:id/cancel', checkAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!studioCanSee(req, job)) return res.status(404).json({ ok: false, error: '找不到这次出图' });
  cancelJob(job.id); res.json({ ok: true });
});
// ── 删除历史（出图 / 语音共用）：成员只能删自己的，管理员能删全部；进行中的不删 ──
// DELETE /api/<kind>/jobs/:id 删一条；POST /api/<kind>/jobs/delete { ids:[…] } 删几条，{ all:true } 清空自己能看到的全部
function historyDeleteRoutes(kind, mod, notFound) {
  app.delete(`/api/${kind}/jobs/:id`, checkAuth, (req, res) => {
    const job = mod.getJob(req.params.id);
    if (!studioCanSee(req, job)) return res.status(404).json({ ok: false, error: notFound });
    try { mod.deleteJob(job); res.json({ ok: true }); }
    catch (e) { res.status(409).json({ ok: false, error: e.message }); }
  });
  app.post(`/api/${kind}/jobs/delete`, checkAuth, express.json(), (req, res) => {
    const user = getUserInfo(req.headers.cookie);
    const ids = req.body?.all === true
      ? mod.allJobIds({ owner: user?.name || null, all: !user || user.role === 'admin' })
      : (Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 1000) : []);
    let deleted = 0, busy = 0;
    for (const id of ids) {
      const job = mod.getJob(id);
      if (!studioCanSee(req, job)) continue;
      try { if (mod.deleteJob(job)) deleted++; } catch { busy++; }
    }
    if (deleted) console.log(`[${kind}] ${user?.name || '管理员'} 删除了 ${deleted} 条历史`);
    res.json({ ok: true, deleted, busy });
  });
}
historyDeleteRoutes('studio', { getJob, deleteJob: studioDelete, allJobIds: studioAllIds }, '找不到这次出图');

// ── 会议纪要（/minutes）：上传会议录音 → 转写并区分发言人 → AI 生成纪要，见 src/minutes.js ──
app.get('/minutes', checkAuth, (req, res) => sendPage(req, res, 'minutes.html'));
const minutesTmp = join(configDir, 'minutes', 'tmp');
const minutesGet = (req, res) => {
  const job = minutes.getJob(req.params.id);
  if (!studioCanSee(req, job)) { res.status(404).json({ ok: false, error: '找不到这份纪要' }); return null; }
  return job;
};
app.get('/api/minutes/config', checkAuth, (req, res) => {
  res.json({ ok: true, asr: minutes.asrUrls().length > 0, model: sceneModel('minutes') || sceneModel('main') || '', projects: studioProjects(req), maxBytes: minutes.MAX_AUDIO });
});
app.post('/api/minutes/jobs', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  if (user && !hasPermission(user.role, 'operator')) return res.status(403).json({ ok: false, error: '只读账号不能整理会议纪要' });
  mkdirSync(minutesTmp, { recursive: true });
  multer({ dest: minutesTmp, limits: { fileSize: minutes.MAX_AUDIO } }).single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? '录音文件超过 1GB' : err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: '没有收到录音文件' });
    const b = req.body || {};
    // multer 把 multipart 文件名按 latin1 解码：中文名转回 UTF-8
    const origName = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8');
    try {
      // 上传只做识别（转写 + 区分发言人）；参会人 / 整理要求在识别完成后填，每次生成一版纪要
      const job = minutes.createJob({ tmpPath: req.file.path, origName, title: b.title, meetingDate: b.meetingDate, attendees: b.attendees, focus: b.focus, spkNum: b.spkNum }, { owner: user?.name || null });
      console.log(`[纪要] 新建「${job.title}」${job.audio.name}（${Math.round(job.audio.size / 1048576)}MB）`);
      res.json({ ok: true, job: minutes.publicJob(job) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
});
app.get('/api/minutes/jobs', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  res.json({ ok: true, jobs: minutes.listJobs({ owner: user?.name || null, all: !user || user.role === 'admin' }) });
});
historyDeleteRoutes('minutes', minutes, '找不到这份纪要');
app.get('/api/minutes/jobs/:id', checkAuth, (req, res) => { const job = minutesGet(req, res); if (job) res.json({ ok: true, job: minutes.publicJob(job) }); });
app.post('/api/minutes/jobs/:id/speakers', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  minutes.renameSpeakers(job, req.body?.speakers); res.json({ ok: true, job: minutes.publicJob(job) });
});
// 整理一版纪要：按这次填的参会人 / 整理要求生成新版本（不覆盖旧版本）
app.post('/api/minutes/jobs/:id/summarize', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  try { const v = minutes.summarize(job, { attendees: req.body?.attendees, focus: req.body?.focus }); res.json({ ok: true, version: v, job: minutes.publicJob(job) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// 重新识别（可指定发言人数）
app.post('/api/minutes/jobs/:id/retranscribe', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  try { minutes.retranscribe(job, { spkNum: req.body?.spkNum }); res.json({ ok: true, job: minutes.publicJob(job) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put('/api/minutes/jobs/:id/minutes', checkAuth, express.json({ limit: '2mb' }), sessBodyGuard, (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  try { minutes.editVersion(job, String(req.body?.versionId || ''), req.body?.markdown); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/minutes/jobs/:id/versions/:vid', checkAuth, (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  try { minutes.deleteVersion(job, req.params.vid); res.json({ ok: true, job: minutes.publicJob(job) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/minutes/jobs/:id/cancel', checkAuth, (req, res) => { const job = minutesGet(req, res); if (!job) return; minutes.cancelJob(job); res.json({ ok: true }); });
app.get('/api/minutes/jobs/:id/audio', checkAuth, async (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  const p = minutes.audioPath(job);
  if (!existsSync(p)) return res.status(404).json({ ok: false, error: '录音文件不在了' });
  // ?original=1：下载原文件（浏览器播不了的格式用本机播放器听）
  if (req.query.original) {
    res.setHeader('Content-Disposition', `attachment; filename="audio${extname(job.audio.file)}"; filename*=UTF-8''${encodeURIComponent(job.audio.name || job.audio.file)}`);
    return res.sendFile(p, { dotfiles: 'allow', maxAge: 0 });
  }
  // 浏览器播不了的格式（.amr）先转成 WAV（缓存，只转一次）
  let play;
  try { play = await minutes.playableAudio(job); }
  catch (e) { return res.status(415).json({ ok: false, error: e.message }); }
  if (play.mime) res.type(play.mime);
  res.sendFile(play.path, { dotfiles: 'allow', maxAge: 0 });   // ~/.myhi 是点目录，不放行会 404
});
app.get('/api/minutes/jobs/:id/download', checkAuth, (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  const what = req.query.what === 'transcript' ? 'transcript' : 'minutes';
  const v = what === 'minutes' ? minutes.getVersion(job, req.query.v ? String(req.query.v) : null) : null;
  if (what === 'minutes' && !v) return res.status(404).json({ ok: false, error: '还没有纪要' });
  const text = what === 'transcript' ? minutes.transcriptMd(job) : v.markdown || '';
  const name = `${job.meetingDate}-${job.title}-${what === 'transcript' ? '逐字稿' : `纪要-第${v.n}版`}.md`.replace(/[\\/:*?"<>|]+/g, '_');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="minutes.md"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(text);
});
app.post('/api/minutes/jobs/:id/save', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const job = minutesGet(req, res); if (!job) return;
  const cwd = String(req.body?.cwd || '');
  if (!studioProjects(req).some((p) => p.cwd === cwd)) return res.status(400).json({ ok: false, error: '只能保存到你的任务所在的项目' });
  try { res.json({ ok: true, saved: minutes.saveToProject(job, cwd, req.body?.versionId ? String(req.body.versionId) : null) }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/studio/jobs/:id/save', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const job = getJob(req.params.id);
  if (!studioCanSee(req, job)) return res.status(404).json({ ok: false, error: '找不到这次出图' });
  const cwd = String(req.body?.cwd || '');
  if (!studioProjects(req).some((p) => p.cwd === cwd)) return res.status(400).json({ ok: false, error: '只能保存到你的任务所在的项目' });
  try { res.json({ ok: true, saved: saveToProject(job, cwd, Array.isArray(req.body?.files) ? req.body.files : null) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/terminal-raw/:id', checkAuth, (req, res) =>
  sendPage(req, res, 'terminal.html'));

// myhi 自己的前端脚本（machine.js 等）每次都带 ETag 回源确认：缓存一天的话升级后浏览器最长一天还跑旧脚本
// （1.3.189「会话页只显示任务名」上线后标签仍是旧格式即此）。没变化回 304，开销很小。
app.use('/lib', express.static(join(__dirname, 'lib'), { maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// ---------------------------------------------------------------------------
// API routes — sessions
// ---------------------------------------------------------------------------

// ── 任务迁移（见 src/migrate.js）：导出 .myhipack → 带到另一台 myhi → 新建任务 › 从迁移包导入 ──
const migrateTmp = join(configDir, 'migrate-tmp');
const _migrateUploads = new Map();   // token → { file, user, at }；1 小时内要完成导入
try { rmSync(migrateTmp, { recursive: true, force: true }); } catch {}
setInterval(() => {
  for (const [k, v] of _migrateUploads) if (Date.now() - v.at > 3600_000) { try { rmSync(v.file, { force: true }); } catch {} _migrateUploads.delete(k); }
}, 600_000).unref();
// 能不能动这个任务：管理员都行；多用户模式下只能动自己的
function migrateSess(req, res) {
  const user = getUserInfo(req.headers.cookie);
  const sess = manager.get(req.params.id);
  if (!sess || sess.mode !== 'agent') { res.status(404).json({ ok: false, error: '任务不存在' }); return null; }
  if (user && user.role !== 'admin' && sess.owner && sess.owner !== user.name) { res.status(403).json({ ok: false, error: '不能导出别人的任务' }); return null; }
  return sess;
}
app.get('/api/migrate/:id/preview', checkAuth, (req, res) => {
  const sess = migrateSess(req, res); if (!sess) return;
  res.json({ ok: true, ...exportPreview(sess), excludeDirs: EXCLUDE_DIRS });
});
app.get('/api/migrate/:id/export', checkAuth, async (req, res) => {
  const sess = migrateSess(req, res); if (!sess) return;
  const d = new Date(); const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const fname = `${String(sess.title || 'task').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}-${ymd}${PACK_EXT}`;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="myhi-task${PACK_EXT}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  try { await exportTask(sess, { conv: req.query.conv !== '0', mem: req.query.mem !== '0', from: machineName() }, res); }
  catch (e) { console.error('[迁移] 导出失败:', e.message); res.destroy(e); }
  console.log(`[迁移] 导出任务「${sess.title}」(${sess.id}) conv=${req.query.conv !== '0'} mem=${req.query.mem !== '0'}`);
});
// ── 一键打包全部任务（总迁移包）：多用户模式下成员只打包自己的任务，管理员打包全部 ──
function migrateAllSessions(req) {
  const user = getUserInfo(req.headers.cookie);
  return [...manager._agentSessions.values()].filter((s) => s.mode === 'agent' && (!user || user.role === 'admin' || !s.owner || s.owner === user.name));
}
app.get('/api/migrate-all/preview', checkAuth, (req, res) => {
  try { res.json({ ok: true, projects: bundlePreview(migrateAllSessions(req)), excludeDirs: EXCLUDE_DIRS }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/migrate-all/export', checkAuth, async (req, res) => {
  const list = migrateAllSessions(req);
  if (!list.length) return res.status(404).json({ ok: false, error: '没有可以打包的任务' });
  const d = new Date(); const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const fname = `myhi-全部任务-${String(machineName() || 'myhi').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)}-${ymd}${PACK_EXT}`;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="myhi-all${PACK_EXT}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  try { await exportBundle(list, { conv: req.query.conv !== '0', mem: req.query.mem !== '0', from: machineName() }, res); }
  catch (e) { console.error('[迁移] 打包全部失败:', e.message); res.destroy(e); }
  console.log(`[迁移] 打包全部任务 ${list.length} 个 conv=${req.query.conv !== '0'} mem=${req.query.mem !== '0'}`);
});

app.post('/api/migrate/upload', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  if (user && !hasPermission(user.role, 'operator')) return res.status(403).json({ ok: false, error: '你的角色不能导入任务' });
  mkdirSync(migrateTmp, { recursive: true });
  multer({ dest: migrateTmp, limits: { fileSize: 8 * 1024 ** 3 } }).single('pack')(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: '没有收到文件' });
    try {
      const manifest = await readManifest(req.file.path);
      const token = randomBytes(12).toString('hex');
      _migrateUploads.set(token, { file: req.file.path, user: user?.name || null, at: Date.now() });
      res.json({ ok: true, token, manifest, userDir: user?.dir || null });
    } catch (e) {
      try { rmSync(req.file.path, { force: true }); } catch {}
      res.status(400).json({ ok: false, error: /incorrect header|unexpected end|invalid/i.test(e.message) ? '文件不是有效的 myhi 迁移包（可能下载不完整或不是 .myhipack）' : e.message });
    }
  });
});
app.post('/api/migrate/import', checkAuth, express.json(), sessBodyGuard, async (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  const up = _migrateUploads.get(String(req.body?.token || ''));
  if (!up || (up.user && up.user !== (user?.name || null))) return res.status(400).json({ ok: false, error: '上传已过期，请重新选择迁移包' });
  const raw = String(req.body?.cwd || '').trim();
  if (!raw || !isAbsolute(raw)) return res.status(400).json({ ok: false, error: '请填写完整的目标目录（绝对路径）' });
  const cwd = resolve(normalize(raw));
  if (user?.dir) {
    const base = resolve(normalize(user.dir));
    if (cwd !== base && !cwd.startsWith(base + sep)) return res.status(403).json({ ok: false, error: `只能导入到你的目录 ${base} 里` });
  }
  try { if (existsSync(cwd) && readdirSync(cwd).length) return res.status(409).json({ ok: false, error: '目标目录已存在且不是空的。换一个目录名，避免覆盖已有文件' }); } catch {}
  try {
    const { manifest, sid, memory } = await importPack(up.file, cwd);
    const sess = manager.createAgent({
      title: manifest.title || '迁移的任务', cwd, tags: manifest.tags || [], firstUserText: manifest.firstUserText || '',
      resumeSessionId: sid || undefined, owner: user?.name, userDir: user?.dir,
    });
    broadcastSessions();
    try { rmSync(up.file, { force: true }); } catch {}
    _migrateUploads.delete(String(req.body.token));
    console.log(`[迁移] 导入任务「${manifest.title}」→ ${cwd}（来自 ${manifest.from || '?'}，对话=${!!sid}）`);
    res.json({ ok: true, id: sess.id, conv: !!sid, memory, secrets: manifest.secrets || [] });
  } catch (e) {
    console.error('[迁移] 导入失败:', e.message);
    res.status(500).json({ ok: false, error: '导入失败：' + e.message });
  }
});

// 总迁移包批量导入：root 下每个项目一个子目录（名字可改）；已存在且非空的跳过、不覆盖
app.post('/api/migrate/import-all', checkAuth, express.json(), sessBodyGuard, async (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  const token = String(req.body?.token || '');
  const up = _migrateUploads.get(token);
  if (!up || (up.user && up.user !== (user?.name || null))) return res.status(400).json({ ok: false, error: '上传已过期，请重新选择迁移包' });
  const raw = String(req.body?.root || '').trim();
  if (!raw || !isAbsolute(raw)) return res.status(400).json({ ok: false, error: '请填写完整的目标根目录（绝对路径）' });
  const root = resolve(normalize(raw));
  if (user?.dir) {
    const base = resolve(normalize(user.dir));
    if (root !== base && !root.startsWith(base + sep)) return res.status(403).json({ ok: false, error: `只能导入到你的目录 ${base} 里` });
  }
  let manifest;
  try { manifest = await readManifest(up.file); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  if (!manifest.myhiBundle) return res.status(400).json({ ok: false, error: '这不是「全部任务」的总迁移包' });
  const pick = req.body?.projects && typeof req.body.projects === 'object' ? req.body.projects : {};   // { p0: '文件夹名' }，没列 = 不导入
  const clean = (n) => String(n || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  const targets = {}, skipped = [], used = new Set();
  for (const p of manifest.projects || []) {
    if (!(p.key in pick)) continue;
    const name = clean(pick[p.key]) || clean(p.name) || p.key;
    const dir = join(root, name);
    if (used.has(dir.toLowerCase())) { skipped.push({ key: p.key, name, reason: '和包里另一个项目用了同一个文件夹名，请改个名字' }); continue; }
    try { if (existsSync(dir) && readdirSync(dir).length) { skipped.push({ key: p.key, name, reason: `${dir} 已存在且不是空的，没有覆盖` }); continue; } } catch {}
    used.add(dir.toLowerCase());
    targets[p.key] = dir;
  }
  if (!Object.keys(targets).length) return res.status(409).json({ ok: false, error: '没有可以导入的项目', skipped });
  try {
    const results = await importBundle(up.file, targets);
    const created = [];
    for (const r of results) {
      for (const t of r.tasks) {
        const sess = manager.createAgent({
          title: t.title || '迁移的任务', cwd: r.cwd, tags: t.tags, firstUserText: t.firstUserText,
          resumeSessionId: t.sid || undefined, owner: user?.name, userDir: user?.dir,
        });
        created.push({ id: sess.id, title: t.title, cwd: r.cwd, conv: !!t.sid });
      }
    }
    broadcastSessions();
    try { rmSync(up.file, { force: true }); } catch {}
    _migrateUploads.delete(token);
    const secrets = [...new Set(results.flatMap((r) => r.secrets || []))];
    const memory = results.reduce((a, r) => ({ written: a.written + r.memory.written, kept: a.kept + r.memory.kept }), { written: 0, kept: 0 });
    console.log(`[迁移] 批量导入 ${results.length} 个项目、${created.length} 个任务 → ${root}（来自 ${manifest.from || '?'}，跳过 ${skipped.length}）`);
    res.json({ ok: true, projects: results.length, created, skipped, memory, secrets });
  } catch (e) {
    console.error('[迁移] 批量导入失败:', e.message);
    res.status(500).json({ ok: false, error: '导入失败：' + e.message });
  }
});

app.get('/api/sessions', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  res.json(manager.list(user?.name, user?.role === 'admin'));
});

// 只读 API 的认证：主站 cookie 会话，或后台（/admin）的 Bearer 令牌；不认就 401 JSON（不重定向，fetch 端好处理）
function apiAuth(req, res, next) {
  if (hasValidSession(req.headers.cookie)) return next();
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ') && _adminTokens.has(h.slice(7))) return next();
  res.status(401).json({ error: '未授权' });
}

// 以前不登录也能调：会泄露所有活跃会话的 id / 标题 / 属主 / 花费
app.get('/api/usage', apiAuth, (req, res) => {
  try {
    const agents = manager.listSessions()
      .filter(s => s.mode === 'agent' && s.alive)
      .map(s => ({
        id: s.id, title: s.title, owner: s.owner, usage: s._usage,
      }));

    let rateLimit = null;
    for (const a of agents) {
      if (a.usage?.rateLimitInfo) {
        rateLimit = a.usage.rateLimitInfo;
        break;
      }
    }
    res.json({ rateLimit, activeSessions: agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  // 绑定目录的成员：与 socket 'create' 一致，不能在绑定目录之外建会话（以前这条 HTTP 路径没查，可借此逃出目录）
  let cwd = typeof req.body?.cwd === 'string' && req.body.cwd ? req.body.cwd : null;
  if (user?.dir) {
    const base = resolve(normalize(user.dir));
    const target = cwd ? resolve(normalize(cwd)) : null;
    if (target && target !== base && !target.startsWith(base + sep)) return res.status(403).json({ ok: false, error: '不能在绑定目录之外创建会话' });
    if (!target) cwd = base;
  }
  const session = manager.create({
    ...req.body,
    ...(cwd ? { cwd } : {}),
    owner: user?.name,
    userDir: user?.dir,
  });
  res.status(201).json(session.toJSON());
});

app.delete('/api/sessions/:id', checkAuth, (req, res) => {
  manager.kill(req.params.id);
  res.status(204).end();
});

// 会话体检：列出 agent 会话 + 健康信息（持久化权限模式/大小/图片数）
app.get('/api/sessions/health', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  const sessions = manager
    .listSessions()
    .filter((s) => s.mode === 'agent')
    .filter((s) => !s.owner || !user?.name || s.owner === user.name)
    .map((s) => ({ ...s.toJSON(), health: getSessionHealth(s.claudeSessionId) }));
  res.json({ ok: true, sessions });
});

// 重开为干净会话：断开 --resume 链，下次提问开新 claude 会话（修中毒会话用）
app.post('/api/sessions/:id/reset', checkAuth, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess || sess.mode !== 'agent' || typeof sess.reset !== 'function') {
    return res.status(404).json({ ok: false, error: 'agent 会话不存在' });
  }
  sess.reset();
  console.log(`[reset] 会话 ${sess.id}「${sess.title || ''}」被重开为干净会话（会话体检，by ${getUserInfo(req.headers.cookie)?.name || '管理员'}）`);
  sess.emit('agent:message', {
    type: 'system', subtype: 'info',
    message: '已重开为干净会话，下次提问开启全新对话（旧上下文已断开）',
  });
  broadcastSessions();
  res.json({ ok: true });
});

app.get('/api/claude-sessions', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  res.json(listLocalClaudeSessions(user?.dir));
});

// 从 claude CLI 的 jsonl 分页拉历史消息（消息 > 500 内存上限或需翻看更老的）。
// 1.3.171 起与 socket agent:history 同源（src/transcript.js）——旧实现按「原始行数」
// 切窗口而 offset 是消息条数，辅助记录越多偏得越狠，是「历史重复/漏消息」的根因。
// 返回格式与 agent:history socket 事件兼容，前端复用同一渲染分支。
// 大 JSON（往上翻历史一页常有上百 KB）按需 gzip；小的照常发
function sendJsonMaybeGz(req, res, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  if (buf.length > 4096 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(gzipSync(buf));
  }
  res.end(buf);
}
app.get('/api/agent/history/:sessionId', checkAuth, (req, res) => {
  const sess = manager.get(req.params.sessionId);
  if (!sess || sess.mode !== 'agent') return res.status(404).json({ ok: false, error: '会话不存在' });
  const claudeSid = sess.claudeSessionId;
  if (!claudeSid) return res.json({ ok: true, messages: [], total: 0, hasMore: false });

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const t = readTranscript(claudeSid, { offset, limit });
  sendJsonMaybeGz(req, res, { ok: true, messages: t.messages, total: t.total, hasMore: t.hasMore });
});

// ---------------------------------------------------------------------------
// API routes — directory browser
// ---------------------------------------------------------------------------

app.get('/api/dirs', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: '没有目录浏览权限' });
  }

  const userBase = user.dir ? resolve(normalize(user.dir)) : null;
  const pathSep = process.platform === 'win32' ? '\\' : '/';

  let target = req.query.path || userBase || process.env.MYHI_CWD || homedir();
  let resolved = resolve(normalize(target)).replace(/[/\\]+$/, '');
  if (process.platform === 'win32' && /^[A-Za-z]:$/.test(resolved)) {
    resolved += '\\';
  }

  // Restrict to user's base directory
  if (userBase && !resolved.startsWith(userBase)) {
    resolved = userBase;
  }

  try {
    const dirs = readdirSync(resolved, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => ({
        name: d.name,
        path: resolved.replace(/[/\\]+$/, '') + pathSep + d.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = join(resolved, '..');
    const canGoUp = !userBase ||
      resolve(normalize(parent)).startsWith(userBase);

    res.json({
      current: resolved,
      parent: (canGoUp && parent !== resolved) ? parent : null,
      dirs,
      // Windows：列出可用盘符，到了 C:\ 根上也能换到 D: 等其他盘（受限用户不给，免得跳出 userBase）
      drives: (process.platform === 'win32' && !userBase)
        ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + ':\\').filter((d) => { try { return existsSync(d); } catch { return false; } })
        : [],
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API routes — file management
// ---------------------------------------------------------------------------

function safePath(base, rel) {
  const baseResolved = resolve(normalize(base));
  const target = resolve(normalize(join(base, rel || '')));
  if (target !== baseResolved && !target.startsWith(baseResolved + sep)) return null;
  try {
    const realBase = realpathSync(baseResolved);
    const realTarget = existsSync(target) ? realpathSync(target) : target;
    if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) return null;
  } catch {}
  return target;
}

function walkFiles(dir, prefix, files = [], depth = 0, skip = [], includeDirs = false, cap = Infinity) {
  if (depth > 20 || files.length >= cap) return files;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch { return files; }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    if (skip.includes(entry.name)) continue;
    if (files.length >= cap) return files;
    const fullPath = join(dir, entry.name);
    const relPath = prefix ? prefix + '/' + entry.name : entry.name;
    try {
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (includeDirs) files.push({ name: relPath, dir: true, mtime: stat.mtimeMs });
        walkFiles(fullPath, relPath, files, depth + 1, skip, includeDirs, cap);
      } else if (stat.isFile()) {
        files.push({ name: relPath, size: stat.size, mtime: stat.mtimeMs });
      }
    } catch {}
  }
  return files;
}

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

app.get('/api/files/:sessionId', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const relPath = req.query.path || '';
  const target = safePath(session.cwd, relPath);
  if (!target) return res.status(403).json({ error: '路径越界' });
  try {
    if (!statSync(target).isDirectory()) {
      return res.status(400).json({ error: '不是目录' });
    }
    const entries = readdirSync(target, { withFileTypes: true })
      .filter(e => e.name !== '.git')
      .map(e => {
        const fullPath = join(target, e.name);
        try {
          const stat = lstatSync(fullPath);
          if (stat.isSymbolicLink()) return null;
          return {
            name: e.name,
            isDir: stat.isDirectory(),
            size: stat.isFile() ? stat.size : undefined,
            mtime: stat.mtimeMs,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));

    const normalizedPath = relPath ? relPath.replace(/\\/g, '/') : '';
    const parent = normalizedPath.includes('/')
      ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
      : normalizedPath ? '' : null;

    res.json({ ok: true, cwd: session.cwd, path: normalizedPath, parent, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 文件/目录搜索（递归）——给输入框 @词 引用补全用（只搜本项目；项目外走下方 at-ls 按路径逐层浏览）。
//   q 是相对路径的子串（大小写不敏感），按匹配度（文件名开头 > 文件名包含 > 只有路径包含）、
//   同档最近修改优先，最多 50 条；目录一并返回（带 dir 标记），「把文件迁移到某文件夹」这类话也能 @ 到文件夹。
//   跳过 node_modules：依赖树动辄几万条目，搜出来全是噪音还拖慢响应。
app.get('/api/files/:sessionId/search', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const q = String(req.query.q || '').trim().toLowerCase();
  try {
    let files = walkFiles(session.cwd, '', [], 0, ['node_modules'], true).map((f) => ({ name: f.name, dir: !!f.dir, mtime: f.mtime }));
    if (q) files = files.filter((f) => f.name.toLowerCase().includes(q));
    const score = (f) => {
      if (!q) return 0;
      const base = f.name.slice(f.name.lastIndexOf('/') + 1).toLowerCase();
      return base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2;
    };
    files.sort((a, b) => score(a) - score(b) || (b.mtime || 0) - (a.mtime || 0));
    res.json({ ok: true, files: files.slice(0, 50).map((f) => ({ name: f.name, dir: !!f.dir })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// @ 按路径逐层浏览（仿 Claude Code 的 @ 路径补全）。dir 是输入框里 @ 后面「最后一个斜杠及之前」的部分：
//   ''        → 本项目根；docs/、../ → 相对本项目；
//   / 或 \    → Linux/mac 根目录，Windows 列盘符；C: / C:/ → 盘符根；~/ → 用户主目录；其余绝对路径照走。
//   q 是最后一段已打的字（前缀优先、再包含，大小写不敏感）；. 开头的隐藏项只在 q 以 . 开头时列出。
// 权限：所有登录用户都可浏览本机任意目录（AI 本身用 Read 也能读任意路径，这里拦着只是挡住用户自己）。
app.get('/api/files/:sessionId/at-ls', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const win = process.platform === 'win32';
  const dir = String(req.query.dir || '').replace(/\\/g, '/');
  const q = String(req.query.q || '').toLowerCase();
  const toFwd = (p) => p.replace(/\\/g, '/');

  // Windows 的 @/ 或 @\ ：没有统一根目录，列出可用盘符
  if (win && dir === '/') {
    const entries = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => l + ':')
      .filter((d) => { try { return existsSync(d + '\\'); } catch { return false; } })
      .filter((d) => !q || d.toLowerCase().startsWith(q))
      .map((d) => ({ label: d, dir: true }));
    return res.json({ ok: true, win, abs: '/', rel: false, parent: null, entries });
  }

  let target;
  if (!dir) target = session.cwd;
  else if (dir === '~' || dir.startsWith('~/')) target = join(homedir(), dir.slice(1));
  else if (win && /^[A-Za-z]:/.test(dir)) target = dir.length === 2 ? dir + '/' : dir;   // C: 单独是盘符相对路径
  else if (dir.startsWith('/')) target = dir;
  else target = join(session.cwd, dir);
  target = resolve(normalize(target));

  try {
    const all = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .map((e) => {
        try {
          const st = lstatSync(join(target, e.name));
          if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) return null;
          return { label: e.name, dir: st.isDirectory() };
        } catch { return null; }
      })
      .filter(Boolean);
    const rank = (e) => (!q ? 0 : e.label.toLowerCase().startsWith(q) ? 0 : 1);
    const entries = all
      .filter((e) => !q || e.label.toLowerCase().includes(q))
      .filter((e) => q.startsWith('.') || !e.label.startsWith('.'))   // 同 Claude Code：隐藏项要打 . 才列
      .sort((a, b) => rank(a) - rank(b) || b.dir - a.dir || a.label.localeCompare(b.label, 'zh'))
      .slice(0, 300);
    const up = dirname(target);
    res.json({
      ok: true, win,
      abs: toFwd(target),
      rel: !dir || !/^([/~]|[A-Za-z]:)/.test(dir),   // 相对本项目（插入相对路径）还是绝对路径
      parent: up !== target ? toFwd(up) : (win ? '/' : null),   // 到盘符根再往上 = 盘符列表
      entries,
    });
  } catch (err) {
    res.status(err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : 500).json({ error: err.code === 'ENOENT' ? '目录不存在' : err.code === 'ENOTDIR' ? '不是目录' : err.message });
  }
});

// ── HTML 预览：/view/<令牌>/<相对路径> ─────────────────────────────────────
//   AI 生成的 .html 要「看」不是「改」：预览在 sandbox iframe 里渲染（不同源，脚本碰不到 myhi 的
//   cookie / 接口）。sandbox 文档发请求不带 cookie（SameSite=Strict），所以图片 / CSS 等相对路径
//   资源靠路径里的短期只读令牌访问：只读、只限本任务目录、2 小时过期。
const _viewTokens = new Map();   // token → { sid, cwd, exp }
app.post('/api/files/:sessionId/view-token', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  const now = Date.now();
  for (const [k, v] of _viewTokens) if (v.exp < now) _viewTokens.delete(k);
  let token = [..._viewTokens].find(([, v]) => v.sid === session.id && v.cwd === session.cwd && v.exp - now > 3600_000)?.[0];
  if (!token) { token = randomBytes(18).toString('base64url'); _viewTokens.set(token, { sid: session.id, cwd: session.cwd, exp: now + 2 * 3600_000 }); }
  res.json({ ok: true, token, cwd: session.cwd });
});
app.get('/view/:token/*', (req, res) => {
  const v = _viewTokens.get(req.params.token);
  if (!v || v.exp < Date.now()) return res.status(403).send('预览链接已过期，请回到 myhi 重新打开');
  const target = safePath(v.cwd, req.params[0] || '');
  if (!target) return res.status(403).send('路径越界');
  // 直接在新标签页打开也是 sandbox：脚本能跑，但拿不到 myhi 的源
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(target, { dotfiles: 'allow' }, (err) => { if (err && !res.headersSent) res.status(404).send('文件不存在'); });
});

// ── 文件夹 / 多选打包下载（zip）──────────────────────────────────────────
//   两步：① POST zip-ticket 登记要打包的路径，先算好文件数 / 大小（超限当场提示，不会下到一半失败）
//         ② GET zip?ticket= 流式打包下载（<a download> 直接触发浏览器下载，大文件夹也不占内存）
const _zipTickets = new Map();   // ticket → { sid, files, name, exp }
app.post('/api/files/:sessionId/zip-ticket', checkAuth, express.json({ limit: '1mb' }), sessBodyGuard, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String).filter(Boolean).slice(0, 2000) : [];
  if (!paths.length) return res.status(400).json({ ok: false, error: '没有选择要下载的文件' });
  const items = [];
  for (const rel of paths) {
    const abs = safePath(session.cwd, rel);
    if (!abs) return res.status(403).json({ ok: false, error: '路径越界：' + rel });
    items.push({ abs, name: rel.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() });
  }
  const { files, bytes, skipped } = collectZipFiles(items);
  if (!files.length) return res.status(400).json({ ok: false, error: '选中的内容里没有文件（空文件夹，或只有被跳过的 .git / node_modules 等）' });
  if (files.length > ZIP_MAX_FILES) return res.status(413).json({ ok: false, error: `文件太多（超过 ${ZIP_MAX_FILES} 个），请分几批下载` });
  if (bytes > ZIP_MAX_BYTES) return res.status(413).json({ ok: false, error: `总大小 ${(bytes / 1024 ** 3).toFixed(1)} GB 超过 4GB，请分几批下载（或用首页任务 ⋯ →「迁移到另一台 myhi」打包）` });
  const now = Date.now();
  for (const [k, v] of _zipTickets) if (v.exp < now) _zipTickets.delete(k);
  const one = items.length === 1 ? items[0].name : null;
  const base = one || `${String(session.title || 'files').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)}-${items.length}项`;
  const ticket = randomBytes(12).toString('hex');
  _zipTickets.set(ticket, { sid: session.id, files, name: base + '.zip', exp: now + 10 * 60_000 });
  res.json({ ok: true, ticket, name: base + '.zip', files: files.length, bytes, skipped });
});
app.get('/api/files/:sessionId/zip', checkAuth, async (req, res) => {
  const t = _zipTickets.get(String(req.query.ticket || ''));
  if (!t || t.sid !== req.params.sessionId || t.exp < Date.now()) return res.status(410).send('下载链接已过期，请回到 myhi 重新点下载');
  _zipTickets.delete(String(req.query.ticket));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent(t.name)}`);
  try { await writeZip(res, t.files); res.end(); }
  catch (e) { console.warn('[files] 打包下载中断:', e.message); res.destroy(); }
});

app.get('/api/files/:sessionId/download', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: '缺少 path 参数' });
  const target = safePath(session.cwd, relPath);
  if (!target) return res.status(403).json({ error: '路径越界' });
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: '不是文件' });

  const filename = relPath.split('/').pop();
  // inline=1：文件面板的「预览」（图片 / PDF / 音视频，浏览器原生能显示的）。只放行这几类；
  // SVG 能内嵌脚本，加 CSP sandbox，直接打开也执行不了
  const inline = req.query.inline === '1' && /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg|pdf|mp4|webm|ogv|mov|m4v|mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i.test(filename);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  if (inline && /\.svg$/i.test(filename)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");

  // 用 sendFile 取代裸 createReadStream().pipe(res)：
  //  ① 读流出错走**回调**而不是抛 —— 老写法没有 error 监听，文件在 stat 之后被
  //     改写/占用/移走（AI 正在生成的 .md/.xlsx 最常见）就抛 uncaughtException，
  //     而全局 handler 是 process.exit(1)：一次下载失败把**整个 myhi 带走**，
  //     浏览器侧表现就是"请检查互联网连接状况" + 文件名 fallback 成 download。
  //  ② 自带 Range/断点续传，弱网、手机切网、大文件的失败率本身就低很多。
  //  ③ dotfiles:'allow' 必须显式给 —— send 的默认策略会把 .gitignore/.env
  //     这类点开头的文件直接吞成 404。
  res.sendFile(target, { dotfiles: 'allow', acceptRanges: true }, (err) => {
    if (!err) return;
    const code = err.code || '';
    // 客户端自己取消/关页面/切网：正常现象，不是错误
    if (['ECONNABORTED', 'EPIPE', 'ECONNRESET'].includes(code) || res.writableEnded) return;
    console.warn('[files] 下载失败:', relPath, code || err.message);
    if (!res.headersSent) res.status(500).json({ error: '读取文件失败: ' + (code || err.message) });
    else res.destroy();
  });
});

app.post('/api/files/:sessionId/upload', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const relPath = (req.query.path || '').replace(/\\/g, '/');
  const target = safePath(session.cwd, relPath);
  if (!target) return res.status(403).json({ error: '路径越界' });
  mkdirSync(target, { recursive: true });

  multer({
    storage: multer.diskStorage({
      destination: (req2, file, cb) => {
        // multer 默认把 multipart filename 按 latin1 解码，中文 UTF-8 字节会错乱。
        // 重新按 utf8 解码并 mutate file.originalname，使后续所有引用都拿到正确文件名。
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const subDir = file.originalname.includes('/')
          ? file.originalname.slice(0, file.originalname.lastIndexOf('/'))
          : '';
        const destDir = subDir ? join(target, subDir) : target;
        const destResolved = resolve(normalize(destDir));
        const cwdResolved = resolve(normalize(session.cwd));
        if (destResolved !== cwdResolved && !destResolved.startsWith(cwdResolved + sep)) {
          return cb(new Error('路径越界'));
        }
        mkdirSync(destDir, { recursive: true });
        cb(null, destDir);
      },
      filename: (req2, file, cb) => {
        // destination 已 mutate，这里直接用即可
        const name = file.originalname.includes('/')
          ? file.originalname.slice(file.originalname.lastIndexOf('/') + 1)
          : file.originalname;
        cb(null, name);
      },
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
  }).array('files', 100)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files?.length) return res.status(400).json({ error: '没有文件' });
    const files = req.files.map(f => ({
      name: f.originalname,
      size: f.size,
      path: resolve(f.path).replace(/\\/g, '/'),
    }));
    io.emit('files:changed', { sessionId: session.id });
    res.json({ ok: true, files });
  });
});

app.delete('/api/files/:sessionId', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: '缺少 path 参数' });
  const target = safePath(session.cwd, relPath);
  if (!target) return res.status(403).json({ error: '路径越界' });
  if (resolve(normalize(target)) === resolve(normalize(session.cwd))) {
    return res.status(403).json({ error: '不能删除会话根目录' });
  }
  try {
    if (statSync(target).isDirectory()) {
      rmSync(target, { recursive: true });
    } else {
      unlinkSync(target);
    }
    io.emit('files:changed', { sessionId: session.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/:sessionId/manifest', checkAuth, async (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const relPath = req.query.path || '';
  const target = safePath(session.cwd, relPath);
  if (!target) return res.status(403).json({ error: '路径越界' });
  try {
    const rawFiles = walkFiles(target, '');
    const files = [];
    for (const f of rawFiles) {
      if (f.size >= 50 * 1024 * 1024) { files.push(f); continue; }
      try {
        const hash = await fileHash(join(target, f.name));
        files.push({ ...f, hash });
      } catch { files.push(f); }
    }
    res.json({ ok: true, cwd: session.cwd, path: relPath, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 文本文件在线编辑 —— AI 生成的 md/代码/配置，直接在网页里看+改+存回，
// 不用再走「下载 → 本机改 → 传回来」。二进制（xlsx/docx/图片）和超大文件
// 仍只给下载。编辑的是会话 cwd 里的真实文件，保存后 AI 下次 Read 就是新内容。
// ---------------------------------------------------------------------------

// 可在线编辑的扩展名白名单（与 public/chat.html 的 FEDIT_EXT 保持一致，改一处记得另一处）
const EDITABLE_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonc', 'json5',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'editorconfig',
  'csv', 'tsv', 'xml', 'svg', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
  'py', 'pyi', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'java', 'kt', 'kts', 'groovy', 'gradle',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'lua', 'dart',
  'proto', 'graphql', 'cmake', 'dockerfile', 'gitignore',
]);
const EDIT_MAX_BYTES = 2 * 1024 * 1024; // 2MB：再大就是"看"的需求，交给下载

function normRelPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

// 扩展名不在白名单 → 拒编辑（下载照旧）；顺带挡掉把 xlsx 改名 .md 之类
function editableTarget(session, relPath) {
  const rel = normRelPath(relPath);
  if (!rel) return { error: '缺少 path', code: 400 };
  const target = safePath(session.cwd, rel);
  if (!target) return { error: '路径越界', code: 403 };
  const ext = (rel.split('/').pop().match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || '';
  if (!EDITABLE_EXTS.has(ext)) return { error: '该类型文件不支持在线编辑，请用下载', code: 415 };
  return { rel, target };
}

// NUL 字节嗅探：文本文件不该有 0x00，有就是二进制（防改名混入）
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// AI 常在会话目录的子项目里干活（cd 子项目后说「已写入 docs/x.md」），回复里的相对路径是相对子项目的，
// 按会话目录拼不出来。原路径不存在时按「路径结尾」在会话目录下找一遍：最浅的优先、同深度取最近修改。
function findBySuffix(cwd, rel) {
  const hits = walkFiles(cwd, '', [], 0, ['node_modules'], false, 20000)
    .filter((f) => f.name.endsWith('/' + rel));
  if (!hits.length) return null;
  const depth = (f) => f.name.split('/').length;
  hits.sort((a, b) => depth(a) - depth(b) || b.mtime - a.mtime);
  return hits[0].name;
}

app.get('/api/files/:sessionId/content', checkAuth, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  let t = editableTarget(session, req.query.path);
  if (t.error) return res.status(t.code).json({ error: t.error });
  if (!existsSync(t.target) && !isAbsolute(t.rel)) {
    const found = findBySuffix(session.cwd, t.rel);
    if (found) t = editableTarget(session, found);   // 返回的 path 是真实相对路径，之后保存也写到这里
  }
  let stat;
  try { stat = statSync(t.target); } catch { return res.status(404).json({ error: '文件不存在' }); }
  if (!stat.isFile()) return res.status(400).json({ error: '不是文件' });
  if (stat.size > EDIT_MAX_BYTES) return res.status(413).json({ error: '文件超过 2MB，仅支持下载' });
  let buf;
  try { buf = readFileSync(t.target); } catch (err) { return res.status(500).json({ error: '读取失败: ' + (err.code || err.message) }); }
  if (looksBinary(buf)) return res.status(415).json({ error: '二进制文件，仅支持下载' });
  res.json({
    ok: true,
    path: t.rel,
    name: t.rel.split('/').pop(),
    content: buf.toString('utf8'),
    mtime: stat.mtimeMs,
    size: stat.size,
    md: /\.(md|markdown)$/i.test(t.rel),
  });
});

app.put('/api/files/:sessionId/content', checkAuth, express.json({ limit: '4mb' }), sessBodyGuard, (req, res) => {
  const session = manager.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const { content, baseMtime, force } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: '缺少内容' });
  if (Buffer.byteLength(content, 'utf8') > EDIT_MAX_BYTES) return res.status(413).json({ error: '内容超过 2MB' });
  const t = editableTarget(session, req.body.path);
  if (t.error) return res.status(t.code).json({ error: t.error });

  let stat;
  try { stat = statSync(t.target); } catch { return res.status(404).json({ error: '文件已被删除，无法保存' }); }
  if (!stat.isFile()) return res.status(400).json({ error: '不是文件' });
  // 冲突检测：编辑器打开期间文件被别人（多半是 AI）写过 → 拒绝静默覆盖，
  // 前端拿到 409 让用户选「覆盖 / 重新加载」。容差只吸收文件系统时间戳粒度，
  // 要小 —— 太宽会把「刚打开编辑器 AI 就写完」的真实冲突漏过去。
  if (!force && typeof baseMtime === 'number' && Math.abs(stat.mtimeMs - baseMtime) > 300) {
    return res.status(409).json({ error: 'conflict', mtime: stat.mtimeMs });
  }
  // 原子写：先 tmp 再 rename。Windows 上目标被独占锁住（AI 正在写/Excel 开着）时
  // rename 会 EBUSY/EPERM —— 回落成直接覆盖写；还不行就如实报"被占用"，绝不让它飞。
  const tmp = t.target + '.myhi-edit-' + Date.now();
  try {
    try {
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, t.target);
    } catch {
      try { rmSync(tmp, { force: true }); } catch {}
      writeFileSync(t.target, content, 'utf8');
    }
  } catch (err) {
    const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
    console.warn('[files] 保存失败:', t.rel, err.code || err.message);
    return res.status(500).json({
      error: busy ? '文件被其它程序占用（AI 可能正在写入），稍后再试' : '保存失败: ' + (err.code || err.message),
    });
  }
  let mtime = Date.now();
  try { mtime = statSync(t.target).mtimeMs; } catch {}
  io.emit('files:changed', { sessionId: session.id });
  res.json({ ok: true, mtime });
});

// ---------------------------------------------------------------------------
// API routes — current user info
// ---------------------------------------------------------------------------

app.get('/api/me', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  res.json({
    name: user?.name || '用户',
    role: user?.role || 'admin',
    exclusive: isExclusiveMode(),
    hasUsers: hasUsers(),            // 有登录账号（显示账户菜单：退出 / 改密）
    multiUser: isMultiUser(),        // ≥2 个账号才是多用户
    member: !!user?.member,          // 用账号密码登录的（可自助改密）
    dir: user?.dir || null,
    // 新建任务默认根目录：绑定目录优先，其次 MYHI_CWD / server cwd——以服务器 OS 为准，
    // 前端不得按浏览器 OS 猜（Linux 主机从 Windows 浏览器访问时猜出 D:\project 这种错路径）
    defaultRoot: user?.dir || process.env.MYHI_CWD || process.cwd(),
    // 快捷栏默认模式：打包给简单用户时在 config.json 配 "skMode":"normal"（或 env MYHI_SK_MODE=normal），
    // 普通用户只见精简快捷栏；默认 expert。用户在设置里自己切过则以用户为准（存浏览器 localStorage）
    // 本机能否弹出桌面窗口（「打开当前文件夹」）：headless 部署时前端隐藏该按钮
    desktop: hasDesktop(),
    skMode: (process.env.MYHI_SK_MODE || _configString('skMode') || 'expert').toLowerCase() === 'normal' ? 'normal' : 'expert',
  });
});

// ---------------------------------------------------------------------------
// 大模型网关配置（仅 admin）
// ---------------------------------------------------------------------------

const gatewayFile = join(configDir, 'gateway.json');

function loadGateway() {
  try {
    return JSON.parse(readFileSync(gatewayFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { baseUrl: '', apiKey: '' };
  }
}

// 网关配置：后台（管理令牌）和首页设置（单用户的主人 / 多用户的管理员）都能改
const maskKey = (k) => (k ? (k.length > 12 ? k.slice(0, 6) + '***' + k.slice(-4) : '***') : '');
app.get('/api/gateway', adminBearerOr(checkAuth, requireAdmin), (req, res) => {
  const cfg = loadGateway();
  // 实际生效的网关：myhi 自己没配时，自动用环境变量 / Claude Code 配置里的（见 models.js resolveGateway）
  const eff = resolveGateway();
  res.json({
    baseUrl: cfg.baseUrl || '',
    // 返回掩码后的 key（前 6 位 + *** + 后 4 位）
    apiKey: maskKey(cfg.apiKey),
    hasKey: !!cfg.apiKey,
    syncClaude: !!cfg.syncClaude,
    claudeSettings: claudeSettingsFile(),
    effective: eff.baseUrl ? { baseUrl: eff.baseUrl, apiKey: maskKey(eff.apiKey), source: eff.source } : null,
  });
});

// 「同时写入 Claude Code 配置」：把网关写进 ~/.claude/settings.json 的 env，终端里直接用的 claude 也走它。
//   只动 env 里这三个键，其它内容原样保留；写之前备份成 settings.json.myhi-bak；文件不是合法 JSON 就拒绝，不覆盖。
//   取消勾选 / 清空网关：只删值还等于 myhi 写进去的那几个键（用户之后手改过的不动）。
const CLAUDE_GW_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
function claudeSettingsFile() { return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'); }
function syncClaudeSettings(prev, next) {
  const file = claudeSettingsFile();
  let raw = null, cfg = {};
  if (existsSync(file)) {
    raw = readFileSync(file, 'utf8');
    try { cfg = JSON.parse(raw.replace(/^\uFEFF/, '') || '{}'); } catch { throw new Error(`${file} 不是合法的 JSON，没有改动它，请先手工修好`); }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} 格式不对，没有改动它`);
  }
  const env = cfg.env && typeof cfg.env === 'object' ? { ...cfg.env } : {};
  const want = next.syncClaude && next.baseUrl && next.apiKey
    ? { ANTHROPIC_BASE_URL: next.baseUrl, ANTHROPIC_API_KEY: next.apiKey, ANTHROPIC_AUTH_TOKEN: next.apiKey } : null;
  if (want) Object.assign(env, want);
  else if (prev.syncClaude) {
    const mine = { ANTHROPIC_BASE_URL: prev.baseUrl, ANTHROPIC_API_KEY: prev.apiKey, ANTHROPIC_AUTH_TOKEN: prev.apiKey };
    for (const k of CLAUDE_GW_KEYS) if (env[k] && env[k] === mine[k]) delete env[k];
  } else return null;
  const out = { ...cfg, env };
  if (!Object.keys(env).length) delete out.env;
  const body = JSON.stringify(out, null, 2) + '\n';
  if (raw !== null && body === raw) return file;
  mkdirSync(dirname(file), { recursive: true });
  if (raw !== null) copyFileSync(file, file + '.myhi-bak');
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

app.post('/api/gateway', adminBearerOr(checkAuth, requireAdmin), express.json(), (req, res) => {
  const { baseUrl, apiKey, syncClaude } = req.body || {};
  const current = loadGateway();
  const next = {
    baseUrl: typeof baseUrl === 'string' ? baseUrl.trim() : current.baseUrl,
    // 留空或掩码视为不修改，明文更新
    apiKey: (!apiKey || apiKey.includes('***')) ? current.apiKey : apiKey.trim(),
    // 没传（如 /admin 旧页面）= 保持原样
    syncClaude: typeof syncClaude === 'boolean' ? syncClaude : !!current.syncClaude,
  };
  try {
    // 先改 Claude Code 配置：它失败（文件坏了）就整体不保存，免得两边不一致
    const synced = syncClaudeSettings(current, next);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(gatewayFile, JSON.stringify(next, null, 2), { mode: 0o600 });
    markEnvDirty('网关');
    res.json({ ok: true, synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Secret Vault — 命名密钥库（仅管理端；GET 只回掩码，永不回明文）。见 src/secrets.js
// ---------------------------------------------------------------------------
app.get('/api/secrets', checkAdminAuth, (req, res) => {
  try { res.json(secretsOverview()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/secrets', checkAdminAuth, express.json(), (req, res) => {
  const { name, value, type, scope, cwd } = req.body || {};
  const r = upsertSecret({ name, value, type, scope, cwd });
  if (r.error) return res.status(400).json(r);
  markEnvDirty('密钥', scope === 'project' ? cwd : null);
  res.json(r);
});

app.delete('/api/secrets', checkAdminAuth, express.json(), (req, res) => {
  const { name, scope, cwd } = req.body || {};
  if (!name) return res.status(400).json({ error: '缺少 name' });
  try { const r = deleteSecret({ name, scope, cwd }); markEnvDirty('密钥', scope === 'project' ? cwd : null); res.json(r); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 会话级（项目）密钥：普通登录即可，cwd 由服务端从会话取，前端不碰路径。
// 让「每个项目在自己的会话里自助维护项目密钥」，无需管理员/敲 cwd。全局密钥只读展示（继承）。
app.get('/api/session/:id/secrets', checkAuth, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  res.json({ cwd: sess.cwd, project: listSecrets('project', sess.cwd), global: listSecrets('global') });
});

app.post('/api/session/:id/secrets', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const { name, value, type } = req.body || {};
  const r = upsertSecret({ name, value, type, scope: 'project', cwd: sess.cwd });
  if (r.error) return res.status(400).json(r);
  markEnvDirty('密钥', sess.cwd);
  res.json(r);
});

app.delete('/api/session/:id/secrets', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: '缺少 name' });
  const r = deleteSecret({ name, scope: 'project', cwd: sess.cwd });
  markEnvDirty('密钥', sess.cwd);
  res.json(r);
});

// 批量编辑：粘一段 .env 风格文本一次性 upsert 本项目变量（非破坏性，不删漏列的）
app.post('/api/session/:id/secrets/bulk', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const r = upsertManyProject(sess.cwd, (req.body || {}).text || '');
  if (r.error) return res.status(400).json(r);
  markEnvDirty('密钥', sess.cwd);
  res.json(r);
});

// -------------------------------------------------------------------------
// 隐私护栏（Layer C，去标识化）：会话级自助维护。开关/档位 + 项目实体词典。
// 每个项目在自己会话里维护"我方主体名单"，无需管理员/敲 cwd（cwd 由服务端从会话取）。
// -------------------------------------------------------------------------
app.get('/api/session/:id/guard', checkAuth, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const g = getProjectGuard(sess.cwd);
  res.json({ cwd: sess.cwd, enabled: g.enabled, level: g.level, entities: g.entities });
});

// 更新开关/档位
app.put('/api/session/:id/guard', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const { enabled, level } = req.body || {};
  const r = setProjectGuard(sess.cwd, { enabled, level });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// 词典：新增/更新一条实体
app.post('/api/session/:id/guard/entity', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const { name, type } = req.body || {};
  const r = upsertEntity(sess.cwd, { name, type });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// 词典：删除一条实体
app.delete('/api/session/:id/guard/entity', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: '缺少 name' });
  res.json(deleteEntity(sess.cwd, name));
});

// 词典：批量（每行 `名称` 或 `名称|类型`）
app.post('/api/session/:id/guard/bulk', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const r = upsertManyEntities(sess.cwd, (req.body || {}).text || '');
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// 审计留痕：本会话每轮脱敏记录（时间/数量/类型分布/发给模型的脱敏后全文，不含真值），可导出取证
app.get('/api/session/:id/guard/audit', checkAuth, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const key = sess.claudeSessionId || req.params.id;
  res.json({ entries: loadAudit(key) });
});

// 自动跟进：长任务完成后自动汇报进度（免用户反复问）。仅 AI(agent) 会话有此能力。
app.get('/api/session/:id/followup', checkAuth, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess || typeof sess.followUpState !== 'function') return res.status(404).json({ error: '会话不存在或非 AI 会话' });
  res.json(sess.followUpState());
});
app.put('/api/session/:id/followup', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess || typeof sess.setFollowUp !== 'function') return res.status(404).json({ error: '会话不存在或非 AI 会话' });
  const { enabled, intervalMinutes } = req.body || {};
  res.json(sess.setFollowUp({ enabled, intervalMinutes }));
});

// ---------------------------------------------------------------------------
// 灵感收件箱（草稿队列）：会话正忙时先把想法（文字+图片+文件）记下来，干完再发。
//   每条强制归属一个会话，否则过几天就认不出是哪个任务了。详见 src/inbox.js。
// ---------------------------------------------------------------------------

// 勾了「自动接力」但会话**此刻已空闲**时，没有下一个 result 来触发接力，
// 草稿会一直卡着不发。这里补一脚：会话空闲就立刻排一次接力（内部仍会延时复查忙闲）。
function maybeKickRelay(draft) {
  try {
    if (!draft?.autoSend) return;
    const sess = manager.get(draft.sessionId);
    if (sess && typeof sess._maybeRelayDraft === 'function' && sess.alive && !sess.isBusy) {
      sess._maybeRelayDraft();
    }
  } catch { /* 接力是锦上添花，失败不影响存草稿 */ }
}

app.get('/api/inbox', checkAuth, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  const { sessionId } = req.query;
  try {
    // 先按 claudeSessionId 把重启后变孤儿的草稿贴回恢复出来的会话
    try { rebindDrafts(manager.listSessions()); } catch {}
    // 草稿跟着任务走：能看到该任务（会话）就能看到它的草稿，不再按「记录人」过滤——
    // 同一个人手机/电脑用不同账号登录时，按记录人过滤会导致两边列表对不上、
    // 角标计数（原来无条件全局统计）和列表也不一致。
    const visible = new Set(manager.list(user?.name, user?.role === 'admin').map((s) => s.id));
    const drafts = listDrafts({ sessionId: sessionId || undefined })
      .filter((d) => visible.has(d.sessionId) || (d.owner && d.owner === user?.name));
    // 角标计数也按同一份可见草稿统计，保证计数 == 列表
    const counts = {};
    for (const d of drafts) counts[d.sessionId] = (counts[d.sessionId] || 0) + 1;
    // 归属的会话还活着吗 —— 前端据此标「原任务(已结束)」并提供改投
    const alive = new Set(manager.listSessions().map((s) => s.id));
    res.json({
      drafts: drafts.map((d) => ({ ...d, sessionAlive: alive.has(d.sessionId) })),
      counts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 草稿可见 / 可改：与 GET /api/inbox 的过滤一致 —— 能看到它所属的任务，或者是自己记的
function canTouchDraft(user, d) {
  if (!d) return false;
  if (!user || user.role === 'admin') return true;
  if (d.owner && d.owner === user.name) return true;
  const sess = d.sessionId ? manager.get(d.sessionId) : null;
  return !!sess && canAccessSession(user, sess);
}
function draftGuard(req, res, next) {
  const user = getUserInfo(req.headers.cookie);
  const ids = req.params.id ? [req.params.id] : (Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
  const all = listDrafts({});
  for (const id of ids) {
    const d = all.find((x) => x.id === id);
    if (d && !canTouchDraft(user, d)) return res.status(403).json({ ok: false, error: '没有操作这条草稿的权限' });
  }
  next();
}

app.post('/api/inbox', checkAuth, express.json({ limit: '1mb' }), sessBodyGuard, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  const body = req.body || {};
  const sess = body.sessionId ? manager.get(body.sessionId) : null;
  try {
    // 记录人只有管理员能代填；其他人一律记成自己（以前 body.owner 可伪造成别人）
    const owner = (user?.role === 'admin' && body.owner) || user?.name || null;
    const draft = addDraft({ ...body, owner }, sess);
    maybeKickRelay(draft);
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/inbox/:id', checkAuth, express.json({ limit: '1mb' }), sessBodyGuard, draftGuard, (req, res) => {
  const body = { ...(req.body || {}) };
  if (getUserInfo(req.headers.cookie)?.role !== 'admin') delete body.owner;
  const sess = body.sessionId ? manager.get(body.sessionId) : null;
  const draft = updateDraft(req.params.id, body, sess);
  if (!draft) return res.status(404).json({ error: '草稿不存在' });
  maybeKickRelay(draft);
  res.json({ ok: true, draft });
});

// 调整顺序：ids 为本任务草稿的新顺序（自动接力按这个顺序发）
app.post('/api/inbox/reorder', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const { sessionId, ids } = req.body || {};
  if (!sessionId || !Array.isArray(ids)) return res.status(400).json({ error: '参数不对' });
  reorderDrafts(sessionId, ids.map(String));
  res.json({ ok: true });
});

// 合并几条草稿（同一任务）；撤销合并把原来的几条拆回
app.post('/api/inbox/merge', checkAuth, express.json(), sessBodyGuard, draftGuard, (req, res) => {
  try {
    const draft = mergeDrafts((req.body?.ids || []).map(String));
    maybeKickRelay(draft);
    res.json({ ok: true, draft });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/inbox/:id/unmerge', checkAuth, draftGuard, (req, res) => {
  try { res.json({ ok: true, drafts: unmergeDraft(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 继续自动发送：上一轮被中断 / 出错收尾时队列不会自己往下走，用户确认后从这里接着发
app.post('/api/inbox/resume', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const sess = manager.get(String(req.body?.sessionId || ''));
  if (!sess || typeof sess._maybeRelayDraft !== 'function') return res.status(404).json({ error: '任务不存在' });
  if (sess.isBusy) return res.json({ ok: true, busy: true });
  sess._maybeRelayDraft();
  res.json({ ok: true });
});

app.delete('/api/inbox/:id', checkAuth, draftGuard, (req, res) => {
  if (!removeDraft(req.params.id)) return res.status(404).json({ error: '草稿不存在' });
  res.json({ ok: true });
});

// 在【myhi 服务端所在机器】打开任务文件夹 —— 仅当你就坐在跑 myhi 的那台机时有意义
// （远程/Tailscale 访问时会开在服务器桌面上，看不到；那种情况用内置「文件」面板浏览/下载）。
function _spawnOpen(cmd, args, useShell = process.platform === 'win32') {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: useShell });
      p.on('error', (e) => { console.warn('[open-folder]', cmd, '失败:', e.message); resolve(false); });
      p.unref();
      // explorer 永远 exit 1（成功也是），无法靠退出码判断；spawn 没抛错即视为已拉起
      setTimeout(() => resolve(true), 300);
    } catch (e) { console.warn('[open-folder] spawn 异常:', e.message); resolve(false); }
  });
}
// 本机有没有可弹窗的桌面（「打开当前文件夹」能否生效）。
//   Linux 看 DISPLAY / WAYLAND_DISPLAY（SSH / systemd / 容器里都没有）；
//   Windows 看 myhi 进程所在会话号：经 SSH 启动/重启（远程升级常这么干）或作为服务跑时是 Session 0——
//   没有桌面，explorer 起得来但窗口谁也看不到，接口还回「已拉起」。曾试过借计划任务 /IT 开到登录用户桌面，
//   实测同样「报成功、不出窗」，不可靠 → 后台会话一律按无桌面处理：前端藏按钮，接口如实提示。
let _winSessionId;   // 启动时取一次；取不到为 null（按有桌面处理，不误伤）
if (process.platform === 'win32') {
  execFile('tasklist', ['/FI', `PID eq ${process.pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
    // "node.exe","1234","Services","0","50,000 K" —— 第 4 列是会话号（与系统语言无关）
    const m = !err && String(out).match(/^"[^"]*","\d+","[^"]*","(\d+)"/m);
    _winSessionId = m ? Number(m[1]) : null;
    if (_winSessionId === 0) console.log('[open-folder] myhi 运行在后台会话（Session 0），「打开文件夹」已停用');
  });
}
function hasDesktop() {
  if (process.platform === 'linux') return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (process.platform === 'win32') return _winSessionId !== 0;
  return true;
}
const NO_DESKTOP_MSG = 'myhi 当前以后台服务方式运行（没有桌面），无法在本机弹出文件夹窗口，请用「文件」面板浏览/下载';

app.post('/api/session/:id/open-folder', checkAuth, async (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess?.cwd) return res.status(404).json({ error: '会话或目录不存在' });
  if (!existsSync(sess.cwd)) return res.status(400).json({ error: '目录不存在（可能被移动/删除）: ' + sess.cwd });
  // 无桌面时 explorer / xdg-open 照样能 spawn 成功，会误报「已打开」
  if (!hasDesktop()) return res.json({ ok: false, cwd: sess.cwd, error: NO_DESKTOP_MSG });
  let cwd = sess.cwd;
  if (process.platform === 'win32') {
    // explorer 对正斜杠兼容性差（远程路径形态时可能静默不开窗），统一换反斜杠；
    // 去掉尾部反斜杠（D:\ 保留），免得 "D:\资料\" 里的 \" 被当成转义引号
    cwd = cwd.replace(/\//g, '\\').replace(/(?<!^[A-Za-z]:)\\+$/, '');
    // 不经 shell：shell:true 时 Node 不给参数加引号，带空格的路径会被 explorer 拆成几段；
    // 先直接 explorer；再兜底 cmd start（双保险，deamon 上下文不同时总有一个能开）
    let ok = await _spawnOpen('explorer.exe', [cwd], false);
    if (!ok) ok = await _spawnOpen('cmd.exe', ['/c', 'start', '', cwd]);
    // 从后台 daemon 拉起的窗口常开在浏览器后面：AppActivate 把文件夹窗口抢到前台
    // （窗口出现有延迟，重试 ~4 秒；尽力而为，失败不影响「已打开」）
    const folder = cwd.split('\\').filter(Boolean).pop() || '';
    if (folder) {
      const ps = `$f='${folder.replace(/'/g, "''")}'; 1..12 | ForEach-Object { Start-Sleep -Milliseconds 350; if ((New-Object -ComObject WScript.Shell).AppActivate($f)) { break } }`;
      _spawnOpen('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], false);
    }
    console.log('[open-folder]', cwd, ok ? '已拉起' : '失败');
    return res.json({ ok, cwd });
  }
  const ok = process.platform === 'darwin' ? await _spawnOpen('open', [cwd]) : await _spawnOpen('xdg-open', [cwd]);
  res.json({ ok, cwd });
});

// ---------------------------------------------------------------------------
// Version check & update
// ---------------------------------------------------------------------------

function getPkgVersion() {
  for (const rel of ['../package.json', './package.json', 'package.json']) {
    try {
      const ver = JSON.parse(readFileSync(join(__dirname, rel), 'utf8')).version;
      if (ver && ver !== '0.0.0') return ver;
    } catch {}
  }
  return '0.0.0';
}

// 正在运行的版本：启动时读一次定死。npm 装完、还没重启时磁盘上已经是新版本号，
// 若每次现读，网页会以为升级完成提前刷新，连到马上要退出的旧进程
const PKG_VERSION = getPkgVersion();
// 程序文件（dist）是哪个版本构建的：npm 发布时漏了构建，版本号是新的、程序却是旧的（1.3.214~1.3.218 都中过）
const BUILD_INFO = (() => { try { return JSON.parse(readFileSync(join(__dirname, 'build-info.json'), 'utf8')); } catch { return null; } })();
const BUILD_STALE = !!(BUILD_INFO && BUILD_INFO.version && PKG_VERSION !== '0.0.0' && BUILD_INFO.version !== PKG_VERSION);
if (BUILD_STALE) console.warn(`[myhi] ⚠ 程序文件是 v${BUILD_INFO.version} 构建的，和版本号 v${PKG_VERSION} 不一致——发布时没有重新构建，新功能不会生效。请发布方重新 npm run build 后再发布`);
else if (BUILD_INFO) console.log(`[myhi] 版本 v${PKG_VERSION}${BUILD_INFO.commit ? ' · 构建 ' + BUILD_INFO.commit : ''}`);
let _latestVersion = null;
let _lastVersionCheck = 0;
const VERSION_CHECK_INTERVAL = 600 * 1000; // 10 min

async function checkLatestVersion() {
  const now = Date.now();
  if (_latestVersion && now - _lastVersionCheck < VERSION_CHECK_INTERVAL) {
    return _latestVersion;
  }
  // 先官方源，连不上再国内镜像（见 bin/install-check.js 下载源说明）
  const got = await latestVersion('@wendongfly/myhi', npmRegistryPref());
  if (got) { _latestVersion = got.version; _lastVersionCheck = now; }
  return _latestVersion;
}
// 升级下载源偏好：config.json npmRegistry = auto（默认）/ official / mirror / 自定义 URL
function npmRegistryPref() { return _configString('npmRegistry') || 'auto'; }

// 「有新版」必须是 latest 比当前大，不是「不相等」：本机先装了还没发布的新版（如 1.3.192）试用时，
// npm 上的 latest 还是 1.3.191，按「不相等」会提示把它「升级」到旧版（实为降级）。
function semverGt(a, b) {
  const pa = String(a || '').split(/[.-]/).map(Number), pb = String(b || '').split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}

app.get('/api/version', async (req, res) => {
  const current = PKG_VERSION;
  const latest = await checkLatestVersion();
  res.json({
    current,
    latest: latest || current,
    updateAvailable: !!latest && semverGt(latest, current),
    upgrade: upgradeState(),   // 网页升级时轮询：进行中 / 上次结果（成败、原因）
    build: BUILD_INFO ? { version: BUILD_INFO.version, commit: BUILD_INFO.commit || '', stale: BUILD_STALE } : null,
  });
});

// 普通用户也可触发升级与重启；改全局配置只给管理员（见 requireAdmin）
// 检测是否在 systemd 下运行
function isSystemd() {
  // 只看 INVOCATION_ID / JOURNAL_STREAM 会误判：systemd 拉起的进程树里（如别的服务开的终端）敲 myhi 前台跑，
  // 这两个变量是继承来的 → 升级后去 systemctl restart 一个根本不存在的服务，新版本永远不生效。
  // 真由 systemd 直接管理时 server 就是主进程、父进程是 PID 1（myhi service 跑的是 daemon，server 走 IPC 分支）。
  return process.platform === 'linux' && process.ppid === 1 && !!(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
}

// 根据环境选择 npm install 命令
// 注意：不再做 `|| sudo` 兜底——若第一次 install 因权限失败而 fallback 到 sudo，
// 两次 npm 走的 prefix 可能不同（用户 prefix vs root prefix），结果留下"两套 install
// dir"，daemon fork(serverEntry) 还是吃旧路径，UI 升级表面成功实际跑老版本
// （实际遇到过）。失败就让 admin SSH 进去手动 sudo install，确保 prefix 一致。

// 根据环境重启服务
function restartService() {
  if (process.send) {
    // daemon 子进程：通过 IPC 让 daemon 重启 server（不中断 daemon，重启更快）
    process.send({ type: 'restart' });
  } else if (isSystemd()) {
    // systemd 直接管理（无 daemon 层）：用 systemctl restart
    try { spawn('sudo', ['systemctl', 'restart', 'myhi.service'], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  } else {
    // 前台运行（直接敲 myhi）：没人负责把它拉起来，以前点升级/重启后服务就没了。
    // 拉起 daemon 接班（等本进程退出、端口释放后再起 server），本进程随即退出
    try {
      // 数组 join 拼路径：写成 join(__dirname, …, 'daemon.js') 会被 ncc 当静态资源拷进 dist/ 并改写路径，
      // 拷过去的 daemon.js 找不到同目录的 install-check.js，起不来
      const daemonJs = [PKG_ROOT, 'bin', 'daemon.js'].join(sep);
      const out = openSync(join(configDir, 'daemon.log'), 'a');
      spawn(process.execPath, [daemonJs, ...process.argv.slice(2)], {
        detached: true, stdio: ['ignore', out, out], windowsHide: true,
        env: { ...process.env, MYHI_WAIT_PID: String(process.pid) },
      }).unref();
      console.log('[myhi] 已转为后台运行（daemon），查看日志：myhi log');
    } catch (e) { console.error('[myhi] 拉起 daemon 失败，请手动重新运行 myhi：', e.message); }
    gracefulShutdown();
    setTimeout(() => process.exit(0), 300);
  }
}

// 管理后台（/admin）用 Bearer 管理令牌登录，和首页的登录 cookie 是两套：全局设置接口两种都认，
// 否则管理员在后台登录了也改不了（首页那边可能还是成员身份）
app.get('/api/server-config', adminBearerOr(checkAuth), (req, res) => {
  const asrUrl = process.env.ASR_URL ||
    (() => { try { return JSON.parse(readFileSync(join(homedir(), '.myhi', 'asr.json'), 'utf8')).url; } catch { return ''; } })();
  res.json({ asrUrl: asrUrl || '' });
});

// 改全局配置只给管理员。升级 / 重启成员也可触发（产品决定）。
// 与 /api/me 口径一致：token / 管理密码登录（无 userSessions 记录或 role=admin）算管理员，users.json 成员不算。
function requireAdmin(req, res, next) {
  const user = getUserInfo(req.headers.cookie);
  if (user && user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可执行此操作' });
  next();
}

// ── 个人偏好跨设备同步（外观 / 聊天显示 / 快捷栏）──
// 原先只存浏览器 localStorage，换手机/电脑得重设一遍。按登录身份存一份：管理员身份共用 'admin'，成员按名字。
// 只存前端声明的白名单键，单份 ≤ 8KB；updatedAt 由服务端打，前端以较新的为准。
const prefsFile = join(configDir, 'prefs.json');
const PREF_KEYS = new Set(['theme', 'font', 'chat']);
function prefsKey(req) {
  const u = getUserInfo(req.headers.cookie);
  return u && u.role !== 'admin' ? 'u:' + u.name : 'admin';
}
function loadAllPrefs() { try { return JSON.parse(readFileSync(prefsFile, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; } }
app.get('/api/prefs', checkAuth, (req, res) => res.json({ ok: true, prefs: loadAllPrefs()[prefsKey(req)] || null }));
app.put('/api/prefs', checkAuth, express.json({ limit: '16kb' }), sessBodyGuard, (req, res) => {
  const body = req.body || {};
  const clean = {};
  for (const [k, v] of Object.entries(body)) if (PREF_KEYS.has(k)) clean[k] = v;
  if (JSON.stringify(clean).length > 8192) return res.status(413).json({ ok: false, error: '偏好数据过大' });
  const all = loadAllPrefs();
  const key = prefsKey(req);
  all[key] = { ...(all[key] || {}), ...clean, updatedAt: Date.now() };
  try { writeFileSync(prefsFile, JSON.stringify(all, null, 2)); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  res.json({ ok: true, updatedAt: all[key].updatedAt });
});

app.post('/api/server-config', adminBearerOr(checkAuth, requireAdmin), express.json(), (req, res) => {
  const { asrUrl } = req.body || {};
  const cfgPath = join(homedir(), '.myhi', 'asr.json');
  try {
    const url = (asrUrl || '').trim();
    writeFileSync(cfgPath, JSON.stringify({ url }, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 机器名：多台电脑都跑 myhi 时用来区分浏览器标签（标题前缀 + 彩色图标）。
// 优先级 env MYHI_NAME > config.json name > 系统主机名；每次请求现读，改完刷新即生效、无需重启。
// 主机名只取第一段：Linux 常见 host.example.com 这种带域名的，标签里太长
const shortHostname = () => (hostname() || '').split('.')[0];
function machineName() {
  return (process.env.MYHI_NAME || _configString('name') || shortHostname() || 'myhi').trim();
}
app.get('/api/machine-name', adminBearerOr(checkAuth), (req, res) => {
  res.json({ name: machineName(), hostname: shortHostname(), fromEnv: !!process.env.MYHI_NAME });
});
app.post('/api/machine-name', adminBearerOr(checkAuth, requireAdmin), express.json(), (req, res) => {  const name = String(req.body?.name ?? '').trim().slice(0, 32);
  const cfgPath = join(configDir, 'config.json');
  try {
    const cfg = _readConfig();
    if (name) cfg.name = name; else delete cfg.name;   // 留空 = 恢复用主机名
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    res.json({ ok: true, name: machineName() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 模型：网关模型目录 + 场景模型（同一网关 + token，不同场景用不同模型；见 src/models.js）──
// adminBearerOr：管理后台 /admin 用 Bearer 令牌也能读（多用户模式下成员在首页设置里只读，模型只能在后台配）
app.get('/api/models', adminBearerOr(checkAuth), async (req, res) => {
  const g = await listGatewayModels({ force: req.query.refresh === '1' });
  res.json({ ok: true, ...g, scenes: readSceneModels(), sceneLabels: SCENES, sceneHints: SCENE_HINTS, gatewaySource: resolveGateway().source });
});
app.post('/api/model-scenes', adminBearerOr(checkAuth, requireAdmin), express.json(), (req, res) => {
  const body = req.body || {};
  try {
    const cfg = _readConfig();
    const models = {};
    for (const k of Object.keys(SCENES)) {
      const v = String(body[k] ?? '').trim();
      if (v.length > 120 || /\s/.test(v)) return res.status(400).json({ ok: false, error: `「${SCENES[k]}」的模型名不对：${v}` });
      if (v) models[k] = v;
    }
    cfg.models = models;
    delete cfg.visionAlways;   // 1.3.212 前的开关已取消：配了看图模型就一律先转文字
    if ('ask' in models || body.ask === '') delete cfg.askModel;   // 老配置并入 models.ask
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    console.log('[myhi] 场景模型已更新:', JSON.stringify(models));
    markEnvDirty('模型设置');
    res.json({ ok: true, scenes: readSceneModels() });
  } catch (e) { res.status(500).json({ ok: false, error: '写配置失败：' + e.message }); }
});

// 访问协议 HTTPS / HTTP：写进**本进程自己的**配置目录再重启。命令行 `myhi --http` 改的是敲命令那个账号的
// ~/.myhi；myhi 若是被别的程序（如第三方启动器）用另一个用户目录拉起，那份配置它读不到 —— 网页上改最稳
app.get('/api/server-mode', adminBearerOr(checkAuth), (req, res) => {   // 管理后台 /admin 也要读
  res.json({ ok: true, httpOnly: !_tlsOpts, fromEnv: !!process.env.MYHI_NO_HTTPS, port: PORT, configDir });
});
app.post('/api/server-mode', adminBearerOr(checkAuth, requireAdmin), express.json(), (req, res) => {
  const httpOnly = !!req.body?.httpOnly;
  if (process.env.MYHI_NO_HTTPS && !httpOnly) return res.status(400).json({ ok: false, error: '启动参数里设了环境变量 MYHI_NO_HTTPS，强制 HTTP；要切回 HTTPS 需先去掉它' });
  try {
    const cfg = _readConfig();
    cfg.httpOnly = httpOnly;
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) { return res.status(500).json({ ok: false, error: '写配置失败：' + e.message }); }
  console.log(`[myhi] 网页切换访问协议 → ${httpOnly ? 'HTTP' : 'HTTPS'}，重启生效（配置 ${join(configDir, 'config.json')}）`);
  res.json({ ok: true, httpOnly, port: PORT });
  setTimeout(() => restartService(), 500);
});

// 升级下载源（myhi / Claude 升级共用）：auto（先官方，不行再国内镜像）/ official / mirror；自定义 URL 只能手改 config.json
app.get('/api/npm-registry', adminBearerOr(checkAuth), (req, res) => {   // 管理后台 /admin 也要读
  res.json({ ok: true, pref: npmRegistryPref() });
});
app.post('/api/npm-registry', adminBearerOr(checkAuth, requireAdmin), express.json(), (req, res) => {
  const pref = String(req.body?.pref || 'auto');
  if (!['auto', 'official', 'mirror'].includes(pref)) return res.status(400).json({ ok: false, error: '只能选 auto / official / mirror' });
  try {
    const cfg = _readConfig();
    if (pref === 'auto') delete cfg.npmRegistry; else cfg.npmRegistry = pref;
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) { return res.status(500).json({ ok: false, error: '写配置失败：' + e.message }); }
  _latestVersion = null; _latestClaude = null;   // 换源后重新查新版
  res.json({ ok: true, pref });
});

app.post('/api/restart', checkAuth, (req, res) => {   // 成员也可重启（产品决定）
  res.json({ ok: true });
  setTimeout(() => restartService(), 300);
});

// ── 网页升级 ──────────────────────────────────────────────
// 保护：① 同一时间只允许一个升级（连点/两人同时点会跑两个 npm -g 互相覆盖，装坏）；
// ② 有 AI 任务正在执行时先提示（重启会打断这一轮），确认后带 force 再来；
// ③ 装完校验文件齐全 + 版本对才重启——装出半成品就不重启，旧版照常跑，网页提示原因；
// ④ Windows + 新版 daemon：交给 daemon 停服后再装（运行中的 server 锁着 pty.node，npm 覆盖会 EBUSY）；
// ⑤ npm 放后台跑、超时放宽到 10 分钟（慢网被 2 分钟超时腰斩同样会留半成品），网页轮询 /api/version.upgrade。
const PKG_ROOT = join(__dirname, '..');
const DAEMON_CAPS = (process.env.MYHI_DAEMON_CAPS || '').split(',');
let _upgrade = { running: false };
function readLastUpgrade() {
  try { return JSON.parse(readFileSync(upgradeStatusFile(configDir), 'utf8')); } catch { return null; }
}
function upgradeState() {
  if (_upgrade.running) return { running: true, startedAt: _upgrade.startedAt, target: _upgrade.target };
  const last = _upgrade.result || readLastUpgrade();
  // 只报最近 30 分钟内的结果，免得陈年失败记录一直挂着
  return last && Date.now() - (last.at || 0) < 30 * 60 * 1000 ? { running: false, last } : { running: false };
}
function busyAgentTitles() {
  try { return manager.listSessions().filter((s) => s.mode === 'agent' && s.isBusy).map((s) => s.title || s.id); } catch { return []; }
}
function recordUpgrade(result) {
  result.at = Date.now();
  _upgrade = { running: false, result };
  try { writeFileSync(upgradeStatusFile(configDir), JSON.stringify(result, null, 2)); } catch {}
  console.log(result.ok ? `[myhi] 升级成功：${result.from} → ${result.to}` : `[myhi] 升级失败：${result.error}`);
}

async function handleUpgrade(req, res) {
  if (_upgrade.running) return res.status(409).json({ ok: false, error: '升级已在进行中，请稍候' });
  const busy = busyAgentTitles();
  if (busy.length && !req.body?.force) {
    return res.status(409).json({ ok: false, busy, error: `有 ${busy.length} 个任务正在执行：${busy.join('、')}。升级会重启服务、打断它们这一轮。` });
  }
  const from = PKG_VERSION;
  // 下载源：先官方，连不上 / 装失败再国内镜像；每个源以它自己的 latest 为目标（镜像没同步到就跳过）
  const { candidates, note } = await upgradeCandidates('@wendongfly/myhi', from, npmRegistryPref());
  if (!candidates.length) return res.json({ ok: false, error: note });
  const target = candidates[0].version;

  if (process.platform === 'win32' && process.send && DAEMON_CAPS.includes('upgrade-v2')) {
    _upgrade = { running: true, startedAt: Date.now(), target };
    res.json({ ok: true, mode: 'daemon', from, target, message: '正在停止服务并安装新版本，约 1~3 分钟，期间页面会断开…' });
    // candidates：新 daemon 按顺序换源重试；老 daemon 不认这个字段，照旧走官方源
    setTimeout(() => process.send({ type: 'upgrade', target, candidates }), 300);
    return;
  }

  _upgrade = { running: true, startedAt: Date.now(), target };
  res.json({ ok: true, mode: 'server', from, target, message: '正在下载安装新版本…' });
  const fails = [];
  let chk = null;
  for (const c of candidates) {
    try {
      console.log(`[myhi] 升级：从${registryName(c.registry)}安装 ${c.version}`);
      await execAsync(npmUpgradeCmd(PKG_ROOT, c.registry), { encoding: 'utf8', timeout: 600000, windowsHide: true });
      chk = checkInstall(PKG_ROOT, c.version);
      if (chk.ok) break;
      fails.push(`${registryName(c.registry)}：${chk.error}`);
    } catch (err) {
      const tail = (err.stderr || err.stdout || err.message || '').split('\n').filter(l => l.trim()).slice(-4).join('\n');
      fails.push(`${registryName(c.registry)}：npm install 失败\n${tail}`);
    }
    chk = null;
  }
  if (!chk?.ok) {
    return recordUpgrade({ ok: false, from, to: target, error: fails.join('\n\n') + '\n\n服务未重启，仍在运行旧版本。可登录服务器手动执行 npm i -g @wendongfly/myhi@latest --registry https://registry.npmmirror.com 后重启' });
  }
  recordUpgrade({ ok: true, from, to: chk.version });
  _upgrade = { running: true, startedAt: Date.now(), target };   // 重启前保持「进行中」，网页继续等新版上线
  setTimeout(() => restartService(), 500);
  // 2 分钟后本进程还活着 = 重启没生效（如 systemd 的 sudo 未放行）：别让网页一直转圈
  setTimeout(() => recordUpgrade({ ok: false, from, to: chk.version, error: '新版本已安装，但服务没能自动重启，请手动重启 myhi 生效' }), 120000).unref();
}

app.post('/api/update', checkAuth, express.json(), sessBodyGuard, handleUpgrade);   // 成员也可升级（有执行中任务时会先确认）

// ---------------------------------------------------------------------------
// Claude Code 版本检测 & 升级
//   动机：claude 自带自更新在很多机子上会漏装平台二进制（留 500B 占位符）→ spawn
//   ENOENT/EACCES；很多 edge 又特意 DISABLE_AUTOUPDATER=1 导致 claude 长期不更新。
//   由 myhi 统一升级：① 强制 `--include=optional` 装全平台二进制；② 升级后真跑 --version 校验。
// ---------------------------------------------------------------------------

let _latestClaude = null;
let _lastClaudeCheck = 0;

async function checkLatestClaudeVersion() {
  const now = Date.now();
  if (_latestClaude && now - _lastClaudeCheck < VERSION_CHECK_INTERVAL) return _latestClaude;
  const got = await latestVersion('@anthropic-ai/claude-code', npmRegistryPref());
  if (got) { _latestClaude = got.version; _lastClaudeCheck = now; }
  return _latestClaude;
}

// 关键：--include=optional 明示装平台子包（claude.exe 真二进制），杜绝占位符坑。
// --registry 显式指定：以前不带，走本机 npm 自己配的源 —— 查新版看官方、装却走镜像，镜像没同步就「升级成功」但版本没变
function getClaudeUpgradeCmd(registry = REGISTRIES.official) {
  const base = `install -g @anthropic-ai/claude-code@latest --include=optional --registry ${registry}`;
  return (process.platform === 'win32' ? 'npm.cmd ' : 'npm ') + base;
}

// 后台升级状态（升级慢/包大 ~260MB，不阻塞 HTTP；UI 轮询 status）
let _claudeUpgrade = { running: false, ok: null, error: null, version: null, startedAt: 0 };

app.get('/api/claude/version', apiAuth, async (req, res) => {
  const [cur, latest] = await Promise.all([getClaudeVersion(), checkLatestClaudeVersion()]);
  const current = cur?.version || null;
  res.json({
    current,
    latest: latest || current,
    updateAvailable: !!(latest && current && semverGt(latest, current)),
    upgrade: _claudeUpgrade.running ? { running: true } : undefined,
  });
});

app.get('/api/claude/update-status', (req, res) => {
  res.json(_claudeUpgrade);
});

// 管理后台用后台令牌（Bearer）调，主站首页用登录 Cookie 调：两种都认
function adminBearerOr(...chain) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ') && _adminTokens.has(h.slice(7))) return next();
    let i = 0;
    const step = (err) => { if (err) return next(err); const mw = chain[i++]; return mw ? mw(req, res, step) : next(); };
    step();
  };
}
// 与 myhi 升级（/api/update）同一口径：成员也可升级；只读用户不行
function requireOperator(req, res, next) {
  const user = getUserInfo(req.headers.cookie);
  if (user && !hasPermission(user.role, 'operator')) return res.status(403).json({ ok: false, error: '只读账号不能升级，请用成员或管理员账号' });
  next();
}
app.post('/api/claude/update', adminBearerOr(checkAuth, requireOperator), async (req, res) => {
  if (_claudeUpgrade.running) {
    return res.json({ ok: true, started: false, message: '升级已在进行中' });
  }
  _claudeUpgrade = { running: true, ok: null, error: null, version: null, startedAt: Date.now() };
  res.json({ ok: true, started: true, message: 'claude 升级已开始，可能需要几分钟...' });

  // 后台执行，不阻塞响应
  (async () => {
    try {
      const cur = (await getClaudeVersion())?.version || null;   // 没装（首页「安装 AI 引擎」）时为 null：任何版本都算新
      const { candidates, note } = await upgradeCandidates('@anthropic-ai/claude-code', cur, npmRegistryPref());
      if (!candidates.length) throw new Error(note);
      // 按顺序试：官方源装失败 / 装完版本不对，换国内镜像再来
      const fails = [];
      let v = null;
      for (const c of candidates) {
        try {
          console.log(`[myhi] claude 升级：从${registryName(c.registry)}安装 ${c.version}`);
          await execAsync(getClaudeUpgradeCmd(c.registry), { encoding: 'utf8', timeout: 15 * 60 * 1000 });
          resetClaudeLauncher(); // 让下次 spawn 重新解析新装的 claude
          v = await getClaudeVersion();
          if (!v) throw new Error('装完 claude --version 跑不起来（可能平台二进制没装好）');
          if (v.version !== c.version) throw new Error(`装完是 ${v.version}，不是 ${c.version}（npm 可能装到了别的目录）`);
          break;
        } catch (e) {
          const tail = (e.stderr || e.stdout || e.message || '').split('\n').filter(l => l.trim()).slice(-3).join('\n');
          fails.push(`${registryName(c.registry)}：${tail}`);
          v = null;
        }
      }
      if (!v) throw new Error(fails.join('\n\n') + '\n\n可登录这台电脑手动执行：npm i -g @anthropic-ai/claude-code@latest --include=optional --registry https://registry.npmmirror.com');
      _claudeUpgrade = { running: false, ok: true, error: null, version: v.version, startedAt: _claudeUpgrade.startedAt };
      console.log('[myhi] claude 升级完成 ->', v.version);
    } catch (err) {
      const tail = (err.stderr || err.stdout || err.message || '').split('\n').filter(l => l.trim()).slice(-6).join('\n');
      _claudeUpgrade = { running: false, ok: false, error: tail, version: null, startedAt: _claudeUpgrade.startedAt };
      console.error('[myhi] claude 升级失败:', tail);
    }
  })();
});

// ---------------------------------------------------------------------------
// Git push API
// ---------------------------------------------------------------------------

app.post('/api/git/push', checkAuth, express.json(), sessBodyGuard, async (req, res) => {
  const { sessionId, url, username, password, message, branch } = req.body || {};

  if (!sessionId || !message) {
    return res.status(400).json({ ok: false, error: '缺少参数' });
  }

  const session = manager.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: '会话不存在' });
  }
  // 分支名 / 远程地址以 - 开头会被 git 当成选项（如 --receive-pack=<命令>）→ 参数注入
  if (branch != null && branch !== '' && (typeof branch !== 'string' || !/^[\w.\/-]{1,200}$/.test(branch) || branch.startsWith('-'))) {
    return res.status(400).json({ ok: false, error: '分支名不合法' });
  }
  if (url != null && url !== '' && (typeof url !== 'string' || !/^(https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(url))) {
    return res.status(400).json({ ok: false, error: '仓库地址不合法' });
  }
  if (typeof message !== 'string') return res.status(400).json({ ok: false, error: '缺少参数' });

  const cwd = session.cwd || process.cwd();
  const isWin = process.platform === 'win32';
  const git = 'git';

  function gitExec(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      const gitconfigPath = join(cwd, '.gitconfig');
      if (existsSync(gitconfigPath)) {
        env.GIT_CONFIG_GLOBAL = gitconfigPath;
      }

      const proc = spawn(git, args, { cwd, env, timeout: 60000 });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code =>
        code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `exit ${code}`))
      );
      proc.on('error', reject);
    });
  }

  try {
    // Ensure git repo exists
    try {
      await gitExec(['rev-parse', '--git-dir']);
    } catch {
      await gitExec(['init']);
    }

    // Configure credentials if provided
    if (url && username && password) {
      const credUrl = new URL(url);
      credUrl.username = encodeURIComponent(username);
      credUrl.password = encodeURIComponent(password);
      const credStr = credUrl.toString();
      const credFile = join(cwd, '.git-credentials');
      writeFileSync(credFile, credStr + '\n', { mode: 0o600 });

      const gitconfigPath = join(cwd, '.gitconfig');
      const gitconfigContent = `[credential]\n\thelper = store --file ${credFile.replace(/\\/g, '/')}\n[user]\n\tname = ${username}\n\temail = ${username}@myhi\n`;
      writeFileSync(gitconfigPath, gitconfigContent, { mode: 0o600 });

      try { await gitExec(['remote', 'remove', 'origin']); } catch {}
      await gitExec(['remote', 'add', 'origin', url]);
    }

    // 凭据文件就写在项目目录里：本地排除 + 移出暂存区，绝不能被 add -A 带进提交推到远端（.git-credentials 是明文 token）
    try {
      const gitDir = resolve(cwd, await gitExec(['rev-parse', '--git-dir']));
      const exclude = join(gitDir, 'info', 'exclude');
      const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      const add = ['/.git-credentials', '/.gitconfig'].filter((p) => !cur.split(/\r?\n/).includes(p));
      if (add.length) { mkdirSync(dirname(exclude), { recursive: true }); writeFileSync(exclude, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n'); }
      await gitExec(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', '.git-credentials', '.gitconfig']);
    } catch (e) { console.warn('[git] 排除凭据文件失败:', e.message); }

    // Stage, commit, push
    await gitExec(['add', '-A']);

    if (!await gitExec(['status', '--porcelain'])) {
      return res.json({ ok: true, message: '没有需要提交的变更', pushed: false });
    }

    await gitExec(['commit', '-m', message]);

    const targetBranch = branch || 'main';
    try {
      await gitExec(['push', '-u', 'origin', targetBranch]);
    } catch (err) {
      if (err.message.includes('src refspec') || err.message.includes('does not match')) {
        await gitExec(['checkout', '-b', targetBranch]);
        await gitExec(['push', '-u', 'origin', targetBranch]);
      } else {
        throw err;
      }
    }

    const lastCommit = await gitExec(['log', '--oneline', '-1']);
    res.json({ ok: true, message: `已提交并推送: ${lastCommit}`, pushed: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/git/info', checkAuth, (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessionId ? manager.get(sessionId) : null;
  if (!session) return res.json({});

  const cwd = session.cwd || process.cwd();
  try {
    const url = execSync('git remote get-url origin', {
      cwd, encoding: 'utf8', timeout: 5000,
    }).trim();
    const branch = execSync('git branch --show-current', {
      cwd, encoding: 'utf8', timeout: 5000,
    }).trim();

    let username = '';
    const gitconfigPath = join(cwd, '.gitconfig');
    if (existsSync(gitconfigPath)) {
      const match = readFileSync(gitconfigPath, 'utf8').match(/name\s*=\s*(.+)/);
      if (match) username = match[1].trim();
    }

    res.json({ url, branch: branch || 'main', username });
  } catch {
    res.json({});
  }
});

// ---------------------------------------------------------------------------
// Memory / Claude files API
// ---------------------------------------------------------------------------

// Skill 名称转文件路径：deploy:prod → deploy/prod.md
// 分屏新建任务：工作目录留空时按【任务名】建在「默认目录/任务名」下，避免多任务全堆在
// 同一默认目录（仅 opts.nestByTitle 时生效——首页在项目根建 agent 是正常用法，不嵌套）。
// 名称做文件系统安全清洗（去非法字符/前导点、限长）；清洗后为空则回落默认目录本身。
function taskCwdFromTitle(title, boundDir) {
  const base = boundDir ? resolve(normalize(boundDir)) : (process.env.MYHI_CWD || process.cwd());
  const name = String(title || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 80).trim();
  return name ? join(base, name) : base;
}

// ── 技能（见 src/skills.js）：斜杠命令 + Agent 技能；生成 / 分享 / 导入 / 团队仓库 ──
const BUILTIN_SKILLS_DIR = join(__dirname, 'builtin-skills');
const skillShares = createShareStore(join(configDir, 'skill-shares.json'));
const skillSubs = createSubStore(join(configDir, 'skill-subs.json'));
// 本机技能（scope 不是 project → ~/.claude/commands、skills）会被这台机器上所有人的任务加载，
// 等于往别人的 bypassPermissions 会话里注入提示词 → 只许管理员写；成员只能装 / 改「本项目」技能
function skillScopeGuard(req, res, next) {
  const user = getUserInfo(req.headers.cookie);
  if (!user || user.role === 'admin' || _hasAdminBearer(req)) return next();
  const b = req.body || {};
  const sub = b.subId ? skillSubs.raw(b.subId) : null;
  const scope = sub ? sub.scope : b.scope;
  if (scope !== 'project') return res.status(403).json({ ok: false, error: '本机技能会影响这台机器上所有人的任务，只有管理员能改。请选择「本项目」' });
  next();
}
const sessCwd = (sessionId) => manager.get(sessionId || '')?.cwd || process.cwd();
const skillKind = (k) => (k === 'skill' ? 'skill' : 'command');
const skillErr = (res, e, code = 400) => res.status(code).json({ ok: false, error: e.message || String(e) });
// 技能变了：让受影响的任务重新加载（本项目技能 → 同目录的任务；本机技能 → 所有任务）
function notifySkillsChanged(cwd, scope) {
  const norm = (p) => { const r = resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
  let n = 0;
  for (const s of manager.listSessions()) {
    if (s.mode !== 'agent' || typeof s.refreshSkills !== 'function') continue;
    if (scope === 'project' && norm(s.cwd) !== norm(cwd)) continue;
    if (s.refreshSkills()) n++;
  }
  return n;
}

app.get('/api/skills', checkAuth, (req, res) => {
  const { skills, dirs } = listSkills(sessCwd(req.query.sessionId), BUILTIN_SKILLS_DIR, req.query.detail === '1');
  res.json({ skills, dirs });
});

// 单个技能的内容（内置命令执行时前端拉取 / 编辑器打开）
app.get('/api/skills/content', checkAuth, (req, res) => {
  const { name, kind } = req.query;
  if (!name) return res.status(400).json({ error: '缺少 name' });
  const cwd = sessCwd(req.query.sessionId);
  const sources = req.query.source ? [req.query.source] : ['project', 'user', 'builtin'];
  for (const source of sources) {
    try {
      const pkg = packSkill(cwd, { name, source, kind: skillKind(kind) }, BUILTIN_SKILLS_DIR);
      const main = pkg.kind === 'skill' ? pkg.files.find((f) => f.path === 'SKILL.md') : pkg.files[0];
      return res.json({ content: main.content, source, kind: pkg.kind, files: pkg.files.map((f) => f.path) });
    } catch {}
  }
  res.status(404).json({ error: '技能不存在' });
});

app.post('/api/skills', checkAuth, express.json({ limit: '1mb' }), sessBodyGuard, skillScopeGuard, (req, res) => {
  const { name, content, scope, kind } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: '缺少 name 或 content' });
  try {
    const cwd = sessCwd(req.query.sessionId);
    const path = saveSkill(cwd, { name, content, scope, kind: skillKind(kind) });
    notifySkillsChanged(cwd, scope);
    res.json({ ok: true, path });
  }
  catch (e) { skillErr(res, e); }
});

app.delete('/api/skills', checkAuth, express.json(), sessBodyGuard, skillScopeGuard, (req, res) => {
  const { name, scope, kind } = req.body || {};
  if (!name) return res.status(400).json({ error: '缺少 name' });
  try { const cwd = sessCwd(req.query.sessionId); deleteSkill(cwd, { name, source: scope, kind: skillKind(kind) }); notifySkillsChanged(cwd, scope); res.json({ ok: true }); }
  catch (e) { skillErr(res, e); }
});

// 打包一个本机技能用于分享：查出疑似密钥就拦下（force 才放行）
function packForShare(req) {
  const { sessionId, name, source, kind, force } = req.body || {};
  const pkg = packSkill(sessCwd(sessionId), { name, source, kind: skillKind(kind) }, BUILTIN_SKILLS_DIR);
  pkg.from = machineName();
  pkg.exportedAt = Date.now();
  const secrets = scanSecrets(pkg);
  if (secrets.length && !force) {
    const e = new Error('技能里像是写进了敏感信息：' + secrets.slice(0, 3).map((h) => `${h.file} 第 ${h.line} 行（${h.what}）`).join('；') + '。请先编辑删掉；确认是误报可以继续');
    e.secrets = secrets;
    throw e;
  }
  return pkg;
}
app.post('/api/skills/export', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  try { const pkg = packForShare(req); res.json({ ok: true, pkg, code: encodeShareCode(pkg) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message, secrets: e.secrets }); }
});
app.post('/api/skills/share-link', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  try {
    const pkg = packForShare(req);
    const { token, expires } = skillShares.create(pkg);
    res.json({ ok: true, url: `${req.protocol}://${req.get('host')}/s/skill/${token}`, expires });
  } catch (e) { res.status(400).json({ ok: false, error: e.message, secrets: e.secrets }); }
});
// 分享链接：凭链接里的随机令牌取技能包（不用登录；24 小时后失效）
app.get('/s/skill/:token', (req, res) => {
  const pkg = skillShares.get(req.params.token);
  if (!pkg) return res.status(404).json({ error: '分享链接不存在或已过期' });
  res.json(pkg);
});

// 拉另一台 myhi 的分享链接（myhi 默认自签证书，只对这个请求放宽证书校验；内容安装前还要预览 + 扫描）
function fetchSharedSkill(url) {
  return new Promise((resolvePromise, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('链接格式不对')); }
    if (!/^https?:$/.test(u.protocol) || !/^\/s\/skill\/[\w-]+$/.test(u.pathname)) return reject(new Error('这不是 myhi 技能分享链接'));
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const r = mod(u, { method: 'GET', timeout: 15000, rejectUnauthorized: false }, (resp) => {
      let body = '', size = 0;
      resp.on('data', (c) => { size += c.length; if (size > 3 * 1024 * 1024) { r.destroy(); reject(new Error('内容太大')); } else body += c; });
      resp.on('end', () => {
        let d; try { d = JSON.parse(body); } catch { return reject(new Error('对方返回的不是技能包')); }
        if (resp.statusCode !== 200) return reject(new Error(d.error || ('HTTP ' + resp.statusCode)));
        resolvePromise(d);
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('连接超时：两台 myhi 网络不通？')); });
    r.on('error', (e) => reject(new Error('连不上对方：' + e.message)));
    r.end();
  });
}

// 导入预览：分享码 / 技能包文件内容 / 分享链接 → 规整 + 安全扫描 + 是否已有同名
app.post('/api/skills/preview', checkAuth, express.json({ limit: '4mb' }), sessBodyGuard, async (req, res) => {
  const { sessionId, code, pkg: raw, url } = req.body || {};
  try {
    let src = raw;
    if (url) src = await fetchSharedSkill(String(url).trim());
    else if (code) src = decodeShareCode(code);
    const pkg = normalizePack(typeof src === 'string' ? JSON.parse(src) : src);
    const cwd = sessCwd(sessionId);
    res.json({ ok: true, pkg, findings: scanPack(pkg), exists: { project: skillExists(cwd, pkg, 'project'), user: skillExists(cwd, pkg, 'user') } });
  } catch (e) { skillErr(res, e); }
});
app.post('/api/skills/install', checkAuth, express.json({ limit: '4mb' }), sessBodyGuard, skillScopeGuard, (req, res) => {
  const { sessionId, pkg, scope } = req.body || {};
  try {
    const cwd = sessCwd(sessionId), sc = scope === 'project' ? 'project' : 'user';
    const path = installPack(cwd, pkg, sc);
    notifySkillsChanged(cwd, sc);
    res.json({ ok: true, path });
  }
  catch (e) { skillErr(res, e); }
});

// 发布到团队仓库
app.post('/api/skills/publish', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  try {
    const pkg = packForShare(req);
    const { url, username, password, branch } = req.body || {};
    const who = getUserInfo(req.headers.cookie)?.name || machineName();
    res.json(publishToRepo({ url, username, password, branch }, pkg, who));
  } catch (e) { res.status(400).json({ ok: false, error: e.message, secrets: e.secrets }); }
});

// 团队仓库：扫描（一次性导入和订阅共用）/ 订阅列表 / 安装并订阅 / 检查更新 / 取消订阅
const packView = (p) => ({ name: p.name, kind: p.kind, desc: p.desc, files: p.files.map((f) => f.path), hash: packHash(p), findings: scanPack(p) });
function repoOpts(body, sub) {
  return { url: body?.url || sub?.url, username: body?.username || sub?.username, password: body?.password || sub?.password, branch: body?.branch ?? sub?.branch };
}
app.post('/api/skills/repo/scan', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  try {
    const packs = withRepo(repoOpts(req.body), (dir) => scanRepoDir(dir));
    res.json({ ok: true, skills: packs.map(packView) });
  } catch (e) { skillErr(res, e); }
});
app.get('/api/skills/subs', checkAuth, (req, res) => res.json({ ok: true, subs: skillSubs.list() }));
app.post('/api/skills/repo/install', checkAuth, express.json(), sessBodyGuard, skillScopeGuard, (req, res) => {
  const body = req.body || {};
  const scope = body.scope === 'project' ? 'project' : 'user';
  const sub = body.subId ? skillSubs.raw(body.subId) : null;
  const cwd = sub?.scope === 'project' ? sub.cwd : sessCwd(body.sessionId);
  try {
    const names = new Set((body.names || []).map(String));
    const installed = {}, done = [];
    withRepo(repoOpts(body, sub), (dir) => {
      for (const p of scanRepoDir(dir)) {
        const key = p.kind + ':' + p.name;
        if (!names.has(key)) continue;
        installPack(cwd, p, sub ? sub.scope : scope);
        installed[key] = packHash(p);
        done.push(key);
      }
    });
    if (done.length) notifySkillsChanged(cwd, sub ? sub.scope : scope);
    let saved = null;
    if (sub || body.subscribe) {
      saved = skillSubs.upsert({
        url: repoOpts(body, sub).url, username: body.username ?? sub?.username, password: body.password, branch: body.branch ?? sub?.branch,
        scope: sub ? sub.scope : scope, cwd: (sub ? sub.scope : scope) === 'project' ? cwd : '', installed,
        updates: (sub?.updates || []).filter((u) => !done.includes(u.kind + ':' + u.name)), lastCheck: Date.now(),
      });
    }
    res.json({ ok: true, installed: done, sub: saved });
  } catch (e) { skillErr(res, e); }
});
app.post('/api/skills/subs/:id/check', checkAuth, (req, res) => {
  const sub = skillSubs.raw(req.params.id);
  if (!sub) return res.status(404).json({ ok: false, error: '订阅不存在' });
  try {
    const updates = withRepo(repoOpts(null, sub), (dir) => scanRepoDir(dir)
      .map((p) => {
        const key = p.kind + ':' + p.name, old = sub.installed?.[key];
        if (old === packHash(p)) return null;
        return { ...packView(p), status: old ? 'changed' : 'new' };
      }).filter(Boolean));
    res.json({ ok: true, updates, sub: skillSubs.upsert({ ...sub, password: undefined, updates: updates.map((u) => ({ name: u.name, kind: u.kind, status: u.status })), lastCheck: Date.now() }) });
  } catch (e) { skillErr(res, e); }
});
// AI 自己写好了技能文件（「✨ 从本次任务生成」）：前端在那一轮结束后通知，让相关任务重新加载
app.post('/api/skills/changed', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const { sessionId, scope } = req.body || {};
  res.json({ ok: true, refreshed: notifySkillsChanged(sessCwd(sessionId), scope === 'user' ? 'user' : 'project') });
});
app.delete('/api/skills/subs/:id', checkAuth, (req, res) => { skillSubs.remove(req.params.id); res.json({ ok: true }); });

// 项目说明（cwd/CLAUDE.md）概况：会话页据此显示「📘 项目说明」标记 / 偏长提醒，以及在合适时机建议生成。
// siblings = 同目录的其他任务数、turns = 本任务用户发言数——都是「这是长期项目」的信号。只回统计，不回内容。
const ASIDE_MAX_CONCURRENT = 6;   // 「问一问」全服务同时在跑的一次性 claude 进程上限
let _asideRunning = 0;
const GUIDE_LONG_LINES = 200, GUIDE_LONG_BYTES = 16 * 1024;
app.get('/api/session/:id/guide', checkAuth, (req, res) => {
  const sess = manager.get(req.params.id);
  if (!sess) return res.status(404).json({ error: '会话不存在' });
  const norm = (p) => { const r = resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const cwd = norm(sess.cwd);
  let exists = false, lines = 0, bytes = 0;
  try {
    const txt = readFileSync(join(sess.cwd, 'CLAUDE.md'), 'utf8');
    exists = true; bytes = Buffer.byteLength(txt); lines = txt.split('\n').length;
  } catch {}
  const siblings = manager.listSessions().filter(s => s !== sess && s.mode === 'agent' && s.cwd && norm(s.cwd) === cwd).length;
  const turns = Array.isArray(sess._history) ? sess._history.filter(h => h.type === 'user').length : 0;
  res.json({ exists, lines, bytes, long: lines > GUIDE_LONG_LINES || bytes > GUIDE_LONG_BYTES, siblings, turns });
});

app.get('/api/memory', checkAuth, (req, res) => {
  const sessionId = req.query.sessionId;
  const scope = req.query.scope === 'all' ? 'all' : 'project'; // 默认只看本项目
  const session = sessionId ? manager.get(sessionId) : null;
  if (!session) return res.json({ files: [], scope });

  const cwd = session.cwd || process.cwd();
  // Claude Code 把 cwd 编码成 projects 子目录名：非字母数字一律换 '-'（D:\project\myhi → D--project-myhi）
  const curProjDir = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  // 成员隔离：所有人的任务跑在同一个系统用户下，~/.claude/projects 里是全部成员的项目记忆。
  // 非管理员看「全部」时只列自己能访问的任务所在目录（以前遍历整个目录 → 能读到别人所有项目的记忆）；
  // 全局记忆对非管理员只读（改了会影响所有人的任务）
  const user = getUserInfo(req.headers.cookie);
  const isAdmin = !user || user.role === 'admin';
  const myProjDirs = isAdmin ? null : new Set(
    manager.list(user.name, false).map((x) => String(x.cwd || '').replace(/[^a-zA-Z0-9]/g, '-')).concat(curProjDir));
  const files = [];

  // Project CLAUDE.md
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try { files.push({ name: 'CLAUDE.md', content: readFileSync(claudeMdPath, 'utf8') }); } catch {}
  }

  // Project .claude/settings.json
  const settingsPath = join(cwd, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try { files.push({ name: '.claude/settings.json', content: readFileSync(settingsPath, 'utf8') }); } catch {}
  }

  // Global ~/.claude/CLAUDE.md（全局指令）——仅「全部」范围显示，本项目范围不列
  if (scope === 'all') {
    const globalClaudeMd = join(homedir(), '.claude', 'CLAUDE.md');
    if (existsSync(globalClaudeMd)) {
      try { files.push({ name: '~/.claude/CLAUDE.md', content: readFileSync(globalClaudeMd, 'utf8'), readonly: !isAdmin }); } catch {}
    }
  }

  // Memory files from ~/.claude/memory and project memory directories
  const globalMemoryDirs = [join(homedir(), '.claude', 'memory')];

  const projectsDir = join(homedir(), '.claude', 'projects');
  if (existsSync(projectsDir)) {
    try {
      for (const projEntry of readdirSync(projectsDir)) {
        if (scope !== 'all' && projEntry !== curProjDir) continue; // 本项目范围：只当前项目目录
        if (myProjDirs && !myProjDirs.has(projEntry)) continue;   // 非管理员：只看自己任务所在的项目
        const otherProj = projEntry !== curProjDir;               // 别的项目：只读（编辑入口按当前项目解析路径，会写错地方）
        const memDir = join(projectsDir, projEntry, 'memory');
        if (existsSync(memDir)) {
          // Also check project CLAUDE.md
          const projClaudeMd = join(projectsDir, projEntry, 'CLAUDE.md');
          if (existsSync(projClaudeMd)) {
            try {
              files.push({
                name: `.claude/projects/${projEntry}/CLAUDE.md`,
                content: readFileSync(projClaudeMd, 'utf8'), readonly: otherProj,
              });
            } catch {}
          }

          try {
            for (const f of readdirSync(memDir)) {
              if (!f.endsWith('.md')) continue;
              const filePath = join(memDir, f);
              try {
                files.push({ name: `memory/${f}`, content: readFileSync(filePath, 'utf8'), readonly: otherProj, ...(otherProj ? { project: projEntry } : {}) });
              } catch {}
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 全局 ~/.claude/memory —— 仅「全部」范围显示
  if (scope === 'all') {
    for (const dir of globalMemoryDirs) {
      if (existsSync(dir)) {
        try {
          for (const f of readdirSync(dir)) {
            if (!f.endsWith('.md')) continue;
            const filePath = join(dir, f);
            try {
              files.push({ name: `~/.claude/memory/${f}`, content: readFileSync(filePath, 'utf8'), readonly: !isAdmin });
            } catch {}
          }
        } catch {}
      }
    }
  }

  res.json({ files, scope });
});

// 记忆维护：编辑/删除单个记忆文件。只白名单已知的 memory 路径模式（+ 拦 `..`、文件名不含斜杠），防路径穿越。
const _SAFE_MD = /^[\w.\- ]+\.md$/;
function memoryTarget(cwd, name, isAdmin = true) {
  const home = homedir();
  if (!isAdmin && typeof name === 'string' && name.startsWith('~/')) return { denied: '全局记忆会影响这台机器上所有人的任务，只有管理员能改' };
  if (typeof name !== 'string' || name.includes('..')) return null;
  if (name.startsWith('memory/')) {
    const f = name.slice(7); if (!_SAFE_MD.test(f)) return null;
    const proj = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    return { path: join(home, '.claude', 'projects', proj, 'memory', f), deletable: true };
  }
  if (name.startsWith('~/.claude/memory/')) {
    const f = name.slice(17); if (!_SAFE_MD.test(f)) return null;
    return { path: join(home, '.claude', 'memory', f), deletable: true };
  }
  if (name === '~/.claude/CLAUDE.md') return { path: join(home, '.claude', 'CLAUDE.md'), deletable: false };
  if (name === 'CLAUDE.md') return { path: join(cwd, 'CLAUDE.md'), deletable: false };
  if (name === '.claude/settings.json') return { path: join(cwd, '.claude', 'settings.json'), deletable: false };
  const m = name.match(/^\.claude\/projects\/([\w.\-]+)\/CLAUDE\.md$/);
  if (m) {
    if (m[1] !== String(cwd).replace(/[^a-zA-Z0-9]/g, '-')) return { denied: '只能改当前任务所在项目的记忆' };
    return { path: join(home, '.claude', 'projects', m[1], 'CLAUDE.md'), deletable: false };
  }
  return null;
}

app.post('/api/memory/save', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const { sessionId, name, content } = req.body || {};
  const s = sessionId ? manager.get(sessionId) : null;
  const u = getUserInfo(req.headers.cookie);
  const t = memoryTarget(s?.cwd || process.cwd(), name, !u || u.role === 'admin');
  if (t?.denied) return res.status(403).json({ error: t.denied });
  if (!t) return res.status(400).json({ error: '不支持编辑该文件' });
  if (typeof content !== 'string') return res.status(400).json({ error: '缺少内容' });
  try { mkdirSync(dirname(t.path), { recursive: true }); writeFileSync(t.path, content, 'utf8'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/memory/delete', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const { sessionId, name } = req.body || {};
  const s = sessionId ? manager.get(sessionId) : null;
  const u = getUserInfo(req.headers.cookie);
  const t = memoryTarget(s?.cwd || process.cwd(), name, !u || u.role === 'admin');
  if (t?.denied) return res.status(403).json({ error: t.denied });
  if (!t || !t.deletable) return res.status(400).json({ error: '该文件不允许删除（只允许删 memory/*.md）' });
  try { if (existsSync(t.path)) unlinkSync(t.path); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Admin API — token auth
// ---------------------------------------------------------------------------

const _adminTokens = new Set();
const SERVER_START_TIME = Date.now();

function checkAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && _adminTokens.has(authHeader.slice(7))) {
    return next();
  }
  res.status(401).json({ error: '未授权' });
}

app.post('/api/admin/login', express.json(), (req, res) => {
  const ip = req.ip;
  if (!checkLoginRate(ip)) return res.status(429).json({ ok: false, error: '尝试次数过多，请 5 分钟后再试' });
  const { password } = req.body || {};
  if (typeof password === 'string' && password === PASSWORD) {
    clearLoginFailures(ip);
    const token = randomBytes(16).toString('hex');
    _adminTokens.add(token);
    return res.json({ ok: true, token });
  }
  recordLoginFailure(ip);
  res.json({ ok: false, error: '密码错误' });
});

// 免二次登录：主站已是管理员身份（token / 管理密码登录）进 /admin 直接换后台令牌，不用再输一遍管理密码。
// 成员（users.json）不给，仍走管理密码登录。后台令牌只在内存，重启后失效，页面每次加载都先走这里拿新的。
app.post('/api/admin/sso', checkAuth, requireAdmin, (req, res) => {
  const token = randomBytes(16).toString('hex');
  _adminTokens.add(token);
  res.json({ ok: true, token });
});

app.get('/api/admin/status', checkAdminAuth, async (req, res) => {
  const latest = await checkLatestVersion();
  loadUsers();

  const onlineUsers = [];
  const seen = new Set();
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.data.userName || seen.has(socket.data.userName)) continue;
    seen.add(socket.data.userName);
    onlineUsers.push({ name: socket.data.userName, role: socket.data.role || 'viewer' });
  }

  const sessions = manager.listSessions()
    .filter(s => s.alive !== false)
    .map(s => ({
      id: s.id, title: s.title, mode: s.mode || 'pty',
      owner: s.owner, viewers: s.viewerCount || 0,
    }));

  res.json({
    version: {
      current: PKG_VERSION,
      latest: latest || PKG_VERSION,
      updateAvailable: !!latest && semverGt(latest, PKG_VERSION),
    },
    onlineUsers,
    sessions,
    users: listUsers(),
    exclusive: isExclusiveMode(),
    uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
  });
});

app.post('/api/admin/upgrade', checkAdminAuth, express.json(), handleUpgrade);

app.post('/api/admin/restart', checkAdminAuth, (req, res) => {
  res.json({ ok: true });
  setTimeout(() => restartService(), 300);
});

// 成员用户自助改密：凭原密码改自己的密码（区别于 /api/admin/user/password 的管理员强改）。
// 双重校验：① 原密码正确且归属当前登录用户；② 新密码不得与其他用户/全局管理密码重复。
app.post('/api/user/password', checkAuth, express.json(), sessBodyGuard, (req, res) => {
  const user = getUserInfo(req.headers.cookie);
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.json({ ok: false, error: '原密码和新密码都必填' });
  }
  if (newPassword.length < 4) {
    return res.json({ ok: false, error: '新密码至少 4 位' });
  }
  loadUsers();
  if (!hasUsers()) {
    return res.json({ ok: false, error: '本机未配置成员用户（单管理员模式无自助改密）' });
  }
  // 新密码不得与全局管理密码重复——登录时 users.json 优先匹配，重复会让两个身份搅在一起
  if (newPassword === PASSWORD) {
    return res.json({ ok: false, error: '新密码不能与管理密码重复' });
  }
  const result = changeUserPassword(oldPassword, newPassword, user?.name);
  if (result.ok) {
    console.log(`[用户] ${user?.name} 修改了自己的密码`);
  }
  res.json(result);
});

// ── 使用模式：有成员 = 多用户，没有成员 = 单用户（默认）。不另设模式开关，免得出现「多用户但没成员」──
app.post('/api/admin/user', checkAdminAuth, express.json(), (req, res) => {
  const password = String(req.body?.password || '').trim();
  const name = String(req.body?.name || '').trim();
  const dir = String(req.body?.dir || '').trim();   // 留空 = 不限制目录
  if (!password || !name) return res.json({ ok: false, error: '名称和登录密码必填' });
  if (password.length < 4) return res.json({ ok: false, error: '登录密码至少 4 位' });
  if (isReservedPassword(password)) return res.json({ ok: false, error: '该密码不可用，请换一个' });
  // 密码就是登录凭据（users.json 以密码为键）：与管理密码或别人的密码相同，登录时就分不清是谁
  if (password === PASSWORD) return res.json({ ok: false, error: '不能与管理密码相同' });
  loadUsers();
  if (lookupUser(password)) return res.json({ ok: false, error: '这个密码已被其他成员使用，请换一个' });
  if (listUsers().some((u) => u.name === name)) return res.json({ ok: false, error: '已有同名成员' });
  addUser(password, name, dir || undefined);
  if (dir) try {
    mkdirSync(dir, { recursive: true });
    const gitconfigPath = join(dir, '.gitconfig');
    const credFile = join(dir, '.git-credentials');
    if (!existsSync(gitconfigPath)) {
      writeFileSync(gitconfigPath,
        `[credential]\n\thelper = store --file ${credFile.replace(/\\/g, '/')}\n[user]\n\tname = ${name}\n`,
        { mode: 0o600 }
      );
    }
  } catch {}

  syncMemberRoles();
  console.log(`[管理] 添加用户 ${name} (目录: ${dir || '不限'})${isMultiUser() ? '' : '（单用户模式：它拥有全部权限）'}`);
  res.json({ ok: true });
});

// 删成员 / 改密后让这个人现有的登录立刻失效（以前删了还能一直用到自己退出）
function revokeUserSessions(name) {
  for (const [tok, sess] of userSessions) if (sess?.member && sess.name === name) userSessions.delete(tok);
  if (activeUser?.name === name) activeUser = null;
}
// 账号数跨过 1↔2（单用户 ↔ 多用户）：已登录账号的角色跟着变，不用重新登录
//   加第二个账号 → 原来那个从管理员降为成员；删到只剩一个 → 它升回管理员
function syncMemberRoles() {
  const role = memberRole();
  for (const [, sess] of userSessions) if (sess?.member) sess.role = role;
  for (const [, sk] of io.sockets.sockets) if (sk.data.member) sk.data.role = role;
}

app.post('/api/admin/exclusive', checkAdminAuth, express.json(), (req, res) => {
  loadUsers();
  if (!isMultiUser()) return res.json({ ok: false, error: '单用户模式下无需独占模式（2 个及以上账号才有）' });
  setExclusiveMode(!!req.body?.on);
  console.log(`[管理] 独占模式${req.body?.on ? '开启' : '关闭'}`);
  res.json({ ok: true, exclusive: isExclusiveMode() });
});

app.delete('/api/admin/user', checkAdminAuth, express.json(), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.json({ ok: false, error: '请指定用户名称' });

  loadUsers();
  if (!listUsers().find(u => u.name === name)) {
    return res.json({ ok: false, error: '用户不存在' });
  }

  try {
    const usersFile = join(configDir, 'users.json');
    const data = JSON.parse(readFileSync(usersFile, 'utf8'));
    for (const [pwd, info] of Object.entries(data.users || {})) {
      if (info.name === name) {
        delete data.users[pwd];
        break;
      }
    }
    writeFileSync(usersFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    loadUsers();
    revokeUserSessions(name);
    syncMemberRoles();
    // 回到单用户就清掉独占设置，免得下次再到多用户时它悄悄生效
    if (!isMultiUser()) { try { setExclusiveMode(false); } catch {} }
    console.log(`[管理] 删除用户 ${name}${isMultiUser() ? '' : '（回到单用户模式）'}`);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/user/password', checkAdminAuth, express.json(), (req, res) => {
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '').trim();
  if (!name || !password) return res.json({ ok: false, error: '名称和新密码必填' });
  if (password.length < 4) return res.json({ ok: false, error: '登录密码至少 4 位' });
  if (password === PASSWORD) return res.json({ ok: false, error: '不能与管理密码相同' });
  loadUsers();
  const owner = lookupUser(password);
  if (owner && owner.name !== name) return res.json({ ok: false, error: '这个密码已被其他成员使用，请换一个' });

  try {
    const usersFile = join(configDir, 'users.json');
    const data = JSON.parse(readFileSync(usersFile, 'utf8'));
    let found = null;
    for (const [pwd, info] of Object.entries(data.users || {})) {
      if (info.name === name) {
        found = info;
        delete data.users[pwd];
        break;
      }
    }
    if (!found) return res.json({ ok: false, error: '用户不存在' });

    data.users[password] = found;
    writeFileSync(usersFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    loadUsers();
    revokeUserSessions(name);
    console.log(`[管理] 修改用户 ${name} 的密码`);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/password', checkAdminAuth, express.json(), (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) {
    return res.json({ ok: false, error: '密码至少4位' });
  }
  try {
    writeFileSync(join(configDir, 'password'), password, { mode: 0o600 });
    PASSWORD = password;
    res.json({ ok: true });
    console.log('[管理] 管理密码已修改');
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Upload route
// ---------------------------------------------------------------------------

// 上传过期清理：config.json 的 uploadRetentionDays（默认 30，0=不清理）。
// 扫 ~/.myhi/uploads 与当前各会话 <cwd>/upload；启动 1 分钟后跑一次，之后每天一次
function _sweepUploads() {
  const v = _readConfig().uploadRetentionDays;
  const days = typeof v === 'number' ? v : 30;
  const dirs = [uploadDir, ...manager.listSessions().filter((s) => s.cwd).map((s) => join(s.cwd, 'upload'))];
  const n = sweepUploads(dirs, days);
  if (n) console.log(`[uploads] 清理 ${n} 个超过 ${days} 天的上传文件`);
}
setTimeout(_sweepUploads, 60_000).unref();
setInterval(_sweepUploads, 86400_000).unref();

// 出图 / 语音历史保留天数：config.json 的 historyRetentionDays（缺省 / 0 = 一直保留，用户要求的默认）。
// 启动 1 分钟后清一次，之后每天一次；改了设置立刻清一次
const historyRetentionDays = () => { const v = Number(_readConfig().historyRetentionDays); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; };
function _sweepHistory() {
  const days = historyRetentionDays();
  if (!days) return { studio: 0, minutes: 0 };
  const r = { studio: studioPurge(days), minutes: minutes.purgeJobs(days) };
  if (r.studio || r.minutes) console.log(`[历史] 清理超过 ${days} 天的历史：出图 ${r.studio} 条、语音 ${r.minutes} 条`);
  return r;
}
setTimeout(_sweepHistory, 60_000).unref();
setInterval(_sweepHistory, 86400_000).unref();
app.get('/api/history-retention', adminBearerOr(checkAuth), (req, res) => res.json({ days: historyRetentionDays() }));
app.post('/api/history-retention', adminBearerOr(checkAuth, requireAdmin), express.json(), (req, res) => {
  const n = Number(req.body?.days);
  if (!Number.isFinite(n) || n < 0 || n > 36500) return res.status(400).json({ ok: false, error: '天数要在 0～36500 之间（0 = 一直保留）' });
  try {
    const cfg = _readConfig();
    if (n > 0) cfg.historyRetentionDays = Math.floor(n); else delete cfg.historyRetentionDays;
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    res.json({ ok: true, days: historyRetentionDays(), purged: _sweepHistory() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/upload', checkAuth, (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessionId ? manager.get(sessionId) : null;
  const destDir = session?.cwd ? join(session.cwd, 'upload') : uploadDir;
  mkdirSync(destDir, { recursive: true });

  multer({
    storage: multer.diskStorage({
      destination: destDir,
      filename: (req2, file, cb) => {
        const ext = file.originalname.match(/\.[^.]+$/)?.[0] || '.jpg';
        cb(null, `${Date.now()}-${randomBytes(3).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req2, file, cb) => cb(null, file.mimetype.startsWith('image/')),
  }).single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '没有图片' });
    res.json({ path: resolve(req.file.path).replace(/\\/g, '/') });
  });
});

// 临时文件上传（任意类型）：存到 ~/.myhi/uploads/（**不进项目 cwd**，不污染任务文件树），
// 只为让本会话的 AI 用 Read 工具即时分析。返回绝对路径，前端拼进 prompt。
app.post('/upload-file', checkAuth, (req, res) => {
  mkdirSync(uploadDir, { recursive: true });
  multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req2, file, cb) => {
        // multer 默认把 multipart filename 按 latin1 解码，中文 UTF-8 字节会错乱。
        // 先按 utf8 重解码并 mutate，使落盘名与返回给前端的 name 都是正确中文。
        file.originalname = Buffer.from(file.originalname || 'file', 'latin1').toString('utf8');
        // 保留原始文件名（去路径分隔），加时间戳前缀防冲突，便于 AI 认出文件类型
        const safe = file.originalname.replace(/[\\/:*?"<>|]/g, '_').slice(-80);
        cb(null, `${Date.now()}-${randomBytes(3).toString('hex')}-${safe}`);
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
  }).single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '没有文件' });
    res.json({ path: resolve(req.file.path).replace(/\\/g, '/'), name: req.file.originalname });
  });
});

// ---------------------------------------------------------------------------
// Voice transcription（SenseVoice ASR）
// ---------------------------------------------------------------------------

app.post('/api/voice-transcribe', checkAuth,
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 },
  }).single('audio'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '无音频数据' });

    const asrUrl = process.env.ASR_URL ||
      (() => { try { return JSON.parse(readFileSync(join(homedir(), '.myhi', 'asr.json'), 'utf8')).url; } catch { return null; } })();

    if (!asrUrl) {
      return res.status(503).json({ error: '未配置 ASR 服务，请设置 ASR_URL 环境变量或 ~/.myhi/asr.json' });
    }

    const mime = req.file.mimetype || 'audio/webm';
    const filename = req.file.originalname || 'audio.webm';
    try {
      const form = new FormData();
      form.append('audio', new Blob([req.file.buffer], { type: mime }), filename);
      const resp = await fetch(asrUrl + '/transcribe', { method: 'POST', body: form });
      const data = await resp.json();
      res.json({ text: data.text || '', error: data.error });
    } catch (e) {
      const cause = e.cause?.message || e.cause?.code || '';
      const detail = cause ? `${e.message} (${cause})` : e.message;
      console.error(`[myhi] ASR fetch 失败 url=${asrUrl} file=${filename} mime=${mime} size=${req.file.buffer.length}:`, detail, e.cause);
      res.status(500).json({ error: detail });
    }
  }
);

// ---------------------------------------------------------------------------
// Voice assistant — organize transcript into structured requirement
// ---------------------------------------------------------------------------

app.post('/api/voice-assist/organize', checkAuth, express.json(), sessBodyGuard, async (req, res) => {
  const { transcript } = req.body || {};
  if (!transcript?.trim()) return res.status(400).json({ error: '无转录内容' });

  const prompt = `用户通过语音口述了以下内容，原文如下：

---
${transcript}
---

请将上述口语化、随意性较强的文字整理成表达清晰、语言严谨的书面描述。要求：
1. 去除口头禅、语气词、重复啰嗦的部分
2. 保持原意，不添加、不删减实质内容
3. 语言自然流畅，不需要分条列项，保持连贯段落
4. 保留所有具体的数字、名称等关键信息

只输出整理后的文字，不需要任何解释或标题。必须用中文输出。`;

  try {
    const result = await new Promise((resolve, reject) => {
      let output = '';
      let errOut = '';
      // 和会话 / 问一问同一套：findClaude（处理 Windows 的 .cmd 外壳与各种安装位置）+ 网关配置 + 场景模型。
      // 以前自己拼路径、只用系统环境变量 → 没走 myhi 配的网关；也没指定模型 → 用默认的大模型改写几句话。
      // prompt 走 stdin：Windows cmd.exe 会在换行处截断引号内参数
      const launcher = findClaude();
      const model = sceneModel('voice') || sceneModel('ask') || 'sonnet';
      const child = spawn(launcher.command, [...launcher.preArgs, '--print', '--model', model, ...gatewaySettingsArgs()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...buildBaseClaudeEnv(), NO_COLOR: '1' },
        timeout: 90000,
        windowsHide: true,
      });
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { errOut += d.toString(); });
      child.on('close', (code) => {
        if (code !== 0 && !output.trim()) reject(new Error(errOut || `exit ${code}`));
        else resolve(output.trim());
      });
      child.on('error', reject);
    });
    res.json({ requirement: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// QR code route
// ---------------------------------------------------------------------------

app.get('/qr/:sessionId', checkAuth, async (req, res) => {
  const ip = getTailscaleIP();
  const onetimeToken = randomBytes(16).toString('hex');
  // 扫码登录继承「生成二维码的人」的身份：以前固定发 admin → 任何成员 / viewer 请求一次 /qr 就能提权成管理员
  const me = getUserInfo(req.headers.cookie) || { role: 'viewer', name: '扫码用户' };
  const { onetime: _o, permanent: _p, lastUsed: _l, ...ident } = me;
  userSessions.set(onetimeToken, { ...ident, onetime: true, lastUsed: Date.now() });
  const proto = httpsServer ? 'https' : 'http';
  const url = `${proto}://${ip}:${PORT}/terminal/${req.params.sessionId}?token=${onetimeToken}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg' });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ---------------------------------------------------------------------------
// Socket.IO auth middleware
// ---------------------------------------------------------------------------

io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie;
  if (hasValidSession(cookie)) {
    const user = getUserInfo(cookie);
    socket.data.role = user?.role || 'admin';
    socket.data.member = !!user?.member;
    socket.data.userName = user?.name || '用户';
    socket.data.dir = user?.dir || null;
    return next();
  }

  const password = socket.handshake.auth?.password;
  if (password) {
    const ip = 'ws:' + (socket.handshake.address || '');
    if (!checkLoginRate(ip)) return next(new Error('尝试次数过多，请稍后再试'));
    loadUsers();
    const user = lookupUser(password);
    if (!user) recordLoginFailure(ip);
    if (user) {
      clearLoginFailures(ip);
      socket.data.role = memberRole();
      socket.data.member = true;
      socket.data.userName = user.name;
      socket.data.dir = user.dir;
      return next();
    }
  }

  if ((socket.handshake.auth?.token || socket.handshake.query?.token) === TOKEN) {
    socket.data.role = 'admin';
    socket.data.userName = '管理员';
    return next();
  }

  next(new Error('未授权'));
});

// ---------------------------------------------------------------------------
// Exclusive mode release timer
// ---------------------------------------------------------------------------

const EXCLUSIVE_RELEASE_DELAY = 120 * 1000;
let _exclusiveReleaseTimer = null;

function checkExclusiveRelease() {
  if (!isExclusiveMode() || !activeUser) return;

  let hasOnline = false;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.userName === activeUser.name) {
      hasOnline = true;
      break;
    }
  }

  if (hasOnline) {
    if (_exclusiveReleaseTimer) {
      clearTimeout(_exclusiveReleaseTimer);
      _exclusiveReleaseTimer = null;
    }
    return;
  }

  if (!_exclusiveReleaseTimer) {
    _exclusiveReleaseTimer = setTimeout(() => {
      _exclusiveReleaseTimer = null;
      if (!activeUser) return;

      for (const [, socket] of io.sockets.sockets) {
        if (socket.data.userName === activeUser.name) return;
      }

      console.log(`[独占] ${activeUser.name} 已离线超时，释放登录状态（会话保留）`);
      for (const token of activeUser.tokens) {
        userSessions.delete(token);
      }
      activeUser = null;
    }, EXCLUSIVE_RELEASE_DELAY);
  }
}

// ---------------------------------------------------------------------------
// Broadcast sessions (debounced)
// ---------------------------------------------------------------------------

let _broadcastTimer = null;

function broadcastSessions() {
  if (_broadcastTimer) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    for (const [, socket] of io.sockets.sockets) {
      socket.emit('sessions', manager.list(socket.data.userName, socket.data.role === 'admin'));
    }
  }, 100);
}

// ---------------------------------------------------------------------------
// Socket.IO connection handler
// ---------------------------------------------------------------------------

// 从 UA 粗分「系统 · 浏览器」，配合来源 IP 区分同一账号的不同设备（手机 / 另一台电脑）。
// Tailscale 下每台设备 IP 固定，局域网 DHCP 一般也稳定，足够认出是哪台
function deviceOf(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /HarmonyOS|OpenHarmony/.test(ua) ? '鸿蒙' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /MicroMessenger/.test(ua) ? '微信' : /DingTalk/.test(ua) ? '钉钉' : /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' ');
}

io.on('connection', (socket) => {
  // 所有事件处理器统一兜底：socket.io 在 nextTick 里调监听器，处理器里抛一个 TypeError 就进 uncaughtException
  // → process.exit(1)，一条畸形消息（如不带参数的 resize）就能让整个服务连同所有会话一起掉线
  const _on = socket.on.bind(socket);
  // 访问控制（与 HTTP 侧同一规则）：带会话 id 的事件先查归属；改会话状态的事件要求 operator
  const SOCK_OPERATOR = new Set(['set-mode', 'rename', 'set-tags', 'agent:interrupt', 'release-control']);
  const sockUser = () => ({ role: socket.data.role, name: socket.data.userName });
  const sockDeny = (args, msg) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb({ ok: false, error: msg });
    socket.emit('control-denied', { reason: msg });
  };
  socket.on = (ev, fn) => _on(ev, (...args) => {
    if (SOCK_OPERATOR.has(ev) && !hasPermission(socket.data.role, 'operator')) return sockDeny(args, '只读账号不能执行此操作');
    const sid = (ev === 'join' || ev === 'kill') ? args[0] : args[0]?.sessionId;
    if (typeof sid === 'string' && sid) {
      const sess = manager.get(sid);
      if (sess && !canAccessSession(sockUser(), sess)) return sockDeny(args, '没有访问这个任务的权限');
    }
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error(`[socket] ${ev} 处理出错:`, e?.message || e));
    } catch (e) { console.error(`[socket] ${ev} 处理出错:`, e?.message || e); }
  });
  const addr = socket.handshake.address?.replace('::ffff:', '') || '?';
  socket.data.device = [deviceOf(socket.handshake.headers['user-agent']), addr].filter(Boolean).join(' · ');
  console.log(`[连接] ${socket.data.userName}(${socket.data.role}) 从 ${socket.data.device} 接入  id=${socket.id}`);

  // Cancel exclusive release if the user reconnects
  if (_exclusiveReleaseTimer && activeUser && socket.data.userName === activeUser.name) {
    clearTimeout(_exclusiveReleaseTimer);
    _exclusiveReleaseTimer = null;
  }

  let currentSession = null;
  let dataHandler = null;
  let agentMessageHandler = null;
  let agentBusyHandler = null;
  let interactionHandlers = null;   // AI 提问 / 方案审批 / 模式变化 → 推给本 socket
  let agentErrorHandler = null;
  let draftRelayHandler = null;

  function cleanupSession() {
    if (!currentSession) return;

    if (currentSession.isController(socket.id)) {
      currentSession.releaseControl();
      io.emit('control-changed', {
        sessionId: currentSession.id,
        holder: null,
        holderName: null,
      });
    }
    currentSession.removeViewer(socket.id);

    if (dataHandler) currentSession.off('data', dataHandler);
    if (agentMessageHandler) currentSession.off('agent:message', agentMessageHandler);
    if (agentBusyHandler) currentSession.off('agent:busy', agentBusyHandler);
    if (agentErrorHandler) currentSession.off('agent:error', agentErrorHandler);
    if (draftRelayHandler) currentSession.off('draft-relayed', draftRelayHandler);
    if (interactionHandlers) for (const [ev, fn] of Object.entries(interactionHandlers)) currentSession.off(ev, fn);
    interactionHandlers = null;

    dataHandler = null;
    agentMessageHandler = null;
    agentBusyHandler = null;
    agentErrorHandler = null;
    draftRelayHandler = null;
  }

  // -- join --
  socket.on('join', (sessionId) => {
    const sess = manager.get(sessionId);
    if (!sess) {
      socket.emit('error', { message: `会话 ${sessionId} 未找到` });
      return;
    }

    // 同一 socket 重新 join 同一会话（如 visibilitychange 触发的"重新订阅"），
    // 仅重挂监听，不再重发 history/scrollback，避免 chat.html 把权威历史
    // 追加到现有 DOM 上造成消息翻倍。
    const isResubscribe = currentSession?.id === sessionId;

    cleanupSession();
    currentSession = sess;
    currentSession.addViewer(socket.id, socket.data.userName);

    if (sess.mode === 'agent') {
      agentMessageHandler = (msg) => socket.emit('agent:message', msg);
      currentSession.on('agent:message', agentMessageHandler);
      agentBusyHandler = (busy) => socket.emit('agent:busy', busy);
      currentSession.on('agent:busy', agentBusyHandler);
      agentErrorHandler = (err) => socket.emit('agent:error', err);
      currentSession.on('agent:error', agentErrorHandler);
      // 自动接力发出了一条草稿 → 让页面刷新收件箱角标
      draftRelayHandler = (info) => socket.emit('draft-relayed', info);
      currentSession.on('draft-relayed', draftRelayHandler);
      const thisSess = currentSession;
      interactionHandlers = {
        'agent:interaction': (v) => socket.emit('agent:interaction', v),
        'agent:interaction-closed': (v) => socket.emit('agent:interaction-closed', v),
        // 方案被批准后 claude 在进程内切到免授权：同步「计划」按钮并落盘
        'mode-changed': (mode) => { socket.emit('mode-changed', { sessionId: thisSess.id, mode }); manager.persist(); },
      };
      for (const [ev, fn] of Object.entries(interactionHandlers)) currentSession.on(ev, fn);
    } else {
      dataHandler = (data) => socket.emit('output', data);
      currentSession.on('data', dataHandler);
      currentSession.once('exit', (code) => {
        socket.emit('session-exit', { code });
        if (dataHandler) currentSession?.off('data', dataHandler);
      });
      spawnLocalTerminal(sessionId, sess.title);
    }

    console.log(`[加入] ${socket.data.userName} 加入会话 "${sess.title}" (${sessionId})  模式=${sess.mode || 'pty'}${isResubscribe ? ' [重新订阅]' : ''}`);
    socket.emit('joined', { ...sess.toJSON(), role: socket.data.role });

    // Send history/scrollback (skip on re-subscribe to avoid client-side dup)
    if (isResubscribe) {
      // no history/scrollback replay
    } else if (sess.mode === 'agent') {
      // 历史回放以 transcript 为唯一权威源（与 REST 分页同源同序，offset 才能对齐——
      // 旧实现推内存 _history，条数与 transcript 序列对不上，翻页就会重复/漏消息）。
      // transcript 缺席（新会话/pty 误入/文件没了）退回 _history 兜底。
      let hist = null;
      try {
        // 首屏只推最近 100 条（以前 500 条，长会话近 1MB 且每次断线重连整包重发）；更早的往上翻时按页拉
        const t = readTranscript(sess.claudeSessionId, { offset: 0, limit: 100 });
        if (t.ok && t.messages.length) hist = t.messages;
      } catch { /* 兜底 _history */ }
      if (!hist?.length && sess._history?.length) hist = sess._history;
      if (hist?.length) {
        socket.emit('agent:history', hist);
      }
    } else if (sess._scrollback?.length) {
      const buf = sess._scrollback;
      if (buf.length <= 4096) {
        socket.emit('output', buf);
      } else {
        let offset = 0;
        (function sendChunk() {
          if (offset >= buf.length) return;
          socket.emit('output', buf.slice(offset, offset + 4096));
          offset += 4096;
          setImmediate(sendChunk);
        })();
      }
    }
    // AI 正在等人回答的提问 / 待审批的方案：打开或重连会话时补发（重新订阅也发，前端按 id 去重）
    if (sess.mode === 'agent') for (const v of sess.pendingInteractions || []) socket.emit('agent:interaction', v);

    broadcastSessions();
  });

  // -- disconnect --
  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.data.userName} 离开会话 "${currentSession?.title || '?'}"  id=${socket.id}`);
    cleanupSession();
    broadcastSessions();
    checkExclusiveRelease();
    manager.persist();
  });

  // -- agent query --
  socket.on('agent:query', async ({ prompt, display, via, visionPro } = {}) => {
    if (!currentSession || currentSession.mode !== 'agent') {
      socket.emit('agent:error', { message: '当前不是 Agent 模式会话' });
      return;
    }
    if (!currentSession.isController(socket.id)) {
      socket.emit('control-denied', { reason: '你没有当前会话的控制权' });
      return;
    }
    if (currentSession.isBusy) {
      socket.emit('agent:error', { message: currentSession.pendingInteractions?.length
        ? 'AI 正在等你回答提问 / 审批方案：请先在弹窗里处理（也可以点「跳过」让它自己决定）'
        : '正在处理中，请等待完成' });
      return;
    }
    // agent 模式不走 'input' 事件，得在这里刷新活跃时间，否则空闲清理器会把
    // 正在用的人的控制权收走（→ 每 5 分钟一次「已释放/已获取」刷屏）。
    currentSession.lastInputTime = Date.now();
    try {
      // /clear 记下操作人与来源（哪个页面 / 按钮还是手输），提示与日志里标明，便于事后查谁清的
      const actor = typeof prompt === 'string' && prompt.trim() === '/clear'
        ? { name: socket.data.userName, where: socket.handshake.query?.where, device: socket.data.device, via: via === 'button' ? 'button' : 'typed' }
        : null;
      await currentSession.query(prompt, { from: socket.id, display: typeof display === 'string' ? display : null, actor, visionPro: visionPro === true });
    } catch (err) {
      console.error('[agent:query] 错误:', err.message);
      try {
        if (socket.connected && !err.reported) socket.emit('agent:error', { message: err.message });
      } catch {}
    }
  });

  // -- ⚡ 插话：AI 正在干活时把一条消息（或一条草稿）直接送进当前这一轮，不打断 --
  socket.on('agent:inject', ({ prompt, display, draftId } = {}, cb) => {
    const reply = (r) => { if (typeof cb === 'function') cb(r); else if (!r.ok) socket.emit('agent:error', { message: r.error }); };
    if (!currentSession || currentSession.mode !== 'agent' || typeof currentSession.inject !== 'function') return reply({ ok: false, error: '当前不是 AI 任务' });
    if (!currentSession.isController(socket.id)) return reply({ ok: false, error: '你没有当前会话的控制权，不能插话' });
    let draft = null;
    if (draftId) {
      draft = loadDrafts().find((d) => d.id === draftId);
      if (!draft) return reply({ ok: false, error: '草稿不存在' });
      prompt = buildDraftPrompt(draft);
      display = draftDisplayText(draft) || prompt;
    }
    const r = currentSession.inject(String(prompt || ''), { display: display ? String(display) : undefined });
    if (r.ok && draft) { try { removeDraft(draft.id); } catch {} }
    currentSession.lastInputTime = Date.now();
    reply(r);
  });

  // -- 回答 AI 的提问 / 审批方案 --
  socket.on('agent:respond', ({ id, decision } = {}) => {
    if (!currentSession || currentSession.mode !== 'agent' || !currentSession.respondInteraction) return;
    if (!currentSession.isController(socket.id)) {
      socket.emit('control-denied', { reason: '你没有当前会话的控制权，不能代为回答' });
      return;
    }
    currentSession.lastInputTime = Date.now();
    const r = currentSession.respondInteraction(id, decision || {}, socket.data.userName || '用户');
    if (!r.ok) socket.emit('agent:error', { message: r.error });
  });

  // -- 💡 问一问：看不懂 AI 回复里的内容时在旁边小窗问，一次性 claude 调用，不进当前会话 --
  // 只读旁观者也能问（只是自己弄懂，不影响任务）；每个页面同时只跑一个，新问题顶掉旧的。
  socket.on('aside:ask', (req = {}) => {
    const reqId = String(req.reqId || '');
    const done = (r) => socket.emit('aside:done', { reqId, ...r });
    if (!currentSession || currentSession.mode !== 'agent') return done({ error: '只有 AI 任务里可以用「问一问」' });
    if (!String(req.selection || '').trim() && !String(req.question || '').trim()) return done({ error: '先选中想弄懂的内容，或输入问题' });
    if (socket.data.aside) socket.data.aside.cancel();
    if (_asideRunning >= ASIDE_MAX_CONCURRENT) return done({ error: '同时提问的人太多了，稍等几秒再试' });
    _asideRunning++;
    const model = sceneModel('ask') || 'sonnet';   // 场景模型「问一问 / 解释」（兼容老配置 askModel）
    let last = 0;
    const job = askAside(currentSession, {
      title: currentSession.title, userAsk: req.userAsk,
      // kind=plan：方案审批的「AI 帮我看重点」，整份方案作为 plan 传（上限比普通上下文大得多）
      context: req.kind === 'plan' ? '' : req.context, plan: req.kind === 'plan' ? String(req.context || '') : '',
      selection: req.selection, question: req.question, history: req.history,
    }, {
      model,
      onText: (text) => { const now = Date.now(); if (now - last > 120) { last = now; socket.emit('aside:delta', { reqId, text }); } },
    });
    socket.data.aside = job;
    job.promise.then((r) => {
      _asideRunning--;
      if (socket.data.aside === job) socket.data.aside = null;
      if (!r.cancelled) done(r);
    });
  });
  socket.on('aside:cancel', () => { if (socket.data.aside) { socket.data.aside.cancel(); socket.data.aside = null; } });
  socket.on('disconnect', () => { if (socket.data.aside) { socket.data.aside.cancel(); socket.data.aside = null; } });

  // -- agent interrupt --
  socket.on('agent:interrupt', () => {
    if (!currentSession || currentSession.mode !== 'agent') return;
    if (currentSession.isController(socket.id)) currentSession.lastInputTime = Date.now();
    currentSession.interrupt();
  });

  // -- create agent session --
  socket.on('create-agent', (opts, cb) => {
    if (!hasPermission(socket.data.role, 'operator')) {
      if (typeof cb === 'function') cb({ ok: false, error: '没有创建会话的权限' });
      return;
    }

    // 分屏新建任务且工作目录留空：按任务名建在「默认目录/任务名」下（见 taskCwdFromTitle）
    if (!opts?.cwd && opts?.nestByTitle) {
      opts = { ...opts, cwd: taskCwdFromTitle(opts?.title, socket.data.dir) };
    }

    if (socket.data.dir) {
      const base = resolve(normalize(socket.data.dir));
      const target = opts?.cwd ? resolve(normalize(opts.cwd)) : null;
      if (target && target !== base && !target.startsWith(base + sep)) {
        if (typeof cb === 'function') cb({ ok: false, error: '不能在绑定目录之外创建会话' });
        return;
      }
      if (!target) opts = { ...opts, cwd: base };
    }

    const cwd = opts?.cwd || process.env.MYHI_CWD || process.cwd();
    if (!existsSync(cwd)) {
      try {
        mkdirSync(cwd, { recursive: true });
        console.log(`[创建] 自动创建目录: ${cwd}`);
      } catch (err) {
        if (typeof cb === 'function') cb({ ok: false, error: `创建目录失败: ${err.message}` });
        return;
      }
    }

    try {
      const sess = manager.createAgent({
        ...opts,
        owner: socket.data.userName,
        userDir: socket.data.dir,
      });
      console.log(`[会话] ${socket.data.userName} 创建 Agent 会话 "${sess.title}" (${sess.id})`);
      broadcastSessions();
      if (typeof cb === 'function') cb({ ok: true, session: sess.toJSON() });
    } catch (err) {
      if (typeof cb === 'function') cb({ ok: false, error: err.message });
    }
  });

  // -- PTY input --
  socket.on('input', (data) => {
    if (data == null || !currentSession) return;
    if (currentSession.mode === 'agent') return;
    if (!currentSession.isController(socket.id)) {
      socket.emit('control-denied', { reason: '你没有当前会话的控制权' });
      return;
    }
    currentSession.lastInputTime = Date.now();
    currentSession.write(data);
  });

  // -- take-control --
  socket.on('take-control', ({ sessionId } = {}) => {
    const sess = sessionId ? manager.get(sessionId) : currentSession;
    if (!sess) return;

    if (!hasPermission(socket.data.role, 'operator')) {
      socket.emit('control-denied', { reason: '你的角色没有控制权限' });
      return;
    }

    if (sess.controlHolder && sess.controlHolder !== socket.id) {
      const sameUser = sess.controlHolderName === socket.data.userName;
      if (socket.data.role !== 'admin' && !sameUser) {
        socket.emit('control-denied', { reason: '其他用户正在控制中，请等待释放' });
        return;
      }
    }

    sess.takeControl(socket.id, socket.data.userName);
    console.log(`[控制] ${socket.data.userName} 获取会话 "${sess.title}" 的控制权`);
    io.emit('control-changed', {
      sessionId: sess.id,
      holder: socket.id,
      holderName: socket.data.userName,
    });
  });

  // -- release-control --
  socket.on('release-control', ({ sessionId } = {}) => {
    const sess = sessionId ? manager.get(sessionId) : currentSession;
    if (!sess || !sess.isController(socket.id)) return;
    console.log(`[控制] ${socket.data.userName} 释放会话 "${sess.title}" 的控制权`);
    sess.releaseControl();
    io.emit('control-changed', {
      sessionId: sess.id,
      holder: null,
      holderName: null,
    });
  });

  // -- set-mode (切换权限模式) --
  socket.on('set-mode', ({ sessionId, mode } = {}) => {
    const sess = sessionId ? manager.get(sessionId) : currentSession;
    if (!sess) return;
    if (sess.mode === 'agent' && sess.setPermissionMode) {
      // setPermissionMode 内部会归一化（未知/空/遗留 'bypass' → bypassPermissions），
      // 广播回前端的必须是归一化后的真实值，否则 UI 和实际进程模式会不一致。
      sess.setPermissionMode(mode);
      const applied = sess.permissionMode;
      if (applied !== mode) {
        console.log(`[模式] set-mode 收到无效模式 "${mode}"，已归一化为 ${applied}`);
      }
      console.log(`[模式] ${socket.data.userName} 切换会话 "${sess.title}" 为 ${applied}`);
      io.emit('mode-changed', { sessionId: sess.id, mode: applied });
    } else {
      sess.permissionMode = mode;
      io.emit('mode-changed', { sessionId: sess.id, mode });
    }
    manager.persist();
  });

  // -- rename --
  socket.on('rename', ({ sessionId, title } = {}) => {
    const sess = sessionId ? manager.get(sessionId) : currentSession;
    // 标题会进各端列表 / 用量面板 / sessions.json：只收字符串、去掉换行、限长
    title = typeof title === 'string' ? title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) : '';
    if (!sess || !title) return;
    sess.title = title;
    try { syncSessionTitle(sess.id, title); } catch {}  // 草稿里的任务名快照跟着改
    io.emit('session-renamed', { sessionId: sess.id, title });
    broadcastSessions();
    manager.persist();
  });

  // -- set-tags -- 会话标签（自由分类），持久化
  socket.on('set-tags', ({ sessionId, tags } = {}) => {
    const sess = sessionId ? manager.get(sessionId) : currentSession;
    if (!sess || !Array.isArray(tags)) return;
    // 归一化：去空白、去重、去空、限量与长度，防止脏数据
    sess.tags = [...new Set(
      tags.map((t) => String(t).trim()).filter(Boolean).map((t) => t.slice(0, 24)),
    )].slice(0, 12);
    io.emit('session-tagged', { sessionId: sess.id, tags: sess.tags });
    broadcastSessions();
    manager.persist();
  });

  // -- resize --
  socket.on('resize', (d) => {
    const cols = d?.cols | 0, rows = d?.rows | 0;   // node-pty 收到 0 / NaN 会直接抛错
    if (cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 && typeof currentSession?.resize === 'function') currentSession.resize(cols, rows);
  });

  // -- list --
  socket.on('list', () =>
    socket.emit('sessions', manager.list(socket.data.userName, socket.data.role === 'admin'))
  );

  // -- dirs (socket version) --
  socket.on('dirs', (path, cb) => {
    if (typeof cb !== 'function') return;

    const userBase = socket.data.dir ? resolve(normalize(socket.data.dir)) : null;
    const pathSep = process.platform === 'win32' ? '\\' : '/';

    let target = ((typeof path === 'string' && path) || userBase || process.env.MYHI_CWD || homedir())
      .replace(/[/\\]+$/, '') || homedir();
    if (process.platform === 'win32' && /^[A-Za-z]:$/.test(target)) {
      target += '\\';
    }

    const resolved = resolve(normalize(target));
    if (userBase && resolved !== userBase && !resolved.startsWith(userBase + pathSep)) {
      target = userBase;
    }

    try {
      const dirs = readdirSync(target, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => ({
          name: d.name,
          path: target.replace(/[/\\]+$/, '') + pathSep + d.name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = join(target, '..');
      const parentResolved = resolve(normalize(parent));
      const canGoUp = !userBase || parentResolved === userBase ||
        parentResolved.startsWith(userBase + pathSep);

      cb({ ok: true, current: target, parent: (canGoUp && parent !== target) ? parent : null, dirs });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // -- create PTY session --
  socket.on('create', (opts, cb) => {
    if (!hasPermission(socket.data.role, 'operator')) {
      if (typeof cb === 'function') cb({ ok: false, error: '没有创建会话的权限' });
      return;
    }

    // 分屏新建任务且工作目录留空：按任务名建在「默认目录/任务名」下（见 taskCwdFromTitle）
    if (!opts?.cwd && opts?.nestByTitle) {
      opts = { ...opts, cwd: taskCwdFromTitle(opts?.title, socket.data.dir) };
    }

    if (socket.data.dir) {
      const base = resolve(normalize(socket.data.dir));
      const target = opts?.cwd ? resolve(normalize(opts.cwd)) : null;
      if (target && target !== base && !target.startsWith(base + sep)) {
        if (typeof cb === 'function') cb({ ok: false, error: '不能在绑定目录之外创建会话' });
        return;
      }
      if (!target) opts = { ...opts, cwd: base };
    }

    const cwd = opts?.cwd || process.env.MYHI_CWD || process.cwd();
    if (!existsSync(cwd)) {
      try {
        mkdirSync(cwd, { recursive: true });
        console.log(`[创建] 自动创建目录: ${cwd}`);
      } catch (err) {
        if (typeof cb === 'function') cb({ ok: false, error: `创建目录失败: ${err.message}` });
        return;
      }
    }

    try {
      const sess = manager.create({
        ...opts,
        owner: socket.data.userName,
        userDir: socket.data.dir,
      });
      console.log(`[会话] ${socket.data.userName} 创建 PTY 会话 "${sess.title}" (${sess.id})`);
      broadcastSessions();
      if (typeof cb === 'function') cb({ ok: true, session: sess.toJSON() });
    } catch (err) {
      console.error('[创建] PTY 启动失败:', err.message);
      if (typeof cb === 'function') cb({ ok: false, error: err.message });
    }
  });

  // -- kill session --
  socket.on('kill', (sessionId) => {
    if (!hasPermission(socket.data.role, 'operator')) {
      socket.emit('error', { message: '没有删除会话的权限' });
      return;
    }
    console.log(`[会话] ${socket.data.userName} 删除会话 ${sessionId}`);
    manager.kill(sessionId);
    _autoSpawned.delete(sessionId);
    broadcastSessions();
  });

  // -- kick user --
  socket.on('kick-user', ({ socketId, sessionId } = {}, cb) => {
    if (!hasPermission(socket.data.role, 'admin')) {
      if (typeof cb === 'function') cb({ ok: false, error: '没有踢出用户的权限' });
      return;
    }
    const target = io.sockets.sockets.get(socketId);
    if (!target) {
      if (typeof cb === 'function') cb({ ok: false, error: '目标用户不在线' });
      return;
    }
    const name = target.data.userName || '未知';
    console.log(`[踢出] ${socket.data.userName} 踢出了用户 ${name} (${socketId})`);
    target.emit('kicked', { reason: `你已被管理员 ${socket.data.userName} 踢出` });
    target.disconnect(true);
    if (typeof cb === 'function') cb({ ok: true, name });
  });

  // -- list viewers --
  socket.on('list-viewers', ({ sessionId } = {}, cb) => {
    if (typeof cb !== 'function') return;
    const sess = sessionId ? manager.get(sessionId) : currentSession;
    if (!sess) {
      cb({ ok: false, error: '会话不存在' });
      return;
    }
    const viewers = [];
    for (const viewerId of sess._viewers) {
      const viewerSocket = io.sockets.sockets.get(viewerId);
      if (viewerSocket) {
        viewers.push({
          socketId: viewerId,
          userName: viewerSocket.data.userName || '未知',
          role: viewerSocket.data.role || 'viewer',
          isController: sess.controlHolder === viewerId,
        });
      }
    }
    cb({ ok: true, viewers });
  });
});

// ---------------------------------------------------------------------------
// Control timeout - auto release stale controllers
// ---------------------------------------------------------------------------

// 默认 5 分钟；可用 MYHI_CONTROL_TIMEOUT(秒) 覆盖——否则这段逻辑要等 5 分钟才能测一次。
const CONTROL_TIMEOUT = (Number(process.env.MYHI_CONTROL_TIMEOUT) || 300) * 1000;
const CONTROL_SWEEP = Math.min(60 * 1000, CONTROL_TIMEOUT);

// 空闲释放的目的只有一个：别让「掉线/挂机的人」把控制权攥着，挡住别人接管。
// 所以只在真有别人等着接管时才收，且正在干活的会话不收——否则单人会话会被
// 无意义地反复收权，用户侧表现为每 5 分钟一对「控制权已释放 / 你已获取控制权」。
function shouldReleaseIdle(sess) {
  if (!sess.controlHolder) return false;
  // 持有者已经掉线 —— 无条件收回，不然这会话永远锁死。
  if (!io.sockets.sockets.get(sess.controlHolder)) return true;
  // 持有者还在线：只有超时 + 有别的观众在等 + 会话不在跑，才收。
  if (!sess.lastInputTime || Date.now() - sess.lastInputTime <= CONTROL_TIMEOUT) return false;
  if (sess.isBusy) return false;
  // 只数「在线的其他观众」——_viewers 里可能还留着掉线没清的 id，
  // 拿它当「有人等着接管」会误判，又把单人会话拖回刷屏老路。
  for (const id of sess._viewers || []) {
    if (id !== sess.controlHolder && io.sockets.sockets.has(id)) return true;
  }
  return false;
}

setInterval(() => {
  for (const sess of manager.listSessions()) {
    if (shouldReleaseIdle(sess)) {
      sess.releaseControl();
      io.emit('control-changed', {
        sessionId: sess.id,
        holder: null,
        holderName: null,
      });
    }
    // Clean up disconnected viewers
    for (const viewerId of sess._viewers) {
      if (!io.sockets.sockets.has(viewerId)) {
        sess.removeViewer(viewerId);
      }
    }
  }
}, CONTROL_SWEEP);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function showStartupInfo() {
  const primary = httpsServer || httpServer;
  PORT = primary.address()?.port || PORT;
  const ip = getTailscaleIP();
  const proto = httpsServer ? 'https' : 'http';
  const primaryUrl = `${proto}://${ip}:${PORT}`;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  myhi — 基于 Tailscale 的 Web 终端');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n  地址:     ${primaryUrl}`);
  if (httpsServer) {
    console.log(`  HTTP重定向: http://${ip}:${PORT + 1} → HTTPS`);
  }
  console.log(`  密码:     ${PASSWORD}  (编辑 ~/.myhi/password 可修改)`);
  console.log('\n  扫描二维码在手机上打开:\n');

  QRCode.toString(primaryUrl, { type: 'terminal', small: false }, (err, str) => {
    if (str) {
      console.log(str.split('\n').map(line => '  ' + line).join('\n'));
    }
  });

  console.log('  提示: myhi help 查看所有命令');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  // npm 装 myhi 不会顺带装 Claude Code：启动时查一下，没装就把安装命令直接打出来
  getClaudeVersion().then((v) => {
    if (v) return;
    console.log('  ⚠ 未检测到 Claude Code（myhi 的 AI 引擎），AI 任务暂时用不了。安装：');
    console.log('      npm i -g @anthropic-ai/claude-code');
    console.log('    装好后运行一次 claude 登录（或在管理后台配置大模型网关）。也可在网页首页点「安装 AI 引擎」。\n');
  }).catch(() => {});
}

// 主服务器：HTTPS（TLS 可用时）或 HTTP（fallback）
const _primaryServer = httpsServer || httpServer;

function tryListen() {
  _primaryServer.listen(PORT, HOST);
  // 启动时就探测一次 claude 能力（交互通道 / 插话）：会话页一进来就知道能不能显示「⚡ 插话」
  setTimeout(() => { probeInteractive().catch(() => {}); }, 1500);
}

const MAX_PORT_RETRIES = 10;
let _portRetries = 0;

_primaryServer.on('listening', () => {
  PORT = _primaryServer.address().port;
  if (httpsServer) {
    // HTTP redirect 监听 PORT+1
    httpServer.listen(PORT + 1, HOST, () => showStartupInfo());
    httpServer.on('error', () => showStartupInfo()); // redirect 端口占用不致命
  } else {
    showStartupInfo();
  }
});

_primaryServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (_portRetries < MAX_PORT_RETRIES) {
      _portRetries++;
      PORT++;
      console.log(`[myhi] 端口 ${PORT - 1} 被占用，尝试 ${PORT}...`);
      _primaryServer.close();
      tryListen();
    } else {
      console.error(`[myhi] 连续 ${MAX_PORT_RETRIES} 个端口都被占用，启动失败`);
      process.exit(1);
    }
  } else {
    console.error(`[myhi] 启动失败: ${err.message}`);
    process.exit(1);
  }
});

tryListen();
