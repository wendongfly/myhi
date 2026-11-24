// ---------------------------------------------------------------------------
// 场景模型：同一个网关 + 同一个 token，不同场景用不同模型
//   config.json 的 models：{ main, subagent, background, ask, voice }，留空 = 用默认
//     main        主任务模型（会话里没手动选过时用它；再没有 → Claude Code 自己的默认）
//     plan        计划模式用的模型（只调研、出方案）；批准后执行回到主任务模型（opusplan 机制，见 agent.js _modelPlan）
//     subagent    子代理（Task 拆出去的子任务）→ CLAUDE_CODE_SUBAGENT_MODEL
//     background  后台小任务（标题、摘要等）→ ANTHROPIC_DEFAULT_HAIKU_MODEL（Claude Code 的轻量模型位）
//     ask         问一问 / 解释（兼容老配置 askModel）
//     voice       语音整理成书面文字
//     visionPro   看图·高精度：重要截图（复杂标注的 bug 单、设计稿）发送时勾「🔍 高精度看图」改用它（如网关上的 Claude 等云端多模态）
//     vision      看图：配了就用——聊天框上传的图片先用它转成文字再交给主模型（见 describeImage / agent._prepareImages）
//   模型列表来自网关 GET /v1/models（新网关支持 ?scope=token 按 token 过滤，见网关设计文档）
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from 'fs';
import { join, extname } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';

export const SCENES = {
  main: '主任务',
  plan: '计划',
  subagent: '子代理',
  background: '后台小任务',
  ask: '问一问 / 解释',
  voice: '语音整理',
  vision: '看图',
  visionPro: '看图·高精度',
  image: '出图',
  minutes: '会议纪要',
};

// 各场景的说明（首页设置 / 管理后台共用，经 /api/models 下发）
export const SCENE_HINTS = {
  main: '任务对话默认用它（聊天框里没单独选模型时）；留空 = Claude Code 默认',
  plan: '计划模式（只调研、出方案）用，可选更强的；批准执行后回到主任务模型；留空 = 跟主任务一样',
  subagent: 'AI 把任务拆成子任务时用；留空 = 跟主任务一样',
  background: '生成标题、摘要等后台小活，建议选便宜的',
  ask: '「问一问」和解释，建议选便宜快速的；留空 = sonnet',
  voice: '语音转成书面文字，建议选便宜的；留空 = 同问一问',
  vision: '配了就用：聊天框发的图片先用它转成文字再交给主模型（多花几秒，聊天里可点开核对）；主模型看不了图时一定要配，如本地部署的看图模型。留空 = 图片直接发给主模型。提示用户：截图标注尽量配文字，红框 / 箭头的指向看图模型常认错',
  minutes: '整理会议纪要用的模型（逐字稿长，选上下文大、中文好的）；留空 = 跟主任务一样',
  image: '「出图」页默认用的出图模型（如 glm-image、cogview-4、image-01）；留空 = 网关上的第一个出图模型',
  visionPro: '可选：重要截图（复杂标注的 bug 单、设计稿评审）发送时点「🔍 高精度」改用它，如网关上的 Claude 等云端多模态模型；留空 = 不显示这个开关',
};

const myhiDir = () => join(homedir(), '.myhi');
function readJson(name) {
  try { return JSON.parse(readFileSync(join(myhiDir(), name), 'utf8').replace(/^﻿/, '')) || {}; } catch { return {}; }
}

/**
 * 某个模型适不适合某个场景 → '' = 合适；否则是不合适的原因（界面上提示，不硬拦：网关元数据可能没填全）
 *   主会话 / 子代理靠工具干活：要支持工具调用，且能走 Anthropic 接口（只能走 OpenAI 转换的会丢工具）
 *   能力 / 协议信息网关没给（旧网关、Claude 种子数据为空）→ 不判断
 */
export function sceneFit(scene, m) {
  if (!m) return '';
  if (scene === 'main' || scene === 'plan' || scene === 'subagent') {
    if (m.caps?.length && !m.caps.includes('function_calling')) return '不支持工具调用，AI 没法读写文件、跑命令';
    if (m.protocols && !m.protocols.includes('anthropic')) return '不走 Anthropic 接口，Claude Code 用不了它的工具';
  }
  if (scene === 'vision' && m.caps?.length && !m.caps.includes('vision')) return '不能看图';
  return '';
}

/** 配了自定义网关没有（gateway.json 有地址和 key）——模型选择只在这时提供 */
export function hasGateway() { return !!resolveGateway().baseUrl; }

/**
 * 当前用的大模型网关 → { baseUrl, apiKey, source }，没有自定义网关时 baseUrl 为 ''
 *   按优先级自动找：
 *   1. myhi 自己的配置 ~/.myhi/gateway.json（首页设置 / 后台里配的）       source='myhi'
 *   2. 启动 myhi 时的环境变量 ANTHROPIC_BASE_URL + API_KEY / AUTH_TOKEN  source='env'
 *   3. Claude Code 自己的配置 ~/.claude/settings.json 的 env 段           source='claude'
 *   2、3 本来就是 claude 进程会用的网关（环境变量 / 它自己读 settings），myhi 只是读来列模型、看图，不改写。
 *   地址是 Anthropic 官方（api.anthropic.com）不算自定义网关。
 */
export function resolveGateway() {
  const official = (u) => /^https?:\/\/([^/]*\.)?anthropic\.com(\/|$)/i.test(u);
  const pick = (url, key, source) => (url && key && !official(url) ? { baseUrl: String(url).trim(), apiKey: String(key).trim(), source } : null);
  const mine = readJson('gateway.json');
  const e = process.env;
  let cs = {};
  try { cs = JSON.parse(readFileSync(join(e.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).env || {}; } catch {}
  return pick(mine.baseUrl, mine.apiKey, 'myhi')
    || pick(e.ANTHROPIC_BASE_URL, e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN, 'env')
    || pick(cs.ANTHROPIC_BASE_URL, cs.ANTHROPIC_API_KEY || cs.ANTHROPIC_AUTH_TOKEN, 'claude')
    || { baseUrl: '', apiKey: '', source: null };
}

/** 各场景配置的模型（没配为 ''） */
export function readSceneModels() {
  const cfg = readJson('config.json');
  // 场景模型只在配了自定义网关时生效（模型从网关目录选）；没配网关 → 全部留空 = 跟随默认
  if (!hasGateway()) return Object.fromEntries(Object.keys(SCENES).map((k) => [k, '']));
  const m = cfg.models && typeof cfg.models === 'object' ? cfg.models : {};
  const out = {};
  for (const k of Object.keys(SCENES)) out[k] = typeof m[k] === 'string' ? m[k].trim() : '';
  for (const k of Object.keys(out)) if (out[k] === 'gpt-m1-vision') out[k] = 'm1-vision';   // 旧配置里的模型名兼容
  if (!out.ask && typeof cfg.askModel === 'string') out.ask = cfg.askModel.trim();   // 老配置
  return out;
}
export const sceneModel = (name) => readSceneModels()[name] || '';

// ── 网关模型目录 ────────────────────────────────────────────────────────────
let _cache = null;   // { at, key, value }
const TTL = 10 * 60_000;

/**
 * → { gateway: bool, scoped: bool, models: [{id, name, provider, kind, target, caps, tags, inputCost, outputCost}], error }
 *   gateway=false：没配网关（直连 Anthropic），界面只给 Claude 别名
 *   scoped=false：网关是旧版，列表没按 token 过滤（可能列出这个 token 用不了的模型）
 */
export async function listGatewayModels({ force = false } = {}) {
  const gw = resolveGateway();
  if (!gw.baseUrl || !gw.apiKey) return { gateway: false, scoped: false, models: [] };
  const key = gw.baseUrl + '|' + gw.apiKey.slice(-6);
  if (!force && _cache && _cache.key === key && Date.now() - _cache.at < TTL) return annotateTime(_cache.value);
  let value;
  try {
    const r = await fetch(gw.baseUrl.replace(/\/+$/, '') + '/v1/models?scope=token', {
      headers: { 'x-api-key': gw.apiKey, Authorization: 'Bearer ' + gw.apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('网关返回 HTTP ' + r.status);
    const d = await r.json();
    const models = (Array.isArray(d.data) ? d.data : []).filter((x) => x && x.id).map((x) => ({
      id: String(x.id),
      name: String(x.display_name || x.id),
      provider: String(x.provider || ''),
      kind: x.kind === 'alias' ? 'alias' : 'model',
      target: x.target ? String(x.target) : '',
      caps: Array.isArray(x.capabilities) ? x.capabilities.map(String) : [],
      tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
      inputCost: typeof x.input_cost === 'number' ? x.input_cost : null,
      outputCost: typeof x.output_cost === 'number' ? x.output_cost : null,
      multiplier: typeof x.price_multiplier === 'number' ? x.price_multiplier : null,   // 渠道系数 K
      protocols: Array.isArray(x.protocols) ? x.protocols.map(String) : null,           // null = 网关没给（旧版）
      image: x.image && typeof x.image === 'object' ? x.image : null,                   // 出图参数（新网关：sizes / aspect_ratios / max_n …）
      perCall: x.per_call_price && typeof x.per_call_price === 'object' ? x.per_call_price : null,   // 按次价 {cny, credits}
    }));
    for (const m of models) m.fit = Object.fromEntries(['main', 'plan', 'subagent', 'vision'].map((k) => [k, sceneFit(k, m)]));
    // 时段计价规则（新网关）：原样留着，每次返回时按当前时间算哪条生效（见 annotateTime）
    (Array.isArray(d.data) ? d.data : []).forEach((x, i) => { if (models[i] && Array.isArray(x.time_pricing)) models[i].timeRules = x.time_pricing; });
    // 本 token 的额度（新网关才有）：用尽时会话页发消息前提醒
    const t = d.token && typeof d.token === 'object' ? d.token : null;
    const num = (v) => (typeof v === 'number' ? v : null);
    const token = t ? {
      name: t.name ? String(t.name) : '',
      dailyLimit: num(t.daily_credit_limit), dailyUsed: num(t.daily_credits_used),
      monthlyLimit: num(t.monthly_credit_limit), monthlyUsed: num(t.monthly_credits_used),
      expiresAt: t.expires_at ? String(t.expires_at) : null,
    } : null;
    value = { gateway: true, scoped: d.scope === 'token', models, token, periods: d.time_periods || null };
  } catch (e) {
    value = { gateway: true, scoped: false, models: [], error: e.message };
  }
  // 失败只缓存 1 分钟：网关临时抖动时别让列表空 10 分钟
  _cache = { at: value.error ? Date.now() - TTL + 60_000 : Date.now(), key, value };
  return annotateTime(value);
}

// ── 时段计价：哪条规则此刻生效（如「闲时 0.5x」），列表里显示成标签 ─────────────
// 规则格式见网关 pricing.TimeRule：period=peak/offpeak 引用全局忙闲时段（time_periods），
// 否则用自己的 start/end/days/timezone；End<=Start 跨零点、相等 = 全天；days 是 ISO 星期（1=周一）
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function nowIn(tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { hm: `${p.hour}:${p.minute}`, wd: WD[p.weekday] || 0 };
  } catch { return null; }
}
function inWindow(w, tz) {
  const n = nowIn(tz); if (!n || !w?.start) return false;
  const s = w.start, e = w.end || w.start, days = Array.isArray(w.days) && w.days.length ? w.days : null;
  const dayOk = (d) => !days || days.includes(d);
  if (s === e) return dayOk(n.wd);
  if (s < e) return n.hm >= s && n.hm < e && dayOk(n.wd);
  return (n.hm >= s && dayOk(n.wd)) || (n.hm < e && dayOk(n.wd === 1 ? 7 : n.wd - 1));   // 跨零点：零点后算前一天的窗口
}
function annotateTime(value) {
  if (!value?.models) return value;
  const periods = value.periods || {};
  const models = value.models.map((m) => {
    if (!m.timeRules?.length) return m;
    for (const r of m.timeRules) {
      const wins = r.period ? (periods[r.period === 'offpeak' ? 'offpeak' : 'peak'] || []) : [r];
      const tz = r.period ? periods.timezone : r.timezone;
      if (wins.some((w) => inWindow(w, tz))) {
        const label = r.label || (r.period === 'offpeak' ? '闲时' : r.period === 'peak' ? '忙时' : '时段价');
        return { ...m, timeNow: { label, multiplier: typeof r.multiplier === 'number' ? r.multiplier : null } };
      }
    }
    return m;
  });
  return { ...value, models };
}

// ── 看图：主模型看不了图时，先用「看图」场景模型把图片转成文字 ─────────────────
// Claude Code 把图片原样发给网关，网关原样转给厂商；纯文字模型收到图片会被厂商换成 URL / 占位文字，
// AI 就「看不到」。这里在 myhi 侧补一刀：发给主模型前，用能看图的模型先描述一遍。

const wildRe = (id) => new RegExp('^' + id.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
/**
 * 某个模型能不能看图 → true / false / null（不知道：网关没给能力信息、目录里找不到）
 *   id 为空 = Claude Code 默认模型（按 opus 查，网关常把 claude-* 映射到别的模型）
 *   别名没给能力时按它指向的 target 查
 */
export async function modelSeesImages(id) {
  const { models = [] } = await listGatewayModels();
  if (!models.length) return null;
  const cands = id ? [id] : ['opus', 'claude-opus-5-5'];
  const find = (x) => models.find((m) => m.id === x) || models.find((m) => m.id.includes('*') && wildRe(m.id).test(x));
  for (const c of cands) {
    let m = find(c);
    if (m && !m.caps?.length && m.kind === 'alias' && m.target) m = find(m.target) || m;
    if (m?.caps?.length) return m.caps.includes('vision');
  }
  return null;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMG = 5 * 1024 * 1024;   // 单图上限（上传时已压到长边 ≤1568px，正常远小于此）
const _descCache = new Map();      // 同一张图 + 同一问题 + 同一模型 → 不重复花钱（最多留 100 条）
// 以下参数按本地看图模型（vllm-mlx 部署）的实测：
//   vllm-mlx 的带图请求在引擎里是串行的（同一时刻只看 1 张；--max-num-seqs 只管纯文本），
//   服务端设了 VLLM_MLX_SIMPLE_ENGINE_LOCK_ADMISSION=wait → 超额请求排队而不是立刻 503；网关侧该账号并发设为 1
const VISION_TIMEOUT = 180_000;    // 单次 ≥180s：小图 9~15s，1080p 密集图 35~65s，留足余量
const VISION_MAX_TOKENS = 1500;    // 转述场景 800~1500 够用
const RETRY_DELAYS = [5000, 15000]; // 503 = 网关排队超时 / 服务重启中：退避重试 2 次
// 每个模型各自排队：日常看图模型（如本地部署的）一次只发 1 张，与它的串行处理对齐，超时只算真正处理的时间；
// 其它（「看图·高精度」的云端模型）可以并行
const visionLimit = (model) => (model === sceneModel('vision') ? 1 : 3);

// 看图提示词：先判图型，再按对应框架输出（截图 / 非截图双分支）
//   截图分支逐字保留指南 §2 实测调优版（不能只说「把图片转成文字」——会丢掉红框 / 箭头 / 高亮这些标注）；
//   非截图分支（照片 / 插画 / 实物 / 图表）与看图服务分流器的兜底同构——以前一律当截图问，照片会答出「无界面内容」。
//   单提示词自适应、一次调用；也覆盖不走本地看图服务的通道（如「看图·高精度」直连云端模型）
const VISION_PROMPT = (q) => `请先判断这张图片的类型，再按对应框架回答：

【若为软件截图 / 界面图】
1) 界面内容：应用/页面名、控件与关键文字（报错信息、日志、代码、数据值逐项列出，保持原文）；
2) 标注描述：图中是否有红框/箭头/高亮/手写文字？分别是什么内容；红字标注的原文；
3) 综合判断：结合界面内容和标注，用户想指出/报告什么问题？

【若为照片 / 插画 / 实物图 / 图表等非界面图】
1) 图片类型：照片/插画/实物图/图表等；
2) 画面描述：详细描述主体、景物、颜色、构图、氛围（不少于 3 句）；
3) 与用户诉求的关系：结合用户发图时说的话，说明这张图的可能用途。

用中文，结构化输出，不要寒暄。` + (q ? `
用户发这张图时说的是：「${q}」——和它相关的内容写得更仔细。` : '');

// 并发闸：按模型分开（整个 myhi 共用，多个任务 / 多人同时发图也在这里排队）
const _lanes = new Map();   // model → { running, queue: [] }
const lane = (model) => { if (!_lanes.has(model)) _lanes.set(model, { running: 0, queue: [] }); return _lanes.get(model); };
/** 这个模型此刻在看 + 在排队的图片数（给「前面还有几张」的提示用） */
export function visionBacklog(model) { const l = _lanes.get(model); return l ? l.running + l.queue.length : 0; }
async function visionSlot(model, signal) {
  const l = lane(model);
  if (l.running < visionLimit(model)) { l.running++; return; }
  await new Promise((resolve, reject) => {
    const item = { resolve, reject };
    l.queue.push(item);
    signal?.addEventListener('abort', () => { const k = l.queue.indexOf(item); if (k >= 0) { l.queue.splice(k, 1); reject(signal.reason || new Error('aborted')); } }, { once: true });
  });
}
function visionRelease(model) { const l = lane(model); const next = l.queue.shift(); if (next) next.resolve(); else l.running--; }
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

// 网关错误 → 用户看得懂的说明（指南 §6 故障速查）
function visionError(status, msg, model) {
  const m = String(msg || '');
  if (status === 503) return new Error(`看图模型 ${model} 暂时不可用（网关排队超时，或模型服务在重启），重试后仍不行，请稍后再发；频繁出现请让网关管理员检查该账号的队列超时（应 ≥180 秒）`);
  if (status === 403 || /no available account/i.test(m)) return new Error(`网关 token 没有绑定 ${model} 的账号组，请找网关管理员绑定`);
  if (status === 404 || /model.*not.*(found|exist)/i.test(m)) return new Error(`网关上找不到模型 ${model}，检查 系统设置 · 模型 › 看图 填的名字`);
  if (status === 401) return new Error('网关拒绝了 token（401），检查网关 Key');
  return new Error(m || ('网关返回 HTTP ' + status));
}

// 记住每个看图模型实际走得通的接口格式：openai（/v1/chat/completions + image_url）或 anthropic（/v1/messages）
const _protoOk = new Map();
async function protoOrder(model) {
  if (_protoOk.has(model)) return [_protoOk.get(model)];
  let protos = null;
  try { protos = (await listGatewayModels()).models?.find((m) => m.id === model)?.protocols || null; } catch {}
  // 目录标了只走某一种就只用它；没标（或两种都行）按指南优先 OpenAI 兼容格式，不通再换另一种
  if (protos?.length === 1 && ['openai', 'anthropic'].includes(protos[0])) return [protos[0]];
  return protos && !protos.includes('openai') && protos.includes('anthropic') ? ['anthropic', 'openai'] : ['openai', 'anthropic'];
}
async function callVision(proto, gw, { model, mime, b64, prompt, signal, maxTokens = VISION_MAX_TOKENS }) {
  const base = gw.baseUrl.replace(/\/+$/, '');
  const timeout = AbortSignal.timeout(VISION_TIMEOUT);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const req = proto === 'openai'
    ? { url: base + '/v1/chat/completions', body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }] } }
    : { url: base + '/v1/messages', body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }, { type: 'text', text: prompt }] }] } };
  let r;
  try {
    r = await fetch(req.url, {
      method: 'POST', signal: sig, body: JSON.stringify(req.body),
      headers: { 'content-type': 'application/json', 'x-api-key': gw.apiKey, Authorization: 'Bearer ' + gw.apiKey, 'anthropic-version': '2023-06-01' },
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timeout.aborted) throw new Error(`看图模型 ${model} 超过 ${VISION_TIMEOUT / 1000} 秒没有回应（图太大或服务在重启），稍后再试`);
    throw new Error('连不上网关：' + e.message);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = visionError(r.status, d?.error?.message || d?.message, model); e.status = r.status; throw e; }
  let text = proto === 'openai'
    ? (() => { const c = d.choices?.[0]?.message?.content; return Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : String(c || ''); })()
    : (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();   // 万一模型带思考标签
  if (!text) throw new Error(`看图模型 ${model} 没有返回内容`);
  return text;
}

/**
 * 让看图模型看一张图、按 prompt 回答 → 文字。排队（按模型）、503 退避重试、接口格式自动选（同 describeImage）。
 * 出图质检（studio.js）也用它：buf 是图片内容，mime 如 image/png
 */
export async function askVision({ buf, mime = 'image/png', prompt, model, signal, maxTokens }) {
  const gw = resolveGateway();
  if (!gw.baseUrl || !gw.apiKey) throw new Error('没配网关');
  if (!model) throw new Error('没有配置看图模型');
  const args = { model, mime, b64: Buffer.from(buf).toString('base64'), prompt, signal, maxTokens };
  await visionSlot(model, signal);
  try {
    let firstErr = null;
    for (const proto of await protoOrder(model)) {
      for (let attempt = 0; ; attempt++) {
        try {
          const text = await callVision(proto, gw, args);
          _protoOk.set(model, proto);
          return text;
        } catch (e) {
          if (signal?.aborted) throw e;
          if (e.status === 503 && attempt < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[attempt], signal); continue; }
          // 接口格式不对（这条路由不存在 / 请求体不认）→ 换另一种格式再试；其它错误直接报
          if ([400, 404, 405, 415, 422].includes(e.status) && !firstErr) { firstErr = e; break; }
          throw firstErr && e.status ? firstErr : e;
        }
      }
    }
    throw firstErr || new Error('看图失败');
  } finally { visionRelease(model); }
}

/** 用 model 描述一张图 → 文字；signal 可中途取消。按指南：限并发、503 退避重试、接口格式自动选 */
export async function describeImage(path, { model, question = '', signal } = {}) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error('不支持的图片格式');
  if (statSync(path).size > MAX_IMG) throw new Error('图片超过 5MB');
  const buf = readFileSync(path);
  const key = createHash('sha1').update(buf).update('\0' + model + '\0' + question).digest('hex');
  if (_descCache.has(key)) return _descCache.get(key);
  const text = await askVision({ buf, mime, prompt: VISION_PROMPT(question), model, signal });
  _descCache.set(key, text);
  if (_descCache.size > 100) _descCache.delete(_descCache.keys().next().value);
  return text;
}
