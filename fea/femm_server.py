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
import cmath
import threading
import traceback
import pythoncom            # COM 초기화 (Flask 워커 스레드용)
import femm
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
_solve_lock = threading.Lock()   # FEMM 전역(단일 인스턴스) 보호: 해석을 직렬화

D2R = math.pi / 180.0
MU0 = 4e-7 * math.pi
ARCSEG = 5.0           # 아크 메시 최대 분할각[deg]
PRECISION = 1e-8       # 솔버 수렴 허용오차. FEMM은 1e-6 이상을 거부("Invalid Precision").
# ── 메시 세밀도 — 절대 mm 가 아니라 "형상 상대값"(모터 크기에 자동 적응).
# 분수는 메시 품질 규칙: 치 가로 ~2요소, 자석 두께 ~3요소 등. 큰/작은 모터 모두 합리적 절점수.
# 에어갭은 자동메시(매우 얇아 강제 크기 지정 시 삼각화 실패) → FEMM이 두께에 맞춰 자동 세분.
FR_STEEL = 1.0 / 6.0   # 철심: 슬롯피치 둘레의 1/6 (치 가로 ~2요소)
FR_MAG = 1.0 / 3.0     # 자석: 자석두께의 1/3 (~3요소)
FR_COIL = 1.0 / 8.0    # 코일: 슬롯깊이의 1/8
FR_EXT = 0.12          # 외부 공기: 라미네이션 외경반경의 12%


def rot(pts, a):
    c, s = math.cos(a), math.sin(a)
    return [(x * c - y * s, x * s + y * c) for x, y in pts]


def seg(pr):
    n = len(pr)
    for x, y in pr:                       # 끝점 노드 먼저 생성 (자동생성 안 됨)
        femm.mi_addnode(x, y)
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
        femm.mi_addarc(x1, y1, x2, y2, 90, ARCSEG)


def label(x, y, mat, magdir=0, group=0, msize=0):
    femm.mi_addblocklabel(x, y)
    femm.mi_selectlabel(x, y)
    auto = 1 if msize <= 0 else 0      # msize>0 이면 자동메시 끄고 그 크기로 고정
    femm.mi_setblockprop(mat, auto, msize, '<None>', magdir, group, 0)
    femm.mi_clearselected()


def rotpt(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c)


def build(d):
    """형상·재질 구성 (1회). 회전자=group 1.
    슬리버 방지: 보어/로터 완전원을 그리지 않고, 슬롯 사이는 치 페이스 아크,
    자석 사이는 폴갭 아크로 경계를 이어 깨끗한 영역을 만든다."""
    Ns, poles = d['Ns'], d['poles']
    Rlam, Rb, Rro, Rmi, Rsh = d['Rlam'], d['Rb'], d['Rro'], d['Rmi'], d['Rsh']
    sp, mp = d['slotPoly'], d['magnetPoly']
    sROT, rROT = d['statorRot'] * D2R, d['rotorRot'] * D2R
    slotDepth = d['slotDepth']
    Rd = Rb + slotDepth
    murMag = 1.05
    Hc = d['Br'] / (MU0 * murMag)

    # 형상 상대 메시 크기[mm] — 이 모터 치수에서 매번 산정 (다른 모터면 자동으로 달라짐)
    gGap = Rb - Rro                                    # 에어갭 두께
    lmMag = max(Rro - Rmi, 1e-3)                       # 자석 두께
    slotPitchArc = 2 * math.pi * Rb / Ns              # 보어 둘레 슬롯피치
    mSteel = slotPitchArc * FR_STEEL
    mMag = lmMag * FR_MAG
    mCoil = slotDepth * FR_COIL
    mExt = Rlam * FR_EXT
    print('[build] 메시[mm] 철심%.2f 자석%.2f 코일%.2f 외부%.2f / 에어갭=자동(g=%.2f)'
          % (mSteel, mMag, mCoil, mExt, gGap), flush=True)

    # 아크각 음수 가드 (넓은 슬롯개구·큰 자석호에서 형상 붕괴 방지)
    slotPitch = 360.0 / Ns
    polePitch = 360.0 / poles
    A1, A1m = sp[0], sp[-1]
    deltaDeg = math.degrees(math.atan2(A1[1], A1[0]))
    mLo, mHi = mp[0], mp[20]
    magHalfDeg = math.degrees(math.atan2(mHi[1], mHi[0]))
    if slotPitch - 2 * deltaDeg <= 1e-3:
        raise ValueError('슬롯 개구각이 슬롯피치보다 큼 (slotOpening 과대) — 형상 불가')
    if polePitch - 2 * magHalfDeg <= 1e-3:
        raise ValueError('자석 호각이 폴피치보다 큼 (magnetArcED 과대) — 형상 불가')

    femm.openfemm(1)            # 1 = 창 숨김 (모델은 mini_motorcad.fem 로 저장됨)
    femm.newdocument(0)
    # 스마트메시 OFF — 켜져 있으면 블록별 메시 크기를 무시하고 에어갭/코너를 자동 미세화해
    # 노드가 20만으로 폭증한다. 끄면 아래 블록 크기(형상 비례)가 그대로 적용됨.
    try:
        femm.mi_smartmesh(0)
        print('[build] smartmesh OFF 적용 (블록 메시 크기 유효)', flush=True)
    except Exception as e:
        print('[build] smartmesh 호출 불가(%s) — pyfemm/FEMM 버전 확인 필요' % e, flush=True)
    femm.mi_probdef(0, 'millimeters', 'planar', PRECISION, d['depth'], 30)
    femm.mi_getmaterial('Air')
    femm.mi_getmaterial('M-19 Steel')
    femm.mi_addmaterial('PM', murMag, murMag, Hc, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)
    for i in range(Ns):
        femm.mi_addmaterial('Coil%d' % i, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)

    # 스테이터 OD (샤프트 원은 생략 — 로터 중심부를 한 영역으로)
    arc(Rlam)

    # 슬롯 폴리곤 + 치 페이스 아크(보어 Rb) — 보어 완전원 생략
    for i in range(Ns):
        seg(rot(sp, sROT + i * 2 * math.pi / Ns))
    for i in range(Ns):
        up = rotpt(A1, sROT + i * 2 * math.pi / Ns)
        lo = rotpt(A1m, sROT + (i + 1) * 2 * math.pi / Ns)
        femm.mi_addnode(up[0], up[1]); femm.mi_addnode(lo[0], lo[1])
        femm.mi_addarc(up[0], up[1], lo[0], lo[1], slotPitch - 2 * deltaDeg, ARCSEG)

    # 자석 폴리곤 + 폴갭 아크(Rmi) — 로터 완전원 생략
    for k in range(poles):
        seg(rot(mp, rROT + k * 2 * math.pi / poles))
    for k in range(poles):
        hi = rotpt(mHi, rROT + k * 2 * math.pi / poles)
        lo = rotpt(mLo, rROT + (k + 1) * 2 * math.pi / poles)
        femm.mi_addnode(hi[0], hi[1]); femm.mi_addnode(lo[0], lo[1])
        femm.mi_addarc(hi[0], hi[1], lo[0], lo[1], polePitch - 2 * magHalfDeg, ARCSEG)

    # 블록 라벨 — 모든 라벨을 축선(x/y축)에서 살짝 비켜 찍는다(OFF). 축 위면 영역 인식 실패.
    OFF = 0.06                                     # rad (~3.4°) 라벨 위치 오프셋
    aT = math.pi / Ns                              # 치 중앙 (이미 비축)
    label((Rb + Rd) / 2 * math.cos(aT), (Rb + Rd) / 2 * math.sin(aT), 'M-19 Steel', 0, 0, mSteel)
    # 에어갭 공기 라벨 — 연결된 단일 영역이므로 1개만. 매우 얇아 자동메시(강제 시 mesh 실패).
    rG = (Rro + 3 * Rb) / 4
    aG = rROT + OFF
    label(rG * math.cos(aG), rG * math.sin(aG), 'Air', 0, 0)        # msize 생략 = 자동
    rR = Rmi * 0.5
    label(rR * math.cos(rROT + OFF), rR * math.sin(rROT + OFF), 'M-19 Steel', 0, 1, mSteel)   # 로터 중심부(샤프트+철심)
    for i in range(Ns):
        a = sROT + i * 2 * math.pi / Ns + OFF
        rr = Rb + 0.45 * slotDepth
        label(rr * math.cos(a), rr * math.sin(a), 'Coil%d' % i, 0, 0, mCoil)
    for k in range(poles):
        ac = rROT + k * 2 * math.pi / poles        # 자석 중심각(자화방향용)
        a = ac + OFF                               # 라벨 위치(비축)
        rr = (Rmi + Rro) / 2
        magdir = math.degrees(ac) + (180 if k % 2 else 0)
        femm.mi_addblocklabel(rr * math.cos(a), rr * math.sin(a))
        femm.mi_selectlabel(rr * math.cos(a), rr * math.sin(a))
        femm.mi_setblockprop('PM', 0, mMag, '<None>', magdir, 1, 0)
        femm.mi_clearselected()

    # 회전자 전체를 group 1로 (에어갭 중간 반경 안쪽)
    femm.mi_selectcircle(0, 0, (Rro + Rb) / 2, 4)
    femm.mi_setgroup(1)
    femm.mi_clearselected()
    femm.mi_makeABC(5, Rlam * 1.25, 0, 0, 0)
    label(Rlam * 1.12 * math.cos(0.06), Rlam * 1.12 * math.sin(0.06), 'Air', 0, 0, mExt)  # 외부 공기(비축)
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


def phase_axis(table, sROT, Ns, pp, p):
    """상 p 의 자기축 전기각[rad] = arg(Σ_i turns_i · e^{j·pp·φ_i}), φ_i=슬롯중심각."""
    S = 0j
    for i in range(Ns):
        S += table[i][p] * cmath.exp(1j * pp * (sROT + i * 2 * math.pi / Ns))
    return cmath.phase(S)


def flux_linkage(d, sROT, p, depth_m):
    """상 p 쇄교자속[Wb] ≈ depth·Σ_i turns_i·A(슬롯중심). go(+)/ret(-) 부호로 코일자속 산출."""
    Ns = d['Ns']
    Rb, Rd = d['Rb'], d['Rb'] + d['slotDepth']
    rr = (Rb + Rd) / 2
    lam = 0.0
    for i in range(Ns):
        t = d['slotTurns'][i][p]
        if t == 0:
            continue
        a = sROT + i * 2 * math.pi / Ns
        A = femm.mo_geta(rr * math.cos(a), rr * math.sin(a))
        lam += t * A
    return lam * depth_m


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
    with _solve_lock:                       # 동시 요청 직렬화 (FEMM 단일 인스턴스)
        pythoncom.CoInitialize()            # 이 워커 스레드에서 COM 사용 준비 (FEMM ActiveX)
        opened = False
        try:
            Ns, poles = d['Ns'], d['poles']
            pp = poles / 2
            Ipk = d['Ipk']
            sROT = d['statorRot'] * D2R
            rROT = d['rotorRot'] * D2R
            adv = float(d.get('phaseAdv', 0.0))             # 위상진각[elec deg]
            P = max(1, int(d.get('parallelPaths', 1)))
            speed = float(d.get('speed', 0.0))              # rpm (역기전력 환산용)
            depth_m = d['depth'] * 1e-3
            nLoad = int(d.get('nLoad', 12))                 # 부하/리플 스윕 스텝
            nCog = int(d.get('nCog', 10))                   # 코깅 스윕 스텝

            build(d)
            opened = True

            # 상 자기축(전기각) — 부하각 정확화 + 쇄교자속 정렬에 사용
            psi = [phase_axis(d['slotTurns'], sROT, Ns, pp, p) for p in range(3)]

            # 코깅/토크리플 1주기 (기계도) = 360/lcm(Ns,poles)
            lcm = (Ns * poles) // math.gcd(int(Ns), int(poles))
            cogPeriod = 360.0 / lcm

            # 로터 절대 회전 관리 (빌드 위치=0 기준, 도)
            state = {'rot': 0.0}

            def set_rotor(target_deg):
                dd = target_deg - state['rot']
                if abs(dd) > 1e-9:
                    femm.mi_selectgroup(1)
                    femm.mi_moverotate(0, 0, dd)
                    femm.mi_clearselected()
                state['rot'] = target_deg

            def field_currents(rotor_mech_deg):
                # 회전자 d축(자석0 N극) 전기각 기준 (90+adv)° 앞에 합성 MMF가 오도록 상전류 산정.
                # 상 MMF축 μ_p = ψ_p + 90°(전기): MMF/벡터퍼텐셜은 자기축 β=arg(S)보다 90° 앞섬(A∝sin).
                # I_p = Ipk·cos(Θ - μ_p) → 균형 3상서 합성 MMF가 정확히 Θ 방향 (상순/부호 무관).
                psir = pp * (rROT + math.radians(rotor_mech_deg))
                # 전기각 증가방향이 회전방향과 반대라 q축은 d축 −90°쪽. 진각>0 → −d로 더 진행(약계자).
                Th = psir - math.radians(90.0 + adv)
                return [Ipk * math.cos(Th - psi[p] - math.pi / 2) for p in range(3)]

            # 1) 무부하: Ke/역기전력 + 에어갭 자속밀도.
            # 쇄교자속 λ_A ∝ sin(β_A − γ) 이므로 d축을 (β_A − 90°)에 둬야 λ 최대(β_A에 두면 λ=0).
            align_deg = math.degrees((psi[0] - math.pi / 2) / pp - rROT)
            set_rotor(align_deg)
            set_currents(d, 0, 0, 0)
            femm.mi_analyze(0)
            femm.mi_loadsolution()
            try:                                                   # 메시 규모를 콘솔에 표시
                print('[solve] 메시: %d 노드 / %d 요소  (목표 2~4만)'
                      % (int(femm.mo_numnodes()), int(femm.mo_numelements())), flush=True)
            except Exception:
                pass
            lam_pk = abs(flux_linkage(d, sROT, 0, depth_m)) / P    # 피크 쇄교자속[Wb]
            Bg = airgap_bn(d)
            Ke = pp * lam_pk                                       # V·s/rad
            we = pp * speed * 2 * math.pi / 60.0
            BEMFpk = we * lam_pk                                   # V (피크 상 역기전력)

            # 2) 부하 토크 (cogPeriod 1주기, 부하각 고정 동기전류) → 평균·리플
            loadT = []
            for s in range(nLoad):
                ang = cogPeriod * s / nLoad
                set_rotor(ang)
                ia, ib, ic = field_currents(ang)
                set_currents(d, ia, ib, ic)
                T = solve_torque()
                loadT.append(T)
                print('[solve] 부하 %d/%d  T=%.3f Nm' % (s + 1, nLoad, T), flush=True)
            avgT = sum(loadT) / len(loadT)
            ripT = (max(loadT) - min(loadT)) / abs(avgT) * 100 if abs(avgT) > 1e-6 else 0.0

            # 3) 코깅 (무전류, cogPeriod 1주기)
            cogT = []
            set_currents(d, 0, 0, 0)
            for s in range(nCog):
                ang = cogPeriod * s / nCog
                set_rotor(ang)
                cogT.append(solve_torque())
                print('[solve] 코깅 %d/%d' % (s + 1, nCog), flush=True)
            cogPP = (max(cogT) - min(cogT)) * 1000          # mNm p-p

            set_rotor(0.0)
            femm.mo_close()
            femm.mi_close()

            print('[solve] 완료 — 평균토크 %.3f Nm, 리플 %.1f%%, 코깅 %.1f mNm, Bg %.3f T, Ke %.4f'
                  % (avgT, ripT, cogPP, Bg, Ke), flush=True)
            return jsonify(ok=True, avgTorque=avgT, torqueRipple=ripT,
                           coggingPP=cogPP, Bg=Bg, Ke=Ke, BEMFpk=BEMFpk,
                           loadT=loadT, cogT=cogT,
                           psiDeg=[math.degrees(x) for x in psi])
        except Exception as e:
            print('[solve] 실패 ↓↓↓ (FEMM 창은 열어둠 — 화면에서 빈 영역 확인)', flush=True)
            print(traceback.format_exc(), flush=True)
            # 진단을 위해 FEMM 창을 닫지 않음 (성공시에는 위에서 닫음)
            return jsonify(ok=False, error=str(e), trace=traceback.format_exc())
        finally:
            pythoncom.CoUninitialize()


@app.route('/ping')
def ping():
    return jsonify(ok=True, msg='FEMM bridge alive')


if __name__ == '__main__':
    print('Mini Motor-CAD ↔ FEMM 브릿지: http://localhost:8765  (Ctrl+C 종료)')
    app.run(host='127.0.0.1', port=8765)
