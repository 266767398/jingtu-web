<#
.SYNOPSIS
    境途WEB 站点导出工具（P3-16 恢复登记规格）。
.DESCRIPTION
    将代码/配置/静态资源打包为 zip，供迁移、异地备份或交付使用。
    面板入口：panel/panel-api.ps1 的 export-site action（-OutDir 指向 backup 目录）。
    打包范围（白名单）：
      server（排除 node_modules/coverage/__tests__/tests/logs/_*.js 临时脚本）
      public（排除 ai-scratch）
      assets（排除 album/avatar-cache 用户数据，-IncludeData 时才带上）
      docs、deploy（排除 *.generated 渲染产物）、panel（排除 panel-auth.json）
      根目录配置文件：显式白名单，绝不含 .env 密钥。
    秘密红线：.env、panel-auth.json 无论如何不进入压缩包；压缩前做二次校验。
    兼容 Windows PowerShell 5.1，文件必须保存为 UTF-8 BOM。
.EXAMPLE
    .\export-site.ps1
    .\export-site.ps1 -OutDir "D:\backup" -Name "site.zip" -IncludeData
#>
param(
    [string]$OutDir = 'D:/phpstudy_pro/WWW',
    [string]$Name = '',
    [switch]$IncludeData
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "[export] $msg" }

# 递归复制目录树：按目录名剪枝（node_modules 等大目录根本不读）、按文件名谓词过滤。
function Copy-FilteredTree {
    param(
        [string]$Source,
        [string]$Target,
        [string[]]$ExcludeDirNames = @(),
        [scriptblock]$ExcludeFilePredicate = $null
    )
    if (-not (Test-Path -LiteralPath $Target)) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
    }
    foreach ($d in (Get-ChildItem -LiteralPath $Source -Directory)) {
        if ($ExcludeDirNames -contains $d.Name) { continue }
        Copy-FilteredTree -Source $d.FullName -Target (Join-Path $Target $d.Name) `
            -ExcludeDirNames $ExcludeDirNames -ExcludeFilePredicate $ExcludeFilePredicate
    }
    foreach ($f in (Get-ChildItem -LiteralPath $Source -File)) {
        if ($ExcludeFilePredicate -and (& $ExcludeFilePredicate $f.Name)) { continue }
        Copy-Item -LiteralPath $f.FullName -Destination $Target -Force
    }
}

$staging = $null
try {
    $ProjectRoot = $PSScriptRoot
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (-not $Name) { $Name = "jingtu-web-$stamp.zip" }
    if (-not (Test-Path -LiteralPath $OutDir)) {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    }
    $outFile = Join-Path (Resolve-Path -LiteralPath $OutDir | Select-Object -First 1) $Name

    # 用户数据目录：跟随 panel-config.json 的 dataDir（默认 uploads）
    $dataDir = 'uploads'
    $panelCfg = Join-Path $ProjectRoot 'panel-config.json'
    if (Test-Path -LiteralPath $panelCfg) {
        try {
            $cfg = ConvertFrom-Json (Get-Content -LiteralPath $panelCfg -Raw)
            if ($cfg.dataDir) { $dataDir = [string]$cfg.dataDir }
        } catch {
            Write-Step 'panel-config.json 解析失败，dataDir 回退默认值 uploads'
        }
    }

    $staging = Join-Path ([IO.Path]::GetTempPath()) "jingtu-export-$stamp"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    # ---- 白名单目录 ----
    $treeJobs = @()
    $treeJobs += @{ Dir = 'server'; Dirs = @('node_modules', 'coverage', '__tests__', 'tests', 'logs', '_jt_trash', 'ai-scratch'); Files = { param($n) $n -like '_*.js' } }
    $treeJobs += @{ Dir = 'public'; Dirs = @('ai-scratch', '_jt_trash'); Files = $null }
    $treeJobs += @{ Dir = 'docs'; Dirs = @('_jt_trash'); Files = $null }
    $treeJobs += @{ Dir = 'deploy'; Dirs = @('_jt_trash'); Files = { param($n) $n -like '*.generated' } }
    $treeJobs += @{ Dir = 'panel'; Dirs = @('_jt_trash', 'backup'); Files = { param($n) $n -eq 'panel-auth.json' } }
    if ($IncludeData) {
        $treeJobs += @{ Dir = 'assets'; Dirs = @('_jt_trash'); Files = $null }
    } else {
        $treeJobs += @{ Dir = 'assets'; Dirs = @('album', 'avatar-cache', '_jt_trash'); Files = $null }
    }
    foreach ($job in $treeJobs) {
        $src = Join-Path $ProjectRoot $job.Dir
        if (-not (Test-Path -LiteralPath $src)) {
            Write-Step ("跳过不存在的目录：{0}" -f $job.Dir)
            continue
        }
        Copy-FilteredTree -Source $src -Target (Join-Path $staging $job.Dir) `
            -ExcludeDirNames $job.Dirs -ExcludeFilePredicate $job.Files
        Write-Step ("已复制目录：{0}" -f $job.Dir)
    }

    # ---- 根目录配置文件：显式白名单，不含 .env ----
    $rootFiles = @(
        '.dockerignore', '.env.example', '.gitignore', '.htaccess',
        'DEPLOY.md', 'Dockerfile', 'docker-compose.yml', 'docker-entrypoint.sh',
        'docker.env.example', 'ecosystem.config.js', 'install.sh',
        'jingtu.bat', 'jingtu.config.json', 'jingtu.ps1', 'jingtu.sh',
        'nginx.htaccess', 'panel-config.json', 'export-site.ps1', 'export-site.bat'
    )
    foreach ($rf in $rootFiles) {
        $src = Join-Path $ProjectRoot $rf
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $staging -Force
        }
    }
    Write-Step '根目录配置文件复制完成（白名单，不含 .env）'

    # ---- -IncludeData：追加用户数据 ----
    if ($IncludeData) {
        $dataSrc = Join-Path $ProjectRoot $dataDir
        if (Test-Path -LiteralPath $dataSrc) {
            Copy-FilteredTree -Source $dataSrc -Target (Join-Path $staging $dataDir) -ExcludeDirNames @('_jt_trash')
            Write-Step ("已包含用户数据目录：{0}" -f $dataDir)
        } else {
            Write-Step ("提示：dataDir={0} 不存在，跳过" -f $dataDir)
        }
    }

    # ---- 秘密红线终检：staging 内绝不允许出现 .env / panel-auth.json ----
    $leaks = @(Get-ChildItem -LiteralPath $staging -Recurse -File -Force |
        Where-Object { $_.Name -eq '.env' -or $_.Name -eq 'panel-auth.json' })
    if ($leaks.Count -gt 0) {
        foreach ($l in $leaks) { Write-Host ("[export] 红线拦截：{0}" -f $l.FullName) }
        throw '压缩包内检测到密钥文件，导出中止'
    }

    # ---- 压缩并落盘 ----
    # 不用 Compress-Archive：PS5.1 生成的 zip 条目用反斜杠路径，跨平台解压会产生
    # 带 \ 的畸形文件名。改用 .NET ZipFile，条目为标准正斜杠且更快。
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tmpZip = Join-Path ([IO.Path]::GetTempPath()) "jingtu-export-$stamp.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $tmpZip, [IO.Compression.CompressionLevel]::Optimal, $false)
    Move-Item -LiteralPath $tmpZip -Destination $outFile -Force

    $count = (Get-ChildItem -LiteralPath $staging -Recurse -File).Count
    $sizeMB = [math]::Round(((Get-Item -LiteralPath $outFile).Length / 1MB), 2)
    Write-Step ("导出完成：{0}（{1} 个文件 / {2} MB）" -f $outFile, $count, $sizeMB)
    exit 0
} catch {
    Write-Host ("[export] 失败：{0}" -f $_.Exception.Message)
    exit 1
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
