# -*- coding: utf-8 -*-
"""
Mini Motor-CAD ↔ FEMM 브릿지 서버
웹앱이 보낸 설계로 FEMM(pyfemm) 2D FEA를 자동 실행하고 성능을 반환한다.

설치:
    pip install pyfemm flask flask-cors
실행 (FEMM 설치된 Windows에서):
    python femm_server.py
웹앱(localhost:5173)의 'FEMM 해석' 버튼이 http://localhost:8765/solve 로 POST.
"""
import math
import traceback
import pythoncom            # COM 초기화 (Flask 워커 스레드용)
import femm
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

D2R = math.pi / 180.0
MU0 = 4e-7 * math.pi


def rot(pts, a):
    c, s = math.cos(a), math.sin(a)
    return [(x * c - y * s, x * s + y * c) for x, y in pts]


def seg(pr):
    n = len(pr)
    for k in range(n):
        a, b = pr[k], pr[(k + 1) % n]
        femm.mi_addsegment(a[0], a[1], b[0], b[1])


def arc(R):
    # 90° 아크 4개로 원 (180° 반원은 FEMM 내부오류 유발 가능)
    pts = [(R, 0), (0, R), (-R, 0), (0, -R)]
    for x, y in pts:
        femm.mi_addnode(x, y)
    for i in range(4):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % 4]
        femm.mi_addarc(x1, y1, x2, y2, 90, 2.5)


def label(x, y, mat, magdir=0, group=0):
    femm.mi_addblocklabel(x, y)
    femm.mi_selectlabel(x, y)
    femm.mi_setblockprop(mat, 1, 0, '<None>', magdir, group, 0)
    femm.mi_clearselected()


def build(d):
    """형상·재질 구성 (1회). 회전자=group 1."""
    Ns, poles = d['Ns'], d['poles']
    Rlam, Rb, Rro, Rmi, Rsh = d['Rlam'], d['Rb'], d['Rro'], d['Rmi'], d['Rsh']
    murMag = 1.05
    Hc = d['Br'] / (MU0 * murMag)

    femm.openfemm(1)            # 1 = 창 숨김
    femm.newdocument(0)         # 0 = magnetics
    femm.mi_probdef(0, 'millimeters', 'planar', 1e-8, d['depth'], 30)
    femm.mi_getmaterial('Air')
    femm.mi_getmaterial('M-19 Steel')
    femm.mi_addmaterial('PM', murMag, murMag, Hc, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)

    for R in (Rlam, Rb, Rro, Rmi, Rsh):
        arc(R)
    for i in range(Ns):
        seg(rot(d['slotPoly'], d['statorRot'] * D2R + i * 2 * math.pi / Ns))
    for k in range(poles):
        seg(rot(d['magnetPoly'], d['rotorRot'] * D2R + k * 2 * math.pi / poles))

    # 슬롯 코일 재질 (정전류밀도, 처음엔 0 → 위치마다 갱신)
    for i in range(Ns):
        femm.mi_addmaterial('Coil%d' % i, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)

    # 블록 라벨
    label(0, (Rb + d['slotDepth'] + Rlam) / 2, 'M-19 Steel', 0, 0)   # 스테이터 백아이언
    label((Rro + Rb) / 2, 0, 'Air', 0, 0)                           # 에어갭
    label((Rsh + Rmi) / 2, 0.001, 'M-19 Steel', 0, 1)              # 로터 철심
    label(Rsh / 2, 0.001, 'Air', 0, 1)                             # 샤프트(비자성)
    for i in range(Ns):
        a = d['statorRot'] * D2R + i * 2 * math.pi / Ns
        rr = Rb + 0.45 * d['slotDepth']
        label(rr * math.cos(a), rr * math.sin(a), 'Coil%d' % i, 0, 0)
    for k in range(poles):
        a = d['rotorRot'] * D2R + k * 2 * math.pi / poles
        rr = (Rro + Rmi) / 2
        magdir = a / D2R + (180 if k % 2 else 0)
        femm.mi_addblocklabel(rr * math.cos(a), rr * math.sin(a))
        femm.mi_selectlabel(rr * math.cos(a), rr * math.sin(a))
        femm.mi_setblockprop('PM', 1, 0, '<None>', magdir, 1, 0)
        femm.mi_clearselected()

    # 회전자 전체를 group 1로 (에어갭 중간 반경 안쪽 모두 선택)
    femm.mi_selectcircle(0, 0, (Rro + Rb) / 2, 4)
    femm.mi_setgroup(1)
    femm.mi_clearselected()

    femm.mi_makeABC(7, Rlam * 1.25, 0, 0, 0)
    femm.mi_zoomnatural()
    femm.mi_saveas('mini_motorcad.fem')


def set_currents(d, ia, ib, ic):
    """슬롯별 정전류밀도 갱신 (J [MA/m²]). table[slot][phase] 부호 턴수 사용."""
    slotA = d['slotArea'] * 1e-6
    for i in range(d['Ns']):
        t = d['slotTurns'][i]
        netAT = t[0] * ia + t[1] * ib + t[2] * ic
        J = netAT / slotA / 1e6
        femm.mi_modifymaterial('Coil%d' % i, 4, J)   # propnum 4 = J


def solve_torque():
    femm.mi_analyze(0)
    femm.mi_loadsolution()
    femm.mo_clearblock()
    femm.mo_groupselectblock(1)          # 회전자
    T = femm.mo_blockintegral(22)         # 가중 응력텐서 토크
    femm.mo_clearblock()
    return T


def airgap_bn(d, npts=180):
    """에어갭 중간원에서 반경방향 자속밀도 샘플 → 피크."""
    Rg = (d['Rro'] + d['Rb']) / 2
    bmax = 0.0
    for k in range(npts):
        a = 2 * math.pi * k / npts
        x, y = Rg * math.cos(a), Rg * math.sin(a)
        bx, by = femm.mo_getb(x, y)
        bn = bx * math.cos(a) + by * math.sin(a)   # 반경성분
        bmax = max(bmax, abs(bn))
    return bmax


@app.route('/solve', methods=['POST'])
def solve():
    d = request.get_json(force=True)
    print('\n[solve] 요청 수신 — Ns=%s poles=%s  FEMM 구동 시도...' % (d.get('Ns'), d.get('poles')), flush=True)
    pythoncom.CoInitialize()        # 이 워커 스레드에서 COM 사용 준비 (FEMM ActiveX)
    try:
        pp = d['poles'] / 2
        Ipk = d['Ipk']
        nLoad = int(d.get('nLoad', 12))     # 부하 토크 스윕 스텝(전기주기)
        nCog = int(d.get('nCog', 16))       # 코깅 스윕 스텝

        build(d)

        # 1) 부하 토크 (회전자 회전 + 동기 전류) → 평균·리플
        loadT = []
        prevMech = 0.0
        for s in range(nLoad):
            th_e = 2 * math.pi * s / nLoad           # 전기각
            th_m = th_e / pp                          # 기계각
            dMech = (th_m - prevMech) / D2R           # 증분(도)
            if abs(dMech) > 1e-9:
                femm.mi_selectgroup(1)
                femm.mi_moverotate(0, 0, dMech)
                femm.mi_clearselected()
            prevMech = th_m
            ia = Ipk * math.cos(th_e)
            ib = Ipk * math.cos(th_e - 2 * math.pi / 3)
            ic = Ipk * math.cos(th_e + 2 * math.pi / 3)
            set_currents(d, ia, ib, ic)
            loadT.append(solve_torque())
        # 회전자 원위치
        femm.mi_selectgroup(1)
        femm.mi_moverotate(0, 0, -prevMech / D2R)
        femm.mi_clearselected()

        avgT = sum(loadT) / len(loadT)
        ripT = (max(loadT) - min(loadT)) / abs(avgT) * 100 if avgT else 0.0

        # 2) 코깅 (무전류, 회전자 회전 1주기)
        set_currents(d, 0, 0, 0)
        lcm = (d['Ns'] * d['poles']) // math.gcd(d['Ns'], d['poles'])
        cogPeriod = 360.0 / lcm                        # 코깅 1주기(기계도)
        cogT = []
        prev = 0.0
        for s in range(nCog):
            ang = cogPeriod * s / nCog
            dd = ang - prev
            if abs(dd) > 1e-9:
                femm.mi_selectgroup(1)
                femm.mi_moverotate(0, 0, dd)
                femm.mi_clearselected()
            prev = ang
            cogT.append(solve_torque())
        femm.mi_selectgroup(1)
        femm.mi_moverotate(0, 0, -prev)
        femm.mi_clearselected()
        cogPP = (max(cogT) - min(cogT)) * 1000          # mNm p-p

        # 3) 무부하 에어갭 자속밀도 (피크)
        set_currents(d, 0, 0, 0)
        femm.mi_analyze(0)
        femm.mi_loadsolution()
        Bg = airgap_bn(d)
        femm.mo_close()
        femm.mi_close()

        print('[solve] 완료 — 평균토크 %.3f Nm, 리플 %.1f%%, 코깅 %.1f mNm, Bg %.3f T'
              % (avgT, ripT, cogPP, Bg), flush=True)
        return jsonify(ok=True, avgTorque=avgT, torqueRipple=ripT,
                       coggingPP=cogPP, Bg=Bg, loadT=loadT, cogT=cogT)
    except Exception as e:
        print('[solve] 실패 ↓↓↓', flush=True)
        print(traceback.format_exc(), flush=True)
        try:
            femm.closefemm()
        except Exception:
            pass
        return jsonify(ok=False, error=str(e), trace=traceback.format_exc())
    finally:
        pythoncom.CoUninitialize()


@app.route('/ping')
def ping():
    return jsonify(ok=True, msg='FEMM bridge alive')


if __name__ == '__main__':
    print('Mini Motor-CAD ↔ FEMM 브릿지: http://localhost:8765  (Ctrl+C 종료)')
    app.run(host='127.0.0.1', port=8765)
