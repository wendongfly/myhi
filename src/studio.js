// ---------------------------------------------------------------------------
// 出图（/studio）：填需求 → 云端出图 → 质检（文字比对 + 看图复核）→ 不合格自动重生成
//   流水线全在 myhi 服务端（不经 Claude、不耗对话 token），所有调用都经大模型网关（只认网关 token）：
//     出图   POST /v1/images/generations（OpenAI 兼容的出图接口，见 docs/gateway-api.md）
//            网关还没有这个接口 → 退回 POST /v1/chat/completions 调 glm-image（content 里是图片 URL）
//     OCR    POST /v1/ocr（网关代理的 OCR 服务，可选）；网关还没有 → 跳过这一步
//     复核   看图模型（场景「看图」，如本地部署的看图模型）经 askVision（排队、503 重试、接口格式自动选）
//   每张图最多 3 次：不合格把具体问题写回提示词重生成；3 次都不合格交付最像样的一张，标「需人工确认」。
//   记录存 ~/.myhi/studio/<日期>/<任务号>/（job.json + 图片）；可选「保存到项目」= 复制进项目的 出图/<日期>/。
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, statSync } from 'fs';
import { removeJobDir, purgeOlderThan } from './history-gc.js';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { resolveGateway, listGatewayModels, sceneModel, askVision } from './models.js';

const MAX_ATTEMPTS = 3;
const MAX_N = 4;
const GEN_TIMEOUT = 200_000;     // 网关对上游最长等 180 秒，客户端留余量
const studioRoot = () => join(homedir(), '.myhi', 'studio');
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── 网关调用 ────────────────────────────────────────────────────────────────
async function gwPost(path, body, { signal, timeout = GEN_TIMEOUT } = {}) {
  const gw = resolveGateway();
  if (!gw.baseUrl || !gw.apiKey) { const e = new Error('没有配置大模型网关（首页 ⚙ 设置 › 大模型网关）'); e.code = 'no_gateway'; throw e; }
  const t = AbortSignal.timeout(timeout);
  let r;
  try {
    r = await fetch(gw.baseUrl.replace(/\/+$/, '') + path, {
      method: 'POST', signal: signal ? AbortSignal.any([signal, t]) : t, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-api-key': gw.apiKey, Authorization: 'Bearer ' + gw.apiKey, 'anthropic-version': '2023-06-01' },
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    const err = new Error(t.aborted ? `网关超过 ${Math.round(timeout / 1000)} 秒没有回应` : '连不上网关：' + e.message);
    err.code = t.aborted ? 'upstream_timeout' : 'network';
    throw err;
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d?.error?.message || d?.message || ('网关返回 HTTP ' + r.status));
    e.status = r.status; e.code = d?.error?.code || '';
    const ra = parseInt(r.headers.get('retry-after') || '', 10); if (ra > 0) e.retryAfter = Math.min(ra, 120);
    if (HINT[e.code] && !e.message.includes('管理员')) e.message += HINT[e.code];
    throw e;
  }
  return d;
}
// 错误码见《myhi 对接说明：出图 + OCR + 看图复核》：message 是中文，可直接展示；这里只补「该找谁」
const HINT = {
  invalid_token: '（检查首页 ⚙ 设置 › 大模型网关 的 token）',
  model_not_allowed: '（myhi 的网关 token 没绑对应账号组，请联系网关管理员）',
  no_account: '（请稍后再试，或联系网关管理员）',
  insufficient_credits: '（网关 token 今日 / 本月积分不够了）',
};
// 出不来图时：哪些错误重试也没用（直接停），哪些值得退避后再试一次
const FATAL = new Set(['content_policy_violation', 'invalid_request', 'no_gateway', 'invalid_token', 'model_not_allowed', 'model_not_image', 'insufficient_credits', 'no_account']);
const isFatal = (e) => FATAL.has(e.code) || [400, 401, 402, 403].includes(e.status);
const isTransient = (e) => e.code === 'rate_limited' || e.code === 'upstream_error' || e.code === 'upstream_timeout' || e.code === 'network' || [429, 502, 504].includes(e.status);
const sleep = (ms, signal) => new Promise((ok, no) => { const t = setTimeout(ok, ms); signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason || new Error('已取消')); }, { once: true }); });
const routeMissing = (e) => e.status === 404 || e.status === 405;
// 网关有没有新接口：没有就记 10 分钟，期间直接走退路（网关升级后自动切回）
const _api = { images: { ok: null, at: 0 }, ocr: { ok: null, at: 0 } };
const apiKnownMissing = (k) => _api[k].ok === false && Date.now() - _api[k].at < 600_000;
const markApi = (k, ok) => { _api[k] = { ok, at: Date.now() }; };

async function download(url, signal) {
  const t = AbortSignal.timeout(60_000);
  const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, t]) : t });
  if (!r.ok) throw new Error('下载图片失败（HTTP ' + r.status + '）');
  return { buf: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get('content-type') || 'image/png').split(';')[0] };
}
const sniffMime = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf[0] === 0x52 && buf[8] === 0x57 ? 'image/webp' : 'image/png');

/** 出一张图 → { buf, mime, credits, via } */
async function generateOne({ model, prompt, size, variant, signal, perCall, refImage = null, user = null }) {
  if (!apiKnownMissing('images')) {
    const body = { model, prompt, n: 1, response_format: 'b64_json' };
    if (user) body.user = 'myhi:' + user;   // 网关日志里能看出是谁出的图
    if (variant) body.extra = { area: variant };   // 按档位计价的模型（MiniMax-H3-Image 1K / 2K / 4K）
    if (refImage) body.image = refImage;   // 参考图（data URI）：只发给模型目录标了 reference_image 的模型（人像主体参考）
    if (size?.startsWith('ratio:')) body.aspect_ratio = size.slice(6); else if (size) body.size = size;
    try {
      const d = await gwPost('/v1/images/generations', body, { signal });
      markApi('images', true);
      const it = (d.data || [])[0];
      if (!it) {
        const f = (d.failed || [])[0];
        const e = new Error(f?.message || '网关没有返回图片'); e.code = f?.code || 'upstream_error'; throw e;
      }
      const img = it.b64_json ? { buf: Buffer.from(it.b64_json, 'base64') } : await download(it.url, signal);
      return { buf: img.buf, mime: it.mime_type || img.mime || sniffMime(img.buf), credits: d.usage?.credits ?? perCall ?? null, via: 'images' };
    } catch (e) {
      if (!routeMissing(e) || e.code === 'model_not_image') throw e;
      markApi('images', false);   // 网关还没有出图接口 → 走对话接口
    }
  }
  // 退路：对话接口调出图模型（如 glm-image：content 返回图片 URL），尺寸选项用不上
  const d = await gwPost('/v1/chat/completions', { model, stream: false, messages: [{ role: 'user', content: prompt }] }, { signal });
  const c = d.choices?.[0]?.message?.content;
  const urls = [];
  const pick = (x) => {
    if (!x) return;
    if (typeof x === 'string') { for (const m of x.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) urls.push(m[0]); return; }
    if (Array.isArray(x)) return x.forEach(pick);
    if (typeof x === 'object') { if (typeof x.url === 'string') urls.push(x.url); if (x.image_url) pick(x.image_url); if (x.b64_json) urls.push('b64:' + x.b64_json); }
  };
  pick(c);
  if (!urls.length) { const e = new Error('模型没有返回图片：' + String(typeof c === 'string' ? c : JSON.stringify(c) || '').slice(0, 120)); e.code = 'upstream_error'; throw e; }
  const img = urls[0].startsWith('b64:') ? { buf: Buffer.from(urls[0].slice(4), 'base64') } : await download(urls[0], signal);
  return { buf: img.buf, mime: img.mime || sniffMime(img.buf), credits: perCall ?? null, via: 'chat' };
}

async function generateRetry(opts) {
  for (let i = 0; ; i++) {
    try { return await generateOne(opts); }
    catch (e) {
      if (opts.signal?.aborted || isFatal(e) || !isTransient(e)) throw e;
      const limit = e.code === 'rate_limited' || e.status === 429 ? 2 : 1;
      if (i >= limit) throw e;
      opts.onWait?.(e);
      await sleep((e.retryAfter || (i ? 20 : 8)) * 1000, opts.signal);
    }
  }
}

/** OCR → { text } | null（网关没有 OCR 接口）| { error } */
async function ocrImage(buf, mime, signal) {
  if (apiKnownMissing('ocr')) return null;
  try {
    const d = await gwPost('/v1/ocr', { image: `data:${mime};base64,${buf.toString('base64')}` }, { signal, timeout: 40_000 });
    markApi('ocr', true);
    return { text: ocrText(d) };
  } catch (e) {
    if (signal?.aborted) throw e;
    if (routeMissing(e)) { markApi('ocr', false); return null; }
    if (isTransient(e)) {   // 502 / 504：退避后再试 1 次
      try { await sleep(3000, signal); return { text: ocrText(await gwPost('/v1/ocr', { image: `data:${mime};base64,${buf.toString('base64')}` }, { signal, timeout: 40_000 })) }; }
      catch (e2) { if (signal?.aborted) throw e2; return { error: e2.message, code: e2.code }; }
    }
    return { error: e.status === 413 ? 'OCR：图片超过 10 MB' : e.message, code: e.code };
  }
}
// OCR 响应：兼容两种格式 {lines:[{text,score,box}], full_text} 与 {text, lines:[{text,confidence}]}
//   都没有就把 lines / words / result 里的文字收起来兜底
function ocrText(d) {
  if (typeof d?.text === 'string') return d.text;
  if (typeof d?.full_text === 'string') return d.full_text;
  if (Array.isArray(d?.lines) && d.lines.every((l) => typeof l?.text === 'string')) return d.lines.map((l) => l.text).join('\n');
  const out = [];
  const walk = (x, k) => {
    if (typeof x === 'string') { if (['text', 'words', 'content', 'transcription', 'result'].includes(k)) out.push(x); return; }
    if (Array.isArray(x)) return x.forEach((v) => walk(v, k));
    if (x && typeof x === 'object') for (const [kk, v] of Object.entries(x)) walk(v, kk);
  };
  walk(d, '');
  return out.join('\n');
}

// ── 文字比对：去掉空白 / 标点后逐字找；找不到给一个相似度（近似子串编辑距离）──────────
const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
function substrSimilarity(needle, hay) {
  const n = needle.length, m = hay.length;
  if (!n) return 1;
  if (!m) return 0;
  let prev = new Array(m + 1).fill(0), cur = new Array(m + 1);   // 半全局对齐：在 hay 任意位置开始 / 结束
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return Math.max(0, 1 - Math.min(...prev) / n);
}
export function checkTexts(required, ocr) {
  const hay = norm(ocr);
  return required.map((t) => {
    const n = norm(t);
    if (!n) return null;
    const exact = hay.includes(n);
    return { text: t, ok: exact, score: exact ? 1 : Math.round(substrSimilarity(n, hay) * 100) / 100 };
  }).filter(Boolean);
}

// ── 看图复核 ────────────────────────────────────────────────────────────────
const QC_PROMPT = (need, texts, refDesc = '') => `你是出图质检员。请仔细看这张图，判断它是否符合下面的出图需求，只输出一个 JSON，不要其它内容：
{"pass": true 或 false, "text_ok": true 或 false, "issues": ["具体问题"], "seen_text": "图中能看清的文字，原样转写"}
判断标准：
1. 必须出现的文字逐字正确、清晰可读：没有错字、漏字、多字、乱码；${texts.length ? '' : '（本次没有必须出现的文字，text_ok 填 true）'}
2. 画面符合需求：主体、风格、用途对得上；
3. 没有明显畸形、没有多余的错误文字、没有不当内容。
issues 用中文写具体问题，例如「"5 折"写成了"S 折"」「背景不是红色」；没有问题时为空数组。
出图需求：${need}
必须出现的文字：${texts.length ? texts.map((t) => `「${t}」`).join('、') : '无'}${refDesc ? `
需要模仿的参考图要点（画面应接近这些要点，差得明显算不合格）：${refDesc}` : ''}`;
function parseQC(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); return { pass: !!j.pass, textOk: j.text_ok !== false, issues: Array.isArray(j.issues) ? j.issues.map(String).filter(Boolean) : [], seenText: String(j.seen_text || '') }; } catch {} }
  const pass = /"?pass"?\s*[:：]\s*true/i.test(raw);
  return { pass, textOk: pass, issues: pass ? [] : [String(raw || '看图模型没有给出结论').slice(0, 200)], seenText: '' };
}

// ── 提示词 ──────────────────────────────────────────────────────────────────
async function refinePrompt({ need, style, texts, signal }) {
  const model = sceneModel('ask');
  if (!model) return null;
  try {
    const d = await gwPost('/v1/chat/completions', {
      model, stream: false, max_tokens: 600,
      messages: [{ role: 'user', content: `把下面的业务需求改写成一段给文生图模型的中文提示词：写清主体、场景、构图、色彩、风格、光线，适合直接出图。只输出提示词本身，不要解释，不超过 300 字。不要改动或增加需要出现的文字（myhi 会另外附上）。\n需求：${need}${style ? '\n风格 / 用途：' + style : ''}` }],
    }, { signal, timeout: 60_000 });
    const t = String(d.choices?.[0]?.message?.content || '').trim();
    return t ? t.slice(0, 800) : null;
  } catch (e) { if (signal?.aborted) throw e; return null; }
}
function buildPrompt(base, texts, issues, maxChars = 0) {
  let tail = '';
  if (texts.length) tail += `\n画面中需要清晰、准确地出现以下文字（逐字一致，不要错字漏字，不要添加其它文字）：${texts.map((t) => `「${t}」`).join('')}`;
  if (issues?.length) tail += `\n上一次出图的问题：${issues.join('；')}。这次请避免这些问题。`;
  const len = (s) => [...s].length;
  if (maxChars && len(base) + len(tail) > maxChars) {
    if (len(tail) > maxChars * 0.6) tail = [...tail].slice(0, Math.floor(maxChars * 0.6)).join('');
    base = [...base].slice(0, Math.max(50, maxChars - len(tail) - 1)).join('') + '…';
  }
  return base + tail;
}

// ── 任务 ────────────────────────────────────────────────────────────────────
const _jobs = new Map();   // id → job（运行中 + 最近的）；历史从磁盘读
const jobDir = (job) => join(studioRoot(), job.day, job.id);
function save(job) {
  if (job.deleted) return;   // 已删除：后台流水线收尾时别再把目录建回来
  try { mkdirSync(jobDir(job), { recursive: true }); writeFileSync(join(jobDir(job), 'job.json'), JSON.stringify(publicJob(job), null, 2)); } catch {}
}
export function publicJob(job) { const { ac, ...rest } = job; return rest; }

/** 出图能用的模型 + 尺寸 + 看图 / OCR 状态（页面初始化用） */
export async function studioConfig() {
  const g = await listGatewayModels();
  const isImage = (m) => (m.caps || []).includes('image_generation') || !!m.image
    || (/(^|[-_/.])(image|cogview|seedream|seededit|wanx|flux|dall-e|jimeng)/i.test(m.id) && !/vision|[-_]vl\b|ocr/i.test(m.id));
  const models = (g.models || []).filter((m) => !m.id.includes('*') && isImage(m)).map((m) => ({
    id: m.id, name: m.name, provider: m.provider,
    sizes: imageSizes(m), maxN: Math.min(MAX_N, m.image?.max_n || MAX_N),
    price: m.perCall ? (m.perCall.credits ?? null) : null, priceCny: m.perCall?.cny ?? null,
    promptMax: m.image?.prompt_max_chars || null, seconds: m.image?.typical_seconds || null,
    refImage: m.image?.reference_image === true || (m.caps || []).includes('image_to_image'),   // 网关标了支持参考图（MiniMax image-01：人像主体参考）
    variants: Array.isArray(m.image?.variants) ? m.image.variants : [], defaultVariant: m.image?.default_variant || '',
  }));
  return {
    gateway: g.gateway, error: g.error || null, models,
    defaultModel: sceneModel('image') || models[0]?.id || '',
    visionModel: sceneModel('vision') || '', refineModel: sceneModel('ask') || '',
    imagesApi: _api.images.ok, ocrApi: _api.ocr.ok,
    token: g.token || null, maxAttempts: MAX_ATTEMPTS,
  };
}
const RATIO_USE = new Proxy({ '1:1': '（方图 / 头像）', '16:9': '（横幅 / PPT）', '9:16': '（手机海报 / 竖屏）', '3:4': '（海报 / 小红书）', '4:3': '（横图）', '2:3': '（竖版海报）', '3:2': '（横版照片）', '21:9': '（超宽横幅）' }, { get: (t, k) => t[k] || '' });
function imageSizes(m) {
  if (m.image?.sizes?.length || m.image?.aspect_ratios?.length) {
    // 比例在前（业务同事好懂，网关换算到最接近的推荐尺寸），精确像素在后；默认尺寸排第一
    const sizes = [...(m.image.sizes || [])].sort((a, b) => (b === m.image.default_size) - (a === m.image.default_size));
    return [...(m.image.aspect_ratios || []).map((r) => ({ value: 'ratio:' + r, label: '比例 ' + r + RATIO_USE[r] })), ...sizes.map((s) => ({ value: s, label: s + (s === m.image.default_size ? '（默认）' : '') }))];
  }
  if (/glm-image/i.test(m.id)) return ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728'].map((s) => ({ value: s, label: s }));
  if (/cogview/i.test(m.id)) return ['1024x1024', '1344x768', '768x1344', '1152x864', '864x1152', '1440x720', '720x1440'].map((s) => ({ value: s, label: s }));
  if (/^image-01/i.test(m.id)) return ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'].map((r) => ({ value: 'ratio:' + r, label: '比例 ' + r }));
  return ['1024x1024', '1344x768', '768x1344'].map((s) => ({ value: s, label: s }));
}

/** 开始一次出图。返回 job（立即返回，流水线在后台跑；页面轮询 getJob） */
export async function startJob(input, { owner = null } = {}) {
  const need = String(input.need || '').trim().slice(0, 2000);
  if (!need) throw new Error('请填写出图需求');
  const texts = (Array.isArray(input.texts) ? input.texts : String(input.texts || '').split('\n')).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
  const cfg = await studioConfig();
  const model = String(input.model || cfg.defaultModel || '').trim();
  if (!model) throw new Error('网关上没有可用的出图模型（需要网关开通 glm-image / cogview / image-01 等）');
  const m = cfg.models.find((x) => x.id === model);
  const n = Math.max(1, Math.min(m?.maxN || MAX_N, parseInt(input.n, 10) || 1));
  const id = Date.now().toString(36) + randomBytes(3).toString('hex');
  // 参考图：data URI，≤ 8MB；模仿什么：style 风格配色 / layout 构图版式 / all 整体
  let ref = null;
  if (input.refImage) {
    const mm = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(input.refImage));
    if (!mm) throw new Error('参考图格式不对（支持 png / jpg / webp）');
    const buf = Buffer.from(mm[3], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw new Error('参考图超过 8MB');
    const mode = ['style', 'layout', 'all', 'person'].includes(input.refMode) ? input.refMode : 'all';
    // 直接带图只在「人像」模式：网关的参考图是 MiniMax 人像主体参考（保持人物样貌），模仿海报风格 / 版式它做不到，走看图拆要点
    ref = { file: 'ref.' + (mm[2] === 'jpeg' ? 'jpg' : mm[2]), mime: mm[1], mode, desc: '', direct: mode === 'person' && !!m?.refImage && mm[1] !== 'image/webp', _buf: buf };
  }
  const job = {
    id, day: day(), owner, createdAt: new Date().toISOString(), status: 'running',
    need, texts, style: String(input.style || '').trim().slice(0, 200), model, size: String(input.size || '').trim(), n,
    variant: m?.variants?.includes(input.variant) ? input.variant : '', promptMax: m?.promptMax || 0,
    refine: input.refine !== false, saveTo: input.saveTo || null, savedTo: [],
    visionModel: cfg.visionModel || null, prompt: '', credits: 0, notes: [], ref,
    slots: Array.from({ length: n }, (_, i) => ({ index: i, status: 'queued', attempts: [], best: null, verdict: null })),
    ac: new AbortController(),
  };
  _jobs.set(id, job);
  if (ref) { mkdirSync(jobDir(job), { recursive: true }); writeFileSync(join(jobDir(job), ref.file), ref._buf); delete ref._buf; }
  save(job);
  run(job, m).catch((e) => { job.status = job.ac.signal.aborted ? 'cancelled' : 'error'; job.error = e.message; save(job); });
  return job;
}

async function run(job, m) {
  const signal = job.ac.signal;
  const perCall = m?.price ?? null;
  if (job.ref) {
    if (job.ref.mode === 'person' && !job.ref.direct) job.notes.push('「保持人物样貌」需要支持人像参考图的出图模型（如 image-01）；当前模型只能按看图描述去模仿，人物不会完全一样');
    if (job.visionModel && !job.ref.direct) {
      job.stage = '分析参考图…'; save(job);
      try {
        const buf = readFileSync(join(jobDir(job), job.ref.file));
        job.ref.desc = String(await askVision({ buf, mime: job.ref.mime, prompt: REF_PROMPT[job.ref.mode], model: job.visionModel, signal, maxTokens: 700 })).trim().slice(0, 1200);
      } catch (e) { if (signal.aborted) return; job.notes.push('分析参考图失败：' + e.message); }
    } else if (!job.ref.direct) job.notes.push('没有配置「看图」模型，也没有支持参考图的出图模型：参考图没有用上');
    job.stage = ''; save(job);
  }
  const refPart = job.ref?.desc ? `\n参照下面这张参考图${REF_LABEL[job.ref.mode]}来做：\n${job.ref.desc}` : '';
  job.prompt = (job.refine && await refinePrompt({ need: job.need + refPart, style: job.style, texts: job.texts, signal })) || (job.need + (job.style ? `\n风格 / 用途：${job.style}` : '') + refPart);
  if (!job.visionModel) job.notes.push('没有配置「看图」模型，跳过看图复核（首页 ⚙ 设置 › 系统设置 · 模型 › 看图）');
  save(job);
  await Promise.all(job.slots.map((slot) => runSlot(job, slot, perCall, signal)));
  if (signal.aborted) { job.status = 'cancelled'; save(job); return; }
  job.status = 'done';
  if (_api.ocr.ok === false && !job.notes.some((x) => x.includes('OCR'))) job.notes.push('网关还没有 OCR 接口，本次没做 OCR 比对，文字由看图模型核对');
  if (_api.images.ok === false) job.notes.push('网关还没有出图接口，本次经对话接口出图，尺寸选项未生效');
  if (job.saveTo) { try { saveToProject(job, job.saveTo); } catch (e) { job.notes.push('保存到项目失败：' + e.message); } }
  save(job);
}

// ── 参考图：让看图模型按「模仿什么」把参考图拆成文字要点，写进出图提示词、也给复核对照 ──
const REF_LABEL = { style: '的风格和配色', layout: '的构图和版式', all: '（风格、配色、构图都照着）', person: '中的人物（保持样貌）' };
const REF_PROMPT = {
  style: '请分析这张参考图的视觉风格，用于让文生图模型模仿：画风 / 艺术风格、配色（主色和辅色，尽量写出具体颜色）、光线与质感、字体风格（如有文字）、整体氛围。不要描述具体画了什么东西。用中文要点式，150 字以内，只输出要点。',
  layout: '请分析这张参考图的版式构图，用于让文生图模型模仿：画幅方向、主体的位置与大小、文字区域的位置和层级（大标题 / 副标题 / 角标等）、留白、各元素怎么排布。不要描述颜色和画风。用中文要点式，150 字以内，只输出要点。',
  person: '请描述这张参考图里的主要人物，用于让文生图模型画出同一个人：性别、大致年龄、脸型五官、发型发色、肤色、体型、穿着打扮、神态。不要描述背景。用中文要点式，150 字以内，只输出要点。',
  all: '请完整描述这张参考图，用于让文生图模型做一张很像的新图：版式构图、画风、配色（写出具体颜色）、主体和元素、文字区域的位置与层级（文字内容会换掉，不用逐字转写）、整体氛围。用中文要点式，250 字以内，只输出要点。',
};
function refDataUri(job) {
  try { return `data:${job.ref.mime};base64,${readFileSync(join(jobDir(job), job.ref.file)).toString('base64')}`; } catch { return null; }
}

async function runSlot(job, slot, perCall, signal) {
  const ocrOff = (o) => o?.code === 'model_not_allowed' || o?.code === 'no_account' || o?.code === 'invalid_token';
  let issues = null;
  for (let k = 1; k <= MAX_ATTEMPTS; k++) {
    if (signal.aborted) return;
    const at = { n: k, file: null, prompt: buildPrompt(job.prompt, job.texts, issues, job.promptMax), ocr: null, vision: null, verdict: null, error: null, credits: null, ms: 0 };
    slot.attempts.push(at);
    const t0 = Date.now();
    try {
      slot.status = k === 1 ? 'generating' : 'retrying'; save(job);
      const img = await generateRetry({ model: job.model, prompt: at.prompt, size: job.size, variant: job.variant, signal, perCall, user: job.owner,
        refImage: job.ref?.direct ? refDataUri(job) : null, onWait: (e) => { slot.status = 'waiting'; at.wait = e.message; save(job); } });
      delete at.wait;
      const ext = img.mime.includes('jpeg') ? 'jpg' : img.mime.includes('webp') ? 'webp' : 'png';
      at.file = `img-${slot.index + 1}-${k}.${ext}`;
      mkdirSync(jobDir(job), { recursive: true });
      writeFileSync(join(jobDir(job), at.file), img.buf);
      at.credits = img.credits; if (img.credits) job.credits = Math.round((job.credits + img.credits) * 100) / 100;
      // ① OCR 比对（有必须出现的文字、网关有 OCR 接口时）
      let ocrBad = false;
      if (job.texts.length && !job.ocrOff) {
        slot.status = 'ocr'; save(job);
        const o = await ocrImage(img.buf, img.mime, signal);
        if (ocrOff(o)) { if (!job.ocrOff) job.notes.push('OCR 用不了：' + o.error + '。本次文字由看图模型核对'); job.ocrOff = true; }
        if (o?.text != null) {
          const checks = checkTexts(job.texts, o.text);
          at.ocr = { text: o.text.slice(0, 2000), checks };
          ocrBad = checks.some((c) => !c.ok);
        } else if (o?.error && !ocrOff(o)) at.ocr = { error: o.error };
      }
      // OCR 明显不对（相似度低于 0.8）就不浪费看图模型的时间，直接重来
      const hardFail = ocrBad && at.ocr.checks.some((c) => c.score < 0.8);
      // ② 看图复核（串行、慢：只对 OCR 过关或差一点的图做）
      if (!hardFail && job.visionModel) {
        slot.status = 'vision'; save(job);
        try {
          const raw = await askVision({ buf: img.buf, mime: img.mime, prompt: QC_PROMPT(job.need + (job.style ? `（${job.style}）` : ''), job.texts, job.ref?.desc || ''), model: job.visionModel, signal, maxTokens: 800 });
          at.vision = parseQC(raw);
        } catch (e) { if (signal.aborted) return; at.vision = { error: e.message }; }
      }
      // ③ 结论：OCR 全对（或 OCR 差一点但看图确认文字无误）且看图通过
      //    看图没做成（没配 / 出错）且没有 OCR 结果 = 「未质检」，不算合格
      const vOk = at.vision ? (at.vision.error ? null : at.vision.pass) : null;
      const textOk = !job.texts.length || (at.ocr?.checks ? (!ocrBad || (!hardFail && at.vision?.textOk === true && vOk === true)) : (at.vision?.textOk ?? null));
      const passed = textOk !== false && vOk !== false && (vOk === true || textOk === true || (!job.visionModel && !at.ocr?.checks));
      at.verdict = passed ? 'pass' : 'fail';
      issues = [
        ...(at.ocr?.checks || []).filter((c) => !c.ok).map((c) => `文字「${c.text}」没有准确出现`),
        ...(at.vision?.issues || []),
      ].slice(0, 6);
      if (passed) { slot.status = 'passed'; slot.best = at.file; slot.verdict = (at.vision && !at.vision.error) || at.ocr?.checks ? 'pass' : 'unchecked'; save(job); return; }
    } catch (e) {
      if (signal.aborted) return;
      at.error = e.message;
      // 内容审核拒绝 / 参数不对：重试也没用，直接停
      if (isFatal(e)) { slot.status = 'failed'; slot.verdict = 'error'; save(job); return; }
    } finally { at.ms = Date.now() - t0; }
  }
  // 3 次都不合格：交付分数最高的一张（OCR 相似度 + 看图结论），标「需人工确认」
  const score = (a) => (a.file ? 1 : 0) + (a.vision?.pass ? 2 : 0) + (a.ocr?.checks ? a.ocr.checks.reduce((s, c) => s + c.score, 0) / a.ocr.checks.length : 0);
  const best = slot.attempts.filter((a) => a.file).sort((a, b) => score(b) - score(a))[0];
  slot.best = best?.file || null;
  slot.status = best ? 'needs_review' : 'failed';
  slot.verdict = best ? 'review' : 'error';
  save(job);
}

export function getJob(id) {
  if (_jobs.has(id)) return _jobs.get(id);
  for (const d of safeList(studioRoot())) {
    const p = join(studioRoot(), d, id, 'job.json');
    if (/^[\w-]+$/.test(id) && existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch {} }
  }
  return null;
}
// ── 删除 / 过期清理（见 history-gc.js）──
export const isBusy = (job) => job?.status === 'running';
export function deleteJob(job) {
  if (!job) return false;
  if (isBusy(job)) throw new Error('这次出图还在进行，先取消再删除');
  job.deleted = true;
  const ok = removeJobDir(studioRoot(), job);
  _jobs.delete(job.id);
  return ok;
}
export const purgeJobs = (days) => purgeOlderThan(studioRoot(), days, isBusy, (id) => _jobs.delete(id));
/** 某人能看到的全部任务（不限条数），用于「清空历史」 */
export function allJobIds({ owner = null, all = false } = {}) { return listJobs({ owner, all, limit: Infinity }).map((j) => j.id); }

export function cancelJob(id) { const j = _jobs.get(id); if (j && j.status === 'running') { j.ac.abort(); j.status = 'cancelled'; save(j); } return j; }
const safeList = (dir) => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };
/** 历史（最近的在前）：只列自己的（多用户时） */
export function listJobs({ owner = null, all = false, limit = 40 } = {}) {
  const out = [];
  for (const d of safeList(studioRoot())) {
    for (const id of safeList(join(studioRoot(), d))) {
      const j = _jobs.get(id) || (() => { try { return JSON.parse(readFileSync(join(studioRoot(), d, id, 'job.json'), 'utf8')); } catch { return null; } })();
      if (!j || (!all && j.owner !== owner)) continue;
      out.push({ id: j.id, day: j.day, createdAt: j.createdAt, status: j.status, need: j.need.slice(0, 80), n: j.n, model: j.model,
        thumbs: (j.slots || []).map((s) => s.best).filter(Boolean), credits: j.credits });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
export function jobFile(job, name) {
  if (!/^(img-\d+-\d+|ref)\.(png|jpg|webp)$/.test(name)) return null;
  const p = join(studioRoot(), job.day, job.id, name);
  return existsSync(p) ? p : null;
}
/** 保存到项目：合格（或需人工确认）的图复制进 <项目>/出图/<日期>/，文件名带需求开头 */
export function saveToProject(job, cwd, files = null) {
  const base = resolve(cwd);
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error('项目目录不存在：' + base);
  const dest = join(base, '出图', job.day);
  mkdirSync(dest, { recursive: true });
  const stem = job.need.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || '出图';
  const pick = files || job.slots.map((s) => s.best).filter(Boolean);
  const saved = [];
  for (const f of pick) {
    const src = jobFile(job, f);
    if (!src) continue;
    const to = join(dest, `${stem}-${job.id.slice(-4)}-${f.replace(/^img-/, '')}`);
    if (!to.startsWith(base + sep)) continue;
    copyFileSync(src, to);
    saved.push(to);
  }
  job.savedTo = [...new Set([...(job.savedTo || []), ...saved])];
  save(job);
  return saved;
}
