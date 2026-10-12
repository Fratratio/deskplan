@echo off
rem DeskPlan desktop launcher (double-click). Keep this file ASCII-only:
rem cmd.exe misparses UTF-8 Chinese comments under the GBK codepage.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
