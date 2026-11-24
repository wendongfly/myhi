// ---------------------------------------------------------------------------
// 任务迁移：把一个任务（项目文件 + 可选 AI 对话）打成 .myhipack，带到另一台 myhi 导入。
//   场景：公司 myhi → 家里 myhi，两边网络不通、也不一定有 GitLab —— 下载一个文件，
//   用微信 / U 盘 / 网盘带过去，在新机器「新建任务 › 从迁移包导入」。
//
//   包格式：tar + gzip（自己实现读写，不引第三方依赖、Windows/Linux/macOS 一致）。
//   每个条目前带 pax 扩展头存 UTF-8 路径（中文文件名、长路径都不丢）。
//     myhi-pack.json          清单（第一个条目，预览时只读到这里就停）
//     files/<相对路径>         项目文件（不含 .git、node_modules 等可重新生成的目录）
//     claude/<sid>.jsonl       AI 对话记录（claude transcript）
//     claude/<sid>/…           子代理等附属记录
//     claude/memory/…          项目记忆
//     myhi/pseudo-map.json     隐私护栏映射表（占位符 ↔ 真名，没有它对话里的假名还原不回来）
//     myhi/guard.json          隐私护栏配置（开关 / 档位 / 主体词典）
//   密钥不进包：清单里只列名字，到新机器重新录入。
//
//   导入时对话记录里的旧项目路径整体改写成新路径、放进新路径对应的 claude 项目目录，
//   这样 `claude --resume` 在新机器上能接着聊。
// ---------------------------------------------------------------------------

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'path';
import { homedir } from 'os';
import { createGzip, createGunzip } from 'zlib';
import { once } from 'events';
import { randomUUID } from 'crypto';
import { findTranscriptPath } from './transcript.js';
import { listSecrets } from './secrets.js';
import { loadMap, saveMap, getGuardBag, importGuardBag } from './pseudo.js';

export const PACK_EXT = '.myhipack';
// 可重新生成 / 体积大 / 与机器绑定的目录，默认不打包（导出面板里列出实际跳过了哪些）
export const EXCLUDE_DIRS = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt',
  'target', '.gradle', '.cache', 'coverage', '.pytest_cache', '.mypy_cache', '.tox', 'upload'];
const EXCLUDE = new Set(EXCLUDE_DIRS);
const MAX_FILES = 200000;

const claudeProjectsDir = () => join(homedir(), '.claude', 'projects');
// claude CLI 把 cwd 编码成 ~/.claude/projects 下的目录名：非字母数字一律换成 -
export const encodeCwd = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

// ── 扫描项目文件 ──────────────────────────────────────────────────────────
export function scanProject(cwd) {
  const files = []; const skipped = new Set(); let bytes = 0;
  const walk = (dir, depth) => {
    if (depth > 40 || files.length > MAX_FILES) return;
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;              // 软链接不跟：可能指到项目外
      if (e.isDirectory()) {
        if (EXCLUDE.has(e.name)) { skipped.add(e.name); continue; }
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        let st; try { st = lstatSync(abs); } catch { continue; }
        files.push({ rel: relative(cwd, abs).split(sep).join('/'), abs, size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o777 });
        bytes += st.size;
      }
    }
  };
  if (existsSync(cwd)) walk(cwd, 0);
  return { files, bytes, skipped: [...skipped].sort(), truncated: files.length > MAX_FILES };
}

function scanDir(root) {
  const out = [];
  const walk = (dir) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) { const st = lstatSync(abs); out.push({ rel: relative(root, abs).split(sep).join('/'), abs, size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o777 }); }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// 项目记忆目录：~/.claude/projects/<编码后的项目路径>/memory。按项目路径直接找（同一项目下别的任务攒的记忆也算），
// 找不到再看本任务对话记录所在目录（路径编码规则万一和 claude 不一致时兜底）
function memoryDirOf(sess) {
  const byCwd = join(claudeProjectsDir(), encodeCwd(sess.cwd), 'memory');
  if (existsSync(byCwd)) return byCwd;
  const tp = sess.claudeSessionId ? findTranscriptPath(sess.claudeSessionId) : null;
  const byConv = tp ? join(dirname(tp), 'memory') : null;
  return byConv && existsSync(byConv) ? byConv : null;
}

// ── 导出预览：给导出面板展示「会带走什么」 ───────────────────────────────
export function exportPreview(sess) {
  const proj = scanProject(sess.cwd);
  const tp = sess.claudeSessionId ? findTranscriptPath(sess.claudeSessionId) : null;
  let convBytes = 0;
  if (tp) { try { convBytes = lstatSync(tp).size; } catch {} }
  const guard = getGuardBag(sess.cwd);
  return {
    title: sess.title, cwd: sess.cwd,
    files: proj.files.length, bytes: proj.bytes, skipped: proj.skipped, truncated: proj.truncated,
    hasConv: !!tp, convBytes, busy: !!sess.isBusy,
    memFiles: (() => { const d = memoryDirOf(sess); return d ? scanDir(d).length : 0; })(),
    secrets: listSecrets('project', sess.cwd).map((s) => s.name),
    guard: guard ? { enabled: !!guard.enabled, entities: (guard.entities || []).length } : null,
  };
}

// ── tar 写 ────────────────────────────────────────────────────────────────
function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }
function tarHeader(name, size, mtime, mode, type) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 99), 0, 'utf8');
  h.write(octal(mode, 8), 100); h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124); h.write(octal(Math.floor(mtime / 1000), 12), 136);
  h.write('        ', 148); h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(octal(sum, 7) + ' ', 148);
  return h;
}
function paxRecord(key, val) {
  const body = ` ${key}=${val}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(len + body, 'utf8');
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);

async function put(out, buf) { if (!out.write(buf)) await once(out, 'drain'); }
async function putEntry(out, name, { size, mtime = Date.now(), mode = 0o644, data, file }) {
  const pax = paxRecord('path', name);
  await put(out, tarHeader('PaxHeader', pax.length, mtime, 0o644, 'x'));
  await put(out, Buffer.concat([pax, pad(pax.length)]));
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  await put(out, tarHeader(ascii, size, mtime, mode, '0'));
  if (data) await put(out, data);
  else {
    let n = 0;
    for await (const chunk of createReadStream(file)) {
      const c = n + chunk.length > size ? chunk.subarray(0, size - n) : chunk;   // 打包途中文件变大：按扫描时大小截断，保证 tar 结构不乱
      n += c.length; await put(out, c);
      if (n >= size) break;
    }
    if (n < size) await put(out, Buffer.alloc(size - n));                          // 途中变小：补零
  }
  await put(out, pad(size));
}

/** 导出：把任务打包写进 out（HTTP 响应） */
export async function exportTask(sess, { conv = true, mem = true, from = '' } = {}, out) {
  const proj = scanProject(sess.cwd);
  const tp = conv && sess.claudeSessionId ? findTranscriptPath(sess.claudeSessionId) : null;
  const projDir = tp ? dirname(tp) : null;
  const sid = sess.claudeSessionId;
  const map = tp ? loadMap(sid) : null;
  const guard = getGuardBag(sess.cwd);
  // 项目记忆与对话记录分开：只要记忆、不要冗长聊天记录也行
  const memDir = mem ? memoryDirOf(sess) : null;
  const memFiles = memDir ? scanDir(memDir) : [];
  const manifest = {
    myhiPack: 1, title: sess.title || '', tags: sess.tags || [], firstUserText: sess.firstUserText || '',
    cwd: sess.cwd, from, exportedAt: new Date().toISOString(),
    home: homedir(), platform: process.platform,   // 原机器的用户目录：导入时对话 / 记忆里提到的用户目录下路径一起改成新机器的
    files: proj.files.length, bytes: proj.bytes, skipped: proj.skipped,
    conv: tp ? { sid, claudeDir: projDir } : null,   // claudeDir：原机器上的 claude 项目目录（对话里提到的记忆路径要跟着改）
    memory: memFiles.length ? { count: memFiles.length, claudeDir: dirname(memDir) } : null,
    secrets: listSecrets('project', sess.cwd).map((s) => s.name),
    guard: guard ? { enabled: !!guard.enabled, entities: (guard.entities || []).length } : null,
  };
  const gz = createGzip({ level: 6 });
  gz.pipe(out);
  const mj = Buffer.from(JSON.stringify(manifest, null, 2));
  await putEntry(gz, 'myhi-pack.json', { size: mj.length, data: mj });
  for (const f of proj.files) await putEntry(gz, 'files/' + f.rel, { size: f.size, mtime: f.mtime, mode: f.mode, file: f.abs });
  if (tp) {
    const tj = readFileSync(tp);
    await putEntry(gz, `claude/${sid}.jsonl`, { size: tj.length, data: tj });
    for (const f of scanDir(join(projDir, sid))) await putEntry(gz, `claude/${sid}/${f.rel}`, { size: f.size, mtime: f.mtime, file: f.abs });
    if (map && Object.keys(map.byVal || {}).length) { const b = Buffer.from(JSON.stringify(map)); await putEntry(gz, 'myhi/pseudo-map.json', { size: b.length, data: b }); }
  }
  for (const f of memFiles) await putEntry(gz, `claude/memory/${f.rel}`, { size: f.size, mtime: f.mtime, file: f.abs });
  if (guard) { const b = Buffer.from(JSON.stringify(guard)); await putEntry(gz, 'myhi/guard.json', { size: b.length, data: b }); }
  await put(gz, Buffer.alloc(1024));          // tar 结尾：两个全零块
  gz.end();
  await once(out, 'finish').catch(() => {});
}

// ── tar 读（流式）──────────────────────────────────────────────────────────
//   onEntry({ name, size }) → 返回 { write(buf), end() }（要这个条目）/ null（跳过）/ 'stop'（不再往下读）
async function readTar(file, onEntry) {
  const input = createReadStream(file).pipe(createGunzip());
  let buf = Buffer.alloc(0), state = 'hdr', left = 0, padLeft = 0, sink = null, paxPath = null, cur = null;
  const ascii = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  try {
    for await (const chunk of input) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (state === 'hdr') {
          if (buf.length < 512) break;
          const h = buf.subarray(0, 512); buf = buf.subarray(512);
          if (h.every((x) => x === 0)) continue;                   // 结尾零块
          const type = String.fromCharCode(h[156] || 48);
          const size = parseInt(ascii(h.subarray(124, 136)).trim() || '0', 8);
          const mode = parseInt(ascii(h.subarray(100, 108)).trim() || '644', 8) & 0o777;
          left = size; padLeft = (512 - (size % 512)) % 512;
          if (type === 'x') { state = 'pax'; cur = []; continue; }
          const name = paxPath || ascii(h.subarray(0, 100)); paxPath = null;
          sink = type === '0' || type === '\0' ? await onEntry({ name, size, mode }) : null;
          if (sink === 'stop') return;
          state = 'data';
        }
        if (state === 'pax' || state === 'data') {
          if (left > 0) {
            if (!buf.length) break;
            const take = buf.subarray(0, Math.min(left, buf.length)); buf = buf.subarray(take.length); left -= take.length;
            if (state === 'pax') cur.push(take); else if (sink) await sink.write(take);
            if (left > 0) break;
          }
          if (buf.length < padLeft) break;
          buf = buf.subarray(padLeft); padLeft = 0;
          if (state === 'pax') {
            for (const line of Buffer.concat(cur).toString('utf8').split('\n')) {
              const m = /^\d+ path=(.*)$/s.exec(line); if (m) paxPath = m[1];
            }
          } else if (sink) await sink.end();
          sink = null; state = 'hdr';
        }
      }
    }
  } finally { input.destroy(); }
}

/** 只读清单（预览用）：读到第一个条目就停 */
export async function readManifest(file) {
  let manifest = null;
  await readTar(file, async ({ name }) => {
    if (name !== 'myhi-pack.json' && name !== 'myhi-bundle.json') return 'stop';
    const parts = [];
    return { write: (b) => parts.push(b), end: () => { manifest = JSON.parse(Buffer.concat(parts).toString('utf8')); } };
  });
  if (!manifest || (manifest.myhiPack !== 1 && manifest.myhiBundle !== 1)) throw new Error('不是有效的 myhi 迁移包（.myhipack）');
  return manifest;
}

// 包内相对路径 → 目标绝对路径；拒绝 .. / 绝对路径 / 盘符，确保落在 base 里
function safeJoin(base, rel) {
  if (!rel || rel.includes('\0') || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[\\/]/).some((s) => s === '..')) return null;
  const p = resolve(base, rel);
  return p === base || p.startsWith(base + sep) ? p : null;
}
function fileSink(path, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const ws = createWriteStream(path, { mode: mode || 0o644 });
  return {
    write: async (b) => { if (!ws.write(b)) await once(ws, 'drain'); },
    end: () => new Promise((r, j) => { ws.on('error', j); ws.end(r); }),
  };
}
function memSink(done) {
  const parts = [];
  return { write: (b) => parts.push(b), end: () => done(Buffer.concat(parts)) };
}

// 对话记录里的旧路径 → 新路径。JSON 里 Windows 反斜杠是转义过的，两种写法都换；
// 存成 plan/default 的权限模式改回 bypass，免得 --resume 一上来就被判「中毒」自动重开
// ── 路径改写（对话记录 JSON / 记忆 Markdown 共用）────────────────────────────
// pairs：[[旧, 新], …]，按从具体到宽泛排：原机器 claude 项目目录 → 项目目录 → 用户目录。
//   · 用户目录也要换：不同主机用户目录不同（C:\Users\alice ↔ C:\Users\bob ↔ /home/me），对话 / 记忆里
//     常提到项目外的文件（聊天上传的截图 ~/.myhi/uploads、下载目录、~/.ssh …）
//   · 只在完整路径段边界上换：旧用户目录是 /root 时不会把 /rooted 也改掉
//   · 先换成占位符最后再落值：新路径里恰好含旧路径时不会被下一条规则二次改写
//   · Windows → Linux / macOS：换完的路径后面跟着的 \ 一并改成 /（反过来不用，Windows 认 /）
// json：文本是 JSON（对话记录），路径里的 \ 在 JSON 里是转义过的 \\
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p || '');
export function rewritePaths(text, pairs, { json = false } = {}) {
  const enc = json ? (x) => JSON.stringify(x).slice(1, -1) : (x) => x;
  const bs = json ? '\\\\' : '\\';                                   // 编码后的一个反斜杠
  const boundary = `(?=${escRe(bs)}|[/"'\\s:,;)\\]}>\`|，。、；：！？）」』】》]|$)`;   // 含中文标点：记忆里常写「…目录 /root。」
  const tokens = [];
  let out = text;
  for (const [a, b] of pairs) {
    if (!a || !b || a === b) continue;
    const variants = [[a, b]];
    if (a.includes('\\')) variants.push([a.replace(/\\/g, '/'), b.replace(/\\/g, '/')]);
    for (const [x, y] of variants) {
      const re = new RegExp(escRe(enc(x)) + boundary, 'g');
      out = out.replace(re, () => { tokens.push(enc(y)); return `\u0000MYHI${tokens.length - 1}\u0000`; });
    }
  }
  // Windows 路径迁到非 Windows：占位符后面紧跟的 \段\段 改成 /段/段
  const winToPosix = pairs.some(([a, b]) => isWinPath(a) && b && !isWinPath(b));
  if (winToPosix) {
    out = out.replace(new RegExp(`(\u0000MYHI\\d+\u0000)((?:${escRe(bs)}[^\\\\/"'\\s<>|*?:]+)+)`, 'g'),
      (m, tok, rest) => tok + rest.split(bs).join('/'));
  }
  return out.replace(/\u0000MYHI(\d+)\u0000/g, (m, i) => tokens[+i]);
}

// extra：排在项目目录前面的（claude 项目目录）；after：排在后面的（用户目录）—— 一次改完，占位符才防得住二次改写
export function rewriteTranscript(text, oldCwd, newCwd, oldSid, newSid, extra = [], after = []) {
  let out = rewritePaths(text, [...extra, [oldCwd, newCwd], ...after], { json: true });
  if (oldSid && newSid && oldSid !== newSid) out = out.split(oldSid).join(newSid);
  return out.replace(/"permissionMode":"(?:default|plan|acceptEdits)"/g, '"permissionMode":"bypassPermissions"');
}
// MEMORY.md 索引合并：新机器已有这个项目的记忆时，把迁移过来的条目追加进去（以前整份跳过 → 带来的记忆不在索引里，AI 看不到）
function mergeMemoryIndex(existing, incoming) {
  const have = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  // 指向同一个记忆文件的条目只留一条：同名文件保留的是新机器的，带过来的描述对不上
  const target = (l) => (l.match(/\]\(([^)]+)\)/) || [])[1];
  const linked = new Set(existing.split('\n').map(target).filter(Boolean));
  const add = incoming.split('\n').filter((l) => /^\s*[-*] /.test(l) && !have.has(l.trim()) && !linked.has(target(l)));
  return add.length ? existing.replace(/\n*$/, '\n') + add.join('\n') + '\n' : existing;
}

// 项目记忆：改写旧路径后落盘；同名已存在保留新机器的（MEMORY.md 索引则合并）
function writeMemories(memories, memDir, pairs) {
  const memory = { written: 0, kept: 0 };
  for (const m of memories) {
    const p = safeJoin(memDir, m.rel);
    if (!p) continue;
    const text = rewritePaths(m.buf.toString('utf8'), pairs);
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) { writeFileSync(p, text); memory.written++; }
    else if (m.rel === 'MEMORY.md') writeFileSync(p, mergeMemoryIndex(readFileSync(p, 'utf8'), text));
    else memory.kept++;
  }
  return memory;
}

// 包里的对话 id 完全来自外部文件：只认 claude 会话 id 的字符集（UUID），带 . / \ 的一律丢弃 ——
// 以前 sid 填 ../../../.ssh 会让 join(projDir, sid) 穿出 claude 项目目录，配合 claude/<sid>/xxx 条目任意写文件
const _validSid = (sid) => (typeof sid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sid)) ? sid : null;

/** 导入：解到 cwd，对话记录放进新路径对应的 claude 项目目录。返回 { manifest, sid, memory } */
export async function importPack(file, cwd) {
  const manifest = await readManifest(file);
  if (manifest.myhiBundle) throw new Error('这是「全部任务」的总迁移包，请在导入面板里按批量导入操作');
  const base = resolve(cwd);
  mkdirSync(base, { recursive: true });
  const oldSid = _validSid(manifest.conv?.sid);
  const projDir = join(claudeProjectsDir(), encodeCwd(base));
  // 同一个包导第二次：对话 id 已存在就换个新 id，两份互不干扰
  const newSid = oldSid ? (findTranscriptPath(oldSid) ? randomUUID() : oldSid) : null;
  let transcript = null, map = null, guard = null;
  const memories = [];   // { rel, buf }：先收着，改写路径后再落盘
  await readTar(file, async ({ name, mode }) => {
    if (name === 'myhi-pack.json') return null;
    // 保留可执行位（脚本到新机器还能直接跑）；属主始终可读写
    if (name.startsWith('files/')) { const p = safeJoin(base, name.slice(6)); return p ? fileSink(p, (mode & 0o755) | 0o600) : null; }
    if (name === 'myhi/guard.json') return memSink((b) => { try { guard = JSON.parse(b.toString('utf8')); } catch {} });
    // 项目记忆不依赖对话记录（导出时可以只带记忆）
    if (name.startsWith('claude/memory/')) { const rel = name.slice('claude/memory/'.length); return memSink((b) => memories.push({ rel, buf: b })); }
    if (!oldSid) return null;
    if (name === `claude/${oldSid}.jsonl`) return memSink((b) => { transcript = b.toString('utf8'); });
    if (name.startsWith(`claude/${oldSid}/`)) { const p = safeJoin(join(projDir, newSid), name.slice(`claude/${oldSid}/`.length)); return p ? fileSink(p) : null; }
    if (name === 'myhi/pseudo-map.json') return memSink((b) => { try { map = JSON.parse(b.toString('utf8')); } catch {} });
    return null;
  });
  if (guard) importGuardBag(base, guard);
  // 项目记忆：改写旧路径后落盘；同名已存在保留新机器的（MEMORY.md 索引则合并）
  const memory = writeMemories(memories, join(projDir, 'memory'),
    [[manifest.memory?.claudeDir || manifest.conv?.claudeDir, projDir], [manifest.cwd, base], [manifest.home, homedir()]]);
  let sid = null;
  if (transcript && newSid) {
    mkdirSync(projDir, { recursive: true });
    // 从具体到宽泛：claude 项目目录 → 项目目录（rewriteTranscript 内） → 用户目录（不同主机用户目录不同）
    const extra = manifest.conv?.claudeDir ? [[manifest.conv.claudeDir, projDir]] : [];
    const after = manifest.home ? [[manifest.home, homedir()]] : [];
    writeFileSync(join(projDir, newSid + '.jsonl'), rewriteTranscript(transcript, manifest.cwd || '', base, oldSid, newSid, extra, after), { mode: 0o600 });
    if (map) saveMap(newSid, map);
    sid = newSid;
  }
  return { manifest, sid, memory };
}

// ── 全部任务打成一个总迁移包 ────────────────────────────────────────────────
//   场景：项目很多，换电脑时一个个导出太麻烦 —— 一次打成一个 .myhipack，新机器一次导入，全部恢复成任务。
//   格式同单任务包（tar + gzip），第一个条目是总清单 myhi-bundle.json，各项目的条目放在 p<序号>/ 下：
//     p0/files/…  p0/claude/<sid>.jsonl  p0/claude/<sid>/…  p0/claude/memory/…  p0/myhi/pseudo-map/<sid>.json  p0/myhi/guard.json
//   同一项目目录下的多个任务：项目文件 / 记忆 / 护栏只打一份，各任务的对话记录分别带上。
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project';
function groupByProject(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    if (!s?.cwd) continue;
    const k = resolve(s.cwd);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.entries()].map(([cwd, list]) => ({ cwd, sessions: list }));
}

/** 预览：按项目列出会打包什么 */
export function bundlePreview(sessions) {
  return groupByProject(sessions).map(({ cwd, sessions: list }) => {
    const proj = scanProject(cwd);
    const memDir = memoryDirOf(list[0]);
    const guard = getGuardBag(cwd);
    return {
      cwd, name: baseName(cwd), exists: existsSync(cwd),
      files: proj.files.length, bytes: proj.bytes, skipped: proj.skipped, truncated: proj.truncated,
      memFiles: memDir ? scanDir(memDir).length : 0,
      guard: guard ? { enabled: !!guard.enabled, entities: (guard.entities || []).length } : null,
      secrets: listSecrets('project', cwd).map((x) => x.name),
      tasks: list.map((x) => {
        const tp = x.claudeSessionId ? findTranscriptPath(x.claudeSessionId) : null;
        let convBytes = 0; if (tp) { try { convBytes = lstatSync(tp).size; } catch {} }
        return { title: x.title || '', hasConv: !!tp, convBytes, busy: !!x.isBusy };
      }),
    };
  });
}

/** 导出总包，写进 out（HTTP 响应） */
export async function exportBundle(sessions, { conv = true, mem = true, from = '' } = {}, out) {
  const groups = groupByProject(sessions).map((g, i) => {
    const proj = scanProject(g.cwd);
    const memDir = mem ? memoryDirOf(g.sessions[0]) : null;
    const memFiles = memDir ? scanDir(memDir) : [];
    const guard = getGuardBag(g.cwd);
    const tasks = g.sessions.map((x) => {
      const tp = conv && x.claudeSessionId ? findTranscriptPath(x.claudeSessionId) : null;
      return { sess: x, tp, sid: tp ? x.claudeSessionId : null };
    });
    return { key: 'p' + i, cwd: g.cwd, proj, memDir, memFiles, guard, tasks };
  });
  const manifest = {
    myhiBundle: 1, from, exportedAt: new Date().toISOString(), home: homedir(), platform: process.platform,
    projects: groups.map((g) => ({
      key: g.key, cwd: g.cwd, name: baseName(g.cwd),
      files: g.proj.files.length, bytes: g.proj.bytes, skipped: g.proj.skipped,
      memory: g.memFiles.length ? { count: g.memFiles.length, claudeDir: dirname(g.memDir) } : null,
      guard: g.guard ? { enabled: !!g.guard.enabled, entities: (g.guard.entities || []).length } : null,
      secrets: listSecrets('project', g.cwd).map((x) => x.name),
      tasks: g.tasks.map((t) => ({
        title: t.sess.title || '', tags: t.sess.tags || [], firstUserText: t.sess.firstUserText || '',
        conv: t.tp ? { sid: t.sid, claudeDir: dirname(t.tp) } : null,
      })),
    })),
  };
  const gz = createGzip({ level: 6 });
  gz.pipe(out);
  const mj = Buffer.from(JSON.stringify(manifest, null, 2));
  await putEntry(gz, 'myhi-bundle.json', { size: mj.length, data: mj });
  for (const g of groups) {
    const P = g.key + '/';
    for (const f of g.proj.files) await putEntry(gz, P + 'files/' + f.rel, { size: f.size, mtime: f.mtime, mode: f.mode, file: f.abs });
    for (const t of g.tasks) {
      if (!t.tp) continue;
      const tj = readFileSync(t.tp);
      await putEntry(gz, `${P}claude/${t.sid}.jsonl`, { size: tj.length, data: tj });
      for (const f of scanDir(join(dirname(t.tp), t.sid))) await putEntry(gz, `${P}claude/${t.sid}/${f.rel}`, { size: f.size, mtime: f.mtime, file: f.abs });
      const map = loadMap(t.sid);
      if (map && Object.keys(map.byVal || {}).length) { const b = Buffer.from(JSON.stringify(map)); await putEntry(gz, `${P}myhi/pseudo-map/${t.sid}.json`, { size: b.length, data: b }); }
    }
    for (const f of g.memFiles) await putEntry(gz, `${P}claude/memory/${f.rel}`, { size: f.size, mtime: f.mtime, file: f.abs });
    if (g.guard) { const b = Buffer.from(JSON.stringify(g.guard)); await putEntry(gz, P + 'myhi/guard.json', { size: b.length, data: b }); }
  }
  await put(gz, Buffer.alloc(1024));
  gz.end();
  await once(out, 'finish').catch(() => {});
}

/**
 * 导入总包。targets：{ p0: '/新机器/目录', … }，没列的项目跳过。
 * 返回 [{ key, cwd, memory, tasks: [{ title, tags, firstUserText, sid }] }]（sid 为空 = 没带对话记录，导入后是新对话）
 */
export async function importBundle(file, targets) {
  const manifest = await readManifest(file);
  if (!manifest.myhiBundle) throw new Error('这不是「全部任务」的总迁移包');
  const st = {};
  for (const p of manifest.projects || []) {
    if (!targets[p.key]) continue;
    const base = resolve(targets[p.key]);
    mkdirSync(base, { recursive: true });
    const sids = new Map();   // 原 sid → 新 sid（这台机器上已有同 id 的对话就换一个，互不干扰）
    for (const t of p.tasks || []) { const sid = _validSid(t.conv?.sid); if (sid) sids.set(sid, findTranscriptPath(sid) ? randomUUID() : sid); }
    st[p.key] = { p, base, projDir: join(claudeProjectsDir(), encodeCwd(base)), sids, transcripts: new Map(), maps: new Map(), memories: [], guard: null };
  }
  await readTar(file, async ({ name, mode }) => {
    const m = /^(p\d+)\/(.+)$/.exec(name);
    const x = m && st[m[1]];
    if (!x) return null;
    const rest = m[2];
    if (rest.startsWith('files/')) { const q = safeJoin(x.base, rest.slice(6)); return q ? fileSink(q, (mode & 0o755) | 0o600) : null; }
    if (rest === 'myhi/guard.json') return memSink((b) => { try { x.guard = JSON.parse(b.toString('utf8')); } catch {} });
    if (rest.startsWith('claude/memory/')) { const rel = rest.slice('claude/memory/'.length); return memSink((b) => x.memories.push({ rel, buf: b })); }
    let mm = /^claude\/([^/]+)\.jsonl$/.exec(rest);
    if (mm && x.sids.has(mm[1])) { const sid = mm[1]; return memSink((b) => x.transcripts.set(sid, b.toString('utf8'))); }
    mm = /^claude\/([^/]+)\/(.+)$/.exec(rest);
    if (mm && x.sids.has(mm[1])) { const q = safeJoin(join(x.projDir, x.sids.get(mm[1])), mm[2]); return q ? fileSink(q) : null; }
    mm = /^myhi\/pseudo-map\/([^/]+)\.json$/.exec(rest);
    if (mm && x.sids.has(mm[1])) { const sid = mm[1]; return memSink((b) => { try { x.maps.set(sid, JSON.parse(b.toString('utf8'))); } catch {} }); }
    return null;
  });
  const results = [];
  for (const x of Object.values(st)) {
    const { p, base, projDir } = x;
    if (x.guard) importGuardBag(base, x.guard);
    const memory = writeMemories(x.memories, join(projDir, 'memory'),
      [[p.memory?.claudeDir, projDir], [p.cwd, base], [manifest.home, homedir()]]);
    const tasks = [];
    for (const t of p.tasks || []) {
      const oldSid = t.conv?.sid, text = oldSid ? x.transcripts.get(oldSid) : null;
      let sid = null;
      if (text) {
        const newSid = x.sids.get(oldSid);
        mkdirSync(projDir, { recursive: true });
        const extra = t.conv.claudeDir ? [[t.conv.claudeDir, projDir]] : [];
        const after = manifest.home ? [[manifest.home, homedir()]] : [];
        writeFileSync(join(projDir, newSid + '.jsonl'), rewriteTranscript(text, p.cwd || '', base, oldSid, newSid, extra, after), { mode: 0o600 });
        if (x.maps.has(oldSid)) saveMap(newSid, x.maps.get(oldSid));
        sid = newSid;
      }
      tasks.push({ title: t.title, tags: t.tags || [], firstUserText: t.firstUserText || '', sid });
    }
    results.push({ key: p.key, cwd: base, memory, secrets: p.secrets || [], tasks });
  }
  return results;
}
