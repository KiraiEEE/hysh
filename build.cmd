@echo off
rem Hysh build helper. Loads an MSVC x64 environment, then runs the requested build.
rem
rem   build.cmd             debug build   -> src-tauri\target\debug\hysh.exe
rem   build.cmd release     optimized     -> src-tauri\target\release\hysh.exe
rem   build.cmd installer   optimized + NSIS installer (needs Node.js for the Tauri CLI)
rem   build.cmd test        Rust unit tests
setlocal

rem Prefer VS 2022 Build Tools (full C++ libraries); fall back to whatever vswhere finds.
set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
)
if not exist "%VCVARS%" (
  echo Visual Studio C++ build tools were not found. Install "Desktop development with C++".
  exit /b 1
)
call "%VCVARS%" >nul 2>nul

cd /d "%~dp0src-tauri"
if /i "%~1"=="release"   ( cargo build --release & exit /b %errorlevel% )
if /i "%~1"=="test"      ( cargo test & exit /b %errorlevel% )
if /i "%~1"=="installer" ( cd /d "%~dp0" & npx --yes @tauri-apps/cli@2 build & exit /b %errorlevel% )
cargo build
exit /b %errorlevel%
