@echo off
chcp 65001 >nul
title YJHMOCAD - FEMM Bridge
cd /d "%~dp0"

echo ============================================
echo   YJHMOCAD - FEMM 브릿지 서버
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [오류] Python 이 설치되어 있지 않습니다.
  echo        https://python.org 에서 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

echo [실행] FEMM 브릿지 서버를 시작합니다 - http://localhost:8765
echo        필요 사항: FEMM 4.2 (64bit) + pip install pyfemm flask flask-cors
echo        코드 수정 후에는 이 창에서 Ctrl+C 로 끄고 다시 실행하세요.
echo.

python fea\femm_server.py

echo.
echo 서버가 종료되었습니다.
pause
