#Requires -Version 5.1
<#
  Steam 自动助手 · 注册开机自启
  作用：在当前用户的「启动」文件夹里放一个指向 start-helper.vbs 的快捷方式，
        然后立刻启动一次助手。不开机自启也可以只双击 start-helper.vbs 使用。
  用法：右键本文件 → 使用 PowerShell 运行
#>

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $here 'start-helper.vbs'

if (-not (Test-Path -LiteralPath $vbs)) {
    Write-Host "找不到 start-helper.vbs：$vbs" -ForegroundColor Red
    exit 1
}

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Steam自动助手.lnk'

try {
    $wsh = New-Object -ComObject WScript.Shell
    $lnk = $wsh.CreateShortcut($lnkPath)
    $lnk.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk.Arguments        = '"{0}"' -f $vbs
    $lnk.WorkingDirectory = $here
    $lnk.WindowStyle      = 7
    $lnk.Description      = 'Steam 自动助手：开机后台启动本地助手'
    $lnk.Save()
    Write-Host "已注册开机自启：$lnkPath" -ForegroundColor Green
} catch {
    Write-Host "注册开机自启失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# 立刻启动一次（若已在运行，助手自己会因端口占用而退出，不会重复起服务）
try {
    Start-Process -FilePath $vbs
    Write-Host '已尝试启动本地助手（http://127.0.0.1:17380/）' -ForegroundColor Green
} catch {
    Write-Host "启动助手失败：$($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '完成。打开 chrome://extensions 处的「Steam 自动助手」面板即可使用「自动启动」页签。'
