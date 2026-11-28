# myhi WSL Ubuntu 一键安装器（Windows 11）
# 作用：在本机开启 WSL 并安装 Ubuntu，然后可顺手把 myhi 装进 WSL（复用 Linux 安装器 installer/linux/install-myhi.sh）。
#   1) 自提权；2) 开启/安装 WSL + Ubuntu（--no-launch 跳过首次交互向导）；
#   3) 创建默认用户 + /etc/wsl.conf 打开 systemd（myhi 的 systemd 服务需要）；
#   4) Win11 22H2+ 配 mirrored 网络（手机平板局域网可直接访问 WSL 里的端口）；
#   5) 防火墙放行 12300/12301；6) 把 Linux 安装器 + gateway.json 灌进 WSL，以 root+SUDO_USER 运行（文件落用户家目录、服务以该用户跑）。
# 用法：双击 Install-wsl-ubuntu.bat（自动提权），或管理员 PowerShell 里：
#   powershell -ExecutionPolicy Bypass -File install-wsl-ubuntu.ps1 [-UserName xx] [-MyhiVersion 1.3.230] [-Port 12300] [-SkipClaude] [-NoMyhi]
# 幂等：重复运行 = 补齐/升级。首次开启 WSL 功能后需要重启电脑，重启后重跑本脚本会接着往下走。
#Requires -Version 5
param([string]$UserName, [string]$MyhiVersion, [int]$Port = 12300, [switch]$SkipClaude, [switch]$NoMyhi)

$ErrorActionPreference = 'Stop'

function Info($m){ Write-Host "[myhi] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "[OK]  $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[!]   $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[X]   $m" -ForegroundColor Red; Read-Host '按回车退出'; exit 1 }

# ---------- 0) 编码（两处都要设，坑见 CLAUDE.md 记忆：PS5.1 默认 ASCII 管道会把中文弄花） ----------
# 读取 wsl.exe 输出：chcp 65001 下 wsl 的 UTF-16 输出会解码成"字符+NUL"，后续统一 strip NUL；
# 往 WSL 管道灌文件（install-myhi.sh 含中文）必须 UTF-8。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- 1) 自提权 ----------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Info '请求管理员权限（UAC）...'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
  if ($UserName)    { $argList += ('-UserName "{0}"'    -f $UserName) }
  if ($MyhiVersion) { $argList += ('-MyhiVersion "{0}"' -f $MyhiVersion) }
  if ($Port -ne 12300) { $argList += '-Port {0}' -f $Port }
  if ($SkipClaude)  { $argList += '-SkipClaude' }
  if ($NoMyhi)      { $argList += '-NoMyhi' }
  Start-Process powershell -Verb RunAs -ArgumentList ($argList -join ' ')
  exit
}

# ---------- 2) 系统版本检查 ----------
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) { Die "本脚本面向 Windows 11（内部版本 $build 过低，WSL 现代安装方式不可用）。" }
if ($build -lt 22621) { Warn "内部版本 $build < 22621（Win11 22H2）：WSL mirrored 网络不可用，将跳过该配置（局域网直连需手动 portproxy，见 README）。" }

# ---------- 3) WSL 是否可用 ----------
$wslExe = Get-Command wsl -ErrorAction SilentlyContinue
$needReboot = $false
if (-not $wslExe) {
  Info '未检测到 WSL，开始安装（开启虚拟机平台等系统功能，下载 WSL + Ubuntu，需要几分钟）...'
  $eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = (& wsl --install --no-launch -d Ubuntu 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $ErrorActionPreference = $eaPrev
  if ($code -eq 3010 -or $out -match 'reboot|重新启动|重启') { $needReboot = $true }
  if ($needReboot) {
    Warn 'WSL 组件已开启，需要重启电脑生效。请重启后重新运行本脚本，会接着完成后续步骤。'
    Read-Host '按回车退出'; exit 0
  }
  if ($code -ne 0) { Warn "wsl --install 返回码 $code：$out" }
} else {
  # 已有 WSL：顺手升到最新（失败不阻塞）
  $eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & wsl --update 2>$null | Out-Null } catch {}
  $ErrorActionPreference = $eaPrev
}

# ---------- 4) 找已装的 Ubuntu（名字可能是 Ubuntu / Ubuntu-24.04 等） ----------
$eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$raw = (& wsl --list --quiet 2>&1 | Out-String)
$ErrorActionPreference = $eaPrev
$distro = ($raw -replace "`0", '') -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^Ubuntu' } | Select-Object -First 1
if (-not $distro) {
  Info '未检测到 Ubuntu，开始安装（下载需要几分钟）...'
  $eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = (& wsl --install --no-launch -d Ubuntu 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $ErrorActionPreference = $eaPrev
  if ($code -eq 3010 -or $out -match 'reboot|重新启动|重启') { $needReboot = $true }
  if ($needReboot) {
    Warn 'WSL 组件已开启，需要重启电脑生效。请重启后重新运行本脚本，会接着完成后续步骤。'
    Read-Host '按回车退出'; exit 0
  }
  if ($code -ne 0) { Die "wsl --install Ubuntu 失败（返回码 $code）：$out" }
  $distro = 'Ubuntu'
}
Ok "Ubuntu 发行版: $distro"

# ---------- 5) 首次初始化（以 root 直接进，绕过交互向导） ----------
$eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& wsl -d $distro -u root -- true 2>$null
$probe = $LASTEXITCODE
$ErrorActionPreference = $eaPrev
if ($probe -ne 0) {
  Warn 'Ubuntu 还没起来（多半是刚开启 WSL 功能、需要重启电脑，或在 BIOS 里开启虚拟化）。'
  Warn '请重启电脑后重新运行本脚本；若反复失败，请在 BIOS/UEFI 打开 Intel VT-x / AMD SVM 虚拟化。'
  Read-Host '按回车退出'; exit 0
}

# ---------- 6) 用户名（默认取 Windows 用户名，清洗成合法 Linux 用户名） ----------
$user = $UserName
if (-not $user) { $user = $env:USERNAME }
$user = ($user.ToLower() -replace '[^a-z0-9_-]', '')
if ($user -match '^[0-9]') { $user = 'u' + $user }
if ($user.Length -gt 28)  { $user = $user.Substring(0, 28) }
if (-not $user)           { $user = 'ubuntu' }

# ---------- 7) 建用户 + 写 /etc/wsl.conf（systemd + 默认用户；幂等，已有配置先备份） ----------
Info "配置 WSL 用户 $user 与 systemd ..."
$bashConf = @'
set -e
u="$1"; [ -n "$u" ] || u=ubuntu
id -u "$u" >/dev/null 2>&1 || useradd -m -G sudo -s /bin/bash "$u"
f=/etc/wsl.conf
if [ -s "$f" ] && grep -q "^systemd=true" "$f" && grep -q "^default=$u" "$f"; then exit 0; fi
if [ -s "$f" ]; then cp -f "$f" "$f.bak.$(date +%s)"; fi
{ awk 'BEGIN{s=0} /^\[boot\]$/{s=1;next} /^\[user\]$/{s=1;next} /^\[/{s=0} s==0{print}' "$f" 2>/dev/null || true
  printf '\n[boot]\nsystemd=true\n\n[user]\ndefault=%s\n' "$u"; } > /etc/wsl.conf.new
chmod 644 /etc/wsl.conf.new && mv -f /etc/wsl.conf.new /etc/wsl.conf
'@
$bashConf | & wsl -d $distro -u root -- bash -s -- $user
if ($LASTEXITCODE -ne 0) { Warn 'wsl.conf 配置返回非零（可手动检查 WSL 里的 /etc/wsl.conf）' }

# ---------- 8) mirrored 网络（Win11 22H2+：手机平板局域网直达 WSL 端口） ----------
$wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
if ($build -ge 22621) {
  if (Test-Path $wslConfig) {
    $cur = Get-Content -Raw $wslConfig
    if ($cur -notmatch 'networkingMode') {
      Warn "已存在 $wslConfig 且未配 mirrored 网络——不动你的现有配置，手机平板直连可能不通，参考 README 手动加 [wsl2] networkingMode=mirrored"
    }
  } else {
    Info '写入 %USERPROFILE%\.wslconfig：networkingMode=mirrored（局域网设备可直接访问）...'
    Set-Content -Path $wslConfig -Value "[wsl2]`nnetworkingMode=mirrored`n" -Encoding ASCII
    Ok '.wslconfig 已写入'
  }
}

# ---------- 9) 防火墙放行（mirrored 网络下走 Windows 防火墙） ----------
$eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
foreach ($p in @($Port, $Port + 1)) {
  $rname = "myhi-wsl-$p"
  netsh advfirewall firewall delete rule name="$rname" 2>$null | Out-Null
  netsh advfirewall firewall add rule name="$rname" dir=in action=allow protocol=TCP localport=$p 2>$null | Out-Null
}
$ErrorActionPreference = $eaPrev
Ok "防火墙已放行 TCP $Port/$($Port+1)"

# ---------- 10) 重启发行版使 wsl.conf / .wslconfig 生效 ----------
Info '重启 WSL 发行版使配置生效...'
$eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& wsl --terminate $distro 2>$null
Start-Sleep -Seconds 2
& wsl -d $distro -u root -- true 2>$null
$probe = $LASTEXITCODE
$ErrorActionPreference = $eaPrev
if ($probe -ne 0) { Warn ('重启发行版后探测失败（可手动 wsl -d ' + $distro + ' 验证）') } else { Ok 'WSL 已带 systemd 运行' }

# ---------- 11) 装 myhi（复用 Linux 安装器；-NoMyhi 跳过） ----------
if ($NoMyhi) {
  Info ('跳过 myhi 安装（-NoMyhi）。WSL Ubuntu 已就绪：wsl -d ' + $distro)
} else {
  $shSrc = Join-Path $PSScriptRoot '..\linux\install-myhi.sh'
  if (-not (Test-Path $shSrc)) {
    Warn "未找到 $shSrc —— 只完成 WSL Ubuntu 安装；要装 myhi 请把本目录放回 myhi 包的 installer/ 下再跑"
  } else {
    Info '把 Linux 安装器灌进 WSL 并运行（装 Node + myhi + Claude CLI + systemd 服务，需要几分钟）...'
    (Get-Content -Raw $shSrc) | & wsl -d $distro -u root -- bash -c "tr -d '\r' > /root/install-myhi.sh"
    $gwSrc = Join-Path $PSScriptRoot '..\linux\gateway.json'
    if (Test-Path $gwSrc) {
      (Get-Content -Raw $gwSrc) | & wsl -d $distro -u root -- bash -c "tr -d '\r' > /root/gateway.json"
      Ok 'gateway.json 已随附，将部署到 WSL 用户 ~/.myhi/（AI 开箱即用）'
    }
    # 以 root + SUDO_USER=<user> 运行：装到 /usr、文件落用户家目录、systemd 服务以该用户身份跑（无需先给用户设密码）
    $envArgs = @('-d', $distro, '-u', 'root', '--', 'env', "SUDO_USER=$user", "PORT=$Port")
    if ($MyhiVersion) { $envArgs += "MYHI_VERSION=$MyhiVersion" }
    if ($SkipClaude)  { $envArgs += 'SKIP_CLAUDE=1' }
    $envArgs += 'bash'
    $envArgs += '/root/install-myhi.sh'
    $eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & wsl @envArgs
    $code = $LASTEXITCODE
    $ErrorActionPreference = $eaPrev
    if ($code -ne 0) { Warn "myhi 安装器返回码 $code —— 可进 WSL 手动排查/重跑：wsl -d $distro 后 bash /root/install-myhi.sh" }
  }
}

# ---------- 12) 收尾信息 ----------
$eaPrev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$ip = ((& wsl -d $distro -- hostname -I 2>$null | Out-String) -replace "`0", '').Trim()
$ErrorActionPreference = $eaPrev
Write-Host ''
Ok "WSL Ubuntu 就绪：$distro（默认用户 $user）"
if ($ip) { Info "访问地址：http://${ip}:$Port （mirrored 网络下与 Windows 同一局域网 IP；NAT 模式下仅本机可达，见 README）" }
Warn "WSL 用户 $user 尚未设密码（WSL 登录不需要）：需要 sudo 时先进 WSL 执行  sudo passwd $user"
Info "进入 WSL：开始菜单打开 Ubuntu，或命令行  wsl -d $distro"
Read-Host '按回车退出'
