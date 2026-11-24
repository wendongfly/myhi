// 「💡 问一问」：用户看不懂 AI 回复里的某段内容 / 名词时，在旁边小窗里问，不进正在干活的会话。
// 每次提问起一个一次性的 claude -p 进程：不带工具（只解释，不读文件不跑命令）、不落会话记录、默认用快模型，
// 回答流式推给提问的那个页面。正在干活的 claude 进程、它的上下文和其他旁观者都不受影响。
import { spawn } from 'child_process';
import { findClaude, buildBaseClaudeEnv, gatewaySettingsArgs } from './agent.js';
import { buildPseudonymizer, loadMap } from './pseudo.js';

// ⚠️ 单行、不含 ASCII 双引号：Windows 走 cmd.exe 启动时多行 / 双引号会把命令行截断（同 agent.js 的系统提示）
const ASIDE_SYSTEM_PROMPT = [
  '你是 myhi 的讲解助手。用户正在让另一个 AI 帮他完成任务，看到那个 AI 回复里的某段内容不太理解（可能在学习中），来问你。',
  '请用简体中文、通俗易懂地回答：先用一两句话直接说清它是什么 / 什么意思，再结合用户当前的任务场景说明它在这里起什么作用，必要时举一个生活化的小例子；',
  '回答里出现的术语顺带解释；篇幅适中，一般不超过 300 字，用户要求详细时再展开。',
  '你只能解释和回答，不能读文件、不能执行命令，也看不到完整的对话；信息不够时说明这是你的推测。',
  '不要替用户改任务、也不要假装你就是那个干活的 AI；除非用户问，否则不要给出操作建议。',
].join('');
// 方案审批「AI 帮我看重点」：帮用户审另一个 AI 交上来的方案（不是解释某段话）
const PLAN_REVIEW_PROMPT = [
  '你是 myhi 的方案审阅助手。另一个 AI 在计划模式下交了一份实施方案，用户要审批，但方案太长、人看着累。',
  '请站在用户（负责人）的角度帮他抓重点：它要做什么、会动到哪些地方、哪些事需要用户确认或提供、有什么风险、可以提什么修改意见。',
  '用简体中文，结构清晰、要点式、引用方案原词，整体控制在 600 字以内；不要复述全文，不要编造方案里没有的内容，不确定的标明。',
  '你只能阅读和给建议，不能读文件、不能执行命令。',
].join('');

const MAX_CTX = 3000, MAX_SEL = 2000, MAX_Q = 1000, MAX_HISTORY = 6;
const MAX_PLAN = 40000;   // 方案审批「AI 帮我看重点」：整份方案都要看到
const TIMEOUT_MS = 3 * 60 * 1000;
const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function buildPrompt({ title, userAsk, context, selection, question, history, plan }) {
  const parts = [];
  if (title) parts.push(`【任务】${clip(title, 100)}`);
  if (plan) parts.push(`【AI 提交的方案（等用户审批）】\n${clip(plan, MAX_PLAN)}`);
  if (userAsk) parts.push(`【用户当时给那个 AI 的需求】\n${clip(userAsk, 1000)}`);
  if (context) parts.push(`【那个 AI 的回复（节选）】\n${clip(context, MAX_CTX)}`);
  if (selection) parts.push(`【用户选中、想弄懂的内容】\n${clip(selection, MAX_SEL)}`);
  const hist = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY);
  if (hist.length) parts.push('【之前在这里的问答】\n' + hist.map(h => `问：${clip(h.q, 500)}\n答：${clip(h.a, 1200)}`).join('\n\n'));
  parts.push(`【用户的问题】\n${clip(question, plan ? 2000 : MAX_Q) || '请解释选中的内容是什么意思。'}`);
  return parts.join('\n\n');
}

// session：AgentSession（取 cwd / 隐私护栏映射）；model：快模型（空则用 claude 默认）。
// onText(全文) 随流式到达反复调用；返回 { promise, cancel }。
export function askAside(session, req, { model, onText }) {
  const cwd = session?.cwd || process.cwd();
  // 隐私护栏：项目开了护栏，发出去之前同样把敏感实体换成占位符、回来再还原；和会话共用映射表，占位符一致
  let pseudo = null;
  try {
    const map = session?._pseudoMap || loadMap(session?.claudeSessionId || session?.id);
    pseudo = buildPseudonymizer(cwd, map);
  } catch {}
  let prompt = buildPrompt(req);
  if (pseudo?.enabled) prompt = pseudo.pseudonymize(prompt).text;
  const restore = (t) => (pseudo?.enabled ? pseudo.restore(t) : t);

  let proc = null, cancelled = false;
  const run = (withModel) => new Promise((resolve) => {
    const launcher = findClaude();
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--no-session-persistence', '--tools', '', '--system-prompt', req.plan ? PLAN_REVIEW_PROMPT : ASIDE_SYSTEM_PROMPT];
    if (withModel) args.push('--model', withModel);
    args.push(...gatewaySettingsArgs());
    try {
      proc = spawn(launcher.command, [...launcher.preArgs, ...args], { cwd, env: buildBaseClaudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ error: e.code === 'ENOENT' ? '这台电脑还没安装 Claude Code，暂时用不了' : e.message }); }
    let buf = '', text = '', result = null, stderr = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, TIMEOUT_MS);
    proc.stdout.setEncoding('utf8');   // 跨块汉字不被切坏
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'stream_event' && o.event?.type === 'content_block_delta' && o.event.delta?.type === 'text_delta') {
          text += o.event.delta.text || '';
          onText?.(restore(text));
        } else if (o.type === 'result') {
          result = o;
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ error: e.code === 'ENOENT' ? '这台电脑还没安装 Claude Code，暂时用不了' : e.message }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (cancelled) return resolve({ cancelled: true });
      if (result && !result.is_error) return resolve({ text: restore(result.result || text) });
      const msg = (result?.result || stderr.trim().split('\n').pop() || `进程退出 (code ${code})`).slice(0, 300);
      resolve({ error: restore(msg), partial: text ? restore(text) : '' });
    });
    try { proc.stdin.end(prompt); } catch {}
  });

  const promise = (async () => {
    let r = await run(model);
    // 指定的快模型不可用（如网关不认这个别名）且一个字都没回：退回 claude 默认模型再试一次
    if (r.error && !r.partial && model && !cancelled) r = await run(null);
    return r;
  })();
  return { promise, cancel: () => { cancelled = true; try { proc?.kill(); } catch {} } };
}
