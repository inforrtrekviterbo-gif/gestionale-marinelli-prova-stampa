@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ".\MarinelliRTBridge.ps1" -ConfigPath ".\config.json"
pause
