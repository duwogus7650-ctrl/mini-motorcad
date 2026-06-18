// .aedt 폴더 일괄 검증 — 각 파일을 앱 parseAedt 로 임포트해 설계변수 추출·형상 일관성·
// 형상생성·compute() 동작을 점검. App.jsx 실제 함수를 eval 추출(드리프트 방지).
//   node tools/verify_aedt.mjs "<폴더 또는 .aedt 경로>"
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const src = readFileSync("app/src/App.jsx", "utf8");
const slice = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error("slice: " + a); return src.slice(i, j); };
globalThis.D2R = Math.PI / 180; globalThis.MU0 = 4 * Math.PI * 1e-7;
eval(slice("const STEELS = {", "const MAGNETS = {").replace("const STEELS =", "globalThis.STEELS ="));
eval(slice("const MAGNETS = {", "const WIRE_TABLES").replace("const MAGNETS =", "globalThis.MAGNETS ="));
eval(slice("const shoelace =", "// ─── DXF 형상 정합").replace("const shoelace =", "globalThis.shoelace ="));
eval(slice("const reflectOuter =", "function buildSlotPath").replace("const reflectOuter =", "globalThis.reflectOuter ="));
eval(slice("function buildSlotPath(P) {", "function buildMagnetPath(P) {").replace("function buildSlotPath", "globalThis.buildSlotPath = function buildSlotPath"));
eval(slice("function buildMagnetPath(P) {", "const rotPts").replace("function buildMagnetPath", "globalThis.buildMagnetPath = function buildMagnetPath"));
eval(slice("function windingAnalysis(Ns, poles, throw_, Nc) {", "const STEELS = {").replace("function windingAnalysis", "globalThis.windingAnalysis = function windingAnalysis"));
eval(slice("function parseAedt(text) {", "// ─── 형상 생성").replace("function parseAedt", "globalThis.parseAedt = function parseAedt"));
eval(slice("function compute(G, W, M, C, cal) {", "// ─── 기본값").replace("function compute", "globalThis.compute = function compute"));
eval(slice("const GEO0 = {", "const WIND0 = {").replace("const GEO0 =", "globalThis.GEO0 ="));
eval(slice("const WIND0 = {", "const MAT0 = {").replace("const WIND0 =", "globalThis.WIND0 ="));
eval(slice("const MAT0 = {", "const CALC0 = {").replace("const MAT0 =", "globalThis.MAT0 ="));
eval(slice("const CALC0 = {", "const REF = {").replace("const CALC0 =", "globalThis.CALC0 ="));

const arg = process.argv[2] || "C:/Users/user/Desktop/aedt파일";
let files = [];
try {
  if (statSync(arg).isDirectory()) files = readdirSync(arg).filter((f) => /\.aedt$/i.test(f)).map((f) => join(arg, f));
  else files = [arg];
} catch (e) { console.log("경로 오류:", e.message); process.exit(1); }
files.sort();

const fin = (v) => Number.isFinite(v);
const CRIT = [["slotNumber", "슬롯"], ["poleNumber", "극"], ["statorBore", "보어"], ["statorLamDia", "외경"], ["airgap", "에어갭"], ["magnetThickness", "자석두께"], ["stackLength", "축길이"]];
let pass = 0, partial = 0, fail = 0;
const summary = [];

for (const fp of files) {
  const name = fp.split(/[\\/]/).pop();
  let r;
  try { r = parseAedt(readFileSync(fp, "latin1")); }
  catch (e) { console.log(`\n🔴 ${name}\n   parseAedt 예외: ${e.message}`); fail++; summary.push([name, "🔴", "파싱예외"]); continue; }
  if (!r) { console.log(`\n🔴 ${name}\n   설계변수(VariableProp) 0개 — Maxwell .aedt 아니거나 다른 형식`); fail++; summary.push([name, "🔴", "변수없음"]); continue; }

  const g = r.geo;
  const outer = g.rotorType === "outer";
  const missCrit = CRIT.filter(([k]) => !fin(g[k]));
  // 일관성 검사 (추출된 값만)
  const chk = [];
  const c = (cond, ok, bad) => chk.push(cond ? "✓" + ok : "✗" + bad);
  if (fin(g.statorBore) && fin(g.statorLamDia)) c(g.statorBore > 0 && g.statorBore < g.statorLamDia, "보어<외경", `보어${g.statorBore}≥외경${g.statorLamDia}`);
  if (fin(g.airgap)) c(g.airgap > 0 && g.airgap < 5, "에어갭", `에어갭${g.airgap}`);
  if (fin(g.slotNumber)) c(Number.isInteger(g.slotNumber) && g.slotNumber >= 3 && g.slotNumber <= 90, `슬롯${g.slotNumber}`, `슬롯${g.slotNumber}`);
  if (fin(g.poleNumber)) c(Number.isInteger(g.poleNumber) && g.poleNumber % 2 === 0 && g.poleNumber >= 2, `극${g.poleNumber}`, `극${g.poleNumber}(홀수?)`);
  if (fin(g.magnetArcED)) c(g.magnetArcED > 20 && g.magnetArcED <= 180, "자석호", `자석호${g.magnetArcED}`);
  if (!outer && fin(g.statorBore) && fin(g.airgap) && fin(g.shaftDia)) { const rotOD = g.statorBore - 2 * g.airgap; c(rotOD > g.shaftDia, "로터>샤프트", `로터${rotOD.toFixed(1)}≤샤프트${g.shaftDia}`); }
  if (fin(g.toothWidth) && fin(g.slotNumber)) { const Rag2 = (outer ? g.statorLamDia : g.statorBore); const pitch = Math.PI * Rag2 / g.slotNumber; c(g.toothWidth > 0 && g.toothWidth < pitch, "톱니<피치", `톱니${g.toothWidth}≥피치${pitch.toFixed(1)}`); }
  const badChk = chk.filter((x) => x.startsWith("✗"));

  // 형상 생성 + compute (누락은 GEO0/WIND0 기본값으로 보완해 시도)
  const geo = { ...GEO0, ...g, statorRot: 0, rotorRot: 0 };
  const wind = { ...WIND0, ...r.wind };
  let buildOK = "—", computeOK = "—", perf = "";
  try { const sp = buildSlotPath(geo), mp = buildMagnetPath(geo); buildOK = (sp.every((p) => fin(p[0]) && fin(p[1])) && mp.every((p) => fin(p[0]) && fin(p[1]))) ? "✓" : "✗NaN좌표"; }
  catch (e) { buildOK = "✗" + e.message.slice(0, 30); }
  try { const o = compute(geo, wind, MAT0, CALC0, null); computeOK = (fin(o.torque) && fin(o.eff) && fin(o.Bgpk)) ? "✓" : "✗NaN"; perf = `Bg=${o.Bgpk?.toFixed(2)}T λ=${(o.lambda * 1000)?.toFixed(1)}mVs T=${o.torque?.toFixed(2)}Nm`; }
  catch (e) { computeOK = "✗" + e.message.slice(0, 30); }

  const ok = missCrit.length === 0 && badChk.length === 0 && buildOK === "✓" && computeOK === "✓";
  const mark = ok ? "🟢" : missCrit.length <= 2 && badChk.length === 0 ? "🟡" : "🔴";
  if (ok) pass++; else if (mark === "🟡") partial++; else fail++;

  console.log(`\n${mark} ${name}  (${r.varCount}변수, 적용 ${r.applied.length})`);
  console.log(`   사양: ${outer ? "[외전형] " : ""}${fin(g.slotNumber) ? g.slotNumber + "슬롯" : "슬롯?"}/${fin(g.poleNumber) ? g.poleNumber + "극" : "극?"}  외경${fin(g.statorLamDia) ? g.statorLamDia : "?"} 보어${fin(g.statorBore) ? g.statorBore : "?"} 에어갭${fin(g.airgap) ? g.airgap : "?"} 자석t${fin(g.magnetThickness) ? g.magnetThickness : "?"} 축장${fin(g.stackLength) ? g.stackLength : "?"}`);
  if (missCrit.length) console.log(`   ⚠ 미추출(핵심): ${missCrit.map(([, l]) => l).join("·")}`);
  if (r.missing.length) console.log(`   미발견: ${r.missing.join(" · ")}`);
  console.log(`   일관성: ${chk.length ? chk.join(" ") : "(검사할 값 부족)"}`);
  if (r.warnings && r.warnings.length) console.log(`   ⚠ ${r.warnings.join(" / ")}`);
  console.log(`   형상생성 ${buildOK}  ·  compute ${computeOK}  ${perf}`);
  summary.push([name, mark, `${g.slotNumber || "?"}S${g.poleNumber || "?"}P 적용${r.applied.length} 미추출${missCrit.length}`]);
}

console.log("\n════════ 요약 ════════");
for (const [n, m, s] of summary) console.log(`${m} ${n.padEnd(42)} ${s}`);
console.log(`\n🟢 임포트 정상 ${pass} · 🟡 일부누락 ${partial} · 🔴 불가/문제 ${fail}  (총 ${files.length})`);
