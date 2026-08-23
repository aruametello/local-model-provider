@echo off
setlocal EnableExtensions
title (custom) Local Model Provider - Installer

set "SCRIPT_DIR=%~dp0"
set "VSIX=%SCRIPT_DIR%local-model-provider-custom-1.2.11.vsix"

echo ============================================================
echo  (custom) Local Model Provider - portable installer
echo ============================================================
echo.

rem --- Locate the bundled vsix --------------------------------------------
if not exist "%VSIX%" goto missing_vsix

rem --- Locate the VS Code CLI ---------------------------------------------
rem NOTE: we must capture the FULL path from where.exe. Calling a .cmd by bare
rem name (PATH lookup) makes %~dp0 inside it expand to the CURRENT directory,
rem which breaks VS Code's own shim ("%~dp0..\Code.exe").
set "CODE_CMD="
for /f "delims=" %%p in ('where.exe code.cmd 2^>nul') do if not defined CODE_CMD set "CODE_CMD=%%p"
if defined CODE_CMD goto found_code
for /f "delims=" %%p in ('where.exe code 2^>nul') do if not defined CODE_CMD set "CODE_CMD=%%p"
if defined CODE_CMD goto found_code
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "CODE_CMD=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if defined CODE_CMD goto found_code
if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" set "CODE_CMD=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
if defined CODE_CMD goto found_code
if exist "%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd" set "CODE_CMD=%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd"
if defined CODE_CMD goto found_code
goto no_code

:found_code
echo Using VS Code CLI : %CODE_CMD%
echo Installing        : %VSIX%
echo.
"%CODE_CMD%" --install-extension "%VSIX%"
if errorlevel 1 goto install_failed
goto done

:missing_vsix
echo [ERROR] Cannot find the extension package:
echo         %VSIX%
echo.
echo Make sure the whole install_build folder was copied, then re-run.
pause
exit /b 1

:no_code
echo [ERROR] Could not find a VS Code installation.
echo.
echo Searched:
echo   - PATH for code / code.cmd
echo   - %LOCALAPPDATA%\Programs\Microsoft VS Code
echo   - %ProgramFiles%\Microsoft VS Code (and x86)
echo.
echo If VS Code is installed somewhere else, open a terminal from inside
echo the VS Code editor [Terminal: Create New Terminal] and run:
echo   code --install-extension "%VSIX%"
pause
exit /b 1

:install_failed
echo.
echo [ERROR] Installation failed - see the messages above.
pause
exit /b 1

:done
echo.
echo ============================================================
echo  Done! (custom) Local Model Provider is installed.
echo.
echo  Next steps:
echo   1. In VS Code press Ctrl+Shift+P and run [Developer: Reload Window]
echo   2. Configure your server via the command palette:
echo      "(custom) Local Model Provider" - Set API Key, Switch Server Preset, ...
echo ============================================================
pause
exit /b 0
