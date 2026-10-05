@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
REM Runs RepoHub from source. Installs or updates what it needs first.
cd /d "%~dp0"
REM "npm ls" fails when a dependency is missing or out of date (for example after an update).
call npm ls --depth=0 >NUL 2>&1
if errorlevel 1 (
  echo Installing RepoHub dependencies...
  call npm ci || goto :fail
)
call npm start -- %*
if errorlevel 1 goto :fail
goto :eof
:fail
echo.
echo RepoHub could not start. Check the error above and that Node.js 22.12 or newer is installed: https://nodejs.org
pause
