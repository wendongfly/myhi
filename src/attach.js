#!/usr/bin/env node
/**
 * myhi attach - CLI 客户端，附加到远程 myhi 会话
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

const SERVER = process.env.MYHI_SERVER || 'http://localhost:12300';

// 解析 --password 参数
let password = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--password' || args[i] === '-pw') && args[i + 1]) {
    password = args[i + 1];
    args.splice(i, 2);
    i--;
  }
}

// 认证方式：密码或 token
let auth;
if (password) {
  auth = { password };
} else {
  try {
    auth = { token: readFileSync(join(homedir(), '.myhi', 'token'), 'utf8').trim() };
  } catch {
    console.error('[myhi] 未找到 token，请使用 --password <密码> 或先启动服务器');
    process.exit(1);
  }
}

function cleanup(socket) {
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  socket.disconnect();
}

function attach(socket, sessionId) {
  socket.emit('join', sessionId);

  socket.on('joined', (session) => {
    const isAgent = session.mode === 'agent';
    process.stderr.write(`\r\n[myhi] 已附加到 "${session.title}" (${sessionId}) 模式=${isAgent ? 'agent' : 'pty'}\r\n`);
    process.stderr.write('[myhi] 按 Ctrl+] 分离\r\n\r\n');

    socket.emit('take-control', { sessionId });

    if (isAgent) {
      // Agent 模式：readline 交互
      let streamText = '';

      socket.on('agent:message', (msg) => {
        if (!msg) return;
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') process.stderr.write('\x1b[90m[会话已连接]\x1b[0m\r\n');
            else if (msg.subtype === 'interrupted') process.stderr.write('\r\n\x1b[33m[已中断]\x1b[0m\r\n');
            break;
          case 'assistant':
            if (msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text') process.stdout.write(block.text + '\r\n');
                else if (block.type === 'tool_use') {
                  const label = block.name === 'Task'
                    ? `子代理 · ${(block.input && block.input.subagent_type) || 'general-purpose'}`
                    : block.name;
                  process.stdout.write(`\r\n\x1b[36m[工具] ${label}\x1b[0m\r\n`);
                  if (block.input) {
                    const text = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
                    process.stdout.write('\x1b[90m' + text.slice(0, 500) + '\x1b[0m\r\n');
                  }
                }
              }
            }
            break;
          case 'content_block_delta':
            if (msg.delta?.text) {
              process.stdout.write(msg.delta.text);
              streamText += msg.delta.text;
            }
            break;
          case 'content_block_stop':
            if (streamText) { process.stdout.write('\r\n'); streamText = ''; }
            break;
          case 'tool_use':
            process.stdout.write(`\r\n\x1b[36m[工具] ${msg.tool_name || msg.name || '?'}\x1b[0m\r\n`);
            break;
          case 'tool_result':
            if (msg.content) {
              const text = typeof msg.content === 'string' ? msg.content
                : Array.isArray(msg.content) ? msg.content.map(b => b.text || '').join('') : '';
              if (text) process.stdout.write('\x1b[90m' + text.slice(0, 1000) + '\x1b[0m\r\n');
            }
            break;
          case 'result':
            process.stdout.write(`\r\n\x1b[32m[完成]\x1b[0m ${msg.duration_ms ? (msg.duration_ms / 1000).toFixed(1) + 's' : ''} ${msg.total_cost_usd ? '$' + msg.total_cost_usd.toFixed(4) : ''}\r\n\r\n`);
            break;
        }
      });

      socket.on('agent:history', (history) => {
        for (const item of history) {
          if (item.type === 'user') process.stdout.write(`\x1b[34m> ${item.content}\x1b[0m\r\n`);
          else if (item.type === 'result') process.stdout.write('\x1b[32m[完成]\x1b[0m\r\n');
        }
        process.stdout.write('\r\n');
      });

      socket.on('agent:busy', (busy) => {
        if (busy) process.stderr.write('\x1b[90m[思考中...]\x1b[0m\r\n');
      });

      socket.on('agent:error', (err) => {
        process.stderr.write(`\x1b[31m[错误] ${err.message}\x1b[0m\r\n`);
      });

      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[34m> \x1b[0m' });
      let isBusy = false;

      socket.on('agent:busy', (busy) => {
        isBusy = busy;
        if (!busy) rl.prompt();
      });

      rl.prompt();

      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) { if (!isBusy) rl.prompt(); return; }
        if (text === '/quit' || text === '/exit' || text === '/q') {
          process.stderr.write('[myhi] 已分离\r\n');
          cleanup(socket);
          process.exit(0);
        }
        if (isBusy) {
          process.stderr.write('\x1b[33m[正在处理中，请等待]\x1b[0m\r\n');
          return;
        }
        socket.emit('agent:query', { prompt: text });
      });

      rl.on('close', () => { cleanup(socket); process.exit(0); });

    } else {
      // PTY 模式：raw stdin
      try { process.stdin.setRawMode(true); } catch {}
      process.stdin.resume();
      process.stdin.setEncoding('binary');

      process.stdin.on('data', (data) => {
        // Ctrl+] = 分离
        if (data === '\x1d') {
          process.stderr.write('\r\n[myhi] 已分离\r\n');
          cleanup(socket);
          process.exit(0);
        }
        socket.emit('input', data);
      });

      socket.on('output', (data) => {
        process.stdout.write(data, 'binary');
      });

      process.stdout.on('resize', () => {
        socket.emit('resize', { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
      });
    }
  });

  socket.on('control-denied', ({ reason }) => {
    process.stderr.write(`\r\n[myhi] 获取控制权失败: ${reason}\r\n`);
  });

  socket.on('control-changed', ({ holder, holderName }) => {
    if (holder && holder !== socket.id) {
      process.stderr.write(`\r\n[myhi] ${holderName || '其他用户'} 已获取控制权，当前为只读\r\n`);
    } else if (!holder) {
      process.stderr.write('\r\n[myhi] 控制权已释放\r\n');
    }
  });

  socket.on('kicked', ({ reason }) => {
    process.stderr.write(`\r\n[myhi] ${reason || '你已被管理员踢出'}\r\n`);
    cleanup(socket);
    process.exit(1);
  });

  socket.on('session-exit', ({ code }) => {
    process.stderr.write(`\r\n[myhi] 会话已退出 (code ${code})\r\n`);
    cleanup(socket);
    process.exit(0);
  });

  socket.on('error', ({ message }) => {
    process.stderr.write(`\r\n[myhi] 错误: ${message}\r\n`);
    cleanup(socket);
    process.exit(1);
  });
}

async function pickSession(socket) {
  return new Promise((resolve) => {
    socket.emit('list');
    socket.once('sessions', (sessions) => {
      const alive = sessions.filter(s => s.alive);
      if (!alive.length) {
        process.stderr.write('[myhi] 没有活跃的会话。\n');
        cleanup(socket);
        process.exit(0);
      }
      process.stdout.write('\n活跃会话:\n');
      alive.forEach((s, i) => {
        const viewers = s.viewers > 0 ? ` (${s.viewers} 人在线)` : '';
        const mode = s.mode === 'agent' ? ' [Agent]' : ' [PTY]';
        process.stdout.write(`  [${i + 1}] ${s.title}${mode}${viewers}  — ${s.id}\n`);
      });
      process.stdout.write('\n');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question('选择会话编号: ', (answer) => {
        rl.close();
        const idx = parseInt(answer, 10) - 1;
        if (idx < 0 || idx >= alive.length) {
          process.stderr.write('[myhi] 无效的选择。\n');
          cleanup(socket);
          process.exit(1);
        }
        resolve(alive[idx].id);
      });
    });
  });
}

async function createAndAttach(socket, opts) {
  return new Promise((resolve) => {
    socket.emit('create', opts, (result) => {
      if (!result?.ok) {
        process.stderr.write(`[myhi] 创建失败: ${result?.error || '未知错误'}\n`);
        cleanup(socket);
        process.exit(1);
      }
      process.stdout.write(`[myhi] 已创建会话 "${result.session.title}" — ${result.session.id}\n`);
      resolve(result.session.id);
    });
  });
}

async function promptNew(socket) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));
  const title = (await ask('会话名称 [shell]: ')).trim() || 'shell';
  const initCmd = (await ask('启动命令（可选）: ')).trim() || undefined;
  rl.close();
  return createAndAttach(socket, { title, initCmd });
}

// 连接
const socket = io(SERVER, { transports: ['websocket', 'polling'], auth });

socket.on('connect_error', (err) => {
  process.stderr.write(`[myhi] 连接失败: ${err.message}\n`);
  process.exit(1);
});

socket.on('connect', async () => {
  const cmd = args[0];
  if (cmd === '--new') {
    const title = args[1];
    const initCmd = args[2] || undefined;
    const id = title ? await createAndAttach(socket, { title, initCmd }) : await promptNew(socket);
    attach(socket, id);
  } else {
    const id = cmd || await pickSession(socket);
    attach(socket, id);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup(socket); process.exit(0); });
}
process.on('exit', () => { try { process.stdin.setRawMode(false); } catch {} });
