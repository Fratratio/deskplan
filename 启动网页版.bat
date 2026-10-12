@echo off
rem Browser / phone mode. ASCII-only comments (GBK codepage safety).
rem Node is resolved from PATH; set NODE_EXE beforehand to point at a specific one.
cd /d "%~dp0"
if not defined NODE_EXE set "NODE_EXE=node"
start "" "%NODE_EXE%" serve.js
ping -n 2 127.0.0.1 >nul
start "" http://localhost:8777
