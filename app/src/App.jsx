import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ════════════════════════════════════════════════════════════════
//  Mini Motor-CAD — PMSM 기초설계 도구
//  Geometry(DXF 매칭) / Winding / Materials / Calculation / Output
//  해석 엔진: 1250W-jk Motor-CAD 결과로 검증됨
// ════════════════════════════════════════════════════════════════

const D2R = Math.PI / 180;
const MU0 = 4 * Math.PI * 1e-7;

// ─── DXF 파서 ────────────────────────────────────────────────────
function parseDxf(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1]]);
  const shapes = [];
  let i = 0;
  while (i < pairs.length) { if (pairs[i][0] === 2 && pairs[i][1].trim() === "ENTITIES") break; i++; }
  const num = (v) => parseFloat(v);
  while (i < pairs.length) {
    const [code, raw] = pairs[i];
    const val = (raw || "").trim();
    if (code === 0 && val === "ENDSEC") break;
    if (code !== 0) { i++; continue; }
    if (val === "LINE") {
      let x1, y1, x2, y2; i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        if (c === 10) x1 = num(v); else if (c === 20) y1 = num(v);
        else if (c === 11) x2 = num(v); else if (c === 21) y2 = num(v);
        i++;
      }
      shapes.push({ type: "poly", pts: [[x1, y1], [x2, y2]], closed: false });
    } else if (val === "CIRCLE" || val === "ARC") {
      let cx, cy, r, a1 = 0, a2 = 360; const isArc = val === "ARC"; i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        if (c === 10) cx = num(v); else if (c === 20) cy = num(v);
        else if (c === 40) r = num(v); else if (c === 50) a1 = num(v); else if (c === 51) a2 = num(v);
        i++;
      }
      shapes.push(isArc ? { type: "arc", cx, cy, r, a1: a1 * D2R, a2: a2 * D2R } : { type: "circle", cx, cy, r });
    } else if (val === "LWPOLYLINE") {
      let closed = false; const verts = []; i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        if (c === 70) closed = (parseInt(v, 10) & 1) === 1;
        else if (c === 10) verts.push({ x: num(v), y: 0, b: 0 });
        else if (c === 20 && verts.length) verts[verts.length - 1].y = num(v);
        else if (c === 42 && verts.length) verts[verts.length - 1].b = num(v);
        i++;
      }
      shapes.push(polyFromVerts(verts, closed));
    } else if (val === "POLYLINE") {
      let closed = false; const verts = []; i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        if (pairs[i][0] === 70) closed = (parseInt(pairs[i][1], 10) & 1) === 1;
        i++;
      }
      while (i < pairs.length) {
        const v0 = (pairs[i][1] || "").trim();
        if (pairs[i][0] === 0 && v0 === "VERTEX") {
          const vt = { x: 0, y: 0, b: 0 }; i++;
          while (i < pairs.length && pairs[i][0] !== 0) {
            const [c, v] = pairs[i];
            if (c === 10) vt.x = num(v); else if (c === 20) vt.y = num(v); else if (c === 42) vt.b = num(v);
            i++;
          }
          verts.push(vt);
        } else if (pairs[i][0] === 0 && v0 === "SEQEND") {
          i++; while (i < pairs.length && pairs[i][0] !== 0) i++;
          break;
        } else break;
      }
      shapes.push(polyFromVerts(verts, closed));
    } else i++;
  }
  return shapes.filter(Boolean);
}
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
    for (let s = 1; s <= steps; s++) {
      const t = a1 + theta * (s / steps);
      pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  return { type: "poly", pts, closed };
}

// ─── DXF 자동 형상 추출 ──────────────────────────────────────────
// 동심원/닫힌 폴리라인을 분석해 중심·단위·외경·보어·샤프트·슬롯/극수·에어갭·회전각 추정.
function extractGeometry(shapes) {
  const circles = [];      // CIRCLE + ARC (중심·반경)
  const closed = [];       // 닫힌 폴리라인 점배열
  const allPts = [];
  for (const s of shapes) {
    if (s.type === "circle") circles.push({ cx: s.cx, cy: s.cy, r: s.r });
    else if (s.type === "arc") circles.push({ cx: s.cx, cy: s.cy, r: s.r });
    else if (s.type === "poly" && s.pts && s.pts.length) {
      s.pts.forEach((p) => { if (isFinite(p[0]) && isFinite(p[1])) allPts.push(p); });
      if (s.closed && s.pts.length >= 3) closed.push(s.pts);
    }
  }
  // 중심: 원 중심들의 중앙값(견고), 없으면 점 바운딩박스 중심
  let cx, cy;
  const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
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
  const unit = maxR < 5 ? 1000 : 1;                  // 5 미만이면 m로 보고 mm 변환
  // 동심원(중심 근처) → 지름 목록(병합)
  const conc = circles.filter((c) => R(c.cx, c.cy) < 0.03 * maxR);
  let dias = [...new Set(conc.map((c) => +(2 * c.r * unit).toFixed(2)))].sort((a, b) => b - a);
  const merged = [];
  dias.forEach((d) => { if (!merged.some((m) => Math.abs(m - d) < 0.3)) merged.push(d); });
  dias = merged;
  // 닫힌 폴리 → 무게중심반경·내/외반경·중심각
  const polyInfo = closed.map((pts) => {
    let sx = 0, sy = 0; pts.forEach((p) => { sx += p[0]; sy += p[1]; });
    const gx = sx / pts.length, gy = sy / pts.length;
    return { rc: R(gx, gy) * unit, rin: Math.min(...pts.map((p) => R(p[0], p[1]))) * unit,
      rout: Math.max(...pts.map((p) => R(p[0], p[1]))) * unit, ang: Math.atan2(gy - cy, gx - cx) / D2R };
  }).filter((p) => p.rc > 0.02 * maxR * unit);       // 중심부 잡음 제외
  // 무게중심반경 최대 갭으로 슬롯(외)·자석(내) 분리
  // 각도 클러스터 수: 정렬한 각도 간격을 내림차순 정렬해 '큰 간격→작은 간격' 비율 점프로
  // 클러스터 경계 개수를 센다 (슬롯당 폴리 2개여도 한 슬롯으로 병합, 균등배치면 전부 개별).
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
    const outer = polyInfo.filter((p) => p.rc >= thr);   // 슬롯
    const inner = polyInfo.filter((p) => p.rc < thr);    // 자석
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
  // 지름 배정: OD(최대) / 보어(동심원 우선) / 샤프트(보어의 0.7배 미만 소형원)
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

// 변환(중심·회전·단위 적용)된 형상을 DXF 텍스트로 출력. T={scale,rot(deg),dx,dy}
function shapesToDxf(shapes, T) {
  const rad = T.rot * D2R, c = Math.cos(rad), s = Math.sin(rad);
  const tf = (px, py) => [T.dx + T.scale * (px * c - py * s), T.dy + T.scale * (px * s + py * c)];
  const L = ["0", "SECTION", "2", "ENTITIES"];
  const f = (v) => v.toFixed(4);
  for (const sh of shapes) {
    if (sh.type === "circle") { const [x, y] = tf(sh.cx, sh.cy); L.push("0", "CIRCLE", "8", "0", "10", f(x), "20", f(y), "30", "0", "40", f(sh.r * T.scale)); }
    else if (sh.type === "arc") { const [x, y] = tf(sh.cx, sh.cy); L.push("0", "ARC", "8", "0", "10", f(x), "20", f(y), "30", "0", "40", f(sh.r * T.scale), "50", f(sh.a1 / D2R + T.rot), "51", f(sh.a2 / D2R + T.rot)); }
    else if (sh.type === "poly" && sh.pts && sh.pts.length) {
      L.push("0", "LWPOLYLINE", "8", "0", "90", String(sh.pts.length), "70", sh.closed ? "1" : "0");
      sh.pts.forEach(([px, py]) => { const [x, y] = tf(px, py); L.push("10", f(x), "20", f(y)); });
    }
  }
  L.push("0", "ENDSEC", "0", "EOF");
  return L.join("\n");
}

// ─── 형상 생성 ───────────────────────────────────────────────────
function buildSlotPath(P) {
  const Rb = P.statorBore / 2, Rd = Rb + P.slotDepth, halfOp = P.slotOpening / 2;
  const tta = P.toothTipAngle * D2R, dlt = Math.PI / P.slotNumber;
  const x1 = Math.sqrt(Math.max(Rb * Rb - halfOp * halfOp, 0));
  const A1 = [x1, halfOp], A2 = [x1 + P.toothTipDepth, halfOp];
  const u = [Math.cos(dlt), Math.sin(dlt)];
  const nv = [Math.sin(dlt) * P.toothWidth / 2, -Math.cos(dlt) * P.toothWidth / 2];
  const d = [Math.sin(tta), Math.cos(tta)];
  const bx = nv[0] - A2[0], by = nv[1] - A2[1];
  const det = d[0] * (-u[1]) - d[1] * (-u[0]);
  let A3 = A2;
  if (Math.abs(det) > 1e-12) {
    const s = (bx * (-u[1]) - by * (-u[0])) / det;
    A3 = [A2[0] + s * d[0], A2[1] + s * d[1]];
  }
  const tEnd = Math.sqrt(Math.max(Rd * Rd - (P.toothWidth / 2) ** 2, 0));
  const A4 = [tEnd * u[0] + nv[0], tEnd * u[1] + nv[1]];
  const a4 = Math.atan2(A4[1], A4[0]);
  const pts = [A1, A2, A3, A4];
  for (let s = 1; s <= 24; s++) {
    const t = a4 - 2 * a4 * (s / 24);
    pts.push([Rd * Math.cos(t), Rd * Math.sin(t)]);
  }
  pts.push([A3[0], -A3[1]], [A2[0], -A2[1]], [A1[0], -A1[1]]);
  return pts;
}
function buildMagnetPath(P) {
  const Ro = (P.statorBore - 2 * P.airgap) / 2 - P.bandingThickness;
  const Ri = Ro - P.magnetThickness;
  const pp = P.poleNumber / 2;
  const halfA = (P.magnetArcED / pp / 2) * D2R;
  const W2 = Ri * Math.sin(halfA);
  let c = 0;
  if (P.magnetReduction > 1e-6) {
    let lo = 0, hi = Ro - 0.01;
    for (let k = 0; k < 60; k++) {
      c = (lo + hi) / 2;
      const Ra = Ro - c, inner = Ra * Ra - W2 * W2;
      const xe = inner > 0 ? c + Math.sqrt(inner) : c;
      const red = Ro - Math.hypot(xe, W2);
      if (red < P.magnetReduction) lo = c; else hi = c;
    }
  }
  const Ra = Ro - c;
  const xSideIn = Ri * Math.cos(halfA);
  const innerS = Ra * Ra - W2 * W2;
  const xSideOut = innerS > 0 ? c + Math.sqrt(innerS) : c;
  const aOut = Math.atan2(W2, xSideOut - c);
  const pts = [];
  for (let s = 0; s <= 20; s++) {
    const t = -halfA + 2 * halfA * (s / 20);
    pts.push([Ri * Math.cos(t), Ri * Math.sin(t)]);
  }
  pts.push([xSideOut, W2]);
  for (let s = 0; s <= 20; s++) {
    const t = aOut - 2 * aOut * (s / 20);
    pts.push([c + Ra * Math.cos(t), Ra * Math.sin(t)]);
  }
  pts.push([xSideIn, -W2]);
  return pts;
}
const rotPts = (pts, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
};
const shoelace = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};

// ─── 권선 패턴 + 권선계수 (star of slots, 2층) ───────────────────
function windingAnalysis(Ns, poles, throw_, Nc) {
  const pp = poles / 2;
  const theta = Array.from({ length: Ns }, (_, i) => ((i * pp * 360) / Ns) % 360);
  const coils = []; // {go, ret, phase 0/1/2, sign}
  const beltMap = { 0: [0, 1], 3: [0, -1], 2: [1, 1], 5: [1, -1], 4: [2, 1], 1: [2, -1] };
  for (let i = 0; i < Ns; i++) {
    const g = theta[i] * D2R, r = theta[(i + throw_) % Ns] * D2R;
    const re = Math.cos(g) - Math.cos(r), im = Math.sin(g) - Math.sin(r);
    const axis = ((Math.atan2(im, re) / D2R) % 360 + 360) % 360;
    const [ph, sg] = beltMap[Math.floor(axis / 60)];
    coils.push({ go: i, ret: (i + throw_) % Ns, phase: ph, sign: sg });
  }
  // 슬롯별 상 도체수 테이블 (±Nc)
  const table = Array.from({ length: Ns }, () => [0, 0, 0]);
  coils.forEach((c) => {
    table[c.go][c.phase] += c.sign * Nc;
    table[c.ret][c.phase] -= c.sign * Nc;
  });
  // 권선계수
  const kw = (h) => {
    let re = 0, im = 0, n = 0;
    coils.forEach((c) => {
      if (c.phase !== 0) return;
      const g = h * theta[c.go] * D2R, r = h * theta[c.ret] * D2R;
      re += c.sign * (Math.cos(g) - Math.cos(r));
      im += c.sign * (Math.sin(g) - Math.sin(r));
      n++;
    });
    return n ? Math.hypot(re, im) / (2 * n) : 0;
  };
  const coilsPerPhase = coils.filter((c) => c.phase === 0).length;
  return { coils, table, kw, coilsPerPhase, theta };
}

// ─── 재질 DB ─────────────────────────────────────────────────────
const STEELS = {
  "20PNX1200F": { density: 7650, kh: 0.0226, ke: 4.43e-5, thk: 0.2 },
  "35PN230":    { density: 7600, kh: 0.028,  ke: 9.0e-5,  thk: 0.35 },
  "50PN470":    { density: 7700, kh: 0.038,  ke: 2.2e-4,  thk: 0.5 },
};
const MAGNETS = {
  "N45UH": { Br20: 1.32, tc: -0.12, mur: 1.05, density: 7500 },
  "N42SH": { Br20: 1.30, tc: -0.115, mur: 1.05, density: 7500 },
  "N52":   { Br20: 1.43, tc: -0.12, mur: 1.05, density: 7500 },
  "N35":   { Br20: 1.18, tc: -0.12, mur: 1.05, density: 7400 },
};

// ─── 와이어 게이지 테이블 (cu=나동선, cov=피복 외경 [mm]) ────────
const WIRE_TABLES = {
  Metric: [ // IEC 60317 Grade 2
    [0.200, 0.239], [0.224, 0.266], [0.250, 0.297], [0.280, 0.329], [0.315, 0.367],
    [0.355, 0.411], [0.400, 0.459], [0.450, 0.513], [0.500, 0.569], [0.560, 0.632],
    [0.630, 0.706], [0.710, 0.790], [0.800, 0.885], [0.900, 0.990], [1.000, 1.093],
    [1.120, 1.217], [1.250, 1.349], [1.400, 1.502], [1.600, 1.706], [1.800, 1.910], [2.000, 2.116],
  ].map(([cu, cov]) => ({ label: `Ø${cu.toFixed(3)}`, cu, cov })),
  AWG: [ // NEMA MW1000 Heavy Build
    [14, 1.628, 1.732], [16, 1.291, 1.384], [18, 1.024, 1.110], [20, 0.812, 0.892],
    [22, 0.644, 0.714], [24, 0.511, 0.577], [26, 0.405, 0.462], [28, 0.320, 0.373],
    [30, 0.254, 0.302], [32, 0.202, 0.241], [34, 0.160, 0.198], [36, 0.127, 0.161], [38, 0.101, 0.130],
  ].map(([g, cu, cov]) => ({ label: `AWG ${g}`, cu, cov })),
  SWG: [ // BS 3737, Grade 2 상당 피복 (근사)
    [14, 2.032, 2.149], [16, 1.626, 1.732], [18, 1.219, 1.318], [20, 0.914, 1.006],
    [22, 0.711, 0.794], [24, 0.559, 0.632], [26, 0.457, 0.521], [28, 0.376, 0.434],
    [30, 0.315, 0.367], [32, 0.274, 0.321], [34, 0.234, 0.277], [36, 0.193, 0.231],
    [38, 0.152, 0.187], [40, 0.122, 0.152],
  ].map(([g, cu, cov]) => ({ label: `SWG ${g}`, cu, cov })),
};

// ─── 해석 엔진 (검증: 1250W-jk) ─────────────────────────────────
function compute(G, W, M, C) {
  const out = {};
  const Ns = G.slotNumber, poles = G.poleNumber, pp = poles / 2;
  const Bore = G.statorBore, g = G.airgap, lm = G.magnetThickness;
  const mag = { ...MAGNETS[M.magnet], Br20: M.Br20, tc: M.tcBr, mur: M.mur };
  const stl = { ...STEELS[M.steel], kh: M.kh, ke: M.ke };

  // 자석/공극
  const Br = mag.Br20 * (1 + mag.tc / 100 * (C.Tmag - 20));
  const taus = Math.PI * Bore / Ns;
  const gam = (G.slotOpening / g) ** 2 / (5 + G.slotOpening / g);
  const kc = taus / (taus - gam * g);
  const Bgpk = Br * lm / (lm + mag.mur * kc * g);
  out.Br_used = Br; out.kc = kc; out.Bgpk = Bgpk;

  // 권선
  const wa = windingAnalysis(Ns, poles, W.throw, W.turnsPerCoil);
  out.wa = wa;
  const kw1 = wa.kw(1);
  const NphSeries = wa.coilsPerPhase * W.turnsPerCoil / W.parallelPaths;
  const NphTotal = wa.coilsPerPhase * W.turnsPerCoil;
  out.kw1 = kw1; out.turnsPerPhase = NphTotal; out.NphSeries = NphSeries;
  out.condPerSlot = 2 * W.turnsPerCoil * W.strands; // 2층

  // 쇄교자속 / EMF / 토크
  const D = Bore - g, taup = Math.PI * D / poles;
  const alpha = G.magnetArcED / 180;
  const L = G.magneticLength * 1e-3;
  const lam = (2 / Math.PI) * kw1 * NphSeries * (alpha * Bgpk * C.klk) * (taup * 1e-3) * L;
  out.lambda = lam; out.magnetAlpha = alpha;
  const fe = C.speed / 60 * pp;
  out.fe = fe;
  out.Epk = 2 * Math.PI * fe * lam;
  out.Erms = out.Epk / Math.SQRT2;
  out.Ke = pp * lam;
  const Iph = W.connection === "delta" ? C.IlineRms / Math.sqrt(3) : C.IlineRms;
  out.IphRms = Iph; out.IlineRms = C.IlineRms;
  const IphPk = Iph * Math.SQRT2;
  const Iq = IphPk * Math.cos(C.phaseAdv * D2R);
  out.torque = 1.5 * pp * lam * Iq;
  out.Kt_phase = out.torque / Iph;
  out.KtLine = out.torque / (C.IlineRms * Math.SQRT2);

  // 슬롯/충전율
  const slotPath = buildSlotPath(G);
  const slotA = shoelace(slotPath);
  out.slotArea = slotA;
  const wireA = Math.PI / 4 * W.wireDia ** 2;
  const cuA = Math.PI / 4 * W.copperDia ** 2;
  out.condCSA = cuA;
  out.wireSlotFill = out.condPerSlot * wireA / slotA;
  out.cuSlotFill = out.condPerSlot * cuA / slotA;
  out.turnCSA = cuA * W.strands;

  // MLT / 저항 / 동손
  const tausMid = Math.PI * (Bore + G.slotDepth) / Ns;
  const slotWMid = tausMid - G.toothWidth;
  out.coilPitch = W.throw * tausMid - slotWMid / 2;
  out.MLT = 2 * G.stackLength + Math.PI * out.coilPitch;
  const rho = 1.724e-8 * (1 + 0.003862 * (C.Tcu - 20));
  out.Rphase = rho * (out.MLT * 1e-3 * NphSeries) / (out.turnCSA * 1e-6) / W.parallelPaths;
  out.RlineLine = W.connection === "delta" ? (2 / 3) * out.Rphase : 2 * out.Rphase;
  out.Pcu = 3 * Iph ** 2 * out.Rphase;
  out.Jrms = Iph / W.parallelPaths / out.turnCSA;

  // 권선영역 상세 (Motor-CAD Winding 출력 대응, 기하 근사)
  const RbW = Bore / 2, RdW = RbW + G.slotDepth;
  const wedgeHold = W.wedgeModel === "wound" ? 0 : W.wedgeDepth; // Wound Space: 웨지 공간도 권선 가능
  const xWedgeEnd = Math.sqrt(Math.max(RbW * RbW - (G.slotOpening / 2) ** 2, 0)) + G.toothTipDepth + wedgeHold;
  let linedLen = 0; // 라이너가 깔리는 둘레: 치선단 코너(A3)부터 반대쪽 A3까지
  for (let i = 2; i < slotPath.length - 3; i++)
    linedLen += Math.hypot(slotPath[i + 1][0] - slotPath[i][0], slotPath[i + 1][1] - slotPath[i][1]);
  out.linerArea = linedLen * W.linerThk;
  out.wedgeArea = W.wedgeModel === "wedge" ? (G.slotOpening + 1.25) * W.wedgeDepth : 0; // 사다리꼴 평균폭 (뷰어 형상과 동일)
  out.windingDepth = RdW - xWedgeEnd;
  out.dividerArea = W.coilDivider * out.windingDepth;
  out.windingAreaLiner = slotA - out.wedgeArea - out.dividerArea;
  out.windingArea = out.windingAreaLiner - out.linerArea;
  out.coveredWireArea = out.condPerSlot * wireA;
  out.copperArea = out.condPerSlot * cuA;
  out.impregArea = out.windingArea - out.coveredWireArea;
  out.wireFillWdg = out.coveredWireArea / out.windingArea;
  out.heavyBuildFill = out.condPerSlot * W.wireDia ** 2 / out.windingArea;
  out.ewdgMLT = out.MLT - 2 * G.stackLength;

  // 동선 체적 / 엔드와인딩 충전율 (근사: 권선환형 × 반타원 오버행)
  out.volCuActive = out.turnCSA * 2 * G.stackLength * NphTotal * 3;      // mm³
  out.volCuEwdg = out.turnCSA * out.ewdgMLT * NphTotal * 3 / 2;          // mm³ (편측)
  const RdLw = RdW - W.linerThk, xWin = xWedgeEnd + W.linerThk;
  const ewdgRegion = Math.PI * (RdLw ** 2 - xWin ** 2) * (Math.PI * out.coilPitch / 4);
  out.ewdgFill = ewdgRegion > 0 ? out.volCuEwdg * (W.wireDia / W.copperDia) ** 2 / ewdgRegion : 0;

  // 자속밀도 (FSCW 보정)
  out.Bt = C.cT * Bgpk * taus / G.toothWidth;
  const byDepth = G.statorLamDia / 2 - Bore / 2 - G.slotDepth;
  out.byDepth = byDepth;
  out.By = out.Bt * G.toothWidth / (2 * byDepth);

  // 중량
  const Lstk = G.stackLength;
  const rhoFe = stl.density * 1e-9, rhoMag = mag.density * 1e-9;
  const Rb = Bore / 2, RdS = Rb + G.slotDepth, RoL = G.statorLamDia / 2;
  const toothArea = Math.PI * (RdS ** 2 - Rb ** 2) - Ns * slotA;
  const byArea = Math.PI * (RoL ** 2 - RdS ** 2);
  out.mTooth = toothArea * Lstk * rhoFe;
  out.mBy = byArea * Lstk * rhoFe;
  out.mStator = out.mTooth + out.mBy;
  const RoM = (Bore - 2 * g) / 2 - G.bandingThickness, RiM = RoM - lm;
  out.mRotor = Math.PI * (RiM ** 2 - (G.shaftDia / 2) ** 2) * G.rotorLamLength * rhoFe;
  const halfA = (G.magnetArcED / pp / 2) * D2R;
  out.mMagnet = poles * (RoM ** 2 - RiM ** 2) * halfA * G.magnetLength * rhoMag;
  out.mCopper = out.turnCSA * 1e-6 * (out.MLT * 1e-3 * NphTotal) * 3 * 8933;
  out.mActive = out.mStator + out.mRotor + out.mMagnet + out.mCopper;

  // 철손 / 효율
  out.Pfe = (stl.kh * fe + stl.ke * fe ** 2) * (out.mTooth * out.Bt ** 2 + out.mBy * out.By ** 2);
  const wm = C.speed * 2 * Math.PI / 60;
  out.Pem = out.torque * wm;
  out.Pin = out.Pem + out.Pcu;
  out.Pout = out.Pem - out.Pfe - C.otherLoss;
  out.Tshaft = out.Pout / wm;
  out.eff = out.Pin > 0 ? (out.Pout / out.Pin) * 100 : 0;
  out.TRV = out.torque / (Math.PI * RoM ** 2 * Lstk * 1e-9) / 1000; // kNm/m³

  // 전압/무부하속도 (정현 구동, SVPWM 가정)
  const VphAvail = W.connection === "delta" ? C.Vdc : C.Vdc / Math.sqrt(3);
  out.noLoadSpeed = (VphAvail / (2 * Math.PI * lam)) * 60 / pp;

  // 인덕턴스 (참고 추정치 — 보정계수 포함)
  const geff = (kc * g + lm / mag.mur) * 1e-3;
  const Lm = C.cL * (3 / Math.PI) * MU0 * (kw1 * NphSeries) ** 2 * ((D / 2) * 1e-3 * L) / (pp ** 2 * geff);
  const hs = G.slotDepth - G.toothTipDepth, ws = slotWMid;
  const pSlot = MU0 * (G.stackLength * 1e-3) * (hs / (3 * ws) + G.toothTipDepth / G.slotOpening);
  const Lslot = C.cLs * (4 * 3 / Ns) * NphSeries ** 2 * pSlot / W.parallelPaths;
  out.Ld = (Lm + Lslot) * 1e3; out.Lq = out.Ld * 1.09; // SPM: Lq 약간 큼(슬롯/포화)

  // 파생량 (Motor-CAD Output Data 항목)
  out.Km = out.Pcu > 0 ? out.torque / Math.sqrt(out.Pcu) : 0;
  out.Te = (out.Lq * 1e-3 / out.Rphase) * 1e3;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcmSP = (Ns * poles) / gcd(Ns, poles);
  out.coggingPeriod = 360 / lcmSP;
  out.coggingFreq = (lcmSP * C.speed) / 60;
  const RoMm = RoM * 1e-3, RiMm = RiM * 1e-3, Rshm = (G.shaftDia / 2) * 1e-3;
  out.Jrotor = 0.5 * out.mRotor * (RiMm ** 2 + Rshm ** 2) + 0.5 * out.mMagnet * (RoMm ** 2 + RiMm ** 2);
  const we = 2 * Math.PI * fe;
  const Vq = out.Erms + out.Rphase * Iph, Vd = -we * out.Lq * 1e-3 * Iph;
  out.Vterm = Math.hypot(Vq, Vd);
  out.PF = out.Vterm > 0 ? Vq / out.Vterm : 0;
  out.VsupplyRms = C.Vdc / Math.SQRT2;
  out.Istall = C.Vdc / out.RlineLine;
  out.Tstall = out.KtLine * out.Istall;
  out.numLam = G.magneticLength / stl.thk;
  const S_fe = out.mTooth * out.Bt ** 2 + out.mBy * out.By ** 2;
  out.PfeHyst = stl.kh * fe * S_fe;
  out.PfeEddy = stl.ke * fe ** 2 * S_fe;
  out.phaseLen = out.MLT * (wa.coilsPerPhase * W.turnsPerCoil);
  out.mCuActive = out.turnCSA * 1e-6 * (2 * G.stackLength * 1e-3 * out.turnsPerPhase) * 3 * 8933;
  out.mCuEwdg = (out.mCopper - out.mCuActive) / 2;
  return out;
}

// ─── 기본값 (1250W-jk) ───────────────────────────────────────────
const GEO0 = {
  slotNumber: 18, statorLamDia: 114, statorBore: 79.66, toothWidth: 4.6,
  slotDepth: 14.2, toothTipDepth: 0.5, slotOpening: 0.56, toothTipAngle: 4,
  poleNumber: 16, magnetThickness: 3.6, magnetReduction: 1.3, magnetArcED: 145,
  airgap: 0.5, bandingThickness: 0, shaftDia: 62, statorRot: 0, rotorRot: 0,
  stackLength: 30, magnetLength: 30, rotorLamLength: 30, magneticLength: 27.9, motorLength: 70,
};
const WIND0 = {
  turnsPerCoil: 12, throw: 1, parallelPaths: 1, wireDia: 0.5, copperDia: 0.45,
  strands: 17, connection: "delta", linerThk: 0.5, coilDivider: 0.5,
  wedgeDepth: 1.0, condSep: 0.02, wedgeModel: "wedge",
};
const MAT0 = { steel: "20PNX1200F", magnet: "N45UH", Br20: 1.32, tcBr: -0.12, mur: 1.05, kh: 0.0226, ke: 4.43e-5 };
const CALC0 = { speed: 3200, Vdc: 48, IlineRms: 24.8, phaseAdv: 0, Tcu: 80, Tmag: 80, klk: 0.97, cT: 0.56, cL: 2.6, cLs: 0.33, otherLoss: 6.7, currentDef: "rms", magnetisation: "parallel", driveMode: "sine" };

// 1250W-jk Motor-CAD 참조값 (비교 표시용)
const REF = {
  kw1: 0.94521, turnsPerPhase: 72, condPerSlot: 408, slotArea: 160.3, cuSlotFill: 0.4049,
  wireSlotFill: 0.4999, coilPitch: 10.5, MLT: 92.99, Rphase: 0.05258, Pcu: 32.34, Jrms: 5.296,
  lambda: 0.0157, Epk: 42.09, Ke: 0.1256, torque: 3.7965, Bt: 1.808, By: 1.414, Bgpk: 1.174,
  windingArea: 132.5, windingAreaLiner: 152.2, coveredWireArea: 80.11, copperArea: 64.89,
  impregArea: 52.36, wedgeArea: 1.627, linerArea: 19.73, dividerArea: 6.441, windingDepth: 12.882,
  wireFillWdg: 0.6047, heavyBuildFill: 0.77, ewdgMLT: 32.99,
  volCuActive: 35040, volCuEwdg: 9633, ewdgFill: 0.3794,
  Pfe: 23.91, eff: 95.213, Pout: 1244.4, noLoadSpeed: 3649, mStator: 0.498, mRotor: 0.2116,
  mMagnet: 0.1428, mCopper: 0.4851, Ld: 0.1289, Lq: 0.1401, Kt_phase: 0.265, stallTorque: 147.8,
};

// ════════════════════════════════════════════════════════════════
const Row = ({ label, value, unit, refv, hl }) => (
  <tr style={{ borderTop: "1px solid #E5E9ED", background: hl ? "#FCF6EE" : undefined }}>
    <td className="px-2 py-1 text-xs" style={{ color: "#2A3540" }}>{label}</td>
    <td className="px-2 py-1 text-xs text-right font-semibold" style={{ fontFamily: "Consolas,monospace" }}>{value}</td>
    <td className="px-2 py-1 text-xs" style={{ color: "#8893A0" }}>{unit || ""}</td>
    {refv !== undefined && (
      <td className="px-2 py-1 text-xs text-right" style={{ color: "#1B7A2B", fontFamily: "Consolas,monospace" }}>{refv}</td>
    )}
  </tr>
);

const NumIn = ({ label, value, onChange, step = 0.01, w = "w-20" }) => (
  <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA" }}>
    <span className="text-xs whitespace-nowrap" style={{ color: "#2A3540" }}>{label}</span>
    <input type="number" step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className={`${w} text-right text-xs px-1 py-0.5 rounded`}
      style={{ border: "1px solid #C8CFD6", fontFamily: "Consolas,monospace" }} />
  </div>
);
const SectionHead = ({ color, children }) => (
  <div className="px-2 py-1 text-xs font-bold" style={{ background: "#E8EBEE", borderLeft: `3px solid ${color}` }}>{children}</div>
);

export default function MiniMotorCad() {
  const [tab, setTab] = useState("geometry");
  const [geo, setGeo] = useState(GEO0);
  const [wind, setWind] = useState(WIND0);
  const [mat, setMat] = useState(MAT0);
  const [calc, setCalc] = useState(CALC0);
  const [showRef, setShowRef] = useState(true);

  // 입력 도중(빈 칸→0 등) NaN/Infinity가 나오면 마지막 유효 결과를 유지
  const rawRes = useMemo(() => {
    try {
      const r = compute(geo, wind, mat, calc);
      return ["torque", "Rphase", "slotArea", "eff", "kw1"].every((k) => isFinite(r[k])) ? r : null;
    } catch (e) { return null; }
  }, [geo, wind, mat, calc]);
  const lastResRef = useRef(null);
  if (rawRes) lastResRef.current = rawRes;
  const res = rawRes || lastResRef.current;
  const stale = !rawRes && !!res;

  // E-Magnetic 결과는 Solve를 눌러야 표시 (Motor-CAD 흐름). 입력 변경 시 무효화.
  const [solved, setSolved] = useState(false);
  useEffect(() => { setSolved(false); }, [geo, wind, mat, calc]);

  const sG = (k, v) => setGeo((p) => ({ ...p, [k]: v }));
  const sW = (k, v) => setWind((p) => ({ ...p, [k]: v }));
  const sM = (k, v) => setMat((p) => ({ ...p, [k]: v }));
  const sC = (k, v) => setCalc((p) => ({ ...p, [k]: v }));

  const exportAll = () => {
    const data = { geometry: geo, winding: wind, materials: mat, calculation: calc, results: res };
    const blob = new Blob([JSON.stringify(data, (k, v) => (k === "wa" ? undefined : v), 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "motor_design.json"; a.click();
  };

  const TABS = [
    ["geometry", "Geometry"], ["winding", "Winding"], ["materials", "Materials"],
    ["calculation", "Calculation"], ["output", "Output Data"], ["graphs", "Graphs"],
  ];

  return (
    <div className="h-screen flex flex-col" style={{ background: "#F0F2F4", fontFamily: "'Segoe UI','Noto Sans KR',sans-serif", color: "#1A222C" }}>
      {/* 헤더 + 탭 */}
      <div style={{ background: "#FFFFFF", borderBottom: "2px solid #1A222C" }}>
        <div className="flex items-center gap-3 px-3 pt-2">
          <span className="font-bold text-sm tracking-tight">Mini Motor-CAD</span>
          <span className="text-xs" style={{ color: "#8893A0" }}>PMSM 기초설계 · 해석엔진 1250W-jk 검증</span>
          {stale && <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ background: "#7A1212", color: "#fff" }}>⚠ 입력값 비정상 — 마지막 유효 결과 표시 중</span>}
          <div className="flex-1" />
          <label className="text-xs flex items-center gap-1">
            <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} />
            Motor-CAD 참조값 표시
          </label>
          <button onClick={exportAll} className="text-xs px-3 py-1 rounded text-white font-medium mb-1" style={{ background: "#B5622D" }}>
            설계 JSON 내보내기
          </button>
        </div>
        <div className="flex gap-0.5 px-3">
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className="text-xs px-3 py-1.5 rounded-t font-medium"
              style={{
                background: tab === k ? "#F0F2F4" : "#DDE2E7",
                border: "1px solid #C8CFD6", borderBottom: tab === k ? "1px solid #F0F2F4" : "1px solid #C8CFD6",
                marginBottom: -1, color: tab === k ? "#1A222C" : "#5C6B7A",
              }}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "geometry" && <GeometryTab geo={geo} sG={sG} res={res} />}
        {tab === "winding" && <WindingTab geo={geo} wind={wind} sW={sW} res={res} showRef={showRef} />}
        {tab === "materials" && <MaterialsTab mat={mat} sM={sM} res={res} showRef={showRef} />}
        {tab === "calculation" && <CalculationTab calc={calc} sC={sC} wind={wind} sW={sW} res={res} solved={solved} setSolved={setSolved} />}
        {tab === "output" && <OutputTab res={res} calc={calc} showRef={showRef} solved={solved} />}
        {tab === "graphs" && <GraphsTab res={res} calc={calc} solved={solved} />}
      </div>
    </div>
  );
}

// ─── Geometry 탭 (DXF 매칭) ──────────────────────────────────────
function GeometryTab({ geo, sG, res }) {
  const [dxf, setDxf] = useState(null);
  const [dxfName, setDxfName] = useState("");
  const [autoInfo, setAutoInfo] = useState(null);
  const [dxfT, setDxfT] = useState({ scale: 1, dx: 0, dy: 0, rot: 0 });
  const [layers, setLayers] = useState({ dxf: true, stator: true, slots: true, rotor: true, magnets: true });
  const [opacity, setOpacity] = useState(0.45);
  const [measure, setMeasure] = useState(false);
  const [mPts, setMPts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const canvasRef = useRef(null), wrapRef = useRef(null), fileRef = useRef(null);
  const viewRef = useRef({ scale: 6, ox: 0, oy: 0, init: false });
  const dragRef = useRef(null);
  const rotorDia = geo.statorBore - 2 * geo.airgap;

  const w2s = (x, y, V) => [V.ox + x * V.scale, V.oy - y * V.scale];
  const s2w = (sx, sy, V) => [(sx - V.ox) / V.scale, (V.oy - sy) / V.scale];

  const draw = useCallback(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const Wd = wrap.clientWidth, H = wrap.clientHeight;
    if (cv.width !== Wd * dpr) { cv.width = Wd * dpr; cv.height = H * dpr; }
    const V = viewRef.current;
    if (!V.init) { V.ox = Wd / 2; V.oy = H / 2; V.scale = Math.min(Wd, H) / 130; V.init = true; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, Wd, H);
    // 그리드
    ctx.strokeStyle = "#EEF1F4"; ctx.lineWidth = 1;
    const wx0 = s2w(0, 0, V)[0], wx1 = s2w(Wd, 0, V)[0];
    const wy1 = s2w(0, 0, V)[1], wy0 = s2w(0, H, V)[1];
    for (let gx = Math.ceil(wx0 / 10) * 10; gx <= wx1; gx += 10) {
      const [sx] = w2s(gx, 0, V); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (let gy = Math.ceil(wy0 / 10) * 10; gy <= wy1; gy += 10) {
      const [, sy] = w2s(0, gy, V); ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(Wd, sy); ctx.stroke();
    }
    ctx.strokeStyle = "#D5DBE1";
    const [ox0, oy0] = w2s(0, 0, V);
    ctx.beginPath(); ctx.moveTo(ox0, 0); ctx.lineTo(ox0, H); ctx.moveTo(0, oy0); ctx.lineTo(Wd, oy0); ctx.stroke();

    const poly = (pts, close) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const [sx, sy] = w2s(x, y, V); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      if (close) ctx.closePath();
    };
    const circle = (r) => { const [sx, sy] = w2s(0, 0, V); ctx.beginPath(); ctx.arc(sx, sy, r * V.scale, 0, Math.PI * 2); };
    const annulus = (rO, rI) => {
      const [sx, sy] = w2s(0, 0, V);
      ctx.beginPath(); ctx.arc(sx, sy, rO * V.scale, 0, Math.PI * 2); ctx.arc(sx, sy, rI * V.scale, 0, Math.PI * 2, true);
    };

    ctx.globalAlpha = opacity;
    const P = geo;
    const Ro = rotorDia / 2 - P.bandingThickness, Ri = Ro - P.magnetThickness;
    if (layers.rotor) { ctx.fillStyle = "#33CCCC"; annulus(Ri, P.shaftDia / 2); ctx.fill("evenodd"); }
    if (layers.magnets && P.poleNumber > 0) {
      const mp = buildMagnetPath(P); ctx.fillStyle = "#22BB22";
      for (let k = 0; k < P.poleNumber; k++) { poly(rotPts(mp, P.rotorRot * D2R + (k * 2 * Math.PI) / P.poleNumber), true); ctx.fill(); }
    }
    if (layers.stator) { ctx.fillStyle = "#E03030"; annulus(P.statorLamDia / 2, P.statorBore / 2); ctx.fill("evenodd"); }
    if (layers.slots && P.slotNumber > 0) {
      const sp = buildSlotPath(P); ctx.fillStyle = "#F5E020"; ctx.strokeStyle = "#998800"; ctx.lineWidth = 1;
      for (let k = 0; k < P.slotNumber; k++) {
        poly(rotPts(sp, P.statorRot * D2R + (k * 2 * Math.PI) / P.slotNumber), true);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#B02020"; ctx.lineWidth = 1.2;
    if (layers.stator) { circle(P.statorLamDia / 2); ctx.stroke(); circle(P.statorBore / 2); ctx.stroke(); }
    if (layers.rotor) { ctx.strokeStyle = "#0E8C8C"; circle(Ro); ctx.stroke(); circle(Ri); ctx.stroke(); circle(P.shaftDia / 2); ctx.stroke(); }

    if (dxf && layers.dxf) {
      ctx.save();
      const [tx, ty] = w2s(dxfT.dx, dxfT.dy, V);
      ctx.translate(tx, ty);
      ctx.scale(V.scale * dxfT.scale, -V.scale * dxfT.scale);
      ctx.rotate(dxfT.rot * D2R);
      ctx.strokeStyle = "#1B7A2B"; ctx.lineWidth = 1 / (V.scale * dxfT.scale);
      for (const s of dxf) {
        ctx.beginPath();
        if (s.type === "poly") { s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (s.closed) ctx.closePath(); }
        else if (s.type === "circle") ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
        else if (s.type === "arc") ctx.arc(s.cx, s.cy, s.r, s.a1, s.a2, false);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (mPts.length) {
      ctx.fillStyle = "#C2410C"; ctx.strokeStyle = "#C2410C"; ctx.lineWidth = 1.5;
      mPts.forEach(([x, y]) => { const [sx, sy] = w2s(x, y, V); ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill(); });
      if (mPts.length === 2) {
        const [s1, s2] = mPts.map(([x, y]) => w2s(x, y, V));
        ctx.beginPath(); ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s2[0], s2[1]); ctx.stroke();
      }
    }
  }, [geo, dxf, dxfT, layers, opacity, mPts, rotorDia]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [draw]);

  const onWheel = (e) => {
    e.preventDefault();
    const V = viewRef.current, rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    V.ox = mx - (mx - V.ox) * f; V.oy = my - (my - V.oy) * f; V.scale *= f;
    draw();
  };
  const onDown = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (measure) { setMPts((p) => (p.length >= 2 ? [s2w(sx, sy, viewRef.current)] : [...p, s2w(sx, sy, viewRef.current)])); return; }
    dragRef.current = { sx, sy };
  };
  const onMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    setCursor(s2w(sx, sy, viewRef.current));
    if (dragRef.current) {
      const V = viewRef.current;
      V.ox += sx - dragRef.current.sx; V.oy += sy - dragRef.current.sy;
      dragRef.current = { sx, sy };
      draw();
    }
  };
  const fitView = () => {
    const wrap = wrapRef.current; if (!wrap) return;
    const V = viewRef.current;
    V.ox = wrap.clientWidth / 2; V.oy = wrap.clientHeight / 2;
    V.scale = Math.min(wrap.clientWidth, wrap.clientHeight) / (geo.statorLamDia * 1.15);
    draw();
  };
  const autoPendingRef = useRef(false);
  const loadFile = async (file) => {
    const text = await file.text();
    try {
      const shapes = parseDxf(text);
      if (!shapes.length) throw new Error("no entities");
      setDxf(shapes); setDxfName(file.name); setAutoInfo(null);
      if (autoPendingRef.current) { autoPendingRef.current = false; runExtract(shapes); }
    } catch (err) { alert("DXF 파싱 실패: " + err.message); }
  };
  const autoExtract = () => {
    if (!dxf) { autoPendingRef.current = true; fileRef.current?.click(); return; } // 없으면 파일 선택 → 로드 후 자동추출
    runExtract(dxf);
  };
  const runExtract = (shapes) => {
    const ex = extractGeometry(shapes);
    if (!ex) { alert("형상을 추출할 수 없습니다 (원/닫힌 폴리라인 없음)."); return; }
    // 축 정렬: 슬롯을 +X축에 맞추도록 DXF를 −statorRot 회전(중심 유지) → 회전각 0 정규화
    const rot = -ex.statorRot, rad = rot * D2R, c = Math.cos(rad), s = Math.sin(rad);
    const rx = ex.cx * c - ex.cy * s, ry = ex.cx * s + ex.cy * c;
    setDxfT({ scale: ex.unit, rot, dx: -ex.unit * rx, dy: -ex.unit * ry });
    const applied = [];
    const put = (k, v, lo, hi, dec = 2) => { if (isFinite(v) && v > lo && v < hi) { sG(k, +v.toFixed(dec)); applied.push(k); } };
    put("statorLamDia", ex.statorLamDia, 5, 2000);
    put("statorBore", ex.statorBore, 2, ex.statorLamDia);
    put("shaftDia", ex.shaftDia, 1, ex.statorBore || 1e9);
    if (ex.slotCount >= 3 && ex.slotCount <= 90) { sG("slotNumber", ex.slotCount); applied.push("slotNumber"); }
    if (ex.poleCount >= 2 && ex.poleCount <= 80) { sG("poleNumber", ex.poleCount); applied.push("poleNumber"); }
    put("airgap", ex.airgap, 0.05, 5);
    sG("statorRot", 0); applied.push("statorRot");          // 정렬했으므로 0
    sG("rotorRot", +(ex.rotorRot - ex.statorRot).toFixed(1)); applied.push("rotorRot");
    setAutoInfo({ ...ex, applied, aligned: true });
  };
  const exportAlignedDxf = () => {
    if (!dxf) { alert("먼저 DXF를 불러오세요."); return; }
    const txt = shapesToDxf(dxf, dxfT);
    const blob = new Blob([txt], { type: "application/dxf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (dxfName.replace(/\.dxf$/i, "") || "section") + "_aligned.dxf";
    a.click(); URL.revokeObjectURL(url);
  };
  const mDist = mPts.length === 2 ? Math.hypot(mPts[1][0] - mPts[0][0], mPts[1][1] - mPts[0][1]) : null;

  const SFIELDS = [
    ["slotNumber", "Slot Number", 1], ["statorLamDia", "Stator Lam Dia", 0.01], ["statorBore", "Stator Bore", 0.01],
    ["toothWidth", "Tooth Width", 0.01], ["slotDepth", "Slot Depth", 0.01], ["toothTipDepth", "Tooth Tip Depth", 0.01],
    ["slotOpening", "Slot Opening", 0.01], ["toothTipAngle", "Tooth Tip Angle", 0.1], ["statorRot", "Stator Rotation [°]", 0.5],
  ];
  const RFIELDS = [
    ["poleNumber", "Pole Number", 1], ["magnetThickness", "Magnet Thickness", 0.01], ["magnetReduction", "Magnet Reduction", 0.01],
    ["magnetArcED", "Magnet Arc [ED]", 0.5], ["airgap", "Airgap", 0.01], ["bandingThickness", "Banding Thickness", 0.01],
    ["shaftDia", "Shaft Dia", 0.01], ["rotorRot", "Rotor Rotation [°]", 0.5],
  ];
  const AFIELDS = [
    ["stackLength", "Stator Lam Length", 0.1], ["rotorLamLength", "Rotor Lam Length", 0.1],
    ["magnetLength", "Magnet Length", 0.1], ["magneticLength", "Magnetic Axial Length", 0.1], ["motorLength", "Motor Length", 0.1],
  ];

  return (
    <div className="flex h-full">
      <div className="w-60 overflow-y-auto flex-shrink-0" style={{ background: "#FAFBFC", borderRight: "1px solid #D5DBE1" }}>
        <div className="p-2 flex flex-col gap-1">
          <button onClick={() => fileRef.current?.click()} className="text-xs px-2 py-1.5 rounded text-white font-medium" style={{ background: "#B5622D" }}>DXF 불러오기</button>
          <input ref={fileRef} type="file" accept=".dxf" className="hidden"
            onChange={(e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; }} />
          {dxfName && <div className="text-xs truncate" style={{ color: "#1B7A2B", fontFamily: "Consolas,monospace" }}>{dxfName}</div>}
          <div className="flex gap-1">
            <button onClick={fitView} className="flex-1 text-xs px-2 py-1 rounded" style={{ border: "1px solid #1A222C", background: "#fff" }}>화면 맞춤</button>
            <button onClick={() => { setMeasure(!measure); setMPts([]); }} className="flex-1 text-xs px-2 py-1 rounded"
              style={{ border: "1px solid #1A222C", background: measure ? "#1A222C" : "#fff", color: measure ? "#fff" : "#1A222C" }}>
              측정 {measure ? "ON" : "OFF"}
            </button>
          </div>
          <button onClick={autoExtract} className="text-xs px-2 py-1.5 rounded text-white font-medium"
            style={{ background: "#1B7A2B", cursor: "pointer" }}>
            ⚙ 자동 정렬·형상 추출{!dxf && " (DXF 선택)"}
          </button>
          {dxf && (
            <button onClick={exportAlignedDxf} className="text-xs px-2 py-1 rounded font-medium"
              style={{ border: "1px solid #1B7A2B", color: "#1B7A2B", background: "#fff", cursor: "pointer" }}>
              ⬇ 정렬 DXF 내보내기
            </button>
          )}
          {autoInfo && (
            <div className="text-xs rounded p-2 mt-0.5" style={{ background: "#F0F7F1", border: "1px solid #BBD9C0", fontFamily: "Consolas,monospace", lineHeight: 1.5 }}>
              <div className="font-bold mb-0.5" style={{ color: "#1B7A2B" }}>추출 결과 (단위 ×{autoInfo.unit})</div>
              <div>OD {autoInfo.statorLamDia} · 보어 {autoInfo.statorBore} · 샤프트 {autoInfo.shaftDia || "—"}</div>
              <div>슬롯 {autoInfo.slotCount || "?"} · 극 {autoInfo.poleCount || "?"} · 에어갭 {autoInfo.airgap || "?"}</div>
              <div>회전 stator {autoInfo.statorRot}° · rotor {autoInfo.rotorRot}°</div>
              <div style={{ color: "#5C6B7A" }}>동심원 Ø: {autoInfo.dias.join(", ") || "없음"}</div>
              <div style={{ color: "#5C6B7A" }}>폴리 외측 {autoInfo.outerN}→슬롯 {autoInfo.slotCount} · 내측 {autoInfo.innerN}→극 {autoInfo.poleCount} · 폴리보어 {autoInfo.borePoly || "—"}</div>
              <div style={{ color: "#8893A0", marginTop: 2 }}>적용 {autoInfo.applied.length}개 — 오버레이 확인 후 미세조정</div>
            </div>
          )}
        </div>
        <SectionHead color="#E03030">Stator Parameters</SectionHead>
        {SFIELDS.map(([k, l, s]) => <NumIn key={k} label={l} value={geo[k]} step={s} onChange={(v) => sG(k, v)} />)}
        <SectionHead color="#22BB22">Rotor Parameters</SectionHead>
        {RFIELDS.map(([k, l, s]) => <NumIn key={k} label={l} value={geo[k]} step={s} onChange={(v) => sG(k, v)} />)}
        <div className="flex items-center justify-between px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F1F4F6" }}>
          <span className="text-xs" style={{ color: "#5C6B7A" }}>Rotor Diameter [Calc]</span>
          <span className="text-xs font-semibold" style={{ fontFamily: "Consolas,monospace" }}>{rotorDia.toFixed(2)}</span>
        </div>
        <SectionHead color="#5C6B7A">Axial Dimensions</SectionHead>
        {AFIELDS.map(([k, l, s]) => <NumIn key={k} label={l} value={geo[k]} step={s} onChange={(v) => sG(k, v)} />)}
        <SectionHead color="#1B7A2B">DXF Transform</SectionHead>
        {[["scale", "Scale", 0.001], ["dx", "Offset X", 0.1], ["dy", "Offset Y", 0.1], ["rot", "Rotation [°]", 0.5]].map(([k, l, s]) => (
          <NumIn key={k} label={l} value={dxfT[k]} step={s} onChange={(v) => setDxfT((t) => ({ ...t, [k]: v }))} />
        ))}
        <SectionHead color="#8893A0">Layers</SectionHead>
        {[["dxf", "DXF 단면"], ["stator", "Stator Lam"], ["slots", "Slots"], ["rotor", "Rotor / Shaft"], ["magnets", "Magnets"]].map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 px-2 py-0.5 text-xs cursor-pointer" style={{ borderTop: "1px solid #E2E6EA" }}>
            <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((L) => ({ ...L, [k]: e.target.checked }))} />{l}
          </label>
        ))}
        <div className="px-2 py-2" style={{ borderTop: "1px solid #E2E6EA" }}>
          <div className="text-xs mb-1" style={{ color: "#5C6B7A" }}>템플릿 투명도</div>
          <input type="range" min="0.05" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(parseFloat(e.target.value))} className="w-full" />
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <div ref={wrapRef} className="flex-1 relative min-h-0">
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full"
            style={{ cursor: measure ? "crosshair" : "grab" }}
            onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove}
            onMouseUp={() => (dragRef.current = null)} onMouseLeave={() => (dragRef.current = null)} />
        </div>
        <div className="flex items-center gap-4 px-3 py-1 text-xs" style={{ background: "#1A222C", color: "#C8CFD6", fontFamily: "Consolas,monospace" }}>
          {cursor && <span>X {cursor[0].toFixed(2)} Y {cursor[1].toFixed(2)} R {Math.hypot(cursor[0], cursor[1]).toFixed(3)} (Ø{(2 * Math.hypot(cursor[0], cursor[1])).toFixed(2)})</span>}
          {mPts.length === 1 && <span style={{ color: "#F59E0B" }}>측정: 두 번째 점 클릭</span>}
          {mDist !== null && <span style={{ color: "#F59E0B" }}>거리 {mDist.toFixed(3)} | R1 {Math.hypot(mPts[0][0], mPts[0][1]).toFixed(3)} | R2 {Math.hypot(mPts[1][0], mPts[1][1]).toFixed(3)}</span>}
          <div className="flex-1" />
          {res && <span>Slot Area {res.slotArea.toFixed(1)} mm² · kw1 {res.kw1.toFixed(4)}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Winding 탭 (슬롯 단면 비주얼 + 도선 패킹) ──────────────────
function packConductors(geo, wind) {
  // 슬롯 로컬 좌표(x: 반경방향, y: 접선방향)에서 도선 원 배치
  const Rb = geo.statorBore / 2, Rd = Rb + geo.slotDepth;
  const dlt = Math.PI / geo.slotNumber;
  const halfOp = geo.slotOpening / 2;
  const x1 = Math.sqrt(Math.max(Rb * Rb - halfOp * halfOp, 0));
  const liner = wind.linerThk, r = wind.wireDia / 2, sep = wind.condSep;
  const wallLim = geo.toothWidth / 2 + liner;           // 치 중심선으로부터 최소거리
  const wedgeHold = wind.wedgeModel === "wound" ? 0 : wind.wedgeDepth;
  const xMin = x1 + geo.toothTipDepth + wedgeHold + liner;
  const RdL = Rd - liner;
  const divHalf = wind.coilDivider / 2;
  const sD = Math.sin(dlt), cD = Math.cos(dlt);
  const ok = (x, y) => {
    if (x < xMin + r) return false;
    if (Math.hypot(x, y) > RdL - r) return false;
    if (sD * x - cD * y < wallLim + r) return false;    // 상부 치 벽
    if (sD * x + cD * y < wallLim + r) return false;    // 하부 치 벽
    if (Math.abs(y) < divHalf + r + sep / 2) return false; // 코일 디바이더
    return true;
  };
  const pitch = wind.wireDia + sep;
  const targetSide = wind.turnsPerCoil * wind.strands;
  const rowH = pitch * Math.sqrt(3) / 2;
  // 치 벽에 평행한 행으로 채운다: 첫 행이 벽에 밀착(개구→백아이언 방향),
  // 행마다 안쪽(디바이더 쪽)으로 rowH씩 + 반 피치 육각 엇갈림.
  // → 비스듬한 치 벽(테이퍼)을 따라 빈틈없이 채워짐 (Motor-CAD 단면 방식).
  const packSide = (s) => {
    const uwx = cD, uwy = s * sD;                          // 벽 방향(개구→백아이언) 단위벡터
    const nx = sD, ny = -s * cD;                           // 벽→디바이더 안쪽 법선 단위벡터
    const bx0 = xMin, by0 = s * (sD * xMin - wallLim) / cD; // 개구쪽 치 벽 시작점
    const cells = [];
    for (let m = 0; m < 120; m++) {
      const dist = r + 1e-4 + m * rowH;                    // 벽으로부터 수직거리(첫 행은 벽 밀착)
      const ox = bx0 + dist * nx, oy = by0 + dist * ny;
      const tStart = (m % 2) * (pitch / 2);                // 육각 엇갈림
      let any = false;
      for (let j = 0; j < 240; j++) {
        const t = tStart + j * pitch;
        const x = ox + t * uwx, y = oy + t * uwy;
        if (x > RdL + r) break;                            // 백아이언 넘음 → 행 종료
        if (ok(x, y) && s * y > 0) { cells.push([x, y]); any = true; } // 자기 절반만(디바이더 넘지 않음)
        else if (any) break;                               // 디바이더/반대 끝 넘음 → 행 종료
      }
      if (dist > RdL) break;                               // 안전 종료
    }
    return cells;
  };
  const right = packSide(1), left = packSide(-1);
  return {
    left: left.slice(0, targetSide), right: right.slice(0, targetSide),
    capacity: Math.min(left.length, right.length), targetSide,
    geo: { x1, Rd, RdL, xMin, dlt, wallLim, divHalf },
  };
}

function SlotViewer({ geo, wind, res }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const pack = useMemo(() => packConductors(geo, wind), [geo, wind]);

  const draw = useCallback(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);

    const P = geo;
    const Rb = P.statorBore / 2, Rd = Rb + P.slotDepth, RoL = P.statorLamDia / 2;
    const dlt = Math.PI / P.slotNumber;
    // 표시 범위: 반경 Rb-3 ~ Rd+4, 접선 ±(피치 0.95)
    const xLo = Rb - 3, xHi = Math.min(Rd + 4, RoL);
    const yHalf = (Rb + P.slotDepth / 2) * Math.tan(dlt) * 1.25;
    const sc = Math.min(W / (2 * yHalf), H / (xHi - xLo)) * 0.94;
    // 화면: y_local → 가로, x_local → 세로(개구가 아래)
    const toS = (x, y) => [W / 2 + y * sc, H - (H - (xHi - xLo) * sc) / 2 - (x - xLo) * sc];
    const poly = (pts, close = true) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const [sx, sy] = toS(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      if (close) ctx.closePath();
    };
    const arcPts = (R, a1, a2, n = 60) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const t = a1 + (a2 - a1) * i / n;
        return [R * Math.cos(t), R * Math.sin(t)];
      });

    // 1) 적층(빨강): 슬롯피치 섹터
    const aS = dlt * 1.25;
    ctx.fillStyle = "#E03030";
    poly([...arcPts(xLo + 0.01, -aS, aS), ...arcPts(Math.min(RoL, xHi), aS, -aS)]);
    ctx.fill();
    // 2) 슬롯 내부(라이너 색으로 먼저 채움)
    const slot = buildSlotPath(P);
    ctx.fillStyle = "#1E7A1E";
    poly(slot); ctx.fill();
    // 3) 권선영역(밝은 녹색): 라이너 안쪽
    const g2 = pack.geo;
    const u = [Math.cos(dlt), Math.sin(dlt)];
    const wl = g2.wallLim;
    const tEnd = Math.sqrt(Math.max(g2.RdL ** 2 - wl ** 2, 0));
    const tAtXmin = (g2.xMin - Math.sin(dlt) * wl) / Math.cos(dlt);
    const W1 = [g2.xMin, tAtXmin * Math.sin(dlt) - Math.cos(dlt) * wl];
    const Wtop = [tEnd * Math.cos(dlt) + Math.sin(dlt) * wl, tEnd * Math.sin(dlt) - Math.cos(dlt) * wl];
    const aT = Math.atan2(Wtop[1], Wtop[0]);
    const wpoly = [W1, Wtop, ...arcPts(g2.RdL, aT, -aT, 40), [Wtop[0], -Wtop[1]], [W1[0], -W1[1]]];
    ctx.fillStyle = "#66DD66";
    poly(wpoly); ctx.fill();
    // 4) 웨지(회색): 팁 영역 — Wedge 모델일 때만
    if (wind.wedgeModel === "wedge") {
      const halfOp = P.slotOpening / 2;
      const xw0 = g2.x1 + P.toothTipDepth, xw1 = xw0 + wind.wedgeDepth;
      ctx.fillStyle = "#AEBDC8";
      poly([[xw0, halfOp + 0.35], [xw1, halfOp + 0.9], [xw1, -halfOp - 0.9], [xw0, -halfOp - 0.35]]);
      ctx.fill();
    }
    // 5) 코일 디바이더(연회색 세로 막대)
    ctx.fillStyle = "#E8EEF2";
    poly([[g2.xMin, g2.divHalf], [g2.RdL - 0.2, g2.divHalf], [g2.RdL - 0.2, -g2.divHalf], [g2.xMin, -g2.divHalf]]);
    ctx.fill();
    // 6) 도선 원 (노랑 + 절연 링)
    const rW = wind.wireDia / 2, rC = wind.copperDia / 2;
    const drawC = ([x, y]) => {
      const [sx, sy] = toS(x, y);
      ctx.beginPath(); ctx.arc(sx, sy, rW * sc, 0, Math.PI * 2);
      ctx.fillStyle = "#CC4444"; ctx.fill();           // 절연(에나멜)
      ctx.beginPath(); ctx.arc(sx, sy, rC * sc, 0, Math.PI * 2);
      ctx.fillStyle = "#F5E020"; ctx.fill();           // 동선
      ctx.strokeStyle = "#8A7700"; ctx.lineWidth = 0.5; ctx.stroke();
    };
    pack.left.forEach(drawC); pack.right.forEach(drawC);
    // 외곽선
    ctx.strokeStyle = "#7A1212"; ctx.lineWidth = 1;
    poly(slot); ctx.stroke();
  }, [geo, wind, pack]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [draw]);

  const fit = pack.capacity >= pack.targetSide;
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div ref={wrapRef} className="flex-1 relative min-h-0" style={{ background: "#fff" }}>
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>
      <div className="flex items-center gap-4 px-3 py-1 text-xs"
        style={{ background: fit ? "#1A222C" : "#7A1212", color: "#fff", fontFamily: "Consolas,monospace" }}>
        <span>도체 배치: {Math.min(pack.capacity, pack.targetSide)} / {pack.targetSide} (편측) · 슬롯당 {2 * Math.min(pack.capacity, pack.targetSide)}</span>
        {!fit && <span>⚠ 공간 부족 — 슬롯에 {pack.capacity}가닥/측까지만 들어감 (와이어 지름·턴수·라이너 확인)</span>}
        {res && <span style={{ color: res.cuSlotFill <= 0.30 ? "#7CFC9A" : "#FFC04D" }}>
          나동선 점적률 {(res.cuSlotFill * 100).toFixed(1)}% · {res.cuSlotFill <= 0.30 ? "기계권선 가능(≤30%)" : "기계권선 한계 초과(>30%)"}
        </span>}
        <div className="flex-1" />
        <span>라이너 {wind.linerThk} · 웨지 {wind.wedgeDepth} · 디바이더 {wind.coilDivider} · 간격 {wind.condSep}</span>
      </div>
    </div>
  );
}

function WindingTab({ geo, wind, sW, res, showRef }) {
  const [wireType, setWireType] = useState("direct");
  const [windView, setWindView] = useState("section");
  if (!res) return null;
  const wa = res.wa;
  const harmonics = [1, 3, 5, 7, 9, 11, 13];
  return (
    <div className="flex h-full overflow-hidden">
      {/* 좌: 입력 */}
      <div className="w-60 overflow-y-auto flex-shrink-0" style={{ background: "#FAFBFC", borderRight: "1px solid #D5DBE1" }}>
        <SectionHead color="#B5622D">Winding Definition</SectionHead>
        <NumIn label="Turns (per coil)" value={wind.turnsPerCoil} step={1} onChange={(v) => sW("turnsPerCoil", v)} />
        <NumIn label="Throw (coil span)" value={wind.throw} step={1} onChange={(v) => sW("throw", v)} />
        <NumIn label="Parallel Paths" value={wind.parallelPaths} step={1} onChange={(v) => sW("parallelPaths", v)} />
        <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA" }}>
          <span className="text-xs">Connection</span>
          <select value={wind.connection} onChange={(e) => sW("connection", e.target.value)}
            className="text-xs px-1 py-0.5 rounded" style={{ border: "1px solid #C8CFD6" }}>
            <option value="delta">Delta</option><option value="star">Star</option>
          </select>
        </div>
        <SectionHead color="#CC8800">Wire Selection</SectionHead>
        <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA" }}>
          <span className="text-xs">Wire Type</span>
          <select value={wireType} onChange={(e) => setWireType(e.target.value)}
            className="text-xs px-1 py-0.5 rounded" style={{ border: "1px solid #C8CFD6" }}>
            <option value="direct">Diameter Input</option>
            <option value="Metric">Metric Table</option>
            <option value="AWG">AWG Table</option>
            <option value="SWG">SWG Table</option>
          </select>
        </div>
        {wireType !== "direct" && (
          <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA" }}>
            <span className="text-xs">Gauge</span>
            <select value=""
              onChange={(e) => {
                const w = WIRE_TABLES[wireType][+e.target.value];
                if (w) { sW("copperDia", w.cu); sW("wireDia", w.cov); }
              }}
              className="text-xs px-1 py-0.5 rounded w-32" style={{ border: "1px solid #C8CFD6", fontFamily: "Consolas,monospace" }}>
              <option value="">— 선택 —</option>
              {WIRE_TABLES[wireType].map((w, i) => (
                <option key={i} value={i}>{w.label} → 피복 {w.cov.toFixed(3)}</option>
              ))}
            </select>
          </div>
        )}
        <NumIn label="Wire Diameter" value={wind.wireDia} step={0.01} onChange={(v) => sW("wireDia", v)} />
        <NumIn label="Copper Diameter" value={wind.copperDia} step={0.01} onChange={(v) => sW("copperDia", v)} />
        <NumIn label="Strands in Hand" value={wind.strands} step={1} onChange={(v) => sW("strands", v)} />
        <SectionHead color="#1E7A1E">Insulation / 슬롯 내부</SectionHead>
        <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA" }}>
          <span className="text-xs">Wedge Model</span>
          <select value={wind.wedgeModel} onChange={(e) => sW("wedgeModel", e.target.value)}
            className="text-xs px-1 py-0.5 rounded" style={{ border: "1px solid #C8CFD6" }}>
            <option value="wedge">Wedge</option>
            <option value="wound">Wound Space</option>
            <option value="air">Air</option>
          </select>
        </div>
        <NumIn label="Liner Thickness" value={wind.linerThk} step={0.05} onChange={(v) => sW("linerThk", v)} />
        <NumIn label="Wedge Depth" value={wind.wedgeDepth} step={0.1} onChange={(v) => sW("wedgeDepth", v)} />
        <NumIn label="Coil Divider" value={wind.coilDivider} step={0.05} onChange={(v) => sW("coilDivider", v)} />
        <NumIn label="Conductor Separation" value={wind.condSep} step={0.01} onChange={(v) => sW("condSep", v)} />
        <SectionHead color="#5C6B7A">계산 결과</SectionHead>
        <table className="w-full"><tbody>
          <Row label="Coils / Phase" value={wa.coilsPerPhase} />
          <Row label="Turns / Phase" value={res.turnsPerPhase} refv={showRef ? REF.turnsPerPhase : undefined} />
          <Row label="Conductors / Slot" value={res.condPerSlot} refv={showRef ? REF.condPerSlot : undefined} />
          <Row label="Slot Area" value={res.slotArea.toFixed(1)} unit="mm²" refv={showRef ? REF.slotArea : undefined} />
          <Row label="Wire Slot Fill" value={res.wireSlotFill.toFixed(4)} refv={showRef ? REF.wireSlotFill : undefined} />
          <Row label="Cu Slot Fill" value={res.cuSlotFill.toFixed(4)} refv={showRef ? REF.cuSlotFill : undefined} />
          <Row label="Mean Coil Pitch" value={res.coilPitch.toFixed(2)} unit="mm" refv={showRef ? REF.coilPitch : undefined} />
          <Row label="MLT" value={res.MLT.toFixed(2)} unit="mm" refv={showRef ? REF.MLT : undefined} />
          <Row label="EWdg MLT" value={res.ewdgMLT.toFixed(2)} unit="mm" refv={showRef ? REF.ewdgMLT : undefined} />
        </tbody></table>
        <SectionHead color="#1B7A2B">슬롯 면적 분해 (근사)</SectionHead>
        <table className="w-full"><tbody>
          <Row label="Winding Area (+Liner)" value={res.windingAreaLiner.toFixed(1)} unit="mm²" refv={showRef ? REF.windingAreaLiner : undefined} />
          <Row label="Winding Area" value={res.windingArea.toFixed(1)} unit="mm²" refv={showRef ? REF.windingArea : undefined} />
          <Row label="Winding Depth" value={res.windingDepth.toFixed(2)} unit="mm" refv={showRef ? REF.windingDepth : undefined} />
          <Row label="Covered Wire Area" value={res.coveredWireArea.toFixed(2)} unit="mm²" refv={showRef ? REF.coveredWireArea : undefined} />
          <Row label="Copper Area" value={res.copperArea.toFixed(2)} unit="mm²" refv={showRef ? REF.copperArea : undefined} />
          <Row label="Impreg Area" value={res.impregArea.toFixed(2)} unit="mm²" refv={showRef ? REF.impregArea : undefined} />
          <Row label="Wedge Area" value={res.wedgeArea.toFixed(3)} unit="mm²" refv={showRef ? REF.wedgeArea : undefined} />
          <Row label="Liner Area" value={res.linerArea.toFixed(2)} unit="mm²" refv={showRef ? REF.linerArea : undefined} />
          <Row label="Coil Divider Area" value={res.dividerArea.toFixed(3)} unit="mm²" refv={showRef ? REF.dividerArea : undefined} />
          <Row label="Wire Fill (Wdg Area)" value={res.wireFillWdg.toFixed(4)} refv={showRef ? REF.wireFillWdg : undefined} />
          <Row label="Heavy Build Slot Fill" value={res.heavyBuildFill.toFixed(3)} refv={showRef ? REF.heavyBuildFill : undefined} />
        </tbody></table>
      </div>
      {/* 중앙: 슬롯 단면 / 권선 배치도 전환 */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex gap-0.5 px-3 pt-1.5" style={{ background: "#F0F2F4", borderBottom: "1px solid #D5DBE1" }}>
          {[["section", "슬롯 단면"], ["layout", "권선 배치도"]].map(([k, l]) => (
            <button key={k} onClick={() => setWindView(k)} className="text-xs px-3 py-1 rounded-t"
              style={{ background: windView === k ? "#fff" : "#DDE2E7", border: "1px solid #C8CFD6", borderBottom: windView === k ? "1px solid #fff" : "1px solid #C8CFD6", marginBottom: -1, fontWeight: windView === k ? 600 : 400 }}>
              {l}
            </button>
          ))}
        </div>
        {windView === "section" ? <SlotViewer geo={geo} wind={wind} res={res} /> : <WindingLayout geo={geo} res={res} />}
      </div>
      {/* 우: 패턴/권선계수 */}
      <div className="w-64 overflow-y-auto flex-shrink-0 p-2 flex flex-col gap-3" style={{ background: "#FAFBFC", borderLeft: "1px solid #D5DBE1" }}>
        <div className="rounded" style={{ background: "#fff", border: "1px solid #D5DBE1" }}>
          <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #D5DBE1" }}>Winding Factors</div>
          <table className="text-xs w-full" style={{ fontFamily: "Consolas,monospace" }}>
            <tbody>
              {harmonics.map((h) => (
                <tr key={h} style={{ borderTop: "1px solid #EEF1F4", background: h === 1 ? "#FCF6EE" : undefined }}>
                  <td className="px-3 py-0.5 text-center">{h}</td>
                  <td className="px-3 py-0.5 text-right">{wa.kw(h).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {showRef && <div className="px-2 py-1 text-xs" style={{ color: "#1B7A2B" }}>참조 kw1 = 0.945214</div>}
        </div>
        <div className="rounded" style={{ background: "#fff", border: "1px solid #D5DBE1" }}>
          <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #D5DBE1" }}>Radial Pattern (슬롯별 도체수)</div>
          <table className="text-xs w-full" style={{ fontFamily: "Consolas,monospace" }}>
            <thead><tr style={{ background: "#E8EBEE" }}>
              <th className="px-1 py-0.5">Slot</th><th className="px-1 py-0.5">Tot</th>
              <th className="px-1 py-0.5" style={{ color: "#CC2222" }}>Ph1</th>
              <th className="px-1 py-0.5" style={{ color: "#1B7A2B" }}>Ph2</th>
              <th className="px-1 py-0.5" style={{ color: "#2244CC" }}>Ph3</th>
            </tr></thead>
            <tbody>
              {/* Motor-CAD 슬롯 번호 기준(슬롯1 = Ph1 집중)에 맞춰 1슬롯 오프셋 정렬 */}
              {wa.table.map((_, i) => {
                const r = wa.table[(i + wa.table.length - 1) % wa.table.length];
                return (
                  <tr key={i} style={{ borderTop: "1px solid #EEF1F4" }}>
                    <td className="px-1 text-center">{i + 1}</td>
                    <td className="px-1 text-center">{Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2])}</td>
                    {/* Motor-CAD All Phases와 동일하게 크기(절대값) 표시 — 권선 방향(go/return)은 배치도 ×/•로 */}
                    {r.map((v, j) => <td key={j} className="px-1 text-right">{v !== 0 ? Math.abs(v) : ""}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Materials 탭 (Motor-CAD Input Data > Materials 그리드) ─────
function MaterialsTab({ mat, sM, res, showRef }) {
  const pickSteel = (name) => { const s = STEELS[name]; sM("steel", name); sM("kh", s.kh); sM("ke", s.ke); };
  const pickMag = (name) => { const m = MAGNETS[name]; sM("magnet", name); sM("Br20", m.Br20); sM("tcBr", m.tc); sM("mur", m.mur); };
  const stl = STEELS[mat.steel], mg = MAGNETS[mat.magnet];
  const SteelSel = () => (
    <select value={mat.steel} onChange={(e) => pickSteel(e.target.value)} className="text-xs px-1 py-0.5 rounded w-32" style={{ border: "1px solid #C8CFD6" }}>
      {Object.keys(STEELS).map((k) => <option key={k}>{k}</option>)}
    </select>
  );
  const td = "px-2 py-1 text-xs";
  const tdr = td + " text-right";
  const mono = { fontFamily: "Consolas,monospace" };
  const TR = ({ children, total }) => (
    <tr style={{ borderTop: "1px solid #E2E6EA", background: total ? "#F1F4F6" : undefined }}>{children}</tr>
  );
  if (!res) return null;
  return (
    <div className="h-full overflow-auto p-3">
      <table className="text-xs" style={{ background: "#fff", border: "1px solid #C8CFD6" }}>
        <thead>
          <tr style={{ background: "#DCE3E9" }}>
            {["Component", "Material from Database", "Electrical Resistivity", "Magnet Br at 20°C", "Magnet Rel. Permeability", "Temp Coef Br", "Density", "Weight"].map((h) => (
              <th key={h} className="px-2 py-1.5 font-semibold" style={{ borderLeft: "1px solid #C8CFD6" }}>{h}</th>
            ))}
          </tr>
          <tr style={{ background: "#F1F4F6", color: "#2244AA" }}>
            <td className={td}>Units</td><td className={td}></td><td className={tdr}>Ohm.m</td>
            <td className={tdr}>Tesla</td><td className={td}></td><td className={tdr}>%/°C</td>
            <td className={tdr}>kg/m³</td><td className={tdr}>kg</td>
          </tr>
        </thead>
        <tbody style={mono}>
          <TR><td className={td}>Stator Lam (Back Iron)</td><td className={td}><SteelSel /></td><td className={tdr}>5.5E-07</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{stl.density}</td><td className={tdr}>{res.mBy.toFixed(4)}</td></TR>
          <TR><td className={td}>Stator Lam (Tooth)</td><td className={td}><SteelSel /></td><td className={tdr}>5.5E-07</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{stl.density}</td><td className={tdr}>{res.mTooth.toFixed(4)}</td></TR>
          <TR total><td className={td}>Stator Lamination [Total]</td><td className={td}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{res.mStator.toFixed(4)}{showRef && <span style={{ color: "#1B7A2B" }}> ({REF.mStator})</span>}</td></TR>
          <TR><td className={td}>Armature Winding [Active]</td><td className={td}>Copper (Pure)</td><td className={tdr}>1.724E-08</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>8933</td><td className={tdr}>{res.mCuActive.toFixed(4)}</td></TR>
          <TR><td className={td}>Armature EWdg [Front]</td><td className={td}>Copper (Pure)</td><td className={tdr}>1.724E-08</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>8933</td><td className={tdr}>{res.mCuEwdg.toFixed(4)}</td></TR>
          <TR><td className={td}>Armature EWdg [Rear]</td><td className={td}>Copper (Pure)</td><td className={tdr}>1.724E-08</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>8933</td><td className={tdr}>{res.mCuEwdg.toFixed(4)}</td></TR>
          <TR total><td className={td}>Armature Winding [Total]</td><td className={td}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{res.mCopper.toFixed(4)}{showRef && <span style={{ color: "#1B7A2B" }}> ({REF.mCopper})</span>}</td></TR>
          <TR><td className={td}>Rotor Lam (Back Iron)</td><td className={td}><SteelSel /></td><td className={tdr}>5.5E-07</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{stl.density}</td><td className={tdr}>{res.mRotor.toFixed(4)}{showRef && <span style={{ color: "#1B7A2B" }}> ({REF.mRotor})</span>}</td></TR>
          <TR>
            <td className={td}>Magnet</td>
            <td className={td}>
              <select value={mat.magnet} onChange={(e) => pickMag(e.target.value)} className="text-xs px-1 py-0.5 rounded w-32" style={{ border: "1px solid #C8CFD6" }}>
                {Object.keys(MAGNETS).map((k) => <option key={k}>{k}</option>)}
              </select>
            </td>
            <td className={tdr}>1.8E-06</td><td className={tdr}>{mat.Br20}</td><td className={tdr}>{mat.mur}</td><td className={tdr}>{mat.tcBr}</td>
            <td className={tdr}>{mg.density}</td><td className={tdr}>{res.mMagnet.toFixed(4)}{showRef && <span style={{ color: "#1B7A2B" }}> ({REF.mMagnet})</span>}</td>
          </TR>
          <TR total><td className={td} style={{ fontWeight: 700 }}>Total Weight (Active)</td><td className={td}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr} style={{ fontWeight: 700 }}>{res.mActive.toFixed(3)}</td></TR>
        </tbody>
      </table>
      <div className="flex gap-3 mt-3 flex-wrap">
        <div className="rounded" style={{ background: "#fff", border: "1px solid #D5DBE1" }}>
          <SectionHead color="#22BB22">자석 물성 편집</SectionHead>
          <NumIn label="Br @20°C [T]" value={mat.Br20} step={0.01} onChange={(v) => sM("Br20", v)} />
          <NumIn label="Temp Coef Br [%/°C]" value={mat.tcBr} step={0.005} onChange={(v) => sM("tcBr", v)} />
          <NumIn label="μr" value={mat.mur} step={0.01} onChange={(v) => sM("mur", v)} />
        </div>
        <div className="rounded" style={{ background: "#fff", border: "1px solid #D5DBE1" }}>
          <SectionHead color="#E03030">강판 철손계수 (Steinmetz)</SectionHead>
          <NumIn label="kh (히스테리시스)" value={mat.kh} step={0.001} onChange={(v) => sM("kh", v)} />
          <NumIn label="ke (와전류)" value={mat.ke} step={1e-6} onChange={(v) => sM("ke", v)} />
          <div className="px-2 py-1 text-xs" style={{ color: "#8893A0" }}>기본값: 20PNX1200F를 1250W FEA 철손으로 캘리브레이션</div>
        </div>
      </div>
    </div>
  );
}

// ─── Calculation 탭 (Motor-CAD Drive 패널) ──────────────────────
function CalculationTab({ calc, sC, wind, sW, res, solved, setSolved }) {
  const Radio = ({ group, val, label, cur, onPick, disabled }) => (
    <label className={"flex items-center gap-1.5 text-xs py-0.5 " + (disabled ? "opacity-40" : "cursor-pointer")}>
      <input type="radio" name={group} checked={cur === val} disabled={disabled} onChange={() => onPick(val)} />{label}
    </label>
  );
  const Box = ({ title, children }) => (
    <fieldset className="rounded px-2 pb-1.5 pt-0.5 mb-2" style={{ border: "1px solid #C8CFD6", background: "#fff" }}>
      <legend className="text-xs px-1 font-semibold" style={{ color: "#2A3540" }}>{title}</legend>
      {children}
    </fieldset>
  );
  const IlinePk = calc.IlineRms * Math.SQRT2;
  return (
    <div className="flex h-full overflow-auto gap-3 p-3 items-start">
      {/* ── Col 1: Drive ── */}
      <div className="w-72 flex-shrink-0">
        <Box title="Drive">
          <NumIn label="Shaft Speed [rpm]" value={calc.speed} step={10} onChange={(v) => sC("speed", v)} />
          <div className="text-xs font-semibold mt-1.5 mb-0.5">Line Current Definition:</div>
          <Radio group="cdef" val="peak" label="Peak" cur={calc.currentDef} onPick={(v) => sC("currentDef", v)} />
          <Radio group="cdef" val="rms" label="RMS" cur={calc.currentDef} onPick={(v) => sC("currentDef", v)} />
          <div className="mt-1" />
          {calc.currentDef === "peak" ? (
            <NumIn label="Line Current — Peak [A]" value={+(IlinePk.toFixed(2))} step={0.1} onChange={(v) => sC("IlineRms", v / Math.SQRT2)} />
          ) : (
            <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F6F8FA" }}>
              <span className="text-xs" style={{ color: "#8893A0" }}>Line Current — Peak [A]</span>
              <span className="text-xs" style={{ fontFamily: "Consolas,monospace" }}>{IlinePk.toFixed(2)}</span>
            </div>
          )}
          {calc.currentDef === "rms" ? (
            <NumIn label="Line Current — RMS [A]" value={calc.IlineRms} step={0.1} onChange={(v) => sC("IlineRms", v)} />
          ) : (
            <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F6F8FA" }}>
              <span className="text-xs" style={{ color: "#8893A0" }}>Line Current — RMS [A]</span>
              <span className="text-xs" style={{ fontFamily: "Consolas,monospace" }}>{calc.IlineRms.toFixed(2)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F6F8FA" }}>
            <span className="text-xs" style={{ color: "#8893A0" }}>Phase Current (RMS)</span>
            <span className="text-xs" style={{ fontFamily: "Consolas,monospace", fontWeight: 600 }}>{res ? res.IphRms.toFixed(2) : "—"} A</span>
          </div>
          <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F6F8FA" }}>
            <span className="text-xs" style={{ color: "#8893A0" }}>Phase Current Density (RMS)</span>
            <span className="text-xs" style={{ fontFamily: "Consolas,monospace" }}>{res ? res.Jrms.toFixed(3) : "—"} A/mm²</span>
          </div>
          <NumIn label="DC Bus Voltage [V]" value={calc.Vdc} step={1} onChange={(v) => sC("Vdc", v)} />
          <NumIn label="Phase Advance [elec deg]" value={calc.phaseAdv} step={1} onChange={(v) => sC("phaseAdv", v)} />
        </Box>
        <Box title="Drive Mode">
          <Radio group="dmode" val="sine" label="Sine" cur={calc.driveMode} onPick={(v) => sC("driveMode", v)} />
          <Radio group="dmode" val="square" label="Square (미지원)" cur={calc.driveMode} onPick={() => {}} disabled />
        </Box>
        <Box title="Winding Connection">
          <Radio group="conn" val="star" label="Star Connection" cur={wind.connection} onPick={(v) => sW("connection", v)} />
          <Radio group="conn" val="delta" label="Delta Connection" cur={wind.connection} onPick={(v) => sW("connection", v)} />
        </Box>
        <Box title="Magnetisation">
          <Radio group="magz" val="parallel" label="Parallel" cur={calc.magnetisation} onPick={(v) => sC("magnetisation", v)} />
          <Radio group="magz" val="radial" label="Radial (모델 동일 취급)" cur={calc.magnetisation} onPick={(v) => sC("magnetisation", v)} />
        </Box>
      </div>
      {/* ── Col 2: Temperatures + 보정 ── */}
      <div className="w-72 flex-shrink-0">
        <Box title="Temperatures">
          <NumIn label="Armature Winding Temp [°C]" value={calc.Tcu} step={5} onChange={(v) => sC("Tcu", v)} />
          <NumIn label="Magnet Temperature [°C]" value={calc.Tmag} step={5} onChange={(v) => sC("Tmag", v)} />
        </Box>
        <Box title="해석모델 보정계수">
          <NumIn label="자석 누설계수 klk" value={calc.klk} step={0.01} onChange={(v) => sC("klk", v)} />
          <NumIn label="치 자속계수 cT (FSCW)" value={calc.cT} step={0.01} onChange={(v) => sC("cT", v)} />
          <NumIn label="인덕턴스 보정 cL" value={calc.cL} step={0.1} onChange={(v) => sC("cL", v)} />
          <NumIn label="슬롯누설 보정 cLs" value={calc.cLs} step={0.01} onChange={(v) => sC("cLs", v)} />
          <NumIn label="기타 손실 [W]" value={calc.otherLoss} step={0.5} onChange={(v) => sC("otherLoss", v)} />
          <div className="px-2 py-1 text-xs" style={{ color: "#8893A0" }}>기본값은 1250W-jk FEA 캘리브레이션. 토폴로지가 다르면 재조정.</div>
        </Box>
      </div>
      {/* ── Col 3: Performance ── */}
      <div className="w-80 flex-shrink-0">
        <Box title="Performance Tests — Single Operating Point">
          {solved && res ? (
            <table className="w-full"><tbody>
              <Row label="Average Torque" value={res.torque.toFixed(4)} unit="Nm" hl />
              <Row label="Output Power" value={res.Pout.toFixed(1)} unit="W" />
              <Row label="System Efficiency" value={res.eff.toFixed(2)} unit="%" />
              <Row label="Line Current (rms)" value={res.IlineRms.toFixed(2)} unit="A" />
              <Row label="Phase Current (rms)" value={res.IphRms.toFixed(2)} unit="A" />
              <Row label="Fundamental Freq" value={res.fe.toFixed(1)} unit="Hz" />
            </tbody></table>
          ) : (
            <div className="text-xs py-4 text-center" style={{ color: "#8893A0" }}>
              아래 <b>Solve E-Magnetic Model</b>을 눌러 해석을 실행하세요.
            </div>
          )}
        </Box>
        <button
          onClick={() => setSolved(true)}
          className="w-full py-3 rounded font-semibold text-sm"
          style={{ border: "1px solid #1A222C", background: solved ? "#1B7A2B" : "#fff", color: solved ? "#fff" : "#1A222C" }}>
          {solved ? "✓ 해석 완료 — Output Data / Graphs 확인" : "Solve E-Magnetic Model"}
        </button>
        <div className="text-xs mt-1.5" style={{ color: "#8893A0" }}>해석식(closed-form) 엔진 — Solve 시 즉시 계산됩니다. 입력을 바꾸면 다시 Solve 해야 합니다.</div>
      </div>
    </div>
  );
}

// ─── Output Data 탭 (Motor-CAD 하위탭 구조) ─────────────────────
function OutputTab({ res, calc, showRef, solved }) {
  const [sub, setSub] = useState("drive");
  if (!solved) return <div className="p-6 text-sm" style={{ color: "#5C6B7A" }}>Calculation 탭에서 <b>Solve E-Magnetic Model</b>을 눌러 해석을 실행하면 결과가 표시됩니다.</div>;
  if (!res) return <div className="p-4 text-sm">계산 불가 — 입력값 확인</div>;
  const f = (v, d = 3) => Number(v).toFixed(d);
  const SUBS = [["drive", "Drive"], ["emag", "E-Magnetics"], ["flux", "Flux Densities"], ["loss", "Losses"], ["wdg", "Winding"], ["matl", "Materials"]];
  const Tbl = ({ children }) => (
    <div className="rounded flex-1 min-w-80" style={{ background: "#fff", border: "1px solid #C8CFD6" }}>
      <table className="w-full">
        <thead><tr style={{ background: "#DCE3E9" }}>
          <th className="px-2 py-1.5 text-xs text-left font-semibold">Variable</th>
          <th className="px-2 py-1.5 text-xs text-right font-semibold">Value</th>
          <th className="px-2 py-1.5 text-xs text-left font-semibold">Units</th>
          {showRef && <th className="px-2 py-1.5 text-xs text-right font-semibold" style={{ color: "#1B7A2B" }}>Motor-CAD</th>}
        </tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
  const r = (label, val, unit, refv, hl) => (
    <Row key={label} label={label} value={val} unit={unit} refv={showRef ? refv : undefined} hl={hl} />
  );
  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-0.5 px-3 pt-2" style={{ background: "#F0F2F4" }}>
        {SUBS.map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} className="text-xs px-2.5 py-1 rounded-t"
            style={{ background: sub === k ? "#fff" : "#DDE2E7", border: "1px solid #C8CFD6", borderBottom: sub === k ? "1px solid #fff" : "1px solid #C8CFD6", marginBottom: -1, fontWeight: sub === k ? 600 : 400 }}>
            {l}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3 flex gap-3 items-start flex-wrap" style={{ background: "#fff", borderTop: "1px solid #C8CFD6" }}>
        {sub === "drive" && (<>
          <Tbl>
            {r("DC Bus Voltage", f(calc.Vdc, 0), "Volts", 48, true)}
            {r("Phase Supply Voltage (rms)", f(res.VsupplyRms, 2), "Volts", 33.94)}
            {r("Phase Terminal Voltage (rms)", f(res.Vterm, 2), "Volts", 30.92)}
            {r("Back EMF Phase Voltage (peak)", f(res.Epk, 2), "Volts", 42.09)}
            {r("Back EMF Phase Voltage (rms)", f(res.Erms, 2), "Volts", 29.76)}
            {r("Line Current (rms)", f(res.IlineRms, 2), "Amps", 24.8)}
            {r("Line Current (peak)", f(res.IlineRms * Math.SQRT2, 2), "Amps", 35.07)}
            {r("Phase Current (rms)", f(res.IphRms, 2), "Amps", 14.32)}
            {r("Phase Current (peak)", f(res.IphRms * Math.SQRT2, 2), "Amps", 20.25)}
            {r("Phase Advance", f(calc.phaseAdv, 1), "EDeg", 0)}
            {r("Fundamental Frequency", f(res.fe, 1), "Hz", 426.7)}
            {r("Shaft Speed", f(calc.speed, 0), "rpm", 3200)}
          </Tbl>
          <Tbl>
            {r("D Axis Inductance (추정)", f(res.Ld, 4), "mH", 0.1289, true)}
            {r("Q Axis Inductance (추정)", f(res.Lq, 4), "mH", 0.1401)}
            {r("Torque Constant Kt (라인 peak)", f(res.KtLine, 4), "Nm/A", 0.108)}
            {r("Torque Constant Kt (상 rms)", f(res.Kt_phase, 4), "Nm/A")}
            {r("Motor Constant Km", f(res.Km, 4), "Nm/√W", 0.6658)}
            {r("Back EMF Constant Ke", f(res.Ke, 4), "Vs/rad", 0.1256)}
            {r("Electrical Constant Te", f(res.Te, 3), "msec", 2.558)}
            {r("Stall Current", f(res.Istall, 0), "Amps", 1369)}
            {r("Stall Torque", f(res.Tstall, 1), "Nm", 147.8)}
            {r("Power Factor (추정)", f(res.PF, 5), "", 0.98481)}
          </Tbl>
        </>)}
        {sub === "emag" && (<>
          <Tbl>
            {r("Average Torque", f(res.torque, 4), "Nm", 3.7965, true)}
            {r("Shaft Torque (손실 반영)", f(res.Tshaft, 4), "Nm", 3.7136)}
            {r("Electromagnetic Power", f(res.Pem, 1), "Watts", 1268.8)}
            {r("Input Power", f(res.Pin, 1), "Watts", 1307)}
            {r("Total Losses (on load)", f(res.Pcu + res.Pfe + calc.otherLoss, 2), "Watts", 62.57)}
            {r("Output Power", f(res.Pout, 1), "Watts", 1244.4)}
            {r("System Efficiency", f(res.eff, 3), "%", 95.213)}
            {r("No Load Speed", f(res.noLoadSpeed, 0), "rpm", 3649)}
          </Tbl>
          <Tbl>
            {r("Torque per Rotor Volume", f(res.TRV, 3), "kNm/m³", 25.971, true)}
            {r("Rotor Inertia (추정)", res.Jrotor.toExponential(4), "kg.m²", "4.445E-4")}
            {r("Cogging Period", f(res.coggingPeriod, 2), "MDeg", 2.5)}
            {r("Cogging Frequency", f(res.coggingFreq, 0), "Hz", 7680)}
            {r("Magnetic Symmetry (LCM)", f(360 / res.coggingPeriod, 0), "")}
            {r("kw1 (기본파 권선계수)", f(res.kw1, 5), "", 0.94521)}
          </Tbl>
        </>)}
        {sub === "flux" && (
          <Tbl>
            {r("Magnet Br (온도보정, 사용값)", f(res.Br_used, 4), "Tesla", 1.225, true)}
            {r("Carter Coefficient", f(res.kc, 4), "")}
            {r("Airgap Flux Density (peak, OC)", f(res.Bgpk, 3), "Tesla", "1.174 (on load)")}
            {r("Stator Tooth Flux Density (추정)", f(res.Bt, 3), "Tesla", 1.808)}
            {r("Stator Back Iron Flux Density (추정)", f(res.By, 3), "Tesla", 1.414)}
            {r("Back Iron Depth", f(res.byDepth, 2), "mm")}
          </Tbl>
        )}
        {sub === "loss" && (
          <Tbl>
            {r("Armature DC Copper Loss (on load)", f(res.Pcu, 2), "Watts", 32.34, true)}
            {r("Stator Iron Loss [hysteresis]", f(res.PfeHyst, 2), "Watts", 13.04)}
            {r("Stator Iron Loss [eddy]", f(res.PfeEddy, 2), "Watts", 10.87)}
            {r("Stator Iron Loss [total]", f(res.Pfe, 2), "Watts", 23.91)}
            {r("기타 손실 (자석+로터철손+마찰, 입력)", f(calc.otherLoss, 2), "Watts", 6.31)}
            {r("Total Losses (on load)", f(res.Pcu + res.Pfe + calc.otherLoss, 2), "Watts", 62.57)}
          </Tbl>
        )}
        {sub === "wdg" && (<>
          <Tbl>
            {r("Armature Conductor CSA", f(res.condCSA, 3), "mm²", 0.159, true)}
            {r("Armature Turn CSA", f(res.turnCSA, 3), "mm²", 2.704)}
            {r("Conductor Current Density (rms)", f(res.Jrms, 3), "A/mm²", 5.296)}
            {r("Armature Conductor MLT", f(res.MLT, 2), "mm", 92.99)}
            {r("Armature Turns per Phase", f(res.turnsPerPhase, 0), "", 72)}
            {r("Length of Phase", f(res.phaseLen, 0), "mm", 6695)}
            {r("Mean Coil Pitch", f(res.coilPitch, 2), "mm", 10.5)}
            {r("Phase Resistance", f(res.Rphase * 1e3, 2), "mΩ", 52.58)}
            {r("Line-Line Resistance", f(res.RlineLine * 1e3, 2), "mΩ", 35.06)}
          </Tbl>
          <Tbl>
            {r("Conductors / Slot", f(res.condPerSlot, 0), "", 408, true)}
            {r("Slot Area", f(res.slotArea, 1), "mm²", 160.3)}
            {r("Winding Area (+Liner)", f(res.windingAreaLiner, 1), "mm²", 152.2)}
            {r("Winding Area", f(res.windingArea, 1), "mm²", 132.5)}
            {r("Winding Depth", f(res.windingDepth, 2), "mm", 12.882)}
            {r("Covered Wire Area", f(res.coveredWireArea, 2), "mm²", 80.11)}
            {r("Copper Area", f(res.copperArea, 2), "mm²", 64.89)}
            {r("Impreg Area", f(res.impregArea, 2), "mm²", 52.36)}
            {r("Wedge Area", f(res.wedgeArea, 3), "mm²", 1.627)}
            {r("Liner Area", f(res.linerArea, 2), "mm²", 19.73)}
            {r("Coil Divider Area", f(res.dividerArea, 3), "mm²", 6.441)}
            {r("Wire Slot Fill (Wdg Area)", f(res.wireFillWdg, 4), "", 0.6047)}
            {r("Wire Slot Fill (Slot Area)", f(res.wireSlotFill, 4), "", 0.4999)}
            {r("Copper Slot Fill (Slot Area)", f(res.cuSlotFill, 4), "", 0.4049)}
            {r("Heavy Build Slot Fill", f(res.heavyBuildFill, 3), "", 0.77)}
            {r("EWdg MLT", f(res.ewdgMLT, 2), "mm", 32.99)}
            {r("EWdg Fill (추정)", f(res.ewdgFill, 4), "", 0.3794)}
            {r("Volume Copper Active", f(res.volCuActive, 0), "mm³", 35040)}
            {r("Volume Copper EWdg F/R", f(res.volCuEwdg, 0), "mm³", 9633)}
          </Tbl>
        </>)}
        {sub === "matl" && (
          <Tbl>
            {r("Armature Conductor Resistivity (T)", (1.724e-8 * (1 + 0.003862 * (calc.Tcu - 20))).toExponential(3), "Ohm.m", "2.123E-8", true)}
            {r("Number of Laminations", f(res.numLam, 1), "", 139.5)}
            {r("Magnet Br (Used)", f(res.Br_used, 4), "Tesla", 1.225)}
            {r("Weight Stator Lam", f(res.mStator, 4), "kg", 0.498)}
            {r("Weight Rotor Lam", f(res.mRotor, 4), "kg", 0.2116)}
            {r("Weight Magnet", f(res.mMagnet, 4), "kg", 0.1428)}
            {r("Armature Copper [Total] Weight", f(res.mCopper, 4), "kg", 0.4851)}
            {r("Total Weight (Active)", f(res.mActive, 3), "kg", 1.657)}
          </Tbl>
        )}
        <div className="w-full text-xs" style={{ color: "#8893A0" }}>녹색 열 = 1250W-jk Motor-CAD FEA 참조값. (추정) 표기는 해석식 근사 항목.</div>
      </div>
    </div>
  );
}

// ─── Graphs 탭 (해석식 합성 파형 — FEA 아님, 추정치) ─────────────
function Plot({ title, sub, series, h = 190, step = false }) {
  const Wp = 460, P = { l: 46, r: 10, t: 8, b: 20 };
  const xs = series.flatMap((s) => s.x), ys = series.flatMap((s) => s.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const sx = (x) => P.l + ((x - x0) / (x1 - x0)) * (Wp - P.l - P.r);
  const sy = (y) => h - P.b - ((y - y0) / (y1 - y0)) * (h - P.t - P.b);
  return (
    <div className="rounded" style={{ background: "#fff", border: "1px solid #C8CFD6" }}>
      <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #D5DBE1" }}>
        {title} {sub && <span className="font-normal" style={{ color: "#8893A0" }}>{sub}</span>}
      </div>
      <svg width={Wp} height={h} style={{ display: "block" }}>
        {Array.from({ length: 5 }, (_, i) => {
          const yv = y0 + ((y1 - y0) * i) / 4;
          return (
            <g key={"y" + i}>
              <line x1={P.l} x2={Wp - P.r} y1={sy(yv)} y2={sy(yv)} stroke="#EEF1F4" />
              <text x={P.l - 4} y={sy(yv) + 3} fontSize="9" fill="#8893A0" textAnchor="end">{yv.toPrecision(3)}</text>
            </g>
          );
        })}
        {Array.from({ length: 7 }, (_, i) => {
          const xv = x0 + ((x1 - x0) * i) / 6;
          return (
            <g key={"x" + i}>
              <line y1={P.t} y2={h - P.b} x1={sx(xv)} x2={sx(xv)} stroke="#F4F6F8" />
              <text y={h - P.b + 12} x={sx(xv)} fontSize="9" fill="#8893A0" textAnchor="middle">{Math.round(xv)}</text>
            </g>
          );
        })}
        {y0 < 0 && y1 > 0 && <line x1={P.l} x2={Wp - P.r} y1={sy(0)} y2={sy(0)} stroke="#C8CFD6" />}
        {series.map((s, k) => (
          <polyline key={k} fill="none" stroke={s.color} strokeWidth="1.4"
            points={s.y.map((yv, i) => {
              if (!step) return sx(s.x[i]) + "," + sy(yv);
              const nx = i + 1 < s.x.length ? sx(s.x[i + 1]) : Wp - P.r;
              return sx(s.x[i]) + "," + sy(yv) + " " + nx + "," + sy(yv);
            }).join(" ")} />
        ))}
      </svg>
      <div className="flex gap-3 px-2 pb-1 text-xs">
        {series.map((s, k) => s.label && <span key={k} style={{ color: s.color }}>— {s.label}</span>)}
      </div>
    </div>
  );
}

function Bars({ title, sub, values, h = 190 }) {
  const Wp = 460, P = { l: 40, r: 8, t: 10, b: 20 };
  const vmax = Math.max(...values, 1e-9) * 1.08;
  const bw = (Wp - P.l - P.r) / values.length;
  return (
    <div className="rounded" style={{ background: "#fff", border: "1px solid #C8CFD6" }}>
      <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #D5DBE1" }}>
        {title} {sub && <span className="font-normal" style={{ color: "#8893A0" }}>{sub}</span>}
      </div>
      <svg width={Wp} height={h} style={{ display: "block" }}>
        {values.map((v, i) => {
          const bh = (v / vmax) * (h - P.t - P.b);
          return <rect key={i} x={P.l + i * bw + 1} width={Math.max(bw - 2, 1)} y={h - P.b - bh} height={bh} fill="#CC2222" />;
        })}
        {values.map((_, i) => ((i + 1) % 2 === 0 ? (
          <text key={"t" + i} x={P.l + i * bw + bw / 2} y={h - P.b + 12} fontSize="9" fill="#8893A0" textAnchor="middle">{i + 1}</text>
        ) : null))}
        <text x={P.l - 4} y={P.t + 4} fontSize="9" fill="#8893A0" textAnchor="end">{vmax.toPrecision(3)}</text>
        <line x1={P.l} x2={Wp - P.r} y1={h - P.b} y2={h - P.b} stroke="#C8CFD6" />
      </svg>
    </div>
  );
}

function PhasorPlot({ chains }) {
  const Wp = 300, C = Wp / 2;
  const all = chains.flat();
  const rmax = Math.max(...all.map(([x, y]) => Math.hypot(x, y)), 1e-9) * 1.15;
  const s = (v) => (v / rmax) * (C - 14);
  const cols = ["#CC2222", "#1B7A2B", "#2244CC"];
  return (
    <div className="rounded" style={{ background: "#fff", border: "1px solid #C8CFD6" }}>
      <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #D5DBE1" }}>
        Winding Phasors <span className="font-normal" style={{ color: "#8893A0" }}>코일 EMF 페이저 체인</span>
      </div>
      <svg width={Wp} height={Wp} style={{ display: "block" }}>
        <circle cx={C} cy={C} r={C - 14} fill="none" stroke="#D5DBE1" strokeDasharray="3 3" />
        <line x1={14} x2={Wp - 14} y1={C} y2={C} stroke="#EEF1F4" />
        <line y1={14} y2={Wp - 14} x1={C} x2={C} stroke="#EEF1F4" />
        {chains.map((pts, p) => (
          <g key={p}>
            <polyline fill="none" stroke={cols[p]} strokeWidth="1.5"
              points={pts.map(([x, y]) => (C + s(x)) + "," + (C - s(y))).join(" ")} />
            {pts.map(([x, y], i) => (i > 0 ? <circle key={i} cx={C + s(x)} cy={C - s(y)} r="2.5" fill={cols[p]} /> : null))}
          </g>
        ))}
      </svg>
      <div className="flex gap-3 px-2 pb-1 text-xs">
        {["Ph1", "Ph2", "Ph3"].map((l, i) => <span key={i} style={{ color: cols[i] }}>— {l}</span>)}
      </div>
    </div>
  );
}

function GraphsTab({ res, calc, solved }) {
  const data = useMemo(() => {
    if (!res) return null;
    const N = 241;
    const harm = [1, 3, 5, 7, 9, 11, 13];
    const a = res.magnetAlpha, s1 = Math.sin((Math.PI * a) / 2);
    // 공극자속 사다리꼴 분해 → BEMF 고조파: (kw_n/kw_1)·sin(nπα/2)/(n·sin(πα/2))
    const eRel = harm.map((n) => (res.wa.kw(n) / res.kw1) * (Math.sin((n * Math.PI * a) / 2) / (n * s1)));
    const IphPk = res.IphRms * Math.SQRT2;
    const adv = calc.phaseAdv * D2R;
    const wm = (calc.speed * 2 * Math.PI) / 60;
    const deg = Array.from({ length: N }, (_, i) => (i * 360) / (N - 1));
    const sh = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
    const eW = sh.map((p) => deg.map((d) => harm.reduce((s, n, k) => s + res.Epk * eRel[k] * Math.cos(n * (d * D2R - p)), 0)));
    const iW = sh.map((p) => deg.map((d) => IphPk * Math.cos(d * D2R - p + adv)));
    const tq = deg.map((_, i) => (eW[0][i] * iW[0][i] + eW[1][i] * iW[1][i] + eW[2][i] * iW[2][i]) / wm);
    const tAvg = tq.reduce((x, y) => x + y, 0) / N;
    const ripple = tAvg > 0 ? ((Math.max(...tq) - Math.min(...tq)) / tAvg) * 100 : 0;
    // MMF: 슬롯별 도체수 누적합(평균 제거), 전류 ia=1, ib=ic=-0.5
    const Ns = res.wa.table.length;
    const cum = (ph) => {
      let c = 0;
      const arr = res.wa.table.map((r2) => (c += r2[ph]));
      const m = arr.reduce((x, y) => x + y, 0) / Ns;
      return arr.map((v) => v - m);
    };
    const m1 = cum(0), m2 = cum(1), m3 = cum(2);
    const mTot = m1.map((v, k) => v - 0.5 * m2[k] - 0.5 * m3[k]);
    const slotX = Array.from({ length: Ns }, (_, k) => k + 1);
    // MMF 공간고조파: 스텝 파형을 슬롯당 16샘플로 펼쳐 DFT
    const fine = [];
    mTot.forEach((v) => { for (let q = 0; q < 16; q++) fine.push(v); });
    const M = fine.length, mag = [];
    for (let hh = 1; hh <= 24; hh++) {
      let re = 0, im = 0;
      fine.forEach((v, k) => { const t = (2 * Math.PI * hh * k) / M; re += v * Math.cos(t); im -= v * Math.sin(t); });
      mag.push((Math.hypot(re, im) * 2) / M);
    }
    // 코일 EMF 페이저 체인 (상별 tip-to-tail)
    const chains = [0, 1, 2].map((p) => {
      let x = 0, y = 0;
      const pts = [[0, 0]];
      res.wa.coils.filter((c) => c.phase === p).forEach((c) => {
        const g = res.wa.theta[c.go] * D2R, r2 = res.wa.theta[c.ret] * D2R;
        x += c.sign * (Math.cos(g) - Math.cos(r2));
        y += c.sign * (Math.sin(g) - Math.sin(r2));
        pts.push([x, y]);
      });
      return pts;
    });
    // ── Torque–Speed (T-N) 용량곡선: 전류원(I_max) + 전압타원(V_max) 제약 하 최대토크 ──
    const pp = Math.max(1, Math.round(res.Ke / res.lambda));
    const lamF = res.lambda, Rf = res.Rphase;
    const LdF = res.Ld * 1e-3, LqF = res.Lq * 1e-3;          // mH → H
    const Vmax = (res.noLoadSpeed * 2 * Math.PI * res.Ke) / 60; // 가용 상전압(피크) = Vdc 기반
    const Imax = res.IphRms * Math.SQRT2;                       // 동작 상전류(피크) = 전류원 한계
    const nTop = res.noLoadSpeed * 1.15, NTN = 90, Nid = 121;
    const maxTorqueAt = (n) => {
      const wm = (n * 2 * Math.PI) / 60, we = pp * wm;
      let best = 0;
      for (let k = 0; k < Nid; k++) {
        const id = -Imax * (k / (Nid - 1));                   // 0 → -Imax (약계자)
        const iqCur = Math.sqrt(Math.max(Imax * Imax - id * id, 0)); // 전류원 한계
        // 전압타원: (R·id − we·Lq·iq)² + (R·iq + we·(Ld·id+λ))² = Vmax² → iq 2차식
        const a = (we * LqF) ** 2 + Rf * Rf;
        const b = 2 * Rf * we * ((LdF - LqF) * id + lamF);
        const c = (Rf * id) ** 2 + (we * (LdF * id + lamF)) ** 2 - Vmax * Vmax;
        let iqVolt = Infinity;
        if (a > 1e-12) { const disc = b * b - 4 * a * c; iqVolt = disc < 0 ? 0 : Math.max(0, (-b + Math.sqrt(disc)) / (2 * a)); }
        const iq = Math.max(0, Math.min(iqCur, iqVolt));
        const T = 1.5 * pp * (lamF * iq + (LdF - LqF) * id * iq);
        if (T > best) best = T;
      }
      return best;
    };
    const tnSpeed = [], tnTorque = [], tnPower = [];
    for (let i = 0; i < NTN; i++) {
      const n = (nTop * i) / (NTN - 1), T = maxTorqueAt(n);
      tnSpeed.push(n); tnTorque.push(T); tnPower.push((T * n * 2 * Math.PI) / 60);
    }
    const T0 = tnTorque[0];
    let baseSpeed = nTop;
    for (let i = 1; i < NTN; i++) { if (tnTorque[i] < 0.98 * T0) { baseSpeed = tnSpeed[i]; break; } }
    const tnPmax = Math.max(...tnPower);
    return { deg, eW, iW, tq, tAvg, ripple, slotX, m1, mTot, mag, chains,
      tnSpeed, tnTorque, tnPower, baseSpeed, tnPmax, opSpeed: calc.speed, opTorque: res.torque };
  }, [res, calc]);
  if (!solved) return <div className="p-6 text-sm" style={{ color: "#5C6B7A" }}>Calculation 탭에서 <b>Solve E-Magnetic Model</b>을 눌러 해석을 실행하면 파형이 표시됩니다.</div>;
  if (!data) return <div className="p-4 text-sm">계산 불가 — 입력값 확인</div>;
  return (
    <div className="h-full overflow-auto p-3 flex flex-wrap gap-3" style={{ alignContent: "flex-start" }}>
      <Plot title="Torque" sub={"해석식 추정 · 평균 " + data.tAvg.toFixed(3) + " Nm · 리플 " + data.ripple.toFixed(2) + "% (FEA 2.09%)"}
        series={[{ x: data.deg, y: data.tq, color: "#2244CC", label: "Torque [Nm] vs EDeg" }]} />
      <Plot title="Back EMF Phase Voltage" sub="고조파 합성 1·3·5·7·9·11·13차 [V]"
        series={[
          { x: data.deg, y: data.eW[0], color: "#CC2222", label: "Ph1" },
          { x: data.deg, y: data.eW[1], color: "#1B7A2B", label: "Ph2" },
          { x: data.deg, y: data.eW[2], color: "#2244CC", label: "Ph3" },
        ]} />
      <Plot title="Phase Currents" sub="정현 구동 [A]"
        series={[
          { x: data.deg, y: data.iW[0], color: "#CC2222", label: "Ph1" },
          { x: data.deg, y: data.iW[1], color: "#1B7A2B", label: "Ph2" },
          { x: data.deg, y: data.iW[2], color: "#2244CC", label: "Ph3" },
        ]} />
      <Plot title="Winding MMF" sub="슬롯 스텝 · ia=1, ib=ic=−0.5 [At]" step
        series={[
          { x: data.slotX, y: data.mTot, color: "#1A222C", label: "Sum" },
          { x: data.slotX, y: data.m1, color: "#CC2222", label: "Ph1" },
        ]} />
      <Bars title="MMF Harmonics" sub="공간(기계) 고조파 [At] — 극쌍수에서 피크" values={data.mag} />
      <PhasorPlot chains={data.chains} />
      <Plot title="Torque–Speed Curve" sub={"기저속도 ~" + Math.round(data.baseSpeed) + " rpm · 전류원 한계 = 동작 전류"}
        series={[
          { x: data.tnSpeed, y: data.tnTorque, color: "#2244CC", label: "Max Torque [Nm]" },
          { x: [data.opSpeed, data.opSpeed], y: [0, data.opTorque], color: "#D98E04", label: "정격점" },
        ]} />
      <Plot title="Power–Speed Curve" sub={"최대 출력 " + Math.round(data.tnPmax) + " W · 전압한계 = 무부하속도 " + Math.round(res.noLoadSpeed) + " rpm"}
        series={[
          { x: data.tnSpeed, y: data.tnPower, color: "#1B7A2B", label: "Output Power [W]" },
          { x: [data.opSpeed, data.opSpeed], y: [0, data.opTorque * data.opSpeed * 2 * Math.PI / 60], color: "#D98E04", label: "정격점" },
        ]} />
      <div className="w-full text-xs" style={{ color: "#8893A0" }}>
        모든 파형은 해석식 합성 추정치 — 슬롯팅·포화·코깅 미반영. 정밀 파형은 Motor-CAD/Maxwell FEA로 검증.
      </div>
    </div>
  );
}

// ─── 권선 배치도 (Motor-CAD Winding Pattern 대응, SVG) ───────────
function WindingLayout({ geo, res }) {
  const [ph, setPh] = useState(-1); // -1 = 전체
  const wa = res.wa;
  const Ns = geo.slotNumber, poles = geo.poleNumber;
  const Rb = geo.statorBore / 2, RoL = geo.statorLamDia / 2;
  const Rro = Rb - geo.airgap, Rsh = geo.shaftDia / 2;
  const size = 540, C = size / 2, margin = 14;
  const worldR = RoL * 1.45;
  const sc = (C - margin) / worldR;
  const cols = ["#CC2222", "#1B7A2B", "#2244CC"];
  const ang = (k) => (k * 2 * Math.PI) / Ns;          // 슬롯 k 중심각
  const SC = ([x, y]) => [C + x * sc, C - y * sc];    // mm → 화면
  const PR = (R, a) => [C + R * sc * Math.cos(a), C - R * sc * Math.sin(a)];
  const pathD = (pts) => pts.map(([x, y], i) => (i ? "L" : "M") + SC([x, y]).map((v) => v.toFixed(1)).join(",")).join(" ") + "Z";

  // 슬롯/자석 형상
  const slotPaths = Array.from({ length: Ns }, (_, k) => pathD(rotPts(buildSlotPath(geo), geo.statorRot * D2R + ang(k))));
  const magPaths = poles > 0 ? Array.from({ length: poles }, (_, k) => pathD(rotPts(buildMagnetPath(geo), geo.rotorRot * D2R + (k * 2 * Math.PI) / poles))) : [];

  // 코일별 마커 + 엔드턴 아크
  const Rgo = Rb + geo.slotDepth * 0.66, Rret = Rb + geo.slotDepth * 0.34;
  const coils = wa.coils.filter((c) => ph < 0 || c.phase === ph);
  const marker = (R, a, into, color, key) => {
    const [x, y] = PR(R, a);
    return into
      ? <g key={key}><circle cx={x} cy={y} r="6.5" fill="#fff" stroke={color} strokeWidth="1.4" />
          <line x1={x - 3.2} y1={y - 3.2} x2={x + 3.2} y2={y + 3.2} stroke={color} strokeWidth="1.4" />
          <line x1={x - 3.2} y1={y + 3.2} x2={x + 3.2} y2={y - 3.2} stroke={color} strokeWidth="1.4" /></g>
      : <g key={key}><circle cx={x} cy={y} r="6.5" fill="#fff" stroke={color} strokeWidth="1.4" />
          <circle cx={x} cy={y} r="2.2" fill={color} /></g>;
  };
  const arcs = [], marks = [];
  coils.forEach((c, idx) => {
    const col = cols[c.phase];
    const ag = ang(c.go), ar = ang(c.ret);
    // 엔드턴: 라미 바깥으로 볼록한 베지어
    const [gx, gy] = PR(RoL * 1.04, ag), [rx, ry] = PR(RoL * 1.04, ar);
    let am = (ag + ar) / 2;
    if (Math.abs(ar - ag) > Math.PI) am += Math.PI;   // 0/2π 경계 보정
    const [cx, cy] = PR(RoL * 1.22, am);
    arcs.push(<path key={"a" + idx} d={`M${gx.toFixed(1)},${gy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${rx.toFixed(1)},${ry.toFixed(1)}`}
      fill="none" stroke={col} strokeWidth="1.3" opacity="0.85" />);
    marks.push(marker(Rgo, ag, c.sign > 0, col, "g" + idx));
    marks.push(marker(Rret, ar, c.sign < 0, col, "r" + idx));
  });

  // 상별 IN/OUT 단자 표기 (직렬 연결선은 제거 — 원래 배치도로 원복)
  const terms = [];
  (ph < 0 ? [0, 1, 2] : [ph]).forEach((p) => {
    const pc = wa.coils.filter((c) => c.phase === p).slice().sort((a, b) => a.go - b.go);
    const col = cols[p];
    if (pc.length) {
      const lbl = ["U", "V", "W"][p];
      [[pc[0].go, "1", "In"], [pc[pc.length - 1].ret, "2", "Out"]].forEach(([slot, suf, io], j) => {
        const a = ang(slot);
        const [sx, sy] = PR(RoL * 1.04, a), [ex, ey] = PR(RoL * 1.40, a);
        terms.push(<g key={`t${p}_${j}`}>
          <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={col} strokeWidth="2.4" />
          <circle cx={ex} cy={ey} r="4" fill={col} />
          <text x={ex} y={ey - 7} fontSize="11" fontWeight="bold" fill={col} textAnchor="middle">{lbl + suf}</text>
          <text x={ex} y={ey + 13} fontSize="9" fill={col} textAnchor="middle">{io}</text>
        </g>);
      });
    }
  });

  const Btn = ({ v, label }) => (
    <button onClick={() => setPh(v)} className="text-xs px-2.5 py-1 rounded"
      style={{ border: "1px solid #C8CFD6", background: ph === v ? (v < 0 ? "#1A222C" : cols[v]) : "#fff", color: ph === v ? "#fff" : "#2A3540", fontWeight: ph === v ? 600 : 400 }}>
      {label}
    </button>
  );
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center gap-1.5 px-3 py-1.5" style={{ borderBottom: "1px solid #D5DBE1" }}>
        <span className="text-xs font-semibold mr-1" style={{ color: "#2A3540" }}>상 표시:</span>
        <Btn v={-1} label="전체" /><Btn v={0} label="Ph1" /><Btn v={1} label="Ph2" /><Btn v={2} label="Ph3" />
        <div className="flex-1" />
        <span className="text-xs" style={{ color: "#8893A0" }}>× 들어감 · • 나옴 · 실선=엔드턴 · U1/V1/W1=In(상 시작) · U2/V2/W2=Out(상 끝)</span>
      </div>
      <div className="flex-1 flex items-center justify-center min-h-0 overflow-auto" style={{ background: "#fff" }}>
        <svg width={size} height={size}>
          <circle cx={C} cy={C} r={RoL * sc} fill="#FBE9E9" stroke="#B02020" strokeWidth="1.2" />
          <circle cx={C} cy={C} r={Rb * sc} fill="#fff" stroke="#B02020" strokeWidth="0.8" />
          {slotPaths.map((d, i) => <path key={"s" + i} d={d} fill="#FAF3C8" stroke="#998800" strokeWidth="0.5" />)}
          <circle cx={C} cy={C} r={Rro * sc} fill="#CFF3F3" stroke="#0E8C8C" strokeWidth="0.8" />
          {magPaths.map((d, i) => <path key={"m" + i} d={d} fill="#CDE8CD" stroke="#1E7A1E" strokeWidth="0.4" />)}
          <circle cx={C} cy={C} r={Rsh * sc} fill="#fff" stroke="#0E8C8C" strokeWidth="0.8" />
          {arcs}
          {marks}
          {terms}
          {Array.from({ length: Ns }, (_, k) => {
            const [lx, ly] = PR(RoL * 1.14, ang(k));
            return <text key={"n" + k} x={lx} y={ly + 3} fontSize="10" fill="#5C6B7A" textAnchor="middle">{k + 1}</text>;
          })}
        </svg>
      </div>
      <div className="flex items-center gap-4 px-3 py-1 text-xs" style={{ background: "#1A222C", color: "#C8CFD6", fontFamily: "Consolas,monospace" }}>
        <span>{Ns}슬롯 / {poles}극 · 3상 2층 Lap · Throw {wa.coils.length ? Math.abs(wa.coils[0].ret - wa.coils[0].go) || 1 : 1}</span>
        <div className="flex-1" />
        <span>코일 {wa.coils.length}개 (상당 {wa.coilsPerPhase}) · kw1 {res.kw1.toFixed(4)}</span>
      </div>
    </div>
  );
}
