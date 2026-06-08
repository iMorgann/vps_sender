@echo off
setlocal EnableDelayedExpansion
title VPS Sender v2 — Setup

echo.
echo  ============================================================
echo   VPS Sender v2  ^|  Direct-to-MX Email Sender
echo   Setup Script for Windows
echo  ============================================================
echo.

:: ── 1. Auto-install Node.js via winget if missing ─────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [--] Node.js not found. Attempting auto-install via winget...
    echo.

    :: Check if winget is available (Windows 10 1709+ / Windows 11)
    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        echo  [--] Installing Node.js 20 LTS via winget...
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        if !errorlevel! neq 0 (
            echo  [WARN] winget install may have failed. Trying to refresh PATH...
        )
        :: Refresh PATH so node is available in this session
        for /f "tokens=*" %%i in ('where node 2^>nul') do set NODE_PATH=%%i
        if "!NODE_PATH!"=="" (
            :: Try the default install location
            if exist "%ProgramFiles%\nodejs\node.exe" (
                set "PATH=%ProgramFiles%\nodejs;!PATH!"
            )
        )
    ) else (
        echo  [WARN] winget is not available on this system.
    )

    :: Check again after attempted install
    where node >nul 2>&1
    if !errorlevel! neq 0 (
        echo.
        echo  [!!] Could not auto-install Node.js.
        echo.
        echo  Please install Node.js 20 LTS manually:
        echo    1. Go to:  https://nodejs.org/en/download
        echo    2. Download the Windows Installer (.msi)
        echo    3. Run the installer, accept all defaults
        echo    4. Re-open this window and run install.bat again
        echo.
        pause
        exit /b 1
    )
    echo  [OK] Node.js installed successfully
    echo.
)

:: ── 2. Version check (need 18+) ────────────────────────────────
for /f "tokens=*" %%v in ('node -e "process.stdout.write(process.version)"') do set NODE_VER=%%v
for /f "tokens=1 delims=." %%m in ("%NODE_VER:v=%") do set NODE_MAJOR=%%m

if %NODE_MAJOR% LSS 18 (
    echo  [ERROR] Node.js 18+ required. You have %NODE_VER%.
    echo.
    echo  Update Node.js:
    echo    winget upgrade OpenJS.NodeJS.LTS
    echo  Or download from:  https://nodejs.org/en/download
    echo.
    pause
    exit /b 1
)
echo  [OK] Node.js %NODE_VER%

for /f "tokens=*" %%v in ('npm -v') do set NPM_VER=%%v
echo  [OK] npm %NPM_VER%

:: ── 3. Install npm dependencies (first attempt) ────────────────
echo.
echo  [--] Installing npm dependencies...
echo       (better-sqlite3 will try to use a prebuilt binary first)
echo.

npm install 2>nul
if %errorlevel% equ 0 goto :deps_ok

:: ── 4. npm install failed — try auto-fixing build tools ────────
echo.
echo  [--] First install attempt failed. Trying to fix build tools...
echo.

:: Try node-gyp rebuild approach: install node-gyp globally and windows-build-tools
echo  [--] Installing node-gyp...
call npm install -g node-gyp >nul 2>&1

:: Check for Visual Studio / Build Tools via winget
where winget >nul 2>&1
if %errorlevel% equ 0 (
    echo  [--] Installing Visual Studio Build Tools (C++ workload)...
    echo       This may take several minutes — please wait...
    winget install --id Microsoft.VisualStudio.2022.BuildTools ^
        --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" ^
        --accept-source-agreements --accept-package-agreements --silent 2>nul
    echo  [--] Retrying npm install...
    npm install
    if !errorlevel! equ 0 goto :deps_ok
)

echo.
echo  [ERROR] npm install failed even after attempting to fix build tools.
echo.
echo  Manual fix options:
echo.
echo    Option A — Install via winget (open PowerShell as Administrator):
echo      winget install Microsoft.VisualStudio.2022.BuildTools
echo      Then select "Desktop development with C++" and install.
echo.
echo    Option B — Use Node.js with pre-built binaries only:
echo      npm install --ignore-scripts
echo      (SQLite features will be disabled but everything else works)
echo.
echo    Option C — Download build tools directly:
echo      https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo.
pause
exit /b 1

:deps_ok
echo.
echo  [OK] Dependencies installed

:: ── 5. Runtime directories ─────────────────────────────────────
if not exist "logs\" mkdir logs
if not exist "dkim\"  mkdir dkim
echo  [OK] Created logs\ and dkim\ directories

:: ── 6. Scaffold starter files (only if missing) ────────────────
echo.
echo  [--] Checking starter files...

if not exist "mxemails.txt" (
    (
        echo # Your sender email addresses — one per line
        echo # The scanner will check each domain for MX, SPF, DMARC, and port 25
        echo #
        echo # alice@yourdomain.com
        echo # bob@anotherdomain.net
    ) > mxemails.txt
    echo  [OK] Created mxemails.txt
)

if not exist "recipients.txt" (
    (
        echo # Destination email addresses — one per line
        echo # Any format is accepted: plain, CSV, "Name" ^<email^>, etc.
        echo #
        echo # user1@gmail.com
        echo # user2@yahoo.com
    ) > recipients.txt
    echo  [OK] Created recipients.txt
)

if not exist "subjects.txt" (
    (
        echo Quick question about {{domain}}
        echo Following up — important update
        echo Your exclusive offer is ready
    ) > subjects.txt
    echo  [OK] Created subjects.txt
)

if not exist "names.txt" (
    (
        echo Michael
        echo Sarah
        echo David
    ) > names.txt
    echo  [OK] Created names.txt
)

if not exist "body.html" (
    (
        echo ^<!DOCTYPE html^>
        echo ^<html^>
        echo ^<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"^>
        echo   ^<p^>Hi there,^</p^>
        echo   ^<p^>We noticed your domain ^<strong^>{{domain}}^</strong^> and wanted to reach out.^</p^>
        echo   ^<p^>Reply any time — we'd love to connect.^</p^>
        echo   ^<p style="font-size:11px;color:#999"^>
        echo     ^<a href="{{unsubscribe_url}}"^>Unsubscribe^</a^>
        echo   ^</p^>
        echo ^</body^>
        echo ^</html^>
    ) > body.html
    echo  [OK] Created body.html
)

:: ── 7. Port 25 check via PowerShell ───────────────────────────
echo.
echo  [--] Checking outbound port 25...
set PORT25=UNKNOWN
powershell -NoProfile -Command ^
  "$t = New-Object System.Net.Sockets.TcpClient; ^
   try { $t.Connect('gmail-smtp-in.l.google.com',25); ^
         if ($t.Connected) { Write-Host 'OPEN'; $t.Close() } } ^
   catch { Write-Host 'BLOCKED' }" > "%TEMP%\p25.txt" 2>nul

set /p PORT25=<"%TEMP%\p25.txt"
del "%TEMP%\p25.txt" 2>nul

if "%PORT25%"=="OPEN" (
    echo  [OK] Port 25 is OPEN — you can send directly to mail servers
) else (
    echo  [WARN] Port 25 appears BLOCKED on this network.
    echo.
    echo         Most ISPs and cloud providers block outbound port 25.
    echo         Solutions:
    echo           1. Use a VPS provider that allows SMTP:
    echo              Hetzner / OVH / Contabo / Vultr
    echo           2. Or configure a SOCKS5 proxy in the Settings tab
    echo              of the Web GUI after launch.
)

:: ── 8. Done ────────────────────────────────────────────────────
echo.
echo  ============================================================
echo   Setup complete!
echo  ============================================================
echo.
echo   NEXT STEPS:
echo.
echo   1. Edit mxemails.txt   — add your sender email addresses
echo   2. Edit recipients.txt — add destination email addresses
echo   3. Edit body.html      — customise your email
echo   4. Run:  npm start     — opens Web GUI at localhost:3000
echo.
echo   Other commands:
echo     npm run cli              — interactive command-line mode
echo     npm run generate-dkim   — create DKIM keys for your domain
echo     npm test                — run tests
echo.
echo  ============================================================
echo.
pause
