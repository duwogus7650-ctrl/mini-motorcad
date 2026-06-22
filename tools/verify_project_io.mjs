// .mmcad 프로젝트 저장/열기 데이터계약 검증 (App.jsx saveProject/loadProject 로직 복제)
// 실행: node tools/verify_project_io.mjs
import assert from "node:assert";

// App.jsx 기본값 형태 모사(키 누락 방어 오버레이 검증용)
const GEO0 = { slotNumber: 18, poleNumber: 16, statorBore: 79.66, slotDepth: 14.2, toothWidth: 4.6, slotBottomShape: "arc", rotorType: "inner" };
const WIND0 = { turnsPerCoil: 12, parallelPaths: 1, wireDia: 0.5, copperDia: 0.45, strands: 17, coilDivider: 0.5 };
const MAT0 = { steel: "20PNX1200F", magnet: "N45UH", Br20: 1.32, mur: 1.05 };
const CALC0 = { speed: 3200, Vdc: 48, IlineRms: 24.8, klk: 0.97, cT: 0.56 };
const THERM0 = { ambient: 40, flow: 0 };

// saveProject 직렬화(브라우저 new Date()만 고정 대체)
const saveProject = (geo, wind, mat, calc, therm, femmCal, res) => JSON.stringify({
  format: "YJHMOCAD", version: 1, savedAt: "2026-06-22T00:00:00.000Z", app: "YJHMOCAD",
  geometry: geo, winding: wind, materials: mat, calculation: calc, thermal: therm,
  femmCal: femmCal && Number.isFinite(femmCal.lam) ? femmCal : null,
  results: res ? JSON.parse(JSON.stringify(res, (k, v) => (k === "wa" ? undefined : v))) : null,
}, (k, v) => (k === "wa" ? undefined : v), 2);

// loadProject 복원(상태 setter 대신 객체 반환)
const loadProject = (text) => {
  const obj = JSON.parse(text);
  const g = obj.geometry, w = obj.winding, m = obj.materials, c = obj.calculation;
  if (!g || !w || !m || !c) throw new Error("invalid mmcad");
  return {
    geo: { ...GEO0, ...g }, wind: { ...WIND0, ...w }, mat: { ...MAT0, ...m },
    calc: { ...CALC0, ...c }, therm: { ...THERM0, ...(obj.thermal || {}) },
    femmCal: obj.femmCal && Number.isFinite(obj.femmCal.lam) ? obj.femmCal : null,
  };
};

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, "FAIL: " + name); console.log("✅ " + name); pass++; };

// 1) 완전 라운드트립 — 저장한 그대로 복원(형상/권선/재질/운전점/열/FEMM보정)
const geo = { ...GEO0, slotNumber: 12, poleNumber: 10, slotBottomShape: "straight", coilDividerNote: undefined };
const wind = { ...WIND0, turnsPerCoil: 14, wireDia: 1.1, copperDia: 1.05, strands: 1, coilDivider: 3 };
const mat = { ...MAT0, magnet: "N48H" };
const calc = { ...CALC0, IlineRms: 8.2, cT: 0.61 };
const therm = { ...THERM0, ambient: 25 };
const femmCal = { lam: 0.0142, ke: 0.123, kT: 1.01, cFe: 0.84, source: "FEMM" };
const res = { torque: 1.21, Jrms: 9.47, wa: { kw: () => 1 } };  // wa 함수는 직렬화에서 제외돼야

const r1 = loadProject(saveProject(geo, wind, mat, calc, therm, femmCal, res));
ok("형상 라운드트립", JSON.stringify(r1.geo) === JSON.stringify({ ...GEO0, ...geo }));
ok("권선 라운드트립(동선경 1.05·디바이더 3 보존)", r1.wind.copperDia === 1.05 && r1.wind.coilDivider === 3 && r1.wind.turnsPerCoil === 14);
ok("재질·운전점·열 라운드트립", r1.mat.magnet === "N48H" && r1.calc.IlineRms === 8.2 && r1.therm.ambient === 25);
ok("FEMM 보정 보존(λ 유효)", r1.femmCal && r1.femmCal.lam === 0.0142 && r1.femmCal.source === "FEMM");
ok("results 스냅샷의 wa 함수 직렬화 제외", JSON.parse(saveProject(geo, wind, mat, calc, therm, femmCal, res)).results.wa === undefined);

// 2) 부분 파일(구버전·키 누락) → 기본값으로 채움
const partial = JSON.stringify({ format: "YJHMOCAD", geometry: { slotNumber: 24 }, winding: { turnsPerCoil: 5 }, materials: {}, calculation: { speed: 1000 } });
const r2 = loadProject(partial);
ok("누락 형상키 기본값 보강", r2.geo.slotNumber === 24 && r2.geo.statorBore === GEO0.statorBore && r2.geo.rotorType === "inner");
ok("누락 thermal → THERM0", r2.therm.ambient === THERM0.ambient);

// 3) femmCal 무효/부재 → null
ok("femmCal 없음 → null", loadProject(saveProject(geo, wind, mat, calc, therm, null, null)).femmCal === null);
ok("femmCal lam NaN → null", loadProject(saveProject(geo, wind, mat, calc, therm, { lam: NaN }, null)).femmCal === null);

// 4) 잘못된 파일 → 거부
let rejected = false;
try { loadProject(JSON.stringify({ format: "x", geometry: { slotNumber: 1 } })); } catch { rejected = true; }
ok("필수키 누락 파일 거부", rejected);

console.log(`\n✅ PASS — ${pass}/10 프로젝트 저장/열기 데이터계약 검증 통과`);
