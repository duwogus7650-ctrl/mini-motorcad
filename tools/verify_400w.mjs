// 400W 10P12S 모터를 앱 compute()에 넣어 Motor-CAD 실해석(영상 캡처) 기준값과 대조.
// 형상: 영상 Geometry 탭(sc_002) / 재질·권선: 400W_10P12S_v1.mot / 운전점: Calculation 탭(a_05).
// compute()는 App.jsx에서 직접 eval 추출 → 실제 코드를 검증(드리프트 방지, verify_fit.mjs와 동일 기법).
import { readFileSync } from "node:fs";
const src = readFileSync("app/src/App.jsx", "utf8");
const slice = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error("slice 실패: " + a); return src.slice(i, j); };
const G = (s, from, to) => eval(slice(from, to).replace(from, "globalThis." + s + " = " + (from.startsWith("function") ? from.replace(/^function\s+\w+/, "function " + s) : "")));
// 의존성 추출 (순서: 상수 → 도형 → 권선 → compute)
globalThis.D2R = Math.PI / 180; globalThis.MU0 = 4 * Math.PI * 1e-7;
eval(slice("const STEELS = {", "const MAGNETS = {").replace("const STEELS =", "globalThis.STEELS ="));
eval(slice("const MAGNETS = {", "const WIRE_TABLES").replace("const MAGNETS =", "globalThis.MAGNETS ="));
eval(slice("const shoelace =", "// ─── DXF 형상 정합").replace("const shoelace =", "globalThis.shoelace ="));
eval(slice("function buildSlotPath(P) {", "function buildMagnetPath(P) {").replace("function buildSlotPath", "globalThis.buildSlotPath = function buildSlotPath"));
eval(slice("function buildMagnetPath(P) {", "const rotPts").replace("function buildMagnetPath", "globalThis.buildMagnetPath = function buildMagnetPath"));
eval(slice("function windingAnalysis(Ns, poles, throw_, Nc) {", "const STEELS = {").replace("function windingAnalysis", "globalThis.windingAnalysis = function windingAnalysis"));
eval(slice("function compute(G, W, M, C, cal) {", "// ─── 기본값").replace("function compute", "globalThis.compute = function compute"));

// ── 400W 입력 ───────────────────────────────────────────────────
const G400 = {
  slotNumber: 12, statorLamDia: 82.3, statorBore: 54.6, toothWidth: 5.6,
  slotDepth: 9.4, toothTipDepth: 0.8, slotOpening: 3, toothTipAngle: 2.3,
  poleNumber: 10, magnetThickness: 2.9, magnetReduction: 0.5, magnetArcED: 142,
  airgap: 0.5, bandingThickness: 0, shaftDia: 42, statorRot: 0, rotorRot: 0, slotBottomShape: "arc",
  stackLength: 28, magnetLength: 28, rotorLamLength: 28, magneticLength: 26.88, motorLength: 70,
};
const W400 = {
  turnsPerCoil: 14, throw: 1, parallelPaths: 1, wireDia: 1.17, copperDia: 1.1,
  strands: 1, connection: "star", linerThk: 0.4, coilDivider: 0.5,
  wedgeDepth: 1.0, condSep: 0.02, wedgeModel: "wedge",
};
const M400 = { steel: "M350-50A", magnet: "N45UH", Br20: 1.32, tcBr: -0.12, mur: 1.05, kh: 0.024, ke: 1.4e-4 };
const C400 = { speed: 3000, Vdc: 48, IlineRms: 8.22, phaseAdv: 0, Tcu: 80, Tmag: 80,
  klk: 0.97, cT: 0.56, cL: 2.6, cLs: 0.33, cAC: 1.0, otherLoss: 0, currentDef: "rms" };

const o = compute(G400, W400, M400, C400, null);            // 해석식(무보정)
// FEMM/실측 λ 보정 시뮬: Motor-CAD 측정 λ=14.5mVs 를 주입했을 때
const oCal = compute(G400, W400, M400, C400, { lam: 0.0145 });

// ── Motor-CAD 기준값 (영상 캡처) ────────────────────────────────
const REF = {
  fe: 250, coggingFreq: 3000, coggingPeriod: 6, Br_used: 1.225,
  Bgpk: 1.092, Bt: 1.806, By: 1.551,
  lambda_mVs: 14.4993, torque: 1.2617, Tshaft: 1.2394, Kt_phase: 0.108419,
  Vterm: 17.117, PF: 0.99619, eff: 92.652, noLoadSpeed: 3650.4,
  Istall: 210.155, Tstall: 22.7847, Pem: 395.95, Pout: 389.38, TRV: 19.949,
};
const row = (name, app, ref, unit, note = "") => {
  const e = ref ? (app - ref) / ref * 100 : 0;
  const mark = Math.abs(e) < 3 ? "🟢" : Math.abs(e) < 10 ? "🟡" : "🔴";
  console.log(`${mark} ${name.padEnd(26)} app=${(+app).toPrecision(5).padStart(11)}  MC=${(+ref).toPrecision(5).padStart(11)}  Δ=${e>=0?"+":""}${e.toFixed(1)}%  ${unit}  ${note}`);
};
console.log("\n════════ 400W 10P12S · 해석식(무보정) vs Motor-CAD FEA ════════");
console.log(`  운전점: 3000rpm · 8.22A RMS · 48V · 진각0° · 80°C   |  kw1=${o.kw1.toFixed(4)}  Nph(series)=${o.NphSeries}  cond/slot=${o.condPerSlot}`);
console.log("─ 운동학(정확해야 함) ─");
row("Fundamental freq", o.fe, REF.fe, "Hz");
row("Cogging freq", o.coggingFreq, REF.coggingFreq, "Hz");
row("Cogging period", o.coggingPeriod, REF.coggingPeriod, "°mech");
console.log("─ 자기회로 ─");
row("Magnet Br (80°C)", o.Br_used, REF.Br_used, "T");
row("Airgap flux peak Bg", o.Bgpk, REF.Bgpk, "T");
row("Tooth flux peak Bt", o.Bt, REF.Bt, "T", "(cT=0.56 보정계수 의존)");
row("Stator BackIron By", o.By, REF.By, "T");
console.log("─ 쇄교자속·토크·EMF (해석식 무보정) ─");
row("Flux linkage λpk", o.lambda * 1000, REF.lambda_mVs, "mVs");
row("Ke (pp·λ, 상)", o.Ke, REF.Ke ?? 0, "Vs/rad", `[MC 0.1256=선간 → app×√3=${(o.Ke*Math.sqrt(3)).toFixed(4)}]`);
row("Torque", o.torque, REF.torque, "Nm");
row("Kt (상)", o.Kt_phase, REF.Kt_phase, "Nm/A");
row("Shaft torque", o.Tshaft, REF.Tshaft, "Nm");
row("Phase voltage rms", o.Vterm, REF.Vterm, "V");
row("Power factor", o.PF, REF.PF, "");
row("No-load speed", o.noLoadSpeed, REF.noLoadSpeed, "rpm");
row("Stall current", o.Istall, REF.Istall, "A");
row("Stall torque", o.Tstall, REF.Tstall, "Nm");
row("EM power", o.Pem, REF.Pem, "W");
row("Output power", o.Pout, REF.Pout, "W", "(철손 강판 대체→근사)");
row("Efficiency", o.eff, REF.eff, "%", "(철손 근사)");
row("TRV", o.TRV, REF.TRV, "kNm/m³");

console.log("\n════════ λ=14.5mVs (Motor-CAD 측정값) 주입 시 — 보정 경로 검증 ════════");
row("Flux linkage λpk", oCal.lambda * 1000, REF.lambda_mVs, "mVs");
row("Torque", oCal.torque, REF.torque, "Nm");
row("Kt (상)", oCal.Kt_phase, REF.Kt_phase, "Nm/A");
row("Phase voltage rms", oCal.Vterm, REF.Vterm, "V");
row("No-load speed", oCal.noLoadSpeed, REF.noLoadSpeed, "rpm");

// ── 전체 보정(FEMM λ·Bt·By·kT + .mot 실측 철손) → 효율 일치 검증 ──
// FEMM 측정: λ=14.22mVs, Bt=1.756, By=1.154, kT=1.012.  .mot 실측 고정자철손 6.47W → cFe=6.47/11.43=0.566.
// otherLoss = .mot 자석손 1.163 + 로터철손 0.093 + 마찰 0.002 = 1.258W. (전부 .mot 실값 — 과적합 아님)
const calF = { lam: 0.01422, Bt: 1.756, By: 1.154, Ld: 0.1134, Lq: 0.1194, kT: 1.012, cFe: 0.566 };
const oF = compute(G400, W400, M400, { ...C400, otherLoss: 1.258 }, calF);
console.log("\n════════ FEMM + .mot 실측 손실 전체보정 — 효율 검증 ════════");
console.log("  .mot 손실분해(@3000rpm): 동손 23.15 / 고정자철손 6.47(톱니4.06+백2.42) / 자석 1.163 / 로터철손 0.093 = 30.88W");
row("동손 Pcu", oF.Pcu, 23.15, "W");
row("고정자 철손 Pfe", oF.Pfe, 6.473, "W", "(cFe=0.566 → MC 실측 일치)");
row("Output power", oF.Pout, REF.Pout, "W");
row("Efficiency", oF.eff, REF.eff, "%");
console.log("");
