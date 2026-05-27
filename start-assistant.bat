@REM Purpose: Windows double-click launcher for the VibeCodingAssistant-ElonMa assistant startup flow.
@REM Author: VibeCodingAssistant-ElonMa distribution tooling
@echo off
setlocal

chcp 65001 >nul
cd /d "%~dp0"

echo ===============================================
echo VibeCodingAssistant-ElonMa Assistant Launcher
echo ===============================================
echo This launcher checks Node.js and npm, then runs:
echo   npm run assistant:start
echo Preflight is executed by assistant:start before launch.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Install Node.js 18 or newer, then try again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found in PATH.
  echo Install Node.js 18 or newer with npm, then try again.
  echo.
  pause
  exit /b 1
)

call npm run assistant:start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Assistant startup failed. Review the messages above.
) else (
  echo Assistant startup completed.
)

echo.
pause
exit /b %EXIT_CODE%
