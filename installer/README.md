# myhi Windows 傻瓜安装（让员工省心）

给普通员工用的一键安装：**双击一个文件，装好后开机登录自动在后台运行，全程不用开终端、不用敲命令**。

> 其他平台：Linux 原生机看 [`linux/`](linux/README.md)；**Windows 11 上走 WSL Ubuntu**（要 systemd 服务形态、或统一 Linux 部署口径）看 [`wsl/`](wsl/README.md)——双击 `wsl/Install-wsl-ubuntu.bat`，开 WSL + 装 Ubuntu + 顺手把 myhi 装进去（mirrored 网络，手机平板局域网直达）。

## 员工怎么用

1. 把整个 `installer` 文件夹拷到员工电脑（或发压缩包）。
2. 按场景右键选一个 `.bat` → **以管理员身份运行**（会弹 UAC，点「是」）：
   - **`Install-myhi.bat`** —— **员工自己的电脑**（登录后用）：登录时自动后台运行。
   - **`Install-myhi-headless.bat`** —— **常驻/常开机器（服务器）**：**开机即运行，无论是否登录**（用 S4U，免密码、非提权）。
3. 等它自动完成（没装 Node 会自动装、装/更新 myhi、设自启、放行防火墙、建快捷方式）。
4. 桌面出现 **「myhi 控制台」** 图标，双击打开 `https://localhost:12300`（首次有自签证书警告，点「高级 → 继续前往」）。首次登录密码见 `%USERPROFILE%\.myhi\password`。

之后 myhi **自动在后台运行**（登录模式=登录后；常驻模式=开机即起），员工只管点桌面图标用，或用手机/平板在同一局域网访问。

卸载：右键 **`Uninstall-myhi.bat` → 以管理员身份运行**（撤销自启/防火墙/快捷方式；保留 myhi 本体与数据）。

## 批量部署很多新电脑（一次配好、台台开箱即用）

安装器已经把**依赖一起装了**：Node（缺则 winget 装）+ **Claude CLI**（AI 引擎）+ myhi。要让新机**连 AI 都免配、开箱即用**，管理员只需在部署包里预置一份网关配置：

1. 把 `installer/gateway.json.example` 复制成 **`gateway.json`**，填入你的 AI 网关 `baseUrl` 和 `apiKey`，放在 installer 文件夹里。
2. 把整个文件夹（含 `gateway.json`）打包发到各新机。
3. 每台机右键 `Install-myhi.bat`（或 `Install-myhi-headless.bat`）以管理员运行 → 自动装好 node/claude/myhi + **把 gateway.json 部署到 `~/.myhi/`** → AI 直接能用。

> 🔒 `gateway.json` 含密钥，已被 `.gitignore` 忽略、**绝不进 git**；只在你的部署包/各机本地之间流转。不预置也行——那样各机装完需在 `~/.myhi/gateway.json` 手动填 `{"baseUrl":"...","apiKey":"..."}`（或在网页里配）后 AI 才可用。

> 还没做的（可后续加）：预置登录密码、预置密钥库 `secrets.json`。需要的话告诉我。

## 升级怎么做

myhi 有两条升级路径，都不需要员工敲命令：

1. **网页点「更新」**（最省事）：仪表盘每 10 分钟查新版，有新版会显示横幅，员工点一下 → daemon 自动 `npm i -g @latest` 并重启。⚠️ **Windows 注意**：升级时正在跑的 server 子进程可能锁着 `node-pty` 的 `pty.node`，导致 npm 覆盖 EBUSY 而升级不生效（会继续跑旧版）。遇到这种情况用下面第 2 条。
2. **重新跑一次安装器（推荐、最可靠）**：重新右键跑对应的 `Install-*.bat`。安装器是**幂等**的——它会**先停掉 myhi 释放 `pty.node` → `npm i -g @latest` → 重新起**，专门绕开了 EBUSY。所以在 Windows 上「**再跑一次安装器 = 干净升级**」。

> 运维批量升级：各机 `npm i -g @wendongfly/myhi@latest` 后重启（Linux `systemctl restart myhi`；Windows 计划任务模式先停 daemon 再由计划任务/手动拉起）。

## 它到底做了什么（管理员/运维看）

`install-myhi.ps1`：

1. **Node**：没有就 `winget install OpenJS.NodeJS.LTS` 自动装；已有则用现成的。
2. **myhi**：`npm i -g @wendongfly/myhi@latest --allow-scripts=@wendongfly/myhi,node-pty`（放行 node-pty 原生模块）。
3. **Claude CLI**（myhi 的 AI 引擎）：`npm i -g @anthropic-ai/claude-code@latest`（加 `-SkipClaude` 可跳过）。装完**校验 `claude --version`，坏了自动补装对应平台原生二进制包**；并把 `CurrentUser` 执行策略设为 `RemoteSigned`（默认 Restricted 会拦 `claude.ps1`，让用户能在 PowerShell 里直接敲 `claude`）。
4. **隐藏启动器**：生成 `~/.myhi/myhi-launch.vbs`，用 `WScript.Shell.Run(cmd, 0, False)` **窗口隐藏**启动 `node bin/daemon.js`（无黑窗）。
5. **AI 网关配置**：若安装包目录随附 `gateway.json`（管理员预置），复制到 `~/.myhi/gateway.json`，AI 开箱即用。
6. **开机自启 = 计划任务**（Windows 上的「systemd 等价物」）：`myhi-autostart`，**当前用户身份 + `RunLevel Limited`(非提权) + 脱离创建者会话**；触发方式按模式：默认「登录触发」，`-Headless` 则「开机触发 + S4U（无论是否登录）」。同时解决开机自启、登出/重启后存活、终端为普通权限（安全）。
7. **防火墙**：放行 TCP 12300/12301（Private/Domain），局域网手机平板可访问。
8. **快捷方式**：桌面 + 开始菜单 `myhi 控制台.url → https://localhost:12300`。
9. **立即启动**一次。

**升级**照旧走网页里的「更新」横幅（daemon 内建 `npm i -g @latest` + 重启，见 `bin/daemon.js`），员工点一下即可，无需碰命令行。

## 关键设计取舍

- **为什么用计划任务不用 Windows 服务**：Windows 服务默认以 `SYSTEM` 跑 → myhi 开的每个终端都会是 SYSTEM 最高权限，是严重提权面；且服务账户的 `~` 与员工登录账户不同，`~/.myhi` 配置对不上。计划任务「登录触发 + 当前用户 + 非提权」天然规避这两点，且脱离会话（正是我们远程运维时被迫用 WMI 解决的那个「登出即死」问题）。
- **谁该是管理员**：注册计划任务/防火墙需要管理员。若员工是**自己电脑的本地管理员**（最常见），`Install-myhi.bat` 提权后 `$env:USERNAME` 仍是员工本人，自启身份正确。若员工是标准用户、UAC 里输入的是**另一个管理员账户**，则自启会挂到那个管理员账户名下——这种环境请改用「以员工账户运行」的方式（或手工建计划任务时指定员工为 principal）。

## 已实测

已在一台真实 Windows 客户机（Win10 + Node 16 + nvm）端到端跑通：Node 检测→停旧释放 `pty.node`→npm 装/更新→隐藏启动器→计划任务注册(Ready)→防火墙→快捷方式→启动，`https://localhost:12300` 返回 302。安装器对重复运行/升级（myhi 已在跑）也做了处理：**先停 myhi 释放 `pty.node` 再 npm**，避免升级时 EBUSY。

## 手动 npm 安装的注意（新版 npm）

若不用安装器、直接 `npm i -g @wendongfly/myhi`，**新版 npm 默认拦截包的安装脚本**（`allow-scripts` 安全特性），会看到 `npm warn allow-scripts` 提示——此时 `node-pty` 的原生模块 `pty.node`（终端核心）没被正确放置，**myhi 终端会起不来**。解决：加 `--allow-scripts` 放行：

```
npm i -g @wendongfly/myhi --allow-scripts=@wendongfly/myhi,node-pty
```

（安装器 `install-myhi.ps1` 已自动带这个参数，用安装器不必手动加。）验证：打开 myhi 网页开一个「Shell/终端」会话，能敲命令即正常。

## 局限（当前 MVP）

- 仍需要机器能访问 npm（装/升级 myhi）。
- 计划任务在**登录时**启动一次；若 daemon 中途自己挂了，要到下次登录才拉起（daemon 内部已有 server 崩溃自恢复，daemon 本身很稳）。后续可加一个带重复间隔的看护任务。
- **触发器是「登录时」**：适合「员工登录后用自己电脑」的场景。若是**无人交互登录的常驻/headless 机器**（重启后没人登录），登录触发不会发生 → 不会自动起；那种机器该用「无论是否登录都运行」的服务模式（但需权衡 SYSTEM 权限/账户密码）。
- Node <18 只会 EBADENGINE 警告不阻断（实测 16 能跑），但建议尽量 18+。

## 后续可演进（阶段二/三，非本 MVP）

- **免装 Node**：随包附 portable `node.exe`（或 Node SEA 打成单 exe），连「装 Node」这道坎也去掉。难点是 `node-pty` 原生模块 `pty.node` 要随包带上。
- **正式安装包**：用 **Inno Setup** 把上面这套 + portable node 打成一个 `myhi-setup.exe` 安装向导（比 .bat 更友好、可加图标/许可/卸载入口）。
- **系统托盘小程序**：托盘图标右键「显示地址+二维码 / 启停 / 检查更新 / 打开面板」，日常操作全图形化（不建议上 Electron，太重）。
