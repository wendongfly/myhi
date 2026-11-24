// ---------------------------------------------------------------------------
// Privacy Guard — 去标识化 / 可逆假名化护栏（Layer C）
//   动机：客户在对话框提交的【提示词/数据】里常含主体实体、证件号、卡号、手机等敏感信息。
//   密钥库的 Layer A（env 注入）解决的是"模型不需要真值"的密钥；但实体正是模型要分析的内容，
//   不能不给、又不想让模型/第三方网关看见真实身份。本模块做【可逆假名化】：
//
//     出模型前：检测敏感实体 → 替换成稳定占位符 【类型_N】 → 映射表只留在本机
//     回模型后：把答案里的占位符 → 还原成真名，用户体验无损
//
//   ⚠️ 边界（务必对客户说清）：myhi 只能脱敏【用户经 myhi 提交的 prompt 文本】。若让 AI 用
//      Read/Bash 工具去读磁盘上的原始数据文件，tool_result 是在 claude 进程内部直接送进模型的，
//      myhi 看不到也拦不到——那种数据不在本护栏覆盖范围。要保护就把数据【贴进对话框】。
//
//   映射表：~/.myhi/pseudo-maps/<key>.json（chmod 600，按会话），不出本机、不进 memory。
//   配置：~/.myhi/pseudo.json —— 按项目 cwd 存 { enabled, level, entities:[{name,type}] }。
// ---------------------------------------------------------------------------

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { normCwd } from './secrets.js';

const configDir = join(homedir(), '.myhi');
const pseudoFile = join(configDir, 'pseudo.json');
const mapsDir = join(configDir, 'pseudo-maps');
const auditDir = join(configDir, 'pseudo-audit');

// 档位：控制启用哪些检测器。high=只脱敏高危 PII；standard=再加项目实体词典（默认）；
// strict=再加金额。词典是客户自己录的"我方主体/关联公司/关键人"名单——最实用的一档。
const LEVELS = {
  high:     { pii: true, dict: false, amount: false },
  standard: { pii: true, dict: true,  amount: false },
  strict:   { pii: true, dict: true,  amount: true },
};
export const DEFAULT_LEVEL = 'standard';

// 高危 PII 检测器（按优先级排序：身份证/信用代码先于纯数字卡号，避免 18 位被当银行卡）。
// 用 lookbehind/lookahead 卡数字边界，减少把长数字串里的子串误伤。
const PII = [
  { type: '身份证',   re: /(?<![0-9])\d{17}[\dXx](?![0-9])/g },
  { type: '信用代码', re: /(?<![0-9A-Za-z])[0-9A-HJ-NP-RTUWXY]{2}\d{6}[0-9A-HJ-NP-RTUWXY]{10}(?![0-9A-Za-z])/g },
  { type: '银行卡',   re: /(?<![0-9])\d{16,19}(?![0-9])/g },
  { type: '手机',     re: /(?<![0-9])1[3-9]\d{9}(?![0-9])/g },
  { type: '邮箱',     re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g },   // 各段有上限：无界写法在长串上平方级回溯
  { type: '车牌',     re: /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-HJ-NP-Z0-9]{4,6}/g },
];
const AMOUNT = [
  { type: '金额', re: /(?:[¥￥]|人民币)\s?\d[\d,]*(?:\.\d+)?|(?<![\d.])\d[\d,]*(?:\.\d+)?\s?(?:元|万元|亿元)/g },
];

// 还原用：匹配我们生成的占位符 【类型_数字】（类型只含中英文，长度受限，避免误吞正文）
const PLACEHOLDER_RE = /【[一-龥A-Za-z]{1,12}_\d+】/g;

// --- 配置读写 -------------------------------------------------------------
export function loadPseudoConfig() {
  try {
    const data = JSON.parse(readFileSync(pseudoFile, 'utf8'));
    return { projects: data.projects || {} };
  } catch {
    return { projects: {} };
  }
}
function savePseudoConfig(data) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(pseudoFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// 迁移用：原样取 / 写某项目的护栏配置（开关、档位、主体词典）。导入时新机器上已有同项目配置则保留新机器的
export function getGuardBag(cwd) {
  return loadPseudoConfig().projects[normCwd(cwd)] || null;
}
export function importGuardBag(cwd, bag) {
  if (!bag || typeof bag !== 'object') return false;
  const data = loadPseudoConfig();
  const key = normCwd(cwd);
  if (data.projects[key]) return false;
  data.projects[key] = { enabled: !!bag.enabled, level: bag.level, entities: Array.isArray(bag.entities) ? bag.entities : [] };
  savePseudoConfig(data);
  return true;
}

// 取某项目的护栏配置（含默认值）。enabled 默认关（opt-in），level 默认 standard。
export function getProjectGuard(cwd) {
  const bag = loadPseudoConfig().projects[normCwd(cwd)] || {};
  return {
    enabled: !!bag.enabled,
    level: LEVELS[bag.level] ? bag.level : DEFAULT_LEVEL,
    entities: Array.isArray(bag.entities) ? bag.entities : [],
  };
}

// 更新开关/档位（不动词典）
export function setProjectGuard(cwd, { enabled, level }) {
  const key = normCwd(cwd);
  if (!key) return { error: '缺少 cwd' };
  const data = loadPseudoConfig();
  const bag = (data.projects[key] = data.projects[key] || {});
  if (typeof enabled === 'boolean') bag.enabled = enabled;
  if (level && LEVELS[level]) bag.level = level;
  savePseudoConfig(data);
  return { ok: true };
}

// 词典：新增/更新一条实体（name 必填，type 可选，默认 '主体'）
export function upsertEntity(cwd, { name, type }) {
  const key = normCwd(cwd);
  if (!key) return { error: '缺少 cwd' };
  const nm = String(name || '').trim();
  if (!nm) return { error: '实体名不能为空' };
  if (nm.length < 2) return { error: '实体名太短（≥2 字符，避免误伤正文）' };
  const t = String(type || '').trim() || '主体';
  const data = loadPseudoConfig();
  const bag = (data.projects[key] = data.projects[key] || {});
  bag.entities = (bag.entities || []).filter((e) => e.name !== nm);
  bag.entities.push({ name: nm, type: t });
  savePseudoConfig(data);
  return { ok: true };
}

export function deleteEntity(cwd, name) {
  const key = normCwd(cwd);
  const data = loadPseudoConfig();
  const bag = data.projects[key];
  if (bag && Array.isArray(bag.entities)) {
    bag.entities = bag.entities.filter((e) => e.name !== name);
    savePseudoConfig(data);
  }
  return { ok: true };
}

// 批量：每行一条，支持 `名称` 或 `名称|类型`。空行/`#` 注释忽略。非破坏性（不删漏列的）。
export function upsertManyEntities(cwd, text) {
  const key = normCwd(cwd);
  if (!key) return { error: '缺少 cwd' };
  let count = 0;
  const errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, type] = line.split('|').map((s) => s.trim());
    const r = upsertEntity(cwd, { name, type });
    if (r.error) errors.push(`${line.slice(0, 30)}: ${r.error}`);
    else count++;
  }
  return { ok: true, count, errors };
}

// --- 会话映射表持久化 ------------------------------------------------------
// key 用 claudeSessionId（跨 --resume 稳定）；无则退回 myhi 会话 id。map 只在本机，chmod 600。
function mapPath(key) {
  return join(mapsDir, String(key).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
}
export function loadMap(key) {
  if (!key) return newMap();
  try {
    const m = JSON.parse(readFileSync(mapPath(key), 'utf8'));
    return { byVal: m.byVal || {}, counters: m.counters || {} };
  } catch {
    return newMap();
  }
}
export function saveMap(key, map) {
  if (!key || !map) return;
  try {
    mkdirSync(mapsDir, { recursive: true });
    const p = mapPath(key), tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    renameSync(tmp, p);
  } catch { /* 持久化失败不致命：本轮仍在内存里可用 */ }
}
function newMap() { return { byVal: {}, counters: {} }; }

// 会话换键：首轮还没有 claude 会话 id，映射表 / 审计按 myhi 会话 id 落盘；拿到 claude id 后迁过去。
// 以前不迁：① 审计导出（按 claude id 读）看不到首轮（往往正是贴大批数据那一轮）；
// ② 首轮后重启 → 按 claude id 读不到映射表 → 编号从 1 重来，新实体复用旧占位符，还原成别人的真名。
export function adoptKey(oldKey, newKey, map) {
  if (!oldKey || !newKey || oldKey === newKey) return;
  if (map) saveMap(newKey, map);
  try { if (existsSync(mapPath(oldKey))) unlinkSync(mapPath(oldKey)); } catch {}
  try {
    if (existsSync(auditPath(oldKey))) {
      mkdirSync(auditDir, { recursive: true });
      appendFileSync(auditPath(newKey), readFileSync(auditPath(oldKey)), { mode: 0o600 });
      unlinkSync(auditPath(oldKey));
    }
  } catch {}
}

// 删掉某键的映射表（开新对话时清掉按 myhi id 存的首轮表）
export function dropMap(key) { if (key) try { unlinkSync(mapPath(key)); } catch {} }

// 只做还原（回放历史用）：占位符 → 真名。映射表为空返回 null
export function buildRestorer(map) {
  const byPh = {};
  for (const [val, rec] of Object.entries(map?.byVal || {})) byPh[rec.ph] = val;
  if (!Object.keys(byPh).length) return null;
  return (str) => (typeof str !== 'string' || str.indexOf('【') < 0) ? str : str.replace(PLACEHOLDER_RE, (m) => (byPh[m] !== undefined ? byPh[m] : m));
}

// --- 审计留痕 -------------------------------------------------------------
// 每轮脱敏记一条：时间、脱敏了几处、类型分布、以及【发给模型的脱敏后全文】。
//   目的：留下可审查/可导出的证据——"模型/网关这一轮实际看到的就是这段假名文本"。
//   安全：只记脱敏后文本 + 类型计数，【不记真值、不记占位符→真值映射】，故审计文件本身
//   可安全导出给合规方看。⚠️ 若某敏感信息漏检(未被任何检测器命中)，它会以明文留在
//   sentToModel 里——这正是审计的价值(能发现漏网)，文件按 chmod 600 与 transcript 同级保护。
function auditPath(key) {
  return join(auditDir, String(key).replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl');
}
export function appendAudit(key, entry) {
  if (!key || !entry) return;
  try {
    mkdirSync(auditDir, { recursive: true });
    appendFileSync(auditPath(key), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* 审计写失败不致命 */ }
}
export function loadAudit(key, limit = 500) {
  if (!key) return [];
  try {
    const lines = readFileSync(auditPath(key), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// --- 核心：构造某会话的假名化器 --------------------------------------------
// sharedMap 会被就地 mutate（跨轮累积，保证同一实体全程同一占位符 → 模型能连贯推理）。
// 返回 { enabled, level, pseudonymize(str)->{text,count}, restore(str)->str, size }。
// enabled=false 时 pseudonymize/restore 均为恒等函数、零开销。
export function buildPseudonymizer(cwd, sharedMap) {
  const guard = getProjectGuard(cwd);
  const map = sharedMap && sharedMap.byVal ? sharedMap : newMap();
  if (!guard.enabled) {
    return { enabled: false, level: guard.level, map, size: Object.keys(map.byVal).length,
      pseudonymize: (s) => ({ text: s, count: 0 }), restore: (s) => s };
  }
  const cfg = LEVELS[guard.level] || LEVELS[DEFAULT_LEVEL];

  // 反向索引（占位符 → 真值），从累积 map 现建，供 restore 用
  const byPh = {};
  for (const [val, rec] of Object.entries(map.byVal)) byPh[rec.ph] = val;

  function ensure(value, type) {
    if (map.byVal[value]) return map.byVal[value].ph;
    map.counters[type] = (map.counters[type] || 0) + 1;
    const ph = `【${type}_${map.counters[type]}】`;
    map.byVal[value] = { ph, type };
    byPh[ph] = value;
    return ph;
  }

  function pseudonymize(text) {
    if (typeof text !== 'string' || !text) return { text, count: 0 };
    // 1) 收集候选（按优先级：PII → 词典 → 金额），首个命中的检测器决定其类型
    const detectors = [];
    if (cfg.pii) detectors.push(...PII);
    // 词典：客户自录的主体名，直接按字面命中
    const dict = cfg.dict ? guard.entities : [];
    if (cfg.amount) detectors.push(...AMOUNT);

    for (const d of detectors) {
      const found = text.match(d.re);
      if (found) for (const v of found) if (!map.byVal[v]) ensure(v, d.type);
    }
    for (const e of dict) {
      if (e.name && text.includes(e.name) && !map.byVal[e.name]) ensure(e.name, e.type || '主体');
    }

    // 2) 替换：只替换本文本里确实出现的值，长值优先（避免子串先被替换）
    const present = Object.keys(map.byVal).filter((v) => text.includes(v));
    present.sort((a, b) => b.length - a.length);
    let out = text;
    let count = 0;
    const byType = {}; // 本轮脱敏的类型分布（供审计留痕，不含真值）
    for (const v of present) {
      if (out.includes(v)) {
        const t = map.byVal[v].type;
        out = out.split(v).join(map.byVal[v].ph);
        count++;
        byType[t] = (byType[t] || 0) + 1;
      }
    }
    return { text: out, count, byType };
  }

  function restore(str) {
    if (typeof str !== 'string' || !str || str.indexOf('【') < 0) return str;
    return str.replace(PLACEHOLDER_RE, (m) => (byPh[m] !== undefined ? byPh[m] : m));
  }

  return { enabled: true, level: guard.level, map, size: Object.keys(map.byVal).length,
    pseudonymize, restore };
}
