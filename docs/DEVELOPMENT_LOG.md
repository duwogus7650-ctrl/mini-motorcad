# 개발 일지 — YJHMOCAD (2026-06-11, Claude와의 세션 기록)

## 1. 요구사항 변천

1. **최초 요청**: "Motor-CAD 화면 스크린샷에서 기초설계 데이터를 추출하는 프로그램"
   → AI 비전 웹앱 제작 (폐기)
2. **방향 전환**: 별도 프로그램 없이 채팅에 스크린샷을 직접 올려 추출하는 방식으로 변경
   → Motor-CAD 전 화면 스크린샷 약 60장 분석, 1250W-jk 전체 사양 확보
3. **진짜 목적 명확화**: "Geometry Radial 탭에서 DXF import 후 옆의 치수 파라미터를
   조절해 형상을 매칭하는 그 워크플로우를, Motor-CAD가 익숙치 않아 내 입맛에 맞게
   재현한 프로그램을 만들고 싶다"
   → Radial Geometry Matcher v1 (DXF 파서 + 파라메트릭 오버레이 + 측정도구)
4. **범위 확장**: "형상 매칭만이 아니라 스크린샷처럼 전부(권선·재질·성능) 뽑아야
   기초설계가 완성된다" → 5탭 YJHMOCAD로 확장, 해석 엔진 검증
5. **Winding 비주얼화**: "슬롯 단면에서 코일·인슐레이터가 변하는 걸 보면서 설정하고
   싶다" → 실시간 도선 패킹 뷰어 구현
6. **나머지 탭 Motor-CAD UI화**: Materials 그리드 / Calculation Drive 패널 /
   Output Data 하위탭 구조로 재구성 — "이후 입맛대로 수정" 단계 진입

## 2. 레퍼런스 모델: 1250W-jk.mot (Ansys Motor-CAD v2024.2.3)

### 형상 (Radial / Axial)
- 18슬롯 / 16극, Parallel Tooth + Surface Parallel SPM
- Stator Lam Dia 114 / Bore 79.66 / Rotor Dia 78.66 / Airgap 0.5
- Tooth Width 4.6 / Slot Depth 14.2 / Slot Opening 0.56 / Tooth Tip 0.5·4°
- Magnet: 두께 3.6, Arc 145°ED, Reduction 1.3, 1분할 / Shaft Ø62(중공)
- Stack 30 (Stator·Rotor·Magnet), Motor Length 70, Magnetic Axial Length 27.9
- EWdg OH Mult F/R 1.5, Shaft Extension F/R 10

### 권선
- 3상 Lap, Turns/Coil 12, Throw 1, 2층, 병렬 1, Delta
- Wire Ø0.5 (Cu Ø0.45) × 17가닥 → Conductors/Slot 408
- Slot Area 160.3 / Cu Fill 0.4049 / Wire Fill 0.4999 / EWdg MLT 32.99
- 상당 72턴, kw1 0.9452, MLT 92.99, 상길이 6695mm
- Liner 0.5 / Coil Divider 0.5 / Conductor Separation 0.02

### 재질
- 코어 20PNX1200F (0.2mm, 7650 kg/m³), 자석 N45UH (Br20 1.32T, -0.12%/°C, μr 1.05)
- 권선 Copper Pure / 활성부 중량 1.657 kg, 전체 2.468 kg

### 구동 / 성능 (3200rpm, 48V, RMS 24.8A 라인, 80°C)
- 토크 3.79 Nm (리플 2.09%), 출력 1244.4W, 효율 95.213%, PF 0.98481
- Kt 0.108 (라인pk) / Ke 0.1256 Vs/rad / λm 15.7 mVs / BEMF 42.09Vpk
- R상 52.58mΩ / Ld 0.1289 / Lq 0.1401 mH / 전류밀도 5.296 A/mm²
- 무부하 3649rpm / 스톨 1369A·147.8Nm / 코깅 2.5MDeg·7680Hz
- 손실 62.57W = 동손 32.34 + 스테이터철손 23.91 + 자석 5.87 + 로터 0.44
- 자속밀도: 공극 평균 0.663 / 피크 1.174, 치 1.808, 치선단 2.41, 백아이언 1.414T
- 관성: 로터 4.445e-4 kg·m²

## 3. 해석 엔진 핵심 수식

- Carter: kc = τs/(τs−γg), γ=(so/g)²/(5+so/g)
- 공극자속: Bg = Br(T)·lm/(lm+μr·kc·g), Br(T) = Br20(1+tc(T−20))
- 권선계수: star-of-slots, 코일 페이저 (e^{jhθgo} − e^{jhθret}), 60° 벨트 배정
- 쇄교자속: λm = (2/π)·kw1·Nph·(α·Bg·klk)·τp·L  [klk=0.97]
- 토크: T = (3/2)·p·λm·Iq,pk / EMF: E = ωe·λm / Ke = p·λm
- 코일피치: τc = throw·τs,mid − wslot,mid/2 / MLT = 2·Lstk + π·τc
- 치 자속: Bt = cT·Bg·τs/tw [cT=0.56, FSCW 캘리브레이션], By = Bt·tw/(2·by)
- 철손: P = (kh·f + ke·f²)·Σ(m·B²) [20PNX1200F: kh=0.0226, ke=4.43e-5]
- 무부하속도 = Vph,avail/(2πλm)·60/p, Vph,avail = Vdc(Delta) 또는 Vdc/√3(Star)
- 스톨: I = Vdc/R_LL, T = Kt,line·I / Km = T/√Pcu / Te = Lq/R
- 역률: Vq=E+RI, Vd=−ωLqI → PF = Vq/|V|

## 4. DXF 구조 (1250W.dxf)

POLYLINE 54개(closed, bulge 원호) + CIRCLE 2개(R39.58/57.57 보조원).
스테이터 적층 1(150정점), 슬롯 권선영역 36(18×좌우), 로터 적층+자석 17.
파서는 POLYLINE/LWPOLYLINE/LINE/CIRCLE/ARC 지원, bulge → 원호 테셀레이션.

## 5. 다음 작업 후보

- AWG/KS 와이어 테이블, Hairpin(각동선) 모드
- 토크-속도 곡선, BEMF/코깅 파형 출력
- 슬롯 코너 R, DXF 자동 정렬(스케일/회전 추정)
- 열등가회로(3-node) 연동, PyQt6 로컬 포팅
