import { Component, useState, useEffect, useRef, useCallback, useMemo } from "react";

// ════════════════════════════════════════════════════════════════
//  Mini Motor-CAD — PMSM 기초설계 도구
//  Geometry(DXF 매칭) / Winding / Materials / Calculation / Output
//  해석 엔진: 1250W-jk Motor-CAD 결과로 검증됨
// ════════════════════════════════════════════════════════════════

const D2R = Math.PI / 180;
const MU0 = 4 * Math.PI * 1e-7;

// ─── 다크 "컨트롤 패널" 테마 토큰 ────────────────────────────────
const UI = {
  bg: "linear-gradient(160deg,#0b1322 0%,#080d18 60%,#070a12 100%)",
  panel: "#101a30",          // 카드 배경
  panel2: "#0c1424",         // 더 깊은 패널(헤더/표 헤더)
  inset: "#0a1120",          // 입력/오목 영역
  border: "#22304d",         // 기본 테두리
  borderHi: "#33b7d8",       // 강조(시안) 테두리
  cyan: "#34d3e8",           // 주 강조(시안)
  blue: "#3b82f6",           // 버튼/링크 블루
  green: "#2bd47a",          // OK/성공
  amber: "#f5a524",          // 경고/액션
  red: "#ff5d6c",            // 위험/정지
  head: "#e6edf7",           // 제목 텍스트
  text: "#c4d0e4",           // 본문
  label: "#7e8eac",          // 라벨(muted)
  faint: "#56668a",          // 더 흐린
  mono: "'JetBrains Mono','Consolas',monospace",
  ui: "'Chakra Petch','Malgun Gothic','Noto Sans KR',sans-serif",
  logo: "'Orbitron','Chakra Petch',sans-serif",
};
// 패널 카드 (브래킷 코너 장식 포함) — 다크 컨트롤패널 룩
const Panel = ({ title, accent = UI.cyan, children, style, bodyClass = "" }) => (
  <div style={{ position: "relative", background: `linear-gradient(180deg,${UI.panel},#0e1626)`, border: `1px solid ${UI.border}`, borderRadius: 14, boxShadow: "0 4px 16px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)", ...style }}>
    {title && (
      <div className="px-3 pt-2 pb-1.5 text-xs font-semibold" style={{ color: UI.label, letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: UI.ui }}>
        <span style={{ color: accent, marginRight: 6 }}>▮</span>{title}
      </div>
    )}
    <div className={bodyClass} style={{ padding: title ? "0 10px 10px" : 10 }}>{children}</div>
    {/* 브래킷 코너 */}
    {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([rx, ry], i) => (
      <span key={i} style={{ position: "absolute", [rx ? "right" : "left"]: 6, [ry ? "bottom" : "top"]: 6, width: 9, height: 9,
        [`border${ry ? "Bottom" : "Top"}`]: `1.5px solid ${accent}66`, [`border${rx ? "Right" : "Left"}`]: `1.5px solid ${accent}66`, pointerEvents: "none" }} />
    ))}
  </div>
);

// 렌더 예외 안전망 — 입력값이 극단/퇴화되면 화면이 통째로 꺼지지 않게 복구 UI 표시.
class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (this.state.err) {
      return (
        <div className="p-6" style={{ color: UI.text }}>
          <div className="rounded p-4" style={{ background: "rgba(255,93,108,0.1)", border: `1px solid ${UI.red}66`, maxWidth: 560 }}>
            <div style={{ color: UI.red, fontWeight: 700, fontSize: 15, marginBottom: 6 }}>⚠ 표시 오류 — 입력값이 형상을 깨뜨렸습니다</div>
            <div className="text-xs" style={{ color: UI.label, marginBottom: 10, lineHeight: 1.6 }}>
              방금 바꾼 값(예: 로터 외경·자석 두께·에어갭)이 형상을 퇴화시켜 렌더가 멈췄습니다.
              아래로 복구하세요. 데이터는 보존됩니다.
            </div>
            <div className="flex gap-2">
              <button onClick={() => { this.props.onReset && this.props.onReset(); }}
                className="text-xs px-3 py-1.5 rounded font-semibold" style={{ background: `linear-gradient(180deg,${UI.blue},#2456c8)`, color: "#fff" }}>
                ⟲ 기준형상(1250W)으로 되돌리기
              </button>
              <button onClick={() => window.location.reload()}
                className="text-xs px-3 py-1.5 rounded" style={{ border: `1px solid ${UI.border}`, color: UI.text, background: UI.inset }}>
                페이지 새로고침
              </button>
            </div>
            <div className="text-xs mt-3" style={{ color: UI.faint, fontFamily: UI.mono }}>{String(this.state.err?.message ?? this.state.err).slice(0, 200)}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// 비유한(NaN/Infinity) → "—" 표시. 편집 중 퇴화 입력이 숫자칸에 NaN으로 새는 것 방지.
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

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
      if ([x1, y1, x2, y2].every(Number.isFinite))      // 끝점 누락 시 NaN 형상 방지
        shapes.push({ type: "poly", pts: [[x1, y1], [x2, y2]], closed: false });
    } else if (val === "CIRCLE" || val === "ARC") {
      let cx, cy, r, a1 = 0, a2 = 360; const isArc = val === "ARC"; i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const [c, v] = pairs[i];
        if (c === 10) cx = num(v); else if (c === 20) cy = num(v);
        else if (c === 40) r = num(v); else if (c === 50) a1 = num(v); else if (c === 51) a2 = num(v);
        i++;
      }
      if ([cx, cy, r].every(Number.isFinite) && r > 0)   // 코드40(r) 누락 등 → NaN cx가 중심중앙값 오염 방지
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
    if (s.type === "circle") circles.push({ cx: s.cx, cy: s.cy, r: s.r, full: true });
    else if (s.type === "arc") {                         // 호는 큰 각도(>270°)만 동심원 후보로
      const sp = (((s.a2 - s.a1) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      circles.push({ cx: s.cx, cy: s.cy, r: s.r, full: sp > 4.712 });
    }
    else if (s.type === "poly" && s.pts && s.pts.length) {
      s.pts.forEach((p) => { if (isFinite(p[0]) && isFinite(p[1])) allPts.push(p); });
      if (s.closed && s.pts.length >= 3) closed.push(s.pts);
    }
  }
  // 중심: 원 중심들의 중앙값(견고), 없으면 점 바운딩박스 중심
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
  const unit = maxR < 5 ? 1000 : 1;                  // 5 미만이면 m로 보고 mm 변환
  // 동심원(중심 근처) → 지름 목록(병합)
  const conc = circles.filter((c) => c.full && R(c.cx, c.cy) < 0.03 * maxR);
  let dias = [...new Set(conc.map((c) => +(2 * c.r * unit).toFixed(2)))].sort((a, b) => b - a);
  const merged = [];
  dias.forEach((d) => { if (!merged.some((m) => Math.abs(m - d) < 0.3)) merged.push(d); });
  dias = merged;
  // 닫힌 폴리 → 무게중심반경·내/외반경·중심각·각폭
  const angSpanOf = (pts, gx, gy) => {            // 무게중심각 기준 점들의 각폭(deg)
    const cang = Math.atan2(gy - cy, gx - cx); let lo = 0, hi = 0;
    pts.forEach((p) => { let d = Math.atan2(p[1] - cy, p[0] - cx) - cang; d = Math.atan2(Math.sin(d), Math.cos(d)); if (d < lo) lo = d; if (d > hi) hi = d; });
    return (hi - lo) / D2R;
  };
  const polyInfo = closed.map((pts) => {
    let sx = 0, sy = 0; pts.forEach((p) => { sx += p[0]; sy += p[1]; });
    const gx = sx / pts.length, gy = sy / pts.length;
    return { rc: R(gx, gy) * unit, rin: Math.min(...pts.map((p) => R(p[0], p[1]))) * unit,
      rout: Math.max(...pts.map((p) => R(p[0], p[1]))) * unit, ang: Math.atan2(gy - cy, gx - cx) / D2R,
      span: angSpanOf(pts, gx, gy) };
  }).filter((p) => p.rc > 0.02 * maxR * unit && p.rc > 0.6 * p.rin);
  // 잡음 제외 + 축을 감싸는 프레임 윤곽선(적층 외곽선·링: 무게중심이 중심으로 끌려 rc≪rin) 제외.
  // 실제 슬롯/자석 피처는 rin<rc<rout 이라 무게중심이 피처 반경에 있음.
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
  // 회전 오프셋(피치 ±절반 내 잔차): n중 대칭의 원형평균.
  // 산술평균은 잔차가 ±피치/2 경계에 걸치면(톱니/극이 축 위 등) +half와 −half가 상쇄돼 0으로 무너진다.
  const meanRot = (arr, p) => {
    if (!arr.length) return 0;
    const n = 360 / p;                                  // 대칭 차수(슬롯/극수)
    let S = 0, C = 0;
    for (const a of arr) { S += Math.sin(n * a * D2R); C += Math.cos(n * a * D2R); }
    if (Math.abs(S) < 1e-12 && Math.abs(C) < 1e-12) return 0;
    return Math.atan2(S, C) / D2R / n;                  // (−p/2, p/2]
  };
  const median = (arr) => { if (!arr.length) return 0; const a = arr.slice().sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  let slotCount = 0, poleCount = 0, rotorOD = 0, airgap = 0, statorRot = 0, rotorRot = 0;
  let borePoly = 0, outerN = 0, innerN = 0, slotRout = 0, slotSpan = 0, magThk = 0, magSpan = 0;
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
      slotRout = median(outer.map((p) => p.rout));        // 슬롯 바닥 반경(mm)
      slotSpan = median(outer.map((p) => p.span));        // 슬롯 폴리 각폭(deg)
    }
    if (inner.length) {
      poleCount = countClusters(inner.map((p) => p.ang));
      rotorOD = 2 * Math.max(...inner.map((p) => p.rout));
      rotorRot = meanRot(inner.map((p) => p.ang), 360 / poleCount);
      magThk = median(inner.map((p) => p.rout - p.rin));  // 자석 두께(mm)
      magSpan = median(inner.map((p) => p.span));         // 자석 각폭(deg, 기계)
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
  // ── 종속 치수 추출 (모델 일관성용) ──
  const Rb = statorBore / 2, Ro = statorLamDia / 2;
  // 슬롯깊이: 슬롯 바닥반경 − 보어반경. 백아이언 ≥0.8mm 남도록 클램프.
  let slotDepth = slotRout > Rb ? slotRout - Rb : 0;
  if (slotDepth > 0) slotDepth = Math.min(slotDepth, (Ro - Rb) - 0.8);
  // 톱니폭: mid반경 슬롯피치호 × (1 − 동(copper)점유율). 점유율 = (피치당 코일폴리수 × 코일각폭)/피치.
  let toothWidth = 0;
  if (slotCount > 0 && slotDepth > 0 && slotSpan > 0) {
    const coilsPerPitch = Math.max(1, Math.round(outerN / slotCount));
    const copperFrac = Math.min(0.85, Math.max(0.2, (coilsPerPitch * slotSpan) / (360 / slotCount)));
    const Rmid = Rb + slotDepth / 2;
    toothWidth = (2 * Math.PI * Rmid / slotCount) * (1 - copperFrac);
  }
  // 자석호각(전기): 자석 기계각폭 × 극쌍수. 자석두께: 자석 밴드 두께.
  const magnetArcED = (magSpan > 0 && poleCount >= 2) ? Math.min(180, magSpan * poleCount / 2) : 0;
  return { cx, cy, unit, dias, statorLamDia, statorBore: +statorBore.toFixed(2),
    shaftDia: +shaftDia.toFixed(2), slotCount, poleCount, rotorOD: +rotorOD.toFixed(2),
    airgap: +airgap.toFixed(2), statorRot: +statorRot.toFixed(1), rotorRot: +rotorRot.toFixed(1),
    outerN, innerN, borePoly: +borePoly.toFixed(2),
    slotDepth: +slotDepth.toFixed(2), toothWidth: +toothWidth.toFixed(2),
    magnetThickness: +magThk.toFixed(2), magnetArcED: +magnetArcED.toFixed(0) };
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
      const pts = sh.pts.filter(([px, py]) => Number.isFinite(px) && Number.isFinite(py));  // 비유한 점 제외
      if (pts.length < 2) continue;
      L.push("0", "LWPOLYLINE", "8", "0", "90", String(pts.length), "70", sh.closed ? "1" : "0");
      pts.forEach(([px, py]) => { const [x, y] = tf(px, py); L.push("10", f(x), "20", f(y)); });
    }
  }
  L.push("0", "ENDSEC", "0", "EOF");
  return L.join("\n");
}

// ─── Ansys Maxwell .aedt 설계변수 임포트 ─────────────────────────────
// .aedt의 VariableProp 블록을 파싱하고 수식(단위 mm/deg·변수참조·함수)을 평가해
// 모델 파라미터로 매핑. DXF 외곽선 추출의 추측을 건너뛰고 설계 원본값을 정확히 적용.
function parseAedt(text) {
  const D2Rl = Math.PI / 180;
  const vars = {}, lc = {};
  const re = /VariableProp\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']*)'/g;
  let m; while ((m = re.exec(text))) { vars[m[1]] = m[2]; lc[m[1].toLowerCase()] = m[1]; }
  if (!Object.keys(vars).length) return null;
  const FUNCS = { sin: (x) => Math.sin(x * D2Rl), cos: (x) => Math.cos(x * D2Rl), tan: (x) => Math.tan(x * D2Rl),
    asin: (x) => Math.asin(x) / D2Rl, acos: (x) => Math.acos(x) / D2Rl, atan: (x) => Math.atan(x) / D2Rl, sqrt: Math.sqrt, abs: Math.abs };
  const UNIT = { mm: 1, cm: 10, m: 1000, um: 0.001, deg: 1, rad: 180 / Math.PI, rpm: 1, a: 1, v: 1, ohm: 1, hz: 1, s: 1, ms: 0.001 };
  const evalVar = (name, seen) => {
    const key = lc[name.toLowerCase()]; if (!key) throw new Error("미정의 " + name);
    if (seen.has(key)) throw new Error("순환참조 " + key);
    const ns = new Set(seen); ns.add(key);
    return parseExpr(vars[key], ns);
  };
  function parseExpr(src, seen) {
    let i = 0; const s = src;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function atom() {
      ws();
      if (s[i] === "(") { i++; const v = expr(); ws(); if (s[i] === ")") i++; return v; }
      if (s[i] === "-") { i++; return -atom(); }
      if (s[i] === "+") { i++; return atom(); }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (id) {
        const w = id[0]; i += w.length; ws();
        if (s[i] === "(") { i++; const a = expr(); ws(); if (s[i] === ")") i++; const fn = FUNCS[w.toLowerCase()]; if (!fn) throw new Error("미지원함수 " + w); return fn(a); }
        if (w.toUpperCase() === "PI") return Math.PI;
        return evalVar(w, seen);
      }
      const nm = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(s.slice(i));
      if (!nm) throw new Error("파싱오류 @" + i + " in " + src);
      i += nm[0].length; let val = parseFloat(nm[0]);
      const u = /^[A-Za-z]+/.exec(s.slice(i));
      if (u) { const f = UNIT[u[0].toLowerCase()]; if (f !== undefined) { val *= f; i += u[0].length; } }
      return val;
    }
    function term() { let v = atom(); for (;;) { ws(); if (s[i] === "*") { i++; v *= atom(); } else if (s[i] === "/") { i++; v /= atom(); } else break; } return v; }
    function expr() { let v = term(); for (;;) { ws(); if (s[i] === "+") { i++; v += term(); } else if (s[i] === "-") { i++; v -= term(); } else break; } return v; }
    return expr();
  }
  // 후보 이름 중 첫 평가 성공값 (없으면 undefined)
  const V = (...names) => { for (const n of names) { try { const v = evalVar(n, new Set()); if (isFinite(v)) return v; } catch (e) { /* skip */ } } return undefined; };

  const D_ro = V("D_ro"), T_m = V("T_m"), g = V("g"), D_so = V("D_so"), T_Yoke = V("T_Yoke");
  const N_slot = V("N_slot", "Slots"), N_pole = V("N_pole", "Poles"), a_m = V("a_m", "Embrace");
  const D_shaft = V("D_shaft", "D_sh"), rotorYoke = V("T_rotorYoke", "T_RotorYoke", "T_Yoke_Rotor");
  // 외전형(아우터로터): 로터 외경 D_ro > 스테이터 외경 D_so. 스테이터 보어=내경 마운팅홀(D_shaft).
  const outer = D_ro !== undefined && D_so !== undefined && D_ro > D_so;
  const D_si = outer ? (V("D_si") ?? D_shaft) : (V("D_si") ?? (D_ro !== undefined && g !== undefined ? D_ro + 2 * g : undefined));
  const offset = V("Magnet_R_Offset", "MagOffset");
  const geo = {}, wind = {}, applied = [], missing = [], warnings = [];
  const set = (obj, k, v, label) => { if (v !== undefined && isFinite(v)) { obj[k] = +v.toFixed(3); applied.push(label || k); } else missing.push(label || k); };

  set(geo, "statorLamDia", D_so, "statorLamDia(D_so)");
  set(geo, "statorBore", D_si, "statorBore(D_si)");
  set(geo, "airgap", g ?? (!outer && D_si !== undefined && D_ro !== undefined ? (D_si - D_ro) / 2 : undefined), "airgap(g)");
  if (outer && g === undefined) warnings.push("외전형 공극(g) 미추출 — 기존 airgap 값 유지(반경 도출 불가, 확인 필요)");
  set(geo, "shaftDia", V("D_shaft", "D_sh"), "shaftDia(D_shaft)");
  set(geo, "slotNumber", N_slot !== undefined ? Math.round(N_slot) : undefined, "slotNumber(N_slot)");
  set(geo, "poleNumber", N_pole !== undefined ? Math.round(N_pole) : undefined, "poleNumber(N_pole)");
  const W_t = V("W_t", "Wt"), W_so = V("W_so", "Bs0"), d_1 = V("d_1", "d1"), d_2 = V("d_2", "d2");
  set(geo, "toothWidth", W_t, "toothWidth(W_t)");
  set(geo, "slotOpening", W_so, "slotOpening(W_so)");
  set(geo, "toothTipDepth", d_1 ?? d_2, "toothTipDepth(d_1)");
  // 톱니팁 테이퍼각: 직선개구(d_1) 끝 A2에서 톱니측면(반경 R3=보어+d_1+d_2)까지의 각도.
  // 이렇게 두면 모델 buildSlotPath의 A3가 정확히 R3에 떨어져 Maxwell d_1·d_2 구성과 일치.
  let toothTipAngle;
  if (!outer && [D_si, N_slot, W_t, W_so, d_1, d_2].every((x) => x !== undefined)) {
    const Rb = D_si / 2, halfOp = W_so / 2, x1 = Math.sqrt(Math.max(Rb * Rb - halfOp * halfOp, 0));
    const A2x = x1 + d_1, A2y = halfOp, dlt = Math.PI / N_slot;
    const R3 = Rb + d_1 + d_2, t = Math.sqrt(Math.max(R3 * R3 - (W_t / 2) ** 2, 0));
    const A3x = Math.cos(dlt) * t + Math.sin(dlt) * W_t / 2, A3y = Math.sin(dlt) * t - Math.cos(dlt) * W_t / 2;
    const ang = Math.atan2(A3x - A2x, A3y - A2y) / D2Rl;
    if (isFinite(ang) && ang > 0 && ang < 30) toothTipAngle = ang;
  }
  set(geo, "toothTipAngle", toothTipAngle, "toothTipAngle(d_2→테이퍼)");
  // 슬롯깊이 = 슬롯바닥반경(D_so/2−T_Yoke) − 보어반경
  const slotDepth = (D_so !== undefined && T_Yoke !== undefined && D_si !== undefined) ? (D_so / 2 - T_Yoke) - D_si / 2 : undefined;
  set(geo, "slotDepth", slotDepth, "slotDepth(D_so/2−T_Yoke−D_si/2)");
  set(geo, "magnetThickness", T_m, "magnetThickness(T_m)");
  set(geo, "magnetArcED", a_m !== undefined ? Math.min(180, a_m * 180) : undefined, "magnetArcED(a_m×180)");
  // 자석 R 면취: 외측호 오프셋(Magnet_R_Offset)에서 모델 정의(Ro−hypot(xe,W2))로 환산.
  let reduction;
  if (!outer && [D_ro, T_m, N_pole, a_m, offset].every((x) => x !== undefined)) {
    const Ro = D_ro / 2, Ri = Ro - T_m, halfA = (a_m * 180 / N_pole) * D2Rl, W2 = Ri * Math.sin(halfA), Ra = Ro - offset;
    if (Ra > W2 && offset >= 0 && offset < Ro) reduction = Math.max(0, Ro - Math.hypot(offset + Math.sqrt(Ra * Ra - W2 * W2), W2));
  }
  set(geo, "magnetReduction", reduction, "magnetReduction(offset→면취)");
  const Lstk = V("L_stk", "Lstk", "L_stack", "Length");
  if (Lstk !== undefined) { ["stackLength", "magnetLength", "rotorLamLength", "magneticLength"].forEach((k) => { geo[k] = +Lstk.toFixed(3); }); applied.push("축길이(L_stk)"); }
  else missing.push("축길이(L_stk)");
  set(wind, "turnsPerCoil", (() => { const z = V("Zc", "N_turns", "TurnsPerCoil"); return z !== undefined ? Math.round(z) : undefined; })(), "turnsPerCoil(Zc)");
  const aVar = V("a", "ParallelPaths"); if (aVar !== undefined && aVar >= 1) wind.parallelPaths = Math.round(aVar);
  // Maxwell 슬롯 바닥은 직선(동심호 아님) — DXF 검증 완료. 임포트 시 직선 바닥으로 설정.
  geo.slotBottomShape = "straight"; applied.push("슬롯바닥=직선(Maxwell)");
  // 권선 와이어: .aedt는 턴수만 줌(가닥·굵기 없음 — Maxwell 2D 미저장). 1250W 와이어가 작은 슬롯을
  // 넘치게 하므로, 슬롯면적 기준 단선으로 ~40% Cu 채움이 되도록 자동 산정(실제 사양 입력 권장).
  if (wind.turnsPerCoil > 0 && geo.statorBore && geo.slotDepth && geo.toothWidth) {
    try {
      const slotArea = shoelace(buildSlotPath(geo));            // mm²
      const baseWind = { ...WIND0, ...wind, strands: 1 };
      let dCu = Math.sqrt(0.42 * slotArea * 4 / (2 * wind.turnsPerCoil * Math.PI)); // 초기추정(슬롯 42%)
      let fitOK = false;
      // 실제 패킹(직선바닥·라이너·웻지·디바이더 반영)으로 턴수가 들어갈 때까지 와이어 축소 → 들어가는 최대 굵기.
      for (let it = 0; it < 18 && dCu > 0.1; it++) {
        const pk = packConductors(geo, { ...baseWind, wireDia: dCu / 0.9, copperDia: dCu });
        if (pk.capacity >= wind.turnsPerCoil) { fitOK = true; break; }
        dCu *= 0.94;
      }
      if (isFinite(dCu) && dCu > 0.05) {
        wind.strands = 1; wind.copperDia = +dCu.toFixed(3); wind.wireDia = +(dCu / 0.9).toFixed(3);
        applied.push(`와이어 자동(Ø${wind.wireDia}·1가닥${fitOK ? ", 슬롯에 맞춤" : ", 슬롯한계"})`);
      }
    } catch (e) { /* 형상 불완전 시 와이어 유지 */ }
  }

  // 외전형(아우터로터) 감지: D_ro>D_so 면 로터가 스테이터 바깥 → 내전형 가정 모델과 형상 모순.
  if (outer) {
    geo.rotorType = "outer";
    geo.magnetReduction = 0;           // 외전형 면취 미추출 → 0(기본값 오적용·메시 슬리버 방지)
    geo.toothTipAngle = 0;             // 외전형 톱니팁각 미추출 → 0
    if (rotorYoke !== undefined) geo.rotorYoke = +rotorYoke.toFixed(3);
    applied.push("외전형(rotorType=outer)" + (rotorYoke !== undefined ? "+로터백아이언(T_rotorYoke)" : ""));
    warnings.push("외전형(아우터로터) 모델 적용 — 공극면=외경·자석 바깥. 톱니팁각·자석면취는 미반영(근사).");
  } else geo.rotorType = "inner";
  return { geo, wind, applied, missing, warnings, varCount: Object.keys(vars).length };
}

// ─── 형상 생성 ───────────────────────────────────────────────────
// 외전형(아우터로터): 공극면이 외경(statorLamDia). 내전형 형상을 외경반경에서 만들어
// 외경원 R→2·Rag−R 로 안쪽으로 반사 = 외전형 슬롯/자석(공극면 폭·치 형상 보존, 검증된 빌더 재사용).
const reflectOuter = (P, fn) => {
  const Rag = P.statorLamDia / 2;
  return fn({ ...P, rotorType: "inner", statorBore: P.statorLamDia })
    .map(([x, y]) => { const R = Math.hypot(x, y) || 1e-9, k = (2 * Rag - R) / R; return [x * k, y * k]; });
};
function buildSlotPath(P) {
  if (P.rotorType === "outer") return reflectOuter(P, buildSlotPath);
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
  if (P.slotBottomShape === "straight") {
    // 직선 바닥 (Ansys Maxwell): 톱니측면이 Rd·cos(반슬롯피치) 투영까지 직선으로 나간 뒤,
    // 슬롯 중심 바닥정점(Rd,0)으로 직선 연결 — DXF 검증: 가장자리 R=hypot(Rd·cosδ,Wt/2), 정점 R=Rd.
    const tEnd = Rd * Math.cos(dlt);
    const A4 = [tEnd * u[0] + nv[0], tEnd * u[1] + nv[1]];
    return [A1, A2, A3, A4, [Rd, 0], [A4[0], -A4[1]], [A3[0], -A3[1]], [A2[0], -A2[1]], [A1[0], -A1[1]]];
  }
  // 동심호 바닥 (Motor-CAD 기본) — 반경 Rd 일정한 호
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
  if (P.rotorType === "outer") return reflectOuter(P, buildMagnetPath);
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

// ─── DXF 형상 정합 자동검사 (모델↔실제 DXF 잔차) ─────────────────
// tools/verify_fit.mjs 와 동일 로직을 앱에 내장. "맞는다"를 눈이 아니라 측정으로 — 임계 초과 시 빨강.
// 정점만 비교하면 직선구간 중간의 호 볼록을 놓치므로 반드시 조밀화+양방향.
const FIT_TOL_STATOR = 0.3, FIT_TOL_MAG = 0.6; // mm (자석은 모델 코너필렛 미지원분 허용)
function fitResidual(dxf, P) {
  if (!dxf || !(P.slotNumber > 0) || !(P.poleNumber > 0) || !(P.statorBore > 0)) return null;
  const distSeg = (p, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1]; const c1 = wx * vx + wy * vy; if (c1 <= 0) return Math.hypot(wx, wy); const c2 = vx * vx + vy * vy; if (c2 <= c1) return Math.hypot(p[0] - b[0], p[1] - b[1]); const t = c1 / c2; return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy)); };
  const distPoly = (p, poly, open) => { let m = Infinity; const lim = open ? poly.length - 1 : poly.length; for (let i = 0; i < lim; i++) { const d = distSeg(p, poly[i], poly[(i + 1) % poly.length]); if (d < m) m = d; } return m; };
  const distPolys = (p, polys) => { let m = Infinity; for (const poly of polys) { const d = distPoly(p, poly); if (d < m) m = d; } return m; };
  const densify = (pts, step, closeIt) => { const out = []; const n = pts.length; const lim = closeIt ? n : n - 1; for (let i = 0; i < lim; i++) { const a = pts[i], b = pts[(i + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const k = Math.max(1, Math.ceil(L / step)); for (let j = 0; j < k; j++) { const t = j / k; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } } if (!closeIt) out.push(pts[n - 1]); return out; };
  const circs = dxf.filter((s) => s.type === "circle");
  const med = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const cx = circs.length ? med(circs.map((c) => c.cx)) : 0, cy = circs.length ? med(circs.map((c) => c.cy)) : 0;
  const C = ([x, y]) => [x - cx, y - cy], R = ([x, y]) => Math.hypot(x, y);
  const Rb = P.statorBore / 2, Rd = Rb + P.slotDepth;
  const Ro = (P.statorBore - 2 * P.airgap) / 2 - (P.bandingThickness || 0), Ri = Ro - P.magnetThickness;
  const closed = dxf.filter((s) => s.type === "poly" && s.closed && s.pts.length >= 10).sort((a, b) => b.pts.length - a.pts.length);
  if (!closed.length) return null;
  const STEP = 0.2;
  const lamC = densify(closed[0].pts.map(C), 0.15, true);
  const lamInner = lamC.filter((p) => { const r = R(p); return r >= Rb - 0.3 && r <= Rd + 0.15; });
  const pitchS = 2 * Math.PI / P.slotNumber;
  const buildSlots = (rot) => { const a = []; for (let k = 0; k < P.slotNumber; k++) a.push(rotPts(buildSlotPath(P), rot + k * pitchS)); return a; };
  let bestRotS = 0, bestMean = Infinity;
  for (let a = 0; a < pitchS; a += pitchS / 60) { const slots = buildSlots(a); let sum = 0; for (const p of lamInner) sum += Math.min(distPolys(p, slots), Math.abs(R(p) - Rb)); if (sum < bestMean) { bestMean = sum; bestRotS = a; } }
  const slots = buildSlots(bestRotS);
  const modelPts = slots.flatMap((poly) => densify(poly, STEP, false)).filter((p) => R(p) > Rb + 0.3);
  let sMax = 0, sBot = 0; const isBot = (p) => R(p) > Rb + P.slotDepth * 0.5;
  for (const p of lamInner) { const d = Math.min(distPolys(p, slots), Math.abs(R(p) - Rb)); if (d > sMax) sMax = d; if (isBot(p) && d > sBot) sBot = d; }
  for (const m of modelPts) { const d = distPoly(m, lamC); if (d > sMax) sMax = d; if (isBot(m) && d > sBot) sBot = d; }
  const magPolys = closed.filter((s) => { const rs = s.pts.map((p) => R(C(p))); const rmin = Math.min(...rs), rmax = Math.max(...rs); return rmax <= Ro + 0.8 && rmax >= Ro - 1.5 && rmin >= Ri - 1.5 && s.pts.length < 200; });
  let mMax = null, bestRotM = 0;
  if (magPolys.length) {
    const magDxf = magPolys.map((s) => densify(s.pts.map(C), STEP, true)), magDxfPts = magDxf.flat();
    const pitchM = 2 * Math.PI / P.poleNumber;
    const buildMags = (rot) => { const a = []; for (let k = 0; k < P.poleNumber; k++) a.push(rotPts(buildMagnetPath(P), rot + k * pitchM)); return a; };
    let bm = Infinity; for (let a = 0; a < pitchM; a += pitchM / 60) { const mags = buildMags(a); let sum = 0; for (const p of magDxfPts) sum += distPolys(p, mags); if (sum < bm) { bm = sum; bestRotM = a; } }
    const mags = buildMags(bestRotM); mMax = 0; for (const p of magDxfPts) mMax = Math.max(mMax, distPolys(p, mags));
    const modelMagPts = mags.flatMap((poly) => densify(poly, STEP, true)); for (const m of modelMagPts) mMax = Math.max(mMax, distPolys(m, magDxf));
  }
  const statorOK = sMax <= FIT_TOL_STATOR, magOK = mMax === null || mMax <= FIT_TOL_MAG;
  return { sMax, sBot, statorRot: bestRotS * 180 / Math.PI, mMax, magCount: magPolys.length, statorOK, magOK, ok: statorOK && magOK };
}

// ─── 권선 패턴 + 권선계수 (star of slots, 2층) ───────────────────
function windingAnalysis(Ns, poles, throw_, Nc) {
  const pp = poles / 2;
  const theta = Array.from({ length: Ns }, (_, i) => ((i * pp * 360) / Ns) % 360);
  const coils = []; // {go, ret, phase 0/1/2, sign}
  const beltMap = { 0: [0, 1], 3: [0, -1], 2: [1, 1], 5: [1, -1], 4: [2, 1], 1: [2, -1] };
  let invalid = false;
  for (let i = 0; i < Ns; i++) {
    const ret = (i + throw_) % Ns;
    const g = theta[i] * D2R, r = theta[ret] * D2R;
    const re = Math.cos(g) - Math.cos(r), im = Math.sin(g) - Math.sin(r);
    if (Math.hypot(re, im) < 1e-9) invalid = true;        // go==ret(EMF 위상 동일) → 권선 무효
    const axis = ((Math.atan2(im, re) / D2R) % 360 + 360) % 360;
    const [ph, sg] = beltMap[Math.floor((axis + 1e-6) / 60) % 6];  // 60° 경계 부동소수 가드
    coils.push({ go: i, ret, phase: ph, sign: sg });
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
  const cpp = [0, 1, 2].map((p) => coils.filter((c) => c.phase === p).length);
  const balanced = !invalid && cpp[0] === cpp[1] && cpp[1] === cpp[2];
  const coilsPerPhase = cpp[0];
  return { coils, table, kw, coilsPerPhase, coilsPerPhaseAll: cpp, balanced, theta };
}

// ─── 재질 DB ─────────────────────────────────────────────────────
const STEELS = {
  "20PNX1200F": { density: 7650, kh: 0.0212, ke: 4.157e-5, thk: 0.2 },
  "35PN230":    { density: 7600, kh: 0.028,  ke: 9.0e-5,  thk: 0.35 },
  "50PN470":    { density: 7700, kh: 0.038,  ke: 2.2e-4,  thk: 0.5 },
  "M350-50A":   { density: 7650, kh: 0.024,  ke: 1.4e-4,  thk: 0.5 },  // 0.5mm 무방향성(3.5W/kg@1.5T50Hz, 손실분리: 와전류∝두께² 고전값~1.1e-4+과잉). 영상 400W 강판.
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
function compute(G, W, M, C, cal) {
  const out = {};
  const Ns = G.slotNumber, poles = G.poleNumber, pp = poles / 2;
  const Bore = G.statorBore, g = G.airgap, lm = G.magnetThickness;
  // ── 토폴로지(내전형/외전형) 반경 ── 외전형은 공극면이 외경(statorLamDia), 로터가 바깥.
  const outer = G.rotorType === "outer";
  const Rag = outer ? G.statorLamDia / 2 : Bore / 2;            // 공극면(슬롯 개구) 반경
  const Rsb = outer ? Rag - G.slotDepth : Rag + G.slotDepth;    // 슬롯 바닥
  const Rback = outer ? Bore / 2 : G.statorLamDia / 2;          // 스테이터 반대편(요크 끝)
  const Rt0 = Math.min(Rag, Rsb), Rt1 = Math.max(Rag, Rsb);    // 치 환형
  const Ry0 = Math.min(Rsb, Rback), Ry1 = Math.max(Rsb, Rback);// 요크 환형
  const Dair = 2 * Rag + (outer ? g : -g);                     // 평균 공극 지름
  const mag = { ...MAGNETS[M.magnet], Br20: M.Br20, tc: M.tcBr, mur: M.mur };
  const stl = { ...STEELS[M.steel], kh: M.kh, ke: M.ke };

  // 자석/공극
  const Br = mag.Br20 * (1 + mag.tc / 100 * (C.Tmag - 20));
  const taus = Math.PI * 2 * Rag / Ns;   // 공극면 슬롯피치 (외전형은 외경 기준)
  const gC = g > 1e-6 ? g : 1e-6;        // 공극 0 방어(g≈0서 Carter 발산 방지)
  const gam = (G.slotOpening / gC) ** 2 / (5 + G.slotOpening / gC);
  const kc = Math.min(Math.max(taus / Math.max(taus - gam * gC, 1e-6), 1), 3);  // Carter는 물리상 ≥1: 광폭개구서 분모≤0→kc폭발(Bg→0) 방지 위해 [1,3]로 클램프
  const Bgpk = Br * lm / (lm + mag.mur * kc * gC);
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
  const D = Dair, taup = Math.PI * D / poles;
  const alpha = G.magnetArcED / 180;
  const L = G.magneticLength * 1e-3;
  // 쇄교자속 λ — FEMM 보정이 적용되면 FEMM에서 측정한 λ(=Ke/pp)를 그대로 사용.
  // 그러면 토크·EMF·출력·T-N·효율맵 등 λ 의존 결과가 전부 FEMM 기반이 된다.
  const lamAnalytic = (2 / Math.PI) * kw1 * NphSeries * (alpha * Bgpk * C.klk) * (taup * 1e-3) * L;
  const lam = (cal && Number.isFinite(cal.lam)) ? cal.lam : lamAnalytic;
  out.lambda = lam; out.lambdaAnalytic = lamAnalytic; out.magnetAlpha = alpha;
  out.femmCal = (cal && Number.isFinite(cal.lam)) ? cal : null;
  const fe = C.speed / 60 * pp;
  out.fe = fe;
  out.fMech = C.speed / 60;                                   // 기계 회전주파수 [Hz]
  out.Epk = 2 * Math.PI * fe * lam;
  out.Erms = out.Epk / Math.SQRT2;
  out.Ke = pp * lam;
  out.pp = pp;
  const Iph = W.connection === "delta" ? C.IlineRms / Math.sqrt(3) : C.IlineRms;
  out.IphRms = Iph; out.IlineRms = C.IlineRms;
  const IphPk = Iph * Math.SQRT2;
  // dq 전류(피크) — 단일 소스(P2): 토크·부하각·전압이 같은 idPk/iqPk를 공유(규약 드리프트 방지).
  const adv = C.phaseAdv * D2R;
  const idPk = -IphPk * Math.sin(adv), iqPk = IphPk * Math.cos(adv);
  const Iq = iqPk;   // 정렬(자석) 토크용 q축 전류
  // kT: FEMM 직접토크/λ공식토크 비율 = 부하 포화 보정. 보정 미적용이면 1.
  const kT = (cal && Number.isFinite(cal.kT)) ? cal.kT : 1;
  out.kTsat = kT;
  out.torque = 1.5 * pp * lam * Iq * kT;
  out.Kt_phase = Iph > 0 ? out.torque / Iph : 0;
  out.KtLine = C.IlineRms > 0 ? out.torque / (C.IlineRms * Math.SQRT2) : 0;

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
  const tausMid = Math.PI * (Rt0 + Rt1) / Ns;   // 슬롯 평균반경 피치(외전형 대응)
  const slotWMid = tausMid - G.toothWidth;
  out.coilPitch = W.throw * tausMid - slotWMid / 2;
  out.MLT = 2 * G.stackLength + Math.PI * out.coilPitch;
  const rho = 1.724e-8 * (1 + 0.003862 * (C.Tcu - 20));
  out.Rphase = rho * (out.MLT * 1e-3 * NphSeries) / (out.turnCSA * 1e-6) / W.parallelPaths;
  out.RlineLine = W.connection === "delta" ? (2 / 3) * out.Rphase : 2 * out.Rphase;
  out.Pcu = 3 * Iph ** 2 * out.Rphase;
  out.Jrms = Iph / W.parallelPaths / out.turnCSA;

  // 권선영역 상세 (Motor-CAD Winding 출력 대응, 기하 근사) — 토폴로지(내전형/외전형) 무관
  // 외전형은 슬롯 개구가 외경(Rag)·바닥이 안쪽(Rag−slotDepth). 내전형은 Bore/2=Rag라 값 동일(무회귀).
  const Ropen = Rag;                                                    // 슬롯 개구 반경(양 토폴로지)
  const wedgeHold = W.wedgeModel === "wound" ? 0 : W.wedgeDepth;        // Wound Space: 웨지 공간도 권선 가능
  const tipChord = Ropen - Math.sqrt(Math.max(Ropen * Ropen - (G.slotOpening / 2) ** 2, 0));
  const depthStart = G.toothTipDepth + wedgeHold - tipChord;           // 개구→권선 시작 반경깊이
  const Rstart = outer ? Ropen - depthStart : Ropen + depthStart;      // 권선 시작 반경
  const Rbottom = outer ? Ropen - G.slotDepth : Ropen + G.slotDepth;   // 슬롯 바닥 반경(=Rsb)
  let linedLen = 0; // 라이너가 깔리는 둘레: 치선단 코너(A3)부터 반대쪽 A3까지
  for (let i = 2; i < slotPath.length - 3; i++)
    linedLen += Math.hypot(slotPath[i + 1][0] - slotPath[i][0], slotPath[i + 1][1] - slotPath[i][1]);
  out.linerArea = linedLen * W.linerThk;
  out.wedgeArea = W.wedgeModel === "wedge" ? (G.slotOpening + 1.25) * W.wedgeDepth : 0; // 사다리꼴 평균폭 (뷰어 형상과 동일)
  out.windingDepth = Math.max(G.slotDepth - depthStart, 0);           // = slotDepth−toothTip−wedge+tipChord (음수 방어)
  out.dividerArea = W.coilDivider * out.windingDepth;
  out.windingAreaLiner = slotA - out.wedgeArea - out.dividerArea;
  out.windingArea = out.windingAreaLiner - out.linerArea;
  out.coveredWireArea = out.condPerSlot * wireA;
  out.copperArea = out.condPerSlot * cuA;
  out.impregArea = out.windingArea - out.coveredWireArea;
  out.wireFillWdg = out.windingArea > 0 ? out.coveredWireArea / out.windingArea : 0;
  out.heavyBuildFill = out.windingArea > 0 ? out.condPerSlot * W.wireDia ** 2 / out.windingArea : 0;
  out.ewdgMLT = out.MLT - 2 * G.stackLength;

  // 동선 체적 / 엔드와인딩 충전율 (근사: 권선환형 × 반타원 오버행)
  out.volCuActive = out.turnCSA * 2 * G.stackLength * NphTotal * 3;      // mm³
  out.volCuEwdg = out.turnCSA * out.ewdgMLT * NphTotal * 3 / 2;          // mm³ (편측)
  const rOuterW = Math.max(Rstart, Rbottom) - W.linerThk, rInnerW = Math.min(Rstart, Rbottom) + W.linerThk;
  const ewdgRegion = Math.PI * (rOuterW ** 2 - rInnerW ** 2) * (Math.PI * out.coilPitch / 4);
  out.ewdgFill = ewdgRegion > 0 ? out.volCuEwdg * (W.wireDia / W.copperDia) ** 2 / ewdgRegion : 0;

  // 자속밀도 (FSCW 보정)
  // 치·요크 자속밀도 — FEMM 보정 시 FEMM 측정값 사용(철손이 FEMM 기반이 됨), 아니면 해석식.
  const BtAnalytic = C.cT * Bgpk * taus / G.toothWidth;
  const byDepth = Ry1 - Ry0;   // 요크 반경깊이(토폴로지 무관: 슬롯반대편)
  out.byDepth = byDepth;
  const ByAnalytic = Math.min(BtAnalytic * G.toothWidth / (2 * Math.max(byDepth, 0.1)), 2.5);   // 백아이언 깊이≤0 가드 + 포화 상한 2.5T(퇴화 요크서 By 폭발→Pfe∝By² 과대 방지)
  out.Bt = (cal && Number.isFinite(cal.Bt)) ? cal.Bt : BtAnalytic;
  out.By = (cal && Number.isFinite(cal.By)) ? cal.By : ByAnalytic;

  // 중량
  const Lstk = G.stackLength;
  const rhoFe = stl.density * 1e-9, rhoMag = mag.density * 1e-9;
  const toothArea = Math.PI * (Rt1 ** 2 - Rt0 ** 2) - Ns * slotA;
  const byArea = Math.PI * (Ry1 ** 2 - Ry0 ** 2);
  out.mTooth = toothArea * Lstk * rhoFe;
  out.mBy = byArea * Lstk * rhoFe;
  out.mStator = out.mTooth + out.mBy;
  // 자석/회전자 반경 (외전형은 자석이 스테이터 바깥, 백아이언이 자석 바깥 캔)
  const magAg = outer ? Rag + g + G.bandingThickness : Rag - g - G.bandingThickness;  // 자석 공극면
  const magBack = outer ? magAg + lm : magAg - lm;                                      // 자석 반대면
  const RoM = magAg, RiM = magBack;
  out.mRotor = outer
    ? Math.PI * ((magBack + (G.rotorYoke || 0)) ** 2 - magBack ** 2) * G.rotorLamLength * rhoFe   // 외전형 백아이언 캔
    : Math.PI * (magBack ** 2 - (G.shaftDia / 2) ** 2) * G.rotorLamLength * rhoFe;                 // 내전형 로터코어
  // 자석 질량 — 실제 그려지는 빵덩어리(면취) 단면적(shoelace)으로 계산해 형상과 일치.
  // magnetReduction(면취량)이 형상·질량 양쪽에 일관 반영됨. (REF 0.1428 은 MC 자석모델 차이)
  const magArea = Math.abs(shoelace(buildMagnetPath(G)));   // mm² (1극 자석 단면)
  out.mMagnet = poles * magArea * G.magnetLength * rhoMag;
  out.mCopper = out.turnCSA * 1e-6 * (out.MLT * 1e-3 * NphTotal) * 3 * 8933;
  out.mActive = out.mStator + out.mRotor + out.mMagnet + out.mCopper;

  // AC 동손 (근접효과 근사, fe² 스케일) — cAC로 kro80 FEA 캘리브레이션. 슬롯 깊이방향 층수 기반.
  const deltaSkin = Math.sqrt(rho / (Math.PI * Math.max(fe, 1e-6) * MU0));            // 표피깊이 [m] (fe=0→Infinity 방어)
  const xiAC = (W.copperDia * 1e-3) / deltaSkin;                     // 환산높이 ξ = d/δ
  const mLayer = Math.max(1, Math.round(out.windingDepth / W.wireDia)); // 슬롯깊이 방향 도체 층수
  const cAC = Number.isFinite(C.cAC) ? C.cAC : 1;                    // 빈칸/미정의 방어
  out.RacRdc = 1 + cAC * (((mLayer * mLayer - 1) / 3) * (xiAC ** 4 / 3) + (4 / 45) * xiAC ** 4);
  out.PcuAC = out.Pcu * out.RacRdc;        // 총 동손(AC 포함)
  out.PcuAddl = out.Pcu * (out.RacRdc - 1); // AC 추가분

  // 철손 / 효율 — cFe: 단순 Steinmetz(peak-B²)는 고B·후막 적층서 FEA/실측 대비 과대 → 모터별 보정(기본 1).
  const cFe = (cal && Number.isFinite(cal.cFe)) ? cal.cFe : (Number.isFinite(C.cFe) ? C.cFe : 1);  // FEMM 철손적분 보정 우선
  out.Pfe = cFe * (stl.kh * fe + stl.ke * fe ** 2) * (out.mTooth * out.Bt ** 2 + out.mBy * out.By ** 2);
  const wm = C.speed * 2 * Math.PI / 60;
  out.Pem = out.torque * wm;
  out.Pin = out.Pem + out.PcuAC;
  out.Pout = out.Pem - out.Pfe - C.otherLoss;
  out.Tshaft = wm > 0 ? out.Pout / wm : 0;
  // 효율: 입력·출력 모두 양(+)일 때만 의미. 손실>Pem(저속고손실)·회생영역은 0으로(음수/100%↑ 비표시).
  out.eff = (out.Pin > 0 && out.Pout > 0) ? Math.min((out.Pout / out.Pin) * 100, 100) : 0;
  out.TRV = out.torque / (Math.PI * RoM ** 2 * Lstk * 1e-9) / 1000; // kNm/m³
  out.rotorPeriphV = wm * RoM * 1e-3;                          // 회전자 외주 선속도 [m/s]

  // 전압/무부하속도 (정현 구동, SVPWM 가정)
  const VphAvail = W.connection === "delta" ? C.Vdc : C.Vdc / Math.sqrt(3);
  out.noLoadSpeed = lam > 1e-9 ? (VphAvail / (2 * Math.PI * lam)) * 60 / pp : 0; // lam≈0(퇴화권선) Infinity 방어

  // 인덕턴스 (참고 추정치 — 보정계수 포함)
  const geff = (kc * g + lm / mag.mur) * 1e-3;
  const Lm = C.cL * (3 / Math.PI) * MU0 * (kw1 * NphSeries) ** 2 * ((D / 2) * 1e-3 * L) / (pp ** 2 * geff);
  const hs = G.slotDepth - G.toothTipDepth, ws = slotWMid;
  const pSlot = MU0 * (G.stackLength * 1e-3) * (hs / (3 * ws) + G.toothTipDepth / G.slotOpening);
  const Lslot = C.cLs * (4 * 3 / Ns) * NphSeries ** 2 * pSlot / W.parallelPaths;
  const LdAnalytic = (Lm + Lslot) * 1e3, LqAnalytic = LdAnalytic * 1.09; // SPM: Lq 약간 큼(슬롯/포화)
  out.Ld = (cal && Number.isFinite(cal.Ld) && cal.Ld > 0) ? cal.Ld : LdAnalytic;  // FEMM 보정 시 FEA 인덕턴스
  out.Lq = (cal && Number.isFinite(cal.Lq) && cal.Lq > 0) ? cal.Lq : LqAnalytic;
  // 릴럭턴스 토크 보정(P1): adv≠0서 (Ld−Lq)·id·iq 항 — T-N곡선·효율맵과 동일식으로 운전점 토크 일치.
  // adv=0 → idPk=0 → Trel=0 → 무변경(검증된 400W/1250W·해석식 경로 byte-identical 보존).
  const Trel = 1.5 * pp * (out.Ld - out.Lq) * 1e-3 * idPk * iqPk * kT;
  if (Trel !== 0) {
    out.torque += Trel;
    out.Kt_phase = Iph > 0 ? out.torque / Iph : 0;
    out.KtLine = C.IlineRms > 0 ? out.torque / (C.IlineRms * Math.SQRT2) : 0;
    out.Pem = out.torque * wm;
    out.Pin = out.Pem + out.PcuAC;
    out.Pout = out.Pem - out.Pfe - C.otherLoss;
    out.Tshaft = wm > 0 ? out.Pout / wm : 0;
    out.eff = (out.Pin > 0 && out.Pout > 0) ? Math.min((out.Pout / out.Pin) * 100, 100) : 0;
    out.TRV = out.torque / (Math.PI * RoM ** 2 * Lstk * 1e-9) / 1000;
  }

  // ── ini_pos: 부하 시 역기전력(전기자반작용 포함) zero-cross 상승점이 0°가 되는 회전자 위치 ──
  // 무부하 기준: U상 자기축 ψ0=arg(Σ turns_U·e^{j·pp·φ}); 상승영점 ppδ=ψ0+90°.
  // 부하 시: 총 쇄교자속 λ_s=(λd,λq)=(λ_PM+Ld·id, Lq·iq) 가 d축 대비 부하각 δL=atan2(λq,λd) 만큼
  //          회전 → 부하 역기전력도 δL 만큼 앞섬 → 상승영점 회전자위치가 δL/pp 만큼 당겨짐.
  {
    let reS = 0, imS = 0;
    for (let i = 0; i < Ns; i++) {
      const phi = (G.statorRot + (i * 360) / Ns) * D2R;
      reS += wa.table[i][0] * Math.cos(pp * phi);
      imS += wa.table[i][0] * Math.sin(pp * phi);
    }
    const psi0 = Math.atan2(imS, reS);
    const lamD = lam + out.Ld * 1e-3 * idPk, lamQ = out.Lq * 1e-3 * iqPk;   // 단일소스 idPk/iqPk 사용(P2)
    const dL = Math.atan2(lamQ, lamD);                        // 부하각(전기) [rad]
    out.loadAngle = dL / D2R;                                 // 부하각 [elec deg]
    out.lamD_load = lamD; out.lamQ_load = lamQ;               // 부하 dq 쇄교자속 [Wb] (Motor-CAD Flux Linkage D/Q on load)
    const per = 360 / pp;
    const nl = (((psi0 + Math.PI / 2) / pp / D2R) % per + per) % per;   // 무부하 상승영점 [mech deg]
    out.iniPosNL = nl;
    let ld = ((psi0 + Math.PI / 2 - dL) / pp / D2R % per + per) % per;  // 부하 상승영점 [mech deg]
    out.iniPos = ld;                                          // 부하 기준 ini_pos [mech deg]
    out.iniPosE = ((ld * pp) % 360 + 360) % 360;             // 전기각 [deg]
  }

  // 파생량 (Motor-CAD Output Data 항목)
  out.Km = (out.Pcu > 0 && out.torque > 0) ? out.torque / Math.sqrt(out.Pcu) : 0;
  out.Te = out.Rphase > 0 ? (out.Lq * 1e-3 / out.Rphase) * 1e3 : 0; // Rphase=0(턴/도선 0) Infinity 방어
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcmSP = (Ns > 0 && poles > 0) ? (Ns * poles) / gcd(Ns, poles) : 0;
  out.coggingPeriod = lcmSP > 0 ? 360 / lcmSP : 0;   // poles/Ns=0(편집 중) → Infinity 누출 방어
  out.coggingFreq = (lcmSP * C.speed) / 60;
  out.optSkew = out.coggingPeriod;                            // 최적 스큐각[기계도] ≈ 코깅 1주기(슬롯고조파 상쇄)
  const RoMm = RoM * 1e-3, RiMm = RiM * 1e-3, Rshm = (G.shaftDia / 2) * 1e-3;
  out.Jrotor = 0.5 * out.mRotor * (RiMm ** 2 + Rshm ** 2) + 0.5 * out.mMagnet * (RoMm ** 2 + RiMm ** 2);
  const we = 2 * Math.PI * fe;
  // 단자전압·역률 — 진각(phaseAdv)을 반영한 정식 dq 정상상태식.
  // lam=피크 쇄교자속, IphPk=피크 상전류. 진각>0 → id<0(약계자). adv=0이면 기존식과 동일.
  const LdH = out.Ld * 1e-3, LqH = out.Lq * 1e-3;   // adv·idPk·iqPk는 위에서 단일소스로 정의(P2)
  const VdPk = out.Rphase * idPk - we * LqH * iqPk;
  const VqPk = out.Rphase * iqPk + we * (LdH * idPk + lam);
  out.Vterm = Math.hypot(VdPk, VqPk) / Math.SQRT2;     // rms 상단자전압
  out.PF = Math.cos(Math.atan2(VdPk, VqPk) - Math.atan2(idPk, iqPk));
  out.VsupplyRms = C.Vdc / Math.SQRT2;
  out.Istall = C.Vdc / out.RlineLine;
  out.Tstall = out.KtLine * out.Istall;
  out.numLam = G.magneticLength / (stl.thk || 0.5);
  const S_fe = out.mTooth * out.Bt ** 2 + out.mBy * out.By ** 2;
  out.PfeHyst = cFe * stl.kh * fe * S_fe;
  out.PfeEddy = cFe * stl.ke * fe ** 2 * S_fe;
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
  airgap: 0.5, bandingThickness: 0, shaftDia: 62, statorRot: 0, rotorRot: 0, slotBottomShape: "arc",
  rotorType: "inner", rotorYoke: 0,
  stackLength: 30, magnetLength: 30, rotorLamLength: 30, magneticLength: 27.9, motorLength: 70,
};
const WIND0 = {
  turnsPerCoil: 12, throw: 1, parallelPaths: 1, wireDia: 0.5, copperDia: 0.45,
  strands: 17, connection: "delta", linerThk: 0.5, coilDivider: 0.5,
  wedgeDepth: 1.0, condSep: 0.02, wedgeModel: "wedge",
};
const MAT0 = { steel: "20PNX1200F", magnet: "N45UH", Br20: 1.32, tcBr: -0.12, mur: 1.05, kh: 0.0212, ke: 4.157e-5 };
const CALC0 = { speed: 3200, Vdc: 48, IlineRms: 24.8, phaseAdv: 0, Tcu: 80, Tmag: 80, klk: 0.97, cT: 0.56, cL: 2.6, cLs: 0.33, cAC: 1.0, cFe: 1.0, otherLoss: 6.7, currentDef: "rms", magnetisation: "parallel", driveMode: "sine" };

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
  <tr style={{ borderTop: `1px solid ${UI.border}`, background: hl ? "rgba(52,211,232,0.07)" : undefined }}>
    <td className="px-2 py-1 text-xs" style={{ color: UI.text }}>{label}</td>
    <td className="px-2 py-1 text-xs text-right font-semibold" style={{ fontFamily: UI.mono, color: hl ? UI.cyan : UI.head }}>{value}</td>
    <td className="px-2 py-1 text-xs" style={{ color: UI.faint }}>{unit || ""}</td>
    {refv !== undefined && (
      <td className="px-2 py-1 text-xs text-right" style={{ color: UI.green, fontFamily: UI.mono }}>{refv}</td>
    )}
  </tr>
);

const NumIn = ({ label, value, onChange, step = 0.01, w = "w-20" }) => (
  <div className="flex items-center justify-between gap-1 px-2 py-1" style={{ borderTop: `1px solid ${UI.border}` }}>
    <span className="text-xs whitespace-nowrap" style={{ color: UI.label }}>{label}</span>
    <input type="number" step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className={`${w} text-right text-xs px-1.5 py-0.5 rounded outline-none`}
      style={{ border: `1px solid ${UI.border}`, background: UI.inset, color: UI.head, fontFamily: UI.mono }}
      onFocus={(e) => (e.target.style.borderColor = UI.cyan)}
      onBlur={(e) => (e.target.style.borderColor = UI.border)} />
  </div>
);
const Radio = ({ group, val, label, cur, onPick, disabled }) => {
  const on = cur === val;
  return (
    <label className={"flex items-center gap-2 text-xs py-1 px-2 rounded " + (disabled ? "opacity-40" : "cursor-pointer")}
      onClick={() => !disabled && onPick(val)}
      style={{ color: on ? UI.head : UI.label, background: on ? "rgba(52,211,232,0.08)" : "transparent" }}>
      <span style={{ width: 11, height: 11, borderRadius: "50%", flexShrink: 0, border: `1.5px solid ${on ? UI.cyan : UI.faint}`, boxShadow: on ? `inset 0 0 0 2.5px ${UI.cyan}` : "none", background: UI.inset }} />
      {label}
    </label>
  );
};
const SectionHead = ({ color, children }) => (
  <div className="px-3 py-1.5 text-xs font-semibold" style={{ background: UI.panel2, borderLeft: `3px solid ${color}`, color: UI.head, letterSpacing: "0.06em", borderTopRightRadius: 6 }}>{children}</div>
);
// 입력 패널 박스 — 모듈 레벨 필수(내부 정의 시 매 렌더 새 타입→input 포커스 풀림). Panel 래퍼 사용.
const Box = ({ title, children }) => (
  <div className="mb-2.5"><Panel title={title} bodyClass="-mx-1">{children}</Panel></div>
);
// 강판 선택 드롭다운 (Materials 탭). 동일 이유로 모듈 레벨.
const SteelSel = ({ value, onPick }) => (
  <select value={value} onChange={(e) => onPick(e.target.value)} className="text-xs px-1.5 py-1 rounded w-32 outline-none"
    style={{ border: `1px solid ${UI.border}`, background: UI.inset, color: UI.head, fontFamily: UI.mono }}>
    {Object.keys(STEELS).map((k) => <option key={k} style={{ background: UI.panel }}>{k}</option>)}
  </select>
);

// 열등가회로 기본값 (집중정수, 정상상태). hConv: 자연대류 기본 10 W/m²K. housing 0 = 형상에서 자동.
const THERM0 = {
  ambient: 25, coolType: "natural", hConv: 10, hContact: 1000,
  housingDia: 0, housingLen: 0, kLiner: 0.2, kImpreg: 0.25, kSteel: 25,
};
const COOL_H = { natural: 10, forced: 60, conduction: 200 };

// ─── FEMM Lua 스크립트 생성 (2D 자기정적) — 진짜 FEA를 무료 FEMM에서 실행 ───
function femmLua(geo, wind, calc, res) {
  const Ns = geo.slotNumber, poles = geo.poleNumber;
  const Rlam = geo.statorLamDia / 2, Rb = geo.statorBore / 2;
  const Rro = (geo.statorBore - 2 * geo.airgap) / 2, Rsh = geo.shaftDia / 2;
  const Rmi = Rro - geo.magnetThickness, Rd = Rb + geo.slotDepth;
  const depth = geo.stackLength;
  const mu0 = 4 * Math.PI * 1e-7, murMag = 1.05;
  const Hc = (res.Br_used || 1.2) / (mu0 * murMag);
  const Ip = res.IphRms * Math.SQRT2;                     // 상전류 피크
  const ia = Ip, ib = -Ip / 2, ic = -Ip / 2;             // A상 피크 순간
  const tbl = res.wa.table, slotA = Math.max(res.slotArea * 1e-6, 1e-9);
  const rot = (pts, a) => { const c = Math.cos(a), s = Math.sin(a); return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]); };
  const sp = buildSlotPath(geo), mp = buildMagnetPath(geo);
  const f = (v) => v.toFixed(3);
  const L = ["-- Mini Motor-CAD → FEMM 자동생성 (2D 자기정적). FEMM에서 File>Open Lua Script로 실행.",
    "showconsole(); newdocument(0)",
    `mi_probdef(0,'millimeters','planar',1e-8,${depth.toFixed(2)},30)`,
    "mi_getmaterial('Air'); mi_getmaterial('M-19 Steel'); mi_getmaterial('Pure Iron')",
    `mi_addmaterial('PM',${murMag},${murMag},${Hc.toFixed(0)},0,0,0,0,1,0,0,0,0,0)`];
  const seg = (pr) => { for (let k = 0; k < pr.length; k++) { const a = pr[k], b = pr[(k + 1) % pr.length]; L.push(`mi_addsegment(${f(a[0])},${f(a[1])},${f(b[0])},${f(b[1])})`); } };
  const arc = (R) => { L.push(`mi_addarc(${f(R)},0,${f(-R)},0,180,5)`, `mi_addarc(${f(-R)},0,${f(R)},0,180,5)`); };
  // 형상: 원(라미OD·보어·로터OD·로터철심OD·샤프트) + 슬롯 + 자석
  arc(Rlam); arc(Rb); arc(Rro); arc(Rmi); arc(Rsh);
  for (let i = 0; i < Ns; i++) seg(rot(sp, geo.statorRot * D2R + i * 2 * Math.PI / Ns));
  for (let k = 0; k < poles; k++) seg(rot(mp, geo.rotorRot * D2R + k * 2 * Math.PI / poles));
  // 블록 라벨
  const label = (x, y, mat, magdir, group, extra) => L.push(`mi_addblocklabel(${f(x)},${f(y)})`, `mi_selectlabel(${f(x)},${f(y)})`,
    `mi_setblockprop('${mat}',1,0,'<None>',${magdir},${group},0)`, "mi_clearselected()", ...(extra ? [extra] : []));
  label(0, (Rd + Rlam) / 2, "M-19 Steel", 0, 0);                 // 스테이터 백아이언
  label((Rsh + Rmi) / 2, 0, "M-19 Steel", 0, 1);                 // 로터 철심 (group1=회전자)
  label(Rsh / 2, 0, "Air", 0, 1);                                // 샤프트(비자성 가정)
  label((Rro + Rb) / 2, 0, "Air", 0, 0);                         // 에어갭
  // 슬롯 코일: 슬롯별 정전류밀도 J [MA/m²]
  for (let i = 0; i < Ns; i++) {
    const netAT = (tbl[i][0] * ia + tbl[i][1] * ib + tbl[i][2] * ic) / (wind.parallelPaths || 1);   // P4: 병렬회로수로 도체당 전류 환산(femm_server와 일치, P=1이면 무변경)
    const J = netAT / slotA / 1e6;
    L.push(`mi_addmaterial('Coil${i}',1,1,0,${J.toFixed(5)},0,0,0,1,0,0,0,0,0)`);
    const a = geo.statorRot * D2R + i * 2 * Math.PI / Ns, rr = Rb + 0.45 * geo.slotDepth;
    label(rr * Math.cos(a), rr * Math.sin(a), `Coil${i}`, 0, 0);
  }
  // 자석: 극마다 자화방향(반경, N/S 교번)
  for (let k = 0; k < poles; k++) {
    const a = geo.rotorRot * D2R + k * 2 * Math.PI / poles, rr = (Rro + Rmi) / 2;
    const magdir = (a / D2R) + (k % 2 ? 180 : 0);               // 교번 극성
    L.push(`mi_addblocklabel(${f(rr * Math.cos(a))},${f(rr * Math.sin(a))})`, `mi_selectlabel(${f(rr * Math.cos(a))},${f(rr * Math.sin(a))})`,
      `mi_setblockprop('PM',1,0,'<None>',${magdir.toFixed(2)},1,0)`, "mi_clearselected()");
  }
  // 경계조건 + 해석
  L.push(`mi_makeABC(7,${f(Rlam * 1.25)},0,0,0)`, "mi_zoomnatural()", "mi_saveas('mini_motorcad.fem')",
    "mi_createmesh()", "mi_analyze(0)", "mi_loadsolution()",
    "-- 토크(회전자 group1, 가중응력텐서)", "mo_clearblock(); mo_groupselectblock(1)",
    "print('Torque [Nm] =', mo_blockintegral(22))", "mo_clearblock()",
    "mo_showdensityplot(1,0,2.0,0,'mag')   -- 자속밀도 컬러맵",
    `-- 운전점: A상 피크 ia=${ia.toFixed(2)} ib=ic=${ib.toFixed(2)} A (피크), 적층 ${depth}mm`);
  return L.join("\n");
}

// ─── Self-Check 탭 (자동 검증: 참조 대조·물리 타당성·FEA 교차검증) ─────
function SelfCheckTab({ res, calc, femmCal, solved }) {
  if (!res || !solved) return <div className="p-6 text-sm" style={{ color: UI.label }}>해석 결과 없음 — Calculation 탭에서 Solve 하세요.</div>;
  const dev = (c, r) => (r ? ((c - r) / r) * 100 : 0);
  const devColor = (d) => (Math.abs(d) < 2 ? UI.green : Math.abs(d) < 8 ? UI.amber : UI.red);
  const refRows = [
    ["평균 토크", res.torque, REF.torque, "Nm"],
    ["역기전력 상수 Ke", res.Ke, REF.Ke, "V·s/rad"],
    ["쇄교자속 λ", res.lambda, REF.lambda, "Wb"],
    ["역기전력 피크", res.Epk, REF.Epk, "V"],
    ["상저항 Rphase", res.Rphase, REF.Rphase, "Ω"],
    ["동손 Pcu", res.Pcu, REF.Pcu, "W"],
    ["철손 Pfe", res.Pfe, REF.Pfe, "W"],
    ["효율", res.eff, REF.eff, "%"],
    ["치 자속 Bt", res.Bt, REF.Bt, "T"],
    ["요크 자속 By", res.By, REF.By, "T"],
    ["권선계수 kw1", res.kw1, REF.kw1, ""],
    ["전류밀도 Jrms", res.Jrms, REF.Jrms, "A/mm²"],
  ].map((r) => ({ ...r, d: dev(r[1], r[2]) }));
  const refWorst = Math.max(...refRows.map((r) => Math.abs(r.d)));
  // 물리 타당성 (pass/warn)
  const finite = [res.torque, res.eff, res.Ke, res.Rphase, res.lambda].every(Number.isFinite);
  const pbal = Math.abs(res.Pin - (res.Pout + res.PcuAC + res.Pfe + calc.otherLoss));
  const phys = [
    ["효율 범위 0~100%", res.eff > 0 && res.eff < 100, res.eff.toFixed(1) + " %"],
    ["치 자속 포화 여유 (Bt<2.2T)", res.Bt < 2.2, res.Bt.toFixed(2) + " T"],
    ["요크 자속 포화 여유 (By<2.0T)", res.By < 2.0, res.By.toFixed(2) + " T"],
    ["전류밀도 (Jrms<12 A/mm²)", res.Jrms < 12, res.Jrms.toFixed(2) + " A/mm²"],
    ["나동선 점적률 (<55%)", res.cuSlotFill < 0.55, (res.cuSlotFill * 100).toFixed(1) + " %"],
    ["운전속도 < 무부하속도", calc.speed < res.noLoadSpeed, Math.round(calc.speed) + " / " + Math.round(res.noLoadSpeed) + " rpm"],
    ["권선 3상 균형", res.wa ? res.wa.balanced !== false : true, res.wa && res.wa.coilsPerPhaseAll ? res.wa.coilsPerPhaseAll.join("/") : "—"],
    ["전력수지 일관 (Pin=Pout+손실)", pbal < 0.5, pbal.toFixed(3) + " W"],
    ["핵심값 유한 (NaN 없음)", finite, finite ? "OK" : "NaN!"],
  ];
  const physWarn = phys.filter((p) => !p[1]).length;
  // FEA 교차검증 (FEMM 보정값 있을 때)
  const fea = femmCal ? [
    ["FEMM Ke", femmCal.ke, REF.Ke, "V·s/rad"],
    ["FEMM 토크", femmCal.torqueFea, REF.torque, "Nm"],
    ...(Number.isFinite(femmCal.Bt) ? [["FEMM 치 자속 Bt", femmCal.Bt, REF.Bt, "T"]] : []),
  ].map((r) => ({ ...r, d: dev(r[1], r[2]) })) : null;
  const dot = (c) => <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: c, boxShadow: `0 0 6px ${c}aa` }} />;
  const overall = refWorst < 8 && physWarn === 0 ? UI.green : refWorst < 15 && physWarn <= 1 ? UI.amber : UI.red;
  return (
    <div className="h-full overflow-auto p-3 flex flex-wrap gap-3 items-start" style={{ alignContent: "flex-start" }}>
      <div className="w-full rounded p-3 flex items-center gap-3" style={{ background: UI.panel, border: `1px solid ${overall}66`, boxShadow: `0 0 14px ${overall}22` }}>
        {dot(overall)}
        <span style={{ color: UI.head, fontWeight: 700, letterSpacing: "0.04em" }}>
          SELF-CHECK {overall === UI.green ? "정상" : overall === UI.amber ? "주의" : "경고"}
        </span>
        <span className="text-xs" style={{ color: UI.label }}>참조 최대편차 {refWorst.toFixed(1)}% · 물리 경고 {physWarn}건{femmCal ? " · FEA 보정 적용중" : ""}</span>
      </div>

      <div className="flex-1 min-w-80">
        <Panel title="참조값(1250W Motor-CAD) 대조">
          <table className="w-full text-xs"><tbody>
            <tr style={{ color: UI.faint }}><td className="px-2 py-1">항목</td><td className="px-2 py-1 text-right">계산</td><td className="px-2 py-1 text-right">참조</td><td className="px-2 py-1 text-right">편차</td><td className="px-2 py-1 text-center">상태</td></tr>
            {refRows.map((r) => (
              <tr key={r[0]} style={{ borderTop: `1px solid ${UI.border}` }}>
                <td className="px-2 py-1" style={{ color: UI.text }}>{r[0]}</td>
                <td className="px-2 py-1 text-right" style={{ fontFamily: UI.mono, color: UI.head }}>{(+r[1]).toFixed(4)}</td>
                <td className="px-2 py-1 text-right" style={{ fontFamily: UI.mono, color: UI.label }}>{r[2]}{r[3] && <span style={{ color: UI.faint }}> {r[3]}</span>}</td>
                <td className="px-2 py-1 text-right" style={{ fontFamily: UI.mono, color: devColor(r.d) }}>{r.d >= 0 ? "+" : ""}{r.d.toFixed(1)}%</td>
                <td className="px-2 py-1 text-center">{dot(devColor(r.d))}</td>
              </tr>
            ))}
          </tbody></table>
          <div className="px-2 py-1.5 text-xs" style={{ color: UI.faint }}>초록 &lt;2% · 주황 &lt;8% · 빨강 ≥8%. 입력을 바꿔 편차가 커지면 즉시 표시됩니다.</div>
        </Panel>
      </div>

      <div className="flex-1 min-w-72">
        <Panel title="물리 타당성">
          <table className="w-full text-xs"><tbody>
            {phys.map((p) => (
              <tr key={p[0]} style={{ borderTop: `1px solid ${UI.border}` }}>
                <td className="px-2 py-1.5 text-center" style={{ width: 24 }}>{dot(p[1] ? UI.green : UI.red)}</td>
                <td className="px-2 py-1.5" style={{ color: UI.text }}>{p[0]}</td>
                <td className="px-2 py-1.5 text-right" style={{ fontFamily: UI.mono, color: p[1] ? UI.label : UI.red }}>{p[2]}</td>
              </tr>
            ))}
          </tbody></table>
        </Panel>
        {fea && (
          <div className="mt-2.5"><Panel title="FEA 교차검증 (FEMM ↔ 참조)" accent={UI.green}>
            <table className="w-full text-xs"><tbody>
              {fea.map((r) => (
                <tr key={r[0]} style={{ borderTop: `1px solid ${UI.border}` }}>
                  <td className="px-2 py-1" style={{ color: UI.text }}>{r[0]}</td>
                  <td className="px-2 py-1 text-right" style={{ fontFamily: UI.mono, color: UI.head }}>{(+r[1]).toFixed(4)}</td>
                  <td className="px-2 py-1 text-right" style={{ fontFamily: UI.mono, color: UI.label }}>{r[2]}</td>
                  <td className="px-2 py-1 text-right" style={{ fontFamily: UI.mono, color: devColor(r.d) }}>{r.d >= 0 ? "+" : ""}{r.d.toFixed(1)}%</td>
                  <td className="px-2 py-1 text-center">{dot(devColor(r.d))}</td>
                </tr>
              ))}
            </tbody></table>
            <div className="px-2 py-1.5 text-xs" style={{ color: UI.faint }}>FEMM 해석 후 "보정 적용"하면 표시됩니다 (독립 FEA가 참조와 일치하는지).</div>
          </Panel></div>
        )}
      </div>
    </div>
  );
}

export default function MiniMotorCad() {
  const [tab, setTab] = useState("geometry");
  const [geo, setGeo] = useState(GEO0);
  const [wind, setWind] = useState(WIND0);
  const [mat, setMat] = useState(MAT0);
  const [calc, setCalc] = useState(CALC0);
  const [therm, setTherm] = useState(THERM0);
  const [showRef, setShowRef] = useState(true);
  // FEMM 보정: {lam, ke, source} — 적용 시 해석식 λ를 FEMM값으로 고정 → 모든 λ의존 결과가 FEMM 기반.
  const [femmCal, setFemmCal] = useState(null);

  // 입력 도중(빈 칸→0 등) NaN/Infinity가 나오면 마지막 유효 결과를 유지
  const rawRes = useMemo(() => {
    try {
      const r = compute(geo, wind, mat, calc, femmCal);
      return ["torque", "Rphase", "slotArea", "eff", "kw1", "Jrotor", "PF"].every((k) => isFinite(r[k])) ? r : null;
    } catch (e) { return null; }
  }, [geo, wind, mat, calc, femmCal]);
  const lastResRef = useRef(null);
  if (rawRes) lastResRef.current = rawRes;
  const res = rawRes || lastResRef.current;
  const stale = !rawRes && !!res;

  // E-Magnetic 결과는 Solve를 눌러야 표시 (Motor-CAD 흐름). 입력 변경 시 무효화.
  const [solved, setSolved] = useState(false);
  useEffect(() => { setSolved(false); }, [geo, wind, mat, calc]);
  // 자기설계(형상·권선·재질)가 바뀌면 FEMM 보정은 무효 (운전점 calc 변경은 λ에 무관하므로 유지)
  useEffect(() => { setFemmCal(null); }, [geo, wind, mat]);

  const sG = (k, v) => setGeo((p) => ({ ...p, [k]: v }));
  const sW = (k, v) => setWind((p) => ({ ...p, [k]: v }));
  const sM = (k, v) => setMat((p) => ({ ...p, [k]: v }));
  const sC = (k, v) => setCalc((p) => ({ ...p, [k]: v }));
  const sT = (k, v) => setTherm((p) => ({ ...p, [k]: v }));

  const exportAll = () => {
    const data = { geometry: geo, winding: wind, materials: mat, calculation: calc, results: res };
    const blob = new Blob([JSON.stringify(data, (k, v) => (k === "wa" ? undefined : v), 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "motor_design.json"; a.click();
  };
  const exportFemm = () => {
    if (!res) { alert("결과 없음 — 입력 확인"); return; }
    const blob = new Blob([femmLua(geo, wind, calc, res)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "mini_motorcad_femm.lua"; a.click();
  };
  // CSV 다운로드 (UTF-8 BOM — Excel에서 한글/°·² 깨짐 방지)
  const downloadCsv = (name, text) => {
    const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
  };
  const exportSpecCsv = () => {
    if (!res) { alert("결과 없음 — 입력 확인"); return; }
    const keRpm = calc.speed > 0 ? res.Erms / (calc.speed / 1000) : 0;   // Vrms/krpm (상)
    const rows = [
      ["Pole pairs", res.pp, ""],
      ["Slots", geo.slotNumber, ""],
      ["Rated voltage", calc.Vdc, "V"],
      ["Rated current", res.IlineRms.toFixed(2), "Arms"],
      ["Phase resistance", res.Rphase.toFixed(4), "Ohm"],
      ["Phase inductance", ((res.Ld + res.Lq) / 2).toFixed(4), "mH"],
      ["Torque constant Kt", res.Kt_phase.toFixed(4), "Nm/Arms"],
      ["Back-EMF constant", keRpm.toFixed(3), "Vrms/krpm"],
      ["Slot fill factor", (res.wireSlotFill * 100).toFixed(1), "%"],
      ["Rated speed", calc.speed, "rpm"],
      ["Rated torque", res.torque.toFixed(3), "Nm"],
      ["Peak torque", (res.torque * 1.6).toFixed(3), "Nm"],
      ["Max speed", Math.round(res.noLoadSpeed), "rpm"],
      ["Output power", res.Pout.toFixed(1), "W"],
      ["Efficiency", res.eff.toFixed(2), "%"],
      ["Power factor", res.PF.toFixed(3), ""],
      ["Outer diameter", geo.statorLamDia, "mm"],
      ["Stack length", geo.stackLength, "mm"],
      ["Weight", res.mActive.toFixed(3), "kg"],
      ["Rotor inertia", (res.Jrotor * 1e4).toFixed(3), "kg·cm²"],
      ["Shaft diameter", geo.shaftDia, "mm"],
      ["Insulation class", "", ""],
      ["Protection", "", ""],
      ["Max winding temp", calc.Tcu, "°C"],
      ["Ambient temperature", therm.ambient, "°C"],
    ];
    const csv = "parameter,value,unit\n" + rows.map((r) => r.join(",")).join("\n") + "\n";
    downloadCsv("motor_spec.csv", csv);
  };
  const exportTNCsv = () => {
    if (!res) { alert("결과 없음 — 입력 확인"); return; }
    const pp = res.pp, lamF = res.lambda, Rf = res.Rphase;
    const LdF = res.Ld * 1e-3, LqF = res.Lq * 1e-3, kT = res.kTsat || 1;
    const Vmax = (res.noLoadSpeed * 2 * Math.PI * res.Ke) / 60;
    const Imax = res.IphRms * Math.SQRT2;
    const maxTorqueAt = (n, Im) => {            // GraphsTab 와 동일한 전류원+전압타원 제약 MTPA
      const wm = (n * 2 * Math.PI) / 60, we = pp * wm;
      let best = 0;
      for (let k = 0; k < 121; k++) {
        const id = -Im * (k / 120);
        const iqCur = Math.sqrt(Math.max(Im * Im - id * id, 0));
        const a = (we * LqF) ** 2 + Rf * Rf;
        const b = 2 * Rf * we * ((LdF - LqF) * id + lamF);
        const c = (Rf * id) ** 2 + (we * (LdF * id + lamF)) ** 2 - Vmax * Vmax;
        let iqVolt = Infinity;
        if (a > 1e-12) { const disc = b * b - 4 * a * c; iqVolt = disc < 0 ? 0 : Math.max(0, (-b + Math.sqrt(disc)) / (2 * a)); }
        const iq = Math.max(0, Math.min(iqCur, iqVolt));
        const T = 1.5 * pp * (lamF * iq + (LdF - LqF) * id * iq) * kT;
        if (T > best) best = T;
      }
      return best;
    };
    const speeds = Array.from({ length: 10 }, (_, i) => i * 500);   // 0..4500
    const lines = speeds.map((n) => [n, maxTorqueAt(n, Imax).toFixed(3), maxTorqueAt(n, Imax * 1.6).toFixed(3)].join(","));
    const csv = "speed_rpm,cont_torque_Nm,peak_torque_Nm\n" + lines.join("\n") + "\n";
    downloadCsv("tn_curve.csv", csv);
  };

  const TABS = [
    ["geometry", "Geometry"], ["winding", "Winding"], ["materials", "Materials"],
    ["calculation", "Calculation"], ["output", "Output Data"], ["graphs", "Graphs"], ["thermal", "Thermal"],
    ["selfcheck", "Self-Check"],
  ];

  return (
    <div className="h-screen flex flex-col" style={{ background: UI.bg, fontFamily: UI.ui, color: UI.text }}>
      {/* 헤더 + 탭 */}
      <div style={{ background: UI.panel2, borderBottom: `1px solid ${UI.border}`, boxShadow: "0 2px 12px rgba(0,0,0,0.4)" }}>
        <div className="flex items-center gap-3 px-4 pt-2.5">
          <span style={{ fontFamily: UI.logo, fontWeight: 700, fontSize: 16, letterSpacing: "0.04em", color: UI.head }}>
            MINI <span style={{ color: UI.cyan }}>MOTOR-CAD</span>
          </span>
          <span className="text-xs" style={{ color: UI.faint, letterSpacing: "0.1em" }}>PMSM DESIGN</span>
          {femmCal && <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ background: "rgba(43,212,122,0.15)", color: UI.green, border: `1px solid ${UI.green}55` }}>● FEMM 보정됨 (λ={femmCal.lam.toFixed(4)})</span>}
          {stale && <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ background: "rgba(255,93,108,0.15)", color: UI.red, border: `1px solid ${UI.red}55` }}>⚠ 입력값 비정상 — 마지막 유효 결과</span>}
          <div className="flex-1" />
          <label className="text-xs flex items-center gap-1.5" style={{ color: UI.label }}>
            <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} accentColor={UI.cyan} />
            Motor-CAD 참조값 표시
          </label>
          {[["사양표 CSV", exportSpecCsv], ["T-N CSV", exportTNCsv], ["FEMM 스크립트", exportFemm]].map(([t, fn]) => (
            <button key={t} onClick={fn} className="text-xs px-3 py-1 rounded font-medium mb-1"
              style={{ border: `1px solid ${UI.border}`, color: UI.cyan, background: UI.inset }}>{t}</button>
          ))}
          <button onClick={exportAll} className="text-xs px-3 py-1 rounded font-semibold mb-1"
            style={{ background: `linear-gradient(180deg,${UI.blue},#2456c8)`, color: "#fff", border: "1px solid #2456c8" }}>
            설계 JSON 내보내기
          </button>
        </div>
        <div className="flex gap-1 px-4 pb-0">
          {TABS.map(([k, l]) => {
            const on = tab === k;
            return (
              <button key={k} onClick={() => setTab(k)}
                className="text-xs px-3.5 py-2 font-semibold"
                style={{
                  background: on ? UI.panel : "transparent",
                  border: `1px solid ${on ? UI.border : "transparent"}`, borderBottom: "none",
                  borderTopLeftRadius: 8, borderTopRightRadius: 8, marginBottom: -1,
                  color: on ? UI.cyan : UI.label, letterSpacing: "0.04em",
                  boxShadow: on ? `inset 0 2px 0 ${UI.cyan}` : "none",
                }}>
                {l}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ErrorBoundary resetKey={JSON.stringify([geo, wind, mat, calc, therm, tab])}
          onReset={() => { setGeo(GEO0); setWind(WIND0); setMat(MAT0); setCalc(CALC0); setTherm(THERM0); setFemmCal(null); }}>
          {tab === "geometry" && <GeometryTab geo={geo} sG={sG} sW={sW} res={res} resetGeo={() => setGeo(GEO0)} />}
          {tab === "winding" && <WindingTab geo={geo} wind={wind} sW={sW} res={res} showRef={showRef} />}
          {tab === "materials" && <MaterialsTab mat={mat} sM={sM} res={res} showRef={showRef} />}
          {tab === "calculation" && <CalculationTab geo={geo} calc={calc} sC={sC} wind={wind} sW={sW} res={res} solved={solved} setSolved={setSolved} femmCal={femmCal} setFemmCal={setFemmCal} />}
          {tab === "output" && <OutputTab res={res} calc={calc} showRef={showRef} solved={solved} />}
          {tab === "graphs" && <GraphsTab res={res} calc={calc} solved={solved} />}
          {tab === "thermal" && <ThermalTab geo={geo} wind={wind} calc={calc} res={res} therm={therm} sT={sT} solved={solved} />}
          {tab === "selfcheck" && <SelfCheckTab res={res} calc={calc} femmCal={femmCal} solved={solved} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}

// ─── Geometry 탭 (DXF 매칭) ──────────────────────────────────────
function GeometryTab({ geo, sG, sW, res, resetGeo }) {
  const [dxf, setDxf] = useState(null);
  const [dxfName, setDxfName] = useState("");
  const [autoInfo, setAutoInfo] = useState(null);
  const [aedtInfo, setAedtInfo] = useState(null);
  const [dxfT, setDxfT] = useState({ scale: 1, dx: 0, dy: 0, rot: 0 });
  const [layers, setLayers] = useState({ dxf: true, stator: true, slots: true, rotor: true, magnets: true });
  const [opacity, setOpacity] = useState(0.45);
  const [measure, setMeasure] = useState(false);
  const [mPts, setMPts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const canvasRef = useRef(null), wrapRef = useRef(null), fileRef = useRef(null), aedtRef = useRef(null);
  const viewRef = useRef({ scale: 6, ox: 0, oy: 0, init: false });
  const dragRef = useRef(null);
  const rotorDia = geo.rotorType === "outer"
    ? geo.statorLamDia + 2 * (geo.airgap + (geo.bandingThickness || 0) + geo.magnetThickness + (geo.rotorYoke || 0))  // 외전형: 로터 캔 외경
    : geo.statorBore - 2 * geo.airgap;
  // DXF 형상 정합 자동검사 — 형상 관련 파라미터가 바뀔 때만 재계산.
  const fit = useMemo(() => (dxf ? fitResidual(dxf, geo) : null),
    [dxf, geo.statorBore, geo.slotDepth, geo.slotNumber, geo.toothWidth, geo.slotOpening, geo.toothTipDepth,
     geo.toothTipAngle, geo.poleNumber, geo.magnetThickness, geo.magnetArcED, geo.magnetReduction, geo.airgap, geo.bandingThickness, geo.slotBottomShape]);

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
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a1120"; ctx.fillRect(0, 0, Wd, H);
    // 그리드
    ctx.strokeStyle = "#15203a"; ctx.lineWidth = 1;
    const wx0 = s2w(0, 0, V)[0], wx1 = s2w(Wd, 0, V)[0];
    const wy1 = s2w(0, 0, V)[1], wy0 = s2w(0, H, V)[1];
    for (let gx = Math.ceil(wx0 / 10) * 10; gx <= wx1; gx += 10) {
      const [sx] = w2s(gx, 0, V); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (let gy = Math.ceil(wy0 / 10) * 10; gy <= wy1; gy += 10) {
      const [, sy] = w2s(0, gy, V); ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(Wd, sy); ctx.stroke();
    }
    ctx.strokeStyle = "#27374f";
    const [ox0, oy0] = w2s(0, 0, V);
    ctx.beginPath(); ctx.moveTo(ox0, 0); ctx.lineTo(ox0, H); ctx.moveTo(0, oy0); ctx.lineTo(Wd, oy0); ctx.stroke();

    const poly = (pts, close) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const [sx, sy] = w2s(x, y, V); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      if (close) ctx.closePath();
    };
    const cr = (r) => Math.max(r * V.scale, 0);   // 음수 반경 가드 (ctx.arc 음수=예외)
    const circle = (r) => { const [sx, sy] = w2s(0, 0, V); ctx.beginPath(); ctx.arc(sx, sy, cr(r), 0, Math.PI * 2); };
    const annulus = (rO, rI) => {
      const [sx, sy] = w2s(0, 0, V);
      ctx.beginPath(); ctx.arc(sx, sy, cr(rO), 0, Math.PI * 2); ctx.arc(sx, sy, cr(rI), 0, Math.PI * 2, true);
    };

    ctx.globalAlpha = opacity;
    const P = geo;
    const outer = P.rotorType === "outer";
    const Rag = outer ? P.statorLamDia / 2 : P.statorBore / 2;
    const Ro = outer ? Rag + P.airgap + (P.bandingThickness || 0) : Rag - P.airgap - (P.bandingThickness || 0);  // 자석 공극면
    const Ri = outer ? Ro + P.magnetThickness : Ro - P.magnetThickness;                                          // 자석 반대면
    const Rcan = outer ? Ri + (P.rotorYoke || 0) : 0;                                                            // 외전형 로터 캔 외경
    if (layers.rotor) { ctx.fillStyle = "#33CCCC"; annulus(outer ? Rcan : Ri, outer ? Ri : P.shaftDia / 2); ctx.fill("evenodd"); }
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
    if (layers.rotor) { ctx.strokeStyle = "#0E8C8C"; circle(Ro); ctx.stroke(); circle(Ri); ctx.stroke(); circle(outer ? Rcan : P.shaftDia / 2); ctx.stroke(); }

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
    V.scale = Math.min(wrap.clientWidth, wrap.clientHeight) / (Math.max(geo.statorLamDia, rotorDia) * 1.15);   // 외전형 로터 캔 포함
    draw();
  };
  const autoPendingRef = useRef(false);
  const loadFile = async (file) => {
    const text = await file.text();
    try {
      const shapes = parseDxf(text);
      if (!shapes.length) throw new Error("no entities");
      setDxf(shapes); setDxfName(file.name); setAutoInfo(null);
      // 표시만 중심정렬 (형상 파라미터는 절대 건드리지 않음 — 사용자가 직접 치수로 맞춤)
      const ex = extractGeometry(shapes);
      if (ex) setDxfT({ scale: ex.unit, rot: 0, dx: -ex.unit * ex.cx, dy: -ex.unit * ex.cy });
      else setDxfT({ scale: 1, rot: 0, dx: 0, dy: 0 });
      if (autoPendingRef.current) { const m = autoPendingRef.current; autoPendingRef.current = false; m === "fit" ? runFit(shapes) : runExtract(shapes); }
    } catch (err) { alert("DXF 파싱 실패: " + err.message); }
  };
  const loadAedt = async (file) => {
    try {
      const text = await file.text();
      const r = parseAedt(text);
      if (!r) { alert("AEDT 설계변수(VariableProp)를 찾지 못했습니다."); return; }
      Object.entries(r.geo).forEach(([k, v]) => sG(k, v));
      if (sW) Object.entries(r.wind).forEach(([k, v]) => sW(k, v));
      setAedtInfo({ ...r, name: file.name });
    } catch (err) { alert("AEDT 파싱 실패: " + err.message); }
  };
  const autoExtract = () => {
    if (!dxf) { autoPendingRef.current = "extract"; fileRef.current?.click(); return; } // 없으면 파일 선택 → 로드 후 자동추출
    runExtract(dxf);
  };
  const autoFit = () => {
    if (!dxf) { autoPendingRef.current = "fit"; fileRef.current?.click(); return; }   // 없으면 파일 선택 → 로드 후 자동맞춤
    runFit(dxf);
  };
  // 형상 자동 맞춤: 치수 추출 + 중심/스케일/회전 정렬 (DXF 오버레이가 파라메트릭 모델에 겹치게)
  const runFit = (shapes) => {
    const ex = extractGeometry(shapes);
    if (!ex) { alert("형상을 추출할 수 없습니다 (원/닫힌 폴리라인 없음)."); return; }
    const applied = [];
    const put = (k, v, lo, hi, dec = 2) => { if (isFinite(v) && v > lo && v < hi) { sG(k, +v.toFixed(dec)); applied.push(k); } };
    put("statorLamDia", ex.statorLamDia, 5, 2000);
    put("statorBore", ex.statorBore, 2, ex.statorLamDia);
    // 샤프트: DXF에 원 있으면 적용(로터보다 작아야). 미검출인데 잔존값이 로터≥ 면 0(솔리드 로터)으로 — 로터 환형 뒤집힘 방지.
    if (ex.shaftDia > 1 && ex.shaftDia < ex.rotorOD) { sG("shaftDia", ex.shaftDia); applied.push("shaftDia"); }
    else if (ex.rotorOD > 0 && geo.shaftDia >= 0.98 * ex.rotorOD) { sG("shaftDia", 0); applied.push("shaftDia→0(미검출)"); }
    if (ex.slotCount >= 3 && ex.slotCount <= 90) { sG("slotNumber", ex.slotCount); applied.push("slotNumber"); }
    if (ex.poleCount >= 2 && ex.poleCount <= 80) { sG("poleNumber", ex.poleCount); applied.push("poleNumber"); }
    // 종속 치수(슬롯깊이·톱니폭·자석두께·자석호각·에어갭) — OD/보어와 일관되게(모델 오버플로 방지)
    put("slotDepth", ex.slotDepth, 0.3, (ex.statorLamDia - ex.statorBore) / 2);
    put("toothWidth", ex.toothWidth, 0.2, 100);
    put("magnetThickness", ex.magnetThickness, 0.2, 100);
    if (ex.magnetArcED >= 60 && ex.magnetArcED <= 180) { sG("magnetArcED", ex.magnetArcED); applied.push("magnetArcED"); }
    // 자석 R 면취(reduction)는 DXF에서 신뢰성 있게 못 뽑음(코너 필렛이 외측호 측정을 오염).
    // 정확값은 .aedt 불러오기로 설정. DXF 경로에서는 기존 값을 건드리지 않음.
    put("airgap", ex.airgap, 0.05, 5);
    // 정렬: 모델 슬롯(statorRot=0)에 DXF 슬롯을 맞춤. 변환 후 DXF 피처는 world각=θ_raw+rot 이므로 rot=−statorRot.
    sG("statorRot", 0);
    const polePitch = 360 / (ex.poleCount || geo.poleNumber || 2);
    const rrot = (((ex.rotorRot - ex.statorRot) % polePitch) + polePitch) % polePitch;
    sG("rotorRot", +rrot.toFixed(1));
    const rot = -ex.statorRot, rr = rot * D2R, sc = ex.unit;
    setDxfT({ scale: sc, rot,
      dx: -sc * (ex.cx * Math.cos(rr) - ex.cy * Math.sin(rr)),
      dy: -sc * (ex.cx * Math.sin(rr) + ex.cy * Math.cos(rr)) });
    setAutoInfo({ ...ex, applied: [...applied, "정렬(중심·스케일·회전)"] });
  };
  const runExtract = (shapes) => {
    const ex = extractGeometry(shapes);
    if (!ex) { alert("형상을 추출할 수 없습니다 (원/닫힌 폴리라인 없음)."); return; }
    // 회전 자동 정렬은 하지 않음 — 표시 중심정렬만(회전 0). 회전각은 사용자가 직접 맞춤.
    setDxfT({ scale: ex.unit, rot: 0, dx: -ex.unit * ex.cx, dy: -ex.unit * ex.cy });
    const applied = [];
    const put = (k, v, lo, hi, dec = 2) => { if (isFinite(v) && v > lo && v < hi) { sG(k, +v.toFixed(dec)); applied.push(k); } };
    put("statorLamDia", ex.statorLamDia, 5, 2000);
    put("statorBore", ex.statorBore, 2, ex.statorLamDia);
    put("shaftDia", ex.shaftDia, 1, ex.statorBore || 1e9);
    if (ex.slotCount >= 3 && ex.slotCount <= 90) { sG("slotNumber", ex.slotCount); applied.push("slotNumber"); }
    if (ex.poleCount >= 2 && ex.poleCount <= 80) { sG("poleNumber", ex.poleCount); applied.push("poleNumber"); }
    // 에어갭·회전각은 자동 적용 안 함 (검출오차 민감 / 사용자 직접 정렬). 추출값은 리포트에 참고 표시.
    setAutoInfo({ ...ex, applied });
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
    ["magnetLength", "Magnet Length", 0.1], ["magneticLength", "Magnetic Axial Length", 0.1], ["motorLength", "Motor Length (전장·엔드와인딩 포함)", 0.1],
  ];

  return (
    <div className="flex h-full">
      <div className="w-60 overflow-y-auto flex-shrink-0" style={{ background: "#0c1424", borderRight: "1px solid #22304d" }}>
        <div className="p-2 flex flex-col gap-1">
          <button onClick={() => fileRef.current?.click()} className="text-xs px-2 py-1.5 rounded font-semibold" style={{ background: "linear-gradient(180deg,#f5a524,#d98a10)", color: "#15110a" }}>DXF 불러오기</button>
          <input ref={fileRef} type="file" accept=".dxf" className="hidden"
            onChange={(e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; }} />
          {dxfName && <div className="text-xs truncate" style={{ color: "#1B7A2B", fontFamily: "Consolas,monospace" }}>{dxfName}</div>}
          <button onClick={() => aedtRef.current?.click()} className="text-xs px-2 py-1.5 rounded font-semibold" style={{ background: `linear-gradient(180deg,${UI.cyan},#1f9fb5)`, color: "#06222a" }}>⬇ AEDT 불러오기 (설계변수 정확 적용)</button>
          <input ref={aedtRef} type="file" accept=".aedt" className="hidden"
            onChange={(e) => { if (e.target.files[0]) loadAedt(e.target.files[0]); e.target.value = ""; }} />
          {aedtInfo && (
            <div className="text-xs rounded p-2" style={{ background: "#08222a", border: `1px solid ${UI.cyan}`, fontFamily: "Consolas,monospace", lineHeight: 1.5 }}>
              <div className="font-bold mb-0.5" style={{ color: UI.cyan }}>AEDT 적용 완료 — {aedtInfo.varCount}개 변수</div>
              <div className="truncate" style={{ color: "#1B7A2B" }}>{aedtInfo.name}</div>
              <div style={{ color: UI.text }}>적용 {aedtInfo.applied.length}개: {aedtInfo.applied.join(" · ")}</div>
              {aedtInfo.missing.length > 0 && <div style={{ color: "#B5622D" }}>미발견 {aedtInfo.missing.length}개: {aedtInfo.missing.join(" · ")}</div>}
              {aedtInfo.warnings && aedtInfo.warnings.length > 0 && aedtInfo.warnings.map((w, i) => <div key={i} style={{ color: "#ff6b6b", fontWeight: 600 }}>⚠ {w}</div>)}
            </div>
          )}
          {dxf && (
            fit ? (
              <div className="text-xs rounded p-2" style={{ background: fit.ok ? "#0a2418" : "#2a1212", border: `1px solid ${fit.ok ? "#1B7A2B" : "#d9534f"}`, fontFamily: "Consolas,monospace", lineHeight: 1.5 }}>
                <div className="font-bold" style={{ color: fit.ok ? "#3ddc84" : "#ff6b6b" }}>{fit.ok ? "🟢 DXF 형상 정합 OK" : "🔴 DXF 형상 불일치"}</div>
                <div style={{ color: fit.statorOK ? "#9fb8d4" : "#ff9b9b" }}>{fit.statorOK ? "🟢" : "🔴"} 고정자 잔차 {fit.sMax.toFixed(2)}mm (바닥 {fit.sBot.toFixed(2)})</div>
                <div style={{ color: fit.magOK ? "#9fb8d4" : "#ff9b9b" }}>{fit.magOK ? "🟢" : "🔴"} 자석 잔차 {fit.mMax === null ? "—" : fit.mMax.toFixed(2) + "mm"} {fit.magCount ? `(${fit.magCount}극)` : ""}</div>
                <div style={{ color: "#7e8eac" }}>임계 고정자 {FIT_TOL_STATOR}/자석 {FIT_TOL_MAG}mm · 모델↔DXF 측정</div>
              </div>
            ) : (
              <div className="text-xs rounded p-2" style={{ background: "#0c1424", border: "1px solid #22304d", color: "#7e8eac", fontFamily: "Consolas,monospace" }}>형상 정합검사: 비교 가능한 닫힌 폴리 없음</div>
            )
          )}
          <div className="flex gap-1">
            <button onClick={fitView} className="flex-1 text-xs px-2 py-1 rounded" style={{ border: "1px solid #22304d", background: "#101a30", color: "#c4d0e4" }}>화면 맞춤</button>
            <button onClick={() => { setMeasure(!measure); setMPts([]); }} className="flex-1 text-xs px-2 py-1 rounded"
              style={{ border: `1px solid ${measure ? "#34d3e8" : "#22304d"}`, background: measure ? "rgba(52,211,232,0.15)" : "#101a30", color: measure ? "#34d3e8" : "#c4d0e4" }}>
              측정 {measure ? "ON" : "OFF"}
            </button>
          </div>
          <button onClick={() => { if (window.confirm("형상을 1250W-jk 기준값으로 되돌립니다. 진행할까요?")) resetGeo(); }}
            className="text-xs px-2 py-1 rounded" style={{ border: "1px solid #22304d", background: "#101a30", color: "#7e8eac" }}>
            ⟲ 기준형상 리셋 (1250W)
          </button>
          <button onClick={autoFit} className="text-xs px-2 py-1.5 rounded font-semibold"
            style={{ background: `linear-gradient(180deg,${UI.cyan},#1f9fb5)`, color: "#06222a", cursor: "pointer" }}>
            ⊹ 형상 자동 맞춤 (추출+중심·회전 정렬){!dxf && " · DXF 선택"}
          </button>
          <button onClick={autoExtract} className="text-xs px-2 py-1.5 rounded text-white font-medium"
            style={{ background: "#1B7A2B", cursor: "pointer" }}>
            ⚙ 형상 추출만 (치수, 정렬 X){!dxf && " · DXF 선택"}
          </button>
          {dxf && (
            <button onClick={exportAlignedDxf} className="text-xs px-2 py-1 rounded font-medium"
              style={{ border: "1px solid #1B7A2B", color: "#1B7A2B", background: "#101a30", cursor: "pointer" }}>
              ⬇ DXF 내보내기 (현재 정렬)
            </button>
          )}
          {autoInfo && (
            <div className="text-xs rounded p-2 mt-0.5" style={{ background: "#0c1424", border: "1px solid #22304d", fontFamily: "Consolas,monospace", lineHeight: 1.5 }}>
              {(() => { const fit = autoInfo.applied.some((a) => a.includes("정렬")); return (<>
              <div className="font-bold mb-0.5" style={{ color: fit ? UI.cyan : "#1B7A2B" }}>{fit ? "자동 맞춤 완료 (단위 ×" : "추출 결과 (단위 ×"}{autoInfo.unit})</div>
              <div>OD {autoInfo.statorLamDia} · 보어 {autoInfo.statorBore} · 샤프트 {autoInfo.shaftDia || "—"}</div>
              <div>슬롯 {autoInfo.slotCount || "?"} · 극 {autoInfo.poleCount || "?"}</div>
              {fit && <div style={{ color: UI.text }}>슬롯깊이 {autoInfo.slotDepth} · 톱니폭 {autoInfo.toothWidth} · 자석두께 {autoInfo.magnetThickness} · 자석호 {autoInfo.magnetArcED}°E</div>}
              {fit
                ? <div style={{ color: UI.cyan }}>정렬 적용 ✓ 중심·스케일·회전(S{autoInfo.statorRot}°→0) · 자석 rotorRot {(((autoInfo.rotorRot - autoInfo.statorRot) % (360 / (autoInfo.poleCount || 2)) + (360 / (autoInfo.poleCount || 2))) % (360 / (autoInfo.poleCount || 2))).toFixed(1)}° · 에어갭(추정) {autoInfo.airgap || "?"}</div>
                : <div style={{ color: "#B5622D" }}>에어갭(추정) {autoInfo.airgap || "?"} · 회전(추정) S{autoInfo.statorRot}°/R{autoInfo.rotorRot}° — 미적용, 직접 입력/정렬</div>}
              </>); })()}
              <div style={{ color: "#7e8eac" }}>동심원 Ø: {autoInfo.dias.join(", ") || "없음"}</div>
              <div style={{ color: "#7e8eac" }}>폴리 외측 {autoInfo.outerN}→슬롯 {autoInfo.slotCount} · 내측 {autoInfo.innerN}→극 {autoInfo.poleCount} · 폴리보어 {autoInfo.borePoly || "—"}</div>
              <div style={{ color: "#7e8eac", marginTop: 2 }}>적용 {autoInfo.applied.length}개 — 오버레이 확인 후 미세조정</div>
            </div>
          )}
        </div>
        <SectionHead color="#E03030">Stator Parameters</SectionHead>
        <div className="flex items-center justify-between px-2 py-1" style={{ borderBottom: "1px solid #1a2942" }}>
          <span className="text-xs" style={{ color: "#8fa3c4" }}>슬롯 바닥</span>
          <select value={geo.slotBottomShape || "arc"} onChange={(e) => sG("slotBottomShape", e.target.value)}
            className="text-xs px-1 py-0.5 rounded" style={{ background: "#101a30", color: "#c4d0e4", border: "1px solid #22304d", fontFamily: "Consolas,monospace" }}>
            <option value="arc">동심호 (Motor-CAD)</option>
            <option value="straight">직선 (Maxwell)</option>
          </select>
        </div>
        {SFIELDS.map(([k, l, s]) => <NumIn key={k} label={l} value={geo[k]} step={s} onChange={(v) => sG(k, v)} />)}
        <SectionHead color="#22BB22">Rotor Parameters</SectionHead>
        {RFIELDS.map(([k, l, s]) => <NumIn key={k} label={l} value={geo[k]} step={s} onChange={(v) => sG(k, v)} />)}
        <div className="flex items-center justify-between px-2 py-0.5" style={{ borderTop: "1px solid #22304d", background: "#0c1424" }}>
          <span className="text-xs" style={{ color: "#7e8eac" }}>Rotor Diameter [Calc]</span>
          <span className="text-xs font-semibold" style={{ fontFamily: "Consolas,monospace" }}>{rotorDia.toFixed(2)}</span>
        </div>
        <SectionHead color="#7e8eac">Axial Dimensions</SectionHead>
        {AFIELDS.map(([k, l, s]) => <NumIn key={k} label={l} value={geo[k]} step={s} onChange={(v) => sG(k, v)} />)}
        <SectionHead color="#1B7A2B">DXF Transform</SectionHead>
        {[["scale", "Scale", 0.001], ["dx", "Offset X", 0.1], ["dy", "Offset Y", 0.1], ["rot", "Rotation [°]", 0.5]].map(([k, l, s]) => (
          <NumIn key={k} label={l} value={dxfT[k]} step={s} onChange={(v) => setDxfT((t) => ({ ...t, [k]: v }))} />
        ))}
        <SectionHead color="#7e8eac">Layers</SectionHead>
        {[["dxf", "DXF 단면"], ["stator", "Stator Lam"], ["slots", "Slots"], ["rotor", "Rotor / Shaft"], ["magnets", "Magnets"]].map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 px-2 py-0.5 text-xs cursor-pointer" style={{ borderTop: "1px solid #22304d" }}>
            <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((L) => ({ ...L, [k]: e.target.checked }))} />{l}
          </label>
        ))}
        <div className="px-2 py-2" style={{ borderTop: "1px solid #22304d" }}>
          <div className="text-xs mb-1" style={{ color: "#7e8eac" }}>템플릿 투명도</div>
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
        <div className="flex items-center gap-4 px-3 py-1 text-xs" style={{ background: "#0c1424", color: "#9fb2d4", fontFamily: "JetBrains Mono,Consolas,monospace", borderTop: "1px solid #22304d" }}>
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
  // 외전형: 공극면 반경의 내전형 등가 슬롯으로 패킹(치수 동일 → 용량·배치 동일). 위치 반사는 표시단에서.
  if (geo.rotorType === "outer") return packConductors({ ...geo, statorBore: geo.statorLamDia, rotorType: "inner" }, wind);
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
  // 슬롯 바닥 형상별 제약: 직선바닥이면 동심호(hypot)가 아니라 두 직선(A4→정점)을 경계로.
  const straight = geo.slotBottomShape === "straight";
  let bnx = 0, bny = 0, bc = 0, blen = 1;
  if (straight) {
    const tEnd0 = Rd * cD;
    const ax = tEnd0 * cD + sD * geo.toothWidth / 2, ay = tEnd0 * sD - cD * geo.toothWidth / 2; // A4(+y)
    bnx = ay; bny = Rd - ax; blen = Math.hypot(bnx, bny) || 1; bc = ay * Rd; // +y 바닥선: bnx·x+bny·y=bc (원점쪽 음수)
  }
  const ok = (x, y) => {
    if (x < xMin + r) return false;
    if (straight) {
      if ((bnx * x + bny * y - bc) / blen > -(liner + r)) return false;   // +y 바닥직선 안쪽
      if ((bnx * x - bny * y - bc) / blen > -(liner + r)) return false;   // -y 바닥직선 안쪽
    } else if (Math.hypot(x, y) > RdL - r) return false;                   // 동심호 바닥
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
  // 권선영역(라이너 안쪽) 상단 모서리 — 렌더용. 직선바닥이면 치벽∩(바닥-라이너), 정점은 바닥선∩축.
  let WtopS = null, apexS = null;
  if (straight) {
    const blc = bc - liner * blen;                                   // +y 바닥선을 라이너만큼 안쪽 평행이동
    const yTop = (blc - bnx * (wallLim / sD)) / (bnx * cD / sD + bny); // 치벽(sD·x−cD·y=wallLim)과 교점
    WtopS = [(wallLim + cD * yTop) / sD, yTop];
    apexS = [blc / bnx, 0];                                          // 바닥선 ∩ x축(슬롯중심 바닥)
  }
  return {
    left: left.slice(0, targetSide), right: right.slice(0, targetSide),
    capacity: Math.min(left.length, right.length), targetSide,
    geo: { x1, Rd, RdL, xMin, dlt, wallLim, divHalf, straight, WtopS, apexS },
  };
}

function SlotViewer({ geo, wind, res }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  // 외전형: 단면 상세는 공극면 반경의 내전형 등가 슬롯으로 표시(치수·도체패킹 동일, 검증된 경로 재사용)
  const geoEff = geo.rotorType === "outer" ? { ...geo, statorBore: geo.statorLamDia, rotorType: "inner" } : geo;
  const pack = useMemo(() => packConductors(geoEff, wind), [geo, wind]);

  const draw = useCallback(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a1120"; ctx.fillRect(0, 0, W, H);

    const P = geoEff;
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
    const tAtXmin = (g2.xMin - Math.sin(dlt) * wl) / Math.cos(dlt);
    const W1 = [g2.xMin, tAtXmin * Math.sin(dlt) - Math.cos(dlt) * wl];
    let wpoly;
    if (g2.straight && g2.WtopS && g2.apexS) {
      // 직선 바닥: 모서리(Wtop) → 슬롯중심 바닥정점(apex) → 대칭. 호 아님.
      wpoly = [W1, g2.WtopS, g2.apexS, [g2.WtopS[0], -g2.WtopS[1]], [W1[0], -W1[1]]];
    } else {
      const tEnd = Math.sqrt(Math.max(g2.RdL ** 2 - wl ** 2, 0));
      const Wtop = [tEnd * Math.cos(dlt) + Math.sin(dlt) * wl, tEnd * Math.sin(dlt) - Math.cos(dlt) * wl];
      const aT = Math.atan2(Wtop[1], Wtop[0]);
      wpoly = [W1, Wtop, ...arcPts(g2.RdL, aT, -aT, 40), [Wtop[0], -Wtop[1]], [W1[0], -W1[1]]];
    }
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
    // 5) 코일 디바이더(연회색 세로 막대) — 직선바닥이면 바닥정점까지
    const divOut = (g2.straight && g2.apexS ? g2.apexS[0] : g2.RdL) - 0.2;
    ctx.fillStyle = "#E8EEF2";
    poly([[g2.xMin, g2.divHalf], [divOut, g2.divHalf], [divOut, -g2.divHalf], [g2.xMin, -g2.divHalf]]);
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
    ctx.strokeStyle = "#c25555"; ctx.lineWidth = 1;
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
      <div ref={wrapRef} className="flex-1 relative min-h-0" style={{ background: "#101a30" }}>
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
  if (!res) return <div className="p-4 text-sm" style={{ color: UI.label }}>계산 불가 — 입력값 확인</div>;
  const wa = res.wa;
  const harmonics = [1, 3, 5, 7, 9, 11, 13];
  return (
    <div className="flex h-full overflow-hidden">
      {/* 좌: 입력 */}
      <div className="w-60 overflow-y-auto flex-shrink-0" style={{ background: "#0c1424", borderRight: "1px solid #22304d" }}>
        <SectionHead color="#B5622D">Winding Definition</SectionHead>
        <NumIn label="Turns (per coil)" value={wind.turnsPerCoil} step={1} onChange={(v) => sW("turnsPerCoil", v)} />
        <NumIn label="Throw (coil span)" value={wind.throw} step={1} onChange={(v) => sW("throw", v)} />
        <NumIn label="Parallel Paths" value={wind.parallelPaths} step={1} onChange={(v) => sW("parallelPaths", v)} />
        <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d" }}>
          <span className="text-xs">Connection</span>
          <select value={wind.connection} onChange={(e) => sW("connection", e.target.value)}
            className="text-xs px-1 py-0.5 rounded" style={{ border: "1px solid #22304d" }}>
            <option value="delta">Delta</option><option value="star">Star</option>
          </select>
        </div>
        <SectionHead color="#CC8800">Wire Selection</SectionHead>
        <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d" }}>
          <span className="text-xs">Wire Type</span>
          <select value={wireType} onChange={(e) => setWireType(e.target.value)}
            className="text-xs px-1 py-0.5 rounded" style={{ border: "1px solid #22304d" }}>
            <option value="direct">Diameter Input</option>
            <option value="Metric">Metric Table</option>
            <option value="AWG">AWG Table</option>
            <option value="SWG">SWG Table</option>
          </select>
        </div>
        {wireType !== "direct" && (
          <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d" }}>
            <span className="text-xs">Gauge</span>
            <select value=""
              onChange={(e) => {
                const w = WIRE_TABLES[wireType][+e.target.value];
                if (w) { sW("copperDia", w.cu); sW("wireDia", w.cov); }
              }}
              className="text-xs px-1 py-0.5 rounded w-32" style={{ border: "1px solid #22304d", fontFamily: "Consolas,monospace" }}>
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
        <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d" }}>
          <span className="text-xs">Wedge Model</span>
          <select value={wind.wedgeModel} onChange={(e) => sW("wedgeModel", e.target.value)}
            className="text-xs px-1 py-0.5 rounded" style={{ border: "1px solid #22304d" }}>
            <option value="wedge">Wedge</option>
            <option value="wound">Wound Space</option>
            <option value="air">Air</option>
          </select>
        </div>
        <NumIn label="Liner Thickness" value={wind.linerThk} step={0.05} onChange={(v) => sW("linerThk", v)} />
        <NumIn label="Wedge Depth" value={wind.wedgeDepth} step={0.1} onChange={(v) => sW("wedgeDepth", v)} />
        <NumIn label="Coil Divider" value={wind.coilDivider} step={0.05} onChange={(v) => sW("coilDivider", v)} />
        <NumIn label="Conductor Separation" value={wind.condSep} step={0.01} onChange={(v) => sW("condSep", v)} />
        <SectionHead color="#7e8eac">계산 결과</SectionHead>
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
        <div className="flex gap-0.5 px-3 pt-1.5" style={{ background: "#0c1424", borderBottom: "1px solid #22304d" }}>
          {[["section", "슬롯 단면"], ["layout", "권선 배치도"]].map(([k, l]) => (
            <button key={k} onClick={() => setWindView(k)} className="text-xs px-3 py-1 rounded-t"
              style={{ background: windView === k ? "#101a30" : "transparent", border: `1px solid ${windView === k ? "#22304d" : "transparent"}`, borderBottom: "none", marginBottom: -1, fontWeight: windView === k ? 600 : 400, color: windView === k ? "#34d3e8" : "#7e8eac", boxShadow: windView === k ? "inset 0 2px 0 #34d3e8" : "none" }}>
              {l}
            </button>
          ))}
        </div>
        {windView === "section" ? <SlotViewer geo={geo} wind={wind} res={res} /> : <WindingLayout geo={geo} res={res} />}
      </div>
      {/* 우: 패턴/권선계수 */}
      <div className="w-64 overflow-y-auto flex-shrink-0 p-2 flex flex-col gap-3" style={{ background: "#0c1424", borderLeft: "1px solid #22304d" }}>
        <div className="rounded" style={{ background: "#101a30", border: "1px solid #22304d" }}>
          <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>Winding Factors</div>
          <table className="text-xs w-full" style={{ fontFamily: "Consolas,monospace" }}>
            <tbody>
              {harmonics.map((h) => (
                <tr key={h} style={{ borderTop: "1px solid #22304d", background: h === 1 ? "rgba(52,211,232,0.1)" : undefined }}>
                  <td className="px-3 py-0.5 text-center">{h}</td>
                  <td className="px-3 py-0.5 text-right">{wa.kw(h).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {showRef && <div className="px-2 py-1 text-xs" style={{ color: "#1B7A2B" }}>참조 kw1 = 0.945214</div>}
        </div>
        <div className="rounded" style={{ background: "#101a30", border: "1px solid #22304d" }}>
          <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>Radial Pattern (슬롯별 도체수)</div>
          <table className="text-xs w-full" style={{ fontFamily: "Consolas,monospace" }}>
            <thead><tr style={{ background: "#0c1424" }}>
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
                  <tr key={i} style={{ borderTop: "1px solid #22304d" }}>
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
  const td = "px-2 py-1 text-xs";
  const tdr = td + " text-right";
  const mono = { fontFamily: "Consolas,monospace" };
  const TR = ({ children, total }) => (
    <tr style={{ borderTop: "1px solid #22304d", background: total ? "#0c1424" : undefined }}>{children}</tr>
  );
  if (!res) return <div className="p-4 text-sm" style={{ color: UI.label }}>계산 불가 — 입력값 확인</div>;
  return (
    <div className="h-full overflow-auto p-3">
      <table className="text-xs" style={{ background: "#101a30", border: "1px solid #22304d" }}>
        <thead>
          <tr style={{ background: "#0c1424" }}>
            {["Component", "Material from Database", "Electrical Resistivity", "Magnet Br at 20°C", "Magnet Rel. Permeability", "Temp Coef Br", "Density", "Weight"].map((h) => (
              <th key={h} className="px-2 py-1.5 font-semibold" style={{ borderLeft: "1px solid #22304d" }}>{h}</th>
            ))}
          </tr>
          <tr style={{ background: "#0c1424", color: "#5e9bff" }}>
            <td className={td}>Units</td><td className={td}></td><td className={tdr}>Ohm.m</td>
            <td className={tdr}>Tesla</td><td className={td}></td><td className={tdr}>%/°C</td>
            <td className={tdr}>kg/m³</td><td className={tdr}>kg</td>
          </tr>
        </thead>
        <tbody style={mono}>
          <TR><td className={td}>Stator Lam (Back Iron)</td><td className={td}><SteelSel value={mat.steel} onPick={pickSteel} /></td><td className={tdr}>5.5E-07</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{stl.density}</td><td className={tdr}>{res.mBy.toFixed(4)}</td></TR>
          <TR><td className={td}>Stator Lam (Tooth)</td><td className={td}><SteelSel value={mat.steel} onPick={pickSteel} /></td><td className={tdr}>5.5E-07</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{stl.density}</td><td className={tdr}>{res.mTooth.toFixed(4)}</td></TR>
          <TR total><td className={td}>Stator Lamination [Total]</td><td className={td}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{res.mStator.toFixed(4)}{showRef && <span style={{ color: "#1B7A2B" }}> ({REF.mStator})</span>}</td></TR>
          <TR><td className={td}>Armature Winding [Active]</td><td className={td}>Copper (Pure)</td><td className={tdr}>1.724E-08</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>8933</td><td className={tdr}>{res.mCuActive.toFixed(4)}</td></TR>
          <TR><td className={td}>Armature EWdg [Front]</td><td className={td}>Copper (Pure)</td><td className={tdr}>1.724E-08</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>8933</td><td className={tdr}>{res.mCuEwdg.toFixed(4)}</td></TR>
          <TR><td className={td}>Armature EWdg [Rear]</td><td className={td}>Copper (Pure)</td><td className={tdr}>1.724E-08</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>8933</td><td className={tdr}>{res.mCuEwdg.toFixed(4)}</td></TR>
          <TR total><td className={td}>Armature Winding [Total]</td><td className={td}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{res.mCopper.toFixed(4)}{showRef && <span style={{ color: "#1B7A2B" }}> ({REF.mCopper})</span>}</td></TR>
          <TR><td className={td}>Rotor Lam (Back Iron)</td><td className={td}><SteelSel value={mat.steel} onPick={pickSteel} /></td><td className={tdr}>5.5E-07</td><td className={tdr}></td><td className={tdr}></td><td className={tdr}></td><td className={tdr}>{stl.density}</td><td className={tdr}>{res.mRotor.toFixed(4)}{showRef && <span style={{ color: "#1B7A2B" }}> ({REF.mRotor})</span>}</td></TR>
          <TR>
            <td className={td}>Magnet</td>
            <td className={td}>
              <select value={mat.magnet} onChange={(e) => pickMag(e.target.value)} className="text-xs px-1 py-0.5 rounded w-32" style={{ border: "1px solid #22304d" }}>
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
        <div className="rounded" style={{ background: "#101a30", border: "1px solid #22304d" }}>
          <SectionHead color="#22BB22">자석 물성 편집</SectionHead>
          <NumIn label="Br @20°C [T]" value={mat.Br20} step={0.01} onChange={(v) => sM("Br20", v)} />
          <NumIn label="Temp Coef Br [%/°C]" value={mat.tcBr} step={0.005} onChange={(v) => sM("tcBr", v)} />
          <NumIn label="μr" value={mat.mur} step={0.01} onChange={(v) => sM("mur", v)} />
        </div>
        <div className="rounded" style={{ background: "#101a30", border: "1px solid #22304d" }}>
          <SectionHead color="#E03030">강판 철손계수 (Steinmetz)</SectionHead>
          <NumIn label="kh (히스테리시스)" value={mat.kh} step={0.001} onChange={(v) => sM("kh", v)} />
          <NumIn label="ke (와전류)" value={mat.ke} step={1e-6} onChange={(v) => sM("ke", v)} />
          <div className="px-2 py-1 text-xs" style={{ color: "#7e8eac" }}>기본값: 20PNX1200F를 1250W FEA 철손으로 캘리브레이션</div>
        </div>
      </div>
    </div>
  );
}

// ─── Calculation 탭 (Motor-CAD Drive 패널) ──────────────────────
function CalculationTab({ geo, calc, sC, wind, sW, res, solved, setSolved, femmCal, setFemmCal }) {
  const [femmRes, setFemmRes] = useState(null);
  const [femmBusy, setFemmBusy] = useState(false);
  const [femmErr, setFemmErr] = useState(null);
  const runFemm = async () => {
    if (!res) return;
    setFemmBusy(true); setFemmErr(null); setFemmRes(null);
    const outerF = geo.rotorType === "outer";
    const Rb = geo.statorBore / 2;
    const Rro = outerF ? geo.statorLamDia / 2 + geo.airgap : (geo.statorBore - 2 * geo.airgap) / 2;   // 자석 공극면
    const RmF = outerF ? Rro + geo.magnetThickness : Rro - geo.magnetThickness;                        // 자석 반대면
    const Rcan = outerF ? RmF + (geo.rotorYoke || 0) : 0;                                              // 외전형 로터 캔 외경
    const payload = {
      Ns: geo.slotNumber, poles: geo.poleNumber, statorRot: geo.statorRot, rotorRot: geo.rotorRot,
      depth: geo.magneticLength, slotDepth: geo.slotDepth, toothWidth: geo.toothWidth,    // 2D FEA 깊이 = 유효 자기길이 / 철손샘플용 톱니폭
      Rlam: geo.statorLamDia / 2, Rb, Rro, Rmi: RmF, Rsh: geo.shaftDia / 2, rotorType: geo.rotorType, Rcan,
      slotPoly: buildSlotPath(geo), magnetPoly: buildMagnetPath(geo), slotTurns: res.wa.table,
      Ipk: res.IphRms * Math.SQRT2, Br: res.Br_used, slotArea: res.slotArea,
      phaseAdv: calc.phaseAdv, parallelPaths: wind.parallelPaths, speed: calc.speed,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6 * 60 * 1000);   // 6분 타임아웃
    try {
      const r = await fetch("http://localhost:8765/solve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal });
      if (!r.ok) { setFemmErr(`브릿지 서버 오류 (HTTP ${r.status}) — 서버 콘솔의 trace 확인`); return; }
      const j = await r.json();
      if (j.ok) setFemmRes(j); else setFemmErr(j.error || "FEMM 해석 실패 — 서버 콘솔 trace 확인");
    } catch (e) {
      if (e.name === "AbortError") setFemmErr("FEMM 해석 시간 초과(6분) — 메시/스텝을 줄이거나 다시 시도");
      else setFemmErr("브릿지 서버 연결 실패 — fea/femm_server.py 가 실행 중인지 확인 (python fea/femm_server.py)");
    } finally {
      clearTimeout(timer);
      setFemmBusy(false);
    }
  };
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
            <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d", background: "#0a1120" }}>
              <span className="text-xs" style={{ color: "#7e8eac" }}>Line Current — Peak [A]</span>
              <span className="text-xs" style={{ fontFamily: "Consolas,monospace" }}>{IlinePk.toFixed(2)}</span>
            </div>
          )}
          {calc.currentDef === "rms" ? (
            <NumIn label="Line Current — RMS [A]" value={calc.IlineRms} step={0.1} onChange={(v) => sC("IlineRms", v)} />
          ) : (
            <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d", background: "#0a1120" }}>
              <span className="text-xs" style={{ color: "#7e8eac" }}>Line Current — RMS [A]</span>
              <span className="text-xs" style={{ fontFamily: "Consolas,monospace" }}>{calc.IlineRms.toFixed(2)}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d", background: "#0a1120" }}>
            <span className="text-xs" style={{ color: "#7e8eac" }}>Phase Current (RMS)</span>
            <span className="text-xs" style={{ fontFamily: "Consolas,monospace", fontWeight: 600 }}>{res ? res.IphRms.toFixed(2) : "—"} A</span>
          </div>
          <div className="flex items-center justify-between gap-1 px-2 py-0.5" style={{ borderTop: "1px solid #22304d", background: "#0a1120" }}>
            <span className="text-xs" style={{ color: "#7e8eac" }}>Phase Current Density (RMS)</span>
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
          <NumIn label="AC 동손 보정 cAC" value={calc.cAC} step={0.1} onChange={(v) => sC("cAC", v)} />
          <NumIn label="철손 보정 cFe (FEA/측정)" value={calc.cFe} step={0.05} onChange={(v) => sC("cFe", v)} />
          <NumIn label="기타 손실 [W]" value={calc.otherLoss} step={0.5} onChange={(v) => sC("otherLoss", v)} />
          <div className="px-2 py-1 text-xs" style={{ color: "#7e8eac" }}>기본값은 1250W-jk FEA 캘리브레이션. 토폴로지가 다르면 재조정.</div>
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
            <div className="text-xs py-4 text-center" style={{ color: "#7e8eac" }}>
              아래 <b>Solve E-Magnetic Model</b>을 눌러 해석을 실행하세요.
            </div>
          )}
        </Box>
        <button
          onClick={() => setSolved(true)}
          className="w-full py-3 rounded font-semibold text-sm"
          style={{ border: `1px solid ${solved ? "#2bd47a" : "#34d3e8"}`, background: solved ? "linear-gradient(180deg,#23a35f,#1c8b50)" : "#101a30", color: solved ? "#fff" : "#34d3e8", boxShadow: solved ? "0 0 14px rgba(43,212,122,0.3)" : "0 0 10px rgba(52,211,232,0.15)" }}>
          {solved ? "✓ 해석 완료 — Output Data / Graphs 확인" : "Solve E-Magnetic Model"}
        </button>
        <div className="text-xs mt-1.5" style={{ color: "#7e8eac" }}>해석식(closed-form) 엔진 — Solve 시 즉시 계산됩니다. 입력을 바꾸면 다시 Solve 해야 합니다.</div>

        <button onClick={runFemm} disabled={femmBusy}
          className="w-full py-3 rounded font-semibold text-sm mt-3"
          style={{ border: "1px solid #1B7A2B", background: femmBusy ? "#A8B2BC" : "#1B7A2B", color: "#fff", cursor: femmBusy ? "default" : "pointer" }}>
          {femmBusy ? "⏳ FEMM 해석 중… (수십 초~분)" : "▶ FEMM 해석 (진짜 FEA)"}
        </button>
        <div className="rounded mt-1.5 p-2 text-xs" style={{ background: "#0a1120", border: "1px solid #22304d", color: "#7e8eac", lineHeight: 1.6 }}>
          <div style={{ color: "#34d3e8", fontWeight: 600, marginBottom: 3 }}>▶ FEMM 해석 전, 브릿지 서버를 먼저 켜세요</div>
          <div>1. 터미널(명령 프롬프트)에서 프로젝트 폴더로 이동:</div>
          <div style={{ fontFamily: "JetBrains Mono,Consolas,monospace", color: "#cfe0ff", background: "#0c1424", padding: "2px 6px", borderRadius: 4, margin: "2px 0" }}>cd C:\\Users\\user\\Desktop\\mini-motorcad-main</div>
          <div>2. 브릿지 서버 실행 (FEMM·pyfemm 설치 필요):</div>
          <div style={{ fontFamily: "JetBrains Mono,Consolas,monospace", color: "#cfe0ff", background: "#0c1424", padding: "2px 6px", borderRadius: 4, margin: "2px 0" }}>python fea\\femm_server.py</div>
          <div>3. <span style={{ color: "#2bd47a" }}>http://localhost:8765 대기</span> 뜨면 위 버튼 클릭. 코드 수정 시 서버 <b style={{ color: "#f5a524" }}>재시작(Ctrl+C → 재실행)</b>.</div>
        </div>
        {femmErr && <div className="text-xs mt-1 p-2 rounded" style={{ background: "rgba(255,93,108,0.12)", color: "#ff8a94", border: "1px solid rgba(255,93,108,0.4)" }}>{femmErr}</div>}
        {femmRes && (
          <div className="rounded mt-2" style={{ border: "1px solid #1B7A2B", background: "#0c1424" }}>
            <div className="px-2 py-1 text-xs font-bold" style={{ color: "#1B7A2B", borderBottom: "1px solid #22304d" }}>FEMM 기반 성능 (FEA)</div>
            <table className="w-full"><tbody>
              <Row label="평균 토크 (FEA)" value={femmRes.avgTorque.toFixed(3)} unit="Nm" hl />
              <Row label="토크 리플 (FEA)" value={femmRes.torqueRipple.toFixed(2)} unit="%" />
              <Row label="코깅 p-p (FEA) ⚠ 메시한계·참고만" value={femmRes.coggingPP.toFixed(1)} unit="mNm" />
              <Row label="에어갭 자속밀도 (FEA)" value={femmRes.Bg.toFixed(3)} unit="T" />
              {Number.isFinite(femmRes.Ke) && <Row label="역기전력 상수 Ke (FEA)" value={femmRes.Ke.toFixed(4)} unit="V·s/rad" />}
              {Number.isFinite(femmRes.BEMFpk) && <Row label="무부하 역기전력 피크 (FEA)" value={femmRes.BEMFpk.toFixed(2)} unit="V" />}
              {Number.isFinite(femmRes.Bt) && <Row label="치 자속밀도 (FEA, 부하)" value={femmRes.Bt.toFixed(3)} unit="T" />}
              {Number.isFinite(femmRes.By) && <Row label="요크 자속밀도 (FEA, 부하)" value={femmRes.By.toFixed(3)} unit="T" />}
              {Number.isFinite(femmRes.ironMassB2) && femmRes.ironMassB2 > 0 && res.mTooth > 0 && (
                <Row label="철손 보정 cFe (FEA 적분/앱 첨두)" value={(femmRes.ironMassB2 / (res.mTooth * femmRes.Bt ** 2 + res.mBy * femmRes.By ** 2)).toFixed(3)} unit="" />
              )}
              {Number.isFinite(femmRes.Ld) && femmRes.Ld > 0 && <Row label="d축 인덕턴스 Ld (FEA)" value={femmRes.Ld.toFixed(4)} unit="mH" />}
              {Number.isFinite(femmRes.Lq) && femmRes.Lq > 0 && <Row label="q축 인덕턴스 Lq (FEA)" value={femmRes.Lq.toFixed(4)} unit="mH" />}
              <tr><td colSpan={3} style={{ borderTop: "1px solid #22304d" }} /></tr>
              <Row label="해석식 토크 (비교)" value={res.torque.toFixed(3)} unit="Nm" />
              {Number.isFinite(femmRes.Ke) && <Row label="해석식 Ke (비교)" value={res.Ke.toFixed(4)} unit="V·s/rad" />}
            </tbody></table>
            <div className="px-2 py-1 text-xs" style={{ color: "#f5a524", background: "rgba(245,165,36,0.1)", borderTop: "1px solid #22304d" }}>
              ⚠ 코깅 토크는 빠른 메시의 토크 계산 노이즈(~수십 mNm)보다 작아 <b>신뢰 불가</b>입니다. 정밀 코깅은 Maxwell/전용 미세메시 해석을 참조하세요. (토크·Ke·효율은 검증됨)
            </div>
            {Number.isFinite(femmRes.Ke) && res.pp > 0 && (
              <div className="p-2" style={{ borderTop: "1px solid #22304d" }}>
                {femmCal ? (
                  <button onClick={() => setFemmCal(null)} className="w-full py-2 rounded text-xs font-semibold"
                    style={{ border: "1px solid #f5a524", background: "rgba(245,165,36,0.12)", color: "#f5a524" }}>
                    ✓ FEMM 보정 적용중 (λ={femmCal.lam.toFixed(4)}, kT={femmCal.kT ? femmCal.kT.toFixed(3) : "—"}, cFe={femmCal.cFe ? femmCal.cFe.toFixed(2) : "—"}) — 클릭하면 해제
                  </button>
                ) : (
                  <button onClick={() => {
                    const lamF = femmRes.Ke / res.pp;
                    const Tlam = 1.5 * res.pp * lamF * (res.IphRms * Math.SQRT2) * Math.cos(calc.phaseAdv * D2R);
                    const kT = (Math.abs(Tlam) > 1e-3 && Number.isFinite(femmRes.avgTorque)) ? femmRes.avgTorque / Tlam : 1;
                    const Bdenom = res.mTooth * femmRes.Bt ** 2 + res.mBy * femmRes.By ** 2;   // 앱 철손식 peak²·질량합
                    const cFe = (Number.isFinite(femmRes.ironMassB2) && femmRes.ironMassB2 > 0 && Bdenom > 0)
                      ? +(femmRes.ironMassB2 / Bdenom).toFixed(3) : undefined;                  // FEA 철손적분 / 앱 첨두근사
                    setFemmCal({ lam: lamF, ke: femmRes.Ke, kT, cFe, torqueFea: femmRes.avgTorque,
                      Bt: femmRes.Bt, By: femmRes.By, Ld: femmRes.Ld, Lq: femmRes.Lq, source: "FEMM" });
                  }}
                    className="w-full py-2 rounded text-xs font-semibold"
                    style={{ border: "1px solid #1B7A2B", background: "#1B7A2B", color: "#fff" }}>
                    ▶ 이 FEMM 결과로 보정 적용 (λ·토크(포화)·EMF·T-N·효율맵 전부 FEMM 기반)
                  </button>
                )}
                <div className="text-xs mt-1" style={{ color: "#7e8eac" }}>
                  보정하면 Output Data·Graphs·Thermal 이 FEMM λ·포화토크(kT) 기반으로 재계산됩니다 (효율맵은 빠른 엔진이 FEMM값으로 생성 — 점마다 FEMM 실행 X). 형상·권선·재질 변경 시 자동 해제.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Output Data 탭 (Motor-CAD 하위탭 구조) ─────────────────────
function OutputTab({ res, calc, showRef, solved }) {
  const [sub, setSub] = useState("drive");
  if (!solved) return <div className="p-6 text-sm" style={{ color: "#7e8eac" }}>Calculation 탭에서 <b>Solve E-Magnetic Model</b>을 눌러 해석을 실행하면 결과가 표시됩니다.</div>;
  if (!res) return <div className="p-4 text-sm">계산 불가 — 입력값 확인</div>;
  const f = (v, d = 3) => Number(v).toFixed(d);
  const SUBS = [["drive", "Drive"], ["emag", "E-Magnetics"], ["flux", "Flux Densities"], ["loss", "Losses"], ["wdg", "Winding"], ["matl", "Materials"]];
  const Tbl = ({ children }) => (
    <div className="rounded flex-1 min-w-80" style={{ background: "#101a30", border: "1px solid #22304d" }}>
      <table className="w-full">
        <thead><tr style={{ background: "#0c1424" }}>
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
      <div className="flex gap-0.5 px-3 pt-2" style={{ background: "#0c1424" }}>
        {SUBS.map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} className="text-xs px-2.5 py-1 rounded-t"
            style={{ background: sub === k ? "#101a30" : "transparent", border: `1px solid ${sub === k ? "#22304d" : "transparent"}`, borderBottom: "none", marginBottom: -1, fontWeight: sub === k ? 600 : 400, color: sub === k ? "#34d3e8" : "#7e8eac", boxShadow: sub === k ? "inset 0 2px 0 #34d3e8" : "none" }}>
            {l}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3 flex gap-3 items-start flex-wrap" style={{ background: "#101a30", borderTop: "1px solid #22304d" }}>
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
            {r("Total Losses (on load)", f(res.PcuAC + res.Pfe + calc.otherLoss, 2), "Watts", 62.57)}
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
            {r("ini_pos (부하시, 기계)", f(res.iniPos, 2), "°mech", undefined, true)}
            {r("ini_pos (부하시, 전기)", f(res.iniPosE, 1), "°elec")}
            {r("ini_pos (무부하 기준)", f(res.iniPosNL, 2), "°mech")}
            {r("부하각 δL (전기자반작용)", f(res.loadAngle, 1), "°elec")}
          </Tbl>
          <Tbl>
            {r("Flux Linkage D (PM, 무부하)", f(res.lambda * 1000, 3), "mVs", 15.70, true)}
            {r("Flux Linkage D (on load)", f(res.lamD_load * 1000, 3), "mVs")}
            {r("Flux Linkage Q (on load)", f(res.lamQ_load * 1000, 3), "mVs")}
            {r("Rotor Peripheral Velocity", f(res.rotorPeriphV, 2), "m/s")}
            {r("Mechanical Frequency", f(res.fMech, 1), "Hz")}
            {r("Optimum Skew Angle", f(res.optSkew, 2), "MDeg")}
          </Tbl>
          <div className="w-full text-xs px-1" style={{ color: "#7e8eac" }}>ini_pos = U상 <b>부하시 역기전력</b>(전기자반작용 포함)이 0(상승)에서 시작하는 회전자 위치. 무부하 상승영점에서 부하각 δL/pp 만큼 이동(현재 운전점 전류·진각 기준). 전기 1주기(360/pp={f(360 / res.pp, 1)}°mech)마다 반복.</div>
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
            {r("AC 동손비 R_ac/R_dc (추정)", f(res.RacRdc, 4), "")}
            {r("AC 동손 추가분 (근접효과, 추정)", f(res.PcuAddl, 2), "Watts")}
            {r("Stator Iron Loss [hysteresis]", f(res.PfeHyst, 2), "Watts", 13.04)}
            {r("Stator Iron Loss [eddy]", f(res.PfeEddy, 2), "Watts", 10.87)}
            {r("Stator Iron Loss [total]", f(res.Pfe, 2), "Watts", 23.91)}
            {r("기타 손실 (자석+로터철손+마찰, 입력)", f(calc.otherLoss, 2), "Watts", 6.31)}
            {r("Total Losses (on load)", f(res.PcuAC + res.Pfe + calc.otherLoss, 2), "Watts", 62.57)}
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
        <div className="w-full text-xs" style={{ color: "#7e8eac" }}>녹색 열 = 1250W-jk Motor-CAD FEA 참조값. (추정) 표기는 해석식 근사 항목.</div>
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
    <div className="rounded" style={{ background: "#101a30", border: "1px solid #22304d" }}>
      <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>
        {title} {sub && <span className="font-normal" style={{ color: "#7e8eac" }}>{sub}</span>}
      </div>
      <svg width={Wp} height={h} style={{ display: "block" }}>
        {Array.from({ length: 5 }, (_, i) => {
          const yv = y0 + ((y1 - y0) * i) / 4;
          return (
            <g key={"y" + i}>
              <line x1={P.l} x2={Wp - P.r} y1={sy(yv)} y2={sy(yv)} stroke="#1a2740" />
              <text x={P.l - 4} y={sy(yv) + 3} fontSize="9" fill="#7e8eac" textAnchor="end">{yv.toPrecision(3)}</text>
            </g>
          );
        })}
        {Array.from({ length: 7 }, (_, i) => {
          const xv = x0 + ((x1 - x0) * i) / 6;
          return (
            <g key={"x" + i}>
              <line y1={P.t} y2={h - P.b} x1={sx(xv)} x2={sx(xv)} stroke="#1a2740" />
              <text y={h - P.b + 12} x={sx(xv)} fontSize="9" fill="#7e8eac" textAnchor="middle">{Math.round(xv)}</text>
            </g>
          );
        })}
        {y0 < 0 && y1 > 0 && <line x1={P.l} x2={Wp - P.r} y1={sy(0)} y2={sy(0)} stroke="#22304d" />}
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
    <div className="rounded" style={{ background: "#101a30", border: "1px solid #22304d" }}>
      <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>
        {title} {sub && <span className="font-normal" style={{ color: "#7e8eac" }}>{sub}</span>}
      </div>
      <svg width={Wp} height={h} style={{ display: "block" }}>
        {values.map((v, i) => {
          const bh = (v / vmax) * (h - P.t - P.b);
          return <rect key={i} x={P.l + i * bw + 1} width={Math.max(bw - 2, 1)} y={h - P.b - bh} height={bh} fill="#CC2222" />;
        })}
        {values.map((_, i) => ((i + 1) % 2 === 0 ? (
          <text key={"t" + i} x={P.l + i * bw + bw / 2} y={h - P.b + 12} fontSize="9" fill="#7e8eac" textAnchor="middle">{i + 1}</text>
        ) : null))}
        <text x={P.l - 4} y={P.t + 4} fontSize="9" fill="#7e8eac" textAnchor="end">{vmax.toPrecision(3)}</text>
        <line x1={P.l} x2={Wp - P.r} y1={h - P.b} y2={h - P.b} stroke="#22304d" />
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
    <div className="rounded" style={{ background: "#101a30", border: "1px solid #22304d" }}>
      <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>
        Winding Phasors <span className="font-normal" style={{ color: "#7e8eac" }}>코일 EMF 페이저 체인</span>
      </div>
      <svg width={Wp} height={Wp} style={{ display: "block" }}>
        <circle cx={C} cy={C} r={C - 14} fill="none" stroke="#22304d" strokeDasharray="3 3" />
        <line x1={14} x2={Wp - 14} y1={C} y2={C} stroke="#1a2740" />
        <line y1={14} y2={Wp - 14} x1={C} x2={C} stroke="#1a2740" />
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

// jet 컬러맵 (t:0→짙은파랑, 0.5→녹색, 1→짙은적색) — Motor-CAD 효율맵과 동일 계열
function jetColor(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.min(Math.max(1.5 - Math.abs(4 * t - 3), 0), 1);
  const g = Math.min(Math.max(1.5 - Math.abs(4 * t - 2), 0), 1);
  const b = Math.min(Math.max(1.5 - Math.abs(4 * t - 1), 0), 1);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}
// marching-squares: grid[j][i]=(xs[i],ys[j])에서 level 등치선 선분들
function contourSegs(grid, xs, ys, level) {
  const segs = [];
  for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
    const c = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
    if (c[0] == null || c[1] == null || c[2] == null || c[3] == null) continue;
    const xa = [xs[i], xs[i + 1], xs[i + 1], xs[i]], ya = [ys[j], ys[j], ys[j + 1], ys[j + 1]];
    const pts = [];
    for (let e = 0; e < 4; e++) {
      const a = c[e], b = c[(e + 1) % 4];
      if ((a > level) !== (b > level)) {
        const t = (level - a) / (b - a);
        pts.push([xa[e] + (xa[(e + 1) % 4] - xa[e]) * t, ya[e] + (ya[(e + 1) % 4] - ya[e]) * t]);
      }
    }
    if (pts.length >= 2) segs.push([pts[0], pts[1]]);
    if (pts.length === 4) segs.push([pts[2], pts[3]]);
  }
  return segs;
}
function EffMap({ speeds, torques, grid, env, op, h = 340 }) {
  const Wp = 560, P = { l: 52, r: 82, t: 12, b: 26 };
  const flat = grid.flat().filter((v) => v != null);
  if (!flat.length) return null;
  const emax = Math.max(...flat);
  const top = Math.ceil(emax * 2) / 2;                 // 최고효율(0.5 단위 반올림)
  const NB = 12, span = 22;                            // 상위 22%p에 색 집중 (고효율 구간 분해능)
  const lo = Math.max(0, top - span);
  const cellColor = (e) => jetColor((Math.min(e, top) - lo) / (top - lo));   // lo 미만은 t<0 → 짙은 파랑
  const dxs = speeds.length > 1 ? speeds[1] - speeds[0] : 1, dts = torques.length > 1 ? torques[1] - torques[0] : 1;
  const xMax = speeds[speeds.length - 1] + dxs / 2, yMax = torques[torques.length - 1] + dts / 2;
  const sx = (v) => P.l + (v / xMax) * (Wp - P.l - P.r);
  const sy = (v) => h - P.b - (v / yMax) * (h - P.t - P.b);
  const cells = [];
  for (let j = 0; j < torques.length; j++) for (let i = 0; i < speeds.length; i++) {
    const e = grid[j][i]; if (e == null) continue;
    const xl = sx(speeds[i] - dxs / 2), xr = sx(speeds[i] + dxs / 2);
    const yt = sy(torques[j] + dts / 2), yb = sy(torques[j] - dts / 2);
    cells.push(<rect key={j + "_" + i} x={xl} y={yt} width={Math.max(xr - xl + 0.6, 0.6)} height={Math.max(yb - yt + 0.6, 0.6)} fill={cellColor(e)} shapeRendering="crispEdges" />);
  }
  const envPts = env.x.map((xx, i) => sx(xx) + "," + sy(env.y[i])).join(" ");
  // 포락선 다각형으로 클리핑 → 곡선 경계의 계단/삐짐 제거
  const clipPoly = [[0, 0]].concat(env.x.map((xx, i) => [xx, Math.min(env.y[i], yMax)])).concat([[env.x[env.x.length - 1], 0]]);
  const clipStr = clipPoly.map(([xx, yy]) => sx(xx).toFixed(1) + "," + sy(yy).toFixed(1)).join(" ");
  const cbH = h - P.t - P.b;
  // iso-효율 등고선 (Motor-CAD 식): 정수 효율 레벨마다 선 + 주요 레벨 라벨
  const contourEls = [], labelEls = [];
  for (let lv = Math.ceil(lo + 1); lv <= Math.floor(top); lv++) {
    const segs = contourSegs(grid, speeds, torques, lv);
    if (!segs.length) continue;
    const major = lv % 2 === 0 || lv >= top - 3;
    segs.forEach((sg, si) => contourEls.push(
      <line key={"c" + lv + "_" + si} x1={sx(sg[0][0]).toFixed(1)} y1={sy(sg[0][1]).toFixed(1)} x2={sx(sg[1][0]).toFixed(1)} y2={sy(sg[1][1]).toFixed(1)}
        stroke="#1a1a1a" strokeWidth={major ? 0.7 : 0.4} opacity={major ? 0.55 : 0.3} />));
    // 라벨: 짝수(또는 최상위) 레벨만, 등고선의 중앙(median-y) 선분에 배치 → 구석 뭉침 방지
    if (lv % 2 === 0 || lv >= top - 1) {
      const sorted = segs.slice().sort((a, b) => a[0][1] - b[0][1]);
      const mid = sorted[Math.floor(sorted.length / 2)];
      labelEls.push(<text key={"cl" + lv} x={sx(mid[0][0]).toFixed(1)} y={sy(mid[0][1]).toFixed(1)} fontSize="8.5" fontWeight="bold" fill="#111" stroke="#fff" strokeWidth="0.6" paintOrder="stroke">{lv}</text>);
    }
  }
  return (
    <div className="rounded w-full" style={{ background: "#101a30", border: "1px solid #22304d" }}>
      <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>
        Efficiency Map <span className="font-normal" style={{ color: "#7e8eac" }}>속도-토크 효율 [%] (추정 · 손실 속도외삽: 철손 pE1.8·기타 ∝n)</span>
      </div>
      <svg width={Wp} height={h} style={{ display: "block" }}>
        <defs><clipPath id="effclip"><polygon points={clipStr} /></clipPath></defs>
        <rect x={P.l} y={P.t} width={Wp - P.l - P.r} height={cbH} fill="#1f2540" />
        <g clipPath="url(#effclip)">{cells}{contourEls}{labelEls}</g>
        <polyline fill="none" stroke="#111" strokeWidth="1.6" points={envPts} />
        {op && op.torque <= yMax && (() => {
          const lx = sx(op.speed), ly = sy(op.torque);
          const right = lx < (P.l + Wp - P.r) * 0.62;      // 오른쪽 여백 없으면 왼쪽에 표기
          const tx = right ? lx + 8 : lx - 8, anc = right ? "start" : "end";
          return <g><circle cx={lx} cy={ly} r="4.5" fill="#fff" stroke="#111" strokeWidth="1.8" />
            <text x={tx} y={ly - 6} fontSize="9.5" fontWeight="bold" fill="#111" textAnchor={anc}>정격 운전점</text>
            <text x={tx} y={ly + 5} fontSize="9" fill="#111" textAnchor={anc}>{Math.round(op.speed)}rpm · {op.torque.toFixed(2)}Nm · {op.eff != null ? op.eff.toFixed(1) + "%" : ""}</text>
          </g>;
        })()}
        {Array.from({ length: 6 }, (_, i) => { const xv = xMax * i / 5; return <text key={"x" + i} x={sx(xv)} y={h - P.b + 12} fontSize="9" fill="#7e8eac" textAnchor="middle">{Math.round(xv)}</text>; })}
        {Array.from({ length: 5 }, (_, i) => { const yv = yMax * i / 4; return <text key={"y" + i} x={P.l - 4} y={sy(yv) + 3} fontSize="9" fill="#7e8eac" textAnchor="end">{yv.toFixed(1)}</text>; })}
        <text x={(P.l + Wp - P.r) / 2} y={h - 2} fontSize="9" fill="#7e8eac" textAnchor="middle">Speed [rpm]</text>
        <text x={12} y={h / 2} fontSize="9" fill="#7e8eac" textAnchor="middle" transform={`rotate(-90 12 ${h / 2})`}>Torque [Nm]</text>
        {Array.from({ length: NB }, (_, i) => { const yy = P.t + (cbH * i) / NB; const tBand = 1 - (i + 0.5) / NB; return (
          <rect key={"cb" + i} x={Wp - P.r + 18} y={yy} width={14} height={cbH / NB + 0.6} fill={jetColor(tBand)} shapeRendering="crispEdges" />); })}
        {Array.from({ length: NB + 1 }, (_, i) => { const e = top - (span * i) / NB; const yy = P.t + (cbH * i) / NB; return (
          <text key={"cbt" + i} x={Wp - P.r + 35} y={yy + 3} fontSize="8" fill="#7e8eac">{i === NB ? "≤" + e.toFixed(0) : e.toFixed(1)}</text>); })}
      </svg>
    </div>
  );
}

function GraphsTab({ res, calc, solved }) {
  const data = useMemo(() => {
    if (!res) return null;
    const N = 241;
    const harm = [1, 3, 5, 7, 9, 11, 13];
    const a = res.magnetAlpha, s1 = Math.sin((Math.PI * a) / 2) || 1e-9;   // magnetArcED=0서 0/0 NaN 방어
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
    // pp 는 compute()에서 직접 받는다 (Ke/lambda 재추정은 lambda≈0서 0/0=NaN 전파).
    const pp = res.pp || Math.max(1, res.lambda ? Math.round(res.Ke / res.lambda) : 1);
    const lamF = res.lambda, Rf = res.Rphase;
    const kT = res.kTsat || 1;                                // FEMM 포화토크 보정(미보정=1)
    const LdF = res.Ld * 1e-3, LqF = res.Lq * 1e-3;          // mH → H
    const Vmax = (res.noLoadSpeed * 2 * Math.PI * res.Ke) / 60; // 가용 상전압(피크) = Vdc 기반
    const Imax = res.IphRms * Math.SQRT2;                       // 동작 상전류(피크) = 전류원 한계
    const nTop = res.noLoadSpeed * 1.15, NTN = 90, Nid = 121;
    const PEAKF = 1.6;                                          // 효율맵: 피크(과부하) 전류 용량 배수
    const ImaxMap = Imax * PEAKF;
    const maxTorqueAt = (n, Im) => {
      const wm = (n * 2 * Math.PI) / 60, we = pp * wm;
      let best = 0;
      for (let k = 0; k < Nid; k++) {
        const id = -Im * (k / (Nid - 1));                     // 0 → -Im (약계자)
        const iqCur = Math.sqrt(Math.max(Im * Im - id * id, 0)); // 전류원 한계
        // 전압타원: (R·id − we·Lq·iq)² + (R·iq + we·(Ld·id+λ))² = Vmax² → iq 2차식
        const a = (we * LqF) ** 2 + Rf * Rf;
        const b = 2 * Rf * we * ((LdF - LqF) * id + lamF);
        const c = (Rf * id) ** 2 + (we * (LdF * id + lamF)) ** 2 - Vmax * Vmax;
        let iqVolt = Infinity;
        if (a > 1e-12) { const disc = b * b - 4 * a * c; iqVolt = disc < 0 ? 0 : Math.max(0, (-b + Math.sqrt(disc)) / (2 * a)); }
        const iq = Math.max(0, Math.min(iqCur, iqVolt));
        const T = 1.5 * pp * (lamF * iq + (LdF - LqF) * id * iq) * kT;
        if (T > best) best = T;
      }
      return best;
    };
    const tnSpeed = [], tnTorque = [], tnPower = [], tnTorqueP = [];
    for (let i = 0; i < NTN; i++) {
      const n = (nTop * i) / (NTN - 1), T = maxTorqueAt(n, Imax);
      tnSpeed.push(n); tnTorque.push(T); tnPower.push((T * n * 2 * Math.PI) / 60);
      tnTorqueP.push(maxTorqueAt(n, ImaxMap));                 // 피크 전류 포락선(효율맵 경계)
    }
    const T0 = tnTorque[0], T0map = tnTorqueP[0];
    let baseSpeed = nTop;
    for (let i = 1; i < NTN; i++) { if (tnTorque[i] < 0.98 * T0) { baseSpeed = tnSpeed[i]; break; } }
    const tnPmax = Math.max(...tnPower);

    // ── 효율맵: (속도,토크) 격자에서 최소손실 운전점 효율 (전류원+전압타원 제약, MTPA 근사) ──
    // 피크 전류 용량(ImaxMap)까지 펼쳐 고토크 효율 하강을 포함 → 효율섬이 닫힘 (Motor-CAD 식).
    const NES = 88, NET = 60;
    const effSpeeds = Array.from({ length: NES }, (_, i) => (nTop * (i + 0.5)) / NES);
    const effTorques = Array.from({ length: NET }, (_, j) => (T0map * (j + 0.5)) / NET);
    const feRatio = (n) => (pp * n / 60) / Math.max(res.fe, 1e-6);
    const kacRated = (res.RacRdc || 1) - 1, nRated = Math.max(calc.speed, 1);
    const effGrid = effTorques.map((Tt) => effSpeeds.map((n) => {
      const wm = (n * 2 * Math.PI) / 60, we = pp * wm;
      const kac = 1 + kacRated * (n / nRated) ** 2;                  // AC 동손비(속도² 스케일)
      let bestPcu = Infinity, bestEff = 0, feasible = false;
      for (let k = 0; k <= 80; k++) {
        const id = -ImaxMap * (k / 80);
        const denom = lamF + (LdF - LqF) * id;
        if (Math.abs(denom) < 1e-9) continue;
        const iq = Tt / (1.5 * pp * denom * kT);                        // kT: 같은 토크에 더 큰 전류(포화)
        if (iq < 0 || id * id + iq * iq > ImaxMap * ImaxMap) continue;  // 전류 한계(피크)
        const Vd = Rf * id - we * LqF * iq, Vq = Rf * iq + we * (LdF * id + lamF);
        if (Vd * Vd + Vq * Vq > Vmax * Vmax) continue;                  // 전압 한계
        feasible = true;                                               // 운전 가능(포락선 내부)
        const Pcu = 1.5 * Rf * (id * id + iq * iq) * kac;              // AC 포함 동손
        if (Pcu < bestPcu) {
          bestPcu = Pcu;
          // 손실 속도 외삽(정격 기준, fr=1·n=정격에서 불변): 에디 고주파 완화 pE=1.8, 기타손실 속도비례 pO=1
          const fr = feRatio(n);
          // 약계자(id<0) 시 d축 자속 = λ+Ld·id 감소 → 철심 자속↓ → 철손↓ (자속비²). id=0서 1.
          const fluxR = lamF > 0 ? Math.max(0, (lamF + LdF * id) / lamF) : 1;
          const Pfe = (res.PfeHyst * fr + res.PfeEddy * Math.pow(fr, 1.8)) * fluxR * fluxR;
          const other = calc.otherLoss * (n / nRated);
          const Pem = Tt * wm, Pout = Pem - Pfe - other, Pin = Pem + Pcu;
          bestEff = Pout > 0 && Pin > 0 ? (Pout / Pin) * 100 : 0;       // 손실>출력이면 0 (빈칸 대신 최저색)
        }
      }
      return feasible ? bestEff : null;                                // 진짜 운전불가만 빈칸
    }));
    return { deg, eW, iW, tq, tAvg, ripple, slotX, m1, mTot, mag, chains,
      tnSpeed, tnTorque, tnPower, tnTorqueP, baseSpeed, tnPmax, opSpeed: calc.speed, opTorque: res.torque,
      effSpeeds, effTorques, effGrid };
  }, [res, calc]);
  if (!solved) return <div className="p-6 text-sm" style={{ color: "#7e8eac" }}>Calculation 탭에서 <b>Solve E-Magnetic Model</b>을 눌러 해석을 실행하면 파형이 표시됩니다.</div>;
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
          { x: data.slotX, y: data.mTot, color: "#9fb2d4", label: "Sum" },
          { x: data.slotX, y: data.m1, color: "#CC2222", label: "Ph1" },
        ]} />
      <Bars title="MMF Harmonics" sub="공간(기계) 고조파 [At] — 극쌍수에서 피크" values={data.mag} />
      <PhasorPlot chains={data.chains} />
      <Plot title="Torque–Speed Curve" sub={"기저속도 ~" + Math.round(data.baseSpeed) + " rpm · 정격점 " + Math.round(data.opSpeed) + "rpm / " + data.opTorque.toFixed(2) + "Nm"}
        series={[
          { x: data.tnSpeed, y: data.tnTorque, color: "#2244CC", label: "Max Torque [Nm]" },
          { x: [data.opSpeed, data.opSpeed], y: [0, data.opTorque], color: "#D98E04", label: "정격점 " + Math.round(data.opSpeed) + "rpm/" + data.opTorque.toFixed(2) + "Nm" },
        ]} />
      <Plot title="Power–Speed Curve" sub={"최대 출력 " + Math.round(data.tnPmax) + " W · 정격점 " + Math.round(data.opSpeed) + "rpm / " + Math.round(data.opTorque * data.opSpeed * 2 * Math.PI / 60) + "W"}
        series={[
          { x: data.tnSpeed, y: data.tnPower, color: "#1B7A2B", label: "Output Power [W]" },
          { x: [data.opSpeed, data.opSpeed], y: [0, data.opTorque * data.opSpeed * 2 * Math.PI / 60], color: "#D98E04", label: "정격점 " + Math.round(data.opTorque * data.opSpeed * 2 * Math.PI / 60) + "W" },
        ]} />
      <EffMap speeds={data.effSpeeds} torques={data.effTorques} grid={data.effGrid}
        env={{ x: data.tnSpeed, y: data.tnTorqueP }} op={{ speed: data.opSpeed, torque: data.opTorque, eff: res.eff }} />
      <div className="w-full text-xs" style={{ color: "#7e8eac" }}>
        모든 파형은 해석식 합성 추정치 — 슬롯팅·포화·코깅 미반영. 정밀 파형은 Motor-CAD/Maxwell FEA로 검증.
      </div>
    </div>
  );
}

// 소형 선형계 풀이 (가우스 소거) — 열 노드망 G·T=Q
function solveLin(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / piv; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => { const d = r[i]; return Math.abs(d) < 1e-12 ? NaN : r[n] / d; });   // 특이행렬→유한 garbage 대신 NaN(fmt가 "—" 표시)
}

// ─── Thermal 탭 (집중정수 열등가회로 6노드 — 부품별 온도, Motor-CAD식) ───────
function ThermalTab({ geo, wind, calc, res, therm, sT, solved }) {
  const data = useMemo(() => {
    if (!res) return null;
    const a = 0.003862, Ta = therm.ambient;
    const rhoRatio = (Tc) => (1 + a * (Tc - 20)) / (1 + a * (calc.Tcu - 20));
    const Lstk = geo.stackLength * 1e-3, Ns = geo.slotNumber;
    const Lend = Math.max((res.MLT / 2 - geo.stackLength) * 1e-3, 4e-3);                // 엔드와인딩 편측 길이
    const linedLen = (res.linerArea / Math.max(wind.linerThk, 1e-6)) * 1e-3;
    const Awall = Math.max(linedLen * Lstk * Ns, 1e-5);
    const Acu = Math.max(res.condPerSlot * res.condCSA * Ns * 1e-6, 1e-6);              // 전체 동선 단면
    const Dh = (therm.housingDia > 0 ? therm.housingDia : geo.statorLamDia + 8) * 1e-3;
    const Lh = (therm.housingLen > 0 ? therm.housingLen : geo.motorLength) * 1e-3;
    const Ahouse = Math.PI * Dh * Lh + 2 * (Math.PI / 4 * Dh * Dh);
    const Aint = Math.PI * (geo.statorLamDia * 1e-3) * Lstk;
    const Agap = Math.PI * (geo.statorBore * 1e-3) * Lstk;
    const Aend = Math.PI * (geo.statorBore * 1e-3) * Lend * 2;
    // 열저항 (K/W)
    const Rslot = (wind.linerThk * 1e-3 / therm.kLiner + 0.5e-3 / therm.kImpreg) / Awall;  // 활성권선↔철심
    const Rcuax = Lend / (385 * Acu);                                                       // 활성↔엔드(Cu 축전도)
    const Rendair = 1 / (20 * Math.max(Aend, 1e-4));                                        // 엔드↔하우징(엔드공간)
    const Ryoke = 1 / (therm.hContact * Aint) + (res.byDepth * 1e-3) / (therm.kSteel * Aint); // 철심↔하우징
    const Rconv = 1 / (therm.hConv * Ahouse);                                               // 하우징↔공기
    const Rgap = 1 / (40 * Math.max(Agap, 1e-4));                                           // 자석/로터↔철심(에어갭)
    const Rmr = (geo.magnetThickness * 1e-3) / (8 * Math.max(Agap * 0.7, 1e-4));            // 자석↔로터
    const Rbrg = 4.0;                                                                        // 로터↔하우징(베어링 근사)
    const g = (R) => 1 / Math.max(R, 1e-9);
    const g01 = g(Rcuax), g02 = g(Rslot), g13 = g(Rendair), g23 = g(Ryoke), g3a = g(Rconv), g42 = g(Rgap), g45 = g(Rmr), g53 = g(Rbrg);
    const actFrac = Math.min(Math.max(2 * geo.stackLength / res.MLT, 0.2), 0.85);
    const Pmag = calc.otherLoss * 0.5, Prot = calc.otherLoss * 0.5;   // 자석 vs 로터철손+마찰 (근사 분배)
    // 6노드 정상상태 (열-전기 반복): 0=활성권선 1=엔드와인딩 2=철심 3=하우징 4=자석 5=로터
    let Twavg = calc.Tcu, T = [Ta, Ta, Ta, Ta, Ta, Ta];
    for (let it = 0; it < 40; it++) {
      const Pcu = res.Pcu * rhoRatio(Twavg) * (res.RacRdc || 1), Pca = Pcu * actFrac, Pce = Pcu * (1 - actFrac);
      const G = [
        [g01 + g02, -g01, -g02, 0, 0, 0],
        [-g01, g01 + g13, 0, -g13, 0, 0],
        [-g02, 0, g02 + g23 + g42, -g23, -g42, 0],
        [0, -g13, -g23, g13 + g23 + g3a + g53, 0, -g53],
        [0, 0, -g42, 0, g42 + g45, -g45],
        [0, 0, 0, -g53, -g45, g45 + g53],
      ];
      const Q = [Pca, Pce, res.Pfe, g3a * Ta, Pmag, Prot];
      T = solveLin(G, Q);
      const newAvg = (Pca * T[0] + Pce * T[1]) / Math.max(Pcu, 1e-6);
      if (Math.abs(newAvg - Twavg) < 0.02) { Twavg = newAvg; break; } Twavg = newAvg;
    }
    const hot = Math.max(T[0], T[1]);
    const Pcu = res.Pcu * rhoRatio(Twavg) * (res.RacRdc || 1), Qtot = Pcu + res.Pfe + calc.otherLoss;
    // 온도-시간 포화곡선 (핫스팟 기준)
    // 시정수는 정상상태와 일관된 등가 열저항(권선→주위) 사용: Req=(hot−Ta)/Qtot.
    const Cth = res.mCopper * 385 + res.mStator * 460;
    const Req = Qtot > 0 ? (hot - Ta) / Qtot : (Ryoke + Rconv);
    const tau = Cth * Req;
    const Tss = hot, NPT = 60, tMax = tau * 5, tmin = [], temp = [];
    for (let i = 0; i <= NPT; i++) { const t = (tMax * i) / NPT; tmin.push(t / 60); temp.push(Ta + (Tss - Ta) * (1 - Math.exp(-t / tau))); }
    return { T, hot, Qtot, Rslot, Rcuax, Rendair, Ryoke, Rconv, Rgap, Ahouse, Dh: Dh * 1e3, Lh: Lh * 1e3, Cth, tau, Tss, tmin, temp };
  }, [geo, wind, calc, res, therm]);
  if (!solved) return <div className="p-6 text-sm" style={{ color: "#7e8eac" }}>Calculation 탭에서 <b>Solve E-Magnetic Model</b>을 누른 뒤 표시됩니다 (손실값 필요).</div>;
  if (!data) return <div className="p-4 text-sm">계산 불가 — 입력값 확인</div>;
  const TRow = ({ k, v, u, c }) => (   // ThermalTab 전용 행(U1: 모듈 Row 섀도잉 제거 위해 개명)
    <div className="flex items-center justify-between px-2 py-1 text-xs" style={{ borderTop: "1px solid #22304d" }}>
      <span style={{ color: "#7e8eac" }}>{k}</span>
      <span style={{ fontFamily: "JetBrains Mono,Consolas,monospace", fontWeight: 600, color: c || "#e6edf7" }}>{v}{u && <span style={{ color: "#7e8eac", fontWeight: 400 }}> {u}</span>}</span>
    </div>
  );
  const setCool = (t) => { sT("coolType", t); sT("hConv", COOL_H[t]); };
  // 하우징 축단면 열지도 (부품 온도로 색칠) — 치수 시각화 + 미니 thermal map
  const Rh = data.Dh / 2, Rsl = geo.statorLamDia / 2, Rb = geo.statorBore / 2;
  const Rro = (geo.statorBore - 2 * geo.airgap) / 2, Rsh = geo.shaftDia / 2, Rmi = Rro - geo.magnetThickness;
  const Lh = data.Lh, Lstk = geo.stackLength, Lend = Math.max(res.MLT / 2 - geo.stackLength, 4);
  const Wv = 520, Hv = 250, mxv = 22, xMx = Lh / 2 + Lend + 4, yMx = Rh + 4;
  const scv = Math.min((Wv - 2 * mxv) / (2 * xMx), (Hv - 2 * mxv) / (2 * yMx)), cxv = Wv / 2, cyv = Hv / 2;
  const SXv = (x) => cxv + x * scv, SYv = (r) => cyv - r * scv;
  const Tmn = therm.ambient, Tmx = Math.max(...data.T, Tmn + 1), tc = (T) => jetColor((T - Tmn) / (Tmx - Tmn));
  const band = (x0, x1, r0, r1, T, key, fillOverride) => {
    const f = fillOverride || tc(T);
    return [
      <rect key={key + "t"} x={SXv(x0)} y={SYv(r1)} width={(x1 - x0) * scv} height={(r1 - r0) * scv} fill={f} stroke="#00000066" strokeWidth="0.7" />,
      <rect key={key + "b"} x={SXv(x0)} y={SYv(-r0)} width={(x1 - x0) * scv} height={(r1 - r0) * scv} fill={f} stroke="#00000066" strokeWidth="0.7" />,
    ];
  };
  const parts = [
    ...band(-Lh / 2, Lh / 2, 0, Rsh, data.T[5], "sh", "#9AA4AE"),    // 샤프트(회색, 열원 아님)
    ...band(-Lh / 2, Lh / 2, Rsl, Rh, data.T[3], "hou"),
    ...band(-Lstk / 2, Lstk / 2, Rb, Rsl, data.T[2], "fe"),
    ...band(-Lstk / 2, Lstk / 2, Rb, Rb + 0.45 * (Rsl - Rb), data.T[0], "act"),
    ...band(-Lstk / 2 - Lend, -Lstk / 2, Rb, Rb + 0.6 * (Rsl - Rb), data.T[1], "ewl"),
    ...band(Lstk / 2, Lstk / 2 + Lend, Rb, Rb + 0.6 * (Rsl - Rb), data.T[1], "ewr"),
    ...band(-Lstk / 2, Lstk / 2, Rsh, Rmi, data.T[5], "rot"),         // 로터 철심
    ...band(-Lstk / 2, Lstk / 2, Rmi, Rro, data.T[4], "mag"),         // 자석(얇은 띠)
  ];
  return (
    <div className="flex h-full overflow-auto gap-3 p-3 items-start">
      <div className="w-72 flex-shrink-0">
        <fieldset className="rounded mb-2" style={{ border: "1px solid #22304d", background: "#101a30" }}>
          <legend className="text-xs font-bold px-1 ml-2" style={{ color: "#c4d0e4" }}>냉각 / 하우징</legend>
          <div className="text-xs font-semibold px-2 mt-1">냉각 방식:</div>
          <Radio group="cool" val="natural" label="자연대류 (h≈10)" cur={therm.coolType} onPick={setCool} />
          <Radio group="cool" val="forced" label="강제공냉 (h≈60)" cur={therm.coolType} onPick={setCool} />
          <Radio group="cool" val="conduction" label="전도방열 (h≈200)" cur={therm.coolType} onPick={setCool} />
          <NumIn label="대류계수 h [W/m²K]" value={therm.hConv} step={1} onChange={(v) => sT("hConv", v)} />
          <NumIn label="주위온도 [°C]" value={therm.ambient} step={1} onChange={(v) => sT("ambient", v)} />
          <NumIn label={"하우징 외경 [mm] (0=자동 " + (geo.statorLamDia + 8) + ")"} value={therm.housingDia} step={1} onChange={(v) => sT("housingDia", v)} />
          <NumIn label={"하우징 길이 [mm] (0=자동 " + geo.motorLength + ")"} value={therm.housingLen} step={1} onChange={(v) => sT("housingLen", v)} />
          <NumIn label="계면 접촉계수 [W/m²K]" value={therm.hContact} step={100} onChange={(v) => sT("hContact", v)} />
          <NumIn label="라이너 열전도 k [W/mK]" value={therm.kLiner} step={0.05} onChange={(v) => sT("kLiner", v)} />
          <NumIn label="함침 열전도 k [W/mK]" value={therm.kImpreg} step={0.05} onChange={(v) => sT("kImpreg", v)} />
        </fieldset>
        <div className="text-xs px-1" style={{ color: "#7e8eac" }}>집중정수 추정 · 자연대류 텍스트북 기본값. 절대값은 열 측정/FEA로 보정.</div>
      </div>
      <div className="w-80 flex-shrink-0">
        <div className="rounded" style={{ border: "1px solid #22304d", background: "#101a30" }}>
          <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>부품별 온도 (정상상태)</div>
          <div className="px-3 py-3 text-center" style={{ background: "#0a1120" }}>
            <div className="text-xs" style={{ color: "#7e8eac" }}>권선 핫스팟 포화온도 (예측)</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: data.hot > 130 ? "#ff5d6c" : "#2bd47a", fontFamily: "JetBrains Mono,Consolas,monospace" }}>{fmt(data.hot, 1)} °C</div>
          </div>
          <TRow k="권선 핫스팟" v={fmt(data.hot, 1)} u="°C" c="#B02020" />
          <TRow k="엔드와인딩" v={data.T[1].toFixed(1)} u="°C" c={data.T[1] >= data.T[0] ? "#B02020" : undefined} />
          <TRow k="활성권선(슬롯)" v={data.T[0].toFixed(1)} u="°C" />
          <TRow k="스테이터 철심" v={data.T[2].toFixed(1)} u="°C" />
          <TRow k="하우징" v={data.T[3].toFixed(1)} u="°C" />
          <TRow k="자석 (PM)" v={data.T[4].toFixed(1)} u="°C" c="#1B5E20" />
          <TRow k="로터" v={data.T[5].toFixed(1)} u="°C" />
          <TRow k="주위" v={therm.ambient.toFixed(1)} u="°C" />
          <TRow k="총 발열 Q" v={data.Qtot.toFixed(1)} u="W" />
          <div className="px-2 py-1 text-xs font-bold" style={{ borderTop: "2px solid #22304d", background: "#0c1424" }}>열저항 / 하우징</div>
          <TRow k="활성권선→철심 R" v={data.Rslot.toFixed(3)} u="K/W" />
          <TRow k="엔드→하우징 R" v={data.Rendair.toFixed(3)} u="K/W" />
          <TRow k="철심→하우징 R" v={data.Ryoke.toFixed(3)} u="K/W" />
          <TRow k="하우징→공기 R" v={data.Rconv.toFixed(3)} u="K/W" />
          <TRow k="에어갭 R" v={data.Rgap.toFixed(3)} u="K/W" />
          <TRow k="하우징(사용)" v={data.Dh.toFixed(0) + "×" + data.Lh.toFixed(0)} u="mm" />
          <TRow k="열 시정수 τ" v={fmt(data.tau / 60, 1)} u="분" />
        </div>
        {data.hot > 130 && <div className="text-xs mt-1 px-1" style={{ color: "#B02020" }}>⚠ 권선 핫스팟 과다 — 이 냉각방식으론 연속정격 불가. 강제공냉/전도방열 또는 하우징 확대 필요.</div>}
        {data.T[4] > 120 && <div className="text-xs mt-1 px-1" style={{ color: "#B02020" }}>⚠ 자석온도 {data.T[4].toFixed(0)}°C — 감자 위험. 자석 등급(내열) 확인.</div>}
        {Math.abs(data.hot - calc.Tcu) > 10 && <div className="text-xs mt-1 px-1" style={{ color: "#B5622D" }}>예측 권선온도 {data.hot.toFixed(0)}°C ≠ 입력 {calc.Tcu}°C. 정밀화하려면 Calculation의 Armature Winding Temp를 {data.hot.toFixed(0)}로 맞추고 재Solve.</div>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="rounded mb-2" style={{ background: "#101a30", border: "1px solid #22304d" }}>
          <div className="px-2 py-1 text-xs font-bold" style={{ borderBottom: "1px solid #22304d" }}>
            하우징 축단면 열지도 <span className="font-normal" style={{ color: "#7e8eac" }}>부품 온도 색칠 · 하우징 {data.Dh.toFixed(0)}×{data.Lh.toFixed(0)}mm</span>
          </div>
          <svg width={Wv} height={Hv} style={{ display: "block" }}>
            <rect x="0" y="0" width={Wv} height={Hv} fill="#F7F8FA" />
            <line x1={mxv} y1={cyv} x2={Wv - mxv} y2={cyv} stroke="#22304d" strokeDasharray="4 3" />
            {parts}
            <text x={SXv(0)} y={SYv(Rh) - 4} fontSize="9" fill="#7e8eac" textAnchor="middle">하우징 Ø{data.Dh.toFixed(0)} · 길이 {data.Lh.toFixed(0)}mm</text>
            <text x={SXv(0)} y={cyv + 3} fontSize="8" fill="#7e8eac" textAnchor="middle">샤프트</text>
            {[["하우징", data.T[3]], ["철심", data.T[2]], ["엔드와인딩", data.T[1]], ["자석", data.T[4]]].map(([l, T], i) => (
              <g key={i}><rect x={Wv - 96} y={10 + i * 14} width={10} height={10} fill={tc(T)} stroke="#0003" />
                <text x={Wv - 82} y={19 + i * 14} fontSize="8" fill="#333">{l} {T.toFixed(0)}°</text></g>
            ))}
          </svg>
          <div className="px-2 pb-1 text-xs" style={{ color: "#7e8eac" }}>파랑 {Tmn.toFixed(0)}° → 적색 {Tmx.toFixed(0)}° · 하우징 외경/길이를 바꾸면 단면이 변합니다.</div>
        </div>
        <Plot title="포화온도 예측 (온도–시간)" sub={"정상상태 " + fmt(data.Tss, 1) + "°C · 시정수 τ " + fmt(data.tau / 60, 1) + "분 · ≈" + fmt(5 * data.tau / 60, 0) + "분 후 포화"}
          h={300} series={[
            { x: data.tmin, y: data.temp, color: "#B02020", label: "Coil Temp [°C] vs 분" },
            { x: [0, data.tmin[data.tmin.length - 1]], y: [data.Tss, data.Tss], color: "#7e8eac", label: "포화온도" },
          ]} />
        <div className="text-xs mt-1 px-1" style={{ color: "#7e8eac" }}>고정 운전점에서 권선이 가열되며 정상상태(포화온도)로 수렴. τ = 열용량×열저항. Motor-CAD 포화온도 예측곡선 대응(추정).</div>
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
  const outer = geo.rotorType === "outer";
  const Rsb = outer ? RoL - geo.slotDepth : Rb + geo.slotDepth;                 // 슬롯 바닥
  const Rro = outer ? RoL + geo.airgap : Rb - geo.airgap;                       // 로터 공극면(자석 표면)
  const Rcan = outer ? Rro + geo.magnetThickness + (geo.rotorYoke || 0) : Rb - geo.airgap;  // 외전형 캔 외경
  const Rsh = geo.shaftDia / 2;
  // 외전형은 마커/엔드턴/단자/번호를 로터(바깥) 피해 보어 안쪽·슬롯 안쪽에 배치
  const Rlbl = outer ? Rb * 0.86 : RoL * 1.14;
  const RtS = outer ? Rb * 0.92 : RoL * 1.04, RtE = outer ? Rb * 0.52 : RoL * 1.40;
  const Rend = outer ? Rsb * 0.97 : RoL * 1.04, Rendc = outer ? Rsb * 0.78 : RoL * 1.22;
  const size = 540, C = size / 2, margin = 14;
  const worldR = (outer ? Rcan : RoL) * 1.45;
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
  const Rgo = outer ? RoL - geo.slotDepth * 0.34 : Rb + geo.slotDepth * 0.66, Rret = outer ? RoL - geo.slotDepth * 0.66 : Rb + geo.slotDepth * 0.34;
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
    const [gx, gy] = PR(Rend, ag), [rx, ry] = PR(Rend, ar);
    let am = (ag + ar) / 2;
    if (Math.abs(ar - ag) > Math.PI) am += Math.PI;   // 0/2π 경계 보정
    const [cx, cy] = PR(Rendc, am);
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
        const [sx, sy] = PR(RtS, a), [ex, ey] = PR(RtE, a);
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
      style={{ border: "1px solid #22304d", background: ph === v ? (v < 0 ? "#0c1424" : cols[v]) : "#0a1120", color: ph === v ? "#fff" : "#7e8eac", fontWeight: ph === v ? 600 : 400 }}>
      {label}
    </button>
  );
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center gap-1.5 px-3 py-1.5" style={{ borderBottom: "1px solid #22304d" }}>
        <span className="text-xs font-semibold mr-1" style={{ color: "#c4d0e4" }}>상 표시:</span>
        <Btn v={-1} label="전체" /><Btn v={0} label="Ph1" /><Btn v={1} label="Ph2" /><Btn v={2} label="Ph3" />
        <div className="flex-1" />
        <span className="text-xs" style={{ color: "#7e8eac" }}>× 들어감 · • 나옴 · 실선=엔드턴 · U1/V1/W1=In(상 시작) · U2/V2/W2=Out(상 끝)</span>
      </div>
      <div className="flex-1 flex items-center justify-center min-h-0 overflow-auto" style={{ background: "#101a30" }}>
        <svg width={size} height={size}>
          {outer ? (<>
            <circle cx={C} cy={C} r={Rcan * sc} fill="#CFF3F3" stroke="#0E8C8C" strokeWidth="0.8" />{/* 로터 캔(배경) */}
            {magPaths.map((d, i) => <path key={"m" + i} d={d} fill="#CDE8CD" stroke="#1E7A1E" strokeWidth="0.4" />)}
            <circle cx={C} cy={C} r={RoL * sc} fill="#FBE9E9" stroke="#B02020" strokeWidth="1.2" />{/* 스테이터(중심 덮음) */}
            <circle cx={C} cy={C} r={Rb * sc} fill="#0a1120" stroke="#B02020" strokeWidth="0.8" />
            {slotPaths.map((d, i) => <path key={"s" + i} d={d} fill="#FAF3C8" stroke="#998800" strokeWidth="0.5" />)}
          </>) : (<>
            <circle cx={C} cy={C} r={RoL * sc} fill="#FBE9E9" stroke="#B02020" strokeWidth="1.2" />
            <circle cx={C} cy={C} r={Rb * sc} fill="#0a1120" stroke="#B02020" strokeWidth="0.8" />
            {slotPaths.map((d, i) => <path key={"s" + i} d={d} fill="#FAF3C8" stroke="#998800" strokeWidth="0.5" />)}
            <circle cx={C} cy={C} r={Rro * sc} fill="#CFF3F3" stroke="#0E8C8C" strokeWidth="0.8" />
            {magPaths.map((d, i) => <path key={"m" + i} d={d} fill="#CDE8CD" stroke="#1E7A1E" strokeWidth="0.4" />)}
            <circle cx={C} cy={C} r={Rsh * sc} fill="#1a2740" stroke="#0E8C8C" strokeWidth="0.8" />
          </>)}
          {arcs}
          {marks}
          {terms}
          {Array.from({ length: Ns }, (_, k) => {
            const [lx, ly] = PR(Rlbl, ang(k));
            return <text key={"n" + k} x={lx} y={ly + 3} fontSize="10" fill="#7e8eac" textAnchor="middle">{k + 1}</text>;
          })}
        </svg>
      </div>
      <div className="flex items-center gap-4 px-3 py-1 text-xs" style={{ background: "#0c1424", color: "#9fb2d4", fontFamily: "JetBrains Mono,Consolas,monospace", borderTop: "1px solid #22304d" }}>
        <span>{Ns}슬롯 / {poles}극 · 3상 2층 Lap · Throw {wa.coils.length ? Math.abs(wa.coils[0].ret - wa.coils[0].go) || 1 : 1}</span>
        {wa.balanced === false && <span style={{ color: "#f5a524", fontWeight: 600 }}>⚠ 3상 불균형 권선 (상당 코일 {wa.coilsPerPhaseAll.join("/")}) — throw/슬롯·극수 확인</span>}
        <div className="flex-1" />
        <span>코일 {wa.coils.length}개 (상당 {wa.coilsPerPhase}) · kw1 {res.kw1.toFixed(4)}</span>
      </div>
    </div>
  );
}
