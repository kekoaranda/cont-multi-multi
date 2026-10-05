@echo off
REM Inicia Partida y abre el navegador. Cerrar esta ventana detiene el sistema.
cd /d "%~dp0.."
start "" http://localhost:3000
node --env-file=.env src\app.js
pause
