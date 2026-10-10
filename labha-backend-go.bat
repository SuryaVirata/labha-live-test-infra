@echo off
setlocal

REM ============================================================
REM  LABHA Full Stack Launcher — the ONE file. Double-click this
REM  and it brings up everything: backend (Docker/WSL), pgAdmin,
REM  dashboard, and storefront, each in its own window.
REM
REM  Steps [1/7]-[7/7] below are the original launch sequence,
REM  unchanged. [8/8] at the end is new: it checks from Windows
REM  that the three WSL-hosted services actually became reachable
REM  (not just "the window opened"), and if not, automatically
REM  resets WSL's networking and retries the WHOLE sequence once.
REM  See the comment above that step for why this exists - do not
REM  remove it, it fixes a real recurring bug (WSL2's
REM  localhost-forwarding relay silently breaking), it isn't
REM  optional polish.
REM ============================================================

title LABHA Full Stack Launcher

REM Set by this script's own self-relaunch after a WSL network reset (see
REM step [8/8] below) so it retries the full sequence exactly once instead
REM of looping forever if something else is actually wrong.
set IS_RETRY=%1

set WSL_DISTRO=Ubuntu
set BACKEND_PATH=/mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-backend-go
set DASHBOARD_PATH=/mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-dashboard
set STOREFRONT_PATH=/mnt/c/Users/surya/OneDrive/Documents/GitHub/labha-storefront
set DOCKER_DESKTOP=C:\Program Files\Docker\Docker\resources\bin\docker.exe

echo ================================================================
echo   LABHA Full Stack  -  Backend + pgAdmin + Dashboard + Storefront
echo ================================================================
echo.

echo [1/7] Ensuring Docker is running inside WSL...
wsl -d %WSL_DISTRO% -u root -- bash -lc "if systemctl is-active --quiet docker; then echo DOCKER_OK; else echo Starting Docker...; service docker start >/dev/null 2>&1; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do systemctl is-active --quiet docker && echo DOCKER_OK && exit 0; sleep 1; done; echo DOCKER_FAIL; exit 1; fi"
if errorlevel 1 (
    echo.
    echo Docker could not be started inside WSL Ubuntu.
    echo Open a WSL terminal once and run:  sudo service docker start
    echo Then double-click this file again.
    echo.
    pause
    exit /b 1
)
echo Docker is active.
echo.

echo [2/7] Stopping stale containers on BOTH Docker engines...
echo   - WSL engine (this script's engine)...
wsl -d %WSL_DISTRO% -- bash -lc "cd %BACKEND_PATH% && docker compose down 2>/dev/null; docker ps -aq --filter name=labha-backend-go | xargs -r docker rm -f 2>/dev/null; echo '    WSL engine cleaned.'"
echo   - Docker Desktop engine (Windows, if installed AND running)...
if exist "%DOCKER_DESKTOP%" (
    for /f "delims=" %%i in ('"%DOCKER_DESKTOP%" ps -aq --filter "name=labha-backend-go" 2^>nul') do "%DOCKER_DESKTOP%" rm -f %%i >nul 2>nul
    echo     Desktop engine cleaned.
) else (
    echo     Desktop CLI not present - skipping, WSL engine above is authoritative.
)
echo.

echo [3/7] Freeing ports 8080/5432/6379 (backend), 5173 (dashboard), 3000 (storefront)...
echo   Anything already listening on these is killed automatically so this
echo   file can be re-run any time without manual cleanup.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = 8080,5432,6379,5173,3000;" ^
  "foreach ($p in $ports) {" ^
  "  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue;" ^
  "  $seen = @{};" ^
  "  foreach ($c in $conns) {" ^
  "    if ($seen.ContainsKey($c.OwningProcess)) { continue }; $seen[$c.OwningProcess] = 1;" ^
  "    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;" ^
  "    if ($proc) {" ^
  "      Write-Host ('  freeing port ' + $p + ' (was held by ' + $proc.ProcessName + ', PID ' + $proc.Id + ')');" ^
  "      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue;" ^
  "    }" ^
  "  }" ^
  "}" ^
  "Start-Sleep -Seconds 2;" ^
  "Write-Host '  Ports freed.'"
echo.

echo [4/7] Fixing Windows line-endings on shell scripts (safe, idempotent)...
wsl -d %WSL_DISTRO% -- bash -lc "cd %BACKEND_PATH% && find scripts -name '*.sh' -exec sed -i 's/\r$//' {} \; && find ../labha-database-postgres -type f \( -name '*.sh' -o -name '*.sql' -o -name '*.txt' \) -exec sed -i 's/\r$//' {} \;"
echo.

echo [5/7] Ensuring pgAdmin is up (WSL-side container, not part of the repo)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0labha-pgadmin-provision.ps1"
echo.

echo [6/7] Launching backend, dashboard, and storefront each in their own window...

start "LABHA Backend" cmd /k wsl -d %WSL_DISTRO% -- bash -lc "export PATH=$HOME/go-linux/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd %BACKEND_PATH% && [ -f .env ] || cp .env.example .env; for i in 1 2 3 4 5; do sed -i -e 's/\r$//' -e 's/^S3_BUCKET_MEDIA=.*/S3_BUCKET_MEDIA=/' -e 's/^AWS_PROFILE=/#AWS_PROFILE=/' .env 2>/dev/null; grep -q '^AUTH_FINGERPRINT_PEPPER=' .env 2>/dev/null || echo 'AUTH_FINGERPRINT_PEPPER=dev-local-fingerprint-pepper-32chars-min' >> .env; grep -q '^AUTH_REFRESH_TOKEN_PEPPER=' .env 2>/dev/null || echo 'AUTH_REFRESH_TOKEN_PEPPER=dev-local-refresh-token-pepper-32chars-min' >> .env; grep -qE '^AUTH_ENCRYPTION_KEY_BASE64=.+' .env 2>/dev/null || { sed -i '/^AUTH_ENCRYPTION_KEY_BASE64=/d' .env 2>/dev/null; echo AUTH_ENCRYPTION_KEY_BASE64=$(openssl rand -base64 32) >> .env; }; grep -qE '^AUTH_ENCRYPTION_KEY_BASE64=.+' .env 2>/dev/null && break; echo 'env file not ready yet, retrying...'; sleep 1; done; if ! grep -qE '^AUTH_ENCRYPTION_KEY_BASE64=.+' .env 2>/dev/null; then echo 'FATAL: could not prepare .env after 5 attempts'; exit 1; fi; ./scripts/runLocal.sh --docker"

timeout /t 2 /nobreak >nul

start "LABHA Dashboard" cmd /k wsl -d %WSL_DISTRO% -- bash -lc "source ~/.nvm/nvm.sh && nvm use 22 >/dev/null 2>&1 && cd %DASHBOARD_PATH% && npm install --fetch-timeout=120000 --fetch-retries=5 && npm run dev -- --host"

timeout /t 2 /nobreak >nul

start "LABHA Storefront" cmd /k wsl -d %WSL_DISTRO% -- bash -lc "source ~/.nvm/nvm.sh && nvm use 22 >/dev/null 2>&1 && cd %STOREFRONT_PATH% && npm install --fetch-timeout=120000 --fetch-retries=5 && npm run dev"

echo.

echo [7/7] All services launching.
echo.

echo [8/8] Waiting for the three WSL-hosted services to come up, then
echo       checking from Windows that they're ACTUALLY reachable (not
echo       just "the window opened") - this is the fix for the recurring
echo       bug where WSL2's localhost-forwarding relay silently breaks:
echo       Expo/Vite/Next serve fine *inside* WSL but Windows can't reach
echo       localhost at all. Plain "it started" is not proof it works.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$urls = @('http://localhost:8080/','http://localhost:5173/','http://localhost:3000/');" ^
  "function Test-All {" ^
  "  foreach ($u in $urls) {" ^
  "    try { $r = Invoke-WebRequest -Uri $u -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 500) { return $false } }" ^
  "    catch { return $false }" ^
  "  }; return $true" ^
  "}" ^
  "$healthy = $false;" ^
  "for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Seconds 3; if (Test-All) { $healthy = $true; break } }" ^
  "if ($healthy) { Write-Host '  All three reachable from Windows - confirmed.'; exit 0 } else { Write-Host '  Still not all reachable after 2 minutes.'; exit 1 }"

if errorlevel 1 (
    if "%IS_RETRY%"=="RETRY" (
        echo.
        echo   Still not reachable even after one WSL network reset and retry.
        echo   This is something other than the known forwarding bug - check
        echo   each service's own window for real errors ^(failed npm install,
        echo   Docker compose failure, etc.^), or verify from inside WSL directly:
        echo     wsl -d %WSL_DISTRO% -- curl -s -o /dev/null -w "%%{http_code}" http://localhost:8080/
        echo.
    ) else (
        echo.
        echo   Not reachable from Windows - this matches the known WSL2
        echo   localhost-forwarding bug, not a slow install ^(2 minutes is
        echo   generous^). Resetting WSL networking automatically
        echo   ^(wsl --shutdown^) and retrying the FULL sequence once...
        echo   ^(The open service windows will go dead/disconnected - that's
        echo   expected, wsl --shutdown kills everything in WSL including
        echo   Docker. Close them; the retry opens fresh ones.^)
        echo.
        wsl --shutdown
        timeout /t 5 /nobreak >nul
        call "%~f0" RETRY
        exit /b
    )
) else (
    echo.
    echo   Backend:    http://localhost:8080
    echo   Dashboard:  http://localhost:5173
    echo   Storefront: http://localhost:3000
    echo   pgAdmin:    http://localhost:5050
    echo.
    echo Each service has its own window with live logs - close a window to
    echo stop that service. This launcher window can be closed safely now.
)
echo.
pause
