@echo off
cd /d "%~dp0"
call npm run build
if errorlevel 1 (
  echo The app could not build. Please share this window's error with Codex.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:4177/"
node dist/server.js
if errorlevel 1 pause
