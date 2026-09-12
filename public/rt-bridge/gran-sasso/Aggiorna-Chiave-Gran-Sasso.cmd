@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Aggiorna-Chiave.ps1" -ConfigPath "C:\ProgramData\MarinelliRTBridge\Gran Sasso\config.json" -Task "Marinelli RT Bridge - Gran Sasso"
