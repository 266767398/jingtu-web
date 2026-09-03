#Requires -Version 5.1
<#
  境途WEB 统一运维工具（PowerShell 主程序，Windows）
  ----------------------------------------------------------
  单入口，合并原 start-panel 与 export-site 两大功能：
    - 运维控制台：启动/停止/重启 网站与面板、状态探测、清理卡死 cmd 窗口
    - 依赖管理：MySQL / Nginx 自动探测与启停，启动网站前自动确保 MySQL 已起
    - 网站导出  ：把项目核心文件复制并打包为 zip

  跨平台说明：
    - 本文件 (.ps1) 仅用于 Windows。
    - 导出打包在 Linux/macOS 上请用同目录的 jingtu.sh（功能等价）。
    - 服务启停依赖 Windows 的 node / netstat / Start-Process，无法跨平台。

  用法:
    jingtu.bat                              # 进入交互菜单
    jingtu.bat status                       # 查看服务状态
    jingtu.bat start / stop / restart
    jingtu.bat panel-start / panel-stop / panel-restart
    jingtu.bat start-all / stop-all / restart-all
    jingtu.bat mysql-start / mysql-stop
    jingtu.bat nginx-start / nginx-stop
    jingtu.bat clean                        # 清理卡死的 cmd 窗口
    jingtu.bat export [-OutDir <path>] [-Name <file.zip>] [-IncludeData]

  注意：本文件必须以 UTF-8 BOM 保存（PowerShell 5.1 在无 BOM 时会按系统代码页
  解析，中文系统为 GBK，会把中文误读成乱码甚至解析失败）。build/install 流程
  需要确保 BOM 存在。
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}

try { $Host.UI.RawUI.WindowTitle = '境途WEB 统一运维工具' } catch {}

# -------- 颜色 --------
$Cfg = [pscustomobject]@{
    C_Title = 'Cyan'; C_Ok = 'Green'; C_Fail = 'Red'
    C_Warn  = 'Yellow'; C_Dim = 'DarkGray'; C_Info = 'White'; C_Menu = 'White'
}

# 抑制自动打开浏览器：脚本/CI 调用 jingtu.bat start 时不希望弹出浏览器窗口时，
# 可设置环境变量 JINGTU_NO_OPEN=1（或 true）。交互菜单场景下默认仍会自动打开。
$NoBrowser = ($env:JINGTU_NO_OPEN -eq '1' -or $env:JINGTU_NO_OPEN -eq 'true')

# 按脚本名兜底强杀 node 进程（端口可能被无关进程短暂占用、
# 或 node 已退出但端口未释放时，作为端口杀死的可靠补充）。返回杀死的数量。
function Stop-NodeByScript([string]$pattern) {
    $n = 0
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.CommandLine -and $_.CommandLine -match $pattern) {
                try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ } catch {}
            }
        }
    } catch {}
    return $n
}

function Write-Line([string]$text, [string]$color = 'White') {
    if ($color -and $color -ne 'White') { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

function Banner {
    Clear-Host
    Write-Host ''
    Write-Line '============================================================' $Cfg.C_Title
    Write-Line '              境途WEB 统一运维工具' $Cfg.C_Title
    Write-Line '         Jingtu WEB Ops Tool   .   PowerShell Edition' $Cfg.C_Title
    Write-Line '============================================================' $Cfg.C_Title
    Write-Host ''
}

# ---------- 基础配置（全部基于脚本自身路径，绝不写死硬盘） ----------
$Root        = Split-Path -Parent $MyInvocation.MyCommand.Path
$SiteDir     = Join-Path $Root 'server'
$SiteScript  = Join-Path $SiteDir 'server.js'
$PanelJs     = Join-Path $Root  'panel\panel-server.js'
$PanelDir    = Join-Path $Root  'panel'
$LogDir      = Join-Path $Root  'logs'
$ToolConfig  = Join-Path $Root  'jingtu.config.json'
$SitePort    = 3456
$PanelPort   = 3457
$MysqlPort   = 3306
$NginxPort   = 80
$SiteTitle   = '境途WEB网站'
$PanelTitle  = '境途WEB面板'

if (-not (Test-Path $LogDir)) { [void](New-Item -ItemType Directory -Path $LogDir -Force) }

# ---------- 工具自身配置加载（jingtu.config.json + 环境变量覆盖） ----------
function Load-ToolConfig {
    $defaults = [pscustomobject]@{
        mysql = [pscustomobject]@{ enabled = $true;  bin = $null; conf = $null; waitSeconds = 30 }
        nginx = [pscustomobject]@{ enabled = $false; bin = $null; conf = $null }
    }
    if (Test-Path $ToolConfig) {
        try {
            $raw = Get-Content -Raw -Path $ToolConfig -Encoding UTF8 | ConvertFrom-Json
            if ($raw.mysql) {
                if ($null -ne $raw.mysql.enabled) { $defaults.mysql.enabled = [bool]$raw.mysql.enabled }
                if ($raw.mysql.bin)  { $defaults.mysql.bin  = [string]$raw.mysql.bin }
                if ($raw.mysql.conf) { $defaults.mysql.conf = [string]$raw.mysql.conf }
                if ($raw.mysql.waitSeconds) { $defaults.mysql.waitSeconds = [int]$raw.mysql.waitSeconds }
            }
            if ($raw.nginx) {
                if ($null -ne $raw.nginx.enabled) { $defaults.nginx.enabled = [bool]$raw.nginx.enabled }
                if ($raw.nginx.bin)  { $defaults.nginx.bin  = [string]$raw.nginx.bin }
                if ($raw.nginx.conf) { $defaults.nginx.conf = [string]$raw.nginx.conf }
            }
        } catch {
            Write-Line '[警告] jingtu.config.json 解析失败，使用默认配置。' $Cfg.C_Warn
        }
    }
    # 环境变量覆盖
    if ($env:JINGTU_MYSQL_BIN)  { $defaults.mysql.bin  = $env:JINGTU_MYSQL_BIN }
    if ($env:JINGTU_MYSQL_CONF) { $defaults.mysql.conf = $env:JINGTU_MYSQL_CONF }
    if ($env:JINGTU_NGINX_BIN)  { $defaults.nginx.bin  = $env:JINGTU_NGINX_BIN }
    if ($env:JINGTU_NGINX_CONF) { $defaults.nginx.conf = $env:JINGTU_NGINX_CONF }
    return $defaults
}

# 探测 phpStudy 默认路径（任何电脑只要把 phpStudy 装在以下常见位置就能找到）
function Resolve-MySql {
    $cfg = Load-ToolConfig
    $bin  = $cfg.mysql.bin
    $conf = $cfg.mysql.conf
    if ($bin -and (Test-Path $bin))  { return [pscustomobject]@{ Bin = $bin; Conf = $conf; Enabled = $cfg.mysql.enabled; WaitSeconds = $cfg.mysql.waitSeconds } }
    # 探测顺序：D:\phpstudy_pro → C:\phpstudy_pro → E:\phpstudy_pro → 自定义
    $candidates = @(
        'D:\phpstudy_pro',
        'C:\phpstudy_pro',
        'E:\phpstudy_pro',
        'D:\BtSoft',
        'D:\phpStudy',
        (Join-Path $env:USERPROFILE 'phpstudy_pro')
    )
    foreach ($base in $candidates) {
        if (-not (Test-Path $base)) { continue }
        $bins = Get-ChildItem -Path $base -Recurse -Filter 'mysqld.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($bins) {
            $bin = $bins.FullName
            # 寻找 my.ini（一般在 MySQL* 根目录或 bin 旁）
            $ini = Get-ChildItem -Path (Split-Path $bin) -Filter 'my.ini' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $ini) { $ini = Get-ChildItem -Path (Split-Path (Split-Path $bin)) -Filter 'my.ini' -ErrorAction SilentlyContinue | Select-Object -First 1 }
            if ($ini -and -not $conf) { $conf = $ini.FullName }
            return [pscustomobject]@{ Bin = $bin; Conf = $conf; Enabled = $cfg.mysql.enabled; WaitSeconds = $cfg.mysql.waitSeconds }
        }
    }
    return [pscustomobject]@{ Bin = $null; Conf = $null; Enabled = $cfg.mysql.enabled; WaitSeconds = $cfg.mysql.waitSeconds }
}

function Resolve-Nginx {
    $cfg = Load-ToolConfig
    $bin  = $cfg.nginx.bin
    $conf = $cfg.nginx.conf
    if ($bin -and (Test-Path $bin)) { return [pscustomobject]@{ Bin = $bin; Conf = $conf; Enabled = $cfg.nginx.enabled } }
    $candidates = @('D:\phpstudy_pro','C:\phpstudy_pro','E:\phpstudy_pro','D:\BtSoft','D:\phpStudy')
    foreach ($base in $candidates) {
        if (-not (Test-Path $base)) { continue }
        $bins = Get-ChildItem -Path $base -Recurse -Filter 'nginx.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($bins) {
            $bin = $bins.FullName
            $ng = Get-ChildItem -Path (Split-Path $bin) -Filter 'nginx.conf' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($ng -and -not $conf) { $conf = $ng.FullName }
            return [pscustomobject]@{ Bin = $bin; Conf = $conf; Enabled = $cfg.nginx.enabled }
        }
    }
    return [pscustomobject]@{ Bin = $null; Conf = $null; Enabled = $cfg.nginx.enabled }
}

# ---------- 端口/进程工具 ----------
function Test-Port([int]$port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(500, $false)
        if (-not $ok) { try { $c.Close() } catch {}; return $null }
        $c.EndConnect($iar); $c.Close()
        $lines = netstat -ano 2>$null
        foreach ($ln in $lines) {
            $s = (' ' + $ln + ' ')
            if ($s -match ('\s127\.0\.0\.1:' + $port + '\s.*LISTENING\s+(\d+)\s*$')) {
                $id = 0
                if ([int]::TryParse($matches[1], [ref]$id)) { return $id }
            }
            if ($s -match ('\s0\.0\.0\.0:' + $port + '\s.*LISTENING\s+(\d+)\s*$')) {
                $id = 0
                if ([int]::TryParse($matches[1], [ref]$id)) { return $id }
            }
            # IPv6 监听（如 [::]:80 / [::]:3306）：netstat 显示为 [::]:<port>
            if ($s -match ('\s\[::\]:' + $port + '\s.*LISTENING\s+(\d+)\s*$')) {
                $id = 0
                if ([int]::TryParse($matches[1], [ref]$id)) { return $id }
            }
        }
    } catch {}
    return $null
}

function Test-Http([int]$port) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($r -and $r.StatusCode) { return "HTTP $($r.StatusCode)" }
    } catch {}
    return 'TCP 端口可达'
}

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        'C:\Program Files\nodejs\node.exe',
        'C:\Program Files (x86)\nodejs\node.exe',
        (Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe'),
        'D:\ServBay\bin\node.exe'
    )
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

function Assert-Node {
    $n = Get-NodePath
    if (-not $n) {
        Write-Host ''
        Write-Line '[错误] 未检测到 node.exe，请先安装 Node.js 并加入 PATH。' $Cfg.C_Fail
        Write-Host ''
        return $false
    }
    Write-Line ('[信息] 使用 Node: ' + $n) $Cfg.C_Dim
    return $true
}

# ---------- MySQL 启停 ----------
# 优先用 Windows 服务名启动 MySQL：phpStudy 的 MySQL 通常以服务形式安装，
# 直接拉 mysqld.exe（缺配置/数据目录）往往起不来。探测常见服务名，命中即用 net start。
function Resolve-MySqlService {
    $candidates = @('MySQL5.7', 'MySQL57', 'MySQL5.7.26', 'MySQL', 'MySQL80', 'MariaDB')
    foreach ($name in $candidates) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc) { return $svc.Name }
    }
    return $null
}

function Start-MySql {
    if ($null -ne (Test-Port $MysqlPort)) {
        Write-Line "[提示] MySQL 已在运行。" $Cfg.C_Warn
        return $true
    }
    # 优先：Windows 服务拉起（最稳）
    $svcName = Resolve-MySqlService
    if ($svcName) {
        try {
            $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
            if ($s -and $s.Status -ne 'Running') {
                Write-Line ("[信息] 通过服务启动 MySQL: " + $svcName) $Cfg.C_Dim
                net start $svcName 2>$null | Out-Null
                Start-Sleep -Seconds 2
            }
            if ($null -ne (Test-Port $MysqlPort)) {
                Write-Line ("[成功] MySQL 已启动（服务 " + $svcName + "）") $Cfg.C_Ok
                return $true
            }
        } catch {}
    }
    # 兜底：直接拉 mysqld.exe（需在 jingtu.config.json 配置 mysql.bin）
    $info = Resolve-MySql
    if (-not $info.Bin) {
        Write-Line '[错误] 找不到 mysqld.exe，且未检测到 MySQL 服务。请在 jingtu.config.json 配置 mysql.bin，或把 phpStudy 装到 D:\phpstudy_pro。' $Cfg.C_Fail
        return $false
    }
    Write-Line ('[信息] 启动 MySQL: ' + $info.Bin) $Cfg.C_Dim
    $launchArgs = @()
    if ($info.Conf) { $launchArgs += @('--defaults-file=' + $info.Conf) }
    $outLog = Join-Path $LogDir 'mysqld.log'
    $errLog = Join-Path $LogDir 'mysqld.err'
    Start-Process -FilePath $info.Bin -ArgumentList $launchArgs -WorkingDirectory (Split-Path $info.Bin) `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $wait = 0
    while ($null -eq (Test-Port $MysqlPort) -and $wait -lt $info.WaitSeconds) {
        Start-Sleep -Seconds 1; $wait++
    }
    if ($null -ne (Test-Port $MysqlPort)) {
        Write-Line "[成功] MySQL 已启动（端口 $MysqlPort，耗时 ${wait}s）" $Cfg.C_Ok
        return $true
    } else {
        Write-Line "[失败] MySQL ${wait}s 内未起来，请查看 logs\mysqld.err" $Cfg.C_Fail
        return $false
    }
}

function Stop-MySql {
    $portPid = Test-Port $MysqlPort
    if ($null -eq $portPid) { Write-Line '[提示] MySQL 未在运行' $Cfg.C_Warn; return }
    # 优先用 Windows 服务关停（与启动对称，最稳）
    $svcName = Resolve-MySqlService
    if ($svcName) {
        try {
            $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
            if ($s -and $s.Status -eq 'Running') {
                Write-Line ("[信息] 通过服务停止 MySQL: " + $svcName) $Cfg.C_Dim
                net stop $svcName 2>$null | Out-Null
                Start-Sleep -Seconds 2
                if ($null -eq (Test-Port $MysqlPort)) { Write-Line '[完成] MySQL 已停止' $Cfg.C_Ok; return }
            }
        } catch {}
    }
    $info = Resolve-MySql
    # 优先用 mysqladmin 优雅关停；root 可能设了密码，依次尝试「无密码」与「配置/环境变量密码」。
    $admin = $null
    if ($info.Bin) { $admin = Join-Path (Split-Path $info.Bin) 'mysqladmin.exe' }
    $used = $false
    if ($admin -and (Test-Path $admin)) {
        $cfg = Load-ToolConfig
        $pw = if ($cfg.mysql.password) { $cfg.mysql.password } else { $env:JINGTU_MYSQL_PWD }
        $argLists = @( @('-h','127.0.0.1','-P','3306','-u','root','shutdown') )
        if ($pw) { $argLists += @('-h','127.0.0.1','-P','3306','-u','root',('-p' + $pw),'shutdown') }
        foreach ($al in $argLists) {
            $tmpErr = Join-Path $env:TEMP ('mysqladmin_' + [guid]::NewGuid().ToString('N') + '.err')
            try {
                $p = Start-Process -FilePath $admin -ArgumentList $al -Wait -WindowStyle Hidden -RedirectStandardError $tmpErr -PassThru -ErrorAction Stop
                if ($p -and $p.ExitCode -eq 0) { $used = $true; break }
            } catch {}
            Remove-Item $tmpErr -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not $used) {
        try { Stop-Process -Id $portPid -Force -ErrorAction Stop; $used = $true } catch {}
    }
    # 等端口释放
    $wait = 0
    while ($null -ne (Test-Port $MysqlPort) -and $wait -lt 15) { Start-Sleep -Seconds 1; $wait++ }
    if ($null -eq (Test-Port $MysqlPort)) { Write-Line "[完成] MySQL 已停止" $Cfg.C_Ok }
    else { Write-Line "[失败] MySQL 未能停止" $Cfg.C_Fail }
}

function Ensure-MySql {
    if ($null -ne (Test-Port $MysqlPort)) { return $true }
    $info = Resolve-MySql
    if (-not $info.Enabled) { return $true }
    Write-Line '[依赖] 检测到 MySQL 未启动，正在自动拉起...' $Cfg.C_Warn
    return (Start-MySql)
}

# ---------- Nginx 启停 ----------
function Start-Nginx {
    $info = Resolve-Nginx
    if (-not $info.Bin) {
        Write-Line '[错误] 找不到 nginx.exe。请在 jingtu.config.json 中配置 nginx.bin。' $Cfg.C_Fail
        return $false
    }
    if ($null -ne (Test-Port $NginxPort)) { Write-Line "[提示] Nginx 已在运行。" $Cfg.C_Warn; return $true }
    # 必须用绝对 -c，避免工作目录不同导致相对路径解析到错误位置（如 D:\...\jingtu-web/conf/nginx.conf）。
    $launchArgs = @()
    $conf = $info.Conf
    if (-not $conf) {
        # 自动探测 nginx 自带的 conf/nginx.conf（绝对路径），回退到 nginx 内置默认
        $auto = Get-ChildItem -Path (Split-Path $info.Bin) -Filter 'nginx.conf' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($auto) { $conf = $auto.FullName }
    }
    if ($conf) { $launchArgs += @('-c', $conf) }
    $outLog = Join-Path $LogDir 'nginx.out'
    $errLog = Join-Path $LogDir 'nginx.err'
    Write-Line ('[信息] 启动 Nginx: ' + $info.Bin + ($(if ($conf) { '  -c ' + $conf } else { '' }))) $Cfg.C_Dim
    $spParams = @{ FilePath = $info.Bin; WorkingDirectory = (Split-Path $info.Bin); WindowStyle = 'Hidden'; RedirectStandardOutput = $outLog; RedirectStandardError = $errLog }
    if ($launchArgs.Count -gt 0) { $spParams['ArgumentList'] = $launchArgs }
    Start-Process @spParams
    $wait = 0
    while ($null -eq (Test-Port $NginxPort) -and $wait -lt 10) { Start-Sleep -Seconds 1; $wait++ }
    if ($null -ne (Test-Port $NginxPort)) { Write-Line "[成功] Nginx 已启动（端口 $NginxPort）" $Cfg.C_Ok; return $true }
    else { Write-Line "[失败] Nginx 未起来，请查看 logs\nginx.err" $Cfg.C_Fail; return $false }
}

function Stop-Nginx {
    $info = Resolve-Nginx
    if (-not $info.Bin) { Write-Line '[提示] 未配置 nginx，跳过' $Cfg.C_Warn; return }
    if ($null -eq (Test-Port $NginxPort)) { Write-Line '[提示] Nginx 未在运行' $Cfg.C_Warn; return }
    # 先尝试优雅 stop（用与启动一致的 -c）；若失败（如 pid 文件缺失/路径错），回落到按端口强杀。
    $stopArgs = @('-s', 'stop')
    if ($info.Conf) { $stopArgs = @('-c', $info.Conf, '-s', 'stop') }
    try { Start-Process -FilePath $info.Bin -ArgumentList $stopArgs -Wait -NoNewWindow -ErrorAction SilentlyContinue | Out-Null } catch {}
    $wait = 0
    while ($null -ne (Test-Port $NginxPort) -and $wait -lt 6) { Start-Sleep -Seconds 1; $wait++ }
    # 兜底：直接杀掉监听 80 端口的进程（兼容被错误 -c 启动、pid 文件失效的情况）
    $nginxPid = Test-Port $NginxPort
    if ($nginxPid) {
        try {
            Get-Process -Id $nginxPid -ErrorAction Stop | Stop-Process -Force -ErrorAction Stop
            # nginx 主进程退出后，可能留下 worker 子进程仍占用 80 端口，一并清理
            Get-Process -Name 'nginx' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        } catch {}
        $wait = 0
        while ($null -ne (Test-Port $NginxPort) -and $wait -lt 6) { Start-Sleep -Seconds 1; $wait++ }
    }
    if ($null -eq (Test-Port $NginxPort)) { Write-Line '[完成] Nginx 已停止' $Cfg.C_Ok }
    else { Write-Line '[失败] Nginx 未能停止（端口仍被占用，可能被其它程序占用 80）' $Cfg.C_Fail }
}

function Ensure-Nginx {
    $info = Resolve-Nginx
    if (-not $info.Enabled) { return $true }
    if ($null -ne (Test-Port $NginxPort)) { return $true }
    Write-Line '[依赖] 检测到 Nginx 未启动且已启用自动启动，正在拉起...' $Cfg.C_Warn
    return (Start-Nginx)
}

# ---------- 状态显示 ----------
function Show-Status {
    $rows = @(
        @{ Name = '网站主站'; Port = $SitePort   },
        @{ Name = '运维面板'; Port = $PanelPort  },
        @{ Name = 'MySQL';    Port = $MysqlPort  },
        @{ Name = 'Nginx';    Port = $NginxPort  }
    )
    Write-Line '  服务名称           端口     进程状态                HTTP 探测' $Cfg.C_Dim
    Write-Line '  --------------------------------------------------------------' $Cfg.C_Dim
    foreach ($r in $rows) {
        $procId = Test-Port $r.Port
        if ($null -ne $procId) {
            $http = Test-Http $r.Port
            $color = if ($http -like 'HTTP 2*' -or $http -like 'HTTP 3*') { $Cfg.C_Ok } elseif ($http -like 'HTTP 5*') { $Cfg.C_Warn } else { $Cfg.C_Info }
            Write-Line ('  {0,-10}     {1,-7}  运行中  PID:{2,-7}  {3}' -f $r.Name, $r.Port, $procId, $http) $color
        } else {
            Write-Line ('  {0,-10}     {1,-7}  已停止' -f $r.Name, $r.Port) $Cfg.C_Dim
        }
    }
    Write-Line '  --------------------------------------------------------------' $Cfg.C_Dim
    # 路径提示
    $mi = Resolve-MySql
    $ng = Resolve-Nginx
    if ($mi.Bin)  { Write-Line ('  [依赖] MySQL: ' + $mi.Bin)  $Cfg.C_Dim } else { Write-Line '  [依赖] MySQL: 未配置（需在 jingtu.config.json 设置 mysql.bin）' $Cfg.C_Warn }
    if ($ng.Bin)  { Write-Line ('  [依赖] Nginx: ' + $ng.Bin + '  (autoStart=' + $ng.Enabled + ')') $Cfg.C_Dim } else { Write-Line '  [依赖] Nginx: 未配置' $Cfg.C_Dim }
    Write-Host ''
}

# ---------- 网站/面板启停 ----------
function Start-Site {
    if (-not (Assert-Node)) { return }
    if (-not (Test-Path $SiteScript)) { Write-Line '[错误] 找不到 server\server.js' $Cfg.C_Fail; return }
    # 自动确保依赖（最关键）：MySQL（数据库） + Nginx（80 前门，代理回源 Node 3456）。
    # 注意：无论网站进程是否已运行，都必须先保证后端依赖在线，否则会出现
    # "Node 活着但 Nginx 挂了 → 80 端口进不来" 的假活状态。
    if (-not (Ensure-MySql)) { Write-Line '[错误] MySQL 拉起失败，无法启动网站（业务依赖数据库）' $Cfg.C_Fail; return }
    if (-not (Ensure-Nginx)) {
        Write-Line '[警告] Nginx 未能启动，网站将只能通过 http://localhost:3456 直接访问（80 入口不可用）' $Cfg.C_Warn
    }
    if ($null -ne (Test-Port $SitePort)) {
        $url = Get-SiteUrl
        Write-Line ("[提示] 网站已在运行 PID:" + (Test-Port $SitePort) + "  " + $url) $Cfg.C_Warn
        if (-not $NoBrowser) { try { Start-Process $url | Out-Null } catch {} }
        return
    }
    Write-Line '正在启动网站...' $Cfg.C_Info
    $node = Get-NodePath
    Start-Process -FilePath $node -ArgumentList @($SiteScript) -WorkingDirectory $SiteDir `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'site.log') `
        -RedirectStandardError  (Join-Path $LogDir 'site.err')
    $wait = 0
    while ($null -eq (Test-Port $SitePort) -and $wait -lt 15) { Start-Sleep -Seconds 1; $wait++ }
    $procId = Test-Port $SitePort
    if ($null -ne $procId) {
        $url = Get-SiteUrl
        Write-Line "[成功] 网站已启动 PID:$procId  $url" $Cfg.C_Ok
        if (-not $NoBrowser) { try { Start-Process $url | Out-Null } catch {} }
    } else {
        Write-Line "[失败] 15秒内端口未监听，请查看 logs\site.log 与 logs\site.err" $Cfg.C_Fail
    }
}

function Stop-Site {
    $procId = Test-Port $SitePort
    $killed = $false
    if ($null -ne $procId) { try { Stop-Process -Id $procId -Force -ErrorAction Stop; $killed = $true } catch {} }
    try { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $SiteTitle } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $killed = $true } } catch {}
    # 兜底：按脚本名强杀 node（端口被无关进程占用、或 node 已退出但端口未释放时确保停止）
    $killed = $killed -or (Stop-NodeByScript 'server[\\/]server\.js')
    if ($killed) { Write-Line '[完成] 网站已停止' $Cfg.C_Ok } else { Write-Line '[提示] 网站未在运行' $Cfg.C_Warn }
}

function Restart-Site { Stop-Site; Start-Sleep -Seconds 1; Start-Site }

function Start-Panel {
    if (-not (Assert-Node)) { return }
    if (-not (Test-Path $PanelJs)) { Write-Line '[错误] 找不到 panel\panel-server.js' $Cfg.C_Fail; return }
    if ($null -ne (Test-Port $PanelPort)) {
        $panelPid = Test-Port $PanelPort
        Write-Line ("[提示] 面板已在运行 PID:" + $panelPid + "  http://localhost:" + $PanelPort) $Cfg.C_Warn
        if (-not $NoBrowser) { try { Start-Process "http://localhost:$PanelPort" | Out-Null } catch {} }
        return
    }
    if (-not (Ensure-MySql)) { Write-Line '[警告] MySQL 未启动，面板里"启动网站"会失败；继续启动面板...' $Cfg.C_Warn }
    Write-Line '正在启动运维面板...' $Cfg.C_Info
    $node = Get-NodePath
    Start-Process -FilePath $node -ArgumentList @($PanelJs) -WorkingDirectory $PanelDir `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'panel.log') `
        -RedirectStandardError  (Join-Path $LogDir 'panel.err')
    $wait = 0
    while ($null -eq (Test-Port $PanelPort) -and $wait -lt 8) { Start-Sleep -Seconds 1; $wait++ }
    $procId = Test-Port $PanelPort
    if ($null -ne $procId) {
        Write-Line "[成功] 面板已启动 PID:$procId  http://localhost:$PanelPort" $Cfg.C_Ok
        if (-not $NoBrowser) { try { Start-Process "http://localhost:$PanelPort" | Out-Null } catch {} }
    } else {
        Write-Line "[失败] 8秒内端口未监听，请查看 logs\panel.log" $Cfg.C_Fail
    }
}

function Stop-Panel {
    $procId = Test-Port $PanelPort
    $killed = $false
    if ($null -ne $procId) { try { Stop-Process -Id $procId -Force -ErrorAction Stop; $killed = $true } catch {} }
    try { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $PanelTitle } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $killed = $true } } catch {}
    # 兜底：按脚本名强杀 node（同上）
    $killed = $killed -or (Stop-NodeByScript 'panel[\\/]panel-server\.js')
    if ($killed) { Write-Line '[完成] 面板已停止' $Cfg.C_Ok } else { Write-Line '[提示] 面板未在运行' $Cfg.C_Warn }
}

function Restart-Panel { Stop-Panel; Start-Sleep -Seconds 1; Start-Panel }

function Get-SiteUrl {
    # 优先返回 80（Nginx 前门），否则回退到 Node 直连端口
    if ($null -ne (Test-Port $NginxPort)) { return "http://localhost:$NginxPort" }
    if ($null -ne (Test-Port $SitePort))  { return "http://localhost:$SitePort" }
    return "http://localhost:$SitePort"
}

function Open-Site {
    $url = Get-SiteUrl
    try { Start-Process $url | Out-Null; Write-Line ("[提示] 已尝试打开 " + $url) $Cfg.C_Info } catch {
        Write-Line '[失败] 无法打开浏览器' $Cfg.C_Fail
    }
}

function Open-LogsDir {
    try { Start-Process explorer.exe $LogDir | Out-Null } catch {
        Write-Line '[失败] 无法打开日志目录' $Cfg.C_Fail
    }
}

# 清理"默认标题的 cmd.exe"（其它软件漏出来的刷屏窗口）。
# 规则：必须不是本控制台、必须不是管理员窗口、必须不是 IDE / VSCode / phpStudy 等已知父进程
function Clean-StrayCmdWindows {
    $thisPid  = $PID
    $killed   = 0
    $skipped  = 0
    $procs = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"
    foreach ($p in $procs) {
        if ($p.ProcessId -eq $thisPid) { $skipped++; continue }
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
        $parentName = if ($parent) { $parent.Name } else { '' }
        $safeParents = @('explorer.exe','Code.exe','code.exe','WindowsTerminal.exe','wt.exe','conhost.exe','powershell.exe','pwsh.exe','bash.exe')
        if ($safeParents -contains $parentName) { $skipped++; continue }
        $cl = $p.CommandLine
        if ($cl -and ($cl -match 'npx|cos-mcp|mcp-server|cnb-mcp|cloudbase-mcp|panel-server|jingtu')) { $skipped++; continue }
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { $skipped++ }
    }
    Write-Line ('[清理] 已关闭 {0} 个 cmd 窗口，跳过 {1} 个（受保护）' -f $killed, $skipped) $Cfg.C_Ok
}

# ============================================================
# 网站导出打包（与 jingtu.sh 功能等价，仅 Windows 侧实现）
# ============================================================
function Copy-Robocopy {
    param(
        [string]$src,
        [string]$dst,
        [string[]]$ExcludeDir = @(),
        [string[]]$ExcludeFile = @()
    )
    if (-not (Test-Path $src)) { return }
    New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
    $a = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP', '/R:1', '/W:1')
    foreach ($d in $ExcludeDir) { $a += @('/XD', $d) }
    foreach ($f in $ExcludeFile) { $a += @('/XF', $f) }
    & robocopy @a | Out-Null
    return ($LASTEXITCODE -lt 8)
}

function Write-Step([string]$msg) {
    Write-Host ('  [导出] ' + $msg) -ForegroundColor Cyan
}

function Export-Site {
    [CmdletBinding()]
    param(
        # 默认输出到项目根的上一级目录（即与 jingtu-web 平级），不再写死某块硬盘
        [string]$OutDir = (Split-Path $Root -Parent),
        [string]$Name = '',
        [switch]$IncludeData,
        [switch]$Force
    )

    $ErrorActionPreference = 'Stop'

    if (-not $Name) {
        $Name = 'jingtu-web-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'
    }
    $outFile = Join-Path $OutDir $Name
    $staging = Join-Path $env:TEMP ('jingtu-export-' + [guid]::NewGuid().ToString('N'))

    # 同名文件覆盖确认（仅交互式菜单调用；命令行 export 默认传 -Force 保持原行为）
    if (-not $Force -and (Test-Path $outFile)) {
        Write-Host ''
        Write-Host ("[确认] 文件已存在: $outFile") -ForegroundColor Yellow
        $yn = (Read-Host '  是否覆盖 [Y/N] 默认=N').Trim()
        if ($yn -ne 'Y' -and $yn -ne 'y') {
            Write-Host '[取消] 已跳过导出。' -ForegroundColor Cyan
            return
        }
    }

    Write-Host ''
    Write-Host '========================================' -ForegroundColor Yellow
    Write-Host '  境途WEB 网站导出打包工具' -ForegroundColor Yellow
    Write-Host '========================================' -ForegroundColor Yellow
    Write-Host ('  项目根: ' + $Root)
    Write-Host ('  输出到: ' + $outFile)
    if ($IncludeData) { Write-Host '  包含用户数据: 是 (相册/头像/上传)' }
    else { Write-Host '  包含用户数据: 否' }
    Write-Host ''

    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    Write-Step '复制 server 后端代码...'
    Copy-Robocopy (Join-Path $Root 'server') (Join-Path $staging 'server') @('node_modules', 'coverage', '__tests__', 'test', 'logs') @('*.log', 'session.json', '_*.js', '_*.php', '_*.ps1', 'out.log')

    Write-Step '复制 public 前端资源...'
    Copy-Robocopy (Join-Path $Root 'public') (Join-Path $staging 'public') @('ai-scratch') @()

    Write-Step '复制 assets 媒体资源...'
    if ($IncludeData) {
        Copy-Robocopy (Join-Path $Root 'assets') (Join-Path $staging 'assets') @() @()
    } else {
        Copy-Robocopy (Join-Path $Root 'assets') (Join-Path $staging 'assets') @('album', 'avatar-cache') @()
    }

    Write-Step '复制 docs / deploy / tools...'
    Copy-Robocopy (Join-Path $Root 'docs') (Join-Path $staging 'docs') @() @()
    Copy-Robocopy (Join-Path $Root 'deploy') (Join-Path $staging 'deploy') @() @()
    Copy-Robocopy (Join-Path $Root 'tools') (Join-Path $staging 'tools') @() @('_*.py', '_*.js', '_*.png', '_*.md')

    if ($IncludeData) {
        Write-Step '复制 uploads 上传文件...'
        Copy-Robocopy (Join-Path $Root 'uploads') (Join-Path $staging 'uploads') @() @()
    }

    Write-Step '复制根目录配置文件...'
    $rootFiles = @(
        '.env.example', '.gitignore', '.dockerignore', '.htaccess',
        'DEPLOY.md', 'Dockerfile', 'docker-compose.yml', 'docker-entrypoint.sh',
        'docker.env.example', 'ecosystem.config.js', 'install.sh',
        'panel-config.json', 'jingtu.bat', 'jingtu.ps1', 'jingtu.sh', 'jingtu.config.json', 'start-services.sh'
    )
    foreach ($f in $rootFiles) {
        $srcFile = Join-Path $Root $f
        if (Test-Path $srcFile) { Copy-Item -Path $srcFile -Destination (Join-Path $staging $f) -Force }
    }

    Write-Step '创建压缩包...'
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    if (Test-Path $outFile) { Remove-Item $outFile -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $outFile -CompressionLevel Optimal

    $staged = Get-ChildItem $staging -Recurse -File
    $pkgSize = (Get-Item $outFile).Length / 1MB
    Remove-Item $staging -Recurse -Force

    Write-Host ''
    Write-Host '========================================' -ForegroundColor Green
    Write-Host '  导出完成' -ForegroundColor Green
    Write-Host ('  文件数: ' + $staged.Count)
    Write-Host ('  包大小: ' + [math]::Round($pkgSize, 2) + ' MB')
    Write-Host ('  位置:   ' + $outFile)
    Write-Host '========================================' -ForegroundColor Green
    Write-Host ''
}

# ---------- 交互菜单 ----------
function Show-Menu {
    Banner
    Write-Line '  当前服务状态：' $Cfg.C_Info
    Show-Status
    Write-Line '  快捷操作：' $Cfg.C_Title
    Write-Line '    [1] 启动网站       [2] 停止网站       [3] 重启网站' $Cfg.C_Menu
    Write-Line '    [4] 启动运维面板   [5] 停止运维面板   [6] 打开网站' $Cfg.C_Menu
    Write-Line '    [7] 重启运维面板   [8] 全部启动       [9] 全部停止' $Cfg.C_Menu
    Write-Line '    [M] 启动 MySQL     [N] 停止 MySQL     [G] 启动 Nginx' $Cfg.C_Menu
    Write-Line '    [H] 停止 Nginx     [E] 导出网站包     [O] 打开日志目录' $Cfg.C_Menu
    Write-Line '    [R] 刷新状态       [K] 清理卡死 cmd                          [0] 退出' $Cfg.C_Menu
    Write-Host ''
}

function Clear-InputBuffer {
    # 清空键盘输入缓冲区，防止上一操作残留的按键被下一次 Read-Host 误读
    try {
        while ($Host.UI.RawUI.KeyAvailable) {
            $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
        }
    } catch {}
}

function Menu-Loop {
    while ($true) {
        Clear-InputBuffer
        Show-Menu
        $sel = (Read-Host '请选择').Trim()
        switch ($sel) {
            '1' { Start-Site;  Pause; }
            '2' { Stop-Site; Stop-Panel; Stop-Nginx; Stop-MySql; Pause; }
            '3' { Restart-Site;Pause; }
            '4' { Start-Panel; Pause; }
            '5' { Stop-Panel;  Pause; }
            '6' { Open-Site;   Pause; }
            '7' { Restart-Panel;Pause; }
            '8' { Start-MySql; if (-not (Ensure-Nginx)) { Write-Line '[警告] Nginx 未能启动，网站将只能通过 http://localhost:3456 直接访问' $Cfg.C_Warn }; Start-Site; Start-Panel; Pause; }
            '9' { Stop-Site; Stop-Panel; Stop-Nginx; Stop-MySql; Pause; }
            'M' { Start-MySql; Pause; }
            'm' { Start-MySql; Pause; }
            'N' { Stop-MySql;  Pause; }
            'n' { Stop-MySql;  Pause; }
            'G' { Start-Nginx; Pause; }
            'g' { Start-Nginx; Pause; }
            'H' { Stop-Nginx;  Pause; }
            'h' { Stop-Nginx;  Pause; }
            'E' { Export-Site; Read-Host '  按 Enter 返回主菜单...' | Out-Null }
            'e' { Export-Site; Read-Host '  按 Enter 返回主菜单...' | Out-Null }
            'O' { Open-LogsDir; Pause; }
            'o' { Open-LogsDir; Pause; }
            'K' { Clean-StrayCmdWindows; Pause; }
            'k' { Clean-StrayCmdWindows; Pause; }
            'R' { }
            'r' { }
            '0' { Write-Line '再见。' $Cfg.C_Title; return }
            default { Write-Line '输入无效，请重新输入' $Cfg.C_Warn; Start-Sleep -Seconds 1 }
        }
    }
}

# ---------- 环境修复（关键健壮性修复）----------
# 宿主 PowerShell 环境块里有时会出现大小写重复的变量（如 Path / PATH / path），
# 会导致 Start-Process 在使用 -RedirectStandard* 时构建子进程环境字典抛异常：
#   “已添加项。字典中的关键字:"Path" 所添加的关键字:"PATH"”
# 此函数在脚本启动早期把这类重复键归一为一个干净条目，确保后续 Start-Process 正常。
function Repair-Environment {
    try {
        # 用已合并（大小写不敏感）的环境变量名枚举；env: 提供程序在存在重复大小写键时会本身抛异常，故不可直接用。
        foreach ($k in [System.Environment]::GetEnvironmentVariables().Keys) {
            try {
                $v = [System.Environment]::GetEnvironmentVariable($k, 'Process')
                if ($null -ne $v) {
                    $guard = 0
                    while ($null -ne [System.Environment]::GetEnvironmentVariable($k, 'Process')) {
                        [System.Environment]::SetEnvironmentVariable($k, $null, 'Process')
                        $guard++; if ($guard -ge 32) { break }
                    }
                    [System.Environment]::SetEnvironmentVariable($k, $v, 'Process')
                }
            } catch {}
        }
    } catch {}
}

# ---------- 入口：解析参数 ----------
Repair-Environment
if ($args.Count -eq 0) {
    Menu-Loop
    exit 0
}

$cmd = $args[0].ToLower()

# export 子命令：把剩余参数解析成命名参数后调用 Export-Site
if ($cmd -eq 'export' -or $cmd -eq 'exp') {
    $exportArgs = @{}
    for ($i = 1; $i -lt $args.Count; $i++) {
        switch ($args[$i]) {
            { $_ -in '-OutDir','-outdir' } { $exportArgs['OutDir'] = $args[++$i] }
            { $_ -in '-Name','-name' }     { $exportArgs['Name'] = $args[++$i] }
            { $_ -in '-IncludeData','-includedata' } { $exportArgs['IncludeData'] = $true }
            '-h' { $exportArgs['_help'] = $true }
            '--help' { $exportArgs['_help'] = $true }
            default { }
        }
    }
    if ($exportArgs.ContainsKey('_help')) {
        Write-Line '用法: jingtu.bat export [-OutDir <path>] [-Name <file.zip>] [-IncludeData]' $Cfg.C_Info
        exit 0
    }
    # 命令行 export 默认强制覆盖，保持非交互行为
    $exportArgs['Force'] = $true
    Export-Site @exportArgs
    exit 0
}

switch -Regex ($cmd) {
    '^start$'           { Start-Site;  exit 0 }
    '^stop$'            { Stop-Site; Stop-Panel; Stop-Nginx; Stop-MySql; exit 0 }
    '^restart$'         { Restart-Site;exit 0 }
    '^panel-start$'     { Start-Panel; exit 0 }
    '^panel-stop$'      { Stop-Panel;  exit 0 }
    '^panel-restart$'   { Restart-Panel; exit 0 }
    '^status$'          { Banner; Show-Status; exit 0 }
    '^panel-status$'    { Banner; Show-Status; exit 0 }
    '^start-all$'       { Start-MySql; if (-not (Ensure-Nginx)) { Write-Line '[警告] Nginx 未能启动，网站将只能通过 http://localhost:3456 直接访问' $Cfg.C_Warn }; Start-Site; Start-Panel; exit 0 }
    '^stop-all$'        { Stop-Site; Stop-Panel; Stop-Nginx; Stop-MySql; exit 0 }
    '^restart-all$'     { Stop-Site; Stop-Panel; Start-Sleep 2; Start-MySql; if (-not (Ensure-Nginx)) { Write-Line '[警告] Nginx 未能启动，网站将只能通过 http://localhost:3456 直接访问' $Cfg.C_Warn }; Start-Site; Start-Panel; exit 0 }
    '^mysql-start$'     { Start-MySql; exit 0 }
    '^mstart$'          { Start-MySql; exit 0 }
    '^mysql-stop$'      { Stop-MySql; exit 0 }
    '^mstop$'           { Stop-MySql; exit 0 }
    '^nginx-start$'     { Start-Nginx; exit 0 }
    '^nstart$'          { Start-Nginx; exit 0 }
    '^nginx-stop$'      { Stop-Nginx; exit 0 }
    '^nstop$'           { Stop-Nginx; exit 0 }
    '^clean$'           { Clean-StrayCmdWindows; exit 0 }
    default {
        Write-Line "未知参数：$cmd" $Cfg.C_Fail
        Write-Line '用法:' $Cfg.C_Warn
        Write-Line '  jingtu.bat                                       (菜单)' $Cfg.C_Warn
        Write-Line '  jingtu.bat [start|stop|restart|panel-start|panel-stop|panel-restart|status]' $Cfg.C_Warn
        Write-Line '  jingtu.bat [start-all|stop-all|restart-all|clean]' $Cfg.C_Warn
        Write-Line '  jingtu.bat [mysql-start|mysql-stop|nginx-start|nginx-stop]' $Cfg.C_Warn
        Write-Line '  jingtu.bat export [-OutDir <path>] [-Name <file.zip>] [-IncludeData]' $Cfg.C_Warn
        exit 1
    }
}
