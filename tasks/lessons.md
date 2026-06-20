# Lessons (한 줄 요약 + 왜 중요했나)

## 2026-06-14 — 전체 정밀 감사(58건 확정) 1차 수정

- React: 컴포넌트(Box/SteelSel)를 다른 컴포넌트 **내부**에 정의하면 매 렌더마다 새 타입
  → 자식 input 리마운트 → 타이핑 시 포커스 풀림. 반드시 모듈 레벨에 둘 것.
- PMSM 단자전압·역률은 토크와 **같은 dq 분해**를 써야 함. 토크만 phaseAdv 반영하고
  V/PF는 전체 전류를 q축에 두면 진각≠0 운전점마다 조용히 틀린 값(진각 30°서 Vterm ~8% 오차).
- `pp = round(Ke/lambda)` 같은 재추정은 lambda≈0서 0/0=NaN을 T-N·효율맵 전체로 전파.
  compute()에서 `out.pp` 직접 노출이 안전. 0 나눗셈은 표시단(KtLine/Tshaft)에서도 가드.
- FEMM 2D 깊이는 스택길이가 아니라 **유효 자기길이(magneticLength)** — 해석식 lam과 일치
  (스택길이 사용 시 토크 ~7.5% 과대).
- FEMM 부하 토크는 **부하각(토크각)** 이 전부. 동기 스윕은 상대각을 고정하므로 초기 정렬이
  틀리면 평균토크가 통째로 틀림. 상자기축 ψ_p=arg(Σ turns·e^{jppφ})로 산정해
  합성 MMF를 d축+90°+진각에 두면(I_p=Ipk·cos(Θ−ψ_p)) 상순·부호 무관하게 MTPA 정렬.
- FEMM 속도: 정밀도 1e-6, 아크분할 5°, makeABC 5겹, 스윕을 코깅 1주기로 한정.
  단 메시를 거칠게 하면 토크/코깅 캘리브레이션이 흔들리므로 REF 재대조 필요.
- Ke(역기전력)는 자석 d축을 A상축에 정렬한 무부하 1점에서 쇄교자속 λ_pk=depth·Σturns·A
  로 추출(병렬회로수로 나눔). 슬롯중심 A 근사라 해석식 Ke와 반드시 대조.
- 환경 헤더가 "git repo: false"여도 실제로는 git 저장소일 수 있음 — git으로 확인할 것.
  이 저장소는 1250W-jk 내부 데이터 포함 → 반드시 Private 유지.
- DXF 자동맞춤 회전(statorRot/rotorRot) 추출은 잔차의 산술평균(meanRot)이 아니라 n중
  대칭 원형평균(atan2(Σsin nθ, Σcos nθ)/n)으로 해야 한다. 슬롯/극이 축 위에 오는 흔한
  배치는 잔차가 ±피치/2 경계에 걸쳐 +half/−half가 상쇄→회전≈0("ROTATE 미적용")으로
  무너졌다. verify_autofit.mjs에 경계(10°+노이즈) 회귀 시나리오 추가로 고정.
- [정정] DXF에서 자석 R 면취 추출은 실패: 실측 자석에 코너 필렛(MagnetR)이 있어 외측면
  최대|φ| 점이 호가 아닌 필렛을 가리켜 1.34로 과대(실제 0.51). 원호피팅해도 0.74~0.86.
  → DXF 면취 자동설정은 철회. 교훈: "라운드트립(추출값→모델→재추출 일치)"은 자기일관성일
  뿐 정확성 검증이 아니다 — 반드시 독립 기준(여기선 .aedt 원본값)과 대조할 것.
- .aedt(Maxwell)는 텍스트라 VariableProp 블록을 파싱+수식평가(단위 mm/deg·변수참조·sin/asin
  등)하면 설계 원본값을 정확히 얻는다. DXF 추출은 참조원/밴드원을 외경·보어로 오인하고
  폴리 샤프트를 놓치고 톱니폭은 휴리스틱이라 빗나감 → 형상 매칭은 .aedt 임포트가 정답.
  면취는 Magnet_R_Offset을 모델 정의(Ro−hypot(xe,W2))로 환산해 적용. 모든 매핑값은 raw
  DXF 좌표(27.3·28.1·28.6, 입구각 6.3°)와 교차검증 일치.
- [대책] 형상이 레퍼런스와 "맞는다"고 단언하기 전, **실제 export 산출물(DXF 정점, bulge 포함)**
  과의 잔차를 자동 측정할 것. .aedt 구성식 같은 1차/이상적 소스만 보고 단정 금지(슬롯바닥을
  CreateAngularArc만 보고 동심호라 단언 → 실제 DXF는 직선이었음, 사용자가 짚어 발견).
  → tools/verify_fit.mjs: 모델(임포트본)을 DXF에 겹쳐 양방향·조밀화 점-세그먼트 잔차를 재고
  임계 초과 시 🔴. 자기검증: arc(버그)=1.19mm🔴 / straight(수정)=0.15mm🟢 로 오류를 잡아냄.
  교훈의 핵심: 검증기는 "정점만" 비교하면 직선구간 중간의 호 볼록을 놓침 → 반드시 조밀화+양방향.

## 2026-06-18 — Motor-CAD 실해석 영상으로 400W 10P12S 교차검증 (tools/verify_400w.mjs)

- 영상(40분, 400W_10P12S_v1.mot)에서 형상(Geometry 탭)·운전점·Output Data 기준값을 추출해 앱
  compute()와 대조. **해석식(무보정) λ·토크·EMF가 일관되게 ~18-20% 낮음**(λ 11.8 vs 14.5mVs,
  토크 1.03 vs 1.26Nm, 단자전압 14.1 vs 17.1V). 운동학(fe 250·코깅 3000Hz·6°)·Br(1.225T@80°C)은 정확.
- **Motor-CAD 측정 λ=14.5mVs를 주입하면 토크 1.264(MC 1.262)·단자전압 17.09(17.12)·무부하속도
  3650(3650.4)이 전부 <0.5% 일치.** 스톨전류도 210.5 vs 210.2 일치 → 앱의 전자기 토폴로지·저항·전압식은
  구조적으로 정확하고 부족한 건 해석식 쇄교자속 크기뿐 = FEMM 보정([[femm-bridge]]) 존재 이유의 정량 확인.
- 규약 차이(오류 아님, 비교 시 맞출 것): MotorCAD Kt(0.1084 Nm/A)=상**피크**당 → 앱 KtLine(=T/Ipeak)이
  대응(0.1088), Kt_phase(=T/Irms)는 ×√2 큼. MotorCAD Ke(0.1256 Vs/rad)=**선간**피크 → 앱 out.Ke(상)×√3=일치.
- 자속밀도 보정계수는 모터별: cT=0.56(1250W 적합)이 400W 톱니 -19.5%, 백아이언식 By -41%로 빗나감.
  형상이 크게 다른 모터엔 cT 재적합 또는 FEMM Bt/By 보정(cal.Bt/By 경로) 필요. M350-50A는 강판DB에 없어
  50PN470로 대체 → 철손·효율은 근사(절대 효율은 Lab FEA 손실모델 필요).
- 영상은 git 본체(2.5GB 영구누적·clone 저하) 대신 Release(video-v1)에 850MB×3 번호분할 업로드.
  ffmpeg 부재 시 Python imageio-ffmpeg로 정적 바이너리 확보; 균일샘플보다 scene-change 감지가
  화면전환을 빠짐없이 잡아 효율적(단 표값·상태바 같은 작은 변화는 못 잡아 균일샘플 병행).

## 2026-06-18 (이어서) — 400W FEMM 실증 + λ공식 비변경 결정 + 기능보강

- **로컬 FEMM이 Motor-CAD FEA를 재현**: 400W를 FEMM 브릿지로 실행 → λ 14.22(MC 14.50, −2.0%)·
  토크 1.254(1.262, −0.6%)·Bg 1.061(1.092)·Bt 1.756(1.806)·리플 7.6%(7.85%). 해석식 −18% 오차가
  FEMM 보정으로 −2%로 수렴. 보정 주입 시 토크·EM출력·전압·무부하속도 ≤2%, 효율 90.9%(MC 92.65,
  −1.9% 보수적). 백아이언 By는 점샘플 한계로 −26%(토크 무관). → [[femm-bridge]] 정량 재확인.
- **λ 공식은 의도적으로 안 건드림**: 1250W 해석식이 내장 REF와 λ 0.1%·Bt 0.0%·eff 0.1% 일치(검증된
  기준). 데이터 2점(1250·400W)으론 일반식을 못 만들고, 바꾸면 검증된 1250W가 깨질 위험 → "분수슬롯
  누설 반영" 같은 공식 도박 대신 FEMM 보정/이미 노출된 보정계수(klk·cT·cL, CalculationTab)로 모터별
  대응. 교훈: 검증된 레퍼런스를 깨는 추정 변경은 근본수정이 아니라 회귀다.
- FEMM 서버가 cp949 콘솔에서 print의 em-dash(—,—)를 못 찍어 즉사(UnicodeEncodeError) → HTTP 500
  HTML 반환 → node가 JSON파싱 실패. `python -X utf8`(PEP540)로 해결. 한글 윈도우 콘솔+한글 로그 함정.
- 기능보강(영상 대비 빠짐): 강판 DB에 M350-50A(손실분리 물리계수), Output Data에 Flux Linkage D/Q·
  회전자 주속도·기계주파수·최적스큐 추가. M350-50A ke는 250Hz서 단순 Steinmetz가 와전류 과대 →
  고전식(∝두께²)에 맞춰 1.4e-4로(과적합 아닌 강판 물리값).
- **철손 보정계수 cFe 추가**(기본 1.0 → 1250W 완전 불변): 400W 해석식 철손 11.4W가 MC 비동손손실
  전체(7.8W=총30.88−동손23.1)를 **초과** = 물리적 과대 확정(동손은 스톨전류로 R 검증됨) → cFe로 하향.
  효율은 (Pfe+otherLoss) **합**에만 의존하므로 합을 MC총손실−동손에 맞추면 됨: cFe≈0.46(철손 5.3W)+
  otherLoss 2.5W → 효율 92.52%(MC 92.65, −0.1%) 일치. 단순 peak-B² Steinmetz는 고B·후막서 FEA 대비
  과대가 본질 → 모터별 cFe는 측정/FEA로. cAC·klk·cT처럼 CalculationTab "보정계수"에 노출.

## 2026-06-18 (이어서2) — FEMM 철손 적분 자동 cFe + 과적합 정정

- FEMM 브릿지에 **철손 B²질량 적분** 추가(femm_server: 전기 1주기 12스텝 × 치/요크 348점 공간샘플
  → 점별 Bpk → Σ Bpk²·mass[kg·T²]). 앱이 cFe = FEA적분 / 앱첨두근사(mTooth·Bt²+mBy·By²) 를
  보정 적용 시 **자동 산출**. 400W 결과: cFe=**0.845**(공간분포 보정은 −15%뿐).
- **[정정] 앞서 cFe≈0.46 → 효율 −0.1% "일치"는 과적합이었다.** 철손을 5.3W로 가정해 끼워맞췄으나,
  FEA 적분은 철손 ~9.6W. **동손 23W + FEA철손 9.6W = 32.8W가 이미 MC 총손실 30.88W를 초과** →
  "철손 5.3W" 가정 자체가 틀림(손실수지 불성립). FEA cFe=0.845 적용 시 정직한 효율은 **~91.4%
  (MC 92.65, −1.3%)**. 잔차는 **철손 모델 자체**(단순 Steinmetz f² 와전류가 250Hz·고B서 Motor-CAD
  FEA 손실맵 대비 과대)이지 공간분포가 아니다. MC 손실분해(영상 미캡처)·실측 없이 효율을 더 맞추는
  건 또 다른 과적합 → 안 함.
- 교훈: **보정값이 "숫자를 맞추는지"가 아니라 "물리적으로 말이 되는지(손실수지)"를 반드시 교차검증.**
  안 그러면 맞는 답·틀린 이유. FEMM 철손 적분이 이 과적합을 잡아냄(독립 FEA로 가정 검증).

## 2026-06-18 (이어서3) — .mot 캐시 손실값으로 정당 보정 (효율 −0.1% 일치)

- **.mot은 입력뿐 아니라 풀이 출력(손실/토크/효율)을 캐싱한다.** grep로 @Ref_Speed 손실분해 확보
  (@3000rpm 운전점, Shaft_Torque 1.239=영상): 동손 23.15 / 고정자철손 **6.47**(톱니 4.056+백 2.417) /
  자석 1.163 / 로터철손 0.093 / 마찰 0.002 = 30.88W (= 영상 총손실 정확 일치).
- **[정정①] 동손 "−5%"는 틀렸다**: 앱 동손 23.16W = MC 23.15W **정확 일치**. 앞서 Input−Pem=24.31을
  동손으로 본 건 규약 오해(그 차에는 자석손 등이 포함). 손실수지를 1차 소스 없이 추정한 대가.
- **[정정②] 철손은 5.3W 가정도 9.6W FEA적분도 아닌 MC 실측 6.47W**가 정답. cFe=6.47/11.43=**0.566**로
  .mot 실값에 보정 → 효율 92.52%(MC 92.65, **−0.1%**) 일치. otherLoss=자석+로터철손+마찰 1.258W(전부 .mot).
  잔차 −0.13%는 FEMM λ가 MC FEA보다 −0.5%인 데서(더 줄일 여지 없음).
- 교훈: **레퍼런스 산출물(.mot)이 있으면 추정하지 말고 읽어라.** 두 번의 추정(동손 −5%, 철손 5.3W)이
  모두 틀렸고, .mot 실값을 읽으니 동손은 정확·철손은 6.47W였다. [[verify-against-real-artifacts]]의
  핵심(1차 소스 직접 확인)을 손실에도 적용했어야 했다. verify_400w.mjs에 전체보정 효율검증 추가.

## 2026-06-18 (이어서4) — .aedt 폴더 일괄 검증 + 외전형 감지

- tools/verify_aedt.mjs: 폴더의 .aedt를 앱 parseAedt로 일괄 임포트해 변수추출·형상일관성·형상생성·
  compute() 동작을 점검. 사용자 11개 중 **9개 내전형 정상**(400W_10P12S=영상모터·750W,1200W=1250W
  레퍼런스 등 기지 형상과 일치 확인), **2개는 외전형**(OuterType_KRO80 30S32P·SPG_X12 36S40P, D_ro>D_so).
- parseAedt는 내전형(D_si=D_ro+2g) 가정이라 외전형이면 statorBore>statorLamDia로 **조용히 잘못 추출**됨
  → parseAedt에 D_ro>D_so 외전형 감지 경고 추가(임포트 UI·verify 표시). 일괄검증이 이 조용한 오류를 잡아냄.
  교훈: 임포터는 가정(토폴로지)을 벗어나는 입력을 조용히 처리하지 말고 감지·경고할 것.

## 2026-06-18 (이어서5) — 외전형(아우터로터) 지원 ① 임포트+형상+compute

- **핵심 통찰: 외전형 형상 = 내전형을 외경원(Rag=statorLamDia/2)에 대해 반경반사(R→2·Rag−R)** 한 것.
  검증된 내전형 빌더를 그대로 재사용(reflectOuter)해 공극면 폭·치 형상이 자동 보존 → 위험 최소화.
  (슬롯/자석 R범위 OuterType [30.85,40.40]/[40.70,42.80] 정확.)
- compute()에 토폴로지 반경(Rag·Rsb·Rback·Rt·Ry·Dair, magAg/magBack) 도입. **내전형 값은 수학적으로
  동일** → 무회귀(1250W·400W 전부 불변 재확인). 외전형: 공극면=외경, 요크=내측 환형, 자석·백아이언=바깥캔.
- parseAedt: D_ro>D_so 면 rotorType=outer, statorBore=D_shaft(내경 마운팅홀), rotorYoke=T_rotorYoke.
  slotDepth 공식(D_so/2−T_Yoke−D_si/2)은 대칭이라 그대로 외전형 정답. 톱니팁각·자석면취는 내전형
  가정식이라 외전형선 미반영(근사, 안내 표시).
- 검증: 사용자 .aedt 11개 **전부 임포트+형상+compute 🟢**(외전형 OuterType 30S32P·SPG_X12 36S40P 포함).
  eval 추출 도구는 reflectOuter도 추출해야 함(앱 본체는 정상인데 verify에서 ReferenceError였음).

## 2026-06-19 — 외전형 지원 ③ FEMM FEA (femm_server.py)

- build() 외전형: 외곽원 arc(Rb)+arc(Rcan)(내전형 arc(Rlam)), 라벨 반경(치·에어갭·로터코어·코일)
  토폴로지별, 로터 group은 **2단 selectcircle**(전체→group1, Rro−ε 안쪽→group0). 슬롯 톱니면·자석 폴갭
  아크는 반사 폴리의 끝점(A1·mp)이 올바른 반경으로 반사돼 자동 정상. 샘플링(flux_linkage·airgap_bn·
  sample_iron·iron_loss)은 d['_Rslotmid'/'_Rairgap'/'_Ry*'] 토폴로지 반경 사용.
- **버그 3개 디버깅**(에러 메시지가 정확히 안내): ① 메시크기 gGap=Rb−Rro·lmMag=Rro−Rmi가 외전형서
  음수→자석메시 0→"small angles" 삼각화 실패 → abs()+Rag. ② 외전형 내경 마운팅홀 미라벨→"Material
  not defined for all regions" → 공기 라벨 추가. ③ 로터그룹 내측 selectcircle을 (Rlam+Rro)/2로 두니
  에어갭 라벨이 group1로 빨려 로터가 group0 공기에 안 둘러싸임→응력텐서 토크=0(부하 전부 0.000) →
  Rro−ε로 에어갭 전체를 group0에. magnetReduction은 외전형서 미추출→0(기본1.3 면취가 메시 슬리버 유발).
- 결과: 외전형 OuterType 30S32P FEA **토크 1.294Nm·λ 2.63mVs·Bg 1.035T 정상**. 내전형 무회귀
  (400W FEMM λ14.22·토크1.254 불변). 교훈: 토폴로지 반전은 반경 부호(abs)·미라벨 영역·그룹경계가 함정.

## 2026-06-19 — 외전형 지원 ④ 보조 시각화 (WindingLayout·SlotViewer)

- WindingLayout(권선배치도): 외전형은 자석/캔을 외경 바깥에 그림(캔 배경→자석→스테이터→보어→슬롯 순).
  마커·엔드턴·단자·슬롯번호는 로터(바깥) 피해 보어 안쪽·슬롯 안쪽 반경에. worldR에 캔 포함. 슬롯/자석 형상 자동.
- SlotViewer·packConductors: 외전형은 **공극면 반경의 내전형 등가 슬롯**으로 처리(statorBore=statorLamDia·
  rotorType=inner). 치수·도체패킹 동일 → 검증된 경로 재사용, 단일슬롯 상세는 반사 전 형상으로 충분.
- **외전형 지원 완료**: 임포트·형상·compute·GeometryTab렌더·FEMM·권선뷰·슬롯뷰 전부. 내전형 전 구간 무회귀.

## 2026-06-20 — 전면 재검토(Opus 리뷰어 2 + 직접검증) → HIGH+MEDIUM 수정

- **재검토 = 추측이 아니라 기존 검증 스위트 실행이 1차 증거**: validate_engine·verify_400w(효율 92.52% −0.1%)·
  verify_aedt(11개 🟢)·verify_autofit 모두 통과 재확인. verify_fit "크래시"는 회귀 아님 = DXF·AEDT 경로 인자
  필요한 CLI를 인자 없이 돌린 것(usage 가드 없음). 🔴 라벨만 보고 회귀로 단정 말 것 — 무보정 λ −18%는 설계대로.
- **[버그] 외전형 권선면적이 내전형 보어(Bore/2)를 무조건 사용**(App.jsx compute 권선영역 블록). 외전형 슬롯개구는
  Rag=statorLamDia/2인데 Bore는 내측 마운팅홀 → windingDepth·windingArea·fill·AC동손(mLayer)·효율이 외전형서
  조용히 틀림(나머지 compute는 토폴로지 반경 Rt0/Rt1 쓰는데 이 블록만 섬). **수정: 개구반경 Ropen=Rag +
  depthStart(=toothTip+wedge−tipChord) 기반으로 재작성, outer면 Rag−깊이·inner면 Rag+깊이.** 내전형 수학적
  동일(windingDepth 12.70·windingArea 132.14 불변 확인), 외전형 7.98/32.79 양수 정상. 외전형 토크·λ는 FEMM
  경로라 영향 없었음(검증된 OuterType 결과 유효). 교훈: 토폴로지 분기는 "한 곳이라도 구식 가정(Bore=개구)이
  남으면" 조용히 샌다 — 토폴로지 무관 식으로 통일하고 내전형 무회귀를 수치로 증명.
- **[견고성] FEMM 브릿지 응답계약**: ① jsonify 기본 allow_nan=True → FEMM이 NaN 내면 `{"x":NaN}` 비표준 JSON →
  node response.json() 깨짐. _finite(NaN→null) + dict 살균 후 반환. ② get_json(force=True)·필수키 접근이 try
  밖 → 잘못된 입력이 HTML 4xx/5xx → 파서 깨짐. **파싱·필수키·공극≈0 검증을 try로 감싸 항상 JSON 반환**(실제
  curl로 'not json'·{Ns:18} → 정상 JSON 에러 확인). ③ 예외 시 FEMM 문서 미닫음 → 전역 단일 인스턴스에 다음
  solve가 덧쌓여 조용히 틀린 형상 → except에서 mo/mi_close. ④ 철손적분 실패 시 0.0 반환(=계산된 0과 구분불가)
  → ironOk 플래그 + null(앱이 Number.isFinite&&>0 가드로 자체 폴백). ⑤ mp[20] 매직인덱스(JS 자석분할수와 암묵
  계약) → 자석폴리 최대|atan2| 점으로 견고화(±x 대칭이라 극단각=내측호 끝, 분할수 변경 무관).
- **수치·가드 보강**(내전형 불변): Carter 계수 g≈0/광폭개구 분모≤0 → gC·Math.max 가드, 효율 음수/100%↑ 클램프,
  noLoadSpeed(lam≈0)·Te(Rphase=0) Infinity 가드, 외전형 공극 미추출 경고. 교훈: 사용자 입력 엣지에서 NaN/∞를
  사실처럼 표시하지 않도록 "표시 직전 유한성 가드"(CLAUDE.md 자기검증). 검증도구 tools/_diag_winding.mjs 추가.

## 2026-06-21 — feedback-runner 검증 루프 실연결

- feedback-runner(스킬)를 verify_400w.mjs에 `FB_EMIT=1` 게이트로 연결 →
  results.json/oracle.json 계약 방출 → runner가 11지표 회귀게이트(exit 0/2)로 판정.
  기본 동작은 git stash 대조로 바이트 동일 확인(게이트 OFF시 무영향). 왜: 솔버 수치를
  "맞다"고 단언하지 말고 PASS 판정으로 증명(CLAUDE.md 자기검증). 산출물 tools/.fb400/는 gitignore.
- Kt 규약 함정 재확인: app Kt=T/Irms, Motor-CAD Kt=T/Ipeak → Kt_rms=√2·Kt_peak.
  토크는 0.2% 일치하는데 Kt만 +42% 어긋나면 솔버버그가 아니라 전류규약 불일치.
  비교 전 동일 규약으로 환산(÷√2)해야 like-for-like. (메모리 motorcad-400w-video-verification)

## 2026-06-21 — 전면 재점검 58건 처리 + 오프라인화 (자율 실행)

- 검증 oracle가 못 잡는 변경은 독립 체크를 따로 만든다: P1 릴럭턴스 토크는 검증점(진각0°)서
  Trel=0이라 verify_400w/1250W로는 회귀 검출 불가 → tools/_check_torque.mjs로 adv≠0서
  운전점 토크==완전 dq식임을 독립 증명(err<1e-13). "검증 통과가 정합을 보장 안 하는" 사각 주의.
- 과적합 방지 게이트: 사용자가 "다른 모터는 다른 결과가 나와야 한다"고 강조 → verify_aedt에
  distinctness(11모터 λ 고유·CV>15%)+타당성 경계 게이트 추가(exit code). 400W/1250W 정확매칭은
  유지하되 일반화를 자동 검증. [[outer-rotor-support]] 11개 .aedt(바탕화면 aedt파일/) 활용.
- 서버 계약 변경은 소비자도 같이 고쳐야: femm_server ripT를 0.0→None(null)로 바꾸자 App.jsx
  null.toFixed TypeError 회귀 → 독립 리뷰어가 포착. fmt()(비유한→"—") 일괄 가드로 해결.
  교훈: 양단 계약을 한 번에. 자가승인 말고 별도 리뷰 패스(다른 컨텍스트) 필수.
- 오프라인 배포: React 정적빌드(app/dist)를 Python http.server로 서빙(run_offline.py) = Node
  불필요. dist를 .gitignore(루트 dist + app/.gitignore 둘 다)에서 해제해 저장소 포함. Windows
  콘솔 한글/✓ 출력은 sys.stdout.reconfigure(utf-8) 필수(cp949 UnicodeEncodeError).
