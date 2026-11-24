# myhi Windows 傻瓜安装器（阶段一：让员工省心）
# 作用：把 myhi 装成「开机登录自动后台运行」，员工全程不碰终端。
#   1) 没装 Node 就用 winget 自动装；2) npm 装/更新 myhi 全局包；
#   3) 生成隐藏启动器(VBS，无黑窗)；4) 注册计划任务(登录触发/当前用户/非提权/脱离会话)；
#   5) 防火墙放行 12300/12301(局域网手机平板可访问)；6) 建桌面/开始菜单快捷方式；7) 立即启动。
# 需以管理员运行（Install-myhi.bat 会自动提权）。
#Requires -Version 5
# -Headless：开机即运行（无论是否登录，用 S4U 免密码）；不加则默认「登录时运行」（员工电脑场景）。
# -SkipClaude：不安装 Claude CLI（默认会装，myhi 的 AI 引擎）。
param([switch]$Headless, [switch]$SkipClaude)

$ErrorActionPreference = 'Stop'
$Port     = 12300
$TaskName = 'myhi-autostart'

function Info($m){ Write-Host "[myhi] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "[OK]  $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[!]   $m" -ForegroundColor Yellow }

try {
  # ---------- 1) Node ----------
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Warn "未检测到 Node.js，尝试用 winget 自动安装 LTS..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      # 临时设 Continue：winget 的 stderr 在 ErrorActionPreference=Stop 下会被误判为致命错误
      $eaW = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      $ErrorActionPreference = $eaW
      $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
      $node = Get-Command node -ErrorAction SilentlyContinue
    }
    if (-not $node) { throw "无法自动安装 Node.js。请先手动装 Node 18+（https://nodejs.org/），再重新运行本安装程序。" }
  }
  $nodeExe = $node.Source
  Ok "Node: $(& $nodeExe -v)  ($nodeExe)"

  # ---------- 2) myhi 全局包 ----------
  # 若本机已在跑 myhi，daemon 会锁住 node-pty 的 pty.node → npm 覆盖时 EBUSY。先停再装。
  # 整段临时设 Continue：taskkill/npm 等【原生命令】的 stderr 在 ErrorActionPreference=Stop
  # 下会被 PS5.1 包成 ErrorRecord 误当致命错误（"进程不存在"/EBADENGINE 都会中断安装）。
  $eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Info "停止可能在运行的 myhi（释放 pty.node，避免升级 EBUSY）..."
  $pidFile = Join-Path $env:USERPROFILE '.myhi\daemon.pid'
  if (Test-Path $pidFile) {
    $dpid = (Get-Content $pidFile -Raw).Trim()
    if ($dpid) { taskkill /PID $dpid /T /F 2>$null | Out-Null }
  }
  # 兜底：按命令行特征杀掉残留 myhi 的 node 进程（不会误伤本安装脚本——它是 powershell.exe）
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'myhi' } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
  # 清 npm 上次 EBUSY/ENOTEMPTY 残留的 .myhi-<hash> 临时目录
  $npmRoot0 = (npm.cmd root -g 2>$null | Select-Object -Last 1)
  if ($npmRoot0) { Get-ChildItem (Join-Path $npmRoot0.ToString().Trim() '@wendongfly') -Filter '.myhi-*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  Info "安装/更新 myhi（npm i -g @wendongfly/myhi@latest，稍候）..."
  # 新版 npm 默认拦「包安装脚本」(allow-scripts 安全特性)，而 node-pty 靠其安装脚本放置原生
  # pty.node(终端核心)、@wendongfly/myhi 靠 postinstall chmod。带 --allow-scripts 放行这两个包；
  # 老版本 npm 不认此值只当普通 config、脚本本就默认执行，两种 npm 都 OK。
  npm.cmd i -g '@wendongfly/myhi@latest' --allow-scripts=@wendongfly/myhi,node-pty
  $npmExit = $LASTEXITCODE
  if ($npmExit -ne 0) {
    # 万一某 npm 版本因这个 flag 报错，退回普通安装（老 npm 默认就跑脚本）
    npm.cmd i -g '@wendongfly/myhi@latest'
    $npmExit = $LASTEXITCODE
  }
  $npmRoot = (npm.cmd root -g | Select-Object -Last 1).ToString().Trim()
  $ErrorActionPreference = $eaPrev
  if ($npmExit -ne 0) { throw "npm 安装失败 (exit $npmExit)。若是 EBUSY，多为 myhi 仍在运行占用 pty.node，请关掉后重试。" }

  # ---------- 2b) Claude Code CLI（myhi 的 AI 引擎，@anthropic-ai/claude-code）----------
  if (-not $SkipClaude) {
    $eaC = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    # 停掉可能在跑的 claude.exe（升级时它锁着 ~250MB 原生二进制会 EBUSY），并清 .claude-code-<hash>
    # 残留（防 npm 原子替换 ENOTEMPTY）——与前面停 myhi/清 .myhi-* 同款。
    taskkill /IM claude.exe /F /T 2>$null | Out-Null
    $npmRc = (npm.cmd root -g | Select-Object -Last 1).ToString().Trim()
    Get-ChildItem (Join-Path $npmRc '@anthropic-ai') -Filter '.claude-code-*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Info "安装/更新 Claude CLI（npm i -g @anthropic-ai/claude-code@latest，稍候）..."
    npm.cmd i -g '@anthropic-ai/claude-code@latest' --allow-scripts=@anthropic-ai/claude-code
    if ($LASTEXITCODE -ne 0) { npm.cmd i -g '@anthropic-ai/claude-code@latest' }

    # 校验 claude 真能跑：claude-code 2.x 是平台原生二进制，其平台包(optionalDependencies，
    # 如 @anthropic-ai/claude-code-win32-x64)可能在安装时【静默失败】没装上 → bin/claude 只剩
    # 500B 报错占位 → 用时才发现坏。故装完立即验证，坏了【自动补装对应平台包】自愈。
    function Test-ClaudeVer {
      try { $v = (& claude --version 2>&1 | Select-Object -First 1); if ("$v" -match '\d+\.\d+\.\d+') { return "$v" } } catch {}
      return $null
    }
    $cv = Test-ClaudeVer
    if (-not $cv) {
      Warn "Claude 原生二进制缺失（平台包静默失败），补装平台包..."
      $npmRootC = (npm.cmd root -g | Select-Object -Last 1).ToString().Trim()
      $ccPkg = Join-Path $npmRootC '@anthropic-ai\claude-code\package.json'
      $ccVer = if (Test-Path $ccPkg) { (Get-Content $ccPkg -Raw | ConvertFrom-Json).version } else { 'latest' }
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      # 清 .claude-code-<hash> 残留，防补装时 ENOTEMPTY
      Get-ChildItem (Join-Path $npmRootC '@anthropic-ai') -Filter '.claude-code-*' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      npm.cmd i -g "@anthropic-ai/claude-code-win32-$arch@$ccVer"
      $cv = Test-ClaudeVer
    }
    $ErrorActionPreference = $eaC
    # 不因 claude 装失败而中断整体部署（可事后手动补）
    if ($cv) { Ok "Claude CLI 可用：$cv" }
    else { Warn "Claude CLI 仍不可用，请手动排查：claude --version（或补装 @anthropic-ai/claude-code-win32-x64）" }
  }

  # ---------- 2c) 放开 PowerShell 执行策略 ----------
  # 默认 Restricted 会拦 npm 生成的 claude.ps1，用户在 PS 里敲 claude 报 UnauthorizedAccess。
  # 设成 CurrentUser=RemoteSigned（免管理员、安全：本地脚本可跑、远程需签名）。仅当当前策略会拦
  # .ps1 时才设，不覆盖用户已有的更宽松策略。myhi 自己 spawn .cmd/.exe，本身不受此影响。
  try {
    $ep = Get-ExecutionPolicy -Scope CurrentUser
    if ($ep -in @('Restricted', 'Undefined', 'AllSigned')) {
      Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
      Ok "已放开 PowerShell 执行策略（CurrentUser=RemoteSigned），可在 PS 里直接敲 claude"
    } else {
      Ok "PowerShell 执行策略无需调整（当前：$ep）"
    }
  } catch { Warn "设置执行策略失败（不影响 myhi 运行）：$($_.Exception.Message)" }
  $pkgDir  = Join-Path $npmRoot '@wendongfly\myhi'
  $daemon  = Join-Path $pkgDir 'bin\daemon.js'
  if (-not (Test-Path $daemon)) { throw "未找到 myhi 安装目录：$daemon" }
  Ok "myhi: $(& $nodeExe (Join-Path $pkgDir 'bin\myhi.js') -v)"

  # ---------- 3) 隐藏启动器（无黑窗）----------
  $cfgDir = Join-Path $env:USERPROFILE '.myhi'
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  $vbs = Join-Path $cfgDir 'myhi-launch.vbs'
  $runCmd = '"' + $nodeExe + '" "' + $daemon + '"'          # 带引号，含空格路径安全
  $vbsArg = $runCmd -replace '"', '""'                       # VBS 字符串里的 " 要写成 ""
  $vbsBody = "' myhi 安装器生成：窗口隐藏(0)+不等待(False) 启动 daemon`r`n" +
             "CreateObject(""WScript.Shell"").Run """ + $vbsArg + """, 0, False"
  # VBS 用系统 ANSI 编码存，兼容中文用户名路径
  [IO.File]::WriteAllText($vbs, $vbsBody, [Text.Encoding]::Default)
  Ok "启动器：$vbs"

  # 部署 AI 网关配置：若安装包目录随附 gateway.json（管理员预置，含 baseUrl/apiKey），复制到 ~/.myhi。
  # 这样批量部署时 AI 开箱即用；此文件含密钥，只留本机、绝不进 git（见 installer/README 的批量部署）。
  $gwSrc = Join-Path $PSScriptRoot 'gateway.json'
  if (Test-Path $gwSrc) {
    Copy-Item $gwSrc (Join-Path $cfgDir 'gateway.json') -Force
    Ok "已部署 AI 网关配置（gateway.json → ~/.myhi，AI 开箱即用）"
  } else {
    Warn "未随附 gateway.json：AI 需部署后在 ~/.myhi/gateway.json 填 {\"baseUrl\":...,\"apiKey\":...} 才能用（见 README）"
  }

  # ---------- 4) 计划任务：登录触发 / 当前用户 / 非提权 / 脱离会话 ----------
  # 用当前用户身份 + RunLevel Limited：myhi 里开的终端就是普通员工权限，不是管理员，避免提权面。
  # 用规范账户名（机器名\用户 或 域\用户），Windows 能正确映射到 SID；
  # 直接拼 $env:USERDOMAIN\$env:USERNAME 在某些环境(如 SSH 会话)会报"账户名与安全标识无映射"。
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  if ($Headless) {
    # 常驻/无人登录：开机即以该用户身份后台跑（S4U 免密码、不需要交互登录）。RunLevel Limited 保持非提权。
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
    $modeDesc  = "开机即运行（无论是否登录）"
  } else {
    # 员工电脑：登录时在其会话里后台跑。
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    $modeDesc  = "登录时运行"
  }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Ok "开机自启已设置（计划任务 $TaskName：$modeDesc，普通权限）"

  # ---------- 5) 防火墙 ----------
  foreach ($p in @(12300, 12301)) {
    $rn = "myhi TCP $p"
    Get-NetFirewallRule -DisplayName $rn -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $rn -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -Profile Private,Domain | Out-Null
  }
  Ok "防火墙已放行 12300/12301（局域网手机/平板可访问）"

  # ---------- 6) 快捷方式 ----------
  $url = "https://localhost:$Port"
  foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
    if (Test-Path $dir) { Set-Content -Path (Join-Path $dir 'myhi 控制台.url') -Value "[InternetShortcut]`r`nURL=$url" -Encoding ASCII }
  }
  Ok "快捷方式：myhi 控制台 → $url"

  # ---------- 7) 立即启动 ----------
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 6
  Write-Host ""
  Info "访问地址：$url   （首次有自签证书警告，点『高级 → 继续前往』即可）"
  Info "默认密码见：$cfgDir\password"
  Ok  "安装完成！以后开机登录自动运行，无需再开终端或敲命令。"
} catch {
  Warn "安装失败：$($_.Exception.Message)"
  exit 1
}
