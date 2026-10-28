@echo off
rem ==========================================================================
rem  SIGame Local - one-click launcher for Windows
rem  - checks Node.js, installs dependencies on first run, starts the server
rem  - the console prints the LAN link (and a QR code) to share with players
rem  Optional: set PORT=3001 before running to use another port.
rem ==========================================================================
setlocal
cd /d "%~dp0"
title SIGame Local Server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js was not found.
  echo      Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo  [!] Node.js 18 or newer is required. You have:
  node -v
  pause
  exit /b 1
)

rem Install dependencies if missing or if package.json changed since last install.
set NEED_INSTALL=0
if not exist "node_modules" set NEED_INSTALL=1
if exist "node_modules" (
  for /f %%i in ('powershell -NoProfile -Command "if ((Get-Item package.json).LastWriteTime -gt (Get-Item node_modules).LastWriteTime) { 1 } else { 0 }"') do set NEED_INSTALL=%%i
)
if "%NEED_INSTALL%"=="1" (
  echo  Installing dependencies, please wait...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo  [!] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
  rem Touch node_modules so the timestamp check above works next time.
  powershell -NoProfile -Command "(Get-Item node_modules).LastWriteTime = Get-Date" >nul
)

if not exist "packs" mkdir packs

node server\index.js
echo.
echo  Server stopped.
pause
