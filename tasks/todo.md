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

## 2차 Review

- 회귀 36개 항목: ewdgFill 8.4%(엔드와인딩 근사 모델, 추정 표기) 외 전부 5% 미만.
- volCuActive 35040 정확 일치(3.504E4), volCuEwdg 9624 vs 9633.
- 토크 파형 평균 3.8101 = compute() 평균 3.8100 (고조파 합성 일관성 확인), 리플 1.32% vs FEA 2.09% (슬롯팅 미반영).
- Wedge 3모드: wound→권선깊이 +1mm/패킹 확장, air→웨지면적 0/패킹 유지 확인.
- Tailwind v3 로컬 빌드: CSS 7.27kB 추출, CDN 제거 — 오프라인 동작.
- 비고: 토크리플은 BEMF 고조파×정현전류 성분만 반영(코깅·슬롯팅 제외)이라 FEA보다 낮게 나옴.
