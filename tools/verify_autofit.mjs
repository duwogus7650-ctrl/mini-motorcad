// 형상 자동 맞춤 검증 — extractGeometry + 정렬 변환을 재현해,
// 알려진 중심·단위·회전으로 만든 합성 18s/16p 모터에 적용하고
// 슬롯·자석이 파라메트릭 모델(statorRot=0) 위치로 정확히 가는지 확인한다.
const D2R = Math.PI / 180;

// ── App.jsx extractGeometry 그대로 복제 ───────────────────────────
function extractGeometry(shapes) {
  const circles = [], closed = [], allPts = [];
  for (const s of shapes) {
    if (s.type === "circle") circles.push({ cx: s.cx, cy: s.cy, r: s.r, full: true });
    else if (s.type === "arc") {
      const sp = (((s.a2 - s.a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      circles.push({ cx: s.cx, cy: s.cy, r: s.r, full: sp > 4.712 });
    } else if (s.type === "poly" && s.pts && s.pts.length) {
      s.pts.forEach((p) => { if (isFinite(p[0]) && isFinite(p[1])) allPts.push(p); });
      if (s.closed && s.pts.length >= 3) closed.push(s.pts);
    }
  }
  let cx, cy;
  const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  if (circles.length) { cx = med(circles.map((c) => c.cx)); cy = med(circles.map((c) => c.cy)); }
  else if (allPts.length) {
    const xs = allPts.map((p) => p[0]), ys = allPts.map((p) => p[1]);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  } else return null;
  const R = (x, y) => Math.hypot(x - cx, y - cy);
  let maxR = 0;
  circles.forEach((c) => { maxR = Math.max(maxR, R(c.cx, c.cy) + c.r); });
  allPts.forEach((p) => { maxR = Math.max(maxR, R(p[0], p[1])); });
  if (maxR <= 0) return null;
  const unit = maxR < 5 ? 1000 : 1;
  const conc = circles.filter((c) => c.full && R(c.cx, c.cy) < 0.03 * maxR);
  let dias = [...new Set(conc.map((c) => +(2 * c.r * unit).toFixed(2)))].sort((a, b) => b - a);
  const merged = [];
  dias.forEach((d) => { if (!merged.some((m) => Math.abs(m - d) < 0.3)) merged.push(d); });
  dias = merged;
  const polyInfo = closed.map((pts) => {
    let sx = 0, sy = 0; pts.forEach((p) => { sx += p[0]; sy += p[1]; });
    const gx = sx / pts.length, gy = sy / pts.length;
    return { rc: R(gx, gy) * unit, rin: Math.min(...pts.map((p) => R(p[0], p[1]))) * unit,
      rout: Math.max(...pts.map((p) => R(p[0], p[1]))) * unit, ang: Math.atan2(gy - cy, gx - cx) / D2R };
  }).filter((p) => p.rc > 0.02 * maxR * unit);
  const countClusters = (angs) => {
    const n = angs.length;
    if (n <= 2) return n;
    const s = angs.slice().sort((a, b) => a - b), gaps = [];
    for (let i = 0; i < n; i++) gaps.push(i + 1 < n ? s[i + 1] - s[i] : s[0] + 360 - s[i]);
    const desc = gaps.slice().sort((a, b) => b - a);
    let bestR = 1, cut = -1;
    for (let i = 0; i < desc.length - 1; i++) { if (desc[i + 1] < 1e-6) continue; const r = desc[i] / desc[i + 1]; if (r > bestR) { bestR = r; cut = i; } }
    return bestR > 1.4 && cut + 1 >= 2 ? cut + 1 : n;
  };
  const wrap = (a, p) => a - p * Math.round(a / p);
  const meanRot = (arr, p) => arr.reduce((s, a) => s + wrap(a, p), 0) / arr.length;
  let slotCount = 0, poleCount = 0, rotorOD = 0, airgap = 0, statorRot = 0, rotorRot = 0;
  let borePoly = 0, outerN = 0, innerN = 0;
  if (polyInfo.length) {
    const rcs = polyInfo.map((p) => p.rc).sort((a, b) => a - b);
    let gi = -1, gv = 0;
    for (let i = 1; i < rcs.length; i++) { const g = rcs[i] - rcs[i - 1]; if (g > gv) { gv = g; gi = i; } }
    const thr = gi > 0 && gv > 0.8 ? (rcs[gi - 1] + rcs[gi]) / 2 : -Infinity;
    const outer = polyInfo.filter((p) => p.rc >= thr);
    const inner = polyInfo.filter((p) => p.rc < thr);
    outerN = outer.length; innerN = inner.length;
    if (outer.length) {
      slotCount = countClusters(outer.map((p) => p.ang));
      borePoly = 2 * Math.min(...outer.map((p) => p.rin));
      statorRot = meanRot(outer.map((p) => p.ang), 360 / slotCount);
    }
    if (inner.length) {
      poleCount = countClusters(inner.map((p) => p.ang));
      rotorOD = 2 * Math.max(...inner.map((p) => p.rout));
      rotorRot = meanRot(inner.map((p) => p.ang), 360 / poleCount);
    }
  }
  const statorLamDia = dias.length ? +Math.max(dias[0], 2 * maxR * unit).toFixed(2) : +(2 * maxR * unit).toFixed(2);
  const innerDias = dias.filter((d) => d < 0.985 * statorLamDia);
  let statorBore = 0;
  if (borePoly) { const near = innerDias.find((d) => Math.abs(d - borePoly) < 0.15 * borePoly); statorBore = near || borePoly; }
  else if (innerDias.length) statorBore = innerDias[0];
  let shaftDia = 0;
  if (statorBore) { const sc = innerDias.filter((d) => d < 0.92 * statorBore); if (sc.length) shaftDia = sc[sc.length - 1]; }
  if (statorBore && rotorOD) airgap = (statorBore - rotorOD) / 2;
  return { cx, cy, unit, dias, statorLamDia, statorBore: +statorBore.toFixed(2),
    shaftDia: +shaftDia.toFixed(2), slotCount, poleCount, rotorOD: +rotorOD.toFixed(2),
    airgap: +airgap.toFixed(2), statorRot: +statorRot.toFixed(1), rotorRot: +rotorRot.toFixed(1),
    outerN, innerN, borePoly: +borePoly.toFixed(2) };
}

// ── 합성 모터 생성 (단위: m → unit=1000) ──────────────────────────
const Cx = 0.0123, Cy = -0.0081;          // 중심을 일부러 원점에서 떨어뜨림
const TH0 = 6.5;                            // 스테이터 전역 회전 (deg)
const PH0 = 33.7;                           // 로터 전역 회전 (deg) — 별도
const NS = 18, NP = 16;
const ROD = 0.057, RBORE = 0.03983, RSHAFT = 0.031; // m (→114/79.66/62 mm)
const RSLOT = 0.044, RMAG = 0.036;          // 무게중심 반경 (m)
function rot(px, py, deg) { const a = deg * D2R, c = Math.cos(a), s = Math.sin(a); return [px * c - py * s, px * s + py * c]; }
function quad(rc, rad, ang, hr, hw) { // 반경 rc, 반치폭 hr(반경방향)·hw(접선방향 rad) 사각형 4점
  const pts = [];
  for (const [dr, dt] of [[-hr, -hw], [hr, -hw], [hr, hw], [-hr, hw]]) {
    const rr = rc + dr, tt = ang * D2R + dt;
    pts.push([Cx + rr * Math.cos(tt), Cy + rr * Math.sin(tt)]);
  }
  return { type: "poly", closed: true, pts };
}
const shapes = [
  { type: "circle", cx: Cx, cy: Cy, r: ROD },
  { type: "circle", cx: Cx, cy: Cy, r: RBORE },
  { type: "circle", cx: Cx, cy: Cy, r: RSHAFT },
];
const slotRawAng = [], magRawAng = [];
for (let k = 0; k < NS; k++) { const a = TH0 + k * (360 / NS); slotRawAng.push(a); shapes.push(quad(RSLOT, null, a, 0.004, 0.10)); }
for (let k = 0; k < NP; k++) { const a = PH0 + k * (360 / NP); magRawAng.push(a); shapes.push(quad(RMAG, null, a, 0.0018, 0.18)); }

// ── 추출 ──────────────────────────────────────────────────────────
const ex = extractGeometry(shapes);
console.log("── 추출 결과 ─────────────────────────────");
console.log(`center=(${ex.cx.toFixed(5)}, ${ex.cy.toFixed(5)})  [참값 (${Cx}, ${Cy})]`);
console.log(`unit=${ex.unit}  slot=${ex.slotCount}  pole=${ex.poleCount}  outerN=${ex.outerN} innerN=${ex.innerN}`);
console.log(`statorLamDia=${ex.statorLamDia}  statorBore=${ex.statorBore}  shaftDia=${ex.shaftDia}`);
console.log(`statorRot=${ex.statorRot}  [참값(wrap20) ${(TH0)}]   rotorRot=${ex.rotorRot}`);

// ── 자동맞춤 변환 (App.jsx runFit 과 동일) ────────────────────────
const sc = ex.unit, rdeg = -ex.statorRot, rr = rdeg * D2R;
const T = { scale: sc, rot: rdeg,
  dx: -sc * (ex.cx * Math.cos(rr) - ex.cy * Math.sin(rr)),
  dy: -sc * (ex.cx * Math.sin(rr) + ex.cy * Math.cos(rr)) };
const polePitch = 360 / ex.poleCount;
const rotorRotModel = (((ex.rotorRot - ex.statorRot) % polePitch) + polePitch) % polePitch;
// 렌더 파이프라인 등가: Q_model(mm) = scale·R(rot)·P_raw + (dx,dy)
function toModel(P) {
  const a = T.rot * D2R, c = Math.cos(a), s = Math.sin(a);
  return [T.scale * (c * P[0] - s * P[1]) + T.dx, T.scale * (s * P[0] + c * P[1]) + T.dy];
}
const angOf = (q) => ((Math.atan2(q[1], q[0]) / D2R) % 360 + 360) % 360;
const wrapTo = (a, p) => { let v = ((a % p) + p) % p; if (v > p / 2) v -= p; return v; }; // 가장 가까운 격자까지의 잔차

// ── 검증 1: 중심 → 원점 ───────────────────────────────────────────
const o = toModel([Cx, Cy]);
const centerErr = Math.hypot(o[0], o[1]);
// ── 검증 2: 슬롯이 모델 슬롯 각도(k·20°, statorRot=0)로 ────────────
const slotPitch = 360 / ex.slotCount;
let slotMaxRes = 0, slotR = [];
for (let k = 0; k < NS; k++) {
  const P = [Cx + RSLOT * Math.cos(slotRawAng[k] * D2R), Cy + RSLOT * Math.sin(slotRawAng[k] * D2R)];
  const q = toModel(P); const res = wrapTo(angOf(q), slotPitch);
  slotMaxRes = Math.max(slotMaxRes, Math.abs(res)); slotR.push(Math.hypot(q[0], q[1]));
}
// ── 검증 3: 자석이 모델 극 각도(rotorRot + k·22.5°)로 ──────────────
let magMaxRes = 0;
for (let k = 0; k < NP; k++) {
  const P = [Cx + RMAG * Math.cos(magRawAng[k] * D2R), Cy + RMAG * Math.sin(magRawAng[k] * D2R)];
  const q = toModel(P); const res = wrapTo(angOf(q) - rotorRotModel, polePitch);
  magMaxRes = Math.max(magMaxRes, Math.abs(res));
}
const slotRmm = slotR.reduce((a, b) => a + b, 0) / slotR.length;

console.log("\n── 정렬 검증 ─────────────────────────────");
console.log(`변환 T: scale=${T.scale} rot=${T.rot.toFixed(2)}° dx=${T.dx.toFixed(3)} dy=${T.dy.toFixed(3)}`);
console.log(`rotorRot(모델)=${rotorRotModel.toFixed(2)}°  [참값 wrap(${PH0}-${TH0},22.5)=${wrapTo(PH0 - TH0, polePitch).toFixed(2)} → ${(((PH0 - TH0) % polePitch + polePitch) % polePitch).toFixed(2)}]`);
console.log(`중심 오차          : ${centerErr.toExponential(2)} mm`);
console.log(`슬롯 최대 각도잔차 : ${slotMaxRes.toExponential(2)}°  (모델 슬롯선과의 편차)`);
console.log(`슬롯 평균 반경     : ${slotRmm.toFixed(3)} mm  [참값 ${(RSLOT * 1000).toFixed(1)}]`);
console.log(`자석 최대 각도잔차 : ${magMaxRes.toExponential(2)}°  (모델 극선과의 편차)`);

const ok =
  Math.abs(ex.cx - Cx) < 1e-9 && Math.abs(ex.cy - Cy) < 1e-9 &&
  ex.unit === 1000 && ex.slotCount === NS && ex.poleCount === NP &&
  centerErr < 1e-6 && slotMaxRes < 0.06 && magMaxRes < 0.06 &&
  Math.abs(slotRmm - RSLOT * 1000) < 0.05;
console.log(`\n결과: ${ok ? "✅ 통과 — DXF 슬롯·자석이 모델 위치에 정확히 정렬됨" : "❌ 실패"}`);
process.exit(ok ? 0 : 1);
