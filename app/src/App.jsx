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
  return { coils, table, kw, coilsPerPhase };
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
  out.lambda = lam;
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
  const slotA = shoelace(buildSlotPath(G));
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
  wedgeDepth: 1.0, condSep: 0.02,
};
const MAT0 = { steel: "20PNX1200F", magnet: "N45UH", Br20: 1.32, tcBr: -0.12, mur: 1.05, kh: 0.0226, ke: 4.43e-5 };
const CALC0 = { speed: 3200, Vdc: 48, IlineRms: 24.8, phaseAdv: 0, Tcu: 80, Tmag: 80, klk: 0.97, cT: 0.56, cL: 2.6, cLs: 0.33, otherLoss: 6.7, currentDef: "rms", magnetisation: "parallel", driveMode: "sine" };

// 1250W-jk Motor-CAD 참조값 (비교 표시용)
const REF = {
  kw1: 0.94521, turnsPerPhase: 72, condPerSlot: 408, slotArea: 160.3, cuSlotFill: 0.4049,
  wireSlotFill: 0.4999, coilPitch: 10.5, MLT: 92.99, Rphase: 0.05258, Pcu: 32.34, Jrms: 5.296,
  lambda: 0.0157, Epk: 42.09, Ke: 0.1256, torque: 3.7965, Bt: 1.808, By: 1.414, Bgpk: 1.174,
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

  const res = useMemo(() => {
    try { return compute(geo, wind, mat, calc); } catch (e) { return null; }
  }, [geo, wind, mat, calc]);

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
    ["calculation", "Calculation"], ["output", "Output Data"],
  ];

  return (
    <div className="h-screen flex flex-col" style={{ background: "#F0F2F4", fontFamily: "'Segoe UI','Noto Sans KR',sans-serif", color: "#1A222C" }}>
      {/* 헤더 + 탭 */}
      <div style={{ background: "#FFFFFF", borderBottom: "2px solid #1A222C" }}>
        <div className="flex items-center gap-3 px-3 pt-2">
          <span className="font-bold text-sm tracking-tight">Mini Motor-CAD</span>
          <span className="text-xs" style={{ color: "#8893A0" }}>PMSM 기초설계 · 해석엔진 1250W-jk 검증</span>
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
        {tab === "calculation" && <CalculationTab calc={calc} sC={sC} wind={wind} sW={sW} res={res} />}
        {tab === "output" && <OutputTab res={res} calc={calc} showRef={showRef} />}
      </div>
    </div>
  );
}

// ─── Geometry 탭 (DXF 매칭) ──────────────────────────────────────
function GeometryTab({ geo, sG, res }) {
  const [dxf, setDxf] = useState(null);
  const [dxfName, setDxfName] = useState("");
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
  const loadFile = async (file) => {
    const text = await file.text();
    try {
      const shapes = parseDxf(text);
      if (!shapes.length) throw new Error("no entities");
      setDxf(shapes); setDxfName(file.name);
    } catch (err) { alert("DXF 파싱 실패: " + err.message); }
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
  const xMin = x1 + geo.toothTipDepth + wind.wedgeDepth + liner;
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
  const rowH = pitch * Math.sqrt(3) / 2;
  const targetSide = wind.turnsPerCoil * wind.strands;
  const left = [], right = [];
  let row = 0;
  for (let x = RdL - r; x >= xMin + r - 1e-9; x -= rowH, row++) {
    const off = (row % 2) * pitch / 2;
    const yMax = RdL; // 충분히 넓게 스캔
    const rowR = [], rowL = [];
    for (let y = divHalf + r + sep / 2 + off; y <= yMax; y += pitch) {
      if (ok(x, y)) rowR.push([x, y]);
      if (ok(x, -y)) rowL.push([x, -y]);
    }
    // 벽 쪽부터 채우기 (|y| 큰 순)
    rowR.sort((a, b) => b[1] - a[1]);
    rowL.sort((a, b) => a[1] - b[1]);
    right.push(...rowR); left.push(...rowL);
  }
  return {
    left: left.slice(0, targetSide), right: right.slice(0, targetSide),
    capacity: Math.min(left.length, right.length), targetSide,
    geo: { x1, Rd, RdL, xMin, dlt, wallLim, divHalf },
  };
}

function SlotViewer({ geo, wind }) {
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
    // 4) 웨지(회색): 팁 영역
    const halfOp = P.slotOpening / 2;
    const xw0 = g2.x1 + P.toothTipDepth, xw1 = xw0 + wind.wedgeDepth;
    ctx.fillStyle = "#AEBDC8";
    poly([[xw0, halfOp + 0.35], [xw1, halfOp + 0.9], [xw1, -halfOp - 0.9], [xw0, -halfOp - 0.35]]);
    ctx.fill();
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
        <div className="flex-1" />
        <span>라이너 {wind.linerThk} · 웨지 {wind.wedgeDepth} · 디바이더 {wind.coilDivider} · 간격 {wind.condSep}</span>
      </div>
    </div>
  );
}

function WindingTab({ geo, wind, sW, res, showRef }) {
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
        <NumIn label="Wire Diameter" value={wind.wireDia} step={0.01} onChange={(v) => sW("wireDia", v)} />
        <NumIn label="Copper Diameter" value={wind.copperDia} step={0.01} onChange={(v) => sW("copperDia", v)} />
        <NumIn label="Strands in Hand" value={wind.strands} step={1} onChange={(v) => sW("strands", v)} />
        <SectionHead color="#1E7A1E">Insulation / 슬롯 내부</SectionHead>
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
        </tbody></table>
      </div>
      {/* 중앙: 슬롯 단면 뷰어 */}
      <SlotViewer geo={geo} wind={wind} />
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
              {wa.table.map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid #EEF1F4" }}>
                  <td className="px-1 text-center">{i + 1}</td>
                  <td className="px-1 text-center">{Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2])}</td>
                  {r.map((v, j) => <td key={j} className="px-1 text-right">{v !== 0 ? v : ""}</td>)}
                </tr>
              ))}
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
function CalculationTab({ calc, sC, wind, sW, res }) {
  const [solved, setSolved] = useState(false);
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
            <NumIn label="Peak Current [A]" value={+(IlinePk.toFixed(2))} step={0.1} onChange={(v) => sC("IlineRms", v / Math.SQRT2)} />
          ) : (
            <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F6F8FA" }}>
              <span className="text-xs" style={{ color: "#8893A0" }}>Peak Current [A]</span>
              <span className="text-xs" style={{ fontFamily: "Consolas,monospace" }}>{IlinePk.toFixed(2)}</span>
            </div>
          )}
          {calc.currentDef === "rms" ? (
            <NumIn label="RMS Current [A]" value={calc.IlineRms} step={0.1} onChange={(v) => sC("IlineRms", v)} />
          ) : (
            <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F6F8FA" }}>
              <span className="text-xs" style={{ color: "#8893A0" }}>RMS Current [A]</span>
              <span className="text-xs" style={{ fontFamily: "Consolas,monospace" }}>{calc.IlineRms.toFixed(2)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F6F8FA" }}>
            <span className="text-xs" style={{ color: "#8893A0" }}>RMS Current Density</span>
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
          {res && (
            <table className="w-full"><tbody>
              <Row label="Average Torque" value={res.torque.toFixed(4)} unit="Nm" hl />
              <Row label="Output Power" value={res.Pout.toFixed(1)} unit="W" />
              <Row label="System Efficiency" value={res.eff.toFixed(2)} unit="%" />
              <Row label="Line Current (rms)" value={res.IlineRms.toFixed(2)} unit="A" />
              <Row label="Phase Current (rms)" value={res.IphRms.toFixed(2)} unit="A" />
              <Row label="Fundamental Freq" value={res.fe.toFixed(1)} unit="Hz" />
            </tbody></table>
          )}
        </Box>
        <button
          onClick={() => { setSolved(true); setTimeout(() => setSolved(false), 1200); }}
          className="w-full py-3 rounded font-semibold text-sm"
          style={{ border: "1px solid #1A222C", background: solved ? "#1B7A2B" : "#fff", color: solved ? "#fff" : "#1A222C" }}>
          {solved ? "✓ 계산 완료 (실시간)" : "Solve E-Magnetic Model"}
        </button>
        <div className="text-xs mt-1.5" style={{ color: "#8893A0" }}>해석식 엔진은 입력 변경 시 항상 즉시 재계산됩니다.</div>
      </div>
    </div>
  );
}

// ─── Output Data 탭 (Motor-CAD 하위탭 구조) ─────────────────────
function OutputTab({ res, calc, showRef }) {
  const [sub, setSub] = useState("drive");
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
            {r("Wire Slot Fill (Slot Area)", f(res.wireSlotFill, 4), "", 0.4999)}
            {r("Copper Slot Fill (Slot Area)", f(res.cuSlotFill, 4), "", 0.4049)}
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
