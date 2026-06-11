"""해석 엔진 검증 — 1250W-jk Motor-CAD FEA 결과 대비 (numpy 필요)"""
import numpy as np

Ns, poles = 18, 16; pp = poles // 2
Bore, g, lm, mur = 79.66, 0.5, 3.6, 1.05
LamDia, arcED, Br = 114.0, 145.0, 1.225
Lstk, Lmag = 30.0, 27.9
so, tw, sd = 0.56, 4.6, 14.2
Nc, throw = 12, 1
speed, Iph_pk = 3200, 20.25
alpha = arcED / 180

taus = np.pi * Bore / Ns
gam = (so / g) ** 2 / (5 + so / g); kc = taus / (taus - gam * g)
Bg = Br * lm / (lm + mur * kc * g)

theta = np.array([(i * pp * 360.0 / Ns) % 360 for i in range(Ns)])
coil = [np.exp(1j * np.radians(theta[i])) - np.exp(1j * np.radians(theta[(i + throw) % Ns])) for i in range(Ns)]
sec = (np.floor((np.degrees(np.angle(coil)) % 360) / 60)).astype(int)
A = [(i, +1 if s == 0 else -1) for i, s in enumerate(sec) if s in (0, 3)]
def kw(h):
    s = sum(sg * (np.exp(1j * np.radians(h * theta[i])) - np.exp(1j * np.radians(h * theta[(i + throw) % Ns]))) for i, sg in A)
    return abs(s) / (2 * len(A))

klk = 0.97
Nph = (Ns / 3) * Nc; D = Bore - g; taup = np.pi * D / poles
lam = (2 / np.pi) * kw(1) * Nph * (alpha * Bg * klk) * (taup * 1e-3) * (Lmag * 1e-3)
fe = speed / 60 * pp

print(f"kw1 = {kw(1):.5f}  (ref 0.94521)")
print(f"kw3 = {kw(3):.5f}  (ref 0.57735)")
print(f"lambda = {lam*1e3:.2f} mVs  (ref 15.70)")
print(f"BEMF pk = {2*np.pi*fe*lam:.2f} V  (ref 42.09)")
print(f"Torque = {1.5*pp*lam*Iph_pk:.3f} Nm  (ref 3.816)")
