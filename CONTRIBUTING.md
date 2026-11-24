# 参与贡献 / Contributing

欢迎提 issue 和 PR。界面和文档目前以中文为主，issue / PR 用中文或英文都可以。

Issues and pull requests are welcome, in Chinese or English.

- **安全问题请不要开公开 issue**，按 [SECURITY.md](SECURITY.md) 私密报告。
- 提 bug 请写明 myhi 版本（设置页可见）、操作系统、Node.js 版本、Claude Code 版本和复现步骤。

## 开发环境

```bash
git clone https://github.com/wendongfly/myhi.git
cd myhi
npm install
npm run build      # 打包到 dist/（ncc + esbuild），实际运行的是 dist/ 而不是 src/
npm start          # 或 node bin/myhi.js
```

- 需要 Node.js >= 18；AI 功能需要安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)。
- **改了 `src/` 或 `public/` 后必须重新 `npm run build`**，再用 `dist/` 运行。页面、第三方库和 worker 都在构建时拷进 `dist/`，直接跑 `src/server.js` 打不开网页。

**本机调试时请隔离配置目录和端口**，以免影响你正在用的 myhi（它会读写 `~/.myhi`，启动时还会结束同一配置目录下已在运行的实例）：

```bash
HOME=$(mktemp -d) PORT=12398 MYHI_NO_HTTPS=1 node dist/index.js
```

结束时按 PID 结束这个进程，不要按进程名批量结束 node。

## 代码结构

| 文件 | 职责 |
|---|---|
| `bin/myhi.js` | CLI 入口：命令解析、守护进程、系统服务安装、成员 / SSH 账号管理 |
| `src/server.js` | HTTP 路由、Socket.IO、认证与访问控制、各类 API |
| `src/sessions.js` | 会话管理：终端（PTY）/ AI 任务会话、持久化与恢复 |
| `src/agent.js` | Claude Code CLI 集成：启动、stream-json 解析、死循环熔断、脱敏的出入口 |
| `src/secrets.js` | 密钥库（Layer A / B） |
| `src/pseudo.js` | 隐私护栏（Layer C，可逆假名化） |
| `src/roles.js` | 角色与成员账号 |
| `src/models.js` | 网关模型目录、按场景选模型、看图 |
| `src/studio.js` / `src/minutes.js` | 可选功能：出图、会议纪要 |
| `public/chat.html` | 聊天式主界面（大部分功能 UI 在这里） |
| `public/index.html` | 首页 / 电脑工作台 |
| `public/admin.html` | 管理后台 `/admin` |
| `scripts/build.js` | 打包到 `dist/` |

## 敏感信息三层防护

用户在对话框里提交的内容常含主体名、证件号、卡号、手机号等，密钥（PAT、token、证书）是另一类。改动 `agent.js` / `secrets.js` / `pseudo.js` 时请保持这三层的语义：

- **Layer A（密钥 · 环境变量注入）**：密钥注入成环境变量，命令里用 `$NAME` 引用，值不进会话、不进模型。
- **Layer B（密钥 · 兜底脱敏）**：写入历史和广播的文本里，把密钥明文替换成 `«SECRET:NAME»`。
- **Layer C（隐私护栏 · 可逆假名化）**：发给模型前把敏感实体替换成稳定的占位符 `【类型_N】`，模型回复落盘 / 广播前再还原；映射表只存本机（`~/.myhi/pseudo-maps/`，权限 600）。审计记录只含假名、不含真值。

边界：只保护经对话框提交的内容。AI 用 Read / Bash 读磁盘文件时，内容在 Claude Code 进程内直接发给模型，myhi 拦不到。

**不要把任何真实的密钥或敏感实体写进代码、测试、文档或提交说明。**

## 提交 PR

- 一个 PR 做一件事；说明改了什么、为什么、怎么验证的。
- 涉及界面的改动请附截图，并在手机尺寸和电脑尺寸下都看一下。
- 涉及认证、权限、文件路径、命令执行的改动，请说明对 [SECURITY.md](SECURITY.md) 里威胁模型的影响。
- 版本号由维护者在发布时调整，PR 里不用改 `package.json` 的 `version`。

提交的代码以 MIT 许可证发布（见 [LICENSE](LICENSE)）。
