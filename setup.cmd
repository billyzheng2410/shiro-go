@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer: https://nodejs.org/
  pause
  exit /b 1
)
echo Setting up local KataGo. Model and engine downloads are needed on first run.
node scripts/setup.mjs %*
if errorlevel 1 (
  echo Setup failed. See the message above. Run npm run doctor for diagnostics.
  pause
  exit /b 1
)
echo Setup complete. Open start.cmd to play.
pause
