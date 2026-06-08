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

    where winget >nul 2>&1
    if !errorlevel! equ 0 (
        echo  [--] Installing Node.js 20 LTS via winget...
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        if !errorlevel! neq 0 (
            echo  [WARN] winget install may have failed. Trying to refresh PATH...
        )
        for /f "tokens=*" %%i in ('where node 2^>nul') do set NODE_PATH=%%i
        if "!NODE_PATH!"=="" (
            if exist "%ProgramFiles%\nodejs\node.exe" (
                set "PATH=%ProgramFiles%\nodejs;!PATH!"
            )
        )
    ) else (
        echo  [WARN] winget is not available on this system.
    )

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

echo  [--] Installing node-gyp...
call npm install -g node-gyp >nul 2>&1

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

:: ── 8. Firewall rule for port 3000 ──────────────────────────────
echo.
echo  [--] Adding Windows Firewall rule for port 3000...
netsh advfirewall firewall show rule name="vps-sender Web GUI" >nul 2>&1
if %errorlevel% equ 0 (
    echo  [OK] Firewall rule for port 3000 already exists
) else (
    netsh advfirewall firewall add rule ^
        name="vps-sender Web GUI" ^
        dir=in action=allow protocol=TCP localport=3000 ^
        description="VPS Sender v2 Web GUI" >nul 2>&1
    if !errorlevel! equ 0 (
        echo  [OK] Firewall: inbound TCP 3000 allowed
    ) else (
        echo  [WARN] Could not add firewall rule ^(run as Administrator for this^).
        echo         To add manually ^(PowerShell as Admin^):
        echo         netsh advfirewall firewall add rule name="vps-sender Web GUI" dir=in action=allow protocol=TCP localport=3000
    )
)

:: ── 9. Public access prompt ──────────────────────────────────────
echo.
echo  ────────────────────────────────────────────────────────────
echo   Web GUI Access
echo  ────────────────────────────────────────────────────────────
echo.
echo   The GUI defaults to localhost:3000 ^(safe for local use^).
echo   To access it from another machine or browser on the network,
echo   bind it to 0.0.0.0 ^(all interfaces^).
echo.
set /p BIND_PUBLIC="  Bind GUI to public network (0.0.0.0)? [y/N]: "

set API_TOKEN=
if /i "!BIND_PUBLIC!"=="y" (
    echo.
    echo  [WARN] Public binding enabled. An API token is strongly recommended.
    set /p API_TOKEN="  Set API token (leave blank to skip — NOT recommended): "
    echo.

    node -e "
      const fs = require('fs'), p = './config.json';
      const c  = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
      c.bindHost = '0.0.0.0';
      const tok = process.argv[2];
      if (tok) c.apiToken = tok;
      fs.writeFileSync(p, JSON.stringify(c, null, 2));
    " -- "!API_TOKEN!"

    echo  [OK] bindHost set to 0.0.0.0
    if "!API_TOKEN!"=="" (
        echo  [WARN] No API token set — the GUI will be open without authentication!
    ) else (
        echo  [OK] API token configured
    )
    set BIND_IS_PUBLIC=1
) else (
    echo  [OK] GUI will bind to localhost ^(127.0.0.1^) — localhost only
    set BIND_IS_PUBLIC=0
)

:: ── 10. PM2 process manager (optional) ──────────────────────────
echo.
echo  ────────────────────────────────────────────────────────────
echo   Process Manager ^(PM2^)
echo  ────────────────────────────────────────────────────────────
echo.
echo   PM2 keeps the server alive after you close this window
echo   and restarts it automatically if it crashes.
echo.
set /p SETUP_PM2="  Install PM2 and start the server now? [y/N]: "

set PM2_ACTIVE=0
if /i "!SETUP_PM2!"=="y" (
    echo.
    echo  [--] Installing PM2 globally...
    call npm install -g pm2
    if !errorlevel! neq 0 (
        echo  [WARN] PM2 install failed. You can try manually: npm install -g pm2
        goto :skip_pm2
    )

    echo  [--] Starting vps-sender via PM2...
    pm2 start ecosystem.config.js
    if !errorlevel! neq 0 (
        echo  [WARN] PM2 start failed. Try: pm2 start ecosystem.config.js
        goto :skip_pm2
    )

    echo  [--] Saving PM2 process list...
    pm2 save

    echo  [OK] PM2 running
    echo  [OK] Commands: pm2 status ^| pm2 logs vps-sender ^| pm2 restart vps-sender
    set PM2_ACTIVE=1
    goto :after_pm2
)

:skip_pm2
echo  [OK] Skipped PM2

:after_pm2

:: ── 11. Determine the URL to display ────────────────────────────
set GUI_URL=http://localhost:3000
set PORT_VAL=3000

for /f "tokens=*" %%p in ('node -e "try{const c=require('./config.json');process.stdout.write(String(c.port||3000))}catch(e){process.stdout.write('3000')}" 2^>nul') do set PORT_VAL=%%p

if "!BIND_IS_PUBLIC!"=="1" (
    :: Try to get the local IP via PowerShell
    for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1 -ExpandProperty IPAddress) 2>$null" 2^>nul') do set LOCAL_IP=%%i
    if "!LOCAL_IP!"=="" set LOCAL_IP=^<your-server-ip^>
    set GUI_URL=http://!LOCAL_IP!:!PORT_VAL!
) else (
    set GUI_URL=http://localhost:!PORT_VAL!
)

:: ── Done ────────────────────────────────────────────────────────
echo.
echo  ============================================================
echo   Setup complete!
echo  ============================================================
echo.
echo   Web GUI:  !GUI_URL!
echo.
echo   NEXT STEPS:
echo.
echo   1. Edit mxemails.txt   — add your sender email addresses
echo   2. Edit recipients.txt — add destination email addresses
echo   3. Edit body.html      — customise your email template

if "!PM2_ACTIVE!"=="1" (
    echo   4. Server is already running via PM2
    echo.
    echo   Useful PM2 commands:
    echo     pm2 logs vps-sender       — live log stream
    echo     pm2 restart vps-sender    — restart after config changes
    echo     pm2 stop vps-sender       — stop the server
) else (
    echo   4. Run:  npm start     — opens the Web GUI
    echo      Or:  npm run cli   — interactive command-line mode
)

echo.
echo   Other commands:
echo     npm run generate-dkim   — create DKIM keys for your domain
echo     npm test                — run tests
echo.
if "%PORT25%"=="BLOCKED" (
    echo  [WARN] Port 25 is blocked — configure a SOCKS5 proxy in the
    echo         Settings tab before starting your first campaign.
    echo.
)
echo  ============================================================
echo.
pause
