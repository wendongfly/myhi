# myhi Windows 卸载器：撤销 install-myhi.ps1 的所有设置（保留 myhi 本体与 ~/.myhi 数据）。
#Requires -Version 5
$ErrorActionPreference = 'Continue'
$TaskName = 'myhi-autostart'
function Ok($m){ Write-Host "[OK]  $m" -ForegroundColor Green }
function Info($m){ Write-Host "[myhi] $m" -ForegroundColor Cyan }

# 1) 停并删计划任务
try {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "已删除开机自启计划任务"
  }
} catch {}

# 2) 停掉正在跑的 daemon
try {
  $pidFile = Join-Path $env:USERPROFILE '.myhi\daemon.pid'
  if (Test-Path $pidFile) {
    $dpid = (Get-Content $pidFile -Raw).Trim()
    if ($dpid) { & taskkill /PID $dpid /T /F 2>$null | Out-Null; Ok "已停止 daemon (PID $dpid)" }
  }
} catch {}

# 3) 删防火墙规则
foreach ($p in @(12300, 12301)) {
  Get-NetFirewallRule -DisplayName "myhi TCP $p" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}
Ok "已移除防火墙规则"

# 4) 删快捷方式 + 启动器
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  Remove-Item (Join-Path $dir 'myhi 控制台.url') -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $env:USERPROFILE '.myhi\myhi-launch.vbs') -Force -ErrorAction SilentlyContinue
Ok "已删除快捷方式与启动器"

Info "卸载完成。myhi 全局包与 ~/.myhi 配置仍保留；如需彻底清除：npm uninstall -g @wendongfly/myhi + 删 %USERPROFILE%\.myhi"
