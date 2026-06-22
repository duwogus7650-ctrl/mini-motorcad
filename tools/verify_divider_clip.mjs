// 코일 디바이더가 직선/호 슬롯 바닥을 관통하지 않는지 검증 (App.jsx packConductors/draw 기하 복제)
// 정상 + 퇴화(few-slot/wide-tooth/초후막 디바이더) 케이스 모두 점검. 실행: node tools/verify_divider_clip.mjs

function dividerGeom(P, W) {
  const Rb = P.statorBore / 2, Rd = Rb + P.slotDepth;
  const dlt = Math.PI / P.slotNumber;
  const sD = Math.sin(dlt), cD = Math.cos(dlt);
  const halfOp = P.slotOpening / 2;
  const x1 = Math.sqrt(Math.max(Rb * Rb - halfOp * halfOp, 0));
  const liner = W.linerThk, divHalf = W.coilDivider / 2;
  const wedgeHold = W.wedgeModel === "wound" ? 0 : W.wedgeDepth;
  const xMin = x1 + P.toothTipDepth + wedgeHold + liner;
  const RdL = Rd - liner;
  const straight = P.slotBottomShape === "straight";

  const tEnd0 = Rd * cD;
  const ax = tEnd0 * cD + sD * P.toothWidth / 2, ay = tEnd0 * sD - cD * P.toothWidth / 2;
  const bnx = ay, bny = Rd - ax, blen = Math.hypot(bnx, bny) || 1, bc = ay * Rd;
  const blc = bc - liner * blen;

  let divApexX, divEdgeX;
  if (straight) {
    divApexX = blc / bnx;
    divEdgeX = (blc - bny * divHalf) / bnx;
  } else {
    divApexX = RdL;
    divEdgeX = Math.sqrt(Math.max(RdL * RdL - divHalf * divHalf, 0));
  }
  // App.jsx draw step 5 와 동일
  const gMar = 0.2;
  const apX = Math.max(xMin, divApexX - gMar);
  const edX = Math.max(xMin, Math.min(divEdgeX - gMar, apX));
  const poly = [[xMin, divHalf], [edX, divHalf], [apX, 0], [edX, -divHalf], [xMin, -divHalf]];

  // signed distance(+ = 바닥 바깥/관통). 직선=라이너선, 호=반경.
  const overshoot = (x, y) => straight
    ? (bnx * x + bny * y - blc) / blen
    : Math.hypot(x, y) - RdL;
  const maxOver = Math.max(...poly.map(([x, y]) => overshoot(x, y)));
  const allFinite = poly.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const ordered = edX <= apX + 1e-9 && apX >= xMin - 1e-9 && edX >= xMin - 1e-9;
  return { ay, xMin, divApexX, divEdgeX, apX, edX, poly, maxOver, allFinite, ordered };
}

const GEOMS = [
  { name: "정상 18슬롯", P: { statorBore: 79.66, slotDepth: 14.2, slotNumber: 18, toothWidth: 4.6, slotOpening: 0.56, toothTipDepth: 0.5 } },
  { name: "정상 12슬롯", P: { statorBore: 79.66, slotDepth: 14.2, slotNumber: 12, toothWidth: 6.0, slotOpening: 0.56, toothTipDepth: 0.5 } },
  { name: "few-slot 6/넓은치", P: { statorBore: 60, slotDepth: 10, slotNumber: 6, toothWidth: 8.0, slotOpening: 1.0, toothTipDepth: 0.5 } },
  { name: "얕은슬롯+초후막", P: { statorBore: 79.66, slotDepth: 6, slotNumber: 18, toothWidth: 4.6, slotOpening: 0.56, toothTipDepth: 0.5 } },
];
const wbase = { linerThk: 0.25, wedgeDepth: 0.2, wedgeModel: "wedge" };

let fail = 0, invalidGeom = 0;
for (const { name, P } of GEOMS) {
  console.log(`\n=== ${name} ===`);
  for (const shape of ["straight", "arc"]) {
    for (const cd of [0.5, 3.0, 10.0]) {
      const g = dividerGeom({ ...P, slotBottomShape: shape }, { ...wbase, coilDivider: cd });
      // ay<=0 은 치가 슬롯피치보다 넓다는 뜻 → 슬롯 자체가 성립 안 함(내 변경 이전부터 퇴화). 별도 분류.
      const degenerate = g.ay <= 1e-6;
      const ok = g.allFinite && g.ordered && g.maxOver <= 1e-6;
      const verdict = degenerate ? "⚠(무효형상-기존)" : (ok ? "✅" : "❌");
      if (degenerate) invalidGeom++; else if (!ok) fail++;
      console.log(
        `  ${shape.padEnd(8)} divider=${cd.toString().padStart(4)} | ay=${g.ay.toFixed(2)} ` +
        `apX=${g.apX.toFixed(2)} edX=${g.edX.toFixed(2)} maxOvershoot=${g.maxOver.toFixed(3)}mm ` +
        `finite=${g.allFinite} ordered=${g.ordered} ${verdict}`);
    }
  }
}
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL ${fail}건`} — 유효형상에서 디바이더 바닥 비관통/좌표유한/순서정합` +
  (invalidGeom ? ` (무효형상 ${invalidGeom}건은 ay≤0: 치>슬롯피치, 내 변경과 무관한 기존 퇴화)` : ""));
process.exit(fail === 0 ? 0 : 1);
