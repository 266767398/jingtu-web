#Requires -Version 5.1
# 境途同游 网页版运维后台 —— PowerShell 执行层（由 panel-server.js 调用，输出单行 JSON）
param(
    [Parameter(Mandatory = $true)][string]$Action,
    [string]$Arg = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
try { Set-Location $ProjectRoot } catch {}
$BackupDir  = Join-Path $ProjectRoot "backup"
$LogsDir    = Join-Path $ProjectRoot "logs"
$AuditLog   = Join-Path $LogsDir "panel-audit.log"
$ConfigFile = Join-Path $ProjectRoot "panel-config.json"
foreach ($d in @($BackupDir, $LogsDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

function Load-Config {
    if (Test-Path $ConfigFile) { try { return Get-Content -Raw -Encoding UTF8 $ConfigFile | ConvertFrom-Json } catch {} }
    $cfg = [ordered]@{
        businessService = "NodeServer"; dataDir = "uploads"
        backupRetention = 10; configBackupRetention = 5; diskWarnGB = 1.0
        logSearchKeywords = @("ERROR", "FATAL", "Exception", "失败")
        highRiskConfirm = "CONFIRM-DELETE-ALL-DATA"; restoreConfirm = "CONFIRM-RESTORE-FROM-BACKUP"
        services = @(
            [ordered]@{ name = "MySQL"; port = 3306; start = [ordered]@{ exe = "D:\phpstudy_pro\Extensions\MySQL5.7.26\bin\mysqld.exe"; args = "--defaults-file=D:\phpstudy_pro\Extensions\MySQL5.7.26\my.ini"; cwd = "D:\phpstudy_pro\Extensions\MySQL5.7.26" } }
            [ordered]@{ name = "Nginx"; port = 80; start = [ordered]@{ exe = "D:\phpstudy_pro\Extensions\Nginx1.15.11\nginx.exe"; args = "-c `"D:\phpstudy_pro\Extensions\Nginx1.15.11\conf\nginx.conf`""; cwd = "D:\phpstudy_pro\Extensions\Nginx1.15.11" } }
            [ordered]@{ name = "NodeServer"; port = 3456; start = [ordered]@{ exe = "node"; args = "server.js"; cwd = "server" } }
        )
    }
    return ($cfg | ConvertTo-Json -Depth 8 | ConvertFrom-Json)
}
$Config = Load-Config

function Write-Audit([string]$msg) {
    # P3-24①：与 panel-server.js rotateAuditLog 同规则——超过 5MB 或跨天轮转，
    # 改名 panel-audit.log.YYYYMMDD（同日复轮转追加 -HHmmss 去重），仅保留最近 7 份。
    try {
        if (Test-Path $AuditLog) {
            $fi = Get-Item $AuditLog
            $now = Get-Date
            $sameDay = ($fi.LastWriteTime.Date -eq $now.Date)
            if (-not $sameDay -or $fi.Length -ge 5MB) {
                $suffix = $fi.LastWriteTime.ToString("yyyyMMdd")
                $bak = "$AuditLog.$suffix"
                if (Test-Path $bak) { $bak += "-" + $fi.LastWriteTime.ToString("HHmmss") }
                Move-Item -Path $AuditLog -Destination $bak -Force
                $old = @(Get-ChildItem -Path $LogsDir -Filter "panel-audit.log.*" -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -Skip 7)
                foreach ($f in $old) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
            }
        }
        Add-Content -Path $AuditLog -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " | web-panel | $msg") -Encoding UTF8
    } catch {}
}

function Get-FreeSpaceGB {
    try {
        $vol = Get-Volume -DriveLetter $ProjectRoot.Substring(0, 1) -ErrorAction SilentlyContinue
        if ($vol -and $vol.SizeRemaining) { return [math]::Round($vol.SizeRemaining / 1GB, 1) }
    } catch {}
    try {
        $drv = Get-WmiObject -Query "SELECT FreeSpace FROM Win32_LogicalDisk WHERE DeviceID='$($ProjectRoot.Substring(0,2))'" -ErrorAction SilentlyContinue
        if ($drv -and $drv.FreeSpace) { return [math]::Round($drv.FreeSpace / 1GB, 1) }
    } catch {}
    return $null
}

function Get-LocalIP {
    $ips = @()
    try {
        $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } |
            Select-Object -ExpandProperty IPAddress)
    } catch {}
    if (-not $ips.Count) {
        try {
            $ips = @(Get-WmiObject Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue |
                Where-Object { $_.IPEnabled -and $_.IPAddress } |
                ForEach-Object { $_.IPAddress } |
                Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -ne '127.0.0.1' })
        } catch {}
    }
    $pri = $ips | Where-Object { $_ -match '^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)' } | Select-Object -First 1
    if ($pri) { return $pri }
    $nonTun = $ips | Where-Object { $_ -notmatch '^(169\.254|26\.|100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.)' } | Select-Object -First 1
    if ($nonTun) { return $nonTun }
    return $ips | Select-Object -First 1
}

function Get-PidByPort([int]$port) {
    try {
        $line = netstat -ano 2>$null | Select-String ":$port\s" | Select-String "LISTENING" | Select-Object -First 1
        if ($line) {
            $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
            [int]$p = 0
            if ([int]::TryParse($parts[-1], [ref]$p)) { return $p }
        }
    } catch {}
    return $null
}

function Get-ProcessInfo([int]$procId) {
    try {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p) { return @{ name = $p.Name; cpu = [math]::Round($p.CPU, 1); memMB = [math]::Round($p.WorkingSet / 1MB, 1) } }
    } catch {}
    return $null
}

function Get-ServiceStatus {
    $list = @()
    foreach ($svc in $Config.services) {
        $procId = Get-PidByPort ([int]$svc.port)
        $info = $null
        if ($null -ne $procId) { $info = Get-ProcessInfo $procId }
        $list += [ordered]@{ name = $svc.name; port = [int]$svc.port; running = ($null -ne $procId); pid = $procId; proc = $info }
    }
    return ,$list
}

function Start-OneService($svc) {
    $port = [int]$svc.port
    if (Get-PidByPort $port) { return $true }
    $exe = $svc.start.exe; $args = $svc.start.args; $cwd = $svc.start.cwd
    if ($cwd -and -not [System.IO.Path]::IsPathRooted($cwd)) { $cwd = Join-Path $ProjectRoot $cwd }
    if ($exe -ne "node" -and -not (Test-Path $exe)) { throw "未找到启动程序：$exe" }
    if (-not (Test-Path $cwd)) { throw "工作目录不存在：$cwd" }
    Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $cwd -WindowStyle Hidden -PassThru | Out-Null
    $waited = 0
    while (-not (Get-PidByPort $port) -and $waited -lt 30) { Start-Sleep -Seconds 1; $waited++ }
    return (Get-PidByPort $port) -ne $null
}

function Stop-OneService($svc) {
    $port = [int]$svc.port
    $procId = Get-PidByPort $port
    if ($null -ne $procId) { try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {} }
    $exeName = $null
    try { $raw = $svc.start.exe; if ($raw -and $raw -ne 'node') { $exeName = Split-Path $raw -Leaf } } catch {}
    if ($exeName) {
        try { Start-Process -FilePath "taskkill" -ArgumentList "/f","/im",$exeName -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue | Out-Null } catch {}
    }
    $waited = 0
    while ((Get-PidByPort $port) -and $waited -lt 15) {
        $pid2 = Get-PidByPort $port
        if ($null -ne $pid2) {
            try { Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue } catch {}
            try { Start-Process -FilePath "taskkill" -ArgumentList "/f","/pid",$pid2 -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue | Out-Null } catch {}
        }
        Start-Sleep -Seconds 1; $waited++
    }
    return (Get-PidByPort $port) -eq $null
}

function Invoke-ServiceAction([string]$svcName, [string]$mode) {
    if ($svcName -and $svcName -ne "all") {
        $svc = $Config.services | Where-Object { $_.name -eq $svcName }
        if (-not $svc) { throw "未知服务：$svcName" }
        $targets = @($svc)
    } else { $targets = @($Config.services) }
    $results = @()
    foreach ($svc in $targets) {
        if ($mode -eq "start") { $ok = Start-OneService $svc; $msg = if ($ok) { "✅ $($svc.name) 已启动" } else { "⚠ $($svc.name) 启动失败" } }
        elseif ($mode -eq "stop") { $ok = Stop-OneService $svc; $msg = if ($ok) { "✅ $($svc.name) 已停止" } else { "⚠ $($svc.name) 停止失败" } }
        else { Stop-OneService $svc | Out-Null; Start-Sleep -Seconds 2; $ok = Start-OneService $svc; $msg = if ($ok) { "✅ $($svc.name) 已重启" } else { "⚠ $($svc.name) 重启失败" } }
        $results += [ordered]@{ name = $svc.name; ok = $ok; message = $msg }
        Write-Audit "$mode 服务：$($svc.name) $(if($ok){'成功'}else{'失败'})"
    }
    return $results
}

function Get-DataDir { return Join-Path $ProjectRoot $Config.dataDir }

function Test-DiskForBackup([string]$targetPath, [long]$estimateBytes) {
    try {
        $vol = Get-Volume -DriveLetter $targetPath.Substring(0, 1) -ErrorAction SilentlyContinue
        if ($vol -and $vol.SizeRemaining -and $vol.SizeRemaining -lt $estimateBytes) {
            throw "磁盘剩余空间不足（需约 $([math]::Round($estimateBytes/1GB,2))GB），拒绝执行以防生成损坏备份"
        }
    } catch {}
    return $true
}

$out = @{ ok = $false; message = ""; data = $null }
try {
    switch ($Action) {
        "status" {
            $space = Get-FreeSpaceGB
            $cpuPct = $null; $memTotalMB = $null; $memUsedMB = $null
            try {
                $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
                if ($cpu) { $cpuPct = [math]::Round([double]$cpu.PercentProcessorTime, 0) }
            } catch {}
            if ($null -eq $cpuPct) {
                try { $l = (Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average; if ($null -ne $l) { $cpuPct = [math]::Round([double]$l, 0) } } catch {}
            }
            try {
                $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
                $memTotalMB = [math]::Round([double]$os.TotalVisibleMemorySize / 1KB, 0)
                $memUsedMB = [math]::Round(([double]$os.TotalVisibleMemorySize - [double]$os.FreePhysicalMemory) / 1KB, 0)
            } catch {}
            $out.data = [ordered]@{
                services = (Get-ServiceStatus)
                diskGB   = $space
                diskWarn = if ($null -ne $space) { [double]$Config.diskWarnGB } else { $null }
                lanIp    = (Get-LocalIP)
                isAdmin  = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
                highRiskConfirm = if ($Config.highRiskConfirm) { $Config.highRiskConfirm } else { "CONFIRM-DELETE-ALL-DATA" }
                restoreConfirm  = if ($Config.restoreConfirm) { $Config.restoreConfirm } else { "CONFIRM-RESTORE-FROM-BACKUP" }
                cpuPct   = $cpuPct
                memTotalMB = $memTotalMB
                memUsedMB = $memUsedMB
            }
            $out.ok = $true
        }
        "start"   { $out.data = Invoke-ServiceAction $Arg "start";   $out.ok = $true }
        "stop"    { $out.data = Invoke-ServiceAction $Arg "stop";    $out.ok = $true }
        "restart" { $out.data = Invoke-ServiceAction $Arg "restart"; $out.ok = $true }

        "backup" {
            $dataDir = Get-DataDir
            if (-not (Test-Path $dataDir)) { throw "用户数据目录不存在：$dataDir" }
            $size = (Get-ChildItem $dataDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
            if (-not $size) { $size = 0 }
            Test-DiskForBackup $BackupDir ($size + 50MB) | Out-Null
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $zip = Join-Path $BackupDir "userdata-$stamp.zip"
            $mode = "zip"; $locked = @()
            try {
                Compress-Archive -Path $dataDir -DestinationPath $zip -Force -ErrorAction Stop
            } catch {
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
                    "以下文件在备份时无法读取（可能被占用）：`r`n" + ($locked -join "`r`n") | Out-File -Encoding utf8 (Join-Path $dest "BACKUP-WARNING.txt")
                }
                $zip = $dest; $mode = "dir"
            }
            $keep = 10; try { if ($Config.backupRetention) { $keep = [int]$Config.backupRetention } } catch {}
            $all = Get-ChildItem $BackupDir -File -Filter "userdata-*" | Sort-Object LastWriteTime -Descending
            if ($all.Count -gt $keep) { $all | Select-Object -Skip $keep | Remove-Item -Force -ErrorAction SilentlyContinue }
            if ((Test-Path $zip) -and (Get-Item $zip).PSIsContainer -eq $false -and (Get-Item $zip).Length -eq 0) {
                Remove-Item $zip -Force; throw "备份包为空，已删除"
            }
            $out.data = [ordered]@{ path = $zip; mode = $mode; locked = $locked.Count }
            $out.message = "备份完成：$zip"
            $out.ok = $true
            Write-Audit "备份用户数据：成功 $zip"
        }

        "backups" {
            $list = @()
            if (Test-Path $BackupDir) {
                $list = Get-ChildItem $BackupDir -File | Sort-Object LastWriteTime -Descending | ForEach-Object {
                    $type = "其他"
                    if ($_.Name -like "userdata-*") { $type = "用户数据" } elseif ($_.Name -like "config-*") { $type = "配置备份" }
                    [ordered]@{ name = $_.Name; sizeMB = [math]::Round($_.Length / 1MB, 2); time = $_.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss"); type = $type }
                }
            }
            $out.data = @{ backups = @($list); backupDir = $BackupDir }
            $out.ok = $true
        }

        "restore" {
            $req = @{}; if ($Arg) { try { $req = $Arg | ConvertFrom-Json } catch {} }
            $name = [string]$req.name
            if (-not $name) { throw "缺少备份文件名参数" }
            if ($name -match '[\\/]' -or $name -match '\.\.') { throw "非法备份文件名" }
            $target = Join-Path $BackupDir $name
            if (-not (Test-Path $target)) { throw "备份不存在：$name" }
            $status = Get-ServiceStatus
            $bizName = if ($Config.businessService) { $Config.businessService } else { "NodeServer" }
            if (($status | Where-Object { $_.name -eq $bizName }).running) { throw "服务正在运行，请先停止服务再恢复" }
            $dataDir = Get-DataDir
            $snap = Join-Path $BackupDir ("userdata-snapshot-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
            $snapMsg = ""
            if (Test-Path $dataDir) { try { Compress-Archive -Path $dataDir -DestinationPath $snap -Force; $snapMsg = "已生成快照：$snap" } catch {} }
            if (Test-Path $dataDir) { Get-ChildItem $dataDir -Force | ForEach-Object { try { Remove-Item $_.FullName -Recurse -Force } catch {} } }
            else { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
            if ($target.EndsWith(".zip")) { Expand-Archive -Path $target -DestinationPath $dataDir -Force }
            else {
                Get-ChildItem $target -Recurse -File | ForEach-Object {
                    $rel = $_.FullName.Substring($target.Length).TrimStart('\')
                    $t = Join-Path $dataDir $rel
                    $td = Split-Path $t
                    if (-not (Test-Path $td)) { New-Item -ItemType Directory -Path $td -Force | Out-Null }
                    Copy-Item $_.FullName $t -Force
                }
            }
            $out.data = [ordered]@{ snapshot = $snap; snapMsg = $snapMsg }
            $out.message = "恢复完成：$name"
            $out.ok = $true
            Write-Audit "从备份恢复数据：成功 $name"
        }

        "clear-data" {
            $status = Get-ServiceStatus
            $bizName = if ($Config.businessService) { $Config.businessService } else { "NodeServer" }
            if (($status | Where-Object { $_.name -eq $bizName }).running) { throw "服务正在运行，禁止清除用户数据。请先停止服务" }
            $dataDir = Get-DataDir
            if (-not (Test-Path $dataDir)) { $out.message = "用户数据目录不存在，无需清理"; $out.ok = $true; break }
            Get-ChildItem $dataDir -Force | ForEach-Object { try { Remove-Item $_.FullName -Recurse -Force } catch {} }
            $out.message = "用户数据已清空（目录已保留）"
            $out.ok = $true
            Write-Audit "清除用户数据：高危操作完成"
        }

        "recent-log" {
            $logs = @(Get-ChildItem $LogsDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "panel-audit*" -and $_.Length -gt 0 })
            $res = @()
            foreach ($lf in $logs) {
                $res += [ordered]@{ name = $lf.Name; tail = @(Get-Content $lf.FullName -Encoding UTF8 -Tail 50 -ErrorAction SilentlyContinue) }
            }
            $out.data = @{ files = @($res) }
            $out.ok = $true
        }

        "search-log" {
            if (-not (Test-Path $LogsDir)) { $out.data = @{ matches = @() }; $out.ok = $true; break }
            $kws = @("ERROR", "FATAL", "Exception", "失败")
            try { if ($Config.logSearchKeywords) { $kws = @($Config.logSearchKeywords) } } catch {}
            if ($Arg) { $kws = @($Arg) }
            $lines = @()
            Get-ChildItem $LogsDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "panel-audit*" } | ForEach-Object {
                $fname = $_.Name
                Get-Content $_.FullName -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object {
                    $line = $_
                    foreach ($k in $kws) { if ($line -match [regex]::Escape($k)) { $lines += "${fname}: $line"; break } }
                }
            }
            $out.data = @{ matches = @($lines | Select-Object -First 200); total = $lines.Count }
            $out.ok = $true
        }

        "clear-logs" {
            $removed = 0
            if (Test-Path $LogsDir) {
                Get-ChildItem $LogsDir -File | Where-Object { $_.Name -notlike "panel-audit*" } | ForEach-Object {
                    try { Remove-Item $_.FullName -Force; $removed++ } catch {}
                }
            }
            $out.message = "已清理 $removed 个日志文件"
            $out.ok = $true
            Write-Audit "清理日志：删除 $removed 个文件"
        }

        "check-env" {
            $checks = @()
            foreach ($svc in $Config.services) {
                $exe = $svc.start.exe
                $ok = if ($exe -eq "node") { $null -ne (Get-Command node -ErrorAction SilentlyContinue) } else { Test-Path $exe }
                $checks += [ordered]@{ item = "$($svc.name) 程序"; path = $exe; ok = $ok }
            }
            foreach ($kf in @("server\server.js", ".env", "public", "panel-config.json")) {
                $checks += [ordered]@{ item = "关键文件/目录"; path = $kf; ok = (Test-Path (Join-Path $ProjectRoot $kf)) }
            }
            $out.data = @{ checks = @($checks) }
            $out.ok = $true
        }

        "export-config" {
            if (-not (Test-Path $ConfigFile)) { throw "配置文件不存在" }
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $dest = Join-Path $BackupDir "config-$stamp.json"
            Copy-Item $ConfigFile $dest -Force
            $keep = 5; try { if ($Config.configBackupRetention) { $keep = [int]$Config.configBackupRetention } } catch {}
            $all = Get-ChildItem $BackupDir -File -Filter "config-*" | Sort-Object LastWriteTime -Descending
            if ($all.Count -gt $keep) { $all | Select-Object -Skip $keep | Remove-Item -Force -ErrorAction SilentlyContinue }
            $out.data = @{ path = $dest }
            $out.message = "配置备份已导出：$dest"
            $out.ok = $true
            Write-Audit "导出配置备份：$dest"
        }

        "export-panel-config" {
            if (-not (Test-Path $ConfigFile)) { throw "配置文件不存在" }
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $dest = Join-Path $BackupDir "panel-config-export-$stamp.json"
            Copy-Item $ConfigFile $dest -Force
            $out.data = @{ path = $dest }
            $out.message = "面板配置文件已导出：$dest"
            $out.ok = $true
            Write-Audit "导出面板配置文件：$dest"
        }

        "ports" {
            $default = 3456
            try { $biz = $Config.services | Where-Object { $_.name -eq $Config.businessService }; if ($biz) { $default = [int]$biz.port } } catch {}
            $port = $default
            if ($Arg -match '^\d+$') { $port = [int]$Arg }
            $procId = Get-PidByPort $port
            $info = $null
            if ($null -ne $procId) { $info = Get-ProcessInfo $procId }
            $out.data = @{ port = $port; pid = $procId; proc = $info; occupied = ($null -ne $procId) }
            $out.ok = $true
        }

        "kill-port" {
            $port = 0
            if (-not ($Arg -match '^\d+$' -and [int]::TryParse($Arg, [ref]$port))) { throw "无效端口" }
            if (@(135, 137, 138, 139, 445, 3389, 5985, 5986) -contains $port) { throw "该端口为系统关键端口，禁止操作" }
            $procId = Get-PidByPort $port
            if ($null -eq $procId) { $out.message = "端口 $port 空闲，无需释放"; $out.ok = $true; break }
            $info = Get-ProcessInfo $procId
            if (@("System", "System Idle Process", "csrss", "services", "lsass", "wininit", "smss", "explorer") -contains $info.name) { throw "该进程为系统关键进程（$($info.name)），禁止终止" }
            try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { throw "终止失败（权限不足？）：$_" }
            Start-Sleep -Seconds 2
            $left = Get-PidByPort $port
            if ($null -eq $left) { $out.message = "✅ 端口 $port 已释放"; $out.ok = $true; Write-Audit "释放端口：$port 成功" }
            else { $out.message = "⚠ 端口 $port 仍未释放"; $out.ok = $true }
        }

        "lan-ip" {
            $ip = Get-LocalIP
            $out.data = @{ ip = $ip }
            $out.message = if ($ip) { "内网IPv4地址：$ip" } else { "获取失败" }
            $out.ok = $true
        }

        "disk" {
            $space = Get-FreeSpaceGB
            $warn = 1.0; try { if ($Config.diskWarnGB) { $warn = [double]$Config.diskWarnGB } } catch {}
            $out.data = @{ freeGB = $space; warnGB = $warn }
            $out.ok = $true
        }

        "cache-clean" {
            $targets = @("__pycache__", "temp", "cache", "node_modules\.cache")
            $removed = 0
            foreach ($t in $targets) {
                $p = Join-Path $ProjectRoot $t
                if (Test-Path $p -and $p.StartsWith($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $p -notmatch '\.\.') {
                    Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
                    $removed++
                }
            }
            $out.message = "已清理 $removed 类缓存目录"
            $out.ok = $true
            Write-Audit "清理缓存：清理 $removed 类目录"
        }

        "audit-log" {
            $lines = @()
            if (Test-Path $AuditLog) { $lines = @(Get-Content $AuditLog -Encoding UTF8 -Tail 100 -ErrorAction SilentlyContinue) }
            $out.data = @{ lines = $lines; path = $AuditLog }
            $out.ok = $true
        }

        "reset-superadmin" {
            $req = @{}; if ($Arg) { try { $req = $Arg | ConvertFrom-Json } catch {} }
            $pass = [string]$req.pass
            $login = [string]$req.login
            if (-not $login) { $login = "super_admin" }
            # P2-95：login 值经数组直传给 node，但值本身若以 - 开头会被
            # reset-superadmin.js 的 parseArgs 当作新 flag（如注入 --pass）。
            # 白名单：任意文字/数字/._@-，1-64 位，且禁止 - 开头。
            if ($login -notmatch '^[\p{L}\p{N}_.@-]{1,64}$' -or $login.StartsWith('-')) { throw "账号名不合法（仅允许文字、数字与 ._@-，且不能以 - 开头），已中止" }
            $node = Get-Command node -ErrorAction SilentlyContinue
            if (-not $node) { throw "未找到 node，请确认 Node.js 已安装并在 PATH 中" }
            $script = Join-Path $ProjectRoot "server\scripts\reset-superadmin.js"
            if (-not (Test-Path $script)) { throw "未找到重置脚本：$script" }
            $argList = @($script, "--login", $login, "--yes")
            if ($pass) { $argList += @("--pass", $pass) }
            Push-Location $ProjectRoot
            $stdout = & node @argList 2>&1
            $code = $LASTEXITCODE
            Pop-Location
            if ($code -ne 0) {
                # P2-95：脚本原始输出（可能含表名/路径等内部上下文）只进审计日志，
                # HTTP 响应仅回显单行安全原因。
                Write-Audit "重置超级管理员密码：$login 失败（退出码 $code）：$($stdout | Out-String | ForEach-Object Trim)"
                throw "重置脚本执行失败（退出码 $code），详情见面板审计日志"
            }
            $out.message = "✅ 超级管理员密码已重置（账号：$login）"
            $out.data = @{ login = $login }
            $out.ok = $true
            Write-Audit "重置超级管理员密码：$login 成功"
        }

        "export-site" {
            $script = Join-Path $ProjectRoot "export-site.ps1"
            if (-not (Test-Path $script)) { throw "未找到导出脚本：$script" }
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $name = "jingtu-web-$stamp.zip"
            $args = @("-File", $script, "-OutDir", $BackupDir, "-Name", $name)
            if ($Arg -eq "data") { $args += "-IncludeData" }
            $p = Start-Process powershell.exe -ArgumentList $args -WindowStyle Hidden -Wait -PassThru
            $outFile = Join-Path $BackupDir $name
            if (-not (Test-Path $outFile)) { throw "导出未生成压缩包，请查看面板日志" }
            $size = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
            $out.data = @{ path = $outFile; sizeMB = $size }
            $out.message = "✅ 网站导出完成：$outFile （$size MB）"
            $out.ok = $true
            Write-Audit "导出网站包：$name 成功"
        }

        "reset" {
            $script = Join-Path $ProjectRoot "server\scripts\reset-to-init.js"
            if (-not (Test-Path $script)) { throw "未找到重置脚本：$script" }
            $p = Start-Process node.exe -ArgumentList @($script, "--yes") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -Wait -PassThru
            if ($p.ExitCode -ne 0) { throw "重置脚本执行失败（退出码 $($p.ExitCode)），请查看面板日志" }
            $out.message = "重置初始化执行完成：server\scripts\reset-to-init.js"
            $out.ok = $true
            Write-Audit "重置初始化：执行 reset-to-init.js 成功"
        }
    }
} catch {
    $out.ok = $false
    # P2-95：完整异常堆栈只写审计日志；HTTP 响应透出的 message 收敛为
    # 异常的单行描述（显式 throw 的中文短原因仍会显示），不外泄内部上下文。
    $detail = ($_ | Out-String).Trim()
    try { Write-Audit "$Action 异常：$detail" } catch {}
    $msg = if ($_.Exception -and $_.Exception.Message) { ([string]$_.Exception.Message).Trim() } else { "" }
    if (-not $msg) { $msg = "操作 $Action 失败，详情见面板审计日志" }
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
    $out.message = $msg
}
# stdout 只输出一行 JSON，供 Node 端解析
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
($out | ConvertTo-Json -Compress -Depth 12) | Write-Output
