# Winding 워크플로우 강화 (2026-06-13)

목표: 권선 스펙을 실시간으로 바꿔가며 형상 확인 + Motor-CAD 수준 파라미터 추출.

- [x] 실시간 편집 안정화: 입력 중 NaN 노출 방지 (마지막 유효 결과 유지 + 헤더 경고 배지)
- [x] compute()에 Motor-CAD Winding 출력 파라미터 추가 (Winding Area, Covered/Copper/Impreg Area, Wedge/Liner/Divider Area, Winding Depth, Wire Fill(Wdg), Heavy Build Fill, EWdg MLT)
- [x] WindingTab 계산 결과표 + Output Data Winding 탭에 신규 항목 표시 (참조값 비교열 포함)
- [x] 슬롯 패턴 표를 Motor-CAD 슬롯 번호 기준으로 정렬 (1슬롯 오프셋 보정 — 18슬롯 전부 일치 확인)
- [x] node 교차검증 + vite build 통과 확인

## Review

- 기존 30개 + 신규 12개 항목 교차검증: 최대 오차 wedgeArea 11.2%(절대값 0.18mm², 근사 표기) 외 전부 5% 미만, 도선 면적류는 정확 일치.
- NaN 가드: slotNumber=0 등 비정상 입력에서 마지막 유효 결과 유지 확인.
- vite build 통과 (193.5kB).
- 남은 항목(다음 후보): Tailwind CDN → 로컬 설치, AWG/Metric 와이어 테이블, EWdg Fill(엔드와인딩 모델 필요), 토크리플 파형.

# 2차: Motor-CAD 기능 확장 (2026-06-13, 사용자 승인 순서)

- [x] ① AWG/Metric/SWG 와이어 게이지 테이블 (선택 시 나동선/피복 지름 자동 입력)
- [x] ② EWdg Fill + 동선 체적 (Volume Copper Active/EWdg) 계산·표시
- [x] ③ Wedge Model 옵션 (Wedge / Wound Space / Air) — 패킹·면적·뷰어 연동
- [x] ④ Graphs 탭: BEMF/토크리플/전류 파형, MMF 스텝+고조파, 권선 Phasor (해석식 합성, 추정 표기)
- [x] ⑤ Tailwind CDN → 로컬 설치 (v3 + PostCSS, 오프라인 동작)
- [x] 전체 회귀검증 + build

# 3차: Motor-CAD 충실도 개선 (2026-06-13, 사용자 피드백)

- [x] ① 권선 배치도 (Winding Pattern) — 전체 단면에 코일 엔드턴 아크 + go/return(×/•) + 상색상, 상 필터 (Winding 탭 "권선 배치도" 하위탭)
- [x] ② Radial Pattern 표 부호 규약 Motor-CAD에 맞춤 (절대값 표시 = All Phases)
- [x] ③ 슬롯 단면 도선 패킹 단정화 (디바이더 정렬 + 개구→바닥) — ※ Motor-CAD 독자 렌더러와 완전일치는 아님, 사용자 추가 피드백 필요
- [x] ④ Solve 게이팅 — Solve 눌러야 Output/Graphs/성능표 표시, 입력변경 시 무효화
- [x] 각 단계 commit + build (4 커밋)

# 6차: 효율맵 (2026-06-13)

- [x] data memo에 효율맵 격자(64×44) 계산: 각 (속도,토크)에서 최소손실 id 탐색
      (전류원+전압타원 제약), 동손=1.5·R·(id²+iq²), 철손=정자속 fe스케일 추정
- [x] EffMap 컴포넌트(SVG 히트맵 8밴드 + 컬러바 + 포락선/정격점 오버레이)
- [x] node 검증: 정격점 95.07%, 고속고토크 효율섬, 저속고토크 64%, build 통과

## 6차 Review

- 효율 정의는 compute()와 동일(Pout=Pem−Pfe−기타, Pin=Pem+Pcu).
- 철손은 정격 자속(개방) 기준 fe 스케일 — 약계자 자속감소 미반영(보수적). 추정 표기.
- 정격점 효율맵=95.07%, Output Data 효율과 일치 확인.

# 5차: DXF 자동 형상 추출 (2026-06-13)

- [x] extractGeometry(): 동심원 중심값 → 중심/단위(m→mm) 추정
- [x] 동심원 지름 병합 → OD/보어/샤프트, 닫힌 폴리 무게중심반경 갭분리 → 슬롯/극수
- [x] 슬롯 내반경→보어, 자석 외반경→로터OD→에어갭, 슬롯/자석 각도→회전각
- [x] Geometry 탭 "자동 정렬·형상 추출" 버튼 + 추출 리포트, 파라미터 자동적용(타당값만)
- [x] node 검증(합성 1250W-jk): 18슬롯/16극/OD114/샤프트62/rotorRot7° 정확 추출, build 통과

- [x] 실제 1250W.dxf 검증: 슬롯36→18·샤프트오검출·보어 수정(비율점프 클러스터링 등)
- [x] 축 정렬(슬롯 +X, 회전각 0 정규화, 중심 유지) + 정렬 DXF 내보내기(shapesToDxf)
- [x] 정렬 변환 round-trip 검증: 중심→원점, 슬롯→0°, 자석 회전보정 정확

## 5차 Review

- 합성 사각 슬롯/자석 코너 때문에 보어 79.76·에어갭 0.39(실제 79.66·0.5) — 아크면 DXF는 더 정확.
- 자동적용은 범위 가드(슬롯 3~90, 극 2~80 등) 통과 항목만. 오버레이로 확인 후 NumIn 미세조정 가능.
- 비고: 회전각은 슬롯/자석 무게중심각 기준 — 비대칭 형상은 수동 보정 필요.

# 4차: T-N 곡선 + 실행 편의 (2026-06-13)

- [x] 도선 패킹 치 벽 평행 충전 — 치 벽쪽 빈틈 제거 (사용자 승인)
- [x] 권선배치도 직렬연결선 제거(원복) + U/V/W In/Out 단자 표기
- [x] Drive 패널 전류 라벨 명확화(Line Current) + Phase Current/밀도 표시
- [x] run_gui.bat 더블클릭 실행(자동설치+브라우저 오픈), CRLF
- [x] Graphs: 토크-속도/출력-속도 곡선 (전류원+전압타원 약계자 포락선)
- [x] node 검증: 정토크 3.81Nm→약계자 하강, 정격점 포락선 위, build 통과

## 4차 Review

- T-N: pp=8, Vmax=48V(피크), Imax=20.25A(피크). 정토크 3.811Nm(0~~3650rpm)
  → 약계자(id* −0.3→−18.7) → 출력 ~1420W 피크. 정격점(3200rpm,3.81Nm) 포락선 위 일치.
- 비고: T-N은 해석식 인덕턴스(추정) 기반 — 포화 미반영, 절대값은 FEA 검증 필요.

## 2차 Review

- 회귀 36개 항목: ewdgFill 8.4%(엔드와인딩 근사 모델, 추정 표기) 외 전부 5% 미만.
- volCuActive 35040 정확 일치(3.504E4), volCuEwdg 9624 vs 9633.
- 토크 파형 평균 3.8101 = compute() 평균 3.8100 (고조파 합성 일관성 확인), 리플 1.32% vs FEA 2.09% (슬롯팅 미반영).
- Wedge 3모드: wound→권선깊이 +1mm/패킹 확장, air→웨지면적 0/패킹 유지 확인.
- Tailwind v3 로컬 빌드: CSS 7.27kB 추출, CDN 제거 — 오프라인 동작.
- 비고: 토크리플은 BEMF 고조파×정현전류 성분만 반영(코깅·슬롯팅 제외)이라 FEA보다 낮게 나옴.
