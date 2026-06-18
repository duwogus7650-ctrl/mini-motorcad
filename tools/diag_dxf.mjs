// 실제 DXF 진단 — App.jsx의 parseDxf+polyFromVerts+extractGeometry를 그대로 재현해
// 추출 결과와 "형상 자동 맞춤"(runFit)이 만들 변환을 출력한다.
//   node tools/diag_dxf.mjs "<경로.dxf>"
import { readFileSync } from "node:fs";
const D2R = Math.PI / 180;
const path = process.argv[2];
if (!path) { console.error("사용법: node tools/diag_dxf.mjs <경로.dxf>"); process.exit(2); }

function polyFromVerts(verts, closed) {
  if (!verts.length) return null;
  const pts = [[verts[0].x, verts[0].y]];
  const n = verts.length, segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const p1 = verts[k], p2 = verts[(k + 1) % n], b = p1.b || 0;
    if (Math.abs(b) < 1e-9) { pts.push([p2.x, p2.y]); continue; }
    const theta = 4 * Math.atan(b);
    const dx = p2.x - p1.x, dy = p2.y - p1.y, chord = Math.hypot(dx, dy);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const a = Math.atan2(dy, dx);
    const ang = a + Math.sign(b) * (Math.PI / 2 - Math.abs(theta) / 2);
    const cx = p1.x + r * Math.cos(ang), cy = p1.y + r * Math.sin(ang);
    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const steps = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 36)));
    for (let s = 1; s <= steps; s++) { const t = a1 + theta * (s / steps); pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  }
  return { type: "poly", pts, closed };
}
function parseDxf(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1]]);
  const shapes = []; let i = 0;
  while (i < pairs.length) { if (pairs[i][0] === 2 && pairs[i][1].trim() === "ENTITIES") break; i++; }
  const num = (v) => parseFloat(v);
  while (i < pairs.length) {
    const [code, raw] = pairs[i]; const val = (raw || "").trim();
    if (code === 0 && val === "ENDSEC") break;
    if (code !== 0) { i++; continue; }
    if (val === "LINE") {
      let x1, y1, x2, y2; i++;
      while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 10) x1 = num(v); else if (c === 20) y1 = num(v); else if (c === 11) x2 = num(v); else if (c === 21) y2 = num(v); i++; }
      if ([x1, y1, x2, y2].every(Number.isFinite)) shapes.push({ type: "poly", pts: [[x1, y1], [x2, y2]], closed: false });
    } else if (val === "CIRCLE" || val === "ARC") {
      let cx, cy, r, a1 = 0, a2 = 360; const isArc = val === "ARC"; i++;
      while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 10) cx = num(v); else if (c === 20) cy = num(v); else if (c === 40) r = num(v); else if (c === 50) a1 = num(v); else if (c === 51) a2 = num(v); i++; }
      shapes.push(isArc ? { type: "arc", cx, cy, r, a1: a1 * D2R, a2: a2 * D2R } : { type: "circle", cx, cy, r });
    } else if (val === "LWPOLYLINE") {
      let closed = false; const verts = []; i++;
      while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 70) closed = (parseInt(v, 10) & 1) === 1; else if (c === 10) verts.push({ x: num(v), y: 0, b: 0 }); else if (c === 20 && verts.length) verts[verts.length - 1].y = num(v); else if (c === 42 && verts.length) verts[verts.length - 1].b = num(v); i++; }
      shapes.push(polyFromVerts(verts, closed));
    } else if (val === "POLYLINE") {
      let closed = false; const verts = []; i++;
      while (i < pairs.length && pairs[i][0] !== 0) { if (pairs[i][0] === 70) closed = (parseInt(pairs[i][1], 10) & 1) === 1; i++; }
      while (i < pairs.length) {
        const v0 = (pairs[i][1] || "").trim();
        if (pairs[i][0] === 0 && v0 === "VERTEX") {
          const vt = { x: 0, y: 0, b: 0 }; i++;
          while (i < pairs.length && pairs[i][0] !== 0) { const [c, v] = pairs[i]; if (c === 10) vt.x = num(v); else if (c === 20) vt.y = num(v); else if (c === 42) vt.b = num(v); i++; }
          verts.push(vt);
        } else if (pairs[i][0] === 0 && v0 === "SEQEND") { i++; while (i < pairs.length && pairs[i][0] !== 0) i++; break; } else break;
      }
      shapes.push(polyFromVerts(verts, closed));
    } else i++;
  }
  return shapes.filter(Boolean);
}
function extractGeometry(shapes) {
  const circles = [], closed = [], allPts = [];
  for (const s of shapes) {
    if (s.type === "circle") circles.push({ cx: s.cx, cy: s.cy, r: s.r, full: true });
    else if (s.type === "arc") { const sp = (((s.a2 - s.a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); circles.push({ cx: s.cx, cy: s.cy, r: s.r, full: sp > 4.712 }); }
    else if (s.type === "poly" && s.pts && s.pts.length) { s.pts.forEach((p) => { if (isFinite(p[0]) && isFinite(p[1])) allPts.push(p); }); if (s.closed && s.pts.length >= 3) closed.push(s.pts); }
  }
  let cx, cy;
  const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  if (circles.length) { cx = med(circles.map((c) => c.cx)); cy = med(circles.map((c) => c.cy)); }
  else if (allPts.length) { const xs = allPts.map((p) => p[0]), ys = allPts.map((p) => p[1]); cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2; }
  else return null;
  const R = (x, y) => Math.hypot(x - cx, y - cy);
  let maxR = 0;
  circles.forEach((c) => { maxR = Math.max(maxR, R(c.cx, c.cy) + c.r); });
  allPts.forEach((p) => { maxR = Math.max(maxR, R(p[0], p[1])); });
  if (maxR <= 0) return null;
  const unit = maxR < 5 ? 1000 : 1;
  const conc = circles.filter((c) => c.full && R(c.cx, c.cy) < 0.03 * maxR);
  let dias = [...new Set(conc.map((c) => +(2 * c.r * unit).toFixed(2)))].sort((a, b) => b - a);
  const merged = []; dias.forEach((d) => { if (!merged.some((m) => Math.abs(m - d) < 0.3)) merged.push(d); }); dias = merged;
  const angSpanOf = (pts, gx, gy) => { const cang = Math.atan2(gy - cy, gx - cx); let lo = 0, hi = 0; pts.forEach((p) => { let d = Math.atan2(p[1] - cy, p[0] - cx) - cang; d = Math.atan2(Math.sin(d), Math.cos(d)); if (d < lo) lo = d; if (d > hi) hi = d; }); return (hi - lo) / D2R; };
  const polyInfo = closed.map((pts) => {
    let sx = 0, sy = 0; pts.forEach((p) => { sx += p[0]; sy += p[1]; });
    const gx = sx / pts.length, gy = sy / pts.length;
    return { rc: R(gx, gy) * unit, rin: Math.min(...pts.map((p) => R(p[0], p[1]))) * unit, rout: Math.max(...pts.map((p) => R(p[0], p[1]))) * unit, ang: Math.atan2(gy - cy, gx - cx) / D2R, span: angSpanOf(pts, gx, gy) };
  }).filter((p) => p.rc > 0.02 * maxR * unit && p.rc > 0.6 * p.rin);
  const countClusters = (angs) => {
    const n = angs.length; if (n <= 2) return n;
    const s = angs.slice().sort((a, b) => a - b), gaps = [];
    for (let i = 0; i < n; i++) gaps.push(i + 1 < n ? s[i + 1] - s[i] : s[0] + 360 - s[i]);
    const desc = gaps.slice().sort((a, b) => b - a);
    let bestR = 1, cut = -1;
    for (let i = 0; i < desc.length - 1; i++) { if (desc[i + 1] < 1e-6) continue; const r = desc[i] / desc[i + 1]; if (r > bestR) { bestR = r; cut = i; } }
    return bestR > 1.4 && cut + 1 >= 2 ? cut + 1 : n;
  };
  const meanRot = (arr, p) => {
    if (!arr.length) return 0;
    const n = 360 / p;
    let S = 0, C = 0;
    for (const a of arr) { S += Math.sin(n * a * D2R); C += Math.cos(n * a * D2R); }
    if (Math.abs(S) < 1e-12 && Math.abs(C) < 1e-12) return 0;
    return Math.atan2(S, C) / D2R / n;
  };
  const median = (arr) => { if (!arr.length) return 0; const a = arr.slice().sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  let slotCount = 0, poleCount = 0, rotorOD = 0, airgap = 0, statorRot = 0, rotorRot = 0, borePoly = 0, outerN = 0, innerN = 0, slotRout = 0, slotSpan = 0, magThk = 0, magSpan = 0;
  if (polyInfo.length) {
    const rcs = polyInfo.map((p) => p.rc).sort((a, b) => a - b);
    let gi = -1, gv = 0;
    for (let i = 1; i < rcs.length; i++) { const g = rcs[i] - rcs[i - 1]; if (g > gv) { gv = g; gi = i; } }
    const thr = gi > 0 && gv > 0.8 ? (rcs[gi - 1] + rcs[gi]) / 2 : -Infinity;
    const outer = polyInfo.filter((p) => p.rc >= thr), inner = polyInfo.filter((p) => p.rc < thr);
    outerN = outer.length; innerN = inner.length;
    if (outer.length) { slotCount = countClusters(outer.map((p) => p.ang)); borePoly = 2 * Math.min(...outer.map((p) => p.rin)); statorRot = meanRot(outer.map((p) => p.ang), 360 / slotCount); slotRout = median(outer.map((p) => p.rout)); slotSpan = median(outer.map((p) => p.span)); }
    if (inner.length) { poleCount = countClusters(inner.map((p) => p.ang)); rotorOD = 2 * Math.max(...inner.map((p) => p.rout)); rotorRot = meanRot(inner.map((p) => p.ang), 360 / poleCount); magThk = median(inner.map((p) => p.rout - p.rin)); magSpan = median(inner.map((p) => p.span)); }
  }
  const statorLamDia = dias.length ? +Math.max(dias[0], 2 * maxR * unit).toFixed(2) : +(2 * maxR * unit).toFixed(2);
  const innerDias = dias.filter((d) => d < 0.985 * statorLamDia);
  let statorBore = 0;
  if (borePoly) { const near = innerDias.find((d) => Math.abs(d - borePoly) < 0.15 * borePoly); statorBore = near || borePoly; }
  else if (innerDias.length) statorBore = innerDias[0];
  let shaftDia = 0;
  if (statorBore) { const sc = innerDias.filter((d) => d < 0.92 * statorBore); if (sc.length) shaftDia = sc[sc.length - 1]; }
  if (statorBore && rotorOD) airgap = (statorBore - rotorOD) / 2;
  const Rb = statorBore / 2, Ro = statorLamDia / 2;
  let slotDepth = slotRout > Rb ? slotRout - Rb : 0;
  if (slotDepth > 0) slotDepth = Math.min(slotDepth, (Ro - Rb) - 0.8);
  let toothWidth = 0;
  if (slotCount > 0 && slotDepth > 0 && slotSpan > 0) {
    const coilsPerPitch = Math.max(1, Math.round(outerN / slotCount));
    const copperFrac = Math.min(0.85, Math.max(0.2, (coilsPerPitch * slotSpan) / (360 / slotCount)));
    const Rmid = Rb + slotDepth / 2;
    toothWidth = (2 * Math.PI * Rmid / slotCount) * (1 - copperFrac);
  }
  const magnetArcED = (magSpan > 0 && poleCount >= 2) ? Math.min(180, magSpan * poleCount / 2) : 0;
  return { cx, cy, unit, dias, statorLamDia, statorBore: +statorBore.toFixed(2), shaftDia: +shaftDia.toFixed(2), slotCount, poleCount, rotorOD: +rotorOD.toFixed(2), airgap: +airgap.toFixed(2), statorRot: +statorRot.toFixed(1), rotorRot: +rotorRot.toFixed(1), outerN, innerN, borePoly: +borePoly.toFixed(2), maxR, slotDepth: +slotDepth.toFixed(2), toothWidth: +toothWidth.toFixed(2), magnetThickness: +magThk.toFixed(2), magnetArcED: +magnetArcED.toFixed(0) };
}

const text = readFileSync(path, "latin1");
const shapes = parseDxf(text);
const cnt = shapes.reduce((m, s) => (m[s.type + (s.closed ? "/closed" : "")] = (m[s.type + (s.closed ? "/closed" : "")] || 0) + 1, m), {});
console.log(`파일: ${path}`);
console.log(`엔티티: ${shapes.length}개  유형별: ${JSON.stringify(cnt)}`);
const ex = extractGeometry(shapes);
if (!ex) { console.log("❌ extractGeometry=null (원/닫힌폴리 없음)"); process.exit(1); }
console.log("\n── 추출 ──────────────────────");
console.log(`center=(${ex.cx.toFixed(3)}, ${ex.cy.toFixed(3)})  maxR(raw)=${ex.maxR.toFixed(3)}  → unit=${ex.unit}`);
console.log(`OD=${ex.statorLamDia}  bore=${ex.statorBore}  shaft=${ex.shaftDia}  rotorOD=${ex.rotorOD}  airgap=${ex.airgap}`);
console.log(`slot=${ex.slotCount}(외측폴리 ${ex.outerN})  pole=${ex.poleCount}(내측폴리 ${ex.innerN})`);
console.log(`slotDepth=${ex.slotDepth}  toothWidth=${ex.toothWidth}  magnetThickness=${ex.magnetThickness}  magnetArcED=${ex.magnetArcED}°E`);
const byDepth = ex.statorLamDia / 2 - ex.statorBore / 2 - ex.slotDepth;
console.log(`백아이언 byDepth=${byDepth.toFixed(2)}mm  ${byDepth > 0 ? "✓(모델 일관)" : "❌(오버플로!)"}`);
console.log(`statorRot=${ex.statorRot}  rotorRot=${ex.rotorRot}  borePoly=${ex.borePoly}`);
console.log(`동심원 Ø: ${ex.dias.join(", ") || "없음"}`);
// 자동맞춤 변환
const sc = ex.unit, rdeg = -ex.statorRot, rr = rdeg * D2R;
const T = { scale: sc, rot: rdeg, dx: -sc * (ex.cx * Math.cos(rr) - ex.cy * Math.sin(rr)), dy: -sc * (ex.cx * Math.sin(rr) + ex.cy * Math.cos(rr)) };
console.log("\n── 자동맞춤 변환 ─────────────");
console.log(`scale=${T.scale}  rot=${T.rot}°  dx=${T.dx.toFixed(3)}  dy=${T.dy.toFixed(3)}`);
console.log(`적용될 모델: OD ${ex.statorLamDia} / bore ${ex.statorBore} / shaft ${ex.shaftDia} / slot ${ex.slotCount} / pole ${ex.poleCount}`);

if (process.argv.includes("-v")) {
  // 닫힌 폴리 무게중심반경(rc) 분포 — 슬롯/극 군집 진단
  const cx = ex.cx, cy = ex.cy, R = (x, y) => Math.hypot(x - cx, y - cy);
  const closed = shapes.filter((s) => s.type === "poly" && s.closed && s.pts.length >= 3);
  const info = closed.map((s) => {
    let sx = 0, sy = 0; s.pts.forEach((p) => { sx += p[0]; sy += p[1]; });
    const gx = sx / s.pts.length, gy = sy / s.pts.length;
    return { rc: +R(gx, gy).toFixed(2), nv: s.pts.length, rin: +Math.min(...s.pts.map((p) => R(p[0], p[1]))).toFixed(2), rout: +Math.max(...s.pts.map((p) => R(p[0], p[1]))).toFixed(2), ang: +(Math.atan2(gy - cy, gx - cx) / D2R).toFixed(1) };
  }).sort((a, b) => a.rc - b.rc);
  console.log(`\n── 닫힌 폴리 ${info.length}개 (rc 오름차순) ──`);
  // rc 밴드 히스토그램 (2mm 빈)
  const band = {};
  info.forEach((p) => { const b = Math.round(p.rc / 2) * 2; band[b] = (band[b] || 0) + 1; });
  console.log("rc밴드(2mm): " + Object.entries(band).map(([k, v]) => `${k}:${v}`).join("  "));
  info.forEach((p) => console.log(`  rc=${String(p.rc).padStart(6)}  rin=${String(p.rin).padStart(6)}  rout=${String(p.rout).padStart(6)}  nv=${String(p.nv).padStart(3)}  ang=${String(p.ang).padStart(7)}`));

  // 밴드별 각폭 분석 (자석호각·톱니폭 추출용)
  const angSpan = (pts) => { // 중심각 기준 점들의 각폭(deg)
    const cang = Math.atan2(pts.reduce((s, p) => s + (p[1] - cy), 0), pts.reduce((s, p) => s + (p[0] - cx), 0));
    let lo = 0, hi = 0;
    pts.forEach((p) => { let d = Math.atan2(p[1] - cy, p[0] - cx) - cang; d = Math.atan2(Math.sin(d), Math.cos(d)); lo = Math.min(lo, d); hi = Math.max(hi, d); });
    return (hi - lo) / D2R;
  };
  const withSpan = closed.map((s) => {
    let sx = 0, sy = 0; s.pts.forEach((p) => { sx += p[0]; sy += p[1]; });
    return { rc: R(sx / s.pts.length, sy / s.pts.length), span: angSpan(s.pts), pts: s.pts };
  }).filter((p) => p.rc > 0.02 * ex.maxR && p.rc > 0.6 * Math.min(...p.pts.map((q) => R(q[0], q[1]))));
  const innerB = withSpan.filter((p) => p.rc < ex.statorBore / 2).map((p) => +p.span.toFixed(1)).sort((a, b) => a - b);
  const outerB = withSpan.filter((p) => p.rc >= ex.statorBore / 2).map((p) => +p.span.toFixed(1)).sort((a, b) => a - b);
  const medn = (a) => a.length ? a[a.length >> 1] : 0;
  console.log(`\n자석(내측) 각폭 중앙값=${medn(innerB)}°  → magnetArcED≈${(medn(innerB) * ex.poleCount / 2).toFixed(0)}°E`);
  console.log(`슬롯(외측) 각폭 중앙값=${medn(outerB)}°  (슬롯피치 ${(360 / ex.slotCount).toFixed(1)}°)`);
}
