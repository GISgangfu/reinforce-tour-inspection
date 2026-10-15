@echo off
REM ==================================================================
REM  Safety Inspection Video Processing - service launcher
REM  Same behaviour as serve-forever.cmd: runs in the foreground, and
REM  closing this window stops the service.
REM
REM  Usage:
REM    double-click         start on default port 8899
REM    start.cmd 9001       start on a custom port
REM    close window         stop the service
REM
REM  Status / health check (run in a separate terminal):
REM    node scripts\serve.mjs --status
REM    node scripts\doctor.mjs 8899
REM
REM  This file is ASCII-only ON PURPOSE - see the note at the bottom.
REM ==================================================================
setlocal
cd /d "%~dp0"

set PORT=%~1
if "%PORT%"=="" set PORT=8899

node scripts\supervise.mjs --port %PORT%

echo.
pause
endlocal

REM ------------------------------------------------------------------
REM  Why ASCII-only:
REM  cmd.exe on a Chinese Windows reads .cmd files using the system
REM  code page (GBK), but these files are UTF-8. Chinese text therefore
REM  becomes mojibake AND the stray bytes break line parsing, which
REM  silently breaks commands such as cd /d "%~dp0" (observed: node then
REM  looked for the script in the wrong directory).
REM  All Chinese user-facing messages are printed by the Node scripts
REM  instead, since Node handles UTF-8 correctly.
REM ------------------------------------------------------------------
