@echo off
rem Double-click = audit every shortcut on the Desktop; report opens in Notepad.
rem ASCII-only content on purpose: cmd mangles Chinese paths under the GBK codepage.
rem Python is resolved from PATH; set PY_EXE beforehand to point at a specific one.
cd /d "%~dp0"

if not defined PY_EXE set "PY_EXE=python"

"%PY_EXE%" tools\shortcut_doctor.py --scan-desktop --out data\shortcut-report.txt

if exist "data\shortcut-report.txt" (
  start "" notepad "data\shortcut-report.txt"
) else (
  echo report not generated
  pause
)
