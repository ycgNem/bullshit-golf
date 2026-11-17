"""Golf texture recipes on top of the procedural-pbr-assets texkit (numpy only).

One height field in metres per material; everything else derives from it.
"""
import os
import sys

import numpy as np

SKILL = os.path.join(os.path.expanduser("~"), ".claude", "skills", "procedural-pbr-assets", "scripts")
sys.path.insert(0, SKILL)
import noise as nz                       # noqa: E402
import texkit as tk                      # noqa: E402
from pngio import write_png              # noqa: E402

ss, C, mix, finish = nz.smoothstep, tk.C, tk.mix, tk.finish


def turf(N, tile, seed, count, wpx, lpx, pal, soil, hmax, dens_lo=0.6, clump=7, straw=0.0, rough=0.7,
         nstr=0.6, tone=0.05):
    """Mown or rough turf from above: thousands of blade strokes over soil."""
    ps = tile / N
    k = N / 1024
    X, Y = nz.grid(N)
    rng = np.random.default_rng(seed)
    soilc = C(*soil) * tk.tint_noise(X, Y, 8, 4, seed + 1, 0.12)[..., None]
    H = 0.0015 * nz.fbm(X, Y, 6, 4, seed + 2)
    dens = ss(-0.5, 0.3, nz.fbm(X, Y, clump, 4, seed + 3)) * (1 - dens_lo) + dens_lo
    pal = np.array(pal, np.float32)
    strokes = []
    want = int(count * k * k)
    while len(strokes) < want:
        x, y = rng.uniform(0, N, 2)
        if rng.random() > dens[int(y) % N, int(x) % N]:
            continue
        a = rng.uniform(0, 2 * np.pi)
        L = rng.uniform(*lpx) * k
        c = pal[rng.integers(0, len(pal))] * rng.uniform(0.86, 1.14)
        if rng.random() < straw:
            c = np.array((0.56, 0.50, 0.29), np.float32) * rng.uniform(0.85, 1.1)
        strokes.append((x, y, x + np.cos(a) * L, y + np.sin(a) * L, rng.uniform(*wpx) * max(k, 0.6),
                        rng.uniform(0.3, 1.0) * hmax, c))
    hg, colg, cov = nz.draw_strokes((N, N), strokes)
    H = H + hg
    base = mix(soilc, colg, np.clip(cov * 1.8, 0, 1))
    ao = nz.cavity_ao(H, [(2, hmax * 0.6, 0.7), (10, hmax * 1.5, 0.5)])
    base *= (0.62 + 0.38 * ao)[..., None]
    base *= tk.tint_noise(X, Y, 3, 3, seed + 6, tone)[..., None]
    r = rough + 0.15 * (1 - np.clip(cov * 1.8, 0, 1)) + 0.06 * (1 - ao)
    return finish(H, base, r, np.zeros_like(H), ps, nstr=nstr, ao=ao, pre_blur=0.5)


def fairway(N, tile, seed=4101):
    """Fairway cut, 12 mm: dense short blades, even colour."""
    return turf(N, tile, seed, 75000, (0.9, 1.4), (6, 14),
                [(0.33, 0.47, 0.13), (0.29, 0.43, 0.11), (0.37, 0.51, 0.16), (0.31, 0.44, 0.10), (0.40, 0.53, 0.19)],
                (0.24, 0.21, 0.14), 0.006, dens_lo=0.75)


def green(N, tile, seed=4202):
    """Putting surface, 3 mm: very fine, nearly uniform, slightly paler."""
    return turf(N, tile, seed, 120000, (0.8, 1.1), (4, 9),
                [(0.36, 0.52, 0.17), (0.34, 0.50, 0.15), (0.39, 0.54, 0.19), (0.35, 0.49, 0.14)],
                (0.27, 0.30, 0.15), 0.002, dens_lo=0.9, rough=0.62, nstr=0.5, tone=0.03)


def rough(N, tile, seed=4303):
    """Rough, 60-100 mm: long clumpy blades, darker, some straw, soil in the gaps."""
    return turf(N, tile, seed, 34000, (1.3, 2.3), (16, 46),
                [(0.22, 0.33, 0.09), (0.19, 0.29, 0.07), (0.26, 0.37, 0.11), (0.24, 0.32, 0.08), (0.30, 0.39, 0.13)],
                (0.18, 0.15, 0.10), 0.03, dens_lo=0.3, clump=9, straw=0.07, rough=0.72, nstr=0.9, tone=0.08)


def sand(N, tile, seed=4404):
    """Bunker sand: rake furrows at 55 mm, footprints, fine grain."""
    ps = tile / N
    X, Y = nz.grid(N)
    wob = 0.012 * nz.fbm(X, Y, 3, 3, seed) + 0.003 * nz.fbm(X, Y, 12, 2, seed + 1)
    furrow = 0.5 + 0.5 * np.sin(2 * np.pi * 36 * (Y + wob))
    raked = ss(-0.25, 0.25, nz.fbm(X, Y, 3, 3, seed + 2))
    feet = tk.blobs(N, 12, 0.03, 0.055, seed + 5, soft=1.3)
    H = (0.007 * furrow ** 1.5 * raked * (1 - feet) + 0.004 * nz.fbm(X, Y, 5, 4, seed + 3)
         + 0.0006 * nz.fbm(X, Y, 200, 2, seed + 4) - 0.012 * feet)
    grain = nz.fbm(X, Y, 400, 1, seed + 6)
    ao = nz.cavity_ao(H, [(3, 0.004, 0.6), (14, 0.012, 0.5)])
    base = C(0.76, 0.70, 0.56) * tk.tint_noise(X, Y, 4, 4, seed + 7, 0.05)[..., None] * (1 + 0.07 * grain)[..., None]
    base = mix(base, C(0.67, 0.60, 0.46), ss(0.2, 0.7, nz.fbm(X, Y, 6, 3, seed + 8)) * 0.4)
    base *= (0.8 + 0.2 * ao)[..., None]
    return finish(H, base, 0.92 + 0.04 * grain, np.zeros_like(H), ps, nstr=1.0, ao=ao)


def bark(N, tile, seed=4505):
    """Oak-like bark: long vertical plates split by dark fissures."""
    ps = tile / N
    X, Y = nz.grid(N)
    Wd = nz.Worley2((16, 5), seed, jitter=0.95)
    Xw = X + 0.02 * nz.fbm(X, Y, 8, 3, seed + 1)
    F1, F2, idx, _, _ = Wd(Xw * 16, Y * 5)
    r = Wd.rand(idx)
    edge = ss(0.0, 0.16, F2 - F1)
    H = edge * 0.006 + r[..., 0] * 0.002 + 0.0012 * nz.fbm(X, Y, 30, 3, seed + 2)
    ao = nz.cavity_ao(H, [(2, 0.003, 0.7), (8, 0.008, 0.5)])
    base = mix(C(0.20, 0.16, 0.12), C(0.36, 0.31, 0.26), r[..., 1])
    base = mix(base, C(0.40, 0.44, 0.33), ss(0.5, 0.8, nz.fbm(X, Y, 5, 3, seed + 3)) * 0.35)
    base *= (0.45 + 0.55 * ao)[..., None]
    return finish(H, base, 0.86 + 0.08 * r[..., 2], np.zeros_like(H), ps, nstr=1.2, ao=ao)


def wood(N, tile, seed=4606):
    """Oiled hardwood bench slats; grain runs along U."""
    ps = tile / N
    X, Y = nz.grid(N)
    Yw = Y + 0.012 * nz.fbm(X, Y, 3, 4, seed) + 0.002 * nz.fbm(X, Y, 30, 2, seed + 1)
    rings = (Yw * 70) % 1.0
    late = ss(0.55, 0.85, rings) * (1 - ss(0.85, 0.98, rings))
    checks = tk.scratch_field(N, 30, (60, 400), (0.6, 1.2), seed + 2, angle=0.0, angle_jitter=0.03)
    H = -late * 0.0003 + 0.0002 * nz.fbm(X, Y, 50, 2, seed + 3) - checks * 0.0008
    weather = ss(-0.2, 0.5, nz.fbm(X, Y, 3, 4, seed + 4))
    base = mix(C(0.50, 0.36, 0.22), C(0.55, 0.50, 0.43), weather * 0.6)
    base = mix(base, C(0.30, 0.21, 0.13), late * 0.55)
    base = mix(base, C(0.14, 0.11, 0.09), checks)
    base *= tk.tint_noise(X, Y, 8, 3, seed + 5, 0.06)[..., None]
    return finish(H, base, 0.62 + 0.2 * weather, np.zeros_like(H), ps, nstr=1.0,
                  ao_scales=[(2, 0.0004, 0.6), (8, 0.001, 0.4)])


def leaves_rgba(N=512, seed=4707):
    """Leaf-cluster card with alpha: twigs fanning from the bottom, ovate leaves along them."""
    rng = np.random.default_rng(seed)
    pal = np.array([(0.24, 0.40, 0.11), (0.28, 0.44, 0.13), (0.21, 0.36, 0.10), (0.34, 0.49, 0.16),
                    (0.26, 0.39, 0.09), (0.38, 0.51, 0.18)], np.float32)
    k = N / 512
    col = np.zeros((N, N, 3), np.float32)
    cov = np.zeros((N, N), np.float32)
    lo, hi = 14 * k, N - 14 * k

    def leaf(x, y, a, L):
        x1, y1 = x + np.cos(a) * L, y + np.sin(a) * L
        if not (lo < x < hi and lo < x1 < hi and 4 < y < hi and 4 < y1 < hi):
            return
        W = L * rng.uniform(0.2, 0.27)
        c = pal[rng.integers(0, len(pal))] * rng.uniform(0.8, 1.15)
        xs = np.arange(max(0, int(min(x, x1) - W - 2)), min(N, int(max(x, x1) + W + 3)))
        ys = np.arange(max(0, int(min(y, y1) - W - 2)), min(N, int(max(y, y1) + W + 3)))
        gx, gy = np.meshgrid(xs + 0.5, ys + 0.5)
        t = ((gx - x) * np.cos(a) + (gy - y) * np.sin(a)) / L
        s = (-(gx - x) * np.sin(a) + (gy - y) * np.cos(a))
        w = W * np.sin(np.pi * np.clip(t, 0, 1) ** 0.75) ** 0.8 + 0.6
        m = np.clip((w - np.abs(s)) / 1.2, 0, 1) * (t > 0) * (t < 1)
        rib = 1 + 0.3 * np.exp(-(s / (1.0 * k)) ** 2)
        vein = 1 + 0.07 * np.cos((np.abs(s) * 0.9 + t * L * 0.5) * 1.1 / k)
        shade = (0.8 + 0.25 * t) * rib * vein * (0.85 + 0.15 * (s > 0))
        iy, ix = ys[:, None], xs[None, :]
        cur = col[iy, ix]
        col[iy, ix] = cur * (1 - m[..., None]) + (c[None, None, :] * shade[..., None]) * m[..., None]
        cov[iy, ix] = np.maximum(cov[iy, ix], m)

    def twig(p, q, w):
        seg = nz.draw_segments((N, N), [(p[0], p[1], q[0], q[1], w, 1.0)])
        col[:] = col * (1 - seg[..., None]) + np.array((0.22, 0.16, 0.10), np.float32) * seg[..., None]
        cov[:] = np.maximum(cov, seg)

    root = np.array((0.5 * N, 0.07 * N))
    for t in range(11):
        a = np.pi / 2 + (t - 5) * 0.23 + rng.uniform(-0.06, 0.06)
        L = rng.uniform(0.6, 0.86) * N
        p = root.copy()
        steps = 11
        for s in range(steps):
            a += rng.uniform(-0.12, 0.12)
            q = p + np.array((np.cos(a), np.sin(a))) * L / steps
            if lo < q[0] < hi and q[1] < hi:
                twig(p, q, 2.4 * k * (1 - s / steps) + 0.9)
            if s > 0:
                for side in (-1, 1):
                    leaf(q[0], q[1], a + side * rng.uniform(0.45, 1.0), rng.uniform(30, 50) * k)
            p = q
    for _ in range(330):
        r, a = 0.36 * N * np.sqrt(rng.random()), rng.uniform(0, 2 * np.pi)
        leaf(0.5 * N + r * np.cos(a), 0.54 * N + r * np.sin(a) * 0.95, rng.uniform(0, 2 * np.pi), rng.uniform(28, 46) * k)
    alpha = ss(0.25, 0.6, cov)
    mean = (col * alpha[..., None]).sum((0, 1)) / max(alpha.sum(), 1.0)
    rgb = np.where(cov[..., None] > 0.05, col / np.maximum(cov, 0.05)[..., None], mean[None, None, :])
    return np.concatenate([np.clip(rgb, 0, 1), alpha[..., None]], -1)


def water(N, tile, seed=4808):
    """Ripple normal for ponds and the river (scrolled in two layers by the game)."""
    ps = tile / N
    X, Y = nz.grid(N)
    H = 0.014 * nz.fbm(X, Y, 6, 4, seed) + 0.006 * nz.ridged(X, Y, 12, 3, seed + 1) ** 2
    base = np.ones((N, N, 3), np.float32) * C(0.03, 0.07, 0.06)
    return finish(H, base, np.full_like(H, 0.05), np.zeros_like(H), ps, nstr=1.0, pre_blur=1.0)


def gator(N, tile, seed=4909):
    """Alligator hide: domed olive scales with dark creases."""
    ps = tile / N
    X, Y = nz.grid(N)
    W, (F1, F2, idx, _, _) = nz.warped_worley(X, Y, 22, seed, warp=0.3)
    r = W.rand(idx)
    edge = ss(0.0, 0.14, F2 - F1)
    H = edge * 0.003 * (0.6 + 0.4 * r[..., 0]) + (1 - ss(0.0, 0.5, F1)) * 0.0025 + 0.0004 * nz.fbm(X, Y, 60, 2, seed + 1)
    ao = nz.cavity_ao(H, [(2, 0.002, 0.7), (8, 0.004, 0.5)])
    base = mix(C(0.13, 0.16, 0.08), C(0.25, 0.27, 0.13), r[..., 1])
    base = mix(base, C(0.30, 0.26, 0.16), ss(0.3, 0.7, nz.fbm(X, Y, 4, 3, seed + 2)) * 0.35)
    base *= (0.45 + 0.55 * ao)[..., None]
    return finish(H, base, 0.42 + 0.25 * r[..., 2], np.zeros_like(H), ps, nstr=1.3, ao=ao)


RECIPES = {
    "Fairway": (fairway, 1024, 2.0, "fairway and tee cut"),
    "Green": (green, 1024, 1.0, "putting surface"),
    "Rough": (rough, 1024, 3.0, "rough"),
    "Sand": (sand, 1024, 2.0, "bunkers"),
    "Bark": (bark, 512, 1.0, "tree trunks"),
    "Wood": (wood, 1024, 2.0, "bench slats, posts"),
    "Concrete": (tk.concrete, 1024, 4.0, "cart path"),
    "Paint": (tk.paint, 1024, 1.0, "painted steel and plastic"),
    "Steel": (tk.steel, 512, 1.0, "bare steel"),
    "Water": (water, 512, 4.0, "pond and river ripples"),
    "Gator": (gator, 512, 0.6, "alligator hide"),
}


def run(out_dir, only=None, force=False):
    os.makedirs(out_dir, exist_ok=True)
    todo = {n: r for n, r in RECIPES.items()
            if (only is None or n in only) and (force or only or not os.path.exists(os.path.join(out_dir, f"T_{n}_ORM.png")))}
    if todo:
        tk.run(out_dir, recipes=todo)
    lp = os.path.join(out_dir, "T_Leaves_BaseColor.png")
    if force or not os.path.exists(lp) or (only and "Leaves" in only):
        write_png(lp, leaves_rgba())


if __name__ == "__main__":
    a = sys.argv[1:]
    run(a[0], only=set(a[a.index("--only") + 1].split(",")) if "--only" in a else None, force="--force" in a)
