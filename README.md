# myhi

基于 Web 的终端共享工具 —— 通过局域网或 Tailscale 在手机、平板等设备上安全访问和控制你的终端，无需中继服务器；集成 Claude Code，在网页 / 手机上和 AI 一起干活。

> **English**: myhi is a self-hosted web UI for sharing your terminal and driving [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from a phone or browser over LAN / Tailscale — chat-style agent UI, xterm.js terminal, multi-device control hand-off, role-based multi-user mode, and a reversible pseudonymization layer that keeps sensitive entities out of the model. The UI and docs are currently in Chinese.

> **声明 / Disclaimer**：myhi 是独立的开源项目，与 Anthropic 没有关联，也未获其认可或背书。Claude、Claude Code 是 Anthropic 的商标。
> myhi is an independent project and is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

> ⚠️ **安全提示**：myhi 能远程执行命令，请只在可信的局域网 / Tailscale 内使用，不要直接暴露到公网；首次启动后请把默认管理密码改长。威胁模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

<p align="center">
  <img src="public/icon.svg" width="120" alt="myhi logo">
</p>

## 特性

- **双前端界面** —— 聊天对话式 UI（适合手机触屏）和 xterm.js 全功能终端
- **设备控制权切换** —— 多设备同时观看，单设备独占输入，支持接管与释放
- **AI Agent 集成** —— 集成 Claude Code CLI（需另行安装），Web 界面中直接与 AI 对话编程、审批文件变更；可经任何兼容 Anthropic API 的网关使用其它模型
- **🛡 隐私护栏（去标识化）** —— 提交给模型的敏感实体（主体名、证件/卡号/手机等）自动假名化，模型/第三方网关只看到占位符，答案里再还原成真名，映射表只留本机 + 审计留痕可导出
- **角色权限管理** —— admin / operator / viewer 三级角色，多种认证模式
- **多用户隔离** —— 独立用户目录、独立 Git 配置，支持独占模式
- **SSH 开发账号** —— 为每个用户创建独立的 SSH 账号，VS Code Remote-SSH 远程开发
- **Git 一键提交** —— 内置 Git 提交推送功能，支持每个项目独立的 GitLab / GitHub 账号
- **自动更新** —— Web 界面检测新版本，一键更新服务器
- **会话持久化** —— 会话断线重连、服务重启自动恢复
- **零配置启动** —— 一条命令启动，自动创建会话并附加终端
- **局域网 / Tailscale** —— 自动检测网络，点对点直连，QR 码快速连接
- **PWA 支持** —— 可添加到手机主屏幕，原生应用体验
- **可选：出图 / 会议纪要** —— 出图（云端出图 + 文字比对 + 看图复核）需要兼容的大模型网关；会议纪要（转写、区分发言人、按要求多次整理）需要语音识别服务。接口约定见 [docs/gateway-api.md](docs/gateway-api.md)，没有这些服务不影响其它功能

---

## 安装

```bash
npm install -g @wendongfly/myhi
```

需要 Node.js >= 18，以及 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（AI 功能用；纯终端共享不需要）：

```bash
npm install -g @anthropic-ai/claude-code
```

Claude Code 用你自己的 Anthropic 账号登录，或在 myhi 设置里配置兼容的网关地址和 Key。

> **新版 npm 注意**：若看到 `npm warn allow-scripts`（新版 npm 默认拦包的安装脚本），说明 `node-pty` 的原生模块脚本被跳过、终端可能受影响。加参数放行即可：
> ```bash
> npm install -g @wendongfly/myhi --allow-scripts=@wendongfly/myhi,node-pty
> ```
> 或本机一次性放行：`npm config set allow-scripts=@wendongfly/myhi,node-pty --location=user`。用下面的 Windows 安装器则已自动处理，无需手动加。

### Windows 一键安装（给非技术用户，免命令行）

不想让使用者碰终端？用 `installer/` 里的一键安装：右键 **`Install-myhi.bat` → 以管理员身份运行**，它会自动装 Node（缺则 winget 装）、装/更新 myhi、**注册计划任务实现开机登录自启（脱离会话、无黑窗、普通权限）**、放行防火墙、建桌面「myhi 控制台」快捷方式。装完开机登录即自动后台运行，使用者只管点桌面图标用。详见 [`installer/README.md`](installer/README.md)。

## 快速开始

```bash
# 前台启动（自动创建会话并附加终端）
myhi

# 后台守护进程模式
myhi -d

# 指定端口
myhi -p 8080
```

启动后，终端会输出访问地址和 QR 码。在同一局域网内的手机浏览器扫码或输入 `http://<你的IP>:12300` 即可访问。

首次启动会在 `~/.myhi/password` 生成一个 4 位数默认密码，终端中会显示。

---

## CLI 命令

### 服务器管理

```bash
myhi                     # 前台启动服务器
myhi -d / --daemon       # 后台守护进程启动
myhi -p 8080             # 指定端口
myhi stop                # 停止后台进程
myhi restart             # 重启后台进程
myhi status              # 查看运行状态
myhi log [N]             # 查看最近 N 行日志（默认 50）
```

### 会话操作

```bash
myhi attach              # 交互式选择会话并附加
myhi attach <id>         # 附加到指定会话
myhi attach --new        # 创建新会话并附加
myhi kick                # 交互式踢出用户
```

附加会话后按 `Ctrl+]` 可安全断开。

### 用户管理

```bash
myhi user list                   # 列出所有用户
myhi user add <密码> <名称> <目录>  # 添加用户
myhi user remove <密码>           # 删除用户
myhi exclusive on|off            # 开启/关闭独占模式
```

### SSH 开发账号

为 myhi 用户创建系统 SSH 账号，成员可通过 VS Code Remote-SSH 远程开发，每人只能访问自己的项目目录（支持 Windows 和 Ubuntu）。

```bash
myhi ssh add <用户名> [密码]      # 创建 SSH 账号（绑定到 myhi 用户的项目目录）
myhi ssh list                    # 列出所有 SSH 账号
myhi ssh remove <用户名>          # 删除 SSH 账号（保留项目目录）
```

**示例：**

```bash
# 1. 先添加 myhi 用户
myhi user add 1234 张三 /data/projects/zhangsan

# 2. 为他创建 SSH 账号
myhi ssh add 张三 sshpass123
# 输出:
#   ✓ SSH 账号创建成功！
#   │ SSH 用户名: myhi-zhangsan
#   │ SSH 密码:   sshpass123
#   │ 项目目录:   /data/projects/zhangsan
```

**目录隔离：**

| 平台 | 隔离方式 |
|------|---------|
| Windows | NTFS 权限：上级目录仅允许穿越，子目录完全控制 |
| Ubuntu | `chmod 711` 上级目录 + `chmod 700` 用户目录 + `chown` |

成员在 VS Code 中连接后打开 `~/project` 即可开发，无法查看其他用户的文件。

### 远程附加

```bash
# 连接到远程服务器的会话
MYHI_SERVER=http://192.168.1.100:12300 myhi attach
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `12300` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MYHI_AUTO_ATTACH` | `1` | 启动时自动打开本地终端窗口并附加会话 |
| `MYHI_CWD` | 当前目录 | 新建会话的工作目录 |
| `MYHI_SERVER` | `http://localhost:PORT` | attach 客户端连接的服务器地址 |

---

## 界面说明

### 仪表盘（`/`）

会话列表页面，显示所有终端和 Agent 会话：

- 实时状态（运行中 / 已退出 / 模式）
- 在线观看人数
- 控制权状态指示
- 快捷操作：打开、删除、重命名、踢出用户
- 新建 PTY 会话或 AI Agent 会话（支持文件夹选择器）
- 用量统计（7 天活动数据）
- **版本更新提示** —— 检测到新版本时显示更新横幅，一键更新

### 聊天模式（`/terminal/:id`）

对话式界面，**主要为手机优化**：

- 用户消息 vs AI 回复的对话气泡
- ANSI 48 色彩色终端输出渲染
- Markdown 渲染（加粗、代码块、列表）
- 工具调用可视化（可折叠分组，支持**一键展开/收起全部**）
- AI 思考过程（可展开查看）
- 文件差异查看器
- 权限请求卡片（允许 / 拒绝按钮）
- 图片上传（粘贴或选择，最大 20MB）
- 实时消息流式显示
- **ESC 取消** —— Agent 处理中按 ESC 或点击停止按钮中断操作
- **Git 提交** —— 快捷按钮一键提交代码到 GitLab / GitHub，每个项目独立凭据

### 终端模式（`/terminal-raw/:id`）

完整的 xterm.js 终端：

- 全键盘操作支持
- 自动适配窗口大小
- 可点击的 URL 链接
- 完整的终端色彩和格式

### 登录页（`/login`）

- 密码输入认证
- 登录失败计数与锁定倒计时
- 独占模式下显示占用状态

---

## 认证系统

myhi 支持三种认证模式，按优先级依次检查：

### 1. 用户模式（users.json）

每个用户拥有独立密码、名称和工作目录：

```json
// ~/.myhi/users.json
{
  "users": {
    "alice123": { "name": "Alice", "dir": "/home/alice/projects" },
    "bob456":   { "name": "Bob",   "dir": "/home/bob/work" }
  },
  "exclusive": false
}
```

通过 CLI 管理：`myhi user add <密码> <名称> <目录>`

**独占模式**（`exclusive: true`）：同一时间只允许一个用户登录，其他用户需等待当前用户退出（2 分钟无连接自动释放）。

### 2. 角色模式（roles.json）

不同密码映射到不同角色：

```json
// ~/.myhi/roles.json
{
  "passwords": {
    "1234": { "name": "管理员", "role": "admin" },
    "5678": { "name": "开发者", "role": "operator" },
    "0000": { "name": "观察者", "role": "viewer" }
  }
}
```

### 3. 默认密码模式

无配置文件时，使用 `~/.myhi/password` 中的 4 位数密码，所有登录用户获得 admin 角色。

### 认证流程

1. 浏览器访问 → 重定向到 `/login`
2. 输入密码 → 服务器验证（5 次失败锁定 IP 5 分钟）
3. 验证通过 → 设置 HttpOnly Cookie（`myhi_sid`，SameSite=Strict）
4. 后续请求自动携带 Cookie，7 天无活动自动过期

---

## 设备控制模型

每个会话同一时间只允许**一个设备**进行输入操作，其余设备为只读观察模式。

| 操作 | 说明 |
|------|------|
| 获取控制权 | 点击按钮或发送消息时自动获取 |
| 释放控制权 | 主动释放或 5 分钟无输入自动释放 |
| 强制接管 | admin 角色可强制从其他设备接管 |
| 断线释放 | 控制者断开连接后立即释放 |

权限等级：**admin**(3) > **operator**(2) > **viewer**(1)

- admin：创建/删除会话、强制接管、浏览目录、踢出用户
- operator：获取控制权、输入命令
- viewer：只读观看

---

## AI Agent 会话

myhi 集成了 Claude Code CLI，可以在 Web 界面中直接与 AI 进行编程协作。

### 工作方式

1. 在仪表盘点击"新建 Agent 会话"
2. 选择工作目录，创建 Agent 会话
3. 在聊天界面中输入自然语言指令
4. AI 以流式方式返回回复，包括：
   - **文本回复** —— Markdown 格式
   - **工具调用** —— 文件读写、命令执行等（可折叠查看，支持一键展开全部）
   - **思考过程** —— AI 的推理过程（可展开）
   - **权限请求** —— 需要你批准的操作（允许/拒绝按钮）
   - **文件差异** —— 代码变更的 diff 视图

### 权限模式

Agent 会话支持三种权限模式，可在界面中切换：

| 模式 | 说明 |
|------|------|
| `acceptEdits` | 默认，自动批准文件编辑，其他操作需确认 |
| `plan` | 规划模式，AI 只分析不执行 |
| `bypassPermissions` | 信任模式，自动批准所有操作 |

### 中断与取消

- **ESC 键** —— 在 Agent 处理中按 ESC 中断当前操作
- **停止按钮** —— Agent 忙时发送按钮自动变为红色停止按钮，点击取消

### 会话恢复

Agent 会话支持断线重连，重新打开时自动加载最近的对话历史（最多 500 条消息）。

---

## Git 提交推送

聊天界面的快捷键栏提供**"提交"**按钮，一键将代码提交并推送到 GitLab/GitHub。

### 功能特点

- **每个项目独立凭据** —— 不同项目可使用不同的 Git 账号，互不干扰
- **凭据记忆** —— 勾选"记住"后自动回填仓库地址和用户名
- **自动初始化** —— 目录未初始化时自动执行 `git init`
- **分支管理** —— 支持指定推送分支（默认 main）

### 凭据存储

每个项目的 Git 凭据存储在项目目录下，与系统全局 Git 配置隔离：

```
~/myhi/张三/
├── .gitconfig        # 项目级 Git 配置（credential helper + user）
├── .git-credentials  # 项目级凭据文件（仅本人可读）
└── ...
```

---

## 自动更新

myhi 支持在 Web 界面中检测和执行版本更新。

- **仪表盘**：页面加载时和每 10 分钟检查 npm 最新版本，有新版本时显示黄色更新横幅，点击"更新"按钮自动执行 `npm install -g @wendongfly/myhi@latest`
- **聊天页**：状态栏显示"有更新"提示，点击跳转到仪表盘执行更新
- 更新完成后服务器自动重启，页面自动刷新

---

## 安全特性

| 特性 | 说明 |
|------|------|
| HttpOnly Cookie | 防止 XSS 窃取会话 |
| SameSite=Strict | 防止 CSRF 攻击 |
| 一次性 Token | QR 码使用一次性 token，扫码后立即失效 |
| 登录限速 | 5 次失败锁定 IP 5 分钟 |
| Referrer-Policy | 防止 token 通过 Referer 头泄漏 |
| CORS 限制 | 仅允许局域网 (RFC1918) 和 Tailscale 网段 |
| 路径遍历防护 | 目录浏览接口阻止 `..` 路径穿越 |
| 进程隔离 | 每个用户独立 Git 配置，防止凭据交叉 |
| SSH 目录隔离 | NTFS/chmod 权限确保用户只能访问自己的项目目录 |
| 环境变量清理 | PTY 进程剥离 Claude Code 相关变量，防止嵌套 |

---

## 🛡 隐私护栏（去标识化 / 可逆假名化）

客户提交的提示词/数据常含**主体实体、证件号、卡号、手机**等敏感信息。直接发给模型（尤其经第三方 AI 网关）就是一条泄露面。myhi 在**客户端 ↔ 模型之间的唯一咽喉**做去标识化，形成三层敏感信息防护：

| 层 | 保护对象 | 机制 |
|----|----------|------|
| Layer A | 密钥（PAT/token/证书） | 注入成环境变量，命令用 `$NAME` 引用，模型不见真值 |
| Layer B | 密钥 | 落 history/广播时精确脱敏成 `«SECRET:NAME»` 兜底 |
| **Layer C · 隐私护栏** | **客户实体/数据** | **出模型前换占位符、回模型后还原真名** |

**工作方式**（Layer C，可逆假名化）：

1. **出模型前**：检测敏感实体 → 替换成稳定占位符 `【类型_N】`，模型 / 第三方网关**只看到假名**；
2. **回模型后**：把答案里的占位符**自动还原**成真名，用户体验无损；
3. **映射表只留本机**：`~/.myhi/pseudo-maps/<会话>.json`（`chmod 600`），跨轮累积（同一实体全程同一占位符）、跨 `--resume` 持久，**绝不进会话/网关/记忆**。

**检测能力**：

- **高危 PII 正则**：身份证、统一社会信用代码、银行卡、手机、邮箱、车牌；
- **项目主体词典**：自录「我方主体 / 关联公司 / 关键人」名单，命中即脱敏（最实用一档）；
- **金额**（严格档）。

三档 `仅高危 / 标准 / 严格`，默认关闭（opt-in）。在会话页快捷栏「🛡 护栏」抽屉自助维护（开关 / 档位 / 词典增删批量）。

**审计留痕**：每个有脱敏的轮次记录「时间 / 脱敏数量 / 类型分布 / 发给模型的脱敏后全文」——**只含假名文本、不含真值**，可在护栏抽屉「📋 审计」查看并**一键导出**给合规方取证，证明「模型这一轮实际看到的就是这段假名」。

> **⚠️ 边界**：护栏只保护**用户经对话框提交的内容**。若让 AI 用 Read/Bash 工具去读磁盘上的原始数据文件，`tool_result` 是在 Claude 进程内部直送模型的，myhi 拦不到——要保护就把数据**贴进对话框**，别让 AI 去读原始文件。

---

## 网络与连接

### 局域网

启动后自动检测本机局域网 IP，在终端输出访问地址。同一 Wi-Fi / 有线网络下的设备直接访问。

### Tailscale

自动检测 Tailscale IP（100.x.x.x），优先使用。通过 Tailscale 组网的设备可安全访问，无需端口转发或公网暴露。

### QR 码

仪表盘页面提供 QR 码生成，手机扫码即可打开会话。QR 码中包含一次性认证 token，无需再次输入密码。

### 自动附加终端

启动时（`MYHI_AUTO_ATTACH=1`）会自动打开一个本地终端窗口并附加到会话：

- Windows：优先使用 Windows Terminal (wt.exe)
- macOS：通过 osascript 打开 Terminal.app
- Linux：依次尝试 gnome-terminal / xterm / konsole

---

## 数据目录

所有运行时数据存储在 `~/.myhi/`，可跨重启持久化：

```
~/.myhi/
├── token              # 主认证 token（32 位十六进制）
├── password           # 默认 4 位数登录密码
├── users.json         # 用户账号配置（可选，含 SSH 账号映射）
├── roles.json         # 角色权限配置（可选）
├── sessions.json      # 会话持久化（重启后自动恢复）
├── uploads/           # 通过 Web 上传的图片
├── daemon.pid         # 守护进程 PID
└── daemon.log         # 守护进程日志
```

---

## API 参考

### HTTP 接口

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/login` | GET | 否 | 登录页面 |
| `/login` | POST | 否 | 密码认证（有限速） |
| `/logout` | POST | 否 | 退出登录 |
| `/api/status` | GET | 否 | 登录状态查询 |
| `/` | GET | 是 | 仪表盘 |
| `/terminal/:id` | GET | 是 | 聊天式界面 |
| `/terminal-raw/:id` | GET | 是 | xterm.js 终端 |
| `/api/sessions` | GET | 是 | 会话列表 |
| `/api/sessions` | POST | 是 | 创建会话 |
| `/api/sessions/:id` | DELETE | 是 | 删除会话 |
| `/api/claude-sessions` | GET | 是 | 可导入的 Claude 会话列表 |
| `/api/dirs` | GET | 是 | 目录浏览（仅 admin） |
| `/api/me` | GET | 是 | 当前用户信息 |
| `/api/usage` | GET | 否 | AI 用量统计 |
| `/api/version` | GET | 是 | 版本信息（当前版本 + 最新版本） |
| `/api/update` | POST | 是 | 触发自动更新（仅 admin） |
| `/api/git/info` | GET | 是 | 获取项目 Git remote 信息 |
| `/api/git/push` | POST | 是 | Git 提交并推送 |
| `/upload` | POST | 是 | 图片上传（最大 20MB） |
| `/qr/:sessionId` | GET | 是 | QR 码 SVG（一次性 token） |

### Socket.IO 事件

**会话管理**

| 事件 | 方向 | 说明 |
|------|------|------|
| `join(sessionId)` | 客户端→服务器 | 加入会话，接收历史和滚动缓冲区 |
| `joined(data)` | 服务器→客户端 | 加入确认，返回会话数据和用户角色 |
| `create(opts, ack)` | 客户端→服务器 | 创建 PTY 会话 |
| `create-agent(opts, ack)` | 客户端→服务器 | 创建 Agent 会话 |
| `kill(sessionId)` | 客户端→服务器 | 删除会话（仅 admin） |
| `rename({sessionId, title})` | 客户端→服务器 | 重命名会话 |
| `sessions(list)` | 服务器→客户端 | 会话列表广播 |

**终端 I/O**

| 事件 | 方向 | 说明 |
|------|------|------|
| `input(data)` | 客户端→服务器 | PTY 输入（需控制权） |
| `output(data)` | 服务器→客户端 | PTY 输出 |
| `resize({cols, rows})` | 客户端→服务器 | 终端尺寸调整 |
| `session-exit({code})` | 服务器→客户端 | 会话进程退出 |

**AI Agent**

| 事件 | 方向 | 说明 |
|------|------|------|
| `agent:query({prompt})` | 客户端→服务器 | 发送 AI 查询（需控制权） |
| `agent:message(msg)` | 服务器→客户端 | 流式消息（文本/工具/思考/权限） |
| `agent:busy(bool)` | 服务器→客户端 | AI 处理状态 |
| `agent:history([msgs])` | 服务器→客户端 | 历史消息回放 |
| `agent:interrupt()` | 客户端→服务器 | 中断当前 AI 操作 |
| `agent:permission({requestId, allow})` | 客户端→服务器 | 批准/拒绝权限请求 |
| `agent:error({message})` | 服务器→客户端 | 错误通知 |

**控制权**

| 事件 | 方向 | 说明 |
|------|------|------|
| `take-control` | 客户端→服务器 | 请求控制权 |
| `release-control` | 客户端→服务器 | 释放控制权 |
| `control-changed` | 服务器→客户端 | 控制权变更广播 |
| `control-denied({reason})` | 服务器→客户端 | 控制权被拒绝 |
| `set-mode({mode})` | 客户端→服务器 | 设置 Agent 权限模式 |
| `kick-user({socketId})` | 客户端→服务器 | 强制断开用户 |
| `list-viewers(ack)` | 客户端→服务器 | 获取在线用户列表 |

---

## 使用场景

### 远程终端访问

开发者在电脑上启动 myhi，用手机在任何地方查看和控制终端。适合：
- 离开工位时查看长时间运行的任务
- 在沙发上用手机 review 日志
- 通过 Tailscale 安全地远程操作服务器

### 多人协作

团队成员共同查看同一个终端会话：
- Pair programming：一人输入，多人观看
- 演示和教学：admin 控制，学员观看
- 故障排查：多人同时查看错误日志，按需切换控制权

### AI 辅助编程

在手机上通过 Agent 会话与 Claude 协作：
- 用自然语言描述需求，AI 自动编写代码
- 查看文件差异，审批变更
- 随时随地进行代码审查和修改

### 团队服务器管理

为团队提供受控的服务器访问：
- 每人独立账号和工作目录
- SSH 账号支持 VS Code Remote-SSH 远程开发
- 权限分级（admin 全权限，viewer 只读）
- 独占模式防止操作冲突
- admin 可审计在线用户并踢出
- 每个项目独立的 Git 凭据，一键提交到 GitLab / GitHub

---

## 技术架构

```
┌──────────────────────────────────────────────────┐
│  客户端（浏览器 / CLI attach）                      │
│  ┌────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ chat.html  │  │terminal.html│  │  attach.js  │ │
│  │ (ansi_up)  │  │  (xterm.js) │  │  (raw tty)  │ │
│  └─────┬──────┘  └──────┬──────┘  └──────┬─────┘ │
└────────┼────────────────┼────────────────┼───────┘
         │    Socket.IO   │                │
┌────────┼────────────────┼────────────────┼───────┐
│  服务器 (Express + Socket.IO)                     │
│  ┌─────┴────────────────┴────────────────┴─────┐ │
│  │              server.js                       │ │
│  │  HTTP 路由 · 认证中间件 · 事件处理            │ │
│  └──────┬──────────────────────────┬───────────┘ │
│  ┌──────┴──────┐           ┌──────┴──────┐      │
│  │ sessions.js │           │  agent.js   │      │
│  │  PTY 会话   │           │ Claude CLI  │      │
│  │  node-pty   │           │ stream-json │      │
│  └─────────────┘           └─────────────┘      │
└──────────────────────────────────────────────────┘
```

- **运行时**：Node.js >= 18（ES Modules）
- **后端**：Express.js HTTP 服务 + Socket.IO 实时通信
- **终端**：node-pty 创建伪终端进程，100KB 循环滚动缓冲区
- **前端**：原生 JavaScript（无框架），xterm.js + ansi_up 双渲染引擎
- **AI**：Claude Code CLI `--output-format stream-json` 模式，惰性启动进程
- **构建**：ncc 打包 + esbuild 压缩 → 单文件 `dist/index.js`

---

## 开发

```bash
git clone <repo-url>
cd myhi
npm install
npm run dev       # 开发模式，文件变更自动重载
npm run build     # 构建到 dist/
npm start         # 运行构建产物
```

### 项目结构

```
myhi/
├── bin/myhi.js          # CLI 入口：命令解析与分发（含 ssh 子命令）
├── src/
│   ├── server.js        # 主服务器：路由、Socket.IO、认证、Git API
│   ├── sessions.js      # 会话管理：PTY、Agent、持久化
│   ├── agent.js         # Claude Code CLI 集成（出向脱敏 / 入向还原落点）
│   ├── secrets.js       # 密钥库 Layer A/B（env 注入 + 精确脱敏）
│   ├── pseudo.js        # 🛡 隐私护栏 Layer C（去标识化 / 可逆假名化 / 审计留痕）
│   ├── roles.js         # 角色与用户管理
│   └── attach.js        # CLI 附加客户端
├── public/
│   ├── index.html       # 仪表盘（含版本更新检测）
│   ├── chat.html        # 聊天式界面（含 Git 提交、ESC 取消）
│   ├── terminal.html    # xterm.js 终端
│   ├── login.html       # 登录页
│   └── lib/             # xterm.js 等前端库
├── scripts/build.js     # 构建脚本
└── dist/                # 构建产物
```

---

## 许可证

[MIT](LICENSE)。第三方组件的许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
