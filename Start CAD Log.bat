@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 app.py) || (python app.py)
if errorlevel 1 (
  echo.
  echo Python 3 is needed. Install it from https://www.python.org/downloads/ and tick "Add Python to PATH".
  pause
)
