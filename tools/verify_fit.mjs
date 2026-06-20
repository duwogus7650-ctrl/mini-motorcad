// 형상 정합 자동 검증 — 모델(.aedt 임포트로 생성)을 실제 DXF에 겹쳐, 외곽선 점마다
// 모델 경계까지의 거리를 측정하고 최대 잔차가 임계(기본 0.3mm)를 넘으면 "빨갛게" 실패한다.
//   node tools/verify_fit.mjs "<경로.dxf>" "<경로.aedt>" [임계mm]
// 핵심: 검증은 .aedt 구성식이 아니라 "실제 export된 DXF 정점"을 기준으로 한다.
// 코드 드리프트 방지: buildSlotPath/buildMagnetPath/rotPts/parseAedt를 App.jsx에서 직접 읽어 평가한다.
import { readFileSync } from "node:fs";
const D2R = Math.PI / 180;

// ── DXF 파서 (diag_dxf 와 동일) ─────────────────────────────────
function polyFromVerts(verts, closed) {
  if (!verts.length) return null;
  const pts = [[verts[0].x, verts[0].y]]; const n = verts.length, segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const p1 = verts[k], p2 = verts[(k + 1) % n], b = p1.b || 0;
    if (Math.abs(b) < 1e-9) { pts.push([p2.x, p2.y]); continue; }
    const theta = 4 * Math.atan(b), dx = p2.x - p1.x, dy = p2.y - p1.y, chord = Math.hypot(dx, dy);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2)), a = Math.atan2(dy, dx), ang = a + Math.sign(b) * (Math.PI / 2 - Math.abs(theta) / 2);
    const cx = p1.x + r * Math.cos(ang), cy = p1.y + r * Math.sin(ang), a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const steps = Math.max(6, Math.ceil(Math.abs(theta) / (Math.PI / 72)));
    for (let s = 1; s <= steps; s++) { const t = a1 + theta * (s / steps); pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  }
  return { type: "poly", pts, closed };
}
function parseDxf(text) {
  const lines = text.split(/\r\n|\r|\n/), pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1]]);
  const shapes = []; let i = 0; while (i < pairs.length) { if (pairs[i][0] === 2 && pairs[i][1].trim() === "ENTITIES") break; i++; }
  const num = v => parseFloat(v);
  while (i < pairs.length) {
    const [code, raw] = pairs[i]; const val = (raw || "").trim();
    if (code === 0 && val === "ENDSEC") break; if (code !== 0) { i++; continue; }
    if (val === "CIRCLE" || val === "ARC") { let cx, cy, r; i++; while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 10) cx = num(v); else if (c === 20) cy = num(v); else if (c === 40) r = num(v); i++; } shapes.push({ type: "circle", cx, cy, r }); }
    else if (val === "LWPOLYLINE") { let closed = false; const verts = []; i++; while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 70) closed = (parseInt(v, 10) & 1) === 1; else if (c === 10) verts.push({ x: num(v), y: 0, b: 0 }); else if (c === 20 && verts.length) verts[verts.length - 1].y = num(v); else if (c === 42 && verts.length) verts[verts.length - 1].b = num(v); i++; } shapes.push(polyFromVerts(verts, closed)); }
    else if (val === "POLYLINE") { let closed = false; const verts = []; i++; while (i < pairs.length && pairs[i][0] !== 0) { if (pairs[i][0] === 70) closed = (parseInt(pairs[i][1], 10) & 1) === 1; i++; } while (i < pairs.length) { const v0 = (pairs[i][1] || "").trim(); if (pairs[i][0] === 0 && v0 === "VERTEX") { const vt = { x: 0, y: 0, b: 0 }; i++; while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 10) vt.x = num(v); else if (c === 20) vt.y = num(v); else if (c === 42) vt.b = num(v); i++; } verts.push(vt); } else if (pairs[i][0] === 0 && v0 === "SEQEND") { i++; while (i < pairs.length && pairs[i][0] !== 0) i++; break; } else break; } shapes.push(polyFromVerts(verts, closed)); }
    else i++;
  }
  return shapes.filter(Boolean);
}

// ── App.jsx 실제 함수 평가 (진짜 코드를 검증) ───────────────────
const src = readFileSync("app/src/App.jsx", "utf8");
const slice = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
eval(slice("function buildSlotPath(P) {", "function buildMagnetPath(P) {").replace("function buildSlotPath", "globalThis.buildSlotPath = function buildSlotPath"));
eval(slice("function buildMagnetPath(P) {", "const rotPts").replace("function buildMagnetPath", "globalThis.buildMagnetPath = function buildMagnetPath"));
eval(slice("const rotPts =", "const shoelace").replace("const rotPts =", "globalThis.rotPts ="));
eval(slice("function parseAedt(text) {", "// ─── 형상 생성").replace("function parseAedt", "globalThis.parseAedt = function parseAedt"));

// ── 기하 유틸 ───────────────────────────────────────────────────
const distSeg = (p, a, b) => {
  const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
  const c1 = wx * vx + wy * vy; if (c1 <= 0) return Math.hypot(wx, wy);
  const c2 = vx * vx + vy * vy; if (c2 <= c1) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  const t = c1 / c2; return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
};
const distPoly = (p, poly, open) => { let m = Infinity; const lim = open ? poly.length - 1 : poly.length; for (let i = 0; i < lim; i++) { const d = distSeg(p, poly[i], poly[(i + 1) % poly.length]); if (d < m) m = d; } return m; };
const distPolys = (p, polys) => { let m = Infinity; for (const poly of polys) { const d = distPoly(p, poly); if (d < m) m = d; } return m; };
// 세그먼트를 step 간격으로 조밀화 (직선 구간 중간점까지 비교해야 호↔직선 차이를 잡는다)
function densify(pts, step, closeIt) {
  const out = []; const n = pts.length; const lim = closeIt ? n : n - 1;
  for (let i = 0; i < lim; i++) { const a = pts[i], b = pts[(i + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const k = Math.max(1, Math.ceil(L / step)); for (let j = 0; j < k; j++) { const t = j / k; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } }
  if (!closeIt) out.push(pts[n - 1]);
  return out;
}

// ── 입력 ────────────────────────────────────────────────────────
const dxfPath = process.argv[2], aedtPath = process.argv[3], TOL = parseFloat(process.argv[4] || "0.3");
const forceBottom = process.argv[5]; // 자기검증용: "arc"|"straight" 강제
if (!dxfPath || !aedtPath) {
  console.log("사용법: node tools/verify_fit.mjs <DXF경로> <AEDT경로> [공차mm=0.3] [arc|straight]");
  console.log('  예: node tools/verify_fit.mjs "C:/Users/user/Desktop/dxf 파일/1250W.dxf" "C:/Users/user/Desktop/aedt파일/750W,1200W.aedt"');
  console.log("  (DXF·AEDT는 .gitignore 대상이라 저장소에 없음 — 바탕화면 폴더에서 경로 지정)");
  process.exit(2);
}
const shapes = parseDxf(readFileSync(dxfPath, "latin1"));
const ex = parseAedt(readFileSync(aedtPath, "latin1"));
const P = { bandingThickness: 0, statorRot: 0, rotorRot: 0, ...ex.geo };
if (forceBottom) P.slotBottomShape = forceBottom;

// DXF 중심(원 중심 중앙값) → 원점 이동
const circs = shapes.filter(s => s.type === "circle");
const med = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const cx = circs.length ? med(circs.map(c => c.cx)) : 0, cy = circs.length ? med(circs.map(c => c.cy)) : 0;
const C = ([x, y]) => [x - cx, y - cy], R = ([x, y]) => Math.hypot(x, y);

const Rb = P.statorBore / 2, Rd = Rb + P.slotDepth;            // 보어·슬롯바닥 반경
const Ro = (P.statorBore - 2 * P.airgap) / 2 - P.bandingThickness, Ri = Ro - P.magnetThickness; // 자석 외/내

const closed = shapes.filter(s => s.type === "poly" && s.closed && s.pts.length >= 10).sort((a, b) => b.pts.length - a.pts.length);
const lam = closed[0];
const lamC = densify(lam.pts.map(C), 0.15, true);   // DXF 라미네이션(닫힘) 조밀화
const STEP = 0.15;

// ── 1) 고정자 슬롯 정합 (양방향·조밀화) ─────────────────────────
const lamInner = lamC.filter(p => { const r = R(p); return r >= Rb - 0.3 && r <= Rd + 0.15; }); // 슬롯바닥(Rd)이 최대 — 위는 요크
const pitchS = 2 * Math.PI / P.slotNumber;
const buildSlots = rot => { const a = []; for (let k = 0; k < P.slotNumber; k++) a.push(rotPts(buildSlotPath(P), rot + k * pitchS)); return a; };
// 정렬: DXF→모델 평균거리 최소화
let bestRotS = 0, bestMean = Infinity;
for (let a = 0; a < pitchS; a += pitchS / 120) {
  const slots = buildSlots(a); let sum = 0;
  for (const p of lamInner) sum += Math.min(distPolys(p, slots), Math.abs(R(p) - Rb));
  if (sum < bestMean) { bestMean = sum; bestRotS = a; }
}
// 최종 잔차: DXF→모델 + 모델→DXF (양방향), 슬롯바닥대 별도
const slots = buildSlots(bestRotS);
const modelPts = slots.flatMap(poly => densify(poly, STEP, false)).filter(p => R(p) > Rb + 0.3); // 입구 mouth 제외
const isBot = p => R(p) > Rb + P.slotDepth * 0.5;
let sMax = 0, sBot = 0, worst = null;
for (const p of lamInner) { const d = Math.min(distPolys(p, slots), Math.abs(R(p) - Rb)); if (d > sMax) { sMax = d; worst = { dir: "DXF→M", p, d }; } if (isBot(p) && d > sBot) sBot = d; }
for (const m of modelPts) { const d = distPoly(m, lamC); if (d > sMax) { sMax = d; worst = { dir: "M→DXF", p: m, d }; } if (isBot(m) && d > sBot) sBot = d; }
if (process.env.DBG) console.log(`  [DBG] worst ${worst.dir} pt=(${worst.p[0].toFixed(2)},${worst.p[1].toFixed(2)}) r=${R(worst.p).toFixed(2)} a=${(Math.atan2(worst.p[1],worst.p[0])/D2R).toFixed(1)}° d=${worst.d.toFixed(3)}`);

// ── 2) 자석 정합 (양방향). 모델은 코너필렛 없어 ~0.3mm 기준차 허용 ──
const magPolys = closed.filter(s => { const rs = s.pts.map(p => R(C(p))); const rmin = Math.min(...rs), rmax = Math.max(...rs); return rmax <= Ro + 0.8 && rmax >= Ro - 1.5 && rmin >= Ri - 1.5 && s.pts.length < 200; });
const pitchM = 2 * Math.PI / P.poleNumber;
const buildMags = rot => { const a = []; for (let k = 0; k < P.poleNumber; k++) a.push(rotPts(buildMagnetPath(P), rot + k * pitchM)); return a; };
const magDxf = magPolys.map(s => densify(s.pts.map(C), STEP, true));
const magDxfPts = magDxf.flat();
let mMax = Infinity, bestRotM = 0;
if (magDxfPts.length) {
  let bm = Infinity;
  for (let a = 0; a < pitchM; a += pitchM / 120) { const mags = buildMags(a); let sum = 0; for (const p of magDxfPts) sum += distPolys(p, mags); if (sum < bm) { bm = sum; bestRotM = a; } }
  const mags = buildMags(bestRotM);
  mMax = 0; for (const p of magDxfPts) mMax = Math.max(mMax, distPolys(p, mags));
  const modelMagPts = mags.flatMap(poly => densify(poly, STEP, true));
  for (const m of modelMagPts) mMax = Math.max(mMax, distPolys(m, magDxf));
}

// ── 보고 ────────────────────────────────────────────────────────
const TOL_MAG = TOL + 0.3;  // 코너필렛(모델 미지원) 허용
console.log(`파일: ${dxfPath.split("\\").pop()}  ·  슬롯바닥모드=${P.slotBottomShape}  ·  임계 고정자 ${TOL} / 자석 ${TOL_MAG}mm`);
console.log(`고정자 슬롯: 최대잔차 ${sMax.toFixed(3)}mm  [슬롯바닥대 ${sBot.toFixed(3)}mm]  정렬 ${(bestRotS / D2R).toFixed(1)}°  ${sMax <= TOL ? "🟢" : "🔴"}`);
console.log(`자석      : 최대잔차 ${mMax === Infinity ? "—(자석폴리 없음)" : mMax.toFixed(3) + "mm"}  정렬 ${(bestRotM / D2R).toFixed(1)}°  (폴리 ${magPolys.length}개)  ${mMax === Infinity || mMax <= TOL_MAG ? "🟢" : "🔴"}`);
const ok = sMax <= TOL && (mMax === Infinity || mMax <= TOL_MAG);
console.log(`\n결과: ${ok ? "🟢 형상 정합 OK" : "🔴 불일치 — 위 빨강 항목 확인"}`);
process.exit(ok ? 0 : 1);
