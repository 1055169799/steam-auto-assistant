#Requires -Version 5.1
<#
  Steam 自动助手 · 移除开机自启
  作用：删除 install-autostart.ps1 放在「启动」文件夹里的快捷方式。
        只删这一个快捷方式，不删任何用户文件。
  用法：右键本文件 → 使用 PowerShell 运行
#>

$ErrorActionPreference = 'Stop'

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Steam自动助手.lnk'

if (Test-Path -LiteralPath $lnkPath) {
    try {
        Remove-Item -LiteralPath $lnkPath -Force
        Write-Host "已移除开机自启：$lnkPath" -ForegroundColor Green
    } catch {
        Write-Host "移除失败：$($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host '没有找到开机自启快捷方式，可能本来就没注册过。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '提示：本脚本不会结束正在运行的助手进程，如需停止请在任务管理器结束 powershell.exe。'
