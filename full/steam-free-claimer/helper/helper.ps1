#Requires -Version 5.1
<#
  Steam 自动助手 · 本地助手（helper.ps1）

  职责：
    1. 监听 http://127.0.0.1:17380/ 提供 REST API，供商店页内的插件面板调用
    2. 扫描本机 Steam 游戏库（多个库 + 非 Steam 快捷方式 + 用户自定义项）
    3. 记住用户勾选的游戏与自动运行配置
    4. 后台轮询 steam.exe，检测到「Steam 刚启动」时按配置自动运行勾选的游戏

  设计约束：
    · 零外部依赖，只用 Windows 自带 .NET / PowerShell 能力
    · 单实例：端口已被占用即退出，不重复起服务
    · 所有响应带 CORS 头，允许 https://store.steampowered.com 直接调用
    · 只写自己的 helper 目录（config.json / custom-games.json / helper.log）

  用法：
    helper.ps1              正常模式：起 HTTP 服务 + 起一个后台监视子进程
    helper.ps1 -WatchOnly   只跑「监视 steam.exe 并按配置启动游戏」，由主进程自动拉起
#>

param([switch]$WatchOnly)

$ErrorActionPreference = 'Continue'

$Script:Version      = '2.1.4'
$Script:Port         = 17380
$Script:HelperDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script:ConfigPath   = Join-Path $Script:HelperDir 'config.json'
$Script:CustomPath   = Join-Path $Script:HelperDir 'custom-games.json'
$Script:LogPath      = Join-Path $Script:HelperDir 'helper.log'
$Script:DefaultOrigin = 'https://store.steampowered.com'

$Script:Games        = @()
$Script:LastPoll     = $null
$Script:SteamSessionKey = $null
$Script:RunState     = 'idle'
$Script:RunWaitUntil = $null
$Script:RunQueue     = @()
$Script:RunIndex     = 0
$Script:RunNextAt    = $null

# ======================================================================
# 日志：滚动保留最近 500 行
# ======================================================================
function Write-HelperLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Level = 'INFO'
    )
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try {
        $lines = @()
        if (Test-Path -LiteralPath $Script:LogPath) {
            $lines = @(Get-Content -LiteralPath $Script:LogPath -Encoding UTF8 -ErrorAction SilentlyContinue)
        }
        $lines += $line
        if ($lines.Count -gt 500) {
            $lines = $lines[($lines.Count - 500)..($lines.Count - 1)]
        }
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllLines($Script:LogPath, $lines, $utf8NoBom)
    } catch {
        # 日志写不进去不能影响主流程
    }
}

# ======================================================================
# JSON 读写
# ======================================================================
function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        Write-HelperLog "读取 JSON 失败：$Path：$($_.Exception.Message)" 'ERROR'
        return $null
    }
}

function Write-JsonFile {
    param([string]$Path, $Object)
    try {
        $json = ConvertTo-Json -InputObject $Object -Depth 8
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
        return $true
    } catch {
        Write-HelperLog "写入 JSON 失败：$Path：$($_.Exception.Message)" 'ERROR'
        return $false
    }
}

# 保证输出一定是 JSON 数组（ConvertTo-Json 对单元素数组会退化成对象）
function ConvertTo-JsonArray {
    param($Items)
    $arr = @($Items)
    if ($arr.Count -eq 0) { return '[]' }
    $parts = @()
    foreach ($it in $arr) {
        $parts += (ConvertTo-Json -InputObject $it -Depth 8 -Compress)
    }
    return '[' + ($parts -join ',') + ']'
}

# ======================================================================
# 配置
# ======================================================================
function Get-DefaultConfig {
    return [pscustomobject]@{
        autoStartEnabled = $false
        delaySeconds     = 15
        intervalSeconds  = 10
        selectedIds      = @()
        customGames      = @()
    }
}

function Get-Config {
    $cfg = Read-JsonFile $Script:ConfigPath
    $def = Get-DefaultConfig
    if (-not $cfg) { return $def }

    $out = Get-DefaultConfig
    if ($null -ne $cfg.autoStartEnabled) { $out.autoStartEnabled = [bool]$cfg.autoStartEnabled }
    if ($null -ne $cfg.delaySeconds) {
        $d = 0
        if ([int]::TryParse([string]$cfg.delaySeconds, [ref]$d)) { $out.delaySeconds = [Math]::Max(0, [Math]::Min(600, $d)) }
    }
    if ($null -ne $cfg.intervalSeconds) {
        $i = 0
        if ([int]::TryParse([string]$cfg.intervalSeconds, [ref]$i)) { $out.intervalSeconds = [Math]::Max(0, [Math]::Min(600, $i)) }
    }
    if ($null -ne $cfg.selectedIds) {
        $sel = @()
        foreach ($id in @($cfg.selectedIds)) {
            if ($id -ne $null -and ([string]$id) -ne '') { $sel += [string]$id }
        }
        $out.selectedIds = $sel
    }
    if ($null -ne $cfg.customGames) {
        $cg = @()
        foreach ($g in @($cfg.customGames)) {
            if ($g -and $g.name -and $g.exePath) {
                $cg += [pscustomobject]@{ name = [string]$g.name; exePath = [string]$g.exePath }
            }
        }
        $out.customGames = $cg
    }
    return $out
}

function Save-Config {
    param($Config)
    $obj = [pscustomobject]@{
        autoStartEnabled = [bool]$Config.autoStartEnabled
        delaySeconds     = [int]$Config.delaySeconds
        intervalSeconds  = [int]$Config.intervalSeconds
        selectedIds      = @($Config.selectedIds)
        customGames      = @($Config.customGames)
    }
    return (Write-JsonFile $Script:ConfigPath $obj)
}

# ======================================================================
# Steam 路径与 VDF（文本）解析
# ======================================================================
function Get-SteamInstallPath {
    $candidates = @()
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -ErrorAction Stop
        if ($reg.SteamPath) { $candidates += ([string]$reg.SteamPath -replace '/', '\') }
        if ($reg.SteamExe) { $candidates += (Split-Path -Parent ([string]$reg.SteamExe -replace '/', '\')) }
    } catch {
        Write-HelperLog '读取注册表 SteamPath 失败，回退默认路径' 'WARN'
    }
    $candidates += 'C:\Program Files (x86)\Steam'
    $candidates += 'C:\Program Files\Steam'

    foreach ($p in $candidates) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p.TrimEnd('\') }
    }
    return $candidates[0].TrimEnd('\')
}

# 从文本 VDF 中取出某个 key 的字符串值（找第一个匹配）
function Get-VdfField {
    param([string]$Text, [string]$Key)
    if (-not $Text) { return $null }
    $pattern = '"' + [regex]::Escape($Key) + '"\s+"([^"]*)"'
    $m = [regex]::Match($Text, $pattern)
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Get-LibraryPaths {
    param([string]$SteamPath)
    $paths = @()
    $vdfPath = Join-Path $SteamPath 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $vdfPath) {
        try {
            $text = Get-Content -LiteralPath $vdfPath -Raw -Encoding UTF8 -ErrorAction Stop
            foreach ($m in [regex]::Matches($text, '"path"\s+"([^"]+)"')) {
                $p = $m.Groups[1].Value -replace '\\\\', '\'
                $p = $p.TrimEnd('\')
                if ($p -and ($paths -notcontains $p)) { $paths += $p }
            }
        } catch {
            Write-HelperLog "解析 libraryfolders.vdf 失败：$($_.Exception.Message)" 'WARN'
        }
    }
    if ($paths.Count -eq 0) { $paths += $SteamPath.TrimEnd('\') }
    return $paths
}

# ======================================================================
# 二进制 VDF（shortcuts.vdf）解析
#   0x00 = 嵌套对象（后跟 key\0，内容直到 0x08）
#   0x01 = 字符串（key\0 value\0）
#   0x02 = int32（key\0 value 4 字节小端）
#   0x08 = 对象结束
# ======================================================================
function Read-BinaryVdf {
    param(
        [byte[]]$Bytes,
        [ref]$Index
    )
    $i = [int]$Index.Value
    $obj = New-Object System.Collections.Specialized.OrderedDictionary

    while ($i -lt $Bytes.Length) {
        $type = [int]$Bytes[$i]
        $i++

        if ($type -eq 0x08) { break }

        # 读 key（以 \0 结尾）
        $start = $i
        while ($i -lt $Bytes.Length -and $Bytes[$i] -ne 0) { $i++ }
        $key = [System.Text.Encoding]::UTF8.GetString($Bytes, $start, ($i - $start))
        if ($i -lt $Bytes.Length -and $Bytes[$i] -eq 0) { $i++ }

        if ($type -eq 0x00) {
            $child = Read-BinaryVdf -Bytes $Bytes -Index ([ref]$i)
            $obj[$key] = $child
        } elseif ($type -eq 0x01) {
            $s = $i
            while ($i -lt $Bytes.Length -and $Bytes[$i] -ne 0) { $i++ }
            $val = [System.Text.Encoding]::UTF8.GetString($Bytes, $s, ($i - $s))
            if ($i -lt $Bytes.Length -and $Bytes[$i] -eq 0) { $i++ }
            $obj[$key] = $val
        } elseif ($type -eq 0x02) {
            if ($i + 3 -lt $Bytes.Length) {
                $obj[$key] = [BitConverter]::ToInt32($Bytes, $i)
            }
            $i += 4
        } else {
            # 未知类型：无法继续安全解析
            Write-HelperLog "shortcuts.vdf 出现未知类型 0x$($type.ToString('X2'))，中止解析" 'WARN'
            $i = $Bytes.Length
            break
        }
    }

    $Index.Value = $i
    return $obj
}

# 从 shortcut 的 Exe 字段里剥出真正的可执行文件路径
function Get-ExeFromShortcut {
    param([string]$Raw)
    if (-not $Raw) { return '' }
    $s = $Raw.Trim()
    if ($s.StartsWith('"')) {
        $end = $s.IndexOf('"', 1)
        if ($end -gt 0) { return $s.Substring(1, $end - 1) }
        return $s.Trim('"')
    }
    $m = [regex]::Match($s, '^(.*?\.exe)', 'IgnoreCase')
    if ($m.Success) { return $m.Groups[1].Value }
    return $s
}

# ======================================================================
# 库扫描
# ======================================================================
function Get-SteamAppGames {
    param([string]$SteamPath)

    $games = @()

    foreach ($lib in (Get-LibraryPaths $SteamPath)) {
        $appsDir = Join-Path $lib 'steamapps'
        if (-not (Test-Path -LiteralPath $appsDir)) { continue }

        $manifests = @(Get-ChildItem -LiteralPath $appsDir -Filter 'appmanifest_*.acf' -File -ErrorAction SilentlyContinue)
        foreach ($acf in $manifests) {
            try {
                $text = Get-Content -LiteralPath $acf.FullName -Raw -Encoding UTF8 -ErrorAction Stop
            } catch {
                continue
            }
            $appid = Get-VdfField $text 'appid'
            if (-not $appid) { continue }

            $name = Get-VdfField $text 'name'
            $installdir = Get-VdfField $text 'installdir'

            $flags = 0
            [void][int]::TryParse([string](Get-VdfField $text 'StateFlags'), [ref]$flags)

            $lastPlayed = [int64]0
            [void][int64]::TryParse([string](Get-VdfField $text 'LastPlayed'), [ref]$lastPlayed)

            $installPath = ''
            if ($installdir) {
                $installPath = Join-Path (Join-Path $appsDir 'common') $installdir
            }

            $games += [pscustomobject]@{
                id        = "steam:$appid"
                name      = if ($name) { $name } else { "App $appid" }
                source    = 'steam'
                appid     = [string]$appid
                exePath   = $installPath
                installed = (($flags -band 4) -ne 0)
                lastPlayed = [int64]$lastPlayed
                selected  = $false
            }
        }
    }

    return $games
}

function Get-ShortcutGames {
    param([string]$SteamPath)

    $games = @()
    $userdata = Join-Path $SteamPath 'userdata'
    if (-not (Test-Path -LiteralPath $userdata)) {
        Write-HelperLog 'userdata 目录不存在，跳过非 Steam 快捷方式扫描' 'WARN'
        return $games
    }

    $files = @(Get-ChildItem -LiteralPath $userdata -Recurse -Filter 'shortcuts.vdf' -File -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) {
        Write-HelperLog '未找到 shortcuts.vdf（本机无自定义快捷方式），跳过' 'INFO'
        return $games
    }

    foreach ($f in $files) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        } catch {
            Write-HelperLog "读取 shortcuts.vdf 失败：$($_.Exception.Message)" 'WARN'
            continue
        }
        if ($bytes.Length -eq 0) { continue }

        $idx = 0
        $root = $null
        try {
            $root = Read-BinaryVdf -Bytes $bytes -Index ([ref]$idx)
        } catch {
            Write-HelperLog "解析 shortcuts.vdf 失败：$($_.Exception.Message)" 'WARN'
            continue
        }
        if (-not $root -or -not $root.Contains('shortcuts')) { continue }

        $entries = $root['shortcuts']
        foreach ($k in $entries.Keys) {
            $e = $entries[$k]
            if (-not $e) { continue }

            $appName = [string]$e['AppName']
            if ([string]::IsNullOrWhiteSpace($appName)) { continue }

            $exe = Get-ExeFromShortcut ([string]$e['Exe'])
            $startDir = [string]$e['StartDir']

            $sid = "shortcut:$k"
            if ($e.Contains('appid')) {
                $raw = [int64]$e['appid']
                if ($raw -ne 0) { $sid = "shortcut:$raw" }
            }

            $games += [pscustomobject]@{
                id        = $sid
                name      = $appName
                source    = 'shortcut'
                appid     = ''
                exePath   = $exe
                installed = ($exe -ne '' -and (Test-Path -LiteralPath $exe))
                lastPlayed = [int64]0
                selected  = $false
                startDir  = $startDir
            }
        }
    }

    return $games
}

# 稳定的 ASCII 短哈希（FNV-1a 32 位），用于给自定义项生成与中文名无关的固定 id
function Get-ShortHash {
    param([string]$Text)
    if ($null -eq $Text) { $Text = '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text.ToLowerInvariant())
    [uint64]$h = 2166136261
    foreach ($b in $bytes) {
        $h = [uint64]($h -bxor [uint64]$b)
        $h = [uint64](($h * [uint64]16777619) % [uint64]4294967296)
    }
    return ('{0:x8}' -f [uint32]$h)
}

function Get-CustomGames {
    $list = @()
    $file = Read-JsonFile $Script:CustomPath
    if ($file) {
        foreach ($g in @($file)) {
            if ($g -and $g.name -and $g.exePath) {
                $list += [pscustomobject]@{ name = [string]$g.name; exePath = [string]$g.exePath }
            }
        }
    }
    # 兼容写在 config.json 里的自定义项
    $cfg = Get-Config
    foreach ($g in @($cfg.customGames)) {
        if ($g -and $g.name -and $g.exePath) {
            $exists = $false
            foreach ($x in $list) {
                if ($x.exePath -eq [string]$g.exePath) { $exists = $true; break }
            }
            if (-not $exists) { $list += [pscustomobject]@{ name = [string]$g.name; exePath = [string]$g.exePath } }
        }
    }

    $out = @()
    foreach ($g in $list) {
        $exe = [string]$g.exePath
        $out += [pscustomobject]@{
            id        = ('custom:' + (Get-ShortHash $exe))
            name      = [string]$g.name
            source    = 'custom'
            appid     = ''
            exePath   = $exe
            installed = (Test-Path -LiteralPath $exe)
            lastPlayed = [int64]0
            selected  = $false
        }
    }
    return $out
}

function Get-AllGames {
    $steamPath = Get-SteamInstallPath
    $cfg = Get-Config

    $all = @()
    $all += Get-SteamAppGames -SteamPath $steamPath
    $all += Get-ShortcutGames -SteamPath $steamPath
    $all += Get-CustomGames

    # 应用已保存的勾选状态
    foreach ($g in $all) {
        $g.selected = ($cfg.selectedIds -contains $g.id)
    }

    return $all
}

# 按 selectedIds 的顺序取出要启动的游戏（顺序 = 用户勾选保存的顺序）
function Get-LaunchQueue {
    $cfg = Get-Config
    $all = Get-AllGames
    $queue = @()
    foreach ($id in $cfg.selectedIds) {
        foreach ($g in $all) {
            if ($g.id -eq $id) { $queue += $g; break }
        }
    }
    return $queue
}

# ======================================================================
# 启动游戏
# ======================================================================
function Start-OneGame {
    param(
        $Game,
        [bool]$DryRun = $false
    )

    $steamPath = Get-SteamInstallPath
    $steamExe = Join-Path $steamPath 'steam.exe'

    if ($Game.source -eq 'steam') {
        if (-not (Test-Path -LiteralPath $steamExe)) { throw "找不到 steam.exe：$steamExe" }
        $cmd = '& "{0}" -applaunch {1}' -f $steamExe, $Game.appid
        if (-not $DryRun) {
            Start-Process -FilePath $steamExe -ArgumentList @('-applaunch', [string]$Game.appid) -ErrorAction Stop
        }
        return [pscustomobject]@{ ok = $true; id = $Game.id; name = $Game.name; command = $cmd; dryRun = $DryRun }
    }

    $exe = [string]$Game.exePath
    if ([string]::IsNullOrWhiteSpace($exe)) { throw "没有可执行文件路径：$($Game.name)" }
    if (-not (Test-Path -LiteralPath $exe)) { throw "可执行文件不存在：$exe" }

    $workDir = Split-Path -Parent $exe
    $cmd = 'Start-Process "{0}" -WorkingDirectory "{1}"' -f $exe, $workDir
    if (-not $DryRun) {
        Start-Process -FilePath $exe -WorkingDirectory $workDir -ErrorAction Stop
    }
    return [pscustomobject]@{ ok = $true; id = $Game.id; name = $Game.name; command = $cmd; dryRun = $DryRun }
}

function Invoke-LaunchSelected {
    param([bool]$DryRun = $false)

    $queue = Get-LaunchQueue
    $results = @()
    foreach ($g in $queue) {
        try {
            $results += Start-OneGame -Game $g -DryRun $DryRun
        } catch {
            $results += [pscustomobject]@{ ok = $false; id = $g.id; name = $g.name; command = ''; error = $_.Exception.Message; dryRun = $DryRun }
            Write-HelperLog "启动失败：$($g.name)：$($_.Exception.Message)" 'ERROR'
        }
        if (-not $DryRun) { Start-Sleep -Seconds ([int](Get-Config).intervalSeconds) }
    }
    return $results
}

# ======================================================================
# 后台监视：每 5 秒看一次 steam.exe 是否在运行
# ======================================================================
function Test-SteamRunning {
    $procs = @(Get-Process -Name 'steam' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return $null }
    $ticks = @()
    foreach ($p in $procs) {
        try { $ticks += $p.StartTime.Ticks } catch { $ticks += 0 }
    }
    # Measure-Object 的 Minimum 会把 Int64 转成 Double（17 位 Ticks 会被压缩成 6.39E+17 并丢精度），
    # 这里强制转回 Int64，保证会话 ID 以完整十进制字符串写入日志、且比较时数值不丢精度
    $min = [int64](($ticks | Measure-Object -Minimum).Minimum)
    return [pscustomobject]@{ key = $min; count = $procs.Count }
}

function Invoke-SteamWatch {
    $now = Get-Date
    if ($Script:LastPoll -and (($now - $Script:LastPoll).TotalSeconds -lt 5)) { return }
    $Script:LastPoll = $now

    $steam = Test-SteamRunning

    if (-not $steam) {
        if ($null -ne $Script:SteamSessionKey) {
            Write-HelperLog 'Steam 已退出，自动运行状态已重置'
        }
        $Script:SteamSessionKey = $null
        $Script:RunState = 'idle'
        $Script:RunQueue = @()
        $Script:RunIndex = 0
        return
    }

    if ($null -eq $Script:SteamSessionKey -or $Script:SteamSessionKey -ne $steam.key) {
        # 新的一次 Steam 会话：同一次会话只触发一次
        $firstTime = ($null -eq $Script:SteamSessionKey)
        $Script:SteamSessionKey = $steam.key
        $Script:RunState = 'idle'
        $Script:RunQueue = @()
        $Script:RunIndex = 0

        Write-HelperLog ("检测到 Steam 运行中（会话 {0}，进程 {1}）" -f $steam.key, $steam.count)

        $cfg = Get-Config
        if ($cfg.autoStartEnabled) {
            $queue = @(Get-LaunchQueue)
            if ($queue.Count -gt 0) {
                $Script:RunQueue = $queue
                $Script:RunState = 'waiting'
                $Script:RunWaitUntil = $now.AddSeconds([int]$cfg.delaySeconds)
                Write-HelperLog ("自动运行已排程：{0} 秒后依次启动 {1} 个游戏（间隔 {2} 秒）" -f $cfg.delaySeconds, $queue.Count, $cfg.intervalSeconds)
            } else {
                Write-HelperLog '自动运行已开启，但没有勾选任何游戏，本次跳过'
            }
        } elseif ($firstTime) {
            Write-HelperLog '自动运行未开启（autoStartEnabled=false），只做监视'
        }
        return
    }

    if ($Script:RunState -eq 'waiting' -and $now -ge $Script:RunWaitUntil) {
        $Script:RunState = 'launching'
        $Script:RunIndex = 0
        $Script:RunNextAt = $now
    }

    if ($Script:RunState -eq 'launching' -and $now -ge $Script:RunNextAt) {
        if ($Script:RunIndex -ge $Script:RunQueue.Count) {
            $Script:RunState = 'done'
            return
        }
        $g = $Script:RunQueue[$Script:RunIndex]
        $Script:RunIndex++

        try {
            $r = Start-OneGame -Game $g -DryRun $false
            Write-HelperLog ("自动运行：{0}（{1}）" -f $g.name, $r.command)
        } catch {
            Write-HelperLog ("自动运行失败：{0}：{1}" -f $g.name, $_.Exception.Message) 'ERROR'
        }

        $Script:RunNextAt = (Get-Date).AddSeconds([int](Get-Config).intervalSeconds)
        if ($Script:RunIndex -ge $Script:RunQueue.Count) {
            $Script:RunState = 'done'
            Write-HelperLog '本轮自动运行结束'
        }
    }
}

# ======================================================================
# HTTP 响应工具（含 CORS）
# ======================================================================
function Get-CorsOrigin {
    param($Context)
    $origin = ''
    try { $origin = [string]$Context.Request.Headers['Origin'] } catch { $origin = '' }
    if ([string]::IsNullOrWhiteSpace($origin)) { return $Script:DefaultOrigin }
    return $origin
}

function Send-Json {
    param(
        $Context,
        [int]$StatusCode = 200,
        [string]$Json = '{}'
    )
    $res = $Context.Response
    try {
        $res.StatusCode = $StatusCode
        $res.ContentType = 'application/json; charset=utf-8'
        $res.Headers['Access-Control-Allow-Origin'] = (Get-CorsOrigin $Context)
        $res.Headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
        $res.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
        $res.Headers['Access-Control-Max-Age'] = '600'
        $res.Headers['Vary'] = 'Origin'
        $res.Headers['Cache-Control'] = 'no-store'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
        Write-HelperLog "写出响应失败：$($_.Exception.Message)" 'ERROR'
    } finally {
        try { $res.OutputStream.Close() } catch { }
        try { $res.Close() } catch { }
    }
}

function Send-NoContent {
    param($Context)
    $res = $Context.Response
    try {
        $res.StatusCode = 204
        $res.Headers['Access-Control-Allow-Origin'] = (Get-CorsOrigin $Context)
        $res.Headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
        $res.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
        $res.Headers['Access-Control-Max-Age'] = '600'
        $res.Headers['Vary'] = 'Origin'
        $res.ContentLength64 = 0
    } catch {
        Write-HelperLog "写出预检响应失败：$($_.Exception.Message)" 'ERROR'
    } finally {
        try { $res.OutputStream.Close() } catch { }
        try { $res.Close() } catch { }
    }
}

function Read-JsonBody {
    param($Context)
    try {
        $reader = New-Object System.IO.StreamReader($Context.Request.InputStream, [System.Text.Encoding]::UTF8)
        $raw = $reader.ReadToEnd()
        $reader.Close()
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        Write-HelperLog "请求体解析失败：$($_.Exception.Message)" 'WARN'
        return $null
    }
}

# ======================================================================
# 路由
# ======================================================================
function Invoke-ApiRequest {
    param($Context)

    $method = [string]$Context.Request.HttpMethod
    $path = [string]$Context.Request.Url.AbsolutePath.TrimEnd('/')
    if ($path -eq '') { $path = '/' }

    if ($method -eq 'OPTIONS') {
        Send-NoContent $Context
        return
    }

    try {
        switch -Regex ($path) {

            '^/api/ping$' {
                if ($method -ne 'GET') { Send-Json $Context 405 '{"ok":false,"error":"仅支持 GET"}'; return }
                $steam = Test-SteamRunning
                $obj = [pscustomobject]@{
                    ok           = $true
                    version      = $Script:Version
                    steamRunning = ($null -ne $steam)
                }
                Send-Json $Context 200 (ConvertTo-Json -InputObject $obj -Depth 5 -Compress)
                return
            }

            '^/api/games$' {
                if ($method -ne 'GET') { Send-Json $Context 405 '{"ok":false,"error":"仅支持 GET"}'; return }
                $Script:Games = @(Get-AllGames)
                Write-HelperLog ("返回游戏列表：{0} 项" -f $Script:Games.Count)
                Send-Json $Context 200 (ConvertTo-JsonArray $Script:Games)
                return
            }

            '^/api/selection$' {
                if ($method -ne 'POST') { Send-Json $Context 405 '{"ok":false,"error":"仅支持 POST"}'; return }
                $body = Read-JsonBody $Context
                if (-not $body -or -not $body.id) {
                    Send-Json $Context 400 '{"ok":false,"error":"缺少 id"}'
                    return
                }
                $id = [string]$body.id
                $selected = $false
                if ($null -ne $body.selected) { $selected = [bool]$body.selected }

                $cfg = Get-Config
                $ids = @($cfg.selectedIds)
                if ($selected) {
                    if ($ids -notcontains $id) { $ids += $id }
                } else {
                    $ids = @($ids | Where-Object { $_ -ne $id })
                }
                $cfg.selectedIds = @($ids)
                $okWrite = Save-Config $cfg
                Write-HelperLog ("勾选变更：{0} -> {1}" -f $id, $selected)

                $res = [pscustomobject]@{
                    ok          = [bool]$okWrite
                    id          = $id
                    selected    = $selected
                    selectedIds = @($cfg.selectedIds)
                }
                Send-Json $Context 200 (ConvertTo-Json -InputObject $res -Depth 6 -Compress)
                return
            }

            '^/api/config$' {
                if ($method -eq 'GET') {
                    $cfg = Get-Config
                    $res = [pscustomobject]@{
                        autoStartEnabled = [bool]$cfg.autoStartEnabled
                        delaySeconds     = [int]$cfg.delaySeconds
                        intervalSeconds  = [int]$cfg.intervalSeconds
                        selectedIds      = @($cfg.selectedIds)
                    }
                    Send-Json $Context 200 (ConvertTo-Json -InputObject $res -Depth 6 -Compress)
                    return
                }
                if ($method -eq 'POST') {
                    $body = Read-JsonBody $Context
                    if (-not $body) {
                        Send-Json $Context 400 '{"ok":false,"error":"请求体不是合法 JSON"}'
                        return
                    }
                    $cfg = Get-Config
                    if ($null -ne $body.autoStartEnabled) { $cfg.autoStartEnabled = [bool]$body.autoStartEnabled }
                    if ($null -ne $body.delaySeconds) {
                        $d = 0
                        if ([int]::TryParse([string]$body.delaySeconds, [ref]$d)) {
                            $cfg.delaySeconds = [Math]::Max(0, [Math]::Min(600, $d))
                        }
                    }
                    if ($null -ne $body.intervalSeconds) {
                        $i = 0
                        if ([int]::TryParse([string]$body.intervalSeconds, [ref]$i)) {
                            $cfg.intervalSeconds = [Math]::Max(0, [Math]::Min(600, $i))
                        }
                    }
                    $okWrite = Save-Config $cfg
                    Write-HelperLog ("配置更新：autoStart={0} delay={1} interval={2}" -f $cfg.autoStartEnabled, $cfg.delaySeconds, $cfg.intervalSeconds)

                    $res = [pscustomobject]@{
                        ok               = [bool]$okWrite
                        autoStartEnabled = [bool]$cfg.autoStartEnabled
                        delaySeconds     = [int]$cfg.delaySeconds
                        intervalSeconds  = [int]$cfg.intervalSeconds
                        selectedIds      = @($cfg.selectedIds)
                    }
                    Send-Json $Context 200 (ConvertTo-Json -InputObject $res -Depth 6 -Compress)
                    return
                }
                Send-Json $Context 405 '{"ok":false,"error":"仅支持 GET / POST"}'
                return
            }

            '^/api/launch$' {
                if ($method -ne 'POST') { Send-Json $Context 405 '{"ok":false,"error":"仅支持 POST"}'; return }
                $body = Read-JsonBody $Context
                $dryRun = $false
                if ($body -and $null -ne $body.dryRun) { $dryRun = [bool]$body.dryRun }

                $results = @(Invoke-LaunchSelected -DryRun $dryRun)
                $queue = @(Get-LaunchQueue)
                Write-HelperLog ("手动启动：{0} 个游戏（dryRun={1}）" -f $queue.Count, $dryRun)

                $res = [pscustomobject]@{
                    ok      = $true
                    dryRun  = $dryRun
                    count   = $results.Count
                    results = @($results)
                }
                Send-Json $Context 200 (ConvertTo-Json -InputObject $res -Depth 8 -Compress)
                return
            }

            '^/api/rescan$' {
                if ($method -ne 'POST') { Send-Json $Context 405 '{"ok":false,"error":"仅支持 POST"}'; return }
                $Script:Games = @(Get-AllGames)
                Write-HelperLog ("重新扫描完成：{0} 项" -f $Script:Games.Count)

                $steamCount = 0
                foreach ($g in $Script:Games) { if ($g.source -eq 'steam') { $steamCount++ } }
                $res = [pscustomobject]@{
                    ok       = $true
                    count    = $Script:Games.Count
                    steamCount = $steamCount
                    games    = @($Script:Games)
                }
                Send-Json $Context 200 (ConvertTo-Json -InputObject $res -Depth 8 -Compress)
                return
            }

            '^/api/open-store$' {
                if ($method -ne 'POST') { Send-Json $Context 405 '{"ok":false,"error":"仅支持 POST"}'; return }
                # Steam 客户端内嵌 CEF 里 chrome.tabs.create / window.open 都不生效，
                # 只有交给 ShellExecute 走 steam:// 协议才能真正唤起商店页。
                $uri = 'steam://open/url?url=https%3A%2F%2Fstore.steampowered.com%2F'
                $ok = $false
                $errText = ''
                try {
                    Start-Process -FilePath $uri -ErrorAction Stop
                    $ok = $true
                } catch {
                    $errText = $_.Exception.Message
                }
                if ($ok) {
                    Write-HelperLog '已请求 Steam 打开商店页（steam://open/url）'
                } else {
                    Write-HelperLog ("打开商店页失败：{0}" -f $errText) 'ERROR'
                }
                $res = [pscustomobject]@{
                    ok    = $ok
                    uri   = $uri
                    error = $errText
                }
                Send-Json $Context 200 (ConvertTo-Json -InputObject $res -Depth 5 -Compress)
                return
            }

            default {
                Send-Json $Context 404 '{"ok":false,"error":"未知接口"}'
                return
            }
        }
    } catch {
        Write-HelperLog ("处理请求出错：{0} {1}：{2}" -f $method, $path, $_.Exception.Message) 'ERROR'
        Send-Json $Context 500 ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
    }
}

# ======================================================================
# 探测 17380 端口是否有人监听（监视进程用它判断主服务是否还活着）
# ======================================================================
function Test-HelperPortOpen {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', $Script:Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(500)) { return $false }
        $c.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        try { $c.Close() } catch { }
    }
}

# ======================================================================
# 监视模式：只轮询 steam.exe，由主进程自动拉起（独立进程，不受 HTTP 阻塞影响）
# ======================================================================
function Invoke-WatchMode {
    $mutex = New-Object System.Threading.Mutex($false, 'Local\SteamAutoHelperWatcher')
    $acquired = $false
    try { $acquired = $mutex.WaitOne(0) } catch { $acquired = $false }

    if (-not $acquired) {
        Write-HelperLog '已有监视进程在运行，本监视实例退出'
        return
    }

    Write-HelperLog '监视进程启动：每 5 秒检查一次 steam.exe'
    $miss = 0
    try {
        while ($true) {
            try {
                Invoke-SteamWatch
            } catch {
                Write-HelperLog ("监视异常：{0}" -f $_.Exception.Message) 'ERROR'
            }

            # 主服务不在了就连三次探测失败后退出，避免残留进程
            if (Test-HelperPortOpen) { $miss = 0 } else { $miss++ }
            if ($miss -ge 3) {
                Write-HelperLog '主服务已停止，监视进程退出'
                break
            }
            Start-Sleep -Seconds 2
        }
    } finally {
        try { $mutex.ReleaseMutex() } catch { }
        try { $mutex.Dispose() } catch { }
    }
}

# ======================================================================
# 启动
# ======================================================================

# ---- 监视模式入口 ----
if ($WatchOnly) {
    Invoke-WatchMode
    exit 0
}

# ---- 正常模式：起 HTTP 服务 ----
$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$($Script:Port)/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-HelperLog "端口 $($Script:Port) 无法监听（可能已有实例在运行）：$($_.Exception.Message)" 'WARN'
    Write-Host "Steam 自动助手已经在运行（端口 $($Script:Port) 被占用），本实例退出。"
    exit 1
}

# 首次运行自动生成配置文件
if (-not (Test-Path -LiteralPath $Script:ConfigPath)) {
    [void](Save-Config (Get-DefaultConfig))
    Write-HelperLog '首次运行，已生成默认 config.json'
}
if (-not (Test-Path -LiteralPath $Script:CustomPath)) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Script:CustomPath, "[]", $utf8NoBom)
    Write-HelperLog '首次运行，已生成空的 custom-games.json'
}

Write-HelperLog ("助手启动：{0}（版本 {1}，PID {2}）" -f $prefix, $Script:Version, $PID)
Write-Host "Steam 自动助手已启动：$prefix"

$Script:Games = @(Get-AllGames)
Write-HelperLog ("启动时扫描到 {0} 个游戏" -f $Script:Games.Count)

# 拉起监视子进程（负责「Steam 启动后自动运行游戏」）
$watcherProc = $null
try {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $selfPath = $MyInvocation.MyCommand.Path
    if (-not $selfPath) { $selfPath = $PSCommandPath }
    $argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -WatchOnly' -f $selfPath
    $watcherProc = Start-Process -FilePath $psExe -ArgumentList $argLine -WindowStyle Hidden -PassThru
    Write-HelperLog ("监视子进程已启动（PID {0}）" -f $watcherProc.Id)
} catch {
    Write-HelperLog ("监视子进程启动失败：{0}" -f $_.Exception.Message) 'ERROR'
}

# 主循环：阻塞等待请求（简单可靠，请求一来就处理）
try {
    while ($listener.IsListening) {
        $context = $null
        try {
            $context = $listener.GetContext()
        } catch {
            Write-HelperLog ("监听中断：{0}" -f $_.Exception.Message) 'ERROR'
            break
        }
        if ($context) { Invoke-ApiRequest -Context $context }
    }
} finally {
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
    if ($watcherProc) {
        try {
            if (-not $watcherProc.HasExited) { Stop-Process -Id $watcherProc.Id -Force -ErrorAction SilentlyContinue }
        } catch { }
    }
    Write-HelperLog '助手已停止'
}
