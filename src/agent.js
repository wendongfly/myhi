import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import { join, resolve, normalize, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { applySecretsToEnv, buildRedactor, redactDeep } from './secrets.js';
import { buildPseudonymizer, loadMap, saveMap, appendAudit, adoptKey, dropMap } from './pseudo.js';
import { nextAutoSendDraft, removeDraft, buildDraftPrompt, draftDisplayText } from './inbox.js';
import { sceneModel, modelSeesImages, describeImage, visionBacklog } from './models.js';

// ---------------------------------------------------------------------------
// findClaude – locate the claude CLI binary
// ---------------------------------------------------------------------------

let _launcher = null;

// findClaude 返回启动器 { command, preArgs }，spawn 时用 spawn(command, [...preArgs, ...args])。
// Windows 关键坑：claude.cmd 是 npm shim，若交给 `cmd.exe /c`，当路径含空格(C:\Program Files\)
// 且带引号参数(--append-system-prompt "...")时命中 cmd /c 引号剥离规则——命令行 4 个引号→剥掉首尾
// 两个→路径从空格处截断→`'C:\Program' 不是内部或外部命令`、claude code 1。
// 解法：解析 shim 内部真正的启动方式，直接 spawn 绕开 cmd.exe（与 Linux 一致，Node CreateProcess
// 正确处理含空格路径+引号/多行参数）。npm shim 有两种：
//   ① 新：`"...\claude-code\bin\claude.exe" %*`（platform 原生二进制）
//   ② 旧：`"%_prog%" "...\claude-code\cli.js" %*`（node 跑 JS 入口，装里无 claude.exe）
function resolveWinLauncherFromCmd(cmdPath) {
  try {
    const txt = readFileSync(cmdPath, 'utf8');
    const dir = dirname(cmdPath);
    const expand = (s) => s.trim()
      .replace(/%~?dp0%?/gi, dir + '\\')
      .replace(/\\{2,}/g, '\\');
    // ① 直接 claude.exe
    let m = txt.match(/"?([^"\r\n]*claude\.exe)"?/i);
    if (m) {
      const exe = expand(m[1]);
      if (existsSync(exe)) return { command: exe, preArgs: [] };
    }
    // ② node + cli.js —— 取 `%*` 之前那个 .js 入口，用当前 node(process.execPath) 直接跑
    m = txt.match(/"?([^"\r\n]*\.js)"?\s+%\*/i);
    if (m) {
      const js = expand(m[1]);
      if (existsSync(js)) return { command: process.execPath, preArgs: [js] };
    }
  } catch { /* ignore */ }
  return null;
}

// Windows 上把一个解析到的路径(.exe / .cmd / 名字)转成启动器
function winLauncherFromPath(p) {
  if (/\.exe$/i.test(p)) return { command: p, preArgs: [] };
  if (/\.cmd$/i.test(p)) {
    const l = resolveWinLauncherFromCmd(p);
    if (l) return l;
    // 解析不出就兜底走 cmd /c（此时通常是无空格路径；含空格且解析失败才有残留风险）
    return { command: process.env.ComSpec || 'cmd.exe', preArgs: ['/c', p] };
  }
  return { command: p, preArgs: [] };
}

export function findClaude() {
  if (_launcher) return _launcher;

  const candidates = process.platform === 'win32'
    ? [
        // 优先直接命中 .exe（可直接 spawn，无 cmd.exe 引号坑）
        join(homedir(), '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        join(homedir(), '.claude', 'local', 'claude.cmd'),
        join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      ]
    : [
        '/usr/bin/claude',
        '/usr/local/bin/claude',
        join(homedir(), '.claude', 'local', 'claude'),
        join(homedir(), '.npm-global', 'bin', 'claude'),
        join(homedir(), '.local', 'bin', 'claude'),
      ];

  const toLauncher = (p) => process.platform === 'win32'
    ? winLauncherFromPath(p)
    : { command: p, preArgs: [] };
  const logHit = (tag) => console.log(`[agent] ${tag} claude:`, _launcher.command, ...(_launcher.preArgs.length ? [_launcher.preArgs[_launcher.preArgs.length - 1]] : []));

  for (const p of candidates) {
    if (existsSync(p)) {
      _launcher = toLauncher(p);
      logHit('找到');
      return _launcher;
    }
  }

  try {
    const cmd = process.platform === 'win32' ? 'where claude.cmd' : 'which claude';
    const result = execSync(cmd, { timeout: 5000, stdio: 'pipe' })
      .toString()
      .trim()
      .split('\n')[0]
      .trim();
    if (result) {
      _launcher = toLauncher(result);
      logHit('which 找到');
      return _launcher;
    }
  } catch { /* ignore */ }

  console.warn('[agent] 未找到 claude 可执行文件，回退到 PATH 查找');
  _launcher = process.platform === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', preArgs: ['/c', 'claude'] }
    : { command: 'claude', preArgs: [] };
  return _launcher;
}

// 清掉 launcher 缓存 —— claude 升级后路径/shim 可能变，下次 spawn 重新解析。
export function resetClaudeLauncher() {
  _launcher = null;
  _interactiveCap = null;   // 换了 claude（升级/重装）要重新探测交互通道
  _replayCap = false;
}

// 交互通道（--permission-prompt-tool stdio）：无界面模式下 claude 默认把需要人回答的工具整个去掉
// （AskUserQuestion / ExitPlanMode 等），模型只能「按惯例自己拍板」。带上这个参数后 claude 会把这类调用
// 作为 control_request(can_use_tool) 发给 myhi、等 myhi 回 control_response —— myhi 把问题 / 方案交给用户。
// 老版本 claude 不认这些参数（带上直接启动失败），所以先用 --help 探测一次，支持才开（结果按 launcher 缓存）。
let _interactiveCap = null;   // null 未探测 / true / false
// 插话（⚡）：--replay-user-messages 让 claude 把 stdin 来的每条用户消息在真正处理时回显（带我们给的 uuid），
// myhi 据此知道「AI 下一步已经看到插话」。同一次 --help 探测（MYHI_NO_INJECT=1 关）。
let _replayCap = false;
export function probeInteractive() {
  if (_interactiveCap !== null) return Promise.resolve(_interactiveCap);
  return new Promise((resolve) => {
    let launcher;
    try { launcher = findClaude(); } catch { _interactiveCap = false; return resolve(false); }
    let out = '', done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      // 应急开关：现场遇到问题时 MYHI_NO_INTERACTIVE=1 退回旧行为（不开交互通道）
      _interactiveCap = v && !process.env.MYHI_NO_INTERACTIVE;
      _replayCap = /--replay-user-messages/.test(out) && !process.env.MYHI_NO_INJECT;
      resolve(_interactiveCap);
    };
    let proc;
    try { proc = spawn(launcher.command, [...launcher.preArgs, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return finish(false); }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} finish(false); }, 10000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); finish(false); });
    proc.on('close', () => { clearTimeout(timer); finish(/--permission-prompt-tool/.test(out) && /--allow-dangerously-skip-permissions/.test(out)); });
  });
}

// 取当前 claude 版本（用解析出的 launcher 真跑一次 --version），用于 UI 展示 + 升级后校验。
// 返回 { version, raw } 或 null（拿不到/占位符跑不起来）。
export function getClaudeVersion() {
  return new Promise((resolve) => {
    let launcher;
    try { launcher = findClaude(); } catch { return resolve(null); }
    let out = '', done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let proc;
    try {
      proc = spawn(launcher.command, [...launcher.preArgs, '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { return finish(null); }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } finish(null); }, 10000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); finish(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/(\d+\.\d+\.\d+)/);
      finish(m ? { version: m[1], raw: out.trim() } : null);
    });
  });
}

// ---------------------------------------------------------------------------
// stripHeavyPayload — 递归剥离大 base64 payload
//   适用场景：截图/图片工具结果被存入 _history 后，socket 一次推 500 条整包会让
//   前端 DOM/image decode 卡死（命宝 session 4 张 220KB 图 → 浏览器 tab 冻死）。
//   剥离规则：source.data / image.data / data URI 里 > 5KB 的 base64 字符串。
//   live emit 用的是原 msg，本次显示不受影响；只影响 history 回放时的 UI 表现。
// ---------------------------------------------------------------------------

const BASE64_STRIP_THRESHOLD = 5 * 1024;

export { stripHeavyPayload };

function stripHeavyPayload(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripHeavyPayload);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > BASE64_STRIP_THRESHOLD &&
        (k === 'data' || (k === 'url' && v.startsWith('data:')))) {
      out[k] = `[STRIPPED_BASE64_${v.length}_CHARS]`;
    } else {
      out[k] = stripHeavyPayload(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 死循环熔断（anti-death-loop）
//   场景：API 反复剥离同一张图 / 同一个工具用相同参数反复失败 → 模型不停重试，
//   每一轮都是一次完整上下文往返，几十轮就把 5h session 额度烧光。
//   三道闸：
//     A 毒性内容：出现"内容被 API 剥离/图片超限"类提示 ≥2 次 → 熔断（治图片死循环）
//     B 相同工具调用：同名工具 + 相同入参连续 ≥3 次 → 熔断（治 Read/Bash/Edit/MCP 反复失败）
//     C 单轮工具预算：单轮工具调用 > 120 次 → 检查点（兜底，防入参微调型死循环）
//   熔断动作：interrupt() 停当前回合 + 自动注入引导语纠偏；同一人类回合最多自动
//   纠偏 2 次，仍不恢复则交回人工（提示 /clear 或换问法），不再自动烧 token。
// ---------------------------------------------------------------------------

const LOOP_POISON_PHRASES = [
  'could not be processed and was removed',
  'image exceeds',
  'image dimensions exceed',
];
const LOOP_MAX_POISON_HITS = 2;
// 毒性短语只在"简短通知"里才算真实图片错误——超过此长度的消息几乎必是文件读取/日志/
// 讨论文本（短语只是恰好作为数据出现），不计数，避免"读到含这些短语的源码"被自己熔断。
const POISON_MAX_NOTICE_LEN = 4000;
const LOOP_MAX_IDENTICAL_CALLS = 3;
const LOOP_MAX_TURN_TOOLCALLS = 120;
const LOOP_MAX_AUTO_RECOVER = 2;

// 每张图片 tool_result 累计到该阈值就提醒用户 /clear（stream-json 模式不支持 /compact）
const IMAGE_NUDGE_STEP = 15;

// 停摆看门狗：busy 且"在等模型/API 响应"（非在等工具执行）却超过该时长没有任何 stream
// 消息，判定为传输层重试卡死，强制 interrupt。只在等模型时计时，等工具(长 Bash/构建)不计，
// 避免误伤长任务。可用环境变量 MYHI_STALL_WATCHDOG_MS 覆盖（默认 4 分钟）。
const STALL_WATCHDOG_MS = Number(process.env.MYHI_STALL_WATCHDOG_MS) || 4 * 60 * 1000;
const STALL_CHECK_INTERVAL_MS = 30 * 1000;
// AI 提问 / 提交方案后等用户的上限：到点自动按「请按最佳判断继续 / 暂不执行」回复，免得任务永远卡住
const INTERACTION_WAIT_MS = Number(process.env.MYHI_ASK_WAIT_MS) || 30 * 60 * 1000;
const INTERACTION_WAIT_FOLLOW_MS = Number(process.env.MYHI_ASK_WAIT_FOLLOW_MS) || 3 * 60 * 1000;   // 开了自动跟进（无人值守）

// 自动接力：result 收尾后隔这么久再发下一条草稿。留出的窗口用来躲开熔断纠偏注入，
// 也给人一点「等等别发」的反应时间（会话一旦重新 busy 就自动让位）。
const INJECT_FOLLOW_WAIT_MS = Number(process.env.MYHI_INJECT_WAIT_MS) || 20000;   // 本轮收尾后等 claude 接插话开新一轮的上限
const RELAY_DELAY_MS = Number(process.env.MYHI_RELAY_DELAY_MS) || 3000;

// 自动跟进：长任务"完成后自动汇报进度"，免用户反复问。默认关，间隔默认 15 分钟(可调)、最多 5 次。
const FOLLOW_UP_DEFAULT_MS = 15 * 60 * 1000;
const FOLLOW_UP_MAX = 5;
const FOLLOW_UP_PROMPT = '【自动跟进·系统触发】请检查当前正在进行的后台任务或上一步操作的进度：有新进展就简要汇报；仍在进行就说明还在跑、预计还需多久；若已【全部完成】，请汇总最终结果，并在回复最后单独一行只写 [跟进完成]（系统据此停止自动跟进）。不要重复已汇报过的内容。';

// 注入到每个 agent 会话的系统提示：从源头减少图片死循环
const MYHI_SYSTEM_PROMPT = [
  '图片与截图处理约束（重要，用于避免 API 图片错误与死循环）：',
  '1. 截图优先只截当前视口，不要整页长截图；图片长边尽量 ≤1568px、高度不要超过 8000px，否则会被 API 拒绝。',
  '2. 若出现 "an image ... could not be processed and was removed" 或图片被移除的错误，说明该图片已不可用，',
  '   不要用 Read 反复重新读取它；请基于已有文字信息继续，必要时请用户重新上传一张更小的截图。',
  '3. 同一个工具用完全相同的参数连续失败时，不要原样重试，换方法或跳过。',
  '',
  '{{MODE}}',
  '',
  '杀进程约束（重要，事关本会话存活）：托管你的 myhi 自己就是一个 node 进程，你是它的子进程。',
  '绝对禁止按「进程名」批量杀进程：taskkill /F /IM node.exe、pkill node、killall node、Stop-Process -Name node 全都禁止——',
  '它们会把 myhi 连同本会话一起杀死，工具结果再也写不回来，这条命令会永远停在未完成状态，',
  '下次 --resume 又被重放、再杀一次，形成无限自杀循环（真实发生过）。',
  '要重启某个服务，必须精确定位那一个进程：先按它监听的端口查 PID，再按 PID 杀。',
  'Windows: netstat -ano | findstr :<端口>  然后 taskkill /F /PID <pid>；Linux: lsof -ti:<端口> | xargs -r kill。',
  '同理，不要顺手 rm -rf 数据目录/上传目录，除非用户明确要求删。',
  '',
  '子代理（Task 工具）使用建议：遇到「大范围代码检索 / 多文件审计 / 可并行的独立子任务 / 需要海量读取但只回结论」这类重活，',
  '优先用 Task 工具起子代理去 fan-out——把中间过程隔离在子上下文里、只把结论收回主线，既省主上下文又更快。',
  '子代理内部的工具调用不会撑爆主线的单轮工具预算（已豁免），放心用；但简单的单文件小改动直接自己做，不必起子代理。',
].join('\n');

// 执行模式说明按会话模式替换进 {{MODE}}（⚠️ 会拍平成单行塞进 cmd 双引号参数：不得含 ASCII 双引号）。
// 自动执行（bypass）：想好就做，别编造审批按钮；交互通道可用时允许在关键决策上用 AskUserQuestion 提问。
const EXEC_MODE_PROMPT = [
  '执行模式约束（重要）：本会话是无人值守自动执行模式，没有文件编辑授权、审批按钮这类交互。',
  '你想好方案就直接用工具执行，绝不要说「等待批准」「请点击确认按钮」「需要你授权」之类的话——',
  '那些 UI 在这里不存在，说了只会让任务永久卡住。若某个工具报权限/授权错误，直接基于现状继续或换做法，不要空等用户点按钮。',
].join('\n');
const ASK_PROMPT = '遇到需要用户拍板的关键决策（方向性取舍、不可逆操作、明显影响结果的选择），可以用 AskUserQuestion 提问，' +
  '用户会在界面上作答；一般细节按最佳判断自己定，不要频繁提问。用户长时间未答会收到「请按最佳判断继续」，此时自行决定并说明你的假设。';
// 计划模式：只调研出方案，不改东西（原来计划模式也带着「没有计划模式、直接执行」那段，模型一上来就去写文件被拒、
// 不知所措，还会用英文回复）。交互通道可用时让它用 ExitPlanMode 提交方案，用户在界面上批准后直接进入执行。
function planModePrompt(interactive) {
  return [
    '计划模式（重要）：用户开启了计划模式——这一轮只做调研和出方案，不修改任何东西。',
    '可以读文件、搜索代码、查资料；不要尝试写入/修改/删除文件或执行有副作用的命令（会被拒绝）。',
    '用中文把完整方案写清楚：目标、要改哪些地方、分步骤做法、风险和需要用户确认的点。',
    interactive
      ? '方案写好后调用 ExitPlanMode 提交（plan 参数里放完整方案），用户在界面上批准后你会直接进入执行；若用户要求修改，按意见改好再提交。'
      : '把完整方案直接写在回复里，写完就停下；用户确认后会退出计划模式让你执行。',
  ].join('\n');
}

// Windows 中文乱码：PowerShell 5.1 / cmd 往管道写的是控制台代码页（GBK），claude 按 UTF-8 解码 →
// 工具结果里中文变 �（字节已丢，myhi 前端无从还原，模型自己也读不懂）。只能让命令从源头输出 UTF-8。
// ⚠️ 会被拍平成单行塞进 cmd 命令行的双引号参数里：内容不得含双引号。
const MYHI_WIN_ENCODING_PROMPT = [
  '',
  'Windows 中文输出编码（重要）：PowerShell 5.1 和 cmd 向管道输出用的是 GBK 代码页，工具结果里的中文会变成 � 乱码。',
  '运行 powershell 命令时在脚本开头加 [Console]::OutputEncoding=[Text.Encoding]::UTF8; ，cmd 命令前先 chcp 65001>nul（Python 已由环境变量强制 UTF-8）。',
  '若工具结果仍出现 � 乱码，按上述方式重跑后再下结论，不要基于乱码内容猜测。',
].join('\n');

// npm 装 myhi 不会顺带装 Claude Code（它是独立的包），新机器第一次发消息就会 spawn ENOENT。
// 别甩英文报错，直接告诉用户怎么装。
// 起 claude 子进程的基础环境：去掉宿主 Claude Code 的标记变量 + 注入用户配置的大模型网关（覆盖系统 env）。
// 会话进程（_buildEnv 再叠加密钥库等）和「问一问」的一次性调用（aside.js）共用。
export function buildBaseClaudeEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  try {
    const gatewayFile = join(homedir(), '.myhi', 'gateway.json');
    if (existsSync(gatewayFile)) {
      const cfg = JSON.parse(readFileSync(gatewayFile, 'utf8').replace(/^\uFEFF/, ''));
      if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
      if (cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
    }
  } catch {}
  return env;
}

/**
 * myhi 自己配了网关（~/.myhi/gateway.json）时，给 claude 加 --settings，让它压过 ~/.claude/settings.json 里的网关。
 * 实测：Claude Code 启动时用 settings.json 的 env 覆盖进程环境变量——只靠上面注入 ANTHROPIC_BASE_URL，
 * settings.json 里也配了网关时请求会发到 settings.json 那个地址、却带着 myhi 的 key。
 * --settings 只对 myhi 拉起的 claude 生效，不改 ~/.claude/settings.json，终端里直接用 claude 不受影响。
 * key 同时写 API_KEY 和 AUTH_TOKEN：免得 settings.json 里另一个 AUTH_TOKEN 被一起带上。文件 600，和 gateway.json 同级。
 */
export function gatewaySettingsArgs() {
  try {
    const dir = join(homedir(), '.myhi');
    const cfg = JSON.parse(readFileSync(join(dir, 'gateway.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!cfg.baseUrl || !cfg.apiKey) return [];
    const file = join(dir, 'claude-gateway.settings.json');
    const body = JSON.stringify({ env: { ANTHROPIC_BASE_URL: cfg.baseUrl, ANTHROPIC_API_KEY: cfg.apiKey, ANTHROPIC_AUTH_TOKEN: cfg.apiKey } }, null, 2);
    let old = null; try { old = readFileSync(file, 'utf8'); } catch {}
    if (old !== body) writeFileSync(file, body, { mode: 0o600 });
    return ['--settings', file];
  } catch { return []; }
}

/** Claude 对话记录 ~/.claude/projects/<项目>/<id>.jsonl 还在不在 */
function claudeTranscriptExists(id) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(dir, e.name, id + '.jsonl'))) return true;
    }
  } catch (e) { return e.code !== 'ENOENT'; }   // 目录不存在 = 记录确实没了；其它读不了（权限等）别误判，照常 --resume
  return false;
}

export const CLAUDE_MISSING_MSG = '这台电脑还没安装 Claude Code（myhi 的 AI 引擎），AI 任务暂时用不了。' +
  '管理员可在首页点「安装 AI 引擎」一键安装，或在这台电脑上执行：npm i -g @anthropic-ai/claude-code ；' +
  '装好后在终端运行一次 claude 完成登录（或在管理后台配置大模型网关）。';

// 权限模式归一化。myhi 是无人值守、没有工具授权 UI 的工具：任何未知/空/遗留别名
// 一律回落到 bypassPermissions，绝不能静默落到 default —— default 模式下 Write/删除
// 需要在终端点授权，而 myhi 无从批准，会导致回合永久卡死（模型还会编造"终端权限弹窗"）。
//   - 'bypass' 是旧版下拉框的遗留值，代码判断的是 'bypassPermissions'，不归一化会掉进 default
//   - undefined / null / '' / 'default' / 其它 → bypassPermissions
const VALID_PERMISSION_MODES = new Set(['bypassPermissions', 'plan', 'acceptEdits']);
function normalizePermissionMode(mode) {
  if (mode === 'bypass') return 'bypassPermissions'; // 遗留下拉框别名
  if (VALID_PERMISSION_MODES.has(mode)) return mode;
  return 'bypassPermissions';
}

// ---------------------------------------------------------------------------
// AgentSession
// ---------------------------------------------------------------------------

// /clear 提示里的来源页面（chat.html 握手时上报的 where）
const CLEAR_WHERE = { grid: '分屏工作台', workbench: '电脑端工作台', mobile: '手机/平板', desktop: '电脑浏览器' };

export class AgentSession extends EventEmitter {
  constructor(id, opts = {}) {
    super();

    this.id = id;
    this.createdAt = opts.createdAt || new Date().toISOString();
    this.title = opts.title || 'claude';
    this.cwd = opts.cwd || process.env.MYHI_CWD || process.cwd();
    this.tags = Array.isArray(opts.tags) ? opts.tags : [];
    // 第一条真人消息（脱敏后，截断）—— 会话列表拿它当副标题，解决「一堆会话都叫 claude，
    // 想不起哪个干过什么」。持久化到 sessions.json，重启/恢复后仍在。
    this.firstUserText = opts.firstUserText || '';
    this.permissionMode = normalizePermissionMode(opts.permissionMode);
    // 会话自己选的模型（「模型」按钮 / /model）：要持久化，重启后照样用；没选 → 场景配置的主会话默认
    this.modelId = typeof opts.modelId === 'string' && opts.modelId.trim() ? opts.modelId.trim() : null;
    this.owner = opts.owner || null;
    this.userDir = opts.userDir || null;
    this.claudeSessionId = opts.resumeSessionId || null;
    this.mode = 'agent';
    this.alive = true;

    // Viewer / control tracking
    this._viewers = new Set();
    this._viewerNames = new Map();
    this.controlHolder = null;
    this.controlHolderName = null;
    this.lastInputTime = null;

    // Process state
    this._proc = null;
    this._busy = false;
    this._interrupted = false;
    this._buffer = '';
    this._pendingResolve = null;
    this._pendingReject = null;
    this._keepAliveTimer = null;

    // History (capped at 500 entries)
    this._history = [];

    // 死循环熔断状态
    this._loopSigCounts = new Map();  // 本轮工具调用签名 → 次数
    this._loopPoisonHits = 0;         // 本轮毒性内容命中次数
    this._loopTurnToolCalls = 0;      // 本轮工具调用总数
    this._loopTripped = false;        // 本轮是否已熔断（防重入）
    this._loopAutoRecover = 0;        // 同一人类回合已自动纠偏次数
    this._pendingSteer = null;        // 待自动注入的纠偏引导语

    // 自动跟进（长任务完成自动汇报，免用户反复问进度）。默认关。
    this._followEnabled = false;
    this._followIntervalMs = FOLLOW_UP_DEFAULT_MS; // 默认 15 分钟，可调
    this._followMax = FOLLOW_UP_MAX;               // 最多连续跟进 5 次
    this._followCount = 0;
    this._followTimer = null;
    this._relayTimer = null;                       // 自动接力（草稿队列）的延时句柄
    this._followStopSignal = false;                // 本轮 AI 是否给出 [跟进完成]

    // 图片压力提醒状态
    this._imageBlockCount = 0;        // 会话累计图片数
    this._imageNudgeAt = IMAGE_NUDGE_STEP; // 下一次提醒阈值

    // 密钥脱敏器（Layer B）：每轮 query 开始时按当前密钥库重建；null=无密钥、零开销
    this._redactor = null;

    // 隐私护栏（Layer C）：可逆假名化。出模型前把敏感实体换占位符、回模型后还原。
    // _pseudoMap 是跨轮累积的映射表（同一实体全程同一占位符），懒加载 + 持久化到 ~/.myhi。
    this._pseudo = null;
    this._pseudoMap = null;

    // 停摆看门狗状态
    this._lastActivityAt = opts.lastActivityAt || 0;  // 最后一条 stream 消息时间（恢复时由持久值/transcript 回填）
    this._awaitingTool = false;       // true=在等工具执行(长任务,不计时) false=在等模型/API
    this._watchdogTimer = null;

    // Usage / cost tracking。恢复会话时从持久化配置读回历史累计（此前无条件清零，
    // 服务器重启后所有会话用量一夜归零）。
    this._usage = {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      queryCount: 0,
      rateLimitInfo: null,
      modelUsage: {},
      ...(opts.usage || {}),
      modelUsage: { ...(opts.usage?.modelUsage || {}) },
    };
    // 进程内累计基线：claude 常驻进程的 result 消息里 usage/cost 是「本进程启动起的
    // 累计值」而非本轮增量，每条 result 按「基线 + 累计值」整体赋值记账（见
    // _handleMessage 的 result 分支）。基线必须是「本进程启动前」的历史账——spawn 时
    // 冻结快照，进程重启（/clear、/model、崩溃）后 claude 累计从 0 重来，自然衔接不丢账。
    this._usageBase = JSON.parse(JSON.stringify(this._usage));
    this._procQueryCount = 0; // 本进程内的 result 条数（queryCount = 基线 + 此值）

    // 上下文水位：最新一条消息的 input+cache 读/写 ≈ 当前上下文里的 token 总量。
    // 给前端「上下文 xx%」指示与压缩提示用；claude 满 ~90% 会 auto-compact，myhi 的价值
    // 是让用户在任务节点**主动**压缩（更可控、保留重点）。
    this._contextTokens = 0;

    // If resuming, load history from disk
    if (this.claudeSessionId) {
      this._loadResumedHistory();
    }
  }

  // -----------------------------------------------------------------------
  // Build environment for the child process
  // -----------------------------------------------------------------------

  _buildEnv() {
    const env = buildBaseClaudeEnv();

    if (this.userDir) {
      const gitconfig = join(this.userDir, '.gitconfig');
      if (existsSync(gitconfig)) {
        env.GIT_CONFIG_GLOBAL = gitconfig;
      }
    }

    // Windows：让 AI 跑的 Python 往管道输出 UTF-8（默认按 GBK 代码页，工具结果中文成乱码）
    if (process.platform === 'win32') {
      env.PYTHONUTF8 = '1';
      env.PYTHONIOENCODING = 'utf-8';
    }

    // 注入命名密钥库（Layer A）：global ⊕ 本会话 cwd 的项目密钥 → 环境变量 / 文件路径。
    // AI/命令用 $NAME（或 $MYHI_SECRET_NAME 取证书路径）引用，密钥值不进会话。见 secrets.js。
    try { applySecretsToEnv(env, this.cwd); } catch {}

    // 场景模型（同一网关 + token）：子代理、后台小任务各用各的。Claude Code 的轻量模型位就是 haiku 别名，
    // 后台标题 / 摘要等走它；老名字 ANTHROPIC_SMALL_FAST_MODEL 一并设上，兼容旧版 claude
    // 计划场景：opusplan = 计划阶段用 opus 位、执行阶段用 sonnet 位 → 两个位分别填计划模型和主任务模型。
    // 不论是 /plan 切出还是在界面里批准方案（同一进程内直接转执行），claude 自己都会换模型
    const plan = this._modelPlan();
    if (plan.opus) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = plan.opus;
      // opusplan 在计划阶段会把 opus 位当成 1M 上下文（带 context-1m 头、到 1M 才自动压缩）；
      // 映射到的是网关上的其它模型，上下文没那么大 → 关掉 1M，按正常窗口压缩
      env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
    }
    if (plan.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = plan.sonnet;
    const sub = sceneModel('subagent'), bg = sceneModel('background');
    if (sub) env.CLAUDE_CODE_SUBAGENT_MODEL = sub;
    if (bg) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = bg; env.ANTHROPIC_SMALL_FAST_MODEL = bg; }

    return env;
  }

  // -----------------------------------------------------------------------
  // Build CLI arguments
  // -----------------------------------------------------------------------

  // 本次启动 claude 用哪个模型：主任务 = 会话自己选的 || 场景「主任务」；配了「计划」场景时：
  //   主任务是具体模型名 → --model opusplan + 两个位映射（见 _buildEnv）
  //   主任务是 Claude 别名 / 没配 → 映射不了（别名指向谁不由我们定），退一步：计划模式下启动时直接用计划模型
  /**
   * 看图转文字：消息里引用了聊天框上传的图片（upload/ 或 uploads/ 下）时——
   *   配了「看图」场景模型 → 一律先让它把每张图描述成文字，改写 prompt：去掉「请用 Read 读取图片」，附上描述
   *     （配了就用：网关的能力标注不一定准，GLM 等标了能看图、实际收到图片被换成 URL）；主模型就是看图模型时不转；
   *   没配 → 原样发；网关明确标注主模型看不了图时提示一句去配。
   * 只管经对话框提交的图；AI 自己用 Read 读磁盘上的图 myhi 拦不到（同隐私护栏的边界）。
   */
  async _prepareImages(prompt, { pro = false } = {}) {
    if (typeof prompt !== 'string' || prompt.startsWith('/')) return prompt;
    // 各段限长：以前前缀懒匹配无上限，一长串 '/' 就平方级回溯卡住整个 server
    const re = /(?:[A-Za-z]:)?[\\/][^\s，。、；;,"'`()（）]{0,400}?[\\/]uploads?[\\/][^\s\\/，。、；;,"'`()（）]{1,255}?\.(?:jpe?g|png|gif|webp)(?![A-Za-z0-9])/gi;
    const paths = [...new Set(prompt.match(re) || [])].filter((x) => { try { return statSync(x).isFile(); } catch { return false; } });
    if (!paths.length) return prompt;
    const main = this._currentModel();
    const name = main || 'Claude Code 默认模型';
    // 这条消息勾了「🔍 高精度看图」且配了高精度模型 → 用它；否则用日常的看图模型（高精度没配就退回日常的）
    const vision = (pro && sceneModel('visionPro')) || sceneModel('vision');
    const info = (message, extra) => {
      const m = { type: 'system', subtype: 'info', message, ...extra };
      this._history.push({ ...m, timestamp: Date.now() });
      this.emit('agent:message', m);
    };
    if (!vision) {
      // 没配看图模型：图片照常发给主模型；网关明确标注它看不了图时提醒一句
      if (await modelSeesImages(main) === false) info(`🖼 当前模型 ${name} 看不了图，AI 可能读不出这张图片。可在首页 ⚙ 设置 › 系统设置 · 模型 › 看图 配一个能看图的模型（会先把图转成文字），或在聊天框把模型换成能看图的`);
      return prompt;
    }
    if (vision === main) return prompt;   // 主模型本身就是看图模型：直接看原图
    // 用户的要求一并告诉看图模型（让相关细节写细些）；它也是外部模型 → 走隐私护栏假名化
    let question = (prompt.match(/用户的要求是：([\s\S]*)$/) || [])[1] || '';
    if (question && this._pseudo?.enabled) question = this._pseudo.pseudonymize(question).text;
    // 本地看图模型一次只看一张：多张图 / 前面有人在排队时，说一下大概要等多久
    const ahead = visionBacklog(vision);
    const wait = vision === sceneModel('vision') && (paths.length > 1 || ahead)
      ? `（一次只看一张，每张约 10~60 秒${ahead ? `，前面还有 ${ahead} 张在排队` : ''}）` : '';
    this.emit('agent:message', { type: 'system', subtype: 'info', message: `🖼 正在用看图模型 ${vision} 把 ${paths.length} 张图片转成文字，再交给 ${name}…${wait}` });
    const ac = new AbortController(); this._describing = ac;
    // 看图可能要好几分钟（串行 + 排队）：这段时间不算「等模型响应」，别让停摆看门狗把这一轮中断掉
    const prevAwait = this._awaitingTool; this._awaitingTool = true;
    const t0 = Date.now();
    let out;
    try {
      out = await Promise.all(paths.map((x) => describeImage(x, { model: vision, question: question.slice(0, 500), signal: ac.signal })
        .then((text) => ({ path: x, text }), (e) => { if (ac.signal.aborted) throw e; return { path: x, error: e.message }; })));
    } finally { this._describing = null; this._awaitingTool = prevAwait; this._lastActivityAt = Date.now(); }
    if (ac.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const okN = out.filter((o) => o.text).length;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    info(okN ? `🖼 已用 ${vision} 把 ${okN} 张图片转成文字交给 ${name}（用时 ${secs} 秒）${okN < out.length ? `，${out.length - okN} 张失败` : ''}`
      : `🖼 看图模型 ${vision} 没能识别图片：${out[0].error}。按原样发送，AI 可能读不出图片`,
      okN ? { vision: { model: vision, items: out } } : undefined);
    if (!okN) return prompt;
    const body = prompt.replace(/，?请用 Read 工具(?:读取这张图片|逐一读取|读取)。/g, '。');
    return body + `\n\n（注意：myhi 已用看图模型 ${vision} 把上面的图片转成了下面的文字，直接按文字理解，不要再用 Read 读取图片文件。描述里没有的细节请如实说看不到，必要时建议用户换能看图的模型再问。）`
      + out.map((o) => `\n\n【图片 ${o.path}】\n${o.text || '（识别失败：' + o.error + '）'}`).join('');
  }

  /** 这个任务的 Claude 对话记录已经不在了（被 Claude Code 自动清理等）：改成新对话，平静地告诉用户 */
  _dropLostSession() {
    const old = this.claudeSessionId;
    if (!old) return;
    console.log(`[agent] 对话记录 ${old} 已不在（多半是 Claude Code 自动清理了 30 天以上没用的记录），开始新对话`);
    this.claudeSessionId = null;
    this.emit('session-id');   // 让 SessionManager 落盘，下次别再拿旧编号去续
    this.emit('agent:message', { type: 'system', subtype: 'info', message:
      '📭 这个任务很久没用，Claude Code 已自动清理了它之前的 AI 对话记录（默认保留 30 天），AI 不记得之前聊过的内容。已自动开始新对话来处理你这条消息；项目文件不受影响，需要的话把背景再简单交代一下即可' });
  }

  _modelPlan() {
    const main = this.modelId || sceneModel('main');
    const plan = sceneModel('plan');
    if (plan && plan !== main) {
      const alias = /^(opus|sonnet|haiku|fable|best|default|opusplan)(\[1m\])?$/i;
      if (main && !alias.test(main)) return { model: 'opusplan', opus: plan, sonnet: main };
      if (this.permissionMode === 'plan') return { model: plan };
    }
    return { model: main };
  }
  // 显示用：现在实际在用的模型（计划模式下是计划模型）
  _currentModel() {
    const p = this._modelPlan();
    if (p.model === 'opusplan') return this.permissionMode === 'plan' ? p.opus : p.sonnet;
    return p.model || null;
  }

  _buildArgs() {
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];

    // 注入图片/死循环相关的常驻约束，从源头减少 API 图片错误。
    // ⚠️ 必须拍平成单行：Windows 走 `cmd.exe /c claude.cmd --append-system-prompt "<多行>"`，
    // cmd 会在换行处截断命令行，把后面的 --dangerously-skip-permissions/--resume 整个丢掉 →
    // claude 静默跑进 default 模式、Edit 被拦、模型编"需要授权/计划模式"。GBK codepage 下必现。
    // 换行换成空格即彻底根治（claude 读单行系统提示完全 OK）。
    const mode = normalizePermissionMode(this.permissionMode);
    const interactive = _interactiveCap === true;
    this._interactive = interactive;
    // 插话：claude 处理 stdin 来的用户消息时回显一份（isReplay + 我们给的 uuid），见 inject()
    this._injectable = _replayCap;
    if (_replayCap) args.push('--replay-user-messages');
    const modePrompt = mode === 'plan' ? planModePrompt(interactive) : EXEC_MODE_PROMPT + (interactive ? '\n' + ASK_PROMPT : '');
    const sysPrompt = MYHI_SYSTEM_PROMPT.replace('{{MODE}}', modePrompt) + (process.platform === 'win32' ? '\n' + MYHI_WIN_ENCODING_PROMPT : '');
    args.push('--append-system-prompt', sysPrompt.replace(/\s*\n\s*/g, ' ').trim());

    // 归一化后 mode 必为 bypassPermissions / plan / acceptEdits 之一；不再有会落到
    // "--permission-mode default" 的 else 兜底（default 在 myhi 里无法授权，等于卡死）。
    if (interactive) {
      // 交互通道：AskUserQuestion / ExitPlanMode 的调用转给 myhi，由用户在界面上回答 / 审批（见 _onControlRequest）
      args.push('--permission-prompt-tool', 'stdio');
      // 模型自己进计划模式 = 无人值守卡死，永远禁；ExitPlanMode 只在计划模式里用来提交方案
      args.push('--disallowedTools', 'EnterPlanMode');
      if (mode !== 'plan') args.push('--disallowedTools', 'ExitPlanMode');
      // 计划模式下用户批准方案时要切到免授权直接执行：启动时必须声明允许，否则切换不生效（实测）
      if (mode === 'plan') args.push('--allow-dangerously-skip-permissions');
    }
    if (mode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else if (mode === 'plan') {
      args.push('--permission-mode', 'plan');
      // plan 模式默认禁网，但 WebSearch / WebFetch 是只读 IO，做方案/查文档常用，显式放开
      args.push('--allowedTools', 'WebSearch');
      args.push('--allowedTools', 'WebFetch');
    } else if (mode === 'acceptEdits') {
      args.push('--permission-mode', 'acceptEdits');
      const allowedTools = [
        'Bash(git *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)',
        'Bash(ls *)', 'Bash(cat *)', 'Bash(mkdir *)', 'Bash(cp *)',
        'Bash(mv *)', 'Bash(rm *)', 'Bash(cd *)', 'Bash(pwd)',
        'Bash(find *)', 'Bash(grep *)', 'Bash(curl *)', 'Bash(wget *)',
        'Bash(pip *)', 'Bash(python *)', 'Bash(python3 *)', 'Bash(chmod *)',
        'Bash(chown *)', 'Bash(tar *)', 'Bash(unzip *)', 'Bash(zip *)',
        'Bash(sed *)', 'Bash(awk *)', 'Bash(head *)', 'Bash(tail *)',
        'Bash(wc *)', 'Bash(sort *)', 'Bash(echo *)', 'Bash(which *)',
        'Bash(apt *)', 'Bash(apt-get *)', 'Bash(docker *)',
        'Bash(ssh *)', 'Bash(scp *)', 'Bash(rsync *)',
        'Bash(touch *)', 'Bash(diff *)', 'Bash(env *)', 'Bash(export *)',
        'Bash(source *)', 'Bash(tee *)', 'Bash(xargs *)',
        'Bash(du *)', 'Bash(df *)', 'Bash(ps *)', 'Bash(kill *)',
        'Bash(systemctl *)', 'Bash(journalctl *)', 'Bash(sudo *)',
        // 子代理：放开 Task，让 acceptEdits 模式也能 fan-out 子代理。否则 Task 未列入
        // 白名单 → 需要授权 → myhi 无授权 UI → 子代理起不来、回合卡死。WebSearch/WebFetch
        // 是只读 IO、子代理调研常用，一并放开（子代理内部的写/删仍受 acceptEdits 约束）。
        'Task', 'WebSearch', 'WebFetch',
      ];
      for (const tool of allowedTools) {
        args.push('--allowedTools', tool);
      }
    }
    // 无 else：normalizePermissionMode 已保证 mode 为上述三者之一。
    // 曾经的 "else → --permission-mode default" 是本工具最大的坑：任何未知/空值都会
    // 静默进入需要授权的 default 模式，而 myhi 没有授权 UI → 回合永久卡死。

    const { model } = this._modelPlan();
    if (model) {
      args.push('--model', model);
    }
    args.push(...gatewaySettingsArgs());   // myhi 配的网关压过 ~/.claude/settings.json（见 gatewaySettingsArgs）

    if (this.claudeSessionId) {
      // Claude Code 会自动清理 30 天以上没用的对话记录（cleanupPeriodDays）：记录没了还 --resume
      // 会报「No conversation found」并退出，用户这条消息也没被处理 → 先查一下，不在就直接开新对话
      if (claudeTranscriptExists(this.claudeSessionId)) args.push('--resume', this.claudeSessionId);
      else this._dropLostSession();
    }

    return args;
  }

  // -----------------------------------------------------------------------
  // Write JSON message to process stdin
  // -----------------------------------------------------------------------

  _writeStdin(msg) {
    if (!this._proc || !this._proc.stdin?.writable) return false;
    try {
      return this._proc.stdin.write(JSON.stringify(msg) + '\n'), true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Spawn the persistent claude CLI process
  // -----------------------------------------------------------------------

  _spawnProcess() {
    this._expectExit = false;
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }

    const launcher = findClaude();
    const args = this._buildArgs();
    const env = this._buildEnv();

    // 起新进程：claude 的 result 用量累计从 0 重来，先把当前账目冻结为基线
    // （历史账），本进程内每条 result 按「基线 + 进程内累计值」赋值记账。
    this._usageBase = JSON.parse(JSON.stringify(this._usage));
    this._procQueryCount = 0;

    // launcher = { command, preArgs }：command 是可执行文件(claude.exe / node / claude)，
    // preArgs 是它前置的固定参数(如 cli.js 入口，或 cmd 的 /c claude.cmd)。直接 spawn，
    // 绝大多数情况绕开 cmd.exe，彻底规避 cmd /c 引号剥离 → `'C:\Program' 不是内部或外部命令`。
    const command = launcher.command;
    const spawnArgs = [...launcher.preArgs, ...args];

    console.log(`[agent] 启动持久进程: ${command} ${launcher.preArgs.join(' ')} (会话: ${this.claudeSessionId || '新建'})`);

    this._proc = spawn(command, spawnArgs, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // 本进程的句柄。切模式 / 换模型时旧进程被 SIGTERM、新进程立刻起来，旧进程的 close 事件常常晚于新进程
    // 启动才到——以前 close 里直接动 this._proc，会把【新进程】置空、丢掉它正在等审批的方案、再弹一条
    // 「异常退出」红字。下面所有事件都先判断是不是自己：已被替换的旧进程的事件一律忽略。
    const proc = this._proc;
    const stale = () => this._proc !== null && this._proc !== proc;

    this._buffer = '';

    // ---- stdout ----
    // 按 UTF-8 流式解码：管道按 64KB 分块，chunk.toString() 会把跨块的汉字切成乱码 —— 切在【手机_1】里就还原不回来
    this._proc.stdout.setEncoding('utf8');
    this._proc.stderr.setEncoding('utf8');
    this._proc.stdout.on('data', (chunk) => {
      if (stale()) return;
      this._buffer += chunk.toString();
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          this._handleMessage(msg);
        } catch {
          // 非 JSON 行可能是 slash 命令的文本响应，也可能是 "API Error: an image..." 这类
          // 绕过 stream-json 的错误行 —— 一并送去毒性检测，避免死循环从这条路径漏出。
          if (line.trim()) {
            this.emit('agent:message', { type: 'system', subtype: 'info', message: line.trim() });
            this._checkDeathLoop({ type: 'system', _raw: line });
          }
        }
      }
    });

    // ---- stderr ----
    // 已知良性提示：配了网关后 claude CLI 每次启动都会往 stderr 打这条
    // （ANTHROPIC_API_KEY 使 claude.ai 登录的「连接器」失效 —— 网关用户本来就没有
    // claude.ai 登录，纯信息噪声）。不能当错误弹红框，更不能进熔断计数：
    // 它每轮 spawn 都重复，会白白积累熔断次数。
    const BENIGN_STDERR = [/connectors are disabled because/i];
    const RESUME_LOST = /No conversation found with session ID/i;
    this._proc.stderr.on('data', (chunk) => {
      if (stale()) return;
      const text = chunk.toString().trim();
      if (!text || text.includes('Warning:') || text.includes('DeprecationWarning')) return;
      // chunk 可能一次带到多行，逐行分流，只咽掉良性的
      const noisy = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (noisy.some((l) => RESUME_LOST.test(l))) this._resumeLost = true;   // 对话记录没了：退出后换新对话重发（见 close）
      const real = noisy.filter((l) => !BENIGN_STDERR.some((re) => re.test(l)) && !RESUME_LOST.test(l));
      if (noisy.length > real.length) {
        console.log(`[agent:stderr][benign] 吞掉 ${noisy.length - real.length} 条良性提示`);
      }
      if (!real.length) return;
      console.error('[agent:stderr]', real.join('\n'));
      this.emit('agent:error', { message: real.join('\n') });
      this._checkDeathLoop({ type: 'stderr', _raw: real.join('\n') });
    });

    // ---- close ----
    this._proc.on('close', (code) => {
      if (stale()) { console.log(`[agent] 旧进程退出 (code ${code})，已被新进程替换，忽略`); return; }
      // Try to parse any remaining buffer content
      if (!this._interrupted && this._buffer.trim()) {
        try {
          const msg = JSON.parse(this._buffer.trim());
          this._handleMessage(msg);
        } catch { /* ignore */ }
      }

      if (this._keepAliveTimer) {
        clearInterval(this._keepAliveTimer);
        this._keepAliveTimer = null;
      }
      this._stopStallWatchdog();
      this._proc = null;
      this._buffer = '';
      this._dropInteractions();   // 进程没了，等它回答的请求也作废
      this._dropInjected('Claude 进程已退出，这条插话没有送达');

      console.log(`[agent] 进程退出 (code ${code}), 会话: ${this.claudeSessionId || '?'}`);

      if (this._busy) {
        this._busy = false;
        this._interrupted = false;
        this.emit('agent:busy', false);
        if (this._pendingReject) {
          const err = new Error(`Claude 进程退出 (code ${code})`);
          if (this._resumeLost) err.reported = true;   // 下面会自动换新对话重发，不报错
          this._pendingReject(err);
          this._pendingResolve = null;
          this._pendingReject = null;
        }
      }

      // 熔断走了 hardkill 兜底路径时，graceful result 不会到，这里补发纠偏引导语
      this._flushPendingSteer();

      if (this._resumeLost) {
        this._resumeLost = false;
        this._dropLostSession();
        const q = this._lastQuery;
        if (q && this.alive) setTimeout(() => { if (!this._busy) this.query(q.prompt, { ...q.opts, _retry: true }).catch(() => {}); }, 300);
        return;
      }
      if (this._spawnFailed) { this._spawnFailed = false; return; }   // 启动失败已经报过原因，别再补一条「异常退出」
      // myhi 自己为切模式 / 换模型 / 换会话重启进程（SIGTERM → code 143）：不是故障，别弹红色「异常退出」
      if (this._expectExit) { this._expectExit = false; return; }
      if (this.alive && code !== 0 && code !== null) {
        this.emit('agent:error', {
          message: `Claude 进程异常退出 (code ${code})，下次查询将自动重启`,
        });
      }
    });

    // ---- error ----
    this._proc.on('error', (err) => {
      if (stale()) return;
      if (this._keepAliveTimer) {
        clearInterval(this._keepAliveTimer);
        this._keepAliveTimer = null;
      }
      this._stopStallWatchdog();
      this._proc = null;
      this._busy = false;
      this.emit('agent:busy', false);
      this._spawnFailed = true;
      this.emit('agent:error', { message: err.code === 'ENOENT' ? CLAUDE_MISSING_MSG : `启动 Claude 失败: ${err.message}` });
      err.reported = true;   // 已经告诉用户了，server 那边 catch 到别再原样转发一遍
      if (this._pendingReject) {
        this._pendingReject(err);
        this._pendingResolve = null;
        this._pendingReject = null;
      }
    });

    // ---- keep-alive timer (30s) ----
    this._keepAliveTimer = setInterval(() => {
      this._writeStdin({ type: 'keep_alive' });
    }, 30_000);
  }

  // -----------------------------------------------------------------------
  // Send a user query – lazy-spawns the process if needed
  // -----------------------------------------------------------------------

  // from：发起这条消息的 socket.id（用户在页面里发的才有）。同一会话的其他观看者靠它收到这条用户消息。
  async query(prompt, { internal = false, from = null, display = null, actor = null, visionPro = false, _retry = false } = {}) {
    if (this._busy) {
      this.emit('agent:error', { message: '正在处理中，请等待完成' });
      return;
    }

    // 用户发起的新任务：重置自动跟进计数/信号、取消待触发的跟进定时器（跟进自触发的 internal 不重置）
    if (!internal) { this._followCount = 0; this._followStopSignal = false; this._cancelFollowUp(); }

    // 本地处理的 slash 命令（stream-json 模式不支持这些命令）
    if (prompt === '/clear') {
      this.reset();
      const where = [CLEAR_WHERE[actor?.where], actor?.device].filter(Boolean).join(' · ');
      const how = actor?.via === 'button' ? '点了「清除」' : '发送了 /clear';
      const who = actor ? `${actor.name || '用户'}${where ? `（${where}）` : ''}${how}，` : '';
      console.log(`[clear] 会话 ${this.id}「${this.title || ''}」被清除：${actor ? `${actor.name || '?'} / ${CLEAR_WHERE[actor.where] || '未知页面'} / ${actor.device || '?'} / ${actor.via}` : '内部调用'}`);
      this.emit('agent:message', { type: 'system', subtype: 'info', cleared: true, message: `${who}已开始新对话：AI 不再记得之前聊过的内容（项目文件不受影响）` });
      return;
    }

    const resumeMatch = prompt.match(/^\/resume\s+(\S+)/);
    if (resumeMatch) {
      // 只能接回本项目（同一工作目录）里的对话，id 只认会话编号格式：以前不查 → `/resume ../x` 读任意 .jsonl，
      // 或接回别人项目的对话、连带加载他的隐私护栏映射表（把假名还原成真名）
      const rid = resumeMatch[1];
      const projDir = join(homedir(), '.claude', 'projects', String(this.cwd || '').replace(/[^a-zA-Z0-9]/g, '-'));
      if (!/^[0-9A-Za-z-]{8,64}$/.test(rid) || !existsSync(join(projDir, rid + '.jsonl'))) {
        this.emit('agent:message', { type: 'system', subtype: 'error', message: `找不到这个项目里的会话 ${rid.slice(0, 40)}（/resume 只能接回本项目的对话）` });
        return;
      }
      if (this._proc) {
        this._expectExit = true; try { this._proc.kill('SIGTERM'); } catch {}
        this._proc = null;
      }
      this.claudeSessionId = resumeMatch[1];
      this._pseudoMap = null; this._pseudo = null;   // 下一轮按新对话的 id 重新加载映射表
      this._history = [];
      this._buffer = '';
      this._loadResumedHistory();
      this.emit('agent:message', { type: 'system', subtype: 'info', message: `已切换到会话 ${resumeMatch[1].slice(0, 8)}...，下次提问将恢复该对话` });
      return;
    }

    const modelMatch = prompt.match(/^\/model\s+(\S+)/);
    if (modelMatch) {
      // default = 不指定，回到场景配置的主会话默认（再没有就是 Claude Code 自己的默认）
      this.modelId = modelMatch[1] === 'default' ? null : modelMatch[1];
      this.emit('settings-changed');   // 让 SessionManager 落盘：重启后还用这个模型
      if (this._proc) {
        this._expectExit = true; try { this._proc.kill('SIGTERM'); } catch {}
        this._proc = null;
      }
      const eff = this.modelId || sceneModel('main');
      this.emit('agent:message', { type: 'system', subtype: 'info', message: this.modelId ? `模型已切换为 ${this.modelId}` : `已恢复默认模型${eff ? `（${eff}）` : '（Claude Code 默认）'}` });
      return;
    }

    if (prompt === '/plan' || prompt.startsWith('/plan ')) {
      const wasPlan = this.permissionMode === 'plan';
      if (wasPlan) {
        // 退出计划模式，恢复之前的模式
        this.permissionMode = normalizePermissionMode(this._prePlanMode);
        this._prePlanMode = null;
        if (this._proc) {
          this._expectExit = true; try { this._proc.kill('SIGTERM'); } catch {}
          this._proc = null;
        }
        this.emit('agent:message', { type: 'system', subtype: 'info', message: '已退出计划模式' });
      } else {
        // 进入计划模式
        this._prePlanMode = this.permissionMode;
        this.permissionMode = 'plan';
        if (this._proc) {
          this._expectExit = true; try { this._proc.kill('SIGTERM'); } catch {}
          this._proc = null;
        }
        this.emit('agent:message', { type: 'system', subtype: 'info', message: '已进入计划模式（只规划不执行）' });
        // 如果有附带的计划描述，作为下一条消息发送
        const planText = prompt.slice(5).trim();
        if (planText) {
          setTimeout(() => this.query(planText), 500);
          return;
        }
      }
      return;
    }

    if (prompt.startsWith('/rename')) {
      this.emit('agent:message', { type: 'system', subtype: 'info', message: '会话已命名' });
      return;
    }

    if (!_retry) this._lastQuery = { prompt, opts: { internal, from: null, display, actor, visionPro } };
    this._busy = true;
    this._interrupted = false;
    this.emit('agent:busy', true);

    // 死循环熔断：每轮重置探测器；仅人类新回合清零自动纠偏计数
    this._loopSigCounts.clear();
    this._loopPoisonHits = 0;
    this._loopTurnToolCalls = 0;
    this._loopTripped = false;
    if (!internal) this._loopAutoRecover = 0;

    // 兜底脱敏（Layer B）：本轮开始按当前密钥库重建脱敏器（密钥可能中途新增/删除）。
    // null=无密钥，redactDeep 会原样返回、零开销。见 src/secrets.js。
    this._redactor = buildRedactor();

    // 隐私护栏（Layer C）：懒加载会话映射表；按当前项目配置重建假名化器（复用累积 map，
    // 保持占位符跨轮稳定）。未启用时是恒等函数、零开销。见 src/pseudo.js。
    if (!this._pseudoMap) this._pseudoMap = loadMap(this.claudeSessionId || this.id);
    this._pseudo = buildPseudonymizer(this.cwd, this._pseudoMap);

    // 停摆看门狗：本回合开始，先按"等模型响应"计时
    this._lastActivityAt = Date.now();
    this._awaitingTool = false;
    this._startStallWatchdog();

    // 脱敏后落历史：用户若在输入框贴了密钥值，历史/回放里只留占位符（claude 那侧仍收到
    // 原文，故仍推荐用 $NAME 引用而非直接贴——见 secrets.js 的 Layer A/B 说明）。
    // display：myhi 替用户拼的长指令（生成技能 / 项目说明等）在聊天里只显示一句简短说明，模型照样收到完整 prompt
    const userText = redactDeep(typeof display === 'string' && display.trim() ? display.trim().slice(0, 500) : prompt, this._redactor);
    if (!_retry) this._history.push({ type: 'user', content: userText, timestamp: Date.now() });
    // 同一任务开在多处（本机浏览器 + 远程 + 手机）时，别处只看得到 AI 回复、看不到这条提问，
    // ☰ 定位清单里也就没有它。广播给所有观看者；带 from，发送者自己本地已画过，按 from 跳过。
    if (from && !_retry) this.emit('agent:message', { type: 'user', content: userText, timestamp: Date.now(), from });
    // 会话名片：记住第一条真人消息，给会话列表当「这个任务在干啥」的副标题。
    // 用脱敏后的值（会落 sessions.json + 走列表 API）；跳过 slash 命令这类无信息量的开头。
    if (!this.firstUserText && typeof userText === 'string' && !userText.startsWith('/')) {
      this.firstUserText = userText.trim().slice(0, 160);
    }

    // 看图：主模型看不了图时，先用「看图」模型把上传的图片转成文字（见 _prepareImages）
    try { prompt = await this._prepareImages(prompt, { pro: visionPro }); }
    catch (e) {
      if (e.name === 'AbortError' || this._describeAborted) {
        this._describeAborted = false;
        this._busy = false; this._stopStallWatchdog();
        this.emit('agent:busy', false);
        this.emit('agent:message', { type: 'system', subtype: 'interrupted' });
        return;
      }
      console.warn('[看图] 出错，按原样发送:', e.message);
    }
    this._lastActivityAt = Date.now();

    // 密钥 / 网关 / 场景模型改过：环境变量和启动参数只在 AI 进程启动时生效 → 先用新设置重启进程，
    // 接着原来的对话（--resume），不用「清除」丢上下文（和 /model 换模型同一做法）
    if (this._envDirty && this._proc) {
      const why = this._envDirty;
      this._envDirty = null;
      this._expectExit = true; try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
      this.emit('agent:message', { type: 'system', subtype: 'info', message: `🔄 ${why}有变动，已带上新设置重新启动 AI（对话保留）` });
    }

    if (!this._proc) {
      if (_interactiveCap === null) await probeInteractive();   // 首次启动前探测一次 claude 是否支持交互通道
      this._spawnProcess();
    }

    return new Promise((resolve, reject) => {
      this._pendingResolve = resolve;
      this._pendingReject = reject;

      // Slash 命令超时保护：30 秒无响应自动解除 busy 状态
      if (prompt.startsWith('/')) {
        this._slashTimeout = setTimeout(() => {
          if (this._busy) {
            this._busy = false;
            this._interrupted = false;
            this.emit('agent:busy', false);
            this.emit('agent:message', { type: 'system', subtype: 'info', message: `命令 ${prompt} 已发送` });
            if (this._pendingResolve) {
              this._pendingResolve(0);
              this._pendingResolve = null;
              this._pendingReject = null;
            }
          }
        }, 30000);
      }

      // 隐私护栏（Layer C）：发给 claude 之前把敏感实体替换成占位符——模型/第三方网关只看到
      // 假名。用户自己这条消息在 history 里保留真名（上面已 push），只有【出向模型】这一路脱敏。
      let outbound = prompt;
      if (this._pseudo?.enabled) {
        const pr = this._pseudo.pseudonymize(prompt);
        outbound = pr.text;
        const key = this.claudeSessionId || this.id;
        saveMap(key, this._pseudoMap);
        if (pr.count > 0) {
          // 审计留痕：记本轮脱敏数/类型分布 + 发给模型的脱敏后全文（不含真值），可导出取证
          appendAudit(key, {
            ts: Date.now(), level: this._pseudo.level,
            maskedCount: pr.count, byType: pr.byType, sentToModel: this._redactor ? this._redactor(pr.text) : pr.text,
          });
          this.emit('agent:message', {
            type: 'system', subtype: 'info',
            message: `🛡 隐私护栏：本轮已脱敏 ${pr.count} 处敏感信息，模型只看到占位符（映射表留本机、可逆还原）。`,
          });
        }
      }

      const ok = this._writeStdin({
        type: 'user',
        uuid: randomUUID(),
        message: { role: 'user', content: outbound },
      });

      if (!ok) {
        this._busy = false;
        this.emit('agent:busy', false);
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(new Error('Claude 进程不可写'));
      }
    });
  }

  // -----------------------------------------------------------------------
  // Handle incoming messages from the claude CLI
  // -----------------------------------------------------------------------

  _handleMessage(msg) {
    const hadSessionId = !!this.claudeSessionId;

    // 停摆看门狗：收到任何消息即刷新活跃时间；并判断当前是在等工具还是在等模型
    this._lastActivityAt = Date.now();
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      // AI 自己开了一轮（后台命令 / 子代理结束时 claude 收到 <task-notification> 会自动接着干，不经过 query）：
      // myhi 还以为空闲 → 首页列表显示「新完成」、会话页却在「执行中」，草稿接力 / 新消息也会撞上正在跑的一轮。跟上，标回忙碌
      if (!this._busy && !msg.parent_tool_use_id) {
        this._busy = true;
        this._interrupted = false;
        this.emit('agent:busy', true);
        this._lastActivityAt = Date.now();
        this._startStallWatchdog();
      }
      // 模型发起了 tool_use → 接下来在等工具执行（长 Bash/构建正常无消息，不计时）
      if (msg.message.content.some((b) => b.type === 'tool_use')) this._awaitingTool = true;
    } else if (msg.type === 'user') {
      // 工具结果回来了 → 重新回到"等模型响应"，此时静默过久才算传输层卡死
      this._awaitingTool = false;
    }

    // 交互通道：claude 要 myhi 回答的请求（AskUserQuestion / ExitPlanMode / 其他工具的授权）
    if (msg.type === 'control_request') { this._onControlRequest(msg); return; }
    if (msg.type === 'control_response') return;   // 对我们发出的 interrupt 的回执，无需处理
    // --replay-user-messages 的回显：claude 开始处理某条 stdin 用户消息了。普通提问的回显直接丢（已经显示过）；
    // 插话的回显 = AI 已经看到它，见 _onReplay
    if (msg.type === 'user' && msg.isReplay) { this._onReplay(msg); return; }
    // 方案被批准后 claude 在进程内切到 bypass，会发 system/status 带新的 permissionMode：同步给 myhi 和界面
    if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) {
      const m = normalizePermissionMode(msg.permissionMode);
      if (VALID_PERMISSION_MODES.has(msg.permissionMode) && m !== this.permissionMode) {
        this.permissionMode = m;
        if (m !== 'plan') this._prePlanMode = null;
        this.emit('mode-changed', m);
      }
      return;
    }

    // Track session id
    const _pseudoKey = this.claudeSessionId || this.id;
    if (msg.session_id && !this.claudeSessionId) {
      this.claudeSessionId = msg.session_id;
    }
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      this.claudeSessionId = msg.session_id;
    }
    if (!hadSessionId && this.claudeSessionId) {
      this.emit('session-id', this.claudeSessionId);
    }
    if ((this.claudeSessionId || this.id) !== _pseudoKey && this._pseudoMap) {
      // 首轮（按 myhi id 存的）整体迁走；claude 换了 id（fork）则只把累积映射表另存一份到新 id
      if (_pseudoKey === this.id) adoptKey(this.id, this.claudeSessionId, this._pseudoMap);
      else saveMap(this.claudeSessionId, this._pseudoMap);
    }

    // 中毒会话自愈：myhi 无人值守要的是 bypass，但 --resume 一个存成 plan/default 的会话时，
    // claude 会用会话持久化的模式覆盖命令行 --dangerously-skip-permissions，且运行时无法再提权
    // （控制协议直接拒）。此时写/删被永久拦、点「退出计划」也没用（切 bypass 后又 resume 回原模式），
    // 模型还会编造"终端权限弹窗/请点击确认按钮"。init 带真实 permissionMode，一旦 ≠ 要的 bypass，
    // 说明这条 resume 已中毒——直接 reset（杀进程 + 断开 claudeSessionId + 归一化模式回 bypass），
    // 让用户重发指令时开一条干净的 bypass 会话。只在意图 bypass 时触发，不误伤主动进的 plan。
    if (
      msg.type === 'system' && msg.subtype === 'init' &&
      this.permissionMode === 'bypassPermissions' &&
      msg.permissionMode && msg.permissionMode !== 'bypassPermissions'
    ) {
      const badMode = msg.permissionMode;
      this.reset(); // 杀进程 + 清 claudeSessionId/history + 模式归一化回 bypass
      this.emit('agent:message', {
        type: 'system', subtype: 'warning',
        message: `⚠️ 这个会话被 --resume 带回了「${badMode}」模式（非 bypass，会拦写/删且无法运行时提权，` +
          `点「退出计划」也逃不掉）。已自动断开旧会话链、重开为干净的 bypass 会话——请重发你刚才的指令，这次会直接执行。`,
      });
      return; // history 已被 reset 清空，别再往下走
    }

    // Record in history — 剥离大 base64 payload（截图等），避免 socket agent:history 一次性
    // 推 500 条 heavy image 让浏览器 DOM/decode 卡死。live emit 仍走原 msg 不影响本轮显示。
    // entryStr 是剥离大 base64 后的定长串，复用给毒性检测与图片计数，避免对大图重复 stringify。
    // 兜底脱敏（Layer B）：把已知密钥明文值替换成 «SECRET:NAME» 占位符，再落 history / 广播。
    // 即使 AI 手滑 echo 出 token、或某 tool_result 带出密钥，UI/回放里也只见占位符。
    // 隐私护栏（Layer C）：先把模型输出里的占位符【类型_N】还原成真名（restore 是字符串→字符串，
    // 直接复用 redactDeep 的走树能力），用户看到真实实体；再走密钥脱敏（Layer B）。
    const restored = this._pseudo?.enabled ? redactDeep(msg, this._pseudo.restore) : msg;
    const safeMsg = redactDeep(restored, this._redactor);

    const entry = stripHeavyPayload({ ...safeMsg, timestamp: Date.now() });
    const entryStr = JSON.stringify(entry);
    // 自动跟进：AI 判断任务全部完成会输出 [跟进完成]，据此在本轮结束后停止跟进循环
    if (this._followEnabled && entryStr.includes('[跟进完成]')) this._followStopSignal = true;
    if (entryStr.length > 10240) {
      entry._truncated = true;
    }
    this._history.push(entry);

    const MAX_HISTORY = 500;
    if (this._history.length > MAX_HISTORY) {
      this._history = this._history.slice(-MAX_HISTORY);
    }

    // 图片累积到阈值就提醒用户 /clear（图片越多越易触发 API 图片错误并烧额度）
    this._trackImagePressure(entryStr);

    // 死循环熔断探测（图片反复剥离 / 相同工具反复失败 / 单轮工具超预算）
    this._checkDeathLoop(msg, entryStr);

    // Track rate-limit info
    if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
      this._usage.rateLimitInfo = msg.rate_limit_info;
    }

    // Track usage / cost on result messages。
    // ⚠ result 里的 usage/total_cost_usd/modelUsage 是「claude 进程启动起的累计值」，
    // 不是本轮增量（实测：同进程两轮，第二轮 result 含第一轮全部用量）。直接 += 会把
    // 累计值当增量再叠一遍，近似平方级虚账（N 轮后第 1 轮被记 N 次）。正确记法：
    // 「spawn 时快照的历史账 base + 当前累计值」整体赋值——进程内存活期增量天然正确，
    // 进程重启后 base 保住历史账，新进程从 0 开始累计再叠加。
    if (msg.type === 'result') {
      const b = this._usageBase;
      this._procQueryCount = (this._procQueryCount || 0) + 1;
      this._usage.queryCount = b.queryCount + this._procQueryCount;

      if (msg.total_cost_usd) {
        this._usage.totalCostUSD = b.totalCostUSD + msg.total_cost_usd;
      }
      if (msg.usage) {
        this._usage.totalInputTokens = b.totalInputTokens + (msg.usage.input_tokens || 0);
        this._usage.totalOutputTokens = b.totalOutputTokens + (msg.usage.output_tokens || 0);
        this._usage.totalCacheReadTokens = b.totalCacheReadTokens + (msg.usage.cache_read_input_tokens || 0);
        this._usage.totalCacheCreationTokens = b.totalCacheCreationTokens + (msg.usage.cache_creation_input_tokens || 0);
      }

      if (msg.modelUsage) {
        for (const [model, data] of Object.entries(msg.modelUsage)) {
          const mb = b.modelUsage[model] || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
          this._usage.modelUsage[model] = {
            inputTokens: mb.inputTokens + (data.inputTokens || 0),
            outputTokens: mb.outputTokens + (data.outputTokens || 0),
            costUSD: mb.costUSD + (data.costUSD || 0),
          };
        }
      }
    }

    // 上下文水位更新：live 流认 **assistant** 消息的 usage（单次 API 调用 = 当前真实上下文）。
    // ⚠ result 消息的 usage 是「claude 进程启动以来所有调用的累计值」（1.3.162 实测确认，
    // 与用量记账同源），拿它算水位会把长会话越顶越高——轮末突然报 231% 而实际 21% 就是它。
    // ⚠ claude CLI 2.1.292 起 stream 的 assistant 事件 usage 被清零（实测 {input_tokens:0}），
    // 真实 usage 只剩 transcript 里的 assistant 记录——result 时从 transcript 末尾反查兜底。
    // 上升照记；骤降过半视为发生压缩（手动 /compact 或 ~90% auto-compact），接受回落——
    // 否则压缩后水位永远停在压缩前的高值（1.3.154 的「只升不降」把变小的新 usage 全丢了）。
    // 小幅下降（前后消息 usage 抖动）仍忽略，取 max。
    {
      let u = msg.type === 'assistant' ? msg.message?.usage : null;
      if (msg.type === 'result') {
        u = this._readTranscriptCtx() || u;
      }
      if (u) {
        const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (t > this._contextTokens || (this._contextTokens > 0 && t < this._contextTokens * 0.5)) {
          this._contextTokens = t;
        }
      }
    }

    // Broadcast to listeners（脱敏后的 safeMsg，避免密钥经 socket 广播给其它在线端）。
    // 放在记账之后：result 附带刚算准的 ctxTokens，前端水位/压缩提示不必自己再算。
    if (msg.type === 'result') safeMsg.ctxTokens = this._contextTokens;
    // 还有插话没被看到：claude 收尾后会拿它开新一轮，告诉界面别显示空闲（见下方 result 处理）
    if (msg.type === 'result' && this._injected?.size) safeMsg.injectPending = true;
    this.emit('agent:message', safeMsg);

    // When a result arrives the query is done
    if (msg.type === 'result') {
      if (this._slashTimeout) { clearTimeout(this._slashTimeout); this._slashTimeout = null; }
      this._stopStallWatchdog();
      // 本轮是「干净收尾」还是被中断/出错收尾 —— 决定要不要自动接力下一条草稿。
      // 必须在 _interrupted 被清掉之前抓下来。
      const cleanFinish = !this._interrupted && !msg.is_error;
      if (this._pendingResolve) {
        this._pendingResolve(0);
        this._pendingResolve = null;
        this._pendingReject = null;
      }
      this._lastResultAt = Date.now();
      // 还有插话没被看到（AI 这一轮最后在写总结，中间没有「下一步」，或这一轮被中断了）：claude 收尾后会马上
      // 拿它开新一轮（两种都实测过——中断也不会丢掉已排队的插话），别报空闲、别接力草稿 / 自动跟进，等那一轮结束。
      // 万一 claude 没接（理论上不该），超时后放行并提示。
      if (this._injected?.size) {
        this._interrupted = false;
        this._lastActivityAt = Date.now();
        this._startStallWatchdog();
        clearTimeout(this._injectWaitTimer);
        this._injectWaitTimer = setTimeout(() => {
          if (!this._injected?.size || !this._busy) return;
          this._dropInjected('AI 没有接收这条插话，请重新发送');
          this._busy = false;
          this.emit('agent:busy', false);
        }, INJECT_FOLLOW_WAIT_MS);
        return;
      }
      this._busy = false;
      this._interrupted = false;
      this.emit('agent:busy', false);
      // 这一轮里技能有变化（比如 AI 刚按「生成技能」写好了文件）：收尾后重启进程重新加载
      if (this._skillsDirty) setTimeout(() => { if (!this._busy) this.refreshSkills(); }, 0);
      // 熔断后自动注入纠偏引导语（回合已收尾，busy 已 false）
      this._flushPendingSteer();
      // 自动接力：本轮干净干完 → 若收件箱里有本会话勾了「自动接力」的草稿，发下一条。
      // 被中断 / 出错收尾时不接力，留给人工（接着往一个刚被打断的会话里灌活儿没意义）。
      if (cleanFinish) this._maybeRelayDraft();
      // 自动跟进：回合结束、会话空闲后，若开启则安排下一次进度跟进
      this._maybeScheduleFollowUp();
    }
  }

  // -----------------------------------------------------------------------
  // 死循环熔断探测
  //   在 _handleMessage 中对每条 stream 消息调用；命中即 interrupt() + 自动纠偏。
  // -----------------------------------------------------------------------

  // 统计会话累计图片数，越积越多越容易触发 API 图片错误，跨过阈值就提醒用户 /clear
  _trackImagePressure(entryStr) {
    const imgs = (entryStr.match(/"type":"image"/g) || []).length;
    if (!imgs) return;
    this._imageBlockCount += imgs;
    if (this._imageBlockCount >= this._imageNudgeAt) {
      this._imageNudgeAt += IMAGE_NUDGE_STEP;
      this.emit('agent:message', {
        type: 'system', subtype: 'warning',
        message: `ℹ️ 本会话已累积约 ${this._imageBlockCount} 张图片。图片越多越容易触发 API 图片处理错误并拖慢/消耗额度，` +
          '建议用 /clear 重开一个干净会话，或减少后续截图。',
      });
    }
  }

  _checkDeathLoop(msg, preStr) {
    if (this._loopTripped) return; // 本轮已熔断，避免重入

    // Guard A：毒性内容（图片/内容被 API 反复剥离，并诱导模型"重新读取"）
    //   preStr 为调用方已算好的剥离串（大 base64 已替换成占位符，毒性文本仍保留）；
    //   非 JSON / stderr 路径没有 preStr，就地 stringify 这条很小的合成消息。
    // 真实的"图片被 API 剥离"错误只出现在【非 assistant】消息（平台注入到 user/tool_result/
    // system），且是一条【简短通知】。据此排除两类假阳性：① assistant 自己生成的文本提到这些
    // 短语（讨论/解释熔断器本身）；② 读到含这些短语的大块文本（读本文件源码、粘贴日志）。
    // 只有"非 assistant"且（消息里确有 image 块 或 是简短通知）才算一次真实毒性命中。
    let poison = false;
    try {
      const s = preStr || JSON.stringify(msg);
      if (LOOP_POISON_PHRASES.some((p) => s.includes(p))) {
        const isAssistant = msg.type === 'assistant';
        const hasImageBlock = s.includes('"type":"image"');
        const isShortNotice = s.length <= POISON_MAX_NOTICE_LEN;
        poison = !isAssistant && (hasImageBlock || isShortNotice);
      }
    } catch { /* ignore */ }
    if (poison) {
      this._loopPoisonHits++;
      if (this._loopPoisonHits >= LOOP_MAX_POISON_HITS) {
        this._tripLoopBreaker(
          '该图片/内容 API 反复无法处理并已被移除，请不要再用 Read 重新读取它——它已不可用。' +
          '请基于现有文字信息继续；若确实需要该图，请提示用户重新上传一张更小的截图。'
        );
        return;
      }
    }

    // Guard B / C：只看 assistant 发起的 tool_use
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      // 子代理（Task）内部的 tool_use 会带 parent_tool_use_id 冒泡到主 stream。一次
      // 子代理 fan-out 轻松几十上百次工具调用，绝不能算进主线单轮预算(C)，否则正干活的
      // 子代理会被误判死循环 interrupt 掉。B(相同入参重复)仍对子代理有效，但按上下文分桶
      // （主线 / 各子代理各自计数），避免主线与子代理、多个子代理之间的相同调用互相污染。
      const nested = !!msg.parent_tool_use_id;
      const ctx = msg.parent_tool_use_id || 'main';
      for (const block of msg.message.content) {
        if (block.type !== 'tool_use') continue;

        // C 兜底：单轮工具预算（防入参微调型死循环 / 失控 agentic）——只算主线，豁免子代理内部
        if (!nested) {
          this._loopTurnToolCalls++;
          if (this._loopTurnToolCalls > LOOP_MAX_TURN_TOOLCALLS) {
            this._tripLoopBreaker(
              `本轮工具调用已达 ${this._loopTurnToolCalls} 次并插入检查点。若仍在正常推进，请概述当前进展后继续；` +
              '若在重复同类操作而没有进展，请换一种思路，或先向用户汇报再等待指示。'
            );
            return;
          }
        }

        // B：相同工具 + 相同入参重复调用（按上下文分桶，子代理与主线互不干扰）
        const sig = `${ctx}:${block.name}:${this._hashInput(block.input)}`;
        const n = (this._loopSigCounts.get(sig) || 0) + 1;
        this._loopSigCounts.set(sig, n);
        if (n >= LOOP_MAX_IDENTICAL_CALLS) {
          this._tripLoopBreaker(
            `工具「${block.name}」已用完全相同的参数调用 ${n} 次，疑似陷入死循环。` +
            '请停止重复该调用，改用不同参数/不同工具，或跳过这一步继续。'
          );
          return;
        }
      }
    }
  }

  // 对工具入参做稳定、定长的哈希（先剥离大 base64，避免对整张图算哈希）
  _hashInput(input) {
    let str;
    try { str = JSON.stringify(stripHeavyPayload(input)); }
    catch { str = String(input); }
    if (str.length > 4096) str = str.slice(0, 4096);
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  // 触发熔断：停当前回合；未超自动纠偏上限则排队注入引导语，否则交回人工
  _tripLoopBreaker(steerMsg) {
    this._loopTripped = true;
    console.warn('[agent] 🔌 死循环熔断:', steerMsg);

    if (this._loopAutoRecover >= LOOP_MAX_AUTO_RECOVER) {
      this._pendingSteer = null;
      this.emit('agent:message', {
        type: 'system', subtype: 'warning',
        message: '⚠️ 多次自动纠偏仍未跳出循环，已停止以保护 session 额度。请 /clear 重开或换个问法。',
      });
      this.interrupt();
      return;
    }

    this._loopAutoRecover++;
    this._pendingSteer = steerMsg;
    this.emit('agent:message', {
      type: 'system', subtype: 'warning',
      message: `⚠️ 熔断保护（第 ${this._loopAutoRecover} 次自动纠偏）：${steerMsg}`,
    });
    this.interrupt();
  }

  // 回合收尾后自动注入纠偏引导语（result / close 两条路径各调一次，靠 _pendingSteer 去重）
  _flushPendingSteer() {
    if (!this._pendingSteer) return;
    const steer = this._pendingSteer;
    this._pendingSteer = null;
    setTimeout(() => {
      if (!this._busy && this.alive) {
        this.query(steer, { internal: true }).catch(() => { /* ignore */ });
      }
    }, 600);
  }

  // ── 自动跟进：长任务完成后自动汇报进度，免用户反复问（默认关，间隔可调，最多 N 次）──
  setFollowUp({ enabled, intervalMinutes } = {}) {
    if (typeof enabled === 'boolean') this._followEnabled = enabled;
    if (intervalMinutes != null) {
      const m = Math.max(1, Math.min(180, Number(intervalMinutes) || 15));
      this._followIntervalMs = Math.round(m * 60 * 1000);
    }
    if (!this._followEnabled) { this._cancelFollowUp(); this._followCount = 0; }
    else if (!this._busy) { this._maybeScheduleFollowUp(); } // 开启时若空闲，立即排一次
    this.emit('agent:message', {
      type: 'system', subtype: 'info',
      message: this._followEnabled
        ? `🔄 自动跟进已开启：每 ${Math.round(this._followIntervalMs / 60000)} 分钟自动查一次进度并汇报（最多 ${this._followMax} 次；AI 判断全部完成会自动停）。`
        : '🔄 自动跟进已关闭。',
    });
    return this.followUpState();
  }
  followUpState() {
    return {
      enabled: this._followEnabled,
      intervalMinutes: Math.round(this._followIntervalMs / 60000),
      max: this._followMax,
      count: this._followCount,
    };
  }
  _cancelFollowUp() {
    if (this._followTimer) { clearTimeout(this._followTimer); this._followTimer = null; }
  }

  // -----------------------------------------------------------------------
  // 自动接力：本轮干完后自动发出下一条草稿（灵感收件箱，见 src/inbox.js）
  //   默认关 —— 只有被明确勾了「自动接力」的草稿才会自己发出去，其余只能手动取回。
  //   放在服务端而非前端：这功能的价值恰恰在于你人不在页面前时它也照跑。
  //
  //   只在 result 干净收尾时被调用（中断/出错/进程崩溃都不调）。这里再延时确认一次，
  //   是为了躲开两种「假空闲」：熔断纠偏会在 result 之后立刻注入引导语重新 busy；
  //   用户也可能正好在这一瞬间手动发了新消息。两种情况都让位，草稿留到下一轮。
  // -----------------------------------------------------------------------

  _cancelRelay() {
    if (this._relayTimer) { clearTimeout(this._relayTimer); this._relayTimer = null; }
  }

  _maybeRelayDraft() {
    if (!this.alive || this._relayTimer) return;
    this._relayTimer = setTimeout(() => {
      this._relayTimer = null;
      if (this._busy || !this.alive) return;   // 让位：纠偏注入 / 用户手动发了新消息

      let draft = null;
      try { draft = nextAutoSendDraft(this.id); } catch { return; }
      if (!draft) return;

      // 先删再发：发送失败也不重发，免得一条草稿在循环里反复触发模型调用烧额度
      try { removeDraft(draft.id); } catch { /* ignore */ }

      const prompt = buildDraftPrompt(draft);
      if (!prompt.trim()) return;
      this.emit('agent:message', {
        type: 'system', subtype: 'info',
        message: '📥 自动接力：上一轮已完成，发出下面这条草稿',
      });
      // 再补一条 user 消息，让草稿**原文**像你自己发的一样出现在聊天流里。
      // 服务端发起的 query 不经过前端 sendCommand，不补这条就只剩一行系统提示、
      // 看不到到底发了什么（刷新后能从 _history 看到，但 live 时是空的）。
      this.emit('agent:message', {
        type: 'user',
        content: draftDisplayText(draft) || prompt,
        timestamp: Date.now(),
      });
      this.emit('draft-relayed', { id: draft.id, sessionId: this.id });
      // 接力等于"用户发了条消息"，刷新活跃时间，免得空闲清理器把控制权收走
      // （server.js 里 agent:query 同样要手动刷，agent 模式不走 'input' 事件）
      this.lastInputTime = Date.now();
      this.query(prompt).catch(() => {});
    }, RELAY_DELAY_MS);
    if (this._relayTimer.unref) this._relayTimer.unref();
  }
  // 回合结束、空闲后安排下一次跟进（AI 给了 [跟进完成] 则停；到上限则暂停）
  _maybeScheduleFollowUp() {
    this._cancelFollowUp();
    if (!this._followEnabled || !this.alive) return;
    if (this._followStopSignal) {
      this._followStopSignal = false;
      this._followCount = 0;
      this.emit('agent:message', { type: 'system', subtype: 'info', message: '🔄 AI 已确认任务全部完成，自动跟进停止。' });
      return;
    }
    if (this._followCount >= this._followMax) {
      this.emit('agent:message', { type: 'system', subtype: 'info', message: `🔄 自动跟进已连续 ${this._followMax} 次，暂停（防空转烧额度）。需要继续可手动问一句或重开。` });
      return;
    }
    this._followTimer = setTimeout(() => {
      this._followTimer = null;
      if (this._busy || !this.alive || !this._followEnabled) return;
      this._followCount++;
      this.emit('agent:message', { type: 'system', subtype: 'info', message: `🔄 自动跟进（第 ${this._followCount}/${this._followMax} 次）：让 AI 查看进度…` });
      this.query(FOLLOW_UP_PROMPT, { internal: true }).catch(() => {});
    }, this._followIntervalMs);
  }

  // -----------------------------------------------------------------------
  // 停摆看门狗：busy 且在等模型/API 响应却长时间无任何消息 → 传输层重试卡死，强制中断
  //   只在 !_awaitingTool（等模型）时计时；_awaitingTool（等工具执行）时不计，
  //   避免误伤长时间 Bash/构建。命中不自动重试（传输问题重试也可能再卡），交回人工。
  // -----------------------------------------------------------------------

  _startStallWatchdog() {
    this._stopStallWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (!this._busy) { this._stopStallWatchdog(); return; }
      if (this._awaitingTool) return; // 在等工具执行，长任务正常无消息
      const idle = Date.now() - this._lastActivityAt;
      if (idle >= STALL_WATCHDOG_MS) {
        const secs = Math.round(idle / 1000);
        console.warn(`[agent] ⏱ 停摆看门狗触发：等待模型响应已 ${secs}s 无任何消息，强制中断`);
        this.emit('agent:message', {
          type: 'system', subtype: 'warning',
          message: `⏱ 检测到会话停摆（等待模型响应 ${secs}s 无响应，疑似 API 传输层重试卡住），已强制中断本回合。请重试或稍后再试。`,
        });
        this._stopStallWatchdog();
        this.interrupt();
      }
    }, STALL_CHECK_INTERVAL_MS);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  _stopStallWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Respond to a permission request
  // -----------------------------------------------------------------------

  // claude 发来 can_use_tool：
  //   AskUserQuestion → 把问题交给用户（界面弹问答），等回答；
  //   ExitPlanMode    → 把方案交给用户审批，批准则切到免授权直接执行；
  //   其他工具         → 保持无人值守语义：当前模式没放行的一律拒绝（myhi 没有逐项授权 UI；bypass 模式根本不会来问）。
  _onControlRequest(msg) {
    const req = msg.request || {};
    const id = msg.request_id;
    if (req.subtype !== 'can_use_tool') {
      this._writeStdin({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `myhi 不支持 ${req.subtype}` } });
      return;
    }
    if (req.tool_name === 'AskUserQuestion' || req.tool_name === 'ExitPlanMode') {
      return this._openInteraction({ id, kind: req.tool_name === 'AskUserQuestion' ? 'ask' : 'plan', input: req.input || {}, toolUseId: req.tool_use_id });
    }
    this._ctlReply(id, { behavior: 'deny', message: '当前权限模式不允许此操作（myhi 无人值守，无法逐项授权）。请基于现状继续，或在回复里说明需要用户切换到自动执行。' });
  }

  _ctlReply(id, response) {
    return this._writeStdin({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }

  // 待用户处理的提问 / 方案。服务端在有人打开或重连会话时补发，免得刷新、换设备后看不到、任务卡死
  get pendingInteractions() { return [...(this._interactions?.values() || [])].map((p) => p.view); }

  _openInteraction(p) {
    if (!this._interactions) this._interactions = new Map();
    // 给用户看的内容：隐私护栏占位符还原成真名，再做密钥兜底脱敏（与普通消息同一条通道）
    const shown = redactDeep(this._pseudo?.enabled ? redactDeep(p.input, this._pseudo.restore) : p.input, this._redactor);
    p.view = { id: p.id, kind: p.kind, toolUseId: p.toolUseId, at: Date.now(),
      questions: p.kind === 'ask' ? (shown.questions || []) : undefined,
      plan: p.kind === 'plan' ? String(shown.plan || '') : undefined };
    // 没人答就一直卡着（claude 不会自己超时）：到点自动「按最佳判断继续」。开了自动跟进的会话等得短些
    const waitMs = this._followEnabled ? INTERACTION_WAIT_FOLLOW_MS : INTERACTION_WAIT_MS;
    p.view.deadline = Date.now() + waitMs;
    p.timer = setTimeout(() => this.respondInteraction(p.id, { skip: true, timeout: true }, '系统'), waitMs);
    if (p.timer.unref) p.timer.unref();
    this._interactions.set(p.id, p);
    this.emit('agent:interaction', p.view);
  }

  // decision：ask → { answers: { 问题: 答案 } } 或 { skip: true }；plan → { approve: true } 或 { approve: false, feedback }
  respondInteraction(id, decision = {}, by = '') {
    const p = this._interactions?.get(id);
    if (!p) return { ok: false, error: '这个提问已经处理过了' };
    clearTimeout(p.timer);
    this._interactions.delete(id);
    // 用户写的内容进模型前同样走隐私护栏（真名 → 占位符）
    const toModel = (t) => (this._pseudo?.enabled ? this._pseudo.pseudonymize(String(t)).text : String(t));
    let note;
    if (p.kind === 'ask') {
      if (decision.skip || !decision.answers || !Object.keys(decision.answers).length) {
        this._ctlReply(id, { behavior: 'deny', message: decision.timeout
          ? '用户较长时间没有作答。请按你的最佳判断继续，并在回复里说明你做了哪些假设。'
          : '用户选择不回答这个问题。请按你的最佳判断继续，并在回复里说明你做了哪些假设。' });
        note = decision.timeout ? '⏭ 提问等待超时，AI 将按最佳判断继续' : `⏭ ${by} 跳过了提问，AI 将按最佳判断继续`;
      } else {
        const answers = {};
        // 键用 claude 原始问题文本（可能含占位符），按顺序对应界面上还原过的问题
        const rawQs = p.input.questions || [], shownQs = p.view.questions || [];
        shownQs.forEach((q, i) => {
          const a = decision.answers[q.question];
          if (a !== undefined && rawQs[i]) answers[rawQs[i].question] = toModel(a);
        });
        this._ctlReply(id, { behavior: 'allow', updatedInput: { ...p.input, answers } });
        note = `📝 ${by} 已回答：` + shownQs.map((q) => `${q.header || q.question}＝${decision.answers[q.question] ?? '（未答）'}`).join('；');
      }
    } else {
      if (decision.approve) {
        // 批准：claude 在进程内切到免授权直接执行（启动时带了 --allow-dangerously-skip-permissions）
        this._ctlReply(id, { behavior: 'allow', updatedInput: p.input,
          updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] });
        note = `✅ ${by} 批准了方案，AI 开始执行`;
      } else {
        const fb = String(decision.feedback || '').trim();
        this._ctlReply(id, { behavior: 'deny', message: decision.timeout
          ? '用户较长时间没有审批方案，暂不执行。保持计划模式，等待用户回复。'
          : `用户希望修改方案${fb ? '：' + toModel(fb) : ''}。请按意见修改后重新用 ExitPlanMode 提交。` });
        note = decision.timeout ? '⏭ 方案审批等待超时，暂不执行' : `✏️ ${by} 要求修改方案${fb ? '：' + fb : ''}`;
      }
    }
    this.emit('agent:interaction-closed', { id, kind: p.kind });
    this.emit('agent:message', { type: 'system', subtype: 'info', message: note });
    return { ok: true };
  }

  // 中断 / 重置 / 杀进程时：claude 那边的等待已随之取消，这里收尾、通知界面关掉弹窗
  _dropInteractions() {
    if (!this._interactions?.size) return;
    for (const p of this._interactions.values()) {
      clearTimeout(p.timer);
      this.emit('agent:interaction-closed', { id: p.id, kind: p.kind });
    }
    this._interactions.clear();
  }

  // -----------------------------------------------------------------------
  // Hard-kill the entire process tree (Windows: cmd.exe → claude.cmd → node.exe
  // 需要 taskkill /T，否则 Node 的 kill 只能干掉最外层 cmd.exe，真正干活的 node.exe 会变孤儿继续跑)
  // -----------------------------------------------------------------------

  _hardKillTree(pid) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe', timeout: 5000 });
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { process.kill(pid, 0); } catch { return; }
          try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        }, 1000);
      }
    } catch { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // Interrupt a running query
  //   1. 先走 SDK 协议的 control_request interrupt，让 claude CLI 自己优雅停掉本回合
  //   2. 1.5s 还在 busy 就走 taskkill /F /T 把整棵树干掉
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // ⚡ 插话：AI 正在干活时把一条消息直接送进 claude（不打断）。claude 在下一步（工具调用之间）看到它并调整，
  // 并入当前这一轮；如果这一轮已经在写最后的总结，它会在收尾后拿插话开新一轮（实测两种都正常）。
  // 靠 --replay-user-messages 的回显（带 uuid）确认「AI 已看到」。
  // -----------------------------------------------------------------------

  get canInject() { return !!this._injectable && !!this._proc && this._busy; }

  inject(prompt, { display } = {}) {
    if (!this._injectable) return { ok: false, error: '当前 Claude 版本不支持插话，请升级 Claude Code 后重试' };
    if (!this._proc || !this._busy) return { ok: false, error: 'AI 现在没在干活，直接发送就行' };
    if (this._interactions?.size) return { ok: false, error: 'AI 正在等你回答提问 / 审批方案，请先在弹窗里处理' };
    prompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!prompt) return { ok: false, error: '插话内容是空的' };
    if (prompt.startsWith('/')) return { ok: false, error: '插话不支持 / 命令，请等 AI 干完再发' };

    let outbound = prompt;
    if (this._pseudo?.enabled) {
      const pr = this._pseudo.pseudonymize(prompt);
      outbound = pr.text;
      const key = this.claudeSessionId || this.id;
      saveMap(key, this._pseudoMap);
      if (pr.count > 0) appendAudit(key, { ts: Date.now(), level: this._pseudo.level, maskedCount: pr.count, byType: pr.byType, sentToModel: this._redactor ? this._redactor(pr.text) : pr.text, inject: true });
    }
    const id = randomUUID();
    if (!this._writeStdin({ type: 'user', uuid: id, message: { role: 'user', content: outbound } })) {
      return { ok: false, error: 'Claude 进程不可写，请稍后再试' };
    }
    if (!this._injected) this._injected = new Map();
    const ts = Date.now();
    const content = redactDeep(display || prompt, this._redactor);
    const entry = { type: 'user', content, timestamp: ts, inject: { id, state: 'pending' } };
    this._injected.set(id, entry);
    this._history.push(entry);
    this.emit('agent:message', { type: 'user', content, timestamp: ts, inject: { id, state: 'pending' } });
    this.lastInputTime = ts;
    return { ok: true, id };
  }

  _onReplay(msg) {
    const entry = msg.uuid && this._injected?.get(msg.uuid);
    if (entry) {
      this._injected.delete(msg.uuid);
      entry.inject.state = 'seen';
      this.emit('agent:message', { type: 'system', subtype: 'inject_state', id: msg.uuid, state: 'seen' });
      if (!this._injected.size) clearTimeout(this._injectWaitTimer);
    }
    // claude 开始处理一条消息，myhi 这边却以为空闲（插话在上一轮收尾后才被接、或中断后它仍接了排队的消息）：
    // 跟上，标回忙碌，免得界面显示空闲、草稿接力 / 用户新消息撞上正在跑的一轮
    if (!this._busy) {
      this._busy = true;
      this._interrupted = false;
      this.emit('agent:busy', true);
      this._lastActivityAt = Date.now();
      this._awaitingTool = false;
      this._startStallWatchdog();
    }
  }

  // 技能（.claude/skills、.claude/commands）有变化：Claude 只在启动时读技能列表，开着的进程看不到新技能（实测）。
  // 空闲就结束当前进程，下一轮用 --resume 接着原对话重启、重新加载技能；正忙就等这一轮结束再做。
  refreshSkills() {
    if (!this._proc) return false;
    if (this._busy) { this._skillsDirty = true; return true; }
    this._skillsDirty = false;
    this._expectExit = true;
    const pid = this._proc.pid;
    this._proc = null;
    if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
    this._hardKillTree(pid);
    this.emit('agent:message', { type: 'system', subtype: 'info', message: '🧠 技能有变化：下一轮 AI 会重新加载技能（接着原来的对话）' });
    return true;
  }

  // 还没被 AI 看到的插话作废（中断 / 进程退出 / 重开 / 超时），界面上标出来
  _dropInjected(reason) {
    clearTimeout(this._injectWaitTimer);
    if (!this._injected?.size) return;
    for (const [id, entry] of this._injected) {
      entry.inject.state = 'dropped';
      this.emit('agent:message', { type: 'system', subtype: 'inject_state', id, state: 'dropped', reason });
    }
    this._injected.clear();
  }

  interrupt() {
    this._dropInteractions();
    if (this._describing) { this._describeAborted = true; this._describing.abort(); return; }   // 还在看图，没发给 claude
    if (!this._proc || !this._busy) return;

    this._interrupted = true;
    const pid = this._proc.pid;
    const proc = this._proc;
    const sentAt = Date.now();
    // 已经插进去、AI 还没看到的话：中断只停当前这一步，claude 仍会接着处理排队的插话（实测）。如实告诉用户
    if (this._injected?.size) {
      this.emit('agent:message', { type: 'system', subtype: 'info',
        message: '⚡ 你刚插的话已经排进 AI 的队列，中断后它会接着处理；不需要的话等它开始后再点一次停止' });
    }

    const sent = this._writeStdin({
      type: 'control_request',
      request_id: `interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      request: { subtype: 'interrupt' },
    });

    const fallbackDelay = sent ? 1500 : 0;
    setTimeout(() => {
      if (!this._busy) return;
      if (this._proc !== proc) return;
      if ((this._lastResultAt || 0) >= sentAt) return;   // 已经优雅停下（之后的忙碌是在处理排队的插话），别硬杀
      console.log(`[agent] graceful interrupt 超时，强制结束进程树 PID ${pid}`);
      this._hardKillTree(pid);
    }, fallbackDelay);

    this.emit('agent:message', {
      type: 'system',
      subtype: 'interrupted',
      message: '查询已中断',
    });
  }

  // -----------------------------------------------------------------------
  // Kill the process and clean up
  // -----------------------------------------------------------------------

  kill() {
    this._dropInteractions();
    this._dropInjected('会话已终止');
    this.alive = false;
    this._cancelRelay();
    this._cancelFollowUp();

    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }

    if (this._proc) {
      this._hardKillTree(this._proc.pid);
      this._proc = null;
    }

    if (this._pendingReject) {
      try { this._pendingReject(new Error('会话已终止')); } catch { /* ignore */ }
      this._pendingResolve = null;
      this._pendingReject = null;
    }

    this._busy = false;
  }

  // -----------------------------------------------------------------------
  // Load history from a resumed session's .jsonl files
  // -----------------------------------------------------------------------

  // 从 transcript 末尾反查最后一条 assistant 记录的真实 usage。
  // 背景：claude CLI 2.1.292 起 stream-json 的 assistant 事件 usage 全为 0，result 只给
  // 进程累计值——当前上下文大小（水位）的精确来源只剩 transcript 本身（它的 assistant
  // 记录带每次 API 调用的真实 usage，且 last assistant = 最后一次调用 = 当前上下文）。
  // 只读文件末尾 64KB 反向找，transcript 再大也只有一次小 IO（每轮 result 时调用）。
  _readTranscriptCtx() {
    if (!this.claudeSessionId) return null;
    try {
      const projectsDir = join(homedir(), '.claude', 'projects');
      if (!existsSync(projectsDir)) return null;
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = join(projectsDir, entry.name, this.claudeSessionId + '.jsonl');
        if (!existsSync(p)) continue;
        const size = statSync(p).size;
        const len = Math.min(size, 65536);
        const buf = Buffer.alloc(len);
        const fd = openSync(p, 'r');
        try {
          readSync(fd, buf, 0, len, size - len);
        } finally {
          closeSync(fd);
        }
        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const rec = JSON.parse(lines[i]);
            const u = rec.type === 'assistant' ? rec.message?.usage : null;
            if (u && ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) > 0) {
              return u;
            }
          } catch { /* 跳过截断/坏行（64KB 边界可能切在行中间） */ }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  _loadResumedHistory() {
    try {
      const projectsDir = join(homedir(), '.claude', 'projects');
      if (!existsSync(projectsDir)) return;

      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const jsonlPath = join(projectsDir, entry.name, this.claudeSessionId + '.jsonl');
        if (!existsSync(jsonlPath)) continue;

        const allLines = readFileSync(jsonlPath, 'utf8')
          .split('\n')
          .filter(Boolean);
        // 末 200 条里找回放素材：transcript 尾部常是 attachment/queue-operation 等辅助
        // 记录（实测 435 行里占一半以上），只看 20 条容易一条 assistant 都扫不到，
        // 恢复后水位停在 0（1.3.163 实测）。
        const lines = allLines.slice(-200);

        // 会话名片回填：历史只留末 20 条，但「这个任务当初是干啥的」要看**第一条**，
        // 所以另外从文件头扫一遍。跳过 CLAUDE.md 注入 / slash 命令 / 系统提醒这些噪音。
        if (!this.firstUserText) {
          for (const line of allLines.slice(0, 40)) {
            try {
              const rec = JSON.parse(line);
              if (rec.type !== 'user' && rec.type !== 'human') continue;
              const c = rec.message?.content;
              const text = (typeof c === 'string' ? c : c?.find?.((x) => x.type === 'text')?.text || '').trim();
              if (!text || text.startsWith('/')) continue;
              if (/^(Caveat:|<command-name>|<system-reminder>|<local-command|<task-notification>)/.test(text)) continue;
              this.firstUserText = text.slice(0, 160);
              break;
            } catch { /* skip malformed lines */ }
          }
        }

        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            if (record.isSidechain) continue; // 子代理镜像不进主流（1.3.171：混进来就是重复消息）

            if (record.type === 'human' || record.type === 'user' && record.message?.content) {
              const text = typeof record.message.content === 'string'
                ? record.message.content
                : record.message.content.find((c) => c.type === 'text')?.text || '';
              if (text) {
                this._history.push({ type: 'user', content: text, timestamp: record.timestamp });
              }
            } else if (record.type === 'assistant' && record.message?.content) {
              this._history.push({
                type: 'assistant',
                message: record.message,
                timestamp: record.timestamp,
              });
              // 恢复会话时回填上下文水位（transcript 里的 usage 与 stream 同构）；
              // transcript 按时间序，最后一条 assistant 即当前上下文——直接赋值，
              // 压缩（/compact）后的回落才能体现（取 max 会弹回压缩前）
              const u = record.message.usage;
              if (u) {
                const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                this._contextTokens = t;
              }
            } else if (record.type === 'result') {
              this._history.push({
                type: 'result',
                total_cost_usd: record.costUSD || record.total_cost_usd,
                timestamp: record.timestamp,
              });
            }
          } catch { /* skip malformed lines */ }
        }

        // 用 transcript 文件 mtime 回填「最后任务时间」——文件最后写入即最后活动，
        // 比解析末条记录时间戳可靠得多（末尾常是 system/tool_result 记录，取不到时间戳）。
        try {
          const mt = statSync(jsonlPath).mtimeMs;
          if (mt > 0) this._lastActivityAt = Math.max(this._lastActivityAt, mt);
        } catch { /* ignore */ }

        return; // found the file, stop scanning
      }
    } catch (err) {
      console.warn('[agent] 加载恢复会话历史失败:', err.message);
    }
  }

  // -----------------------------------------------------------------------
  // Convenience getters
  // -----------------------------------------------------------------------

  get isBusy() {
    return this._busy;
  }

  getRecentHistory(n = 20) {
    return this._history.slice(-n);
  }

  getUsage() {
    return { ...this._usage };
  }

  // -----------------------------------------------------------------------
  // Viewer management
  // -----------------------------------------------------------------------

  addViewer(socketId, name) {
    this._viewers.add(socketId);
    if (name) this._viewerNames.set(socketId, name);
  }

  removeViewer(socketId) {
    this._viewers.delete(socketId);
    this._viewerNames.delete(socketId);
  }

  get viewerCount() {
    return new Set(this._viewerNames.values()).size || this._viewers.size;
  }

  // -----------------------------------------------------------------------
  // Control management (who can type)
  // -----------------------------------------------------------------------

  takeControl(socketId, name) {
    this.controlHolder = socketId;
    this.controlHolderName = name || null;
    this.lastInputTime = Date.now();
  }

  releaseControl() {
    this.controlHolder = null;
    this.controlHolderName = null;
    this.lastInputTime = null;
  }

  isController(socketId) {
    return this.controlHolder === socketId;
  }

  // -----------------------------------------------------------------------
  // Permission mode switching (kills process, restarts with new mode)
  // -----------------------------------------------------------------------

  setPermissionMode(mode) {
    // 归一化：拒绝 undefined / '' / 'bypass' / 未知值静默变成 default（会卡死无人值守会话）
    this.permissionMode = normalizePermissionMode(mode);
    if (this._proc) {
      this._expectExit = true;
      this.kill();
      this.alive = true; // restore – kill() sets it false
    }
  }

  // 重置为全新会话：断开 --resume 链、清上下文。下次 query 会开一个新的 claude 会话。
  // 中毒会话（resume 把旧 default 模式带回来、无法运行时提权）唯一可靠的修复手段。
  // /clear 和「会话体检」面板的「重开」都走这里。
  reset() {
    this._dropInteractions();
    this._dropInjected('已开始新对话');
    if (this._proc) {
      this._expectExit = true;   // 主动结束旧进程：它的退出码（常见 code 1）不是故障，别弹红色「异常退出」吓人
      this._hardKillTree(this._proc.pid);
      this._proc = null;
    }
    this.claudeSessionId = null;
    this._pseudoMap = null; this._pseudo = null;   // 新对话：模型上下文里没有旧占位符，映射表从头来
    dropMap(this.id);
    this._history = [];
    this._contextTokens = 0; // 全新上下文，水位归零
    this._buffer = '';
    this._imageBlockCount = 0;
    this._imageNudgeAt = IMAGE_NUDGE_STEP;
    this._cancelFollowUp(); this._followCount = 0; this._followStopSignal = false;
    this._cancelRelay();   // 重开会话：待接力的草稿别再打到新上下文里
    // 归一化模式回 bypass：重开的语义是"干净的无人值守会话"。否则 plan/default 会话
    // 重开后还是原模式（下次 spawn 依旧非 bypass），等于没修（1.3.85）。
    this.permissionMode = 'bypassPermissions';
  }

  // -----------------------------------------------------------------------
  // Serialise for API responses
  // -----------------------------------------------------------------------

  // AI 最后一句文字回复（_history 里已还原假名、已脱敏），压成一行截 80 字
  _lastAssistantText() {
    for (let i = this._history.length - 1, n = 0; i >= 0 && n < 80; i--, n++) {
      const m = this._history[i];
      if (m?.type !== 'assistant' || m.parent_tool_use_id) continue;
      const t = (m.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
      const line = t.replace(/[#*`>|_~\-]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (line) return line.slice(0, 80);
    }
    return '';
  }

  /** 环境 / 启动参数变了（密钥、网关、场景模型）：下一条消息前用新设置重启 AI 进程。进程没在跑就不用管（下次启动自然是新的） */
  markEnvDirty(reason = '设置') {
    if (!this._proc) return;
    this._envDirty = this._envDirty && this._envDirty !== reason ? '设置' : reason;
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      firstUserText: this.firstUserText || '',
      cwd: this.cwd,
      tags: this.tags,
      createdAt: this.createdAt,
      lastActivityAt: this._lastActivityAt || null,
      mode: 'agent',
      alive: this.alive,
      viewers: this.viewerCount,
      controlHolder: this.controlHolder,
      controlHolderName: this.controlHolderName,
      permissionMode: this.permissionMode,
      modelId: this.modelId || null,              // 本会话手动选的模型（null = 用默认）
      effectiveModel: this._currentModel(),       // 现在实际在用的（计划模式下是计划模型；null = Claude Code 默认）
      planModel: sceneModel('plan') || null,
      owner: this.owner,
      claudeSessionId: this.claudeSessionId,
      busy: this._busy,
      pending: this._interactions?.size || 0, // 等你回答的提问 / 待审批方案
      lastText: this._lastAssistantText(),   // 切换面板 / 首页卡片的「最后一句话」预览
      interactive: !!this._interactive,   // 本进程开着交互通道（AskUserQuestion / 方案审批走 myhi 界面）
      injectable: _replayCap,             // 支持 ⚡ 插话（AI 干活时把消息直接送进去）
      usage: this._usage,
      contextTokens: this._contextTokens,
      followUp: this.followUpState(),
    };
  }
}

// ---------------------------------------------------------------------------
// getSessionHealth – 读某个 claude 会话的 transcript，给「会话体检」面板用
//   persistedMode: transcript 里最后一个 user 回合记录的 permissionMode —— 这正是
//   --resume 会带回来的模式；≠ bypassPermissions 即判定「中毒」(写/删会被拦且无法提权)。
// ---------------------------------------------------------------------------

export function getSessionHealth(claudeSessionId) {
  const empty = {
    found: false, persistedMode: null, poisoned: false,
    messageCount: 0, transcriptKB: 0, imageCount: 0, updatedAt: null,
  };
  if (!claudeSessionId) return empty;
  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    if (!existsSync(projectsDir)) return empty;

    for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const p = join(projectsDir, dir.name, claudeSessionId + '.jsonl');
      if (!existsSync(p)) continue;

      const raw = readFileSync(p, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let persistedMode = null;
      let updatedAt = null;
      let imageCount = 0;

      for (const line of lines) {
        const imgs = line.match(/"type":"image"/g);
        if (imgs) imageCount += imgs.length;
        // permissionMode 只落在 user 行；只对这些行 parse，省开销
        if (line.includes('permissionMode')) {
          try {
            const o = JSON.parse(line);
            if (o.type === 'user' && o.permissionMode) persistedMode = o.permissionMode;
          } catch { /* skip */ }
        }
      }
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        if (last.timestamp) updatedAt = last.timestamp;
      } catch { /* ignore */ }

      return {
        found: true,
        persistedMode,
        poisoned: !!(persistedMode && persistedMode !== 'bypassPermissions'),
        messageCount: lines.length,
        transcriptKB: Math.round(raw.length / 1024),
        imageCount,
        updatedAt,
      };
    }
  } catch { /* ignore */ }
  return empty;
}

// ---------------------------------------------------------------------------
// listLocalClaudeSessions – scan ~/.claude/projects/ for session files
// ---------------------------------------------------------------------------

let _claudeSessionsCache = null;
let _claudeSessionsCacheTime = 0;
const CLAUDE_SESSIONS_CACHE_TTL = 30_000;

export function listLocalClaudeSessions(cwd) {
  const now = Date.now();

  // Return cached results if still fresh
  if (_claudeSessionsCache && now - _claudeSessionsCacheTime < CLAUDE_SESSIONS_CACHE_TTL) {
    if (!cwd) return _claudeSessionsCache;
    const normalizedCwd = resolve(normalize(cwd)).replace(/[\\/]+$/, '');
    return _claudeSessionsCache.filter((s) =>
      resolve(normalize(s.projectPath)).replace(/[\\/]+$/, '').startsWith(normalizedCwd)
    );
  }

  const sessions = [];
  const normalizedCwd = cwd
    ? resolve(normalize(cwd)).replace(/[\\/]+$/, '')
    : null;

  try {
    const projectsDir = join(homedir(), '.claude', 'projects');
    if (!existsSync(projectsDir)) return sessions;

    for (const dirEntry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      const dirPath = join(projectsDir, dirEntry.name);

      try {
        for (const file of readdirSync(dirPath)) {
          if (!file.endsWith('.jsonl')) continue;

          const sessionId = file.replace('.jsonl', '');
          const filePath = join(dirPath, file);

          try {
            const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);

            let firstRecord = null;
            let lastRecord = null;
            let messageCount = 0;
            let summary = '';

            for (const raw of lines) {
              try {
                const record = JSON.parse(raw);
                if (!firstRecord) firstRecord = record;
                lastRecord = record;
                messageCount++;

                // Use first human message as summary
                if (!summary && record.type === 'human' || record.type === 'user' && record.message?.content) {
                  const content = record.message.content;
                  if (typeof content === 'string') {
                    summary = content.slice(0, 120);
                  } else if (Array.isArray(content)) {
                    const textBlock = content.find((b) => b.type === 'text');
                    if (textBlock) {
                      summary = textBlock.text?.slice(0, 120) || '';
                    }
                  }
                }
              } catch { /* skip malformed lines */ }
            }

            // Decode the project directory name back to a filesystem path
            let projectPath = dirEntry.name;
            if (process.platform === 'win32' && /^[A-Za-z]--/.test(projectPath)) {
              // e.g. "C--Users-foo-project" -> "C:\Users\foo\project"
              projectPath = projectPath[0] + ':\\' + projectPath.slice(3).replace(/-/g, '\\');
            } else if (projectPath.startsWith('-')) {
              projectPath = projectPath.replace(/-/g, '/');
            }

            // Filter by cwd if provided
            if (normalizedCwd && !resolve(normalize(projectPath)).replace(/[\\/]+$/, '').startsWith(normalizedCwd)) {
              continue;
            }

            sessions.push({
              sessionId,
              projectDir: dirEntry.name,
              projectPath,
              messageCount,
              summary,
              createdAt: firstRecord?.timestamp || null,
              updatedAt: lastRecord?.timestamp || null,
            });
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable directories */ }
    }
  } catch { /* ignore top-level errors */ }

  // Sort by most recently updated first
  sessions.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());

  // Cache up to 50, return up to 20
  const cached = sessions.slice(0, 50);
  _claudeSessionsCache = cached;
  _claudeSessionsCacheTime = Date.now();

  return cached.slice(0, 20);
}
