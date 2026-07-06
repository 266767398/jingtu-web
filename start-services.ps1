# 境途同游 - 一键启动服务 (PowerShell)
$ErrorActionPreference = "Stop"

$MYSQL_DIR = "D:\phpstudy_pro\Extensions\MySQL5.7.26"
$NGINX_DIR = "D:\phpstudy_pro\Extensions\Nginx1.15.11"
$SERVER_DIR = "D:\phpstudy_pro\WWW\jingtu-web\server"

Write-Host "============================================"
Write-Host "  JingTu Web - Starting all services..."
Write-Host "============================================"
Write-Host ""

# ==== Helper: check if port is listening ====
function Test-Port($port) {
    $conn = netstat -ano | Select-String ":$port " | Select-String "LISTENING"
    return $conn -ne $null
}

# ==== 1. MySQL ====
Write-Host "[1/4] Checking MySQL 3306..."
if (Test-Port 3306) {
    Write-Host "  [OK] MySQL is running" -ForegroundColor Green
} else {
    Write-Host "  [..] Starting MySQL..." -ForegroundColor Yellow
    $p = Start-Process -FilePath "$MYSQL_DIR\bin\mysqld.exe" -ArgumentList "--defaults-file=$MYSQL_DIR\my.ini" -WindowStyle Hidden -PassThru
    $waited = 0
    while (-not (Test-Port 3306) -and $waited -lt 30) {
        Start-Sleep -Seconds 1
        $waited++
    }
    if (Test-Port 3306) {
        Write-Host "  [OK] MySQL started (${waited}s)" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] MySQL timeout - check $MYSQL_DIR\data\*.err" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ==== 2. Nginx ====
Write-Host "[2/4] Checking Nginx 80..."
if (Test-Port 80) {
    Write-Host "  [OK] Nginx is running" -ForegroundColor Green
} else {
    Write-Host "  [..] Starting Nginx..." -ForegroundColor Yellow
    if (-not (Test-Path "$NGINX_DIR\nginx.exe")) {
        Write-Host "  [FAIL] Nginx not found at $NGINX_DIR" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    $p = Start-Process -FilePath "$NGINX_DIR\nginx.exe" -ArgumentList "-c `"$NGINX_DIR\conf\nginx.conf`"" -WorkingDirectory "$NGINX_DIR" -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if (Test-Port 80) {
        Write-Host "  [OK] Nginx started" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Nginx failed to start" -ForegroundColor Red
        Write-Host "         Run: nginx -t -c `"$NGINX_DIR\conf\nginx.conf`""
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ==== 3. Node.js ====
Write-Host "[3/4] Checking Node.js 3456..."
if (Test-Port 3456) {
    Write-Host "  [OK] Node.js is running" -ForegroundColor Green
} else {
    Write-Host "  [..] Starting Node.js..." -ForegroundColor Yellow
    if (-not (Test-Path "$SERVER_DIR\server.js")) {
        Write-Host "  [FAIL] Server not found at $SERVER_DIR" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    $p = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "$SERVER_DIR" -WindowStyle Hidden -PassThru
    $waited = 0
    while (-not (Test-Port 3456) -and $waited -lt 20) {
        Start-Sleep -Seconds 1
        $waited++
    }
    if (Test-Port 3456) {
        Write-Host "  [OK] Node.js started (${waited}s)" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Node.js timeout - check $SERVER_DIR\node_output.log" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ==== 4. Health Check ====
Write-Host "[4/4] Health check..."
Start-Sleep -Seconds 2
try {
    $r = Invoke-WebRequest -Uri "http://localhost:3456/api/health" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) {
        Write-Host "  [OK] Health check passed" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] Health check returned $($r.StatusCode)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [WARN] Health check failed: $_" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================"
Write-Host "  [OK] All services started!"
Write-Host "  Open: http://localhost"
Write-Host "============================================"
Start-Sleep -Seconds 2
Start-Process "http://localhost"
