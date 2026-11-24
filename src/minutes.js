// ---------------------------------------------------------------------------
// 会议纪要（/minutes）：上传会议录音 → 语音服务转写并区分发言人 → AI 生成纪要
//   转写：语音服务（/admin › 语音输入 配的地址，同语音输入）的会议接口
//         POST {asr}/meeting/jobs（异步）+ GET {asr}/meeting/jobs/{id} 轮询，见 docs/asr/sensevoice_server.py；
//         服务还没升级（没有会议接口）→ 退回 POST {asr}/transcribe 整段转写，不区分发言人
//   纪要：claude --print（同「语音整理」：有网关走网关，没有就直连），场景模型「会议纪要」
//   记录存 ~/.myhi/minutes/<日期>/<任务号>/（job.json、录音、逐字稿.md、纪要.md）；可选「保存到项目」
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, createReadStream, renameSync, rmSync } from 'fs';
import { removeJobDir, purgeOlderThan } from './history-gc.js';
import { join, resolve, extname, sep, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import { findClaude, buildBaseClaudeEnv, gatewaySettingsArgs } from './agent.js';
import { sceneModel, resolveGateway, listGatewayModels } from './models.js';

const root = () => join(homedir(), '.myhi', 'minutes');
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.amr', '.ogg', '.opus', '.webm', '.mp4', '.flac', '.wma', '.mov', '.3gp']);
export const MAX_AUDIO = 1024 ** 3;   // 1GB
const MAX_PROMPT_CHARS = 150_000;     // 2 小时会议的逐字稿约 3~4 万字，留足余量

// 语音服务地址：环境变量 ASR_URL 或 ~/.myhi/asr.json（同语音输入）；可填多个（逗号分隔），依次尝试
export function asrUrls() {
  const raw = process.env.ASR_URL || (() => { try { return JSON.parse(readFileSync(join(homedir(), '.myhi', 'asr.json'), 'utf8')).url; } catch { return ''; } })();
  return String(raw || '').split(/[,，\s]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

// ── HTTP：大文件流式上传（Node 自带 fetch 默认 5 分钟等响应头会超时，这里用 http 模块自己控制）──
// insecure：只给局域网语音服务用（常见自签证书）；带 API Key 的网关请求一律校验证书，否则中间人能截走 key
function request(url, { method = 'GET', headers = {}, body = null, file = null, timeout = 60_000, insecure = false, label = '语音服务' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, rejectUnauthorized: !insecure }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`${label}超过 ${Math.round(timeout / 1000)} 秒没有回应`)));
    req.on('error', reject);
    if (file) {
      req.write(file.head);
      const rs = createReadStream(file.path);
      rs.on('error', (e) => req.destroy(e));
      rs.on('end', () => req.end(file.tail));
      rs.pipe(req, { end: false });
    } else req.end(body);
  });
}
function postAudio(url, path, ext, timeout, fields = {}) {
  const boundary = '----myhi' + randomBytes(8).toString('hex');
  // 其它表单字段（如 diarize / spk_num）放在文件前面
  const pre = Object.entries(fields).filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const head = Buffer.from(pre + `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio${ext}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const size = statSync(path).size;
  return request(url, {
    method: 'POST', timeout, file: { path, head, tail }, insecure: true,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': head.length + size + tail.length },
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 任务 ────────────────────────────────────────────────────────────────────
const _jobs = new Map();
const jobDir = (job) => join(root(), job.day, job.id);
function save(job) { if (job.deleted) return; try { mkdirSync(jobDir(job), { recursive: true }); writeFileSync(join(jobDir(job), 'job.json'), JSON.stringify(publicJob(job), null, 2)); } catch {} }
export const audioPath = (job) => join(jobDir(job), job.audio.file);

// ── 原录音回放：浏览器播不了的格式先转成能播的 ──────────────────────────────
// 浏览器（Chrome / Edge / Firefox / Safari）都不支持 AMR —— 手机通话录音常见 .amr，播放器只会显示 0:00。
// AMR-NB 用纯 JS 解码器（src/vendor/amrnb.cjs）在 worker 线程转成 WAV，缓存为任务目录下的 audio.play.wav；
// 上传后立即在后台转，老任务第一次播放时再转。其它浏览器播不了的格式（wma 等）由页面提示下载原文件
const _here = dirname(fileURLToPath(import.meta.url));   // 源码时是 src/，打包后是 dist/（构建会把 worker 拷过去）
const NEEDS_CONVERT = new Set(['.amr']);
const _converting = new Map();   // job.id → Promise（同一份同时只转一次）
export const playPath = (job) => join(jobDir(job), 'audio.play.wav');
/** → { path, mime } 能直接给浏览器播的文件；转不了抛错（error.code = 'unplayable'） */
export async function playableAudio(job) {
  const src = audioPath(job);
  const ext = extname(job.audio.file).toLowerCase();
  if (!NEEDS_CONVERT.has(ext)) return { path: src, mime: null };
  const dst = playPath(job);
  if (existsSync(dst)) return { path: dst, mime: 'audio/wav' };
  if (!_converting.has(job.id)) {
    const p = new Promise((ok, no) => {
      const w = new Worker(join(_here, 'amr-worker.cjs'), { workerData: { src, dst } });
      w.once('message', (m) => (m.ok ? ok() : no(Object.assign(new Error(m.error), { code: 'unplayable' }))));
      w.once('error', (e) => no(Object.assign(new Error('转换录音失败：' + e.message), { code: 'unplayable' })));
      w.once('exit', (c) => { if (c !== 0) no(Object.assign(new Error('转换录音失败（退出码 ' + c + '）'), { code: 'unplayable' })); });
    }).finally(() => _converting.delete(job.id));
    _converting.set(job.id, p);
  }
  await _converting.get(job.id);
  return { path: dst, mime: 'audio/wav' };
}
export function publicJob(job) { const { cancelled, ...rest } = job; return rest; }
const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
const speakerName = (job, spk) => (spk == null ? '' : (job.speakers?.[spk] || `发言人${Number(spk) + 1}`));

/** 新建：录音已由 multer 存到 tmpPath，这里挪进任务目录并开始识别（转写 + 区分发言人）。
 *  不再自动整理纪要：识别完先给原始信息（逐字稿 / 发言人），由使用人改发言人名字、写整理要求后再生成纪要，
 *  可以换要求生成多版（job.versions），挑想要的保存 */
export function createJob({ tmpPath, origName, title, meetingDate, attendees, focus, spkNum }, { owner = null } = {}) {
  const ext = (extname(origName || '').toLowerCase() || '.m4a');
  if (!AUDIO_EXT.has(ext)) { try { rmSync(tmpPath, { force: true }); } catch {} throw new Error('不支持的文件类型：' + ext + '（支持 mp3、m4a、wav、aac、amr、ogg、webm、mp4 等）'); }
  if (!asrUrls().length) { try { rmSync(tmpPath, { force: true }); } catch {} throw new Error('还没有配置语音服务：/admin › 语音输入 填语音服务地址'); }
  const id = Date.now().toString(36) + randomBytes(3).toString('hex');
  const job = {
    id, day: day(), owner, createdAt: new Date().toISOString(),
    title: String(title || '').trim().slice(0, 80) || String(origName || '会议').replace(/\.[^.]+$/, '').slice(0, 80),
    meetingDate: String(meetingDate || '').trim().slice(0, 40) || day(),
    attendees: String(attendees || '').trim().slice(0, 500), focus: String(focus || '').trim().slice(0, 1000),
    spkNum: Math.max(0, Math.min(20, parseInt(spkNum, 10) || 0)) || null,   // 发言人数（知道就填，区分更准）
    savedTo: [],
    audio: { file: 'audio' + ext, name: String(origName || '').slice(0, 200), size: statSync(tmpPath).size },
    status: 'transcribing', progress: 0, stage: '提交给语音服务…', mode: null, notes: [],
    segments: [], speakers: {}, duration: 0, versions: [], error: null,
  };
  mkdirSync(jobDir(job), { recursive: true });
  try { renameSync(tmpPath, join(jobDir(job), job.audio.file)); }
  catch { writeFileSync(join(jobDir(job), job.audio.file), readFileSync(tmpPath)); rmSync(tmpPath, { force: true }); }
  _jobs.set(id, job);
  save(job);
  run(job).catch((e) => { job.status = 'error'; job.error = e.message; save(job); });
  if (NEEDS_CONVERT.has(ext)) playableAudio(job).catch((e) => console.warn('[纪要] 录音转成可播放格式失败:', e.message));
  return job;
}

async function run(job) {
  await transcribe(job);
  if (job.cancelled) return;
  job.status = 'done'; job.stage = ''; job.progress = 1;   // done = 识别完成（原始信息就绪）；纪要按需生成，见 summarize
  writeFiles(job); save(job);
}

/** 重新识别（如指定发言人数让区分更准）：清掉逐字稿 / 发言人重来；已生成的纪要版本保留（各自是当时的快照） */
export function retranscribe(job, { spkNum } = {}) {
  if (isBusy(job)) throw new Error('还在处理中，稍等');
  job.spkNum = Math.max(0, Math.min(20, parseInt(spkNum, 10) || 0)) || null;
  Object.assign(job, { status: 'transcribing', progress: 0, stage: '提交给语音服务…', mode: null, segments: [], speakers: {}, duration: 0, error: null, cancelled: false });
  job.notes = (job.notes || []).filter((n) => !n.startsWith('语音服务没有返回发言人信息'));
  save(job);
  run(job).catch((e) => { job.status = 'error'; job.error = e.message; save(job); });
}

async function transcribe(job) {
  const path = join(jobDir(job), job.audio.file), ext = extname(job.audio.file);
  let lastErr = null;
  for (const base of asrUrls()) {
    try {
      // ① 会议接口：异步任务，区分发言人
      const sub = await postAudio(base + '/meeting/jobs', path, ext, 30 * 60_000);
      if (sub.status === 404 || sub.status === 405) {
        // ② 没有异步会议接口：同步 /transcribe，带 diarize=true 让支持的服务区分发言人
        //    （如自建的 SenseVoice + cam++，见 docs/asr/sensevoice_server.py：返回 segments[{text, start, end(毫秒), spk}]）；不支持的服务会忽略这个字段，只给整段 text
        job.stage = '转写中（同步，长录音要等一会儿）…'; job.mode = 'sync'; save(job);
        const r = await postAudio(base + '/transcribe', path, ext, 3 * 3600_000, { diarize: 'true', spk_num: job.spkNum || '' });
        if (r.status >= 400 || r.json?.error) throw new Error(r.json?.error || r.json?.detail || `语音服务返回 HTTP ${r.status}`);
        const segs = Array.isArray(r.json?.segments) ? r.json.segments.filter((x) => x && String(x.text || '').trim()) : [];
        if (segs.length) {
          job.segments = segs.map((x) => ({ start: (+x.start || 0) / 1000, end: (+x.end || 0) / 1000, spk: x.spk == null && x.speaker == null ? null : String(x.spk ?? x.speaker), text: String(x.text).trim() }));
          job.duration = job.segments.at(-1).end;
          for (const spk of new Set(job.segments.map((x) => x.spk).filter((x) => x != null))) job.speakers[spk] = job.speakers[spk] || `发言人${Number(spk) + 1}`;
          job.mode = 'diarize';
        } else {
          const text = String(r.json?.text || '').trim();
          if (!text) throw new Error('没有识别出文字（录音是否有声音？）');
          job.segments = splitPlain(text);
          job.notes.push('语音服务没有返回发言人信息，本次没有区分发言人（需要支持 diarize 的语音服务，见 docs/asr/sensevoice_server.py）');
        }
        job.progress = 1; save(job);
        return;
      }
      if (sub.status >= 400 || !sub.json?.id) throw new Error(sub.json?.error || sub.json?.detail || `语音服务返回 HTTP ${sub.status}`);
      job.mode = 'meeting'; job.remote = { base, id: sub.json.id }; job.stage = '排队中…'; save(job);
      // 轮询：最长 6 小时（服务端一次跑一个，前面有会议在跑会排队）
      for (let t0 = Date.now(); Date.now() - t0 < 6 * 3600_000;) {
        if (job.cancelled) return;
        await sleep(3000);
        let s;
        try { s = (await request(`${base}/meeting/jobs/${encodeURIComponent(sub.json.id)}`, { timeout: 30_000, insecure: true })).json; } catch { continue; }
        if (!s) continue;
        if (s.status === 'error') throw new Error(s.error || '语音服务转写失败');
        job.progress = typeof s.progress === 'number' ? s.progress : job.progress;
        job.stage = s.status === 'queued' ? '排队中（语音服务一次处理一场会议）…' : '转写并区分发言人中…';
        if (s.status === 'done') {
          const segs = (s.result?.segments || []).filter((x) => x && String(x.text || '').trim());
          if (!segs.length) throw new Error('没有识别出文字（录音是否有声音？）');
          job.segments = segs.map((x) => ({ start: +x.start || 0, end: +x.end || 0, spk: x.speaker == null ? null : String(x.speaker), text: String(x.text).trim() }));
          job.duration = +s.result.duration || job.segments.at(-1).end;
          for (const spk of new Set(job.segments.map((x) => x.spk).filter((x) => x != null))) job.speakers[spk] = job.speakers[spk] || `发言人${Number(spk) + 1}`;
          job.progress = 1; save(job);
          return;
        }
        save(job);
      }
      throw new Error('转写超过 6 小时还没完成');
    } catch (e) { lastErr = e; if (job.cancelled) return; }
  }
  throw new Error('转写失败：' + (lastErr?.message || '语音服务不可用'));
}
// 整段文字没有分句信息：按句号切成段，便于阅读
function splitPlain(text) {
  const parts = text.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
  const out = []; let buf = '';
  for (const p of parts) { buf += p; if (buf.length > 120) { out.push(buf); buf = ''; } }
  if (buf) out.push(buf);
  return out.map((t) => ({ start: null, end: null, spk: null, text: t }));
}

export function transcriptMarkdown(job) {
  const head = `# ${job.title} · 逐字稿\n\n- 时间：${job.meetingDate}\n${job.attendees ? `- 参会人：${job.attendees}\n` : ''}- 录音：${job.audio.name}${job.duration ? `（${fmtTime(job.duration)}）` : ''}\n\n`;
  return head + transcriptBody(job);
}
function transcriptBody(job) {
  // 同一发言人连续的几段合并成一段
  const lines = [];
  for (const s of job.segments) {
    const who = speakerName(job, s.spk);
    const last = lines.at(-1);
    if (last && last.who === who && who) { last.text += s.text; continue; }
    lines.push({ who, t: s.start, text: s.text });
  }
  return lines.map((l) => `${l.t != null ? `**[${fmtTime(l.t)}]** ` : ''}${l.who ? `**${l.who}**：` : ''}${l.text}`).join('\n\n') + '\n';
}

const MINUTES_PROMPT = (job, transcript, v) => `下面是一场会议的逐字稿（语音自动转写，可能有错别字和口语重复；「发言人N」是自动区分的说话人，有真名的已替换）。请整理成正式的会议纪要。

会议名称：${job.title}
会议时间：${job.meetingDate}
${v.attendees ? `参会人：${v.attendees}\n` : ''}${v.focus ? `\n使用人的整理要求（最优先；和下面默认要求冲突时以这里为准，比如只要某几部分、换结构、换语气）：\n${v.focus}\n` : ''}
默认要求：
1. 用 Markdown 输出，结构如下（没有内容的部分写「无」，不要删掉标题）：
   # 会议纪要：${job.title}
   - 时间 / 参会人（逐字稿里能确认的）
   ## 会议概要（3~5 句话）
   ## 议题与讨论（按议题分小节；每个议题写清各方主要观点，注明是谁说的）
   ## 决议事项（会上明确定下来的）
   ## 待办事项（表格：| 事项 | 负责人 | 截止时间 | 备注 |；负责人、截止时间会上没说就写「待定」）
   ## 待确认问题（会上没定下来、需要后续确认的）
2. 只写逐字稿里有依据的内容，不编造；数字、日期、金额、人名、项目名保持原样；明显的转写错别字按上下文改正。
3. 去掉寒暄、口头禅和与会议无关的闲聊。
4. 直接输出纪要正文，不要任何解释。

逐字稿：
---
${transcript}
---`;

// ── 调大模型写纪要 ──────────────────────────────────────────────────────────
//   有网关（且配了具体模型）：直接调网关，不经 Claude Code——省掉 CLI 启动和工具环境，长文更稳
//   没网关：claude --print，关掉工具（纯文字整理），每次最多 20 分钟
const CALL_TIMEOUT = 20 * 60_000;
const SYS = '你是会议纪要整理助手。只根据给出的会议内容整理，不编造，用中文输出，直接给结果。';
async function gatewayChat(prompt, model) {
  const gw = resolveGateway();
  let protos = null;
  try { protos = (await listGatewayModels()).models?.find((m) => m.id === model)?.protocols || null; } catch {}
  const useOpenAI = protos ? !protos.includes('anthropic') : false;
  const url = gw.baseUrl.replace(/\/+$/, '') + (useOpenAI ? '/v1/chat/completions' : '/v1/messages');
  const body = useOpenAI
    ? { model, max_tokens: 8000, messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }] }
    : { model, max_tokens: 8000, system: SYS, messages: [{ role: 'user', content: prompt }] };
  const t0 = Date.now();
  const r = await request(url, {
    method: 'POST', timeout: CALL_TIMEOUT, body: JSON.stringify(body), label: '网关',
    headers: { 'content-type': 'application/json', 'x-api-key': gw.apiKey, authorization: 'Bearer ' + gw.apiKey, 'anthropic-version': '2023-06-01' },
  }).catch((e) => { throw new Error(`${e.message}（模型 ${model}，已等 ${Math.round((Date.now() - t0) / 1000)} 秒）`); });
  if (r.status >= 400) throw new Error(`网关返回 HTTP ${r.status}：${(r.json?.error?.message || r.text || '').slice(0, 200)}`);
  const text = useOpenAI ? String(r.json?.choices?.[0]?.message?.content || '') : (r.json?.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  if (!text.trim()) throw new Error(`模型 ${model} 没有返回内容`);
  return text.trim();
}
function runClaude(prompt, { model, timeout = CALL_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const launcher = findClaude();
    const args = [...launcher.preArgs, '--print', '--tools', '', '--system-prompt', SYS, ...(model ? ['--model', model] : []), ...gatewaySettingsArgs()];
    const t0 = Date.now();
    const child = spawn(launcher.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...buildBaseClaudeEnv(), NO_COLOR: '1' }, timeout, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0 || out.trim()) return resolve(out.trim());
      const secs = Math.round((Date.now() - t0) / 1000);
      const tail = err.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      if (signal && secs * 1000 >= timeout - 2000) return reject(new Error(`AI 处理超过 ${Math.round(timeout / 60000)} 分钟被中止（模型 ${model || 'Claude Code 默认'}）${tail ? '：' + tail : ''}`));
      if (signal) return reject(new Error(`claude 进程被系统结束（${signal}，已运行 ${secs} 秒）${tail ? '：' + tail : ''}`));
      reject(new Error(`claude 退出码 ${code}（已运行 ${secs} 秒）${tail ? '：' + tail : ''}`));
    });
    child.stdin.end(prompt, 'utf8');
  });
}
async function llm(prompt, model) {
  return resolveGateway().baseUrl && model ? gatewayChat(prompt, model) : runClaude(prompt, { model });
}

// 长逐字稿分段：每段约 12000 字先提炼要点，再汇总成纪要——单次输入短，不会超时，也更快
const CHUNK_CHARS = 12000;
function chunkTranscript(text) {
  if (text.length <= CHUNK_CHARS * 1.25) return [text];
  const out = []; let cur = '';
  for (const para of text.split('\n\n')) {
    if (cur && cur.length + para.length > CHUNK_CHARS) { out.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + para;
  }
  if (cur) out.push(cur);
  return out;
}
const CHUNK_PROMPT = (job, part, i, n) => `下面是会议「${job.title}」逐字稿的第 ${i}/${n} 段（语音自动转写，可能有错别字；「发言人N」是自动区分的说话人，有真名的已替换）。请提炼这一段的要点，供之后汇总成会议纪要：
- 讨论了哪些议题，各方主要观点（注明是谁说的）
- 明确做出的决定
- 布置的待办（事项、负责人、时间，没说的写「待定」）
- 提到的关键数字、日期、金额、人名、项目名（保持原样）
- 没有定下来的问题
只写这一段里有依据的内容，用 Markdown 要点列表，不要寒暄和闲聊。

逐字稿第 ${i}/${n} 段：
---
${part}
---`;

/**
 * 按使用人的要求生成一版纪要（不覆盖之前的版本）。立即返回新版本，生成在后台跑，页面轮询。
 * 版本记下当时的参会人 / 要求 / 发言人名字 / 模型，换要求再生成就是新的一版
 */
export function summarize(job, { attendees = '', focus = '' } = {}) {
  if (isBusy(job)) throw new Error('还在处理中，稍等');
  if (!job.segments?.length) throw new Error('还没有逐字稿，不能整理纪要');
  job.versions = job.versions || [];
  const n = (job.versions.reduce((m, x) => Math.max(m, x.n || 0), 0)) + 1;
  const v = {
    id: 'v' + n + '-' + randomBytes(2).toString('hex'), n, createdAt: new Date().toISOString(),
    attendees: String(attendees || '').trim().slice(0, 500), focus: String(focus || '').trim().slice(0, 2000),
    speakers: { ...(job.speakers || {}) }, status: 'running', stage: 'AI 整理纪要中…', progress: 0, markdown: '', model: '', error: null, savedTo: [],
  };
  job.versions.push(v);
  job.attendees = v.attendees; job.focus = v.focus;   // 下次默认带上这次填的
  job.status = 'summarizing'; job.stage = `AI 整理第 ${n} 版纪要中…`; job.error = null; job.cancelled = false;
  save(job);
  runVersion(job, v).catch((e) => { v.status = 'error'; v.error = e.message; job.status = 'done'; job.stage = ''; save(job); });
  return v;
}
async function runVersion(job, v) {
  let transcript = transcriptBody(job);
  const notes = [];
  if (transcript.length > MAX_PROMPT_CHARS) { transcript = transcript.slice(0, MAX_PROMPT_CHARS); notes.push(`逐字稿太长，只用了前 ${MAX_PROMPT_CHARS} 字生成纪要`); }
  const model = sceneModel('minutes') || sceneModel('main') || '';
  const step = (stage, progress) => { v.stage = stage; v.progress = progress; job.stage = `第 ${v.n} 版：${stage}`; save(job); };
  try {
    const parts = chunkTranscript(transcript);
    if (parts.length > 1) {
      // 先分段提炼要点，再把各段要点当成「逐字稿」交给汇总
      const pts = [];
      for (let i = 0; i < parts.length; i++) {
        if (v.status === 'cancelled') return;
        step(`AI 提炼要点中（第 ${i + 1}/${parts.length} 段）…`, i / (parts.length + 1));
        pts.push(`### 第 ${i + 1} 段要点\n${await llm(CHUNK_PROMPT(job, parts[i], i + 1, parts.length), model)}`);
      }
      transcript = '（逐字稿较长，下面是按时间顺序分段提炼的要点）\n\n' + pts.join('\n\n');
      step('AI 汇总纪要中…', parts.length / (parts.length + 1));
    }
    const md = await llm(MINUTES_PROMPT(job, transcript, v), model);
    if (v.status === 'cancelled') return;   // 生成途中取消了：结果不要了
    v.markdown = md;
    v.model = (model || 'Claude Code 默认') + (resolveGateway().baseUrl && model ? '（经网关）' : '（经 Claude Code）');
    v.status = 'done'; v.stage = ''; v.progress = 1; v.notes = notes;
  } catch (e) {
    if (v.status !== 'cancelled') { v.status = 'error'; v.error = '生成纪要失败：' + e.message; }
  } finally {
    if (job.status === 'summarizing') { job.status = 'done'; job.stage = ''; }
    writeFiles(job); save(job);
  }
}
const versionOf = (job, vid) => (job.versions || []).find((x) => x.id === vid) || null;
const latestDone = (job) => [...(job.versions || [])].reverse().find((x) => x.status === 'done' && x.markdown) || null;
export function getVersion(job, vid) { return vid ? versionOf(job, vid) : latestDone(job); }
export function editVersion(job, vid, md) {
  const v = versionOf(job, vid); if (!v) throw new Error('找不到这一版纪要');
  if (v.status !== 'done') throw new Error('这一版还没生成完');
  v.markdown = String(md || '').slice(0, 500_000); v.editedAt = new Date().toISOString();
  writeFiles(job); save(job);
}
export function deleteVersion(job, vid) {
  const v = versionOf(job, vid); if (!v) throw new Error('找不到这一版纪要');
  if (v.status === 'running') throw new Error('这一版还在生成，先取消');
  job.versions = job.versions.filter((x) => x !== v);
  try { rmSync(join(jobDir(job), `纪要-第${v.n}版.md`), { force: true }); } catch {}
  writeFiles(job); save(job);
}
function writeFiles(job) {
  if (job.deleted) return;
  try {
    if (job.segments?.length) writeFileSync(join(jobDir(job), '逐字稿.md'), transcriptMarkdown(job));
    for (const v of job.versions || []) if (v.markdown) writeFileSync(join(jobDir(job), `纪要-第${v.n}版.md`), v.markdown);
  } catch {}
}
/** 旧数据（1.3.226 前：一份 job.minutes，自动生成）→ 版本列表；状态统一成「识别完成」 */
function normalize(job) {
  if (!job || job.versions) return job;
  job.versions = [];
  if (job.minutes) job.versions.push({ id: 'v1-old', n: 1, createdAt: job.createdAt, attendees: job.attendees || '', focus: job.focus || '', speakers: { ...(job.speakers || {}) }, status: 'done', markdown: job.minutes, model: job.minutesModel || '', error: null, savedTo: [] });
  if (job.status === 'error' && job.segments?.length) {   // 以前是「纪要生成失败」：识别其实成功了
    if (!job.minutes) job.versions.push({ id: 'v1-old', n: 1, createdAt: job.createdAt, attendees: job.attendees || '', focus: job.focus || '', speakers: { ...(job.speakers || {}) }, status: 'error', markdown: '', model: '', error: job.error, savedTo: [] });
    job.status = 'done'; job.error = null;
  }
  if (job.status === 'summarizing') job.status = 'done';   // 旧进程重启丢了
  delete job.minutes; delete job.minutesModel; delete job.saveTo;
  return job;
}

export function getJob(id) {
  if (_jobs.has(id)) return _jobs.get(id);
  if (!/^[\w-]+$/.test(id)) return null;
  for (const d of safeList(root())) {
    const p = join(root(), d, id, 'job.json');
    if (existsSync(p)) { try { const j = normalize(JSON.parse(readFileSync(p, 'utf8'))); _jobs.set(id, j); return j; } catch {} }
  }
  return null;
}
const safeList = (dir) => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };
export function listJobs({ owner = null, all = false, limit = 40 } = {}) {
  const out = [];
  for (const d of safeList(root())) for (const id of safeList(join(root(), d))) {
    const j = _jobs.get(id) || (() => { try { return JSON.parse(readFileSync(join(root(), d, id, 'job.json'), 'utf8')); } catch { return null; } })();
    if (!j || (!all && j.owner !== owner)) continue;
    normalize(j);
    out.push({ id: j.id, title: j.title, meetingDate: j.meetingDate, createdAt: j.createdAt, status: j.status, duration: j.duration, speakers: Object.keys(j.speakers || {}).length, versions: (j.versions || []).filter((x) => x.status === 'done').length });
    if (out.length >= limit) return out;
  }
  return out;
}
// ── 删除 / 过期清理（见 history-gc.js）。录音一起删 ──
export const isBusy = (job) => job?.status === 'transcribing' || job?.status === 'summarizing';
export function deleteJob(job) {
  if (!job) return false;
  if (isBusy(job)) throw new Error('这份纪要还在处理，先取消再删除');
  job.deleted = true;
  const ok = removeJobDir(root(), job);
  _jobs.delete(job.id);
  return ok;
}
export const purgeJobs = (days) => purgeOlderThan(root(), days, isBusy, (id) => _jobs.delete(id));
export function allJobIds({ owner = null, all = false } = {}) { return listJobs({ owner, all, limit: Infinity }).map((j) => j.id); }

/** 改发言人名字（不自动重生成纪要；已有版本保留各自当时的名字） */
export function renameSpeakers(job, map) {
  for (const [k, v] of Object.entries(map || {})) if (k in (job.speakers || {}) && String(v).trim()) job.speakers[k] = String(v).trim().slice(0, 30);
  writeFiles(job); save(job);
}
/** 取消：识别中 → 整个任务取消；整理纪要中 → 只取消正在生成的那一版 */
export function cancelJob(job) {
  if (job.status === 'transcribing') { job.cancelled = true; job.status = 'cancelled'; save(job); return; }
  if (job.status === 'summarizing') {
    for (const v of job.versions || []) if (v.status === 'running') { v.status = 'cancelled'; v.stage = ''; }
    job.status = 'done'; job.stage = ''; save(job);
  }
}
/** 保存到项目：<项目>/会议纪要/<日期>-<会议名>-纪要.md（选的那一版；多版时文件名带「第N版」）+ 逐字稿.md */
export function saveToProject(job, cwd, vid = null) {
  const base = resolve(cwd);
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error('项目目录不存在：' + base);
  const dir = join(base, '会议纪要');
  mkdirSync(dir, { recursive: true });
  const stem = `${job.meetingDate}-${job.title}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const saved = [];
  const put = (name, text) => { const p = join(dir, name); if (!p.startsWith(base + sep)) return; writeFileSync(p, text); saved.push(p); };
  const v = getVersion(job, vid);
  if (vid && !v) throw new Error('找不到这一版纪要');
  if (v?.markdown) {
    const multi = (job.versions || []).filter((x) => x.status === 'done').length > 1;
    put(`${stem}-纪要${multi ? `（第${v.n}版）` : ''}.md`, v.markdown);
  }
  if (job.segments?.length) put(`${stem}-逐字稿.md`, transcriptMarkdown(job));
  if (v) v.savedTo = [...new Set([...(v.savedTo || []), ...saved.filter((p) => p.includes('-纪要'))])];
  job.savedTo = [...new Set([...(job.savedTo || []), ...saved])];
  save(job);
  return saved;
}
export { transcriptMarkdown as transcriptMd, fmtTime };
