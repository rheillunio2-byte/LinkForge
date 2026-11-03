@echo off
setlocal
cd /d "%~dp0"
call npm.cmd install
if errorlevel 1 goto failed
call npm.cmd install --prefix frontend
if errorlevel 1 goto failed
call npm.cmd install --prefix backend
if errorlevel 1 goto failed
echo Installation complete. Run start-windows.bat to launch LinkForge.
pause
exit /b 0
:failed
echo Installation failed. Check the error above.
pause
exit /b 1
