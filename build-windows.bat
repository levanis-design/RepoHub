@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
REM Builds release\RepoHub-Setup-<version>.exe and a portable exe.
cd /d "%~dp0"
call npm ls --depth=0 >NUL 2>&1
if errorlevel 1 call npm ci || goto :fail
call npm run dist || goto :fail
echo.
echo Done. The installer is in the release folder.
pause
goto :eof
:fail
echo Build failed. See the messages above.
pause
