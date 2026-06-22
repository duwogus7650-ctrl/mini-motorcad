#!/usr/bin/env python3
"""
YJHMOCAD 오프라인 실행기 (Node.js 불필요).

빌드된 정적 프런트엔드(app/dist/)를 파이썬 표준 라이브러리만으로 로컬 서빙하고
브라우저를 띄운다. geometry/compute/권선 시각화/효율맵/열해석 등 핵심 기능은
전부 브라우저 안에서 동작하므로 백엔드가 필요 없다.

FEMM FEA(선택)는 별도 파이썬 서버(fea/femm_server.py)로 동작하며, FEMM + pyfemm이
설치된 환경에서만 --femm 으로 함께 띄울 수 있다.

사용법:
  python run_offline.py                 # 프런트엔드만 (오프라인, Node 불필요)
  python run_offline.py --femm          # FEMM FEA 서버도 함께 실행
  python run_offline.py --port 8080     # 포트 지정 (기본 5173)
  python run_offline.py --no-browser    # 브라우저 자동 열기 끔
"""
import argparse
import functools
import http.server
import socketserver
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

# Windows 콘솔(cp949)에서 ✓·한글 출력 시 UnicodeEncodeError 방지 — UTF-8로 재설정.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "app" / "dist"


def main():
    ap = argparse.ArgumentParser(description="YJHMOCAD 오프라인 실행기")
    ap.add_argument("--port", type=int, default=5173, help="HTTP 포트 (기본 5173)")
    ap.add_argument("--femm", action="store_true", help="FEMM FEA 서버도 실행 (FEMM+pyfemm 필요)")
    ap.add_argument("--no-browser", action="store_true", help="브라우저 자동 열기 끔")
    args = ap.parse_args()

    if not (DIST / "index.html").exists():
        print("✗ 빌드물(app/dist/)을 찾을 수 없습니다.")
        print("  이 저장소에는 빌드된 app/dist/ 가 포함되어 있어야 합니다.")
        print("  Node.js가 있다면 직접 빌드:  cd app && npm install && npm run build")
        sys.exit(1)

    femm_proc = None
    if args.femm:
        server = ROOT / "fea" / "femm_server.py"
        if not server.exists():
            print("✗ FEMM 서버 스크립트를 찾을 수 없습니다:", server)
            sys.exit(1)
        print("▶ FEMM FEA 서버 시작:", server)
        femm_proc = subprocess.Popen([sys.executable, "-X", "utf8", str(server)])

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
    socketserver.TCPServer.allow_reuse_address = True
    try:
        httpd = socketserver.TCPServer(("127.0.0.1", args.port), handler)
    except OSError as e:
        print(f"✗ 포트 {args.port} 를 열 수 없습니다 ({e}). 다른 포트를 지정하세요: --port 8080")
        if femm_proc:
            femm_proc.terminate()
        sys.exit(1)

    url = f"http://127.0.0.1:{args.port}/"
    print(f"\n✓ YJHMOCAD 실행 중 → {url}")
    if args.femm:
        print("  FEMM 서버: http://127.0.0.1:8765  (앱의 FEMM 검증 버튼에서 사용)")
    print("  종료: Ctrl+C\n")
    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
    finally:
        httpd.server_close()
        if femm_proc:
            femm_proc.terminate()


if __name__ == "__main__":
    main()
