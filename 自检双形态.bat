@echo off
rem Dual-form self-check: dock bar + tabs + plan window auto-dock + UI details.
rem Result: data\dock.json, shots: data\dock-bar.png / dock-today.png / dock-plan.png
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
set "DP_DOCK=%~dp0data\dock.json"
set "DP_SHOT=1"
if exist "%DP_DOCK%" del "%DP_DOCK%"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
echo Dual-form self-check running... see data\dock.json in ~20 seconds.
ping -n 22 127.0.0.1 >nul
type "%DP_DOCK%"
pause
