@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo [SauerWeb] npm was not found. Install Node.js and try again.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [SauerWeb] Installing dependencies...
    call npm install
    if errorlevel 1 goto :error
)

echo [SauerWeb] Starting the map viewer...
echo [SauerWeb] Open http://127.0.0.1:5173/ if the browser does not open automatically.
call npm run dev -- --host 127.0.0.1 --open
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [SauerWeb] The server could not be started.
pause
exit /b 1
