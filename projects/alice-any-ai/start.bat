@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Установите Node.js 22 или новее с https://nodejs.org/ и откройте этот файл снова.
  pause
  exit /b 1
)
node start.mjs --open --tunnel
pause
