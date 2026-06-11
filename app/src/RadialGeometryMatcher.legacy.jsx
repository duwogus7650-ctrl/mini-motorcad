import { useState, useEffect, useRef, useCallback } from "react";

// ════════════════════════════════════════════════════════════════
//  Radial Geometry Matcher — Motor-CAD 스타일 DXF 형상 매칭 도구
//  DXF 단면을 깔고, 파라미터를 조절해 템플릿 형상을 맞춰가는 도구
// ════════════════════════════════════════════════════════════════

const D2R = Math.PI / 180;

// ─── DXF 파서 (ASCII: POLYLINE/LWPOLYLINE/LINE/CIRCLE/ARC) ───────
function parseDxf(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1]]);
  }
  const shapes = [];
  let i = 0;
  // ENTITIES 섹션 찾기
  while (i < pairs.length) {
    if (pairs[i][0] === 2 && pairs[i][1].trim() === "ENTITIES") break;
    i++;
  }
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
        else if (c === 40) r = num(v);
        else if (c === 50) a1 = num(v); else if (c === 51) a2 = num(v);
        i++;
      }
      shapes.push(isArc ? { type: "arc", cx, cy, r, a1: a1 * D2R, a2: a2 * D2R }
                        : { type: "circle", cx, cy, r });
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
      // VERTEX 들 ~ SEQEND
      while (i < pairs.length) {
        const v0 = (pairs[i][1] || "").trim();
        if (pairs[i][0] === 0 && v0 === "VERTEX") {
          const vt = { x: 0, y: 0, b: 0 }; i++;
          while (i < pairs.length && pairs[i][0] !== 0) {
            const [c, v] = pairs[i];
            if (c === 10) vt.x = num(v); else if (c === 20) vt.y = num(v);
            else if (c === 42) vt.b = num(v);
            i++;
          }
          verts.push(vt);
        } else if (pairs[i][0] === 0 && v0 === "SEQEND") {
          i++;
          while (i < pairs.length && pairs[i][0] !== 0) i++;
          break;
        } else break;
      }
      shapes.push(polyFromVerts(verts, closed));
    } else { i++; }
  }
  return shapes.filter(Boolean);
}

// bulge 원호를 점열로 테셀레이션
function polyFromVerts(verts, closed) {
  if (!verts.length) return null;
  const pts = [];
  const n = verts.length;
  const segs = closed ? n : n - 1;
  pts.push([verts[0].x, verts[0].y]);
  for (let k = 0; k < segs; k++) {
    const p1 = verts[k], p2 = verts[(k + 1) % n];
    const b = p1.b || 0;
    if (Math.abs(b) < 1e-9) { pts.push([p2.x, p2.y]); continue; }
    const theta = 4 * Math.atan(b);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const chord = Math.hypot(dx, dy);
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

// ─── 파라메트릭 형상 생성 (Parallel Tooth + Surface Parallel) ────
function buildSlotPath(P) {
  // 슬롯 1개 로컬 좌표 (중심선 = +x축), 이후 회전 복제
  const Rb = P.statorBore / 2;
  const Rd = Rb + P.slotDepth;
  const halfOp = P.slotOpening / 2;
  const tta = P.toothTipAngle * D2R;
  const dlt = Math.PI / P.slotNumber; // 반 피치
  const x1 = Math.sqrt(Math.max(Rb * Rb - halfOp * halfOp, 0));
  const A1 = [x1, halfOp];
  const A2 = [x1 + P.toothTipDepth, halfOp];
  // 치 측벽: t·u + n  (u: 치 중심선 방향, n: 슬롯 쪽 오프셋 tw/2)
  const u = [Math.cos(dlt), Math.sin(dlt)];
  const nv = [Math.sin(dlt) * P.toothWidth / 2, -Math.cos(dlt) * P.toothWidth / 2];
  // 팁 사면: A2에서 방향 d=(sin tta, cos tta) → 측벽과 교차
  const d = [Math.sin(tta), Math.cos(tta)];
  // A2 + s·d = t·u + n  →  s·d - t·u = n - A2
  const bx = nv[0] - A2[0], by = nv[1] - A2[1];
  const det = d[0] * (-u[1]) - d[1] * (-u[0]);
  let A3;
  if (Math.abs(det) < 1e-12) A3 = A2;
  else {
    const s = (bx * (-u[1]) - by * (-u[0])) / det;
    A3 = [A2[0] + s * d[0], A2[1] + s * d[1]];
  }
  // 측벽과 슬롯 바닥원 교점 (u ⊥ n 이므로 단순)
  const tEnd = Math.sqrt(Math.max(Rd * Rd - (P.toothWidth / 2) ** 2, 0));
  const A4 = [tEnd * u[0] + nv[0], tEnd * u[1] + nv[1]];
  const a4 = Math.atan2(A4[1], A4[0]);
  // 폴리곤 (상반부 → 바닥 원호 → 하반부 미러)
  const pts = [A1, A2, A3, A4];
  const steps = 16;
  for (let s = 1; s <= steps; s++) {
    const t = a4 - 2 * a4 * (s / steps);
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
  // breadloaf: 외면 원호 중심을 +x로 c 오프셋, 반경 Ro-c, 가장자리 반경감소 = reduction
  let c = 0;
  if (P.magnetReduction > 1e-6) {
    let lo = 0, hi = Ro - 0.01;
    for (let k = 0; k < 60; k++) {
      c = (lo + hi) / 2;
      const Ra = Ro - c;
      const inner = Ra * Ra - W2 * W2;
      const xe = inner > 0 ? c + Math.sqrt(inner) : c;
      const red = Ro - Math.hypot(xe, W2);
      if (red < P.magnetReduction) lo = c; else hi = c;
    }
  }
  const Ra = Ro - c;
  const xSideIn = Ri * Math.cos(halfA);
  const innerSide = Ra * Ra - W2 * W2;
  const xSideOut = innerSide > 0 ? c + Math.sqrt(innerSide) : c;
  const aOut = Math.atan2(W2, xSideOut - c);
  const pts = [];
  const steps = 20;
  // 내면 원호 (-halfA → +halfA)
  for (let s = 0; s <= steps; s++) {
    const t = -halfA + 2 * halfA * (s / steps);
    pts.push([Ri * Math.cos(t), Ri * Math.sin(t)]);
  }
  // 측벽 위 → 외면 원호 (+aOut → -aOut) → 측벽 아래
  pts.push([xSideOut, W2]);
  for (let s = 0; s <= steps; s++) {
    const t = aOut - 2 * aOut * (s / steps);
    pts.push([c + Ra * Math.cos(t), Ra * Math.sin(t)]);
  }
  pts.push([xSideIn, -W2]);
  return pts;
}

function rotPts(pts, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

// ─── 기본 파라미터 (1250W-jk 기준) ───────────────────────────────
const DEFAULTS = {
  slotNumber: 18, statorLamDia: 114, statorBore: 79.66, toothWidth: 4.6,
  slotDepth: 14.2, toothTipDepth: 0.5, slotOpening: 0.56, toothTipAngle: 4,
  poleNumber: 16, magnetThickness: 3.6, magnetReduction: 1.3, magnetArcED: 145,
  airgap: 0.5, bandingThickness: 0, shaftDia: 62, statorRot: 0, rotorRot: 0,
};
const STATOR_FIELDS = [
  ["slotNumber", "Slot Number", 1],
  ["statorLamDia", "Stator Lam Dia", 0.01],
  ["statorBore", "Stator Bore", 0.01],
  ["toothWidth", "Tooth Width", 0.01],
  ["slotDepth", "Slot Depth", 0.01],
  ["toothTipDepth", "Tooth Tip Depth", 0.01],
  ["slotOpening", "Slot Opening", 0.01],
  ["toothTipAngle", "Tooth Tip Angle", 0.1],
  ["statorRot", "Stator Rotation [°]", 0.5],
];
const ROTOR_FIELDS = [
  ["poleNumber", "Pole Number", 1],
  ["magnetThickness", "Magnet Thickness", 0.01],
  ["magnetReduction", "Magnet Reduction", 0.01],
  ["magnetArcED", "Magnet Arc [ED]", 0.5],
  ["airgap", "Airgap", 0.01],
  ["bandingThickness", "Banding Thickness", 0.01],
  ["shaftDia", "Shaft Dia", 0.01],
  ["rotorRot", "Rotor Rotation [°]", 0.5],
];

// ════════════════════════════════════════════════════════════════
export default function RadialGeometryMatcher() {
  const [params, setParams] = useState(DEFAULTS);
  const [dxf, setDxf] = useState(null);
  const [dxfName, setDxfName] = useState("");
  const [dxfT, setDxfT] = useState({ scale: 1, dx: 0, dy: 0, rot: 0 });
  const [layers, setLayers] = useState({ dxf: true, stator: true, slots: true, rotor: true, magnets: true });
  const [opacity, setOpacity] = useState(0.45);
  const [measure, setMeasure] = useState(false);
  const [mPts, setMPts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const viewRef = useRef({ scale: 6, ox: 0, oy: 0, init: false });
  const dragRef = useRef(null);
  const fileRef = useRef(null);

  const setP = (k, v) => setParams((p) => ({ ...p, [k]: v }));
  const rotorDia = params.statorBore - 2 * params.airgap;

  // ─── 좌표 변환 ───
  const w2s = (x, y, V) => [V.ox + x * V.scale, V.oy - y * V.scale];
  const s2w = (sx, sy, V) => [(sx - V.ox) / V.scale, (V.oy - sy) / V.scale];

  // ─── 그리기 ───
  const draw = useCallback(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const V = viewRef.current;
    if (!V.init) { V.ox = W / 2; V.oy = H / 2; V.scale = Math.min(W, H) / 130; V.init = true; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);

    // 그리드 (10mm) + 축
    ctx.strokeStyle = "#EEF1F4"; ctx.lineWidth = 1;
    const wx0 = s2w(0, 0, V)[0], wx1 = s2w(W, 0, V)[0];
    const wy1 = s2w(0, 0, V)[1], wy0 = s2w(0, H, V)[1];
    for (let gx = Math.ceil(wx0 / 10) * 10; gx <= wx1; gx += 10) {
      const [sx] = w2s(gx, 0, V);
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (let gy = Math.ceil(wy0 / 10) * 10; gy <= wy1; gy += 10) {
      const [, sy] = w2s(0, gy, V);
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
    }
    ctx.strokeStyle = "#D5DBE1";
    const [ox0, oy0] = w2s(0, 0, V);
    ctx.beginPath(); ctx.moveTo(ox0, 0); ctx.lineTo(ox0, H); ctx.moveTo(0, oy0); ctx.lineTo(W, oy0); ctx.stroke();

    const poly = (pts, close) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = w2s(x, y, V);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      });
      if (close) ctx.closePath();
    };
    const circle = (cx, cy, r) => {
      const [sx, sy] = w2s(cx, cy, V);
      ctx.beginPath(); ctx.arc(sx, sy, r * V.scale, 0, Math.PI * 2);
    };
    const annulus = (rO, rI) => {
      const [sx, sy] = w2s(0, 0, V);
      ctx.beginPath();
      ctx.arc(sx, sy, rO * V.scale, 0, Math.PI * 2);
      ctx.arc(sx, sy, rI * V.scale, 0, Math.PI * 2, true);
    };

    // ── 템플릿 형상 ──
    ctx.globalAlpha = opacity;
    const P = params;
    const Ro = rotorDia / 2 - P.bandingThickness;
    const Ri = Ro - P.magnetThickness;
    if (layers.rotor) {
      ctx.fillStyle = "#33CCCC";
      annulus(Ri, P.shaftDia / 2); ctx.fill("evenodd");
    }
    if (layers.magnets && P.poleNumber > 0) {
      const mp = buildMagnetPath(P);
      ctx.fillStyle = "#22BB22";
      for (let k = 0; k < P.poleNumber; k++) {
        poly(rotPts(mp, P.rotorRot * D2R + (k * 2 * Math.PI) / P.poleNumber), true);
        ctx.fill();
      }
    }
    if (layers.stator) {
      ctx.fillStyle = "#E03030";
      annulus(P.statorLamDia / 2, P.statorBore / 2); ctx.fill("evenodd");
    }
    if (layers.slots && P.slotNumber > 0) {
      const sp = buildSlotPath(P);
      ctx.fillStyle = "#F5E020";
      ctx.strokeStyle = "#998800"; ctx.lineWidth = 1;
      for (let k = 0; k < P.slotNumber; k++) {
        poly(rotPts(sp, P.statorRot * D2R + (k * 2 * Math.PI) / P.slotNumber), true);
        ctx.fill(); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // 템플릿 외곽선
    ctx.strokeStyle = "#B02020"; ctx.lineWidth = 1.2;
    if (layers.stator) { circle(0, 0, P.statorLamDia / 2); ctx.stroke(); circle(0, 0, P.statorBore / 2); ctx.stroke(); }
    if (layers.rotor) {
      ctx.strokeStyle = "#0E8C8C";
      circle(0, 0, Ro); ctx.stroke(); circle(0, 0, Ri); ctx.stroke(); circle(0, 0, P.shaftDia / 2); ctx.stroke();
    }

    // ── DXF ──
    if (dxf && layers.dxf) {
      ctx.save();
      const [tx, ty] = w2s(dxfT.dx, dxfT.dy, V);
      ctx.translate(tx, ty);
      ctx.scale(V.scale * dxfT.scale, -V.scale * dxfT.scale);
      ctx.rotate(dxfT.rot * D2R);
      ctx.strokeStyle = "#1B7A2B";
      ctx.lineWidth = 1 / (V.scale * dxfT.scale);
      for (const s of dxf) {
        ctx.beginPath();
        if (s.type === "poly") {
          s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          if (s.closed) ctx.closePath();
        } else if (s.type === "circle") {
          ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
        } else if (s.type === "arc") {
          ctx.arc(s.cx, s.cy, s.r, s.a1, s.a2, false);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── 측정 ──
    if (mPts.length) {
      ctx.fillStyle = "#C2410C"; ctx.strokeStyle = "#C2410C"; ctx.lineWidth = 1.5;
      mPts.forEach(([x, y]) => {
        const [sx, sy] = w2s(x, y, V);
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
      });
      if (mPts.length === 2) {
        const [p1, p2] = mPts;
        const [s1x, s1y] = w2s(p1[0], p1[1], V);
        const [s2x, s2y] = w2s(p2[0], p2[1], V);
        ctx.beginPath(); ctx.moveTo(s1x, s1y); ctx.lineTo(s2x, s2y); ctx.stroke();
      }
    }
  }, [params, dxf, dxfT, layers, opacity, mPts, rotorDia]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [draw]);

  // ─── 마우스 ───
  const onWheel = (e) => {
    e.preventDefault();
    const V = viewRef.current;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    V.ox = mx - (mx - V.ox) * f;
    V.oy = my - (my - V.oy) * f;
    V.scale *= f;
    draw();
  };
  const onDown = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (measure) {
      const wp = s2w(sx, sy, viewRef.current);
      setMPts((p) => (p.length >= 2 ? [wp] : [...p, wp]));
      return;
    }
    dragRef.current = { sx, sy };
  };
  const onMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    setCursor(s2w(sx, sy, viewRef.current));
    if (dragRef.current) {
      const V = viewRef.current;
      V.ox += sx - dragRef.current.sx;
      V.oy += sy - dragRef.current.sy;
      dragRef.current = { sx, sy };
      draw();
    }
  };
  const onUp = () => (dragRef.current = null);
  const fitView = () => {
    const wrap = wrapRef.current; if (!wrap) return;
    const V = viewRef.current;
    V.ox = wrap.clientWidth / 2; V.oy = wrap.clientHeight / 2;
    V.scale = Math.min(wrap.clientWidth, wrap.clientHeight) / (params.statorLamDia * 1.15);
    draw();
  };

  // ─── 파일 ───
  const loadFile = async (file) => {
    const text = await file.text();
    try {
      const shapes = parseDxf(text);
      if (!shapes.length) throw new Error("no entities");
      setDxf(shapes); setDxfName(file.name);
    } catch (err) {
      alert("DXF 파싱 실패: " + err.message);
    }
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ ...params, rotorDiaCalc: rotorDia }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "geometry_params.json"; a.click();
  };

  const mDist = mPts.length === 2 ? Math.hypot(mPts[1][0] - mPts[0][0], mPts[1][1] - mPts[0][1]) : null;

  const numInput = (k, label, step) => (
    <div key={k} className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA" }}>
      <span className="text-xs whitespace-nowrap" style={{ color: "#2A3540" }}>{label}</span>
      <input
        type="number" step={step} value={params[k]}
        onChange={(e) => setP(k, parseFloat(e.target.value) || 0)}
        className="w-20 text-right text-xs px-1 py-0.5 rounded"
        style={{ border: "1px solid #C8CFD6", fontFamily: "Consolas,monospace" }}
      />
    </div>
  );

  return (
    <div className="h-screen flex flex-col" style={{ background: "#F0F2F4", fontFamily: "'Segoe UI','Noto Sans KR',sans-serif", color: "#1A222C" }}>
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-3 py-1.5 flex-wrap" style={{ background: "#FFFFFF", borderBottom: "2px solid #1A222C" }}>
        <span className="font-bold text-sm tracking-tight">Radial Geometry Matcher</span>
        <span className="text-xs" style={{ color: "#8893A0" }}>DXF 형상 매칭</span>
        <div className="flex-1" />
        <button onClick={() => fileRef.current?.click()} className="text-xs px-3 py-1 rounded text-white font-medium" style={{ background: "#B5622D" }}>
          DXF 불러오기
        </button>
        <input ref={fileRef} type="file" accept=".dxf" className="hidden"
          onChange={(e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; }} />
        {dxfName && <span className="text-xs" style={{ color: "#1B7A2B", fontFamily: "Consolas,monospace" }}>{dxfName}</span>}
        <button onClick={fitView} className="text-xs px-2.5 py-1 rounded" style={{ border: "1px solid #1A222C", background: "#fff" }}>화면 맞춤</button>
        <button onClick={() => { setMeasure(!measure); setMPts([]); }} className="text-xs px-2.5 py-1 rounded"
          style={{ border: "1px solid #1A222C", background: measure ? "#1A222C" : "#fff", color: measure ? "#fff" : "#1A222C" }}>
          측정 {measure ? "ON" : "OFF"}
        </button>
        <button onClick={exportJson} className="text-xs px-2.5 py-1 rounded" style={{ border: "1px solid #1A222C", background: "#fff" }}>JSON 내보내기</button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 좌측 파라미터 패널 */}
        <div className="w-60 overflow-y-auto flex-shrink-0" style={{ background: "#FAFBFC", borderRight: "1px solid #D5DBE1" }}>
          <div className="px-2 py-1 text-xs font-bold" style={{ background: "#E8EBEE", borderLeft: "3px solid #E03030" }}>Stator Parameters</div>
          {STATOR_FIELDS.map(([k, l, s]) => numInput(k, l, s))}
          <div className="px-2 py-1 mt-1 text-xs font-bold" style={{ background: "#E8EBEE", borderLeft: "3px solid #22BB22" }}>Rotor Parameters</div>
          {ROTOR_FIELDS.map(([k, l, s]) => numInput(k, l, s))}
          <div className="flex items-center justify-between px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA", background: "#F1F4F6" }}>
            <span className="text-xs" style={{ color: "#5C6B7A" }}>Rotor Diameter [Calc]</span>
            <span className="text-xs font-semibold" style={{ fontFamily: "Consolas,monospace" }}>{rotorDia.toFixed(2)}</span>
          </div>

          <div className="px-2 py-1 mt-1 text-xs font-bold" style={{ background: "#E8EBEE", borderLeft: "3px solid #1B7A2B" }}>DXF Transform</div>
          {[["scale", "Scale", 0.001], ["dx", "Offset X", 0.1], ["dy", "Offset Y", 0.1], ["rot", "Rotation [°]", 0.5]].map(([k, l, s]) => (
            <div key={k} className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #E2E6EA" }}>
              <span className="text-xs" style={{ color: "#2A3540" }}>{l}</span>
              <input type="number" step={s} value={dxfT[k]}
                onChange={(e) => setDxfT((t) => ({ ...t, [k]: parseFloat(e.target.value) || 0 }))}
                className="w-20 text-right text-xs px-1 py-0.5 rounded" style={{ border: "1px solid #C8CFD6", fontFamily: "Consolas,monospace" }} />
            </div>
          ))}

          <div className="px-2 py-1 mt-1 text-xs font-bold" style={{ background: "#E8EBEE" }}>Layers</div>
          {[["dxf", "DXF 단면"], ["stator", "Stator Lam"], ["slots", "Slots"], ["rotor", "Rotor / Shaft"], ["magnets", "Magnets"]].map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 px-2 py-0.5 text-xs cursor-pointer" style={{ borderTop: "1px solid #E2E6EA" }}>
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((L) => ({ ...L, [k]: e.target.checked }))} />
              {l}
            </label>
          ))}
          <div className="px-2 py-2" style={{ borderTop: "1px solid #E2E6EA" }}>
            <div className="text-xs mb-1" style={{ color: "#5C6B7A" }}>템플릿 투명도</div>
            <input type="range" min="0.05" max="1" step="0.05" value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))} className="w-full" />
          </div>
        </div>

        {/* 캔버스 */}
        <div ref={wrapRef} className="flex-1 relative min-w-0">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ cursor: measure ? "crosshair" : dragRef.current ? "grabbing" : "grab" }}
            onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          />
        </div>
      </div>

      {/* 상태바 */}
      <div className="flex items-center gap-4 px-3 py-1 text-xs" style={{ background: "#1A222C", color: "#C8CFD6", fontFamily: "Consolas,monospace" }}>
        {cursor && <span>X {cursor[0].toFixed(2)}  Y {cursor[1].toFixed(2)}  R {Math.hypot(cursor[0], cursor[1]).toFixed(3)} mm  (Ø{(2 * Math.hypot(cursor[0], cursor[1])).toFixed(2)})</span>}
        {mPts.length === 1 && <span style={{ color: "#F59E0B" }}>측정: 두 번째 점 클릭</span>}
        {mDist !== null && (
          <span style={{ color: "#F59E0B" }}>
            거리 {mDist.toFixed(3)} mm | R1 {Math.hypot(mPts[0][0], mPts[0][1]).toFixed(3)} | R2 {Math.hypot(mPts[1][0], mPts[1][1]).toFixed(3)}
          </span>
        )}
        <div className="flex-1" />
        <span>휠: 줌 · 드래그: 이동 · 측정 ON 후 두 점 클릭</span>
      </div>
    </div>
  );
}
