@echo off
REM Instalador de Partida para Windows: abre el instalador de PowerShell con los permisos necesarios.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
