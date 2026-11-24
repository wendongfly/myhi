// ---------------------------------------------------------------------------
// transcript 读取 —— 会话历史的唯一权威源
//
//   背景（1.3.171 用户反馈「历史工具看不到细节 / 丢用户输入 / 重复消息」）：
//   旧回放链路有两套不对齐的数据源 —— socket 整本回放用内存 _history（含子代理
//   镜像、系统警告等 transcript 没有的条目），向上翻页却按「原始行数」切 transcript
//   文件（offset 是消息条数，切的却是行，辅助记录越多偏得越狠）。两套序列一对不齐，
//   翻页窗口就与已渲染内容重叠 → 顶部出现重复消息、中间漏消息。
//
//   现在：socket 整本回放与 REST 分页都走这里，同一套过滤、同一个消息序列，
//   offset 天然对齐。子代理记录（isSidechain）在此过滤——它们有自己的面板/文件，
//   混进主流就是「重复消息」的另一个来源。
//
//   消息形状（与前端 chat.html 渲染分支约定一致）：
//     { type:'user', content:'文本', timestamp }          真人输入 / 接力草稿
//     { type:'tool_result', id, text, timestamp }          工具输出（前端配对进最近工具卡）
//     { type:'assistant', message:{content:[blocks]}, timestamp }
//     { type:'result', total_cost_usd, timestamp }
// ---------------------------------------------------------------------------

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { stripHeavyPayload } from './agent.js';
import { buildRedactor, redactDeep } from './secrets.js';
import { loadMap, buildRestorer } from './pseudo.js';

const MAX_TEXT = 8000;        // 单段文本/工具输出上限——回放是给人看的，不必整块搬
const MAX_INPUT_STR = 16000;  // tool_use 入参里的长字符串上限（如 Write 的整文件内容）

/** claude CLI 把 cwd 编码成子目录名，方案不透明，直接扫所有子目录找匹配的 jsonl */
export function findTranscriptPath(claudeSessionId) {
  // 只认 claude 会话 id 的字符集：/resume ../../x 之类会拼出任意 .jsonl 路径
  if (!claudeSessionId || typeof claudeSessionId !== 'string' || !/^[\w-]{1,128}$/.test(claudeSessionId)) return null;
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsDir, entry.name, claudeSessionId + '.jsonl');
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return null;
}

function clipText(s, max = MAX_TEXT) {
  return s.length > max ? s.slice(0, max) + `\n…[已截断，共 ${s.length} 字符]` : s;
}

/** 递归把对象里的长字符串截短（tool_use 入参防炸：Write 带整文件、Bash 带长输出） */
function clipStrings(obj, max = MAX_INPUT_STR) {
  if (obj == null || typeof obj !== 'object') return typeof obj === 'string' && obj.length > max ? clipText(obj, max) : obj;
  if (Array.isArray(obj)) return obj.map((v) => clipStrings(v, max));
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = clipStrings(v, max);
  return out;
}

/** 一行 transcript 记录 → 一条回放消息；null = 跳过（噪音/子代理/不认识） */
export function parseTranscriptLine(line) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || r.isSidechain) return null; // 子代理镜像不进主流

  if (r.type === 'human' || r.type === 'user') {
    const c = r.message?.content;
    if (typeof c === 'string') {
      return c.trim() ? { type: 'user', content: clipText(c), timestamp: r.timestamp } : null;
    }
    if (Array.isArray(c)) {
      // tool_result 记录：只搬文本（图片块留占位，base64 绝不过网线）
      const tr = c.find((b) => b.type === 'tool_result');
      if (tr) {
        let text = '';
        if (typeof tr.content === 'string') text = tr.content;
        else if (Array.isArray(tr.content)) {
          text = tr.content.map((b) => {
            if (b?.type === 'text') return b.text || '';
            if (b?.type === 'image') return '[图片结果]';
            return '';
          }).filter(Boolean).join('\n');
        }
        return { type: 'tool_result', id: tr.tool_use_id || '', text: clipText(text), timestamp: r.timestamp };
      }
      const text = c.find((b) => b.type === 'text')?.text || '';
      return text ? { type: 'user', content: clipText(text), timestamp: r.timestamp } : null;
    }
    return null;
  }

  if (r.type === 'assistant' && r.message?.content) {
    const msg = stripHeavyPayload(r.message);
    // 再截一道超长文本（thinking/工具入参），防整包 socket 推送过大
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'thinking' && typeof b.thinking === 'string') b.thinking = clipText(b.thinking, 4000);
        if (b?.type === 'tool_use' && b.input) b.input = clipStrings(b.input);
      }
    }
    return { type: 'assistant', message: msg, timestamp: r.timestamp };
  }

  if (r.type === 'result') {
    return { type: 'result', total_cost_usd: r.costUSD || r.total_cost_usd, timestamp: r.timestamp };
  }
  return null;
}

/**
 * 读 transcript 并转成回放消息序列。
 * @param {string} claudeSessionId
 * @param {{offset?: number, limit?: number}} opts  offset/limit 单位 = 过滤后的消息条数；
 *                                                  offset 从「最新」往回数（0 = 最新端）；
 *                                                  limit 省略/0 = 全量。
 * @returns {{ok: boolean, messages: Array, total: number, hasMore: boolean}}
 */
export function readTranscript(claudeSessionId, { offset = 0, limit = 0 } = {}) {
  const jsonlPath = findTranscriptPath(claudeSessionId);
  if (!jsonlPath) return { ok: false, messages: [], total: 0, hasMore: false };

  let allLines;
  try {
    allLines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { ok: false, messages: [], total: 0, hasMore: false };
  }

  const all = [];
  for (const line of allLines) {
    const m = parseTranscriptLine(line);
    if (m) all.push(m);
  }
  const total = all.length;
  const end = Math.max(0, total - Math.max(0, offset));
  const start = Math.max(0, limit > 0 ? end - limit : 0);
  // 刷新 / 换设备回放读的是 claude 的原始 jsonl：以前不过护栏 —— 实时看到 «SECRET:X»，一刷新就是明文 token；
  // 占位符也不还原，和实时显示对不上。这里补齐：先还原假名（Layer C），再密钥脱敏（Layer B）
  const restore = buildRestorer(loadMap(claudeSessionId));
  const redact = buildRedactor();
  let messages = all.slice(start, end);
  if (restore || redact) messages = messages.map((m) => redactDeep(restore ? redactDeep(m, restore) : m, redact));
  return { ok: true, messages, total, hasMore: start > 0 };
}
