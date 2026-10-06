@echo off
rem ===========================================================================
rem estimate-run-cost.cmd - Windows launcher for estimate-run-cost.mjs.
rem
rem The cost estimator is a Node ESM script. On Windows the Unix .sh wrapper does
rem not run (no /bin/sh in cmd.exe/PowerShell), and the .mjs shebang is ignored,
rem so if Node is missing a user just sees "'node' is not recognized" with no
rem guidance. This batch wrapper is the Windows equivalent of estimate-run-cost.sh:
rem   1. Node present?         -> else print how to install Node and exit 127.
rem   2. Node >= 20?           -> else print the version problem and exit 3.
rem   3. ingest deps installed -> else offer `npm install` (or do it with --install),
rem                               exit 3 if still missing.
rem Then it hands off to the .mjs, forwarding all (non-wrapper) arguments.
rem
rem Usage (identical to the .mjs, plus the wrapper-only --install flag):
rem   scripts\estimate-run-cost.cmd <runId> [...] --region <r> [--json] [...]
rem   scripts\estimate-run-cost.cmd --install <runId> ...
rem
rem --help is forwarded to the .mjs (prints full usage without needing AWS).
rem ===========================================================================
setlocal enabledelayedexpansion

set "MIN_NODE_MAJOR=20"
set "SCRIPT_DIR=%~dp0"
set "MJS=%SCRIPT_DIR%estimate-run-cost.mjs"
set "INGEST_DIR=%SCRIPT_DIR%..\ingest"

rem --- Strip the wrapper-only --install flag; forward everything else. --------
set "AUTO_INSTALL=0"
set "ARGS="
for %%A in (%*) do (
  if "%%~A"=="--install" (
    set "AUTO_INSTALL=1"
  ) else (
    set "ARGS=!ARGS! %%A"
  )
)

rem --- 1. Node present? ------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed ^(no 'node' on PATH^).>&2
  echo.>&2
  echo This cost estimator requires Node.js %MIN_NODE_MAJOR%+ . Install it one of these ways:>&2
  echo   - winget:             winget install OpenJS.NodeJS.LTS>&2
  echo   - Chocolatey:         choco install nodejs-lts>&2
  echo   - Official installer: https://nodejs.org/en/download>&2
  echo.>&2
  echo After installing, open a new terminal and verify:  node --version>&2
  exit /b 127
)

rem --- 2. Node >= MIN_NODE_MAJOR? --------------------------------------------
for /f "tokens=1 delims=." %%V in ('node -e "process.stdout.write(String(process.versions.node))"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo ERROR: could not determine the Node.js version.>&2
  echo Install Node.js %MIN_NODE_MAJOR%+ : https://nodejs.org/en/download>&2
  exit /b 3
)
if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% (
  echo ERROR: Node.js %MIN_NODE_MAJOR%+ is required, but an older version was found.>&2
  echo This script uses global fetch^(^) and targets the repo's Node 20 toolchain.>&2
  echo Upgrade Node and re-run. ^(winget upgrade OpenJS.NodeJS.LTS, or https://nodejs.org/en/download^)>&2
  exit /b 3
)

rem --- 3. ingest dependencies installed? -------------------------------------
if not exist "%INGEST_DIR%\node_modules\@aws-sdk\client-omics" (
  if "%AUTO_INSTALL%"=="1" (
    echo Installing ingest dependencies ^(cd %INGEST_DIR% ^&^& npm install^) ...>&2
    pushd "%INGEST_DIR%"
    call npm install
    set "NPM_RC=!errorlevel!"
    popd
    if not "!NPM_RC!"=="0" (
      echo npm install failed in %INGEST_DIR%.>&2
      exit /b 3
    )
  ) else (
    echo ERROR: the ingest package's dependencies are not installed.>&2
    echo The estimator loads the AWS SDK from: %INGEST_DIR%\node_modules>&2
    echo.>&2
    echo Install them, then re-run:>&2
    echo   pushd "%INGEST_DIR%" ^&^& npm install ^& popd>&2
    echo.>&2
    echo Or let this wrapper do it for you:>&2
    echo   %~nx0 --install %*>&2
    exit /b 3
  )
)

rem --- 4. Hand off to Node, forwarding all (non-wrapper) args. ---------------
node "%MJS%"%ARGS%
exit /b %errorlevel%
