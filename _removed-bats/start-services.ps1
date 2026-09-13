#Requires -Version 5.1
<#
 境途WEB服务增强控制面板 (PowerShell 实现)
 ---------------------------------------------------------------
 - 单文件实现全部功能；依靠脚本自身位置识别项目根目录，不写死硬盘绝对路径。
 - 可变参数（端口、服务启动命令、保留份数、磁盘阈值等）全部来自外部配置 panel-config.json。
 - 入口：start-services.bat（设置 UTF-8 代码页与窗口标题后调用本脚本）。
#>

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ===================== 自动提权（UAC 自提升） =====================
# 终止端口进程（如 Nginx master/worker）、taskkill /f 等操作需要管理员权限，
# 否则 Stop-OneService 会报"权限不足或进程已退出"。检测到非管理员时，
# 用 Start-Process -Verb RunAs 重新以管理员身份启动本脚本自身，确保关闭服务有完整权限。
function Test-AdminInner {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $pr = New-Object Security.Principal.WindowsPrincipal($id)
        return $pr.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    } catch { return $false }
}
if (-not (Test-AdminInner)) {
    try {
        $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Definition)`""
        Start-Process -FilePath "PowerShell.exe" -Verb RunAs -ArgumentList $argList -ErrorAction Stop
        exit 0
    } catch {
        Write-Warning "无法自动提权为管理员（可能被 UAC 拒绝）。部分端口操作为非管理员模式，可能权限受限。"
        Start-Sleep -Seconds 2
    }
}

# ===================== 基础初始化 =====================
# 脚本自身所在目录即项目根目录（工作目录防护）
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = $ScriptDir
try { Set-Location $ProjectRoot } catch { Write-Warning "无法切换工作目录到 $ProjectRoot" }

# 中文不乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $Host.UI.RawUI.WindowTitle = "境途WEB服务增强控制面板" } catch {}

# 颜色输出
function C([string]$msg, [string]$color = "White") { Write-Host $msg -ForegroundColor $color }

# ===================== 目录与文件路径 =====================
$BackupDir  = Join-Path $ProjectRoot "backup"
$LogsDir    = Join-Path $ProjectRoot "logs"
$AuditLog   = Join-Path $LogsDir "panel-audit.log"
$ConfigFile = Join-Path $ProjectRoot "panel-config.json"
$LockFile   = Join-Path $env:TEMP "jingtu-panel.lock"
$MutexName  = "Global\JingTuWebPanelMutex"

foreach ($d in @($BackupDir, $LogsDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ===================== 外部配置（文件化、缺失自动生成） =====================
function Load-Config {
    if (-not (Test-Path $ConfigFile)) {
        $default = [ordered]@{
            businessService        = "NodeServer"
            dataDir                = "uploads"
            configItems            = @(".env", "server", "tools")
            backupRetention        = 10
            configBackupRetention  = 5
            diskWarnGB             = 1.0
            logMaxMB               = 5
            auditLogMaxKB          = 100
            logSearchKeywords      = @("ERROR", "FATAL", "Exception", "失败")
            highRiskConfirm        = "CONFIRM-DELETE-ALL-DATA"
            restoreConfirm         = "CONFIRM-RESTORE-FROM-BACKUP"
            stopServicesOnExit     = $true
            services = @(
                [ordered]@{
                    name = "MySQL"
                    port = 3306
                    start = [ordered]@{
                        exe = "D:\phpstudy_pro\Extensions\MySQL5.7.26\bin\mysqld.exe"
                        args = "--defaults-file=D:\phpstudy_pro\Extensions\MySQL5.7.26\my.ini"
                        cwd = "D:\phpstudy_pro\Extensions\MySQL5.7.26"
                    }
                }
                [ordered]@{
                    name = "Nginx"
                    port = 80
                    start = [ordered]@{
                        exe = "D:\phpstudy_pro\Extensions\Nginx1.15.11\nginx.exe"
                        args = "-c `"D:\phpstudy_pro\Extensions\Nginx1.15.11\conf\nginx.conf`""
                        cwd = "D:\phpstudy_pro\Extensions\Nginx1.15.11"
                    }
                }
                [ordered]@{
                    name = "NodeServer"
                    port = 3456
                    start = [ordered]@{
                        exe = "node"
                        args = "server.js"
                        cwd = "server"
                    }
                }
            )
        }
        $default | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 $ConfigFile
        C "已生成默认配置文件：$ConfigFile （可按需修改，无需改动程序）" "Yellow"
    }
    $cfg = Get-Content -Raw -Encoding UTF8 $ConfigFile | ConvertFrom-Json
    return $cfg
}
$Config = Load-Config

# ===================== 管理员权限检测 =====================
function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p  = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    } catch { return $false }
}
$IsAdmin = Test-Admin

# ===================== 锁文件 + 多实例互斥 =====================
$global:Mutex = $null
function Init-Lock {
    # 多实例互斥
    $acquired = $false
    try {
        $global:Mutex = New-Object System.Threading.Mutex($false, $MutexName)
        try { $acquired = $global:Mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    } catch { $global:Mutex = $null }
    if (-not $acquired) {
        C "Panel already running (mutex $MutexName held). Exiting." "Red"
        Start-Sleep -Seconds 2
        exit 2
    }

    # 残留锁自检
    if (Test-Path $LockFile) {
        $old = $null
        try { $old = Get-Content -Raw -Encoding UTF8 $LockFile | ConvertFrom-Json } catch {}
        $stale = $true
        if ($old -and $old.pid) {
            try {
                $proc = Get-Process -Id $old.pid -ErrorAction SilentlyContinue
                if ($proc) { $stale = $false }
            } catch {}
        }
        if (-not $stale) {
            C "面板已经在运行（PID $($old.pid)），请勿重复打开。" "Red"
            Start-Sleep -Seconds 2
            exit 1
        } else {
            C "检测到上次非正常退出残留锁文件，正在清理..." "Yellow"
            Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
        }
    }
    $lock = [ordered]@{
        pid  = $PID
        guid = [guid]::NewGuid().ToString()
        time = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    }
    $lock | ConvertTo-Json | Out-File -Encoding utf8 $LockFile
}

# ===================== 审计日志 =====================
function Write-Audit([string]$msg) {
    $ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$ts | $msg"
    try {
        Add-Content -Path $AuditLog -Value $line -Encoding UTF8
        # 超过上限自动归档分割（修正：此前误用 logMaxMB，实际配置键为 auditLogMaxKB）
        $cfgMaxKB = 100
        try { if ($Config.auditLogMaxKB) { $cfgMaxKB = [int]$Config.auditLogMaxKB } } catch {}
        $sz = (Get-Item $AuditLog).Length / 1KB
        if ($sz -ge $cfgMaxKB) {
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            Move-Item $AuditLog (Join-Path $LogsDir "panel-audit-$stamp.log") -Force
            $archives = Get-ChildItem (Join-Path $LogsDir "panel-audit-*.log") |
                Sort-Object LastWriteTime -Descending
            if ($archives.Count -gt 10) {
                $archives | Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}

# ===================== 磁盘 / 内网IP =====================
function Get-FreeSpaceGB {
    try {
        $letter = $ProjectRoot.Substring(0, 1)
        $vol = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue
        if ($vol -and $vol.SizeRemaining) { return [math]::Round($vol.SizeRemaining / 1GB, 1) }
    } catch {}
    try {
        $drv = Get-WmiObject -Query "SELECT FreeSpace FROM Win32_LogicalDisk WHERE DeviceID='$($ProjectRoot.Substring(0,2))'" -ErrorAction SilentlyContinue
        if ($drv -and $drv.FreeSpace) { return [math]::Round($drv.FreeSpace / 1GB, 1) }
    } catch {}
    return $null
}

function Get-LocalIP {
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } |
            Select-Object -First 1).IPAddress
        if ($ip) { return $ip }
    } catch {}
    try {
        $ip = (Get-WmiObject Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue |
            Where-Object { $_.IPEnabled -and $_.IPAddress } |
            ForEach-Object { $_.IPAddress } |
            Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -ne '127.0.0.1' } |
            Select-Object -First 1)
        if ($ip) { return $ip }
    } catch {}
    return $null
}

# ===================== 服务状态检测（按端口反查 PID） =====================
function Get-PidByPort([int]$port) {
    $line = netstat -ano 2>$null | Select-String ":$port\s" | Select-String "LISTENING" | Select-Object -First 1
    if ($line) {
        $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
        $procIdv = $parts[-1]
        [int]$p = 0
        if ([int]::TryParse($procIdv, [ref]$p)) { return $p }
    }
    return $null
}

function Get-ServiceStatus {
    $result = @{}
    foreach ($svc in $Config.services) {
        $procId = Get-PidByPort ([int]$svc.port)
        $result[$svc.name] = @{ running = ($null -ne $procId); pid = $procId }
    }
    return $result
}

function Get-ProcessName([int]$procId) {
    try {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p) { return $p.Name }
    } catch {}
    return $null
}

# ===================== 服务启停（内部） =====================
function Start-OneService($svc) {
    $port = [int]$svc.port
    if (Get-PidByPort $port) { return $true }
    $exe = $svc.start.exe
    $args = $svc.start.args
    $cwd = $svc.start.cwd
    # 相对路径按项目根解析（支持配置里写相对路径，避免写死项目根）
    if ($cwd -and -not [System.IO.Path]::IsPathRooted($cwd)) { $cwd = Join-Path $ProjectRoot $cwd }
    if (-not (Test-Path $exe) -and $exe -ne "node") {
        C "  未找到启动程序：$exe" "Red"
        return $false
    }
    if (-not (Test-Path $cwd)) {
        C "  工作目录不存在：$cwd" "Red"
        return $false
    }
    try {
        $p = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $cwd -WindowStyle Hidden -PassThru
    } catch {
        C "  启动失败：$_" "Red"
        return $false
    }
    $waited = 0
    while (-not (Get-PidByPort $port) -and $waited -lt 30) { Start-Sleep -Seconds 1; $waited++ }
    return (Get-PidByPort $port) -ne $null
}

function Stop-OneService($svc) {
    $port = [int]$svc.port
    $procId = Get-PidByPort $port
    # 1) 按端口 PID 强杀（Stop-Process）
    if ($null -ne $procId) {
        try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
    }
    # 2) 释放端口兜底：直接按进程名强杀（覆盖 master + worker，无需管理员也尽量终止）
    #    解析 exe 文件名（如 nginx.exe）；若无法解析则对所有监听该端口的 PID 用 taskkill /f
    $exeName = $null
    try {
        $raw = $svc.start.exe
        if ($raw -and $raw -ne 'node') { $exeName = Split-Path $raw -Leaf }
    } catch {}
    if ($exeName) {
        try {
            $code = (Start-Process -FilePath "taskkill" -ArgumentList "/f","/im",$exeName -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue).ExitCode
        } catch {}
    }
    # 3) 仍残留：把所有监听该端口的 PID 全部 taskkill /f（管理员权限下才有效）
    $waited = 0
    while ((Get-PidByPort $port) -and $waited -lt 15) {
        $pid2 = Get-PidByPort $port
        if ($null -ne $pid2) {
            try { Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue } catch {}
            try {
                Start-Process -FilePath "taskkill" -ArgumentList "/f","/pid",$pid2 -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue | Out-Null
            } catch {}
        }
        Start-Sleep -Seconds 1; $waited++
    }
    return (Get-PidByPort $port) -eq $null
}

# ===================== 路径安全校验 =====================
function Test-PathSafe([string]$path) {
    if ($path -match '\.\.') { return $false }
    try {
        $full = Resolve-Path -Path $path -ErrorAction Stop
        $root = Resolve-Path -Path $ProjectRoot -ErrorAction Stop
        return $full.Path.StartsWith($root.Path, [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

# ===================== 通用交互 =====================
function Press-Enter { Read-Host "按 Enter 键返回主菜单" }
function Confirm-YN([string]$prompt) {
    $r = Read-Host "$prompt (Y/N)"
    return ($r -eq "Y" -or $r -eq "y")
}
function Confirm-Exact([string]$expect, [string]$prompt) {
    $r = Read-Host $prompt
    return ($r -ceq $expect)
}

# ===================== 顶部状态 + 菜单 =====================
$Divider = "=" * 44
function Show-Menu {
    try { Clear-Host } catch {}
    $status = Get-ServiceStatus
    $bizName = "NodeServer"
    try { if ($Config.businessService) { $bizName = $Config.businessService } } catch {}
    $biz = $status[$bizName]
    if ($null -eq $biz) { $biz = @{ running = $false; pid = $null } }

    $state = if ($biz.running) { "✅服务运行中" } else { "❌服务停止" }
    $space = Get-FreeSpaceGB
    $spaceStr = if ($null -eq $space) { "磁盘空间：读取异常" } else { "磁盘剩余：$($space)GB" }
    $ip = Get-LocalIP
    $ipStr = if ($ip) { "内网IP:$ip" } else { "内网IP：获取失败" }

    C $Divider "Cyan"
    C ("      境途WEB服务增强控制面板") "Cyan"
    C ("  状态：$state ｜ $spaceStr ｜ $ipStr") "White"
    C $Divider "Cyan"
    if (-not $IsAdmin) {
        C "  ⚠ 当前非管理员模式，终止端口进程、部分服务操作可能权限受限。" "Yellow"
    }

    $menu = @"
 1 - 重置初始化
 2 - 启动服务
 3 - 关闭服务（仅终止业务对应进程）
 4 - 重启服务（停止→等待释放→启动）
 5 - 查看服务运行状态
 6 - 打开项目根目录
 7 - 打开logs日志目录
 8 - 清理全部日志
 9 - 备份用户数据
10 - 清除用户数据【高危】
11 - 查看备份列表
12 - 从备份恢复数据【高危】
13 - 查看最近日志
14 - 检查运行环境依赖
15 - 导出配置备份
16 - 检测端口占用
17 - 释放占用端口【高危】
18 - 获取内网访问IP
19 - 检查磁盘剩余空间
20 - 搜索日志错误
21 - 清理项目缓存
22 - 查看审计日志
23 - 简易服务守护开关（会话内生效）
24 - 导出面板配置文件
25 - 快速打开项目网页
26 - 重置超级管理员密码【破窗恢复】
27 - 导出网站主文件（代码/配置/静态资源打包）
 0 - 退出控制面板
"@
    Write-Host $menu
    C "提示：输入 h 查看简易帮助；退出请输入 0" "DarkGray"
}

function Show-Help {
    try { Clear-Host } catch {}
    C $Divider "Cyan"
    C "            简易帮助" "Cyan"
    C $Divider "Cyan"
    Write-Host @"
本面板用于管理境途WEB本地服务（MySQL / Nginx / Node）。
- 启动前请确保已在配置 panel-config.json 中填写正确的服务路径。
- 状态区每次返回菜单都会实时刷新（服务/磁盘/内网IP）。
- 危险操作（清除数据、恢复、释放端口）均有二次确认或指定字符串确认。
- 所有关键操作均写入 logs\panel-audit.log 审计日志。
- 输入数字选择功能；数字 0 退出；字母 h 查看本帮助。

如某项功能提示"未找到…"，请检查项目完整性或配置文件。
"@
    C $Divider "Cyan"
}

# ===================== 各功能实现 =====================
function Do-Reset {
    C "正在执行重置初始化..." "Yellow"
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        C "❌ 未找到 node，请确认 Node.js 已安装并在 PATH 中。" "Red"
        Write-Audit "重置初始化：未找到 node"; return
    }
    $script = Join-Path $ProjectRoot "server\scripts\reset-to-init.js"
    if (-not (Test-Path $script)) {
        C "❌ 未找到重置脚本：$script" "Red"
        Write-Audit "重置初始化：未找到脚本 $script"; return
    }
    try {
        & node $script
        if ($LASTEXITCODE -eq 0) {
            C "重置执行完成。" "Green"
            Write-Audit "重置初始化：执行 reset-to-init.js 成功"
        } else {
            C "重置执行失败（退出码 $LASTEXITCODE），请查看上方输出。" "Red"
            Write-Audit "重置初始化：reset-to-init.js 退出码 $LASTEXITCODE"
        }
    } catch {
        C "重置执行失败：$_" "Red"
        Write-Audit "重置初始化：执行 reset-to-init.js 失败 - $_"
    }
}

function Do-ResetSuperAdmin {
    C "此操作将重置/重建超级管理员密码（破窗恢复）。" "Yellow"
    C "适用场景：网站异常、超级管理员无法登录时，在终端直接修复账号。" "White"
    C "脚本会读取 .env 连接数据库，列出当前超级管理员并交互式重置，或新建 super_admin。" "White"
    C "⚠ 运行后请使用输出的临时密码登录，并立即修改密码。" "Yellow"
    if (-not (Confirm-YN "确认继续重置超级管理员密码？")) {
        C "已取消。" "Yellow"; Write-Audit "重置超级管理员密码：用户取消"; return
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        C "❌ 未找到 node，请确认 Node.js 已安装并在 PATH 中。" "Red"
        Write-Audit "重置超级管理员密码：未找到 node"; return
    }
    $script = Join-Path $ProjectRoot "server\scripts\reset-superadmin.js"
    if (-not (Test-Path $script)) {
        C "❌ 未找到重置脚本：$script" "Red"
        Write-Audit "重置超级管理员密码：未找到脚本"; return
    }
    try {
        Push-Location $ProjectRoot
        & node $script
        Pop-Location
        C "✅ 重置超级管理员密码执行完毕。" "Green"
        Write-Audit "重置超级管理员密码：执行成功"
    } catch {
        Pop-Location -ErrorAction SilentlyContinue
        C "重置执行失败：$_" "Red"
        Write-Audit "重置超级管理员密码：失败 - $_"
    }
}

function Do-ExportSite {
    C "正在导出网站主文件（代码/配置/静态资源）为压缩包..." "Cyan"
    $exportScript = Join-Path $ProjectRoot "export-site.ps1"
    if (-not (Test-Path $exportScript)) {
        C "❌ 未找到导出脚本：$exportScript" "Red"
        Write-Audit "导出网站主文件：未找到 export-site.ps1"
        return
    }
    C "默认导出到 D:/phpstudy_pro/WWW（按 Ctrl+C 可随时取消；如需自定义可用 -OutDir/-IncludeData）。" "White"
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $exportScript
        Write-Audit "导出网站主文件：执行完毕"
    } catch {
        C "导出执行失败：$_" "Red"
        Write-Audit "导出网站主文件：失败 - $_"
    }
}

function Do-Start {
    C "正在启动全部服务..." "Yellow"
    $ok = $true
    foreach ($svc in $Config.services) {
        C "  [启动] $($svc.name) (端口 $($svc.port))..." "White"
        if (Start-OneService $svc) { C "    ✅ 成功" "Green"; Write-Audit "启动服务：$($svc.name) 成功" }
        else { C "    ❌ 失败" "Red"; $ok = $false; Write-Audit "启动服务：$($svc.name) 失败" }
    }
    if ($ok) {
        C "全部服务启动完成。正在做健康检查..." "Green"
        # 健康检查端口从配置的业务服务读取（此前写死 3456）
        $bizNameLocal = if ($Config.businessService) { $Config.businessService } else { "NodeServer" }
        $hp = 3456
        try {
            $bizSvc = $Config.services | Where-Object { $_.name -eq $bizNameLocal }
            if ($bizSvc -and $bizSvc.port) { $hp = [int]$bizSvc.port }
        } catch {}
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:$hp/api/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
            if ($r.StatusCode -eq 200) { C "  ✅ 健康检查通过" "Green" } else { C "  ⚠ 健康检查返回 $($r.StatusCode)" "Yellow" }
        } catch { C "  ⚠ 健康检查未通过（服务可能仍在预热）" "Yellow" }
    }
}

function Do-Stop {
    C "正在关闭全部服务..." "Yellow"
    foreach ($svc in $Config.services) {
        C "  [关闭] $($svc.name) (端口 $($svc.port))..." "White"
        if (Stop-OneService $svc) { C "    ✅ 已停止" "Green"; Write-Audit "关闭服务：$($svc.name) 成功" }
        else { C "    ⚠ 停止失败（可能权限不足或进程已退出）" "Yellow"; Write-Audit "关闭服务：$($svc.name) 失败" }
    }
}

function Do-Restart {
    C "正在重启服务（先停止，等待释放后再启动）..." "Yellow"
    Do-Stop
    Start-Sleep -Seconds 2
    Do-Start
    Write-Audit "重启服务：完成"
}

function Do-Status {
    $status = Get-ServiceStatus
    C "===== 服务运行状态 =====" "Cyan"
    foreach ($svc in $Config.services) {
        $s = $status[$svc.name]
        if ($s.running) {
            $p = Get-Process -Id $s.pid -ErrorAction SilentlyContinue
            $res = ""
            if ($p) {
                $mem = [math]::Round($p.WorkingSet / 1MB, 1)
                $res = " CPU=$($p.CPU.ToString('0.0'))s 内存=${mem}MB"
            }
            C "  ✅ $($svc.name)  端口 $($svc.port)  PID=$($s.pid)$res" "Green"
        } else {
            C "  ❌ $($svc.name)  端口 $($svc.port)  未运行" "Red"
        }
    }
}

function Do-OpenRoot { try { Invoke-Item $ProjectRoot; C "已打开项目根目录。" "Green" } catch { C "打开失败：$_" "Red" } }
function Do-OpenLogs {
    if (Test-Path $LogsDir) { try { Invoke-Item $LogsDir; C "已打开日志目录。" "Green" } catch { C "打开失败：$_" "Red" } }
    else { C "日志目录尚未生成，请先启动服务或手动创建。" "Yellow" }
}

function Do-CleanLogs {
    if (-not (Confirm-YN "将删除 logs 目录下全部日志文件（保留审计日志与目录本体），确认？")) { C "已取消。" "Yellow"; return }
    $removed = 0
    Get-ChildItem $LogsDir -File | Where-Object { $_.Name -notlike "panel-audit*" } | ForEach-Object {
        try { Remove-Item $_.FullName -Force; $removed++ } catch {}
    }
    C "已清理 $removed 个日志文件。" "Green"
    Write-Audit "清理日志：删除 $removed 个文件"
}

function Get-DataDir { return Join-Path $ProjectRoot $Config.dataDir }

function Test-DiskForBackup([string]$targetPath, [long]$estimateBytes) {
    try {
        $letter = $targetPath.Substring(0, 1)
        $vol = Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue
        if ($vol -and $vol.SizeRemaining) {
            $free = $vol.SizeRemaining
            if ($free -lt $estimateBytes) {
                C "磁盘剩余空间不足（需约 $([math]::Round($estimateBytes/1GB,2))GB），拒绝执行以防生成损坏备份。" "Red"
                return $false
            }
        }
    } catch {}
    return $true
}

function Do-Backup {
    $dataDir = Get-DataDir
    if (-not (Test-Path $dataDir)) { C "用户数据目录不存在：$dataDir" "Red"; return }
    $status = Get-ServiceStatus
    $bizName = if ($Config.businessService) { $Config.businessService } else { "NodeServer" }
    if ($status[$bizName] -and $status[$bizName].running) {
        C "⚠ 服务正在运行，部分文件可能被占用，备份可能不一致。" "Yellow"
        if (-not (Confirm-YN "是否仍然继续备份？")) { C "已取消。" "Yellow"; return }
    }
    # 预估大小
    $size = (Get-ChildItem $dataDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if (-not $size) { $size = 0 }
    if (-not (Test-DiskForBackup $BackupDir ($size + 50MB))) { Write-Audit "备份用户数据：磁盘空间不足，已拒绝"; return }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $zip = Join-Path $BackupDir "userdata-$stamp.zip"
    C "正在备份用户数据（请稍候）..." "Yellow"
    $locked = @()
    try {
        # 原生压缩；逐个文件处理以容错被占用文件
        if (-not (Test-Path $zip)) { Compress-Archive -Path $dataDir -DestinationPath $zip -Force -ErrorAction Stop }
        C "  ✅ 备份完成：$zip" "Green"
        Write-Audit "备份用户数据：成功 $zip"
    } catch {
        # 降级：逐文件复制，记录被占用文件
        C "  压缩失败，尝试逐文件复制兜底..." "Yellow"
        $dest = Join-Path $BackupDir "userdata-$stamp"
        if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
        Get-ChildItem $dataDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            $rel = $_.FullName.Substring($dataDir.Length).TrimStart('\')
            $target = Join-Path $dest $rel
            $td = Split-Path $target
            if (-not (Test-Path $td)) { New-Item -ItemType Directory -Path $td -Force | Out-Null }
            try { Copy-Item $_.FullName $target -Force } catch { $locked += $_.FullName }
        }
        if ($locked.Count -gt 0) {
            $warnFile = Join-Path $dest "BACKUP-WARNING.txt"
            "以下文件在备份时无法读取（可能被占用），备份存在部分不一致：`r`n" + ($locked -join "`r`n") |
                Out-File -Encoding utf8 $warnFile
            C "  ⚠ 有 $($locked.Count) 个文件被占用未能备份，已写入告警说明。" "Yellow"
        }
        C "  ✅ 兜底备份完成：$dest" "Green"
        Write-Audit "备份用户数据：兜底复制完成（被占用 $($locked.Count) 个）"
    }
    # 保留策略
    $keep = 10; try { if ($Config.backupRetention) { $keep = [int]$Config.backupRetention } } catch {}
    $all = Get-ChildItem $BackupDir -File -Filter "userdata-*" | Sort-Object LastWriteTime -Descending
    if ($all.Count -gt $keep) { $all | Select-Object -Skip $keep | Remove-Item -Force -ErrorAction SilentlyContinue }
    # 完整性校验：拒绝 0 字节
    if ((Test-Path $zip) -and (Get-Item $zip).Length -eq 0) {
        C "  ❌ 备份包为空，已删除。" "Red"; Remove-Item $zip -Force; Write-Audit "备份用户数据：0字节备份已删除"
    }
}

function Do-ClearData {
    $status = Get-ServiceStatus
    $bizName = if ($Config.businessService) { $Config.businessService } else { "NodeServer" }
    if ($status[$bizName] -and $status[$bizName].running) {
        C "❌ 服务正在运行，禁止清除用户数据。请先关闭服务（选项 3）。" "Red"; return
    }
    C "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" "Red"
    C "  高危操作：将永久删除用户数据目录内全部内容！" "Red"
    C "  建议优先执行「9 - 备份用户数据」。" "Red"
    C "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" "Red"
    $expect = if ($Config.highRiskConfirm) { $Config.highRiskConfirm } else { "CONFIRM-DELETE-ALL-DATA" }
    if (-not (Confirm-Exact $expect "请输入确认字符串 [$expect] 以继续（大小写严格匹配）：")) {
        C "确认字符串不匹配，操作已取消。" "Yellow"; return
    }
    $dataDir = Get-DataDir
    if (-not (Test-Path $dataDir)) { C "用户数据目录不存在，无需清理。" "Yellow"; return }
    Get-ChildItem $dataDir -Force | ForEach-Object { try { Remove-Item $_.FullName -Recurse -Force } catch {} }
    C "✅ 用户数据已清空（目录已保留）。" "Green"
    Write-Audit "清除用户数据：高危操作完成"
}

function Do-BackupList {
    if (-not (Test-Path $BackupDir) -or ((Get-ChildItem $BackupDir -File).Count -eq 0)) {
        C "暂无备份。" "Yellow"; return
    }
    C "===== 备份列表 =====" "Cyan"
    Get-ChildItem $BackupDir -File | Sort-Object LastWriteTime -Descending | ForEach-Object {
        $type = "其他"
        if ($_.Name -like "userdata-*") { $type = "用户数据备份" }
        elseif ($_.Name -like "config-*") { $type = "配置备份" }
        $sz = [math]::Round($_.Length / 1MB, 2)
        C ("  {0,-36} {1,10}MB  {2}  [{3}]" -f $_.Name, $sz, $_.LastWriteTime.ToString("yyyy-MM-dd HH:mm"), $type) "White"
    }
}

function Do-Restore {
    $status = Get-ServiceStatus
    $bizName = if ($Config.businessService) { $Config.businessService } else { "NodeServer" }
    if ($status[$bizName] -and $status[$bizName].running) {
        C "❌ 服务必须停止才能恢复数据，请先关闭服务（选项 3）。" "Red"; return
    }
    $backups = @(Get-ChildItem $BackupDir -File -Filter "userdata-*" | Sort-Object LastWriteTime -Descending)
    if ($backups.Count -eq 0) { C "暂无用户数据备份。" "Yellow"; return }
    C "===== 可用备份 =====" "Cyan"
    for ($i = 0; $i -lt $backups.Count; $i++) {
        C ("  [$i] {0}  {1}" -f $backups[$i].Name, $backups[$i].LastWriteTime.ToString("yyyy-MM-dd HH:mm")) "White"
    }
    $sel = Read-Host "请输入要恢复的备份序号"
    [int]$idx = -1
    if (-not [int]::TryParse($sel, [ref]$idx) -or $idx -lt 0 -or $idx -ge $backups.Count) {
        C "无效序号。" "Red"; return
    }
    $target = $backups[$idx].FullName
    # 完整性校验
    if ($target.EndsWith(".zip") -and (Get-Item $target).Length -eq 0) {
        C "❌ 该备份包为空/损坏，禁止恢复。" "Red"; return
    }
    # 自动快照当前数据作为回退兜底
    $dataDir = Get-DataDir
    $snapStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $snap = Join-Path $BackupDir "userdata-snapshot-$snapStamp.zip"
    if (Test-Path $dataDir) {
        try { Compress-Archive -Path $dataDir -DestinationPath $snap -Force; C "已生成当前数据快照（回退兜底）：$snap" "Yellow" }
        catch { C "⚠ 生成快照失败：$_" "Yellow" }
    }
    $expect = if ($Config.restoreConfirm) { $Config.restoreConfirm } else { "CONFIRM-RESTORE-FROM-BACKUP" }
    C "将用所选备份覆盖当前用户数据目录，覆盖前已生成快照。" "Yellow"
    if (-not (Confirm-Exact $expect "请输入确认字符串 [$expect] 以继续（大小写严格匹配）：")) {
        C "确认字符串不匹配，操作已取消。" "Yellow"; return
    }
    # 清空目标再恢复
    if (Test-Path $dataDir) { Get-ChildItem $dataDir -Force | ForEach-Object { try { Remove-Item $_.FullName -Recurse -Force } catch {} } }
    try {
        if ($target.EndsWith(".zip")) { Expand-Archive -Path $target -DestinationPath $dataDir -Force }
        else { Get-ChildItem $target -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($target.Length).TrimStart('\')
                $t = Join-Path $dataDir $rel; $td = Split-Path $t
                if (-not (Test-Path $td)) { New-Item -ItemType Directory -Path $td -Force | Out-Null }
                Copy-Item $_.FullName $t -Force
            } }
        C "✅ 恢复完成。" "Green"
        Write-Audit "从备份恢复数据：成功 $target（快照 $snap）"
    } catch {
        C "❌ 恢复异常：$_" "Red"
        C "可使用快照回退：$snap" "Yellow"
        Write-Audit "从备份恢复数据：异常 $_（快照 $snap）"
    }
}

function Do-TailLogs {
    $logs = @(Get-ChildItem $LogsDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "panel-audit*" -and $_.Length -gt 0 })
    if ($logs.Count -eq 0) { C "暂无日志记录。" "Yellow"; return }
    C "===== 最近日志（每文件末尾50行） =====" "Cyan"
    foreach ($lf in $logs) {
        C "----- $($lf.Name) -----" "White"
        Get-Content $lf.FullName -Encoding UTF8 -Tail 50 -ErrorAction SilentlyContinue
    }
}

function Do-CheckEnv {
    C "===== 运行环境依赖检查 =====" "Cyan"
    # 关键程序
    $checks = @()
    foreach ($svc in $Config.services) {
        $exe = $svc.start.exe
        $ok = if ($exe -eq "node") { $null -ne (Get-Command node -ErrorAction SilentlyContinue) } else { Test-Path $exe }
        $checks += [pscustomobject]@{ Item = "$($svc.name) 程序"; Path = $exe; OK = $ok }
    }
    # 关键文件
    $keyFiles = @("server\server.js", ".env", "public")
    foreach ($kf in $keyFiles) {
        $checks += [pscustomobject]@{ Item = "关键文件/目录"; Path = $kf; OK = (Test-Path (Join-Path $ProjectRoot $kf)) }
    }
    foreach ($c in $checks) {
        if ($c.OK) { C ("  ✅ {0,-18} {1}" -f $c.Item, $c.Path) "Green" }
        else { C ("  ❌ {0,-18} {1}  (缺失/不可达)" -f $c.Item, $c.Path) "Red" }
    }
}

function Do-ExportConfig {
    if (-not (Test-Path $ConfigFile)) { C "配置文件不存在。" "Red"; return }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $dest = Join-Path $BackupDir "config-$stamp.json"
    try { Copy-Item $ConfigFile $dest -Force; C "配置备份已导出：$dest" "Green"; Write-Audit "导出配置备份：$dest" }
    catch { C "导出失败：$_" "Red" }
    # 保留策略
    $keep = 5; try { if ($Config.configBackupRetention) { $keep = [int]$Config.configBackupRetention } } catch {}
    $all = Get-ChildItem $BackupDir -File -Filter "config-*" | Sort-Object LastWriteTime -Descending
    if ($all.Count -gt $keep) { $all | Select-Object -Skip $keep | Remove-Item -Force -ErrorAction SilentlyContinue }
}

function Do-PortCheck {
    $def = if ($Config.businessService) { ($Config.services | Where-Object { $_.name -eq $Config.businessService }).port } else { 3456 }
    $inp = Read-Host "请输入端口（直接回车使用默认 $def）"
    [int]$port = $def
    if ($inp -match '^\d+$') { $port = [int]$inp }
    $procId = Get-PidByPort $port
    if ($null -eq $procId) { C "端口 $port 空闲。" "Green" }
    else {
        $name = Get-ProcessName $procId
        C "端口 $port 被占用：PID=$procId 进程=$name" "Yellow"
    }
}

$CriticalPorts = @(135, 137, 138, 139, 445, 3389, 5985, 5986)
$CriticalProcNames = @("System", "System Idle Process", "csrss", "services", "lsass", "wininit", "smss", "explorer")
function Do-ReleasePort {
    $inp = Read-Host "请输入要释放的端口"
    [int]$port = 0
    if (-not ($inp -match '^\d+$' -and [int]::TryParse($inp, [ref]$port))) { C "无效端口。" "Red"; return }
    if ($CriticalPorts -contains $port) { C "❌ 该端口为系统关键端口，禁止操作。" "Red"; return }
    $procId = Get-PidByPort $port
    if ($null -eq $procId) { C "端口 $port 空闲，无需释放。" "Green"; return }
    $name = Get-ProcessName $procId
    if ($CriticalProcNames -contains $name) { C "❌ 该进程为系统关键进程（$name），禁止终止。" "Red"; return }
    C "端口 $port 占用进程：PID=$procId 名称=$name" "Yellow"
    if (-not (Confirm-YN "确认终止该进程以释放端口？")) { C "已取消。" "Yellow"; return }
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; C "已发送终止指令。" "Green" }
    catch { C "终止失败（权限不足请以管理员模式运行）：$_" "Red"; Write-Audit "释放端口：$port 终止PID=$procId 失败 - $_"; return }
    Start-Sleep -Seconds 2
    if ((Get-PidByPort $port) -eq $null) { C "✅ 端口 $port 已释放。" "Green"; Write-Audit "释放端口：$port 成功" }
    else { C "⚠ 端口仍未释放，请手动检查。" "Yellow"; Write-Audit "释放端口：$port 仍未释放" }
}

function Do-ShowIP {
    $ip = Get-LocalIP
    if ($ip) {
        C "本机内网IPv4地址：$ip" "Green"
        C "项目网页访问示例：http://$ip  或  http://localhost" "White"
    } else { C "获取失败。" "Red" }
}

function Do-Disk {
    $space = Get-FreeSpaceGB
    if ($null -eq $space) { C "磁盘空间：读取异常" "Red"; return }
    $warn = 1.0; try { if ($Config.diskWarnGB) { $warn = [double]$Config.diskWarnGB } } catch {}
    if ($space -lt $warn) { C "⚠ 空间不足警告：剩余 ${space}GB（阈值 ${warn}GB）" "Red" }
    else { C "磁盘剩余空间：${space}GB" "Green" }
}

function Do-SearchErrors {
    if (-not (Test-Path $LogsDir)) { C "暂无日志。" "Yellow"; return }
    $kws = @("ERROR", "FATAL", "Exception", "失败")
    try { if ($Config.logSearchKeywords) { $kws = @($Config.logSearchKeywords) } } catch {}
    $lines = @()
    Get-ChildItem $LogsDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "panel-audit*" } | ForEach-Object {
        $lf = $_.FullName
        $fname = $_.Name
        Get-Content $lf -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object {
            $line = $_
            foreach ($k in $kws) { if ($line -match [regex]::Escape($k)) { $lines += "${fname}: $line"; break } }
        }
    }
    if ($lines.Count -eq 0) { C "未检索到错误记录。" "Green"; return }
    C "===== 错误日志（最多200行） =====" "Cyan"
    $lines | Select-Object -First 200 | ForEach-Object { C $_ "Red" }
    if ($lines.Count -gt 200) { C "...（已截断，共 $($lines.Count) 条）" "Yellow" }
}

function Do-CleanCache {
    if (-not (Confirm-YN "将清理项目内临时/缓存目录（temp、cache、__pycache__ 等，不触碰用户数据与配置），确认？")) { C "已取消。" "Yellow"; return }
    $targets = @("__pycache__", "temp", "cache", "node_modules\.cache")
    $removed = 0
    foreach ($t in $targets) {
        $p = Join-Path $ProjectRoot $t
        if (Test-Path $p) {
            # 路径安全：必须在项目根内
            if (Test-PathSafe $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue; $removed++ }
        }
    }
    C "已清理 $removed 类缓存目录。" "Green"
    Write-Audit "清理缓存：清理 $removed 类目录"
}

function Do-ViewAudit {
    if (-not (Test-Path $AuditLog)) { C "暂无审计记录。" "Yellow"; return }
    $sz = (Get-Item $AuditLog).Length / 1KB
    $maxKB = 100; try { if ($Config.auditLogMaxKB) { $maxKB = [int]$Config.auditLogMaxKB } } catch {}
    if ($sz -lt $maxKB) {
        C "===== 审计日志（末尾30行） =====" "Cyan"
        Get-Content $AuditLog -Encoding UTF8 -Tail 30 -ErrorAction SilentlyContinue
    } else {
        C "审计日志较大，正在用记事本打开..." "Yellow"
        try { Start-Process notepad.exe $AuditLog } catch { C "打开失败，路径：$AuditLog" "Red" }
    }
}

$global:DaemonJob = $null
function Start-Daemon {
    if ($global:DaemonJob) { C "简易守护已在运行。" "Yellow"; return }
    # 守护 Job 运行在独立 runspace，相对路径不确定：预规范化为绝对路径
    $svcList = @()
    foreach ($svc in $Config.services) {
        $exe = $svc.start.exe
        $svArgs = $svc.start.args
        $cwd = $svc.start.cwd
        if ($cwd -and -not [System.IO.Path]::IsPathRooted($cwd)) { $cwd = Join-Path $ProjectRoot $cwd }
        if ($exe -and $exe -ne "node" -and -not [System.IO.Path]::IsPathRooted($exe)) { $exe = Join-Path $ProjectRoot $exe }
        $svcList += [ordered]@{ name = $svc.name; port = $svc.port; exe = $exe; args = $svArgs; cwd = $cwd }
    }
    $cfgJson = @{ services = $svcList } | ConvertTo-Json -Depth 4 -Compress
    $sb = {
        param($cfgJson)
        $cfg = $cfgJson | ConvertFrom-Json
        while ($true) {
            Start-Sleep -Seconds 10
            foreach ($svc in $cfg.services) {
                $line = netstat -ano 2>$null | Select-String ":$($svc.port)\s" | Select-String "LISTENING" | Select-Object -First 1
                if (-not $line) {
                    try {
                        Start-Process -FilePath $svc.exe -ArgumentList $svc.args -WorkingDirectory $svc.cwd -WindowStyle Hidden -ErrorAction SilentlyContinue
                    } catch {}
                }
            }
        }
    }
    try {
        $global:DaemonJob = Start-Job -ScriptBlock $sb -ArgumentList $cfgJson -ErrorAction Stop
        C "简易守护已开启（仅在当前会话内生效，关闭面板后自动失效）。" "Green"
        Write-Audit "简易守护：开启"
    } catch { C "启动守护失败：$_" "Red" }
}
function Stop-Daemon {
    if ($global:DaemonJob) {
        try { Stop-Job $global:DaemonJob -ErrorAction SilentlyContinue; Remove-Job $global:DaemonJob -ErrorAction SilentlyContinue } catch {}
        $global:DaemonJob = $null
        C "简易守护已关闭。" "Yellow"
        Write-Audit "简易守护：关闭"
    } else { C "简易守护未运行。" "Yellow" }
}
function Do-DaemonToggle {
    if ($global:DaemonJob) { Stop-Daemon } else { Start-Daemon }
}

function Do-ExportPanelConfig {
    if (-not (Test-Path $ConfigFile)) { C "配置文件不存在。" "Red"; return }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $dest = Join-Path $BackupDir "panel-config-export-$stamp.json"
    try { Copy-Item $ConfigFile $dest -Force; C "面板配置文件已导出（便于迁移部署）：$dest" "Green"; Write-Audit "导出面板配置文件：$dest" }
    catch { C "导出失败：$_" "Red" }
}

function Do-OpenWeb {
    $ip = Get-LocalIP
    $url = if ($ip) { "http://$ip" } else { "http://localhost" }
    C "正在打开：$url" "Green"
    try { Start-Process $url } catch { C "打开失败，请手动访问 $url" "Red" }
}

# ===================== 退出善后 =====================
$global:Cleaned = $false
$global:SessionEndType = "会话结束（可能由 Ctrl+C 或窗口关闭触发）"
# 改为全局函数：Register-EngineEvent -Action 运行在独立模块作用域，脚本作用域函数不可见
function global:Cleanup {
    if ($global:Cleaned) { return }
    $global:Cleaned = $true
    try {
        if ($Config.stopServicesOnExit) {
            foreach ($svc in $Config.services) { Stop-OneService $svc | Out-Null }
        }
    } catch {}
    try { if (Test-Path $LockFile) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue } } catch {}
    try { if ($global:Mutex) { $global:Mutex.ReleaseMutex(); $global:Mutex.Close() } } catch {}
    try { Stop-Daemon } catch {}
    $type = $global:SessionEndType
    Write-Audit "会话终止：类型=$type | PID=$PID"
}

# 注册会话退出事件，尽量做善后（覆盖 Ctrl+C / 窗口关闭）
try {
    Register-EngineEvent -SourceIdentifier PowerShell.Exiting -SupportEvent -Action { Cleanup } | Out-Null
} catch {}
# 顶层异常兜底
trap { try { Cleanup } catch {}; break }

# ===================== 启动 =====================
Init-Lock
Write-Audit "面板启动 [PID=$PID] 管理员=$IsAdmin 版本=2026-08-20"
C "欢迎使用境途WEB服务增强控制面板。" "Cyan"
Start-Sleep -Seconds 1

# ===================== 主循环 =====================
while ($true) {
    Show-Menu
    $choice = Read-Host "请选择操作 [0-27]"
    if ($choice -eq "h" -or $choice -eq "H") { Show-Help; Press-Enter; continue }
    if ($choice -notmatch '^\d+$') {
        C "无效选项，请重新输入" "Red"; Start-Sleep -Seconds 1.5; continue
    }
    $n = [int]$choice
    if ($n -lt 0 -or $n -gt 27) {
        C "无效选项，请重新输入" "Red"; Start-Sleep -Seconds 1.5; continue
    }
    switch ($n) {
        0  { $global:SessionEndType = "正常退出"; Cleanup; C "正在退出控制面板..." "Cyan"; Start-Sleep -Seconds 1; exit 0 }
        1  { Do-Reset }
        2  { Do-Start }
        3  { Do-Stop }
        4  { Do-Restart }
        5  { Do-Status }
        6  { Do-OpenRoot }
        7  { Do-OpenLogs }
        8  { Do-CleanLogs }
        9  { Do-Backup }
        10 { Do-ClearData }
        11 { Do-BackupList }
        12 { Do-Restore }
        13 { Do-TailLogs }
        14 { Do-CheckEnv }
        15 { Do-ExportConfig }
        16 { Do-PortCheck }
        17 { Do-ReleasePort }
        18 { Do-ShowIP }
        19 { Do-Disk }
        20 { Do-SearchErrors }
        21 { Do-CleanCache }
        22 { Do-ViewAudit }
        23 { Do-DaemonToggle }
        24 { Do-ExportPanelConfig }
        25 { Do-OpenWeb }
        26 { Do-ResetSuperAdmin }
        27 { Do-ExportSite }
    }
    if ($n -ne 0) { Press-Enter }
}

