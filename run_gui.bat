@echo off
chcp 65001 >nul
title Mini Motor-CAD
cd /d "%~dp0app"

echo ============================================
echo   Mini Motor-CAD - PMSM 기초설계 도구
echo ============================================
echo.

rem --- Node.js 설치 확인 ---
where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

rem --- 최초 실행 시 의존성 설치 ---
if not exist "node_modules" (
  echo [설치] 최초 실행입니다. 의존성을 설치합니다. ^(수 분 소요^)
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [오류] npm install 에 실패했습니다.
    pause
    exit /b 1
  )
  echo.
)

echo [실행] 개발 서버를 시작합니다.
echo        준비되면 브라우저가 자동으로 열립니다 ^(http://localhost:5173^).
echo        종료하려면 이 창에서 Ctrl+C 또는 창을 닫으세요.
echo.

rem --- 서버 시작 + 준비되면 브라우저 자동 오픈 ---
call npm run dev -- --open

echo.
echo 서버가 종료되었습니다.
pause
