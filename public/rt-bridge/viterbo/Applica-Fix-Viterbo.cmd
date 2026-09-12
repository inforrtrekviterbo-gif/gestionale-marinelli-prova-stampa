@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""%~dp0Applica-Fix-Viterbo.ps1""'"
