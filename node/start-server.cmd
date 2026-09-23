@echo off
rem Starts the local accelerator for the combat simulator site (keep this window open).
cd /d "%~dp0"
node server.mjs %*
pause
