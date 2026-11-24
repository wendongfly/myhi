// ---------------------------------------------------------------------------
// 技能：Claude Code 的两种可复用指令
//   · 斜杠命令（command）：.claude/commands/<名>.md，用户点按钮 / 输入 /名 触发，$ARGUMENTS 换成补充内容；
//   · Agent 技能（skill）：.claude/skills/<名>/SKILL.md（+ 辅助文件），开头 YAML 写 name / description，
//     AI 遇到合适场景自己调用。
// 都分「项目级」（<cwd>/.claude/…）和「本机级」（~/.claude/…）。另有随 myhi 打包的内置命令（只读）。
//
// 分享：一个技能打成「技能包」{ myhiSkill, kind, name, desc, files[{path, content}] }，可以
//   · 下载成 .myhiskill 文件 / 复制成分享码（MYHI-SKILL: + gzip + base64url），另一台 myhi 导入；
//   · 生成限时分享链接（/s/skill/<令牌>，同一局域网 / Tailscale 里的 myhi 直接拉）；
//   · 发布到团队 Git 仓库（commands/、skills/ 目录），其他 myhi 订阅后检查更新。
// 导入一律先预览 + 安全扫描（myhi 的 AI 是免授权跑的，导入的技能等于别人写好的指令直接执行）。
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync, rmSync, mkdtempSync, chmodSync } from 'fs';
import { join, dirname, relative, sep, resolve, isAbsolute } from 'path';
import { homedir, tmpdir } from 'os';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';

const MAX_FILES = 30;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
export const NAME_RE = /^[\w.-]+(:[\w.-]+)*$/;   // 手动技能（命令）：可用 a:b 表示子目录
// 自动技能（Agent 技能）按 Claude 规范：小写字母 / 数字 / 连字符，≤64 字，不能含保留词。不合规 Claude 可能不认
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = /anthropic|claude/;
export function skillNameError(name) {
  if (!SKILL_NAME_RE.test(name || '')) return '自动技能的名字只能用小写字母、数字和连字符（如 weekly-report）';
  if (name.length > 64) return '自动技能的名字不能超过 64 个字符';
  if (RESERVED.test(name)) return '自动技能的名字不能包含 anthropic / claude';
  return '';
}
/** 把任意名字改成合规的自动技能名：PDF_Report → pdf-report */
export function slugSkillName(name) {
  let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/anthropic|claude/g, 'ai').slice(0, 64).replace(/-+$/, '');
  return s || 'my-skill';
}
// SKILL.md 开头的 name: 跟目录名保持一致
function syncFrontmatterName(content, name) {
  const m = String(content).match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return `---\nname: ${name}\ndescription: \n---\n\n` + content;
  const body = /^name:.*$/m.test(m[2]) ? m[2].replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}\n` + m[2];
  return m[1] + body + m[3] + String(content).slice(m[0].length);
}

export function skillDirs(cwd) {
  const home = join(homedir(), '.claude');
  return {
    project: { command: join(cwd, '.claude', 'commands'), skill: join(cwd, '.claude', 'skills') },
    user: { command: join(home, 'commands'), skill: join(home, 'skills') },
  };
}

// 解析 SKILL.md 开头的 YAML（只取 name / description 两个简单键）
export function parseFrontmatter(text) {
  const m = String(text || '').match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const firstLineDesc = (text) => (String(text || '').split('\n').find((l) => l.trim() && !/^---/.test(l)) || '').replace(/^#+\s*/, '').trim();

function commandFile(baseDir, name) {
  const parts = name.split(':');
  // NAME_RE 允许 . → 「..:..:x」会拼出目录外的路径（可经分享链接读走任意 .md）
  if (parts.some((p) => p === '.' || p === '..')) throw new Error('技能名称不对');
  return join(baseDir, ...parts.slice(0, -1), parts[parts.length - 1] + '.md');
}
// 路径必须落在 base 里面（防 ../ 逃逸）
function inside(base, p) {
  const r = relative(resolve(base), resolve(p));
  return !!r && !r.startsWith('..') && !isAbsolute(r);
}

function walkFiles(dir, base = dir, out = []) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.name.startsWith('.') && f.name !== '.env.example') continue;
    if (f.isSymbolicLink()) continue;
    const p = join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'node_modules' && f.name !== '__pycache__') walkFiles(p, base, out); }
    else out.push(relative(base, p).split(sep).join('/'));
    if (out.length > MAX_FILES * 2) break;
  }
  return out;
}

/** 列出技能。detail=true 时带内容（命令是全文，Agent 技能是 SKILL.md） */
export function listSkills(cwd, builtinDir, detail = false) {
  const dirs = skillDirs(cwd);
  const skills = [];
  const scanCommands = (dir, source, prefix = '') => {
    if (!existsSync(dir)) return;
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) { scanCommands(join(dir, f.name), source, prefix ? `${prefix}:${f.name}` : f.name); continue; }
        if (!f.name.endsWith('.md')) continue;
        const name = (prefix ? prefix + ':' : '') + f.name.replace(/\.md$/, '');
        try {
          const content = readFileSync(join(dir, f.name), 'utf8');
          const e = { name, desc: firstLineDesc(content).slice(0, 80), source, kind: 'command' };
          if (detail) e.content = content;
          skills.push(e);
        } catch {}
      }
    } catch {}
  };
  const scanSkills = (dir, source) => {
    if (!existsSync(dir)) return;
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (!f.isDirectory()) continue;
        const md = join(dir, f.name, 'SKILL.md');
        if (!existsSync(md)) continue;
        try {
          const content = readFileSync(md, 'utf8');
          const fm = parseFrontmatter(content);
          const e = { name: f.name, desc: (fm.description || firstLineDesc(content.replace(/^---[\s\S]*?---/, ''))).slice(0, 120), source, kind: 'skill' };
          try { e.fileCount = walkFiles(join(dir, f.name)).length; } catch {}
          if (detail) e.content = content;
          skills.push(e);
        } catch {}
      }
    } catch {}
  };
  scanCommands(dirs.project.command, 'project');
  scanSkills(dirs.project.skill, 'project');
  scanCommands(dirs.user.command, 'user');
  scanSkills(dirs.user.skill, 'user');
  if (builtinDir) scanCommands(builtinDir, 'builtin');
  return { skills, dirs };
}

function baseFor(cwd, source, kind) {
  const d = skillDirs(cwd)[source === 'project' ? 'project' : 'user'];
  return kind === 'skill' ? d.skill : d.command;
}

/** 读一个技能的全部文件 → 技能包 */
export function packSkill(cwd, { name, source, kind }, builtinDir) {
  if (!NAME_RE.test(name || '')) throw new Error('技能名称不对');
  if (kind === 'skill') {
    if (name.includes(':')) throw new Error('技能名称不对');
    const dir = join(baseFor(cwd, source, 'skill'), name);
    if (!existsSync(join(dir, 'SKILL.md'))) throw new Error('技能不存在');
    const files = [];
    let total = 0;
    for (const rel of walkFiles(dir)) {
      const p = join(dir, rel);
      const st = statSync(p);
      if (st.size > MAX_FILE_BYTES) throw new Error(`文件 ${rel} 超过 200KB，技能包里不适合放大文件`);
      total += st.size;
      if (total > MAX_TOTAL_BYTES || files.length >= MAX_FILES) throw new Error('技能文件太多或太大（上限 30 个文件 / 1MB）');
      const buf = readFileSync(p);
      if (buf.includes(0)) throw new Error(`文件 ${rel} 是二进制文件，技能包只支持文本文件`);
      files.push({ path: rel, content: buf.toString('utf8') });
    }
    const fm = parseFrontmatter(files.find((f) => f.path === 'SKILL.md')?.content);
    return { myhiSkill: 1, kind: 'skill', name, desc: fm.description || '', files };
  }
  const dir = source === 'builtin' ? builtinDir : baseFor(cwd, source, 'command');
  const fp = commandFile(dir, name);
  if (!existsSync(fp)) throw new Error('技能不存在');
  const content = readFileSync(fp, 'utf8');
  return { myhiSkill: 1, kind: 'command', name, desc: firstLineDesc(content).slice(0, 80), files: [{ path: name.split(':').pop() + '.md', content }] };
}

/** 校验 / 规整一个外来的技能包（来自分享码、文件、链接、仓库） */
export function normalizePack(pkg) {
  if (!pkg || typeof pkg !== 'object' || !pkg.myhiSkill) throw new Error('不是 myhi 技能包');
  const kind = pkg.kind === 'skill' ? 'skill' : 'command';
  let name = String(pkg.name || '').trim(), renamedFrom;
  // 自动技能名字不合规：按规范自动改（PDF_Report → pdf-report），预览里告诉用户
  if (kind === 'skill' && skillNameError(name)) { renamedFrom = name; name = slugSkillName(name); }
  if (!NAME_RE.test(name)) throw new Error('技能名称不对：只能用字母、数字、- _ .');
  if (!Array.isArray(pkg.files) || !pkg.files.length) throw new Error('技能包里没有文件');
  if (pkg.files.length > MAX_FILES) throw new Error('技能包文件太多（上限 30 个）');
  let total = 0;
  const files = pkg.files.map((f) => {
    const path = String(f?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path || path.split('/').some((s) => s === '..' || s === '') || /^[A-Za-z]:/.test(path)) throw new Error('技能包里有不安全的文件路径：' + path);
    const content = String(f?.content ?? '');
    total += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('技能包太大（单文件 200KB / 总共 1MB）');
    return { path, content };
  });
  if (kind === 'skill' && !files.some((f) => f.path === 'SKILL.md')) throw new Error('Agent 技能缺少 SKILL.md');
  if (kind === 'skill') {
    const md = files.find((f) => f.path === 'SKILL.md');
    if (parseFrontmatter(md.content).name !== name) md.content = syncFrontmatterName(md.content, name);
  }
  if (kind === 'command' && files.length !== 1) throw new Error('斜杠命令技能应只有一个 .md 文件');
  const desc = kind === 'skill' ? (parseFrontmatter(files.find((f) => f.path === 'SKILL.md').content).description || pkg.desc || '') : firstLineDesc(files[0].content);
  return {
    myhiSkill: 1, kind, name, desc: String(desc).slice(0, 200), files,
    from: pkg.from ? String(pkg.from).slice(0, 60) : undefined,
    renamedFrom,
    exportedAt: pkg.exportedAt || undefined,
  };
}

/** 安装技能包（覆盖同名）。返回安装位置 */
export function installPack(cwd, pkg, scope) {
  pkg = normalizePack(pkg);
  const base = baseFor(cwd, scope, pkg.kind);
  if (pkg.kind === 'command') {
    const fp = commandFile(base, pkg.name);
    if (!inside(base, fp)) throw new Error('路径不对');
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, pkg.files[0].content, 'utf8');
    return fp;
  }
  const dir = join(base, pkg.name);
  if (!inside(base, dir)) throw new Error('路径不对');
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });   // 覆盖：旧版本里多出来的文件别留着
  for (const f of pkg.files) {
    const p = join(dir, ...f.path.split('/'));
    if (!inside(dir, p)) throw new Error('路径不对：' + f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content, 'utf8');
    if (/\.(sh|py|bash)$/.test(f.path)) { try { chmodSync(p, 0o755); } catch {} }
  }
  return dir;
}

export function skillExists(cwd, { name, kind }, scope) {
  const base = baseFor(cwd, scope, kind);
  return kind === 'skill' ? existsSync(join(base, name, 'SKILL.md')) : existsSync(commandFile(base, name));
}

export function deleteSkill(cwd, { name, source, kind }) {
  if (!NAME_RE.test(name || '')) throw new Error('技能名称不对');
  const base = baseFor(cwd, source, kind);
  const p = kind === 'skill' ? join(base, name) : commandFile(base, name);
  if (!inside(base, p)) throw new Error('路径不对');
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

/** 写一个技能（编辑器保存）：命令写 .md；Agent 技能只写 SKILL.md，目录里其他文件保留 */
export function saveSkill(cwd, { name, content, scope, kind }) {
  if (kind === 'skill') { const err = skillNameError(name); if (err) throw new Error(`${err}，比如「${slugSkillName(name)}」`); }
  else if (!NAME_RE.test(name || '')) throw new Error('名称只能包含字母、数字、-、_、.、:');
  if (kind === 'skill') content = syncFrontmatterName(content, name);
  const base = baseFor(cwd, scope, kind);
  const fp = kind === 'skill' ? join(base, name, 'SKILL.md') : commandFile(base, name);
  if (!inside(base, fp)) throw new Error('路径不对');
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, content, 'utf8');
  return fp;
}

// ── 分享码：MYHI-SKILL: + base64url(gzip(JSON)) ──
const CODE_PREFIX = 'MYHI-SKILL:';
export function encodeShareCode(pkg) {
  return CODE_PREFIX + gzipSync(Buffer.from(JSON.stringify(pkg), 'utf8')).toString('base64url');
}
export function decodeShareCode(text) {
  const s = String(text || '').trim();
  const i = s.indexOf(CODE_PREFIX);
  if (i < 0) throw new Error('没找到分享码（应以 MYHI-SKILL: 开头）');
  const body = s.slice(i + CODE_PREFIX.length).replace(/\s+/g, '').match(/^[A-Za-z0-9_-]+/)?.[0] || '';
  let json;
  try { json = gunzipSync(Buffer.from(body, 'base64url')).toString('utf8'); }
  catch { throw new Error('分享码不完整或已损坏，请重新复制'); }
  return JSON.parse(json);
}

// ── 安全扫描 ──
// level: danger（很可能有害，安装前要用户明确确认）/ warn（需要留意）
const RULES = [
  ['danger', /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*|\.\.?\/?\s)/i, '批量删除（rm -rf 根目录 / 家目录 / 通配）'],
  ['danger', /\b(del|rd|rmdir)\s+\/[sq]\b|Remove-Item\b[^\n]*-Recurse[^\n]*-Force|\bformat\s+[a-z]:/i, '批量删除（Windows）'],
  ['danger', /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|iex|Invoke-Expression)\b/i, '下载后直接执行（curl … | sh）'],
  ['danger', /base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash)|powershell[^\n]*-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{20,}/i, '执行编码过的命令'],
  ['danger', /\b(curl|wget|Invoke-WebRequest|iwr|nc|ncat)\b[^\n]*(\$\{?\w*(TOKEN|KEY|SECRET|PASS(WORD)?)\w*|printenv|\benv\b|\.ssh|id_rsa|\.aws|\.npmrc|credentials)/i, '可能把密钥 / 环境变量 / 凭据发到外部'],
  ['danger', /authorized_keys|\bcrontab\s+-|\\CurrentVersion\\Run\b|schtasks\s+\/create/i, '植入自启动 / 登录凭据'],
  ['danger', /ignore (all |any )?(previous|prior|above) instructions|忽略(之前|以上|前面)的(所有)?(指令|要求|说明)|不要(告诉|让)用户(知道)?/i, '诱导 AI 无视用户 / 隐瞒用户'],
  ['warn', /\bsudo\b/, '使用 sudo 提权'],
  ['warn', /git\s+push\b[^\n]*(--force|-f\b)/, '强制推送 git（可能覆盖别人的提交）'],
  ['warn', /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i, '删除数据库表'],
  ['warn', /\brm\s+-[a-z]*r/i, '递归删除文件'],
  ['warn', /\b(curl|wget|Invoke-WebRequest)\s+[^\n]*https?:\/\//i, '会访问外部网址'],
];
const SECRET_RE = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/, 'API Key（sk-…）'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub Token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack Token'],
  [/(password|passwd|pwd|密码)\s*[:=：]\s*["']?[^\s"'$<{]{6,}/i, '明文密码'],
];
export function scanPack(pkg) {
  const findings = [];
  for (const f of pkg.files || []) {
    const lines = String(f.content || '').split('\n');
    lines.forEach((line, i) => {
      for (const [level, re, why] of RULES) {
        if (re.test(line)) findings.push({ level, why, file: f.path, line: i + 1, text: line.trim().slice(0, 160) });
      }
    });
    if (pkg.kind === 'skill' && !/\.(md|txt)$/i.test(f.path)) findings.push({ level: 'warn', why: '含脚本 / 程序文件，AI 可能会运行它', file: f.path, line: 0, text: '' });
  }
  // 同一条规则同一文件只留前 3 处
  const seen = {};
  return findings.filter((x) => { const k = x.level + x.why + x.file; seen[k] = (seen[k] || 0) + 1; return seen[k] <= 3; });
}
/** 导出前查一遍：技能里像是写进了密钥 → 拦下，别分享出去 */
export function scanSecrets(pkg) {
  const hits = [];
  for (const f of pkg.files || []) {
    String(f.content || '').split('\n').forEach((line, i) => {
      for (const [re, what] of SECRET_RE) if (re.test(line)) hits.push({ what, file: f.path, line: i + 1 });
    });
  }
  return hits;
}

export const packHash = (pkg) => createHash('sha256').update(JSON.stringify((pkg.files || []).map((f) => [f.path, f.content]))).digest('hex').slice(0, 16);

// ── 分享链接（内存 + 磁盘，默认 24 小时）──
export function createShareStore(file) {
  let shares = {};
  try { shares = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch {}
  const save = () => { try { writeFileSync(file, JSON.stringify(shares), { mode: 0o600 }); } catch {} };
  const prune = () => { const now = Date.now(); for (const [k, v] of Object.entries(shares)) if (v.expires < now) delete shares[k]; };
  return {
    create(pkg, ttlMs = 24 * 3600 * 1000) {
      prune();
      const token = randomBytes(12).toString('base64url');
      shares[token] = { pkg, expires: Date.now() + ttlMs };
      save();
      return { token, expires: shares[token].expires };
    },
    get(token) { prune(); return shares[token]?.pkg || null; },
  };
}

// ── 团队仓库（Git）──
// 仓库布局：commands/<名>.md（斜杠命令）、skills/<名>/SKILL.md（Agent 技能）；也认 .claude/commands、.claude/skills。
function authUrl(url, username, password) {
  if (!(username && password && /^https?:\/\//.test(url))) return url;
  try { const u = new URL(url); u.username = encodeURIComponent(username); u.password = encodeURIComponent(password); return u.toString(); } catch { return url; }
}
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' });
function git(args, cwd, timeout = 60000) {
  return execFileSync('git', args, { cwd, timeout, stdio: 'pipe', encoding: 'utf8', env: gitEnv() });
}
const gitErr = (e) => {
  const msg = String(e.stderr || e.stdout || e.message || '').replace(/https?:\/\/[^@\s]+@/g, 'https://***@');   // 别把凭据回显给页面
  return msg.split('\n').filter((l) => l.trim()).slice(-3).join(' ').slice(0, 240);
};

export function cloneRepo({ url, username, password, branch }) {
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url || '')) throw new Error('仓库地址应以 https:// 或 git@ 开头');
  const dir = mkdtempSync(join(tmpdir(), 'myhi-skills-'));
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(authUrl(url, username, password), dir);
  try { git(args, undefined, 90000); }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw new Error('克隆失败：' + gitErr(e)); }
  return dir;
}

/** 扫一个本地仓库目录里的技能 → 技能包数组 */
export function scanRepoDir(root) {
  const packs = [];
  // 目录本身也可能是指向仓库外的软链接：按真实路径必须仍在仓库里
  const realRoot = realpathSync(root);
  const inRepo = (p) => { try { const r = realpathSync(p); return r === realRoot || r.startsWith(realRoot + sep); } catch { return false; } };
  const cmdDirs = [join(root, 'commands'), join(root, '.claude', 'commands')].filter((p) => existsSync(p) && inRepo(p));
  const skDirs = [join(root, 'skills'), join(root, '.claude', 'skills')].filter((p) => existsSync(p) && inRepo(p));
  const addCommands = (dir, prefix = '') => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.name.startsWith('.') || f.isSymbolicLink()) continue;
      if (f.isDirectory()) { addCommands(join(dir, f.name), prefix ? `${prefix}:${f.name}` : f.name); continue; }
      if (!f.name.endsWith('.md') || /^(README|CHANGELOG|LICENSE|CONTRIBUTING)\.md$/i.test(f.name)) continue;
      const name = (prefix ? prefix + ':' : '') + f.name.replace(/\.md$/, '');
      try {
        const content = readFileSync(join(dir, f.name), 'utf8');
        if (Buffer.byteLength(content) <= MAX_FILE_BYTES) packs.push(normalizePack({ myhiSkill: 1, kind: 'command', name, files: [{ path: f.name, content }] }));
      } catch {}
    }
  };
  for (const d of cmdDirs) addCommands(d);
  for (const d of skDirs) {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (!f.isDirectory() || !existsSync(join(d, f.name, 'SKILL.md'))) continue;
      try {
        const files = walkFiles(join(d, f.name)).slice(0, MAX_FILES).map((rel) => ({ path: rel, content: readFileSync(join(d, f.name, rel), 'utf8') }));
        packs.push(normalizePack({ myhiSkill: 1, kind: 'skill', name: f.name, files }));
      } catch {}
    }
  }
  // 两个专用目录都没有：退回扫根目录的 .md（兼容老的「命令合集」仓库）
  if (!cmdDirs.length && !skDirs.length) addCommands(root);
  return packs;
}

export function withRepo(opts, fn) {
  const dir = cloneRepo(opts);
  try { return fn(dir); } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

/** 发布一个技能包到团队仓库：写进 commands/ 或 skills/ → commit → push */
export function publishToRepo(opts, pkg, author) {
  pkg = normalizePack(pkg);
  return withRepo(opts, (dir) => {
    const base = join(dir, pkg.kind === 'skill' ? 'skills' : 'commands');
    if (pkg.kind === 'skill') {
      const sd = join(base, pkg.name);
      if (existsSync(sd)) rmSync(sd, { recursive: true, force: true });
      for (const f of pkg.files) { const p = join(sd, ...f.path.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content, 'utf8'); }
    } else {
      const p = commandFile(base, pkg.name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, pkg.files[0].content, 'utf8');
    }
    git(['add', '-A'], dir);
    const status = git(['status', '--porcelain'], dir).trim();
    if (!status) return { ok: true, unchanged: true };
    const who = String(author || 'myhi').replace(/[<>\n]/g, '').slice(0, 40) || 'myhi';
    git(['-c', `user.name=${who}`, '-c', 'user.email=myhi@localhost', 'commit', '-m', `myhi: 发布技能 ${pkg.name}`], dir);
    try { git(['push'], dir, 90000); }
    catch (e) { throw new Error('推送失败（检查账号 / Token 是否有写权限）：' + gitErr(e)); }
    return { ok: true };
  });
}

// ── 订阅 ──
// ~/.myhi/skill-subs.json：[{ id, url, username, password, branch, scope, cwd, installed: { 'kind:name': hash }, lastCheck, updates }]
// 凭据只存本机（0600），返回给页面时去掉密码。
export function createSubStore(file) {
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')) || []; } catch { return []; } };
  const save = (l) => { try { writeFileSync(file, JSON.stringify(l, null, 2), { mode: 0o600 }); } catch {} };
  const pub = (s) => ({ id: s.id, url: s.url, username: s.username || '', hasPassword: !!s.password, branch: s.branch || '', scope: s.scope, cwd: s.cwd || '', installed: s.installed || {}, lastCheck: s.lastCheck || 0, updates: s.updates || [] });
  return {
    list: () => load().map(pub),
    raw: (id) => load().find((s) => s.id === id) || null,
    upsert(sub) {
      const l = load();
      let s = l.find((x) => x.url === sub.url && x.scope === sub.scope && (x.cwd || '') === (sub.cwd || ''));
      if (!s) { s = { id: randomBytes(6).toString('hex'), installed: {} }; l.push(s); }
      Object.assign(s, { url: sub.url, branch: sub.branch || '', scope: sub.scope, cwd: sub.cwd || '' });
      if (sub.username !== undefined) s.username = sub.username;
      if (sub.password) s.password = sub.password;
      if (sub.installed) s.installed = { ...s.installed, ...sub.installed };
      if (sub.updates) s.updates = sub.updates;
      if (sub.lastCheck) s.lastCheck = sub.lastCheck;
      save(l);
      return pub(s);
    },
    remove(id) { save(load().filter((s) => s.id !== id)); },
  };
}
