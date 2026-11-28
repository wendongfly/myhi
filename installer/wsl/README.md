# WSL Ubuntu 一键安装（Windows 11）

在 Windows 11 上开启 WSL、安装 Ubuntu，并顺手把 myhi 装进 WSL（复用 [`installer/linux/install-myhi.sh`](../linux/README.md)：Node + myhi + Claude CLI + systemd 服务 + 网关配置，一条龙）。

## 用法

**普通用户**：双击 `Install-wsl-ubuntu.bat`（自动弹 UAC 提权，全程不用碰终端）。

**自定义参数**（管理员 PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File install-wsl-ubuntu.ps1 `
  [-UserName wsl用户名] [-MyhiVersion 1.3.230] [-Port 12300] [-SkipClaude] [-NoMyhi]
```

- `-UserName`：WSL 默认用户（缺省取 Windows 用户名，自动清洗成合法 Linux 用户名）
- `-MyhiVersion` / `-Port` / `-SkipClaude`：透传给 Linux 安装器（默认 latest / 12300 / 装 Claude）
- `-NoMyhi`：只装 WSL + Ubuntu，不装 myhi
- `..\linux\gateway.json` 存在时会自动部署进 WSL（AI 开箱即用；该文件含密钥，已 gitignore、绝不入库）

## 流程（幂等，重复运行 = 补齐/升级）

1. 自提权 → 检查 Win11 版本（22621+ 才有 mirrored 网络）
2. `wsl --install --no-launch -d Ubuntu`（开启系统功能、下载 WSL 与 Ubuntu、跳过首次交互向导）
3. 以 root 首次进入完成初始化；创建默认用户；`/etc/wsl.conf` 打开 **systemd**（myhi 服务需要；改动前自动备份）
4. Win11 22H2+ 写 `%USERPROFILE%\.wslconfig` 开 **mirrored 网络**——手机/平板在局域网可直接访问 WSL 里的端口
5. 防火墙放行 12300/12301
6. `wsl --terminate` 重启发行版使配置生效
7. 灌入并运行 Linux 安装器（以 root + `SUDO_USER=<用户>`：装到 /usr、数据落用户家目录、服务以该用户跑，无需先设密码）

## 注意

- **首次开启 WSL 功能需要重启电脑**：脚本会明确提示；重启后重跑一次即接着完成剩余步骤（幂等）。
- 反复起不来 → BIOS/UEFI 里开启虚拟化（Intel VT-x / AMD SVM）。
- **网络模式**：
  - mirrored（默认写入）：WSL 与 Windows 共用 IP，局域网设备直连 `http://<电脑IP>:12300`；仅 Win11 22H2+ 支持。
  - NAT（未写 mirrored 时）：只有本机能访问。要让手机访问，可手动加端口转发（WSL IP 每次启动会变，需重设）：
    `netsh interface portproxy add v4tov4 listenport=12300 connectport=12300 connectaddress=<wsl hostname -I 的 IP>`
- **WSL 用户密码**：WSL 登录不需要密码；要用 `sudo` 时先进 WSL 执行 `sudo passwd <用户名>`（myhi 网页自升级所需的 sudoers 免密已由安装器配好）。
- 国内网络：WSL/Ubuntu 从微软服务器下载可能较慢；npm 走 npmmirror 一般无碍。
- 升级 myhi：进 WSL 重跑 `/root/install-myhi.sh`（幂等 = 升级），或用网页 /admin 自升级。

## 局限（如实）

- 脚本经过语法级验证与流程审走，**尚未在干净 Win11 机器上端到端实测**；`wsl --install` 的输出措辞因系统语言/版本而异，重启探测覆盖了中英文常见措辞与 3010 返回码。
- 依赖 `installer/linux/install-myhi.sh`（同包 `installer/` 内相对引用）；单独拷走本目录则只完成 WSL Ubuntu 安装。
