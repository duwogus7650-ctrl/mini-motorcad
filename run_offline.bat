@echo off
chcp 65001 >nul
title YJHMOCAD (오프라인 · Python)
cd /d "%~dp0"

echo ============================================
echo   YJHMOCAD - 오프라인 실행 (Python)
echo   Node.js 불필요 · 더블클릭으로 실행
echo ============================================
echo.

rem --- Python 탐지: python 우선, 없으면 py 런처 ---
set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py"
)
if not defined PY (
  echo [오류] Python이 설치되어 있지 않습니다.
  echo        https://www.python.org 에서 Python 3.8 이상 설치 후 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

rem --- 빌드물 확인 (오프라인 실행에 필수) ---
if not exist "app\dist\index.html" (
  echo [오류] 빌드물(app\dist)이 없습니다.
  echo        Node가 있으면 직접 빌드:  cd app ^&^& npm install ^&^& npm run build
  echo.
  pause
  exit /b 1
)

echo [실행] 잠시 후 브라우저가 자동으로 열립니다.
echo        FEMM 해석까지 함께 쓰려면 이 창을 닫고:  %PY% run_offline.py --femm
echo        종료: 이 창에서 Ctrl+C
echo.

%PY% run_offline.py

echo.
echo 서버가 종료되었습니다.
pause
