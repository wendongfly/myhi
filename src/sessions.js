import { EventEmitter } from 'events';
import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import * as pty from 'node-pty';
import { AgentSession } from './agent.js';

const DEFAULT_SHELL =
  process.platform === 'win32'
    ? process.env.SHELL || 'powershell.exe'
    : process.env.SHELL || '/bin/bash';

const CONFIG_DIR = join(homedir(), '.myhi');
const SESSIONS_FILE = join(CONFIG_DIR, 'sessions.json');

/** @type {string} */
export const savePath = SESSIONS_FILE;

/**
 * Load saved session configs from ~/.myhi/sessions.json.
 * 文件损坏（断电/强制关机撕裂写）时：留证 .corrupt-<时间戳> + 尝试从 .bak 自救，
 * 绝不无声返回空列表 —— 那会让下一次 _persist 把用户的全部会话配置永久抹掉。
 * @returns {Array<Object>}
 */
export function loadSavedConfigs() {
  let raw;
  try {
    raw = readFileSync(SESSIONS_FILE, 'utf8');
  } catch {
    return [];
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('内容不是数组');
    return arr;
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // 含毫秒，同秒多次损坏不互相覆盖
    try { copyFileSync(SESSIONS_FILE, SESSIONS_FILE + '.corrupt-' + stamp); } catch {}
    console.error(
      `[sessions] ⚠ sessions.json 损坏（断电撕裂写/被改坏），已留证 sessions.json.corrupt-${stamp}`,
    );
    try {
      const bak = JSON.parse(readFileSync(SESSIONS_FILE + '.bak', 'utf8'));
      if (Array.isArray(bak) && bak.length) {
        console.log(`[sessions] ✔ 已从 .bak 恢复 ${bak.length} 条会话配置`);
        return bak;
      }
    } catch { /* 无备份 */ }
    console.error('[sessions] ⚠ 无 .bak 可恢复，本次启动会话列表为空（磁盘证据已留档）');
    return [];
  }
}

/**
 * Atomically write session configs to ~/.myhi/sessions.json.
 * 每次成功覆盖前把旧文件轮换为 .bak —— 永远留有一份上一次的好数据可救。
 * @param {Array<Object>} configs
 */
export function writeSavedConfigs(configs) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    // 空列表护栏：内存一个会话都没有，磁盘上却有一批 —— 大概率是恢复失败后的
    // 空状态要冲掉好数据。照写（尊重用户真的全删光了的语义），但大声报警 + 留 .bak。
    try {
      const cur = readFileSync(SESSIONS_FILE, 'utf8').trim();
      if ((!configs || !configs.length) && cur && cur !== '[]') {
        console.error(
          `[sessions] ⚠ 即将用空列表覆盖 ${cur.length} 字节的存量会话数据（若非本人清空会话，立即停止 myhi 并找回 .bak）`,
        );
      }
    } catch { /* 文件不存在，正常 */ }
    try { copyFileSync(SESSIONS_FILE, SESSIONS_FILE + '.bak'); } catch {}
    const tmp = SESSIONS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(configs, null, 2), { mode: 0o600 });
    try {
      renameSync(tmp, SESSIONS_FILE);
    } catch {
      // rename 被占（杀软/同步盘锁文件）：退回直接写，别让持久化静默失败
      copyFileSync(tmp, SESSIONS_FILE);
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[sessions] 持久化写入失败:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Session (PTY wrapper)
// ---------------------------------------------------------------------------

class Session extends EventEmitter {
  constructor(id, opts = {}) {
    super();
    this.id = id;
    this.createdAt = opts.createdAt || new Date().toISOString();
    this.title = opts.title || DEFAULT_SHELL;
    this.cwd = opts.cwd || process.env.MYHI_CWD || process.cwd();
    this.tags = Array.isArray(opts.tags) ? opts.tags : [];
    this.initCmd = opts.initCmd || null;
    this.owner = opts.owner || null;
    this.cols = opts.cols || 120;
    this.rows = opts.rows || 30;
    this._lastActivityAt = opts.lastActivityAt || 0;

    this._viewers = new Set();
    this._viewerNames = new Map();
    this.controlHolder = null;
    this.controlHolderName = null;
    this.lastInputTime = null;

    // Build a clean env for the child shell
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;

    if (opts.userDir) {
      const gitconfig = join(opts.userDir, '.gitconfig');
      if (existsSync(gitconfig)) {
        env.GIT_CONFIG_GLOBAL = gitconfig;
      }
    }

    // Spawn the pseudo-terminal
    this._pty = pty.spawn(DEFAULT_SHELL, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
      useConpty: false,
    });

    // Scrollback buffer (max 100 KB)
    this._scrollback = '';
    const MAX_SCROLLBACK = 100 * 1024;

    this._pty.onData((data) => {
      this.emit('data', data);
      this._scrollback += data;
      if (this._scrollback.length > MAX_SCROLLBACK) {
        this._scrollback = this._scrollback.slice(
          this._scrollback.length - MAX_SCROLLBACK,
        );
      }
    });

    this._pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      this.emit('exit', exitCode);
    });

    // If an initial command was supplied, wait for a shell prompt then send it
    if (opts.initCmd) {
      const cmd = opts.initCmd;
      let sent = false;

      const onData = (data) => {
        if (!sent && /[$>#\]]\s*$/.test(data.trimEnd())) {
          sent = true;
          this._pty.off('data', onData);
          setTimeout(() => this._pty.write(cmd + '\r'), 120);
        }
      };

      this._pty.onData(onData);

      // Fallback: send after 3 s regardless
      setTimeout(() => {
        if (!sent) {
          sent = true;
          this._pty.write(cmd + '\r');
        }
      }, 3000);
    }
  }

  /* ---- I/O ---- */

  write(data) {
    if (data != null) {
      this._lastActivityAt = Date.now();
      this._pty.write(data);
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this._pty.resize(cols, rows);
  }

  kill() {
    try {
      this._pty.kill();
    } catch { /* ignore */ }
  }

  /* ---- Viewers ---- */

  addViewer(id, name) {
    this._viewers.add(id);
    if (name) this._viewerNames.set(id, name);
  }

  removeViewer(id) {
    this._viewers.delete(id);
    this._viewerNames.delete(id);
  }

  get viewerCount() {
    return new Set(this._viewerNames.values()).size || this._viewers.size;
  }

  /* ---- Control ---- */

  takeControl(id, name) {
    this.controlHolder = id;
    this.controlHolderName = name || null;
    this.lastInputTime = Date.now();
  }

  releaseControl() {
    this.controlHolder = null;
    this.controlHolderName = null;
    this.lastInputTime = null;
  }

  isController(id) {
    return this.controlHolder === id;
  }

  /* ---- Serialisation ---- */

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      tags: this.tags,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt || null,
      cols: this.cols,
      rows: this.rows,
      viewers: this.viewerCount,
      alive: this.exitCode === undefined,
      controlHolder: this.controlHolder,
      controlHolderName: this.controlHolderName,
      owner: this.owner,
    };
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  constructor() {
    this._sessions = new Map();
    this._agentSessions = new Map();

    // Restore previously persisted sessions
    const saved = loadSavedConfigs();
    let restoredCount = 0;
    for (const cfg of saved) {
      try {
        if (cfg.mode === 'agent') {
          // 无 claudeSessionId 也照常恢复（如「清除」后的会话：上下文已作废但任务本身还在）。
          // 此前这里直接跳过 → 点清除后重启，任务从列表里消失（用户实锤的"会话丢失"根因）。
          // 无链接的会话恢复后发消息，claude 会自动开新会话并回填 claudeSessionId。
          const id = this._restoreId(cfg.id);
          const agent = new AgentSession(id, {
            ...cfg,
            resumeSessionId: cfg.claudeSessionId,
          });
          agent.on('session-id', () => this._persist());
          agent.on('settings-changed', () => this._persist());
          this._agentSessions.set(id, agent);
          restoredCount++;
          console.log(
            cfg.claudeSessionId
              ? `[会话] 恢复 Agent "${cfg.title}" (claude: ${cfg.claudeSessionId.slice(0, 8)}...)`
              : `[会话] 恢复 Agent "${cfg.title}" (新上下文——此前已清除/未发起过查询)`,
          );
        } else {
          // PTY session
          this._spawn(this._restoreId(cfg.id), cfg, false);
          restoredCount++;
        }
      } catch (err) {
        console.warn(`[会话] 恢复 "${cfg.title}" 失败:`, err.message);
      }
    }
    if (saved.length && !restoredCount) {
      console.error(
        `[会话] ⚠ 磁盘上有 ${saved.length} 条会话配置但一条都没恢复成功 —— 检查上方日志；sessions.json.bak 里有一份好数据`,
      );
    }
  }

  /* ---- Internal helpers ---- */

  // 重启后沿用原来的会话 id：以前每次重启都换新 id，电脑工作台里嵌着的会话页、地址栏 ?s=、分屏、
  // 书签全部指向不存在的会话（升级后右侧出现「会话不存在」，点返回首页还把整个首页套进右侧）。
  // 老版本存的配置没有 id、或 id 重复时才新生成。
  _restoreId(id) {
    return typeof id === 'string' && /^[0-9a-f-]{8,64}$/i.test(id) && !this.get(id) ? id : randomUUID();
  }

  _spawn(id, opts, persist = true) {
    const session = new Session(id, opts);
    this._sessions.set(id, session);

    session.on('exit', () => {
      // Keep the record around for 5 minutes so clients can see the exit code
      setTimeout(() => this._sessions.delete(id), 300 * 1000);
    });

    if (persist) this._persist();
    return session;
  }

  /* ---- Public API ---- */

  create(opts = {}) {
    return this._spawn(randomUUID(), opts, true);
  }

  createAgent(opts = {}) {
    const id = randomUUID();
    const agent = new AgentSession(id, opts);
    this._agentSessions.set(id, agent);

    agent.on('session-id', () => this._persist());
    agent.on('settings-changed', () => this._persist());
    this._persist();
    return agent;
  }

  get(id) {
    return this._sessions.get(id) || this._agentSessions.get(id);
  }

  list(owner, includeAll = false) {
    let ptySessions = [...this._sessions.values()].map((s) => ({
      ...s.toJSON(),
      mode: 'pty',
    }));

    let agentSessions = [...this._agentSessions.values()].map((s) =>
      s.toJSON(),
    );

    if (owner && !includeAll) {
      ptySessions = ptySessions.filter((s) => !s.owner || s.owner === owner);
      agentSessions = agentSessions.filter(
        (s) => !s.owner || s.owner === owner,
      );
    }

    return [...ptySessions, ...agentSessions];
  }

  listSessions() {
    return [...this._sessions.values(), ...this._agentSessions.values()];
  }

  kill(id) {
    const ptySession = this._sessions.get(id);
    if (ptySession) {
      ptySession.kill();
      this._sessions.delete(id);
      this._persist();
      return;
    }

    const agentSession = this._agentSessions.get(id);
    if (agentSession) {
      agentSession.kill();
      this._agentSessions.delete(id);
      this._persist();
    }
  }

  persist() {
    this._persist();
  }

  _persist() {
    const ptyCfgs = [...this._sessions.values()]
      .filter((s) => s.exitCode === undefined)
      .map((s) => ({
        id: s.id,
        mode: 'pty',
        title: s.title,
        cwd: s.cwd,
        tags: s.tags?.length ? s.tags : undefined,
        createdAt: s.createdAt || undefined,
        lastActivityAt: s._lastActivityAt || undefined,
        initCmd: s.initCmd || undefined,
        owner: s.owner || undefined,
      }));

    const agentCfgs = [...this._agentSessions.values()]
      .filter((s) => s.alive)
      .map((s) => ({
        id: s.id,
        mode: 'agent',
        title: s.title,
        firstUserText: s.firstUserText || undefined,
        cwd: s.cwd,
        tags: s.tags?.length ? s.tags : undefined,
        createdAt: s.createdAt || undefined,
        lastActivityAt: s._lastActivityAt || undefined,
        owner: s.owner || undefined,
        userDir: s.userDir || undefined,
        claudeSessionId: s.claudeSessionId || undefined,
        modelId: s.modelId || undefined,
      }));

    writeSavedConfigs([...ptyCfgs, ...agentCfgs]);
  }
}
