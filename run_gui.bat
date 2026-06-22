@echo off
chcp 65001 >nul
title YJHMOCAD
cd /d "%~dp0"

echo ============================================
echo   YJHMOCAD - PMSM 기초설계 도구
echo ============================================
echo.

rem --- Node.js 설치 확인 (웹앱 필수) ---
where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

rem --- 앱 모드 브라우저 탐지 (Edge 우선, 없으면 Chrome) ---
set "APPURL=http://localhost:5173"
set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

rem --- FEMM 브릿지: 8765 미사용 + Python 있을 때만 새로 시작 (중복 방지) ---
netstat -an | findstr ":8765" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [FEMM] 브릿지 서버가 이미 실행 중 ^(8765^) - 재사용.
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo [안내] Python 미설치 - FEMM 해석 비활성 ^(웹앱은 정상^).
  ) else (
    echo [FEMM] 브릿지 서버를 새 창에서 시작합니다 ^(FEMM 4.2 + pyfemm 설치 시 동작^).
    start "YJHMOCAD - FEMM Bridge" cmd /k "chcp 65001 >nul & python fea\femm_server.py"
  )
)
echo.

rem --- 웹앱이 이미 5173에서 실행 중이면 새 서버 없이 앱 창만 연다 (중복 방지) ---
netstat -an | findstr ":5173" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [안내] 웹 서버가 이미 5173에서 실행 중 - 기존 서버로 앱 창을 엽니다.
  if defined BROWSER (
    start "" "%BROWSER%" --app=%APPURL% --window-size=1340,900
  ) else (
    start %APPURL%
  )
  echo 앱 창을 열었습니다. 이 창은 닫아도 됩니다.
  timeout /t 3 >nul
  exit /b 0
)

rem --- 최초 실행 시 의존성 설치 ---
cd /d "%~dp0app"
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

echo [실행] 웹앱을 앱 모드(독립 창)로 시작합니다.
echo        준비되면 주소창 없는 독립 창으로 열립니다 ^(http://localhost:5173^).
echo        종료: 이 창에서 Ctrl+C ^(FEMM 창도 함께 닫으세요^).
echo.

rem --- 서버 준비(~4초) 후 독립 창 실행 (PowerShell 로 경로 따옴표 안전 처리) ---
if defined BROWSER (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process -FilePath '%BROWSER%' -ArgumentList '--app=%APPURL%','--window-size=1340,900'"
) else (
  echo [안내] Edge/Chrome 미발견 - 기본 브라우저 탭으로 엽니다.
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process '%APPURL%'"
)

rem --- 서버 시작 (포트 5173 고정 — 위에서 미사용 확인됨) ---
call npm run dev -- --port 5173 --strictPort

echo.
echo 서버가 종료되었습니다.
pause
