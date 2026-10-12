@echo off
rem Integration self-check: widget + plan share one data source.
rem Result: data\verify.json
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
set "DP_VERIFY=%~dp0data\verify.json"
if exist "%DP_VERIFY%" del "%DP_VERIFY%"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
echo Self-check running... see data\verify.json in ~15 seconds.
ping -n 16 127.0.0.1 >nul
type "%DP_VERIFY%"
pause
