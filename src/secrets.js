// ---------------------------------------------------------------------------
// Secret Vault — 命名密钥库
//   动机：项目里常要用 GitLab PAT / 部署 token / AI 网关 key / 证书等敏感值。若在
//   聊天框直接贴，会同时落到 ①myhi 内存 _history ②socket 广播/重连回放 ③Claude Code
//   自己的 transcript jsonl（明文落盘，--resume 反复读回）——永久泄露面。
//
//   本模块把密钥集中存在 ~/.myhi/secrets.json（chmod 600），提供两条路径：
//     Layer A（主防线）：spawn claude 时把密钥注入成【环境变量】，AI/命令用 $NAME 引用，
//                        密钥值根本不进会话（对齐既有 gateway.json 的做法）。
//     Layer B（兜底）：myhi 持有明文，可对落 _history / 广播的文本做【精确匹配脱敏】，
//                      即使 AI 手滑 echo 出来，也只显示 «SECRET:NAME» 占位符。
//
//   作用域：global（所有会话）+ 按项目 cwd（最小权限，PAT 只注给对应项目的会话）。
//   类型：'env' → env[NAME]=value；'file'（证书等）→ 写盘 + env[MYHI_SECRET_NAME]=路径。
//
//   ⚠️ 密钥值【绝不】写进 memory / CLAUDE.md（明文、每轮全量入上下文）。记忆只存约定。
// ---------------------------------------------------------------------------

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const configDir = join(homedir(), '.myhi');
const secretsFile = join(configDir, 'secrets.json');
const secretsDir = join(configDir, 'secrets'); // type:'file' 密钥的落盘目录

// 合法环境变量名：字母/下划线开头，后续字母数字下划线
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 脱敏最短长度：太短的值（如 "1234"）易误伤正文，只脱敏 ≥8 字符的密钥
const REDACT_MIN_LEN = 8;

// cwd → 规范化 project key（正斜杠、去尾斜杠、小写），用作 secrets.json 里 projects 的键，
// 可读且跨大小写/斜杠稳定（Windows 路径大小写不敏感）。
export function normCwd(cwd) {
  if (!cwd) return '';
  return String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// 结构：{ global: { NAME: {type, value} }, projects: { <normCwd>: { NAME: {type, value} } } }
export function loadSecrets() {
  try {
    const data = JSON.parse(readFileSync(secretsFile, 'utf8'));
    return { global: data.global || {}, projects: data.projects || {} };
  } catch {
    return { global: {}, projects: {} };
  }
}

function saveSecrets(data) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(secretsFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// 掩码预览：ghp_abcd...wxyz → ghp_ab***wxyz（永不回明文给前端）
export function maskValue(val) {
  if (!val) return '';
  if (val.length <= 12) return '***';
  return val.slice(0, 6) + '***' + val.slice(-4);
}

// 列出某作用域的密钥（只回名字/类型/掩码，不含明文）——给管理端 UI 用
export function listSecrets(scope, cwd) {
  const data = loadSecrets();
  const bag = scope === 'project' ? (data.projects[normCwd(cwd)] || {}) : (data.global || {});
  return Object.entries(bag).map(([name, def]) => ({
    name,
    type: def.type || 'env',
    scope,
    preview: maskValue(def.value),
    hasValue: !!def.value,
  }));
}

// 全量总览（管理端 UI 用）：global + 各项目，全部掩码，永不含明文
export function secretsOverview() {
  const data = loadSecrets();
  const mask = (bag) => Object.entries(bag || {}).map(([name, def]) => ({
    name, type: def.type || 'env', preview: maskValue(def.value), hasValue: !!def.value,
  }));
  return {
    global: mask(data.global),
    projects: Object.entries(data.projects || {}).map(([cwd, bag]) => ({ cwd, secrets: mask(bag) })),
  };
}

// 新增/更新一条密钥。value 为空/掩码串视为"不改值"（沿用旧值）。返回 {ok} 或 {error}
export function upsertSecret({ name, value, type, scope, cwd }) {
  if (!name || !VALID_NAME.test(name)) {
    return { error: '密钥名不合法：需字母/下划线开头，仅含字母数字下划线（会作为环境变量名）' };
  }
  const t = type === 'file' ? 'file' : 'env';
  const data = loadSecrets();
  const key = scope === 'project' ? normCwd(cwd) : null;
  if (scope === 'project' && !key) return { error: '项目作用域必须提供 cwd' };
  const bag = scope === 'project'
    ? (data.projects[key] = data.projects[key] || {})
    : (data.global = data.global || {});
  const prev = bag[name];
  const isMaskedOrEmpty = !value || value.includes('***');
  const finalValue = isMaskedOrEmpty ? (prev ? prev.value : '') : value;
  if (!finalValue) return { error: '新建密钥必须提供值' };
  bag[name] = { type: t, value: finalValue };
  saveSecrets(data);
  return { ok: true };
}

export function deleteSecret({ name, scope, cwd }) {
  const data = loadSecrets();
  const bag = scope === 'project' ? data.projects[normCwd(cwd)] : data.global;
  if (bag && bag[name]) { delete bag[name]; saveSecrets(data); }
  return { ok: true };
}

// 批量 upsert 项目密钥（.env 风格文本，每行 NAME=值）——给「批量编辑」用。
//   规则：空行/`#` 注释忽略；无 `=` 的行报错跳过；值留空=保留旧值(不改)；去掉包裹引号；
//   一律按 type='env'（证书这类 file 型仍单条维护，避免多行值粘不进来）。非破坏性：
//   文本里没列到的变量【不会】被删除（删除仍走单条「删」）。返回 {ok,count,errors}。
export function upsertManyProject(cwd, text) {
  if (!cwd) return { error: '缺少 cwd' };
  const errors = [];
  let count = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) { errors.push(`忽略(无 =): ${line.slice(0, 40)}`); continue; }
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // 空值 = 保留旧值，不改
    const r = upsertSecret({ name, value, type: 'env', scope: 'project', cwd });
    if (r.error) errors.push(`${name}: ${r.error}`); else count++;
  }
  return { ok: true, count, errors };
}

// 解析某 cwd 的会话应得的全部密钥：global ⊕ 该项目（项目同名覆盖 global）
export function resolveSecretsForCwd(cwd) {
  const data = loadSecrets();
  const merged = { ...(data.global || {}) };
  const key = normCwd(cwd);
  if (key && data.projects[key]) Object.assign(merged, data.projects[key]);
  return merged;
}

// Layer A：把该会话应得的密钥注入到 env（就地改传入的 env 对象并返回）
//   type:'env'  → env[NAME] = value
//   type:'file' → 写 ~/.myhi/secrets/NAME（chmod 600）+ env[MYHI_SECRET_NAME] = 路径
export function applySecretsToEnv(env, cwd) {
  const secrets = resolveSecretsForCwd(cwd);
  for (const [name, def] of Object.entries(secrets)) {
    if (!def || !def.value || !VALID_NAME.test(name)) continue;
    if (def.type === 'file') {
      try {
        mkdirSync(secretsDir, { recursive: true });
        const p = join(secretsDir, name);
        writeFileSync(p, def.value, { mode: 0o600 });
        env['MYHI_SECRET_' + name] = p;
      } catch { /* ignore */ }
    } else {
      env[name] = def.value;
    }
  }
  return env;
}

// Layer B：构造脱敏函数（收集所有作用域的密钥明文值，长值优先避免子串先被替换）。
//   无密钥时返回 null（调用方据此跳过、零开销）。
export function buildRedactor() {
  const data = loadSecrets();
  const pairs = []; // [value, name]
  const collect = (bag) => {
    for (const [name, def] of Object.entries(bag || {})) {
      if (def && typeof def.value === 'string' && def.value.length >= REDACT_MIN_LEN) {
        pairs.push([def.value, name]);
      }
    }
  };
  collect(data.global);
  for (const p of Object.values(data.projects || {})) collect(p);
  if (!pairs.length) return null;
  pairs.sort((a, b) => b[0].length - a[0].length); // 长值优先
  return function redact(str) {
    if (typeof str !== 'string' || !str) return str;
    let out = str;
    for (const [val, name] of pairs) {
      if (out.includes(val)) out = out.split(val).join(`«SECRET:${name}»`);
    }
    return out;
  };
}

// 对任意结构递归脱敏（用于 stream 消息 / history 条目）。
//   maxLen：默认不跳过。以前 >20 万字直接放行（fail-open）：一大段 Bash/Read 输出里夹着的密钥会原样广播、落 history。
//   redact 是逐个密钥 includes，线性开销，大字符串也只要毫秒级。
export function redactDeep(obj, redact, maxLen = Infinity) {
  if (!redact) return obj;
  if (typeof obj === 'string') return obj.length > maxLen ? obj : redact(obj);
  if (Array.isArray(obj)) return obj.map((v) => redactDeep(v, redact, maxLen));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redactDeep(v, redact, maxLen);
    return out;
  }
  return obj;
}
