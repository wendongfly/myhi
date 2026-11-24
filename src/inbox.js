// ---------------------------------------------------------------------------
// 灵感收件箱（草稿队列）
//
//   场景：某个会话正忙（AI 在跑，可能还开着子代理），你临时冒出一个需求/想法，
//   想先记下来，等这轮干完再发。旧行为是 isBusy 直接报错「正在处理中」，
//   而前端此时已经清空了输入框和图片预览 —— 输入连同刚上传的图片一起丢失。
//
//   每条草稿**强制归属一个会话**：只记文字不记归属的话，三天后看到
//   「把那个接口改成异步」根本想不起是哪个项目。sessionTitle/cwd 存的是
//   快照，会话被重命名或终止后草稿仍认得出自己原来属于哪个任务，可改投。
//
//   存 ~/.myhi/inbox.json (0600)。草稿只是本机暂存，没有出模型，
//   隐私护栏(Layer C)仍在真正发送那一刻才做假名化，不受影响。
// ---------------------------------------------------------------------------

import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';

const CONFIG_DIR = join(homedir(), '.myhi');
const INBOX_FILE = join(CONFIG_DIR, 'inbox.json');

const MAX_DRAFTS = 500;      // 总量上限，防止无限堆积
const MAX_TEXT = 20000;      // 单条文本上限

/** @returns {Array<Object>} */
export function loadDrafts() {
  try {
    const list = JSON.parse(readFileSync(INBOX_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveDrafts(list) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = INBOX_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    renameSync(tmp, INBOX_FILE);
    return true;
  } catch (err) {
    console.error('[inbox] 写入失败:', err.message);
    return false;
  }
}

/** 从 cwd 取末级目录名当项目名，列表里比全路径好认 */
function projectNameOf(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function normAttach(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((a) => a && typeof a.path === 'string' && a.path)
    .slice(0, 10)
    .map((a) => ({ path: a.path, name: a.name || a.path.split('/').pop() }));
}

/**
 * 列草稿。sessionId 给定则只列该会话的；owner 给定且非管理员则只列自己的。
 * @param {{sessionId?: string, owner?: string, includeAll?: boolean}} opts
 */
export function listDrafts({ sessionId, owner, includeAll = true } = {}) {
  let list = loadDrafts();
  if (sessionId) list = list.filter((d) => d.sessionId === sessionId);
  if (owner && !includeAll) list = list.filter((d) => !d.owner || d.owner === owner);
  return list.sort(byOrder);
}

// 队列顺序：order 小的先发。老草稿没有 order，用记录时间顶上（新草稿 order 也取创建时刻 = 排到队尾）
const orderOf = (d) => (typeof d.order === 'number' ? d.order : (d.createdAt || 0));
const byOrder = (a, b) => orderOf(a) - orderOf(b) || (a.createdAt || 0) - (b.createdAt || 0);

/**
 * 调整某会话草稿的先后顺序。ids 是新顺序（可以只含部分草稿）：把这些草稿原来占的 order 值
 * 按从小到大重新分给新顺序，不在 ids 里的草稿位置不变。
 */
export function reorderDrafts(sessionId, ids = []) {
  const list = loadDrafts();
  const picked = ids.map((id) => list.find((d) => d.id === id && d.sessionId === sessionId)).filter(Boolean);
  if (picked.length < 2) return false;
  const slots = picked.map(orderOf).sort((a, b) => a - b);
  // 去重：两条 order 相同时（同一毫秒创建）挪开一点，保证顺序确定
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
  picked.forEach((d, i) => { d.order = slots[i]; d.updatedAt = Date.now(); });
  saveDrafts(list);
  return true;
}

/**
 * 合并同一会话的几条草稿：按队列顺序拼成一条（2 条以上自动编号），附件合在一起，
 * 放在其中最靠前那条的位置；原草稿存进 mergedFrom，可「撤销合并」原样拆回。
 */
export function mergeDrafts(ids = []) {
  const list = loadDrafts();
  const picked = list.filter((d) => ids.includes(d.id)).sort(byOrder);
  if (picked.length < 2) throw new Error('至少选两条草稿才能合并');
  const sid = picked[0].sessionId;
  if (picked.some((d) => d.sessionId !== sid)) throw new Error('只能合并同一个任务的草稿');
  const texts = picked.map((d) => (d.text || '').trim()).filter(Boolean);
  const text = texts.length > 1 ? texts.map((t, i) => `${i + 1}. ${t}`).join('\n\n') : (texts[0] || '');
  const first = picked[0];
  const merged = {
    ...first,
    id: randomUUID(),
    clientKey: null,
    text: text.slice(0, MAX_TEXT),
    images: normAttach(picked.flatMap((d) => d.images || [])),
    files: normAttach(picked.flatMap((d) => d.files || [])),
    autoSend: picked.some((d) => d.autoSend),
    source: 'merged',
    order: orderOf(first),
    // 只留一层：合并已合并的草稿时把它的原件摊平进来，撤销时一次拆回最初的几条
    mergedFrom: picked.flatMap((d) => (d.mergedFrom?.length ? d.mergedFrom : [{ ...d, mergedFrom: undefined }])).slice(0, 50),
    createdAt: Math.min(...picked.map((d) => d.createdAt || Date.now())),
    updatedAt: Date.now(),
  };
  const next = list.filter((d) => !ids.includes(d.id));
  next.push(merged);
  saveDrafts(next);
  return merged;
}

/** 撤销合并：删掉合并出来的那条，把原来的几条原样放回（保留各自原来的位置与内容） */
export function unmergeDraft(id) {
  const list = loadDrafts();
  const m = list.find((d) => d.id === id);
  if (!m || !m.mergedFrom?.length) throw new Error('这条不是合并出来的草稿');
  const back = m.mergedFrom.map((d) => ({ ...d, sessionId: m.sessionId, claudeSessionId: m.claudeSessionId,
    sessionTitle: m.sessionTitle, cwd: m.cwd, projectName: m.projectName, updatedAt: Date.now() }));
  const next = list.filter((d) => d.id !== id).concat(back);
  saveDrafts(next);
  return back;
}

/** 按会话统计草稿数，给会话列表打角标用 → { [sessionId]: n } */
export function countBySession() {
  const out = {};
  for (const d of loadDrafts()) {
    if (!d.sessionId) continue;
    out[d.sessionId] = (out[d.sessionId] || 0) + 1;
  }
  return out;
}

/**
 * 新建草稿。归属会话是必填的，sess 传会话对象（用于抓 title/cwd 快照）。
 * @param {Object} d  { text, images, files, sessionId, autoSend, source, owner }
 * @param {Object} [sess]  会话实例，用来抓标题/目录快照
 */
export function addDraft(d = {}, sess = null) {
  const text = String(d.text || '').slice(0, MAX_TEXT);
  const images = normAttach(d.images);
  const files = normAttach(d.files);
  if (!text.trim() && !images.length && !files.length) {
    throw new Error('草稿内容为空');
  }
  if (!d.sessionId) throw new Error('草稿必须归属一个会话');

  // 客户端断连重发防重：同一 clientKey 只落一条，重试时直接返回已存的那条
  const clientKey = typeof d.clientKey === 'string' && d.clientKey ? d.clientKey.slice(0, 64) : null;
  if (clientKey) {
    const dup = loadDrafts().find((x) => x.clientKey === clientKey);
    if (dup) return dup;
  }

  const cwd = sess?.cwd || d.cwd || '';
  const draft = {
    id: randomUUID(),
    clientKey,
    text,
    images,
    files,
    sessionId: d.sessionId,
    // myhi 重启后会话会拿到新的 randomUUID（sessions.js 恢复逻辑），光靠 sessionId
    // 草稿会集体变孤儿。claudeSessionId 跨重启/跨 --resume 稳定，用它做二级锚点重新认领。
    claudeSessionId: sess?.claudeSessionId || d.claudeSessionId || null,
    sessionTitle: sess?.title || d.sessionTitle || '(未知任务)',
    cwd,
    projectName: projectNameOf(cwd),
    owner: d.owner || sess?.owner || null,
    autoSend: !!d.autoSend,
    source: d.source || 'manual',   // manual | busy（忙时自动转存）| home（首页随手记）| merged（合并而来）
    order: Date.now(),              // 队列位置：新记的排到最后
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const list = loadDrafts();
  list.push(draft);
  // 超量时丢最老的
  while (list.length > MAX_DRAFTS) list.shift();
  saveDrafts(list);
  return draft;
}

/** 改草稿：文本 / autoSend / 改投到别的会话 */
export function updateDraft(id, patch = {}, sess = null) {
  const list = loadDrafts();
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return null;
  const d = list[i];

  if (typeof patch.text === 'string') d.text = patch.text.slice(0, MAX_TEXT);
  if (typeof patch.autoSend === 'boolean') d.autoSend = patch.autoSend;
  if (patch.images) d.images = normAttach(patch.images);
  if (patch.files) d.files = normAttach(patch.files);
  // 改投：会话没了 / 记错项目了
  if (patch.sessionId && patch.sessionId !== d.sessionId) {
    d.sessionId = patch.sessionId;
    d.claudeSessionId = sess?.claudeSessionId || null;
    d.sessionTitle = sess?.title || patch.sessionTitle || d.sessionTitle;
    d.cwd = sess?.cwd || patch.cwd || d.cwd;
    d.projectName = projectNameOf(d.cwd);
    d.order = Date.now();   // 改投过来的排到新任务队尾
  }
  d.updatedAt = Date.now();
  list[i] = d;
  saveDrafts(list);
  return d;
}

export function removeDraft(id) {
  const list = loadDrafts();
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  saveDrafts(next);
  return true;
}

/**
 * 重新认领：myhi 重启后会话换了新 id，按 claudeSessionId 把草稿贴回恢复出来的那个会话。
 * @param {Array<{id:string, claudeSessionId?:string, title?:string, cwd?:string}>} sessions 当前活跃会话
 * @returns {number} 重绑条数
 */
export function rebindDrafts(sessions = []) {
  const byClaude = new Map();
  for (const s of sessions) {
    if (s.claudeSessionId) byClaude.set(s.claudeSessionId, s);
  }
  const aliveIds = new Set(sessions.map((s) => s.id));
  const list = loadDrafts();
  let n = 0;
  for (const d of list) {
    if (aliveIds.has(d.sessionId)) continue;         // 归属还在，不动
    if (!d.claudeSessionId) continue;                // 没有锚点，留作孤儿等人工改投
    const s = byClaude.get(d.claudeSessionId);
    if (!s || s.id === d.sessionId) continue;
    d.sessionId = s.id;
    d.sessionTitle = s.title || d.sessionTitle;
    d.cwd = s.cwd || d.cwd;
    d.projectName = projectNameOf(d.cwd);
    n++;
  }
  if (n) saveDrafts(list);
  return n;
}

/**
 * 会话标题变了就同步快照，让草稿列表跟着改名走（会话终止时不动，保留原名）。
 */
export function syncSessionTitle(sessionId, title) {
  const list = loadDrafts();
  let changed = false;
  for (const d of list) {
    if (d.sessionId === sessionId && d.sessionTitle !== title) {
      d.sessionTitle = title;
      changed = true;
    }
  }
  if (changed) saveDrafts(list);
}

/**
 * 草稿 → 发给 AI 的 prompt。与 chat.html 的 sendCommand() 保持同一套措辞，
 * 免得手动发和自动接力发出去的东西不一样。
 * @param {Object} d 草稿
 * @returns {string}
 */
export function buildDraftPrompt(d) {
  const text = (d.text || '').trim();
  const img = d.images?.[0];
  const file = d.files?.[0];
  // 合并出来的草稿可能带多张图 / 多个文件：逐个列出路径
  if ((d.images?.length || 0) + (d.files?.length || 0) > 1) {
    const parts = [];
    if (d.images?.length) parts.push(`用户上传了 ${d.images.length} 张图片，路径分别是 ${d.images.map((a) => a.path).join('、')}，请用 Read 工具逐一读取。`);
    if (d.files?.length) parts.push(`用户上传了 ${d.files.length} 个临时文件用于本次分析（不在项目文件树里）：${d.files.map((a) => `${a.path}（原文件名 ${a.name}）`).join('、')}，请用合适的工具读取。`);
    return parts.join('') + `用户的要求是：${text || '分析这些内容'}`;
  }
  if (img) {
    return `用户上传了一张图片，路径是 ${img.path}，请用 Read 工具读取这张图片。用户的要求是：${text || '描述图片内容'}`;
  }
  if (file) {
    return `用户上传了一个临时文件用于本次分析（不在项目文件树里），路径是 ${file.path}（原文件名 ${file.name}），` +
      `请用合适的工具（如 Read）读取并分析它。用户的要求是：${text || '分析这个文件'}`;
  }
  return text;
}

/**
 * 取某会话下一条待自动接力的草稿（按队列顺序）。没有则 null。
 * 只返回明确勾了 autoSend 的 —— 自动接力默认关，不勾就只能手动取回。
 */
export function nextAutoSendDraft(sessionId) {
  if (!sessionId) return null;
  const list = loadDrafts()
    .filter((d) => d.sessionId === sessionId && d.autoSend)
    .sort(byOrder);   // 按队列顺序（用户排过的顺序），不是单纯按记录时间
  return list[0] || null;
}

/**
 * 草稿 → 聊天界面上显示的那行字。规则与 chat.html 手动发送时的 displayText 一致
 * （图片 📷、文件 📎、纯文本原样），这样自动接力发出的消息看起来和你自己发的一样。
 * 注意它和 buildDraftPrompt 是两回事：那个是给模型看的完整指令，这个是给人看的原文。
 * @param {Object} d 草稿
 * @returns {string}
 */
export function draftDisplayText(d) {
  const text = (d.text || '').trim();
  const img = d.images?.[0];
  const file = d.files?.[0];
  if ((d.images?.length || 0) + (d.files?.length || 0) > 1) {
    const att = [d.images?.length ? `📷×${d.images.length}` : '', d.files?.length ? `📎×${d.files.length}` : ''].filter(Boolean).join(' ');
    return `${att} ${text}`.trim();
  }
  if (img) return `📷 ${text || '分析图片'}`;
  if (file) return `📎 ${file.name}${text ? ' ' + text : ''}`;
  return text;
}
