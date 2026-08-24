@echo off
REM Launcher for the BAHIS Patient Registry CLI on Windows.
REM
REM The Windows twin of cli.sh. Both exist so the environment defaults live in exactly one
REM place per platform and cannot drift apart. Change a value here and in cli.sh, or neither.
REM
REM stdout is the CLI's JSON result and is meant to be piped or parsed. Diagnostics go to
REM stderr. The exit code is passed through, which is the point: 0 success, 1 error,
REM 2 batch partially verified.

setlocal

REM %~dp0 is this script's directory with a trailing backslash.
set "BAHIS_MCP_HOME=%~dp0"

REM BAHIS_DB_PATH is deliberately NOT defaulted here. config.ts resolves the right location
REM per platform - on Windows %APPDATA%\bahis\bahis3.db, which is where the BAHIS desktop
REM app puts it. Set the variable only to point at a non-standard database.
if not defined BAHIS_MCP_ALLOW_PRODUCTION_WRITES set "BAHIS_MCP_ALLOW_PRODUCTION_WRITES=1"

if not defined BAHIS_MCP_NODE (
  for %%I in (node.exe) do set "BAHIS_MCP_NODE=%%~$PATH:I"
)
if not defined BAHIS_MCP_NODE (
  echo bahis: no usable node found - install Node 22.x or set BAHIS_MCP_NODE>&2
  exit /b 1
)

set "BAHIS_CLI_ENTRY=%BAHIS_MCP_HOME%dist\cli.js"
if not exist "%BAHIS_CLI_ENTRY%" (
  echo bahis: "%BAHIS_CLI_ENTRY%" is missing - run 'npm run build' in "%BAHIS_MCP_HOME%">&2
  exit /b 1
)

"%BAHIS_MCP_NODE%" "%BAHIS_CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
