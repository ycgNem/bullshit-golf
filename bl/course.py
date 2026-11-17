"""Holes as numpy fields: height in metres and surface masks, sampled at any (x, y).

Every hole plays along +Y from its tee. Shared by the Blender build and (as exported grids) by the
game, so physics and picture agree.
"""
import sys

import numpy as np

sys.path.insert(0, __import__("os").path.join(__import__("os").path.expanduser("~"), ".claude", "skills", "procedural-pbr-assets", "scripts"))
import noise as nz                       # noqa: E402

ss = nz.smoothstep
S = 1024.0
INF = 1e9


def _n(x, y, feat, octv, seed):
    """fBm with features of about `feat` metres."""
    return nz.fbm((x / S + 0.5).astype(np.float32), (y / S + 0.5).astype(np.float32), max(2, int(round(S / feat))), octv, seed)


def sd_blob(x, y, cx, cy, rx, ry, rot, seed, wob=0.14):
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = x - cx, y - cy
    u, v = (dx * c + dy * s) / rx, (-dx * s + dy * c) / ry
    ang = np.arctan2(v, u)
    w = 1 + wob * (0.6 * np.sin(2 * ang + seed) + 0.4 * np.sin(3 * ang + seed * 2.3))
    return (np.hypot(u, v) - w) * min(rx, ry)


def blob_outline(cx, cy, rx, ry, rot, seed, wob=0.14, scale=1.0, n=72):
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    w = (1 + wob * (0.6 * np.sin(2 * a + seed) + 0.4 * np.sin(3 * a + seed * 2.3))) * scale
    u, v = w * np.cos(a) * rx, w * np.sin(a) * ry
    return np.stack([cx + u * np.cos(rot) - v * np.sin(rot), cy + u * np.sin(rot) + v * np.cos(rot)], 1)


def sd_path(x, y, pts):
    """pts: [((x, y), half_width)] -> signed distance to the widened polyline."""
    d = np.full(np.shape(x), INF)
    for (a, wa), (b, wb) in zip(pts[:-1], pts[1:]):
        ax, ay, bx, by = a[0], a[1], b[0], b[1]
        ex, ey = bx - ax, by - ay
        t = np.clip(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey), 0, 1)
        d = np.minimum(d, np.hypot(x - ax - t * ex, y - ay - t * ey) - (wa + t * (wb - wa)))
    return d


def catmull(pts, step=4.0):
    """Smooth a polyline into points about `step` metres apart."""
    P = np.array(pts, float)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        n = max(2, int(np.linalg.norm(p2 - p1) / step))
        for t in np.arange(n) / n:
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return np.array(out)


class Hole:
    def __init__(self, **kw):
        self.pond = self.river = None
        self.river_w = 8.0
        self.paths = []
        self.__dict__.update(kw)
        self.river_pts = catmull(self.river, 4.0) if self.river else None

    @property
    def cup(self):
        return self.pins[0]

    def grid(self, step=None):
        step = step or self.step
        x0, x1, y0, y1 = self.bounds
        return np.meshgrid(np.arange(x0, x1 + 1e-6, step), np.arange(y0, y1 + 1e-6, step))

    def height(self, x, y):
        return self.fields(np.asarray(x, float), np.asarray(y, float))["h"]

    def fields(self, x, y):
        x = np.asarray(x, np.float64)
        y = np.asarray(y, np.float64)
        sd = self.seed
        d_f = np.full(x.shape, INF)
        for seg in self.fairways:
            d_f = np.minimum(d_f, sd_path(x, y, seg))
        d_f = d_f + 2.6 * _n(x, y, 23, 2, sd + 21)
        gx, gy = self.green[0], self.green[1]
        d_g = sd_blob(x, y, *self.green, wob=0.10)
        tx, ty = self.tee
        d_t = np.maximum(np.abs(x - tx) - 5.0, np.abs(y - ty) - 7.0)
        d_b = np.full(x.shape, INF)
        for b in self.bunkers:
            d_b = np.minimum(d_b, sd_blob(x, y, *b, wob=0.2))
        d_p = sd_blob(x, y, *self.pond, wob=0.16) if self.pond else np.full(x.shape, INF)
        if self.river:
            d_r = sd_path(x, y, [((p[0], p[1]), self.river_w) for p in self.river_pts]) + 1.6 * _n(x, y, 30, 2, sd + 41)
        else:
            d_r = np.full(x.shape, INF)
        d_c = np.full(x.shape, INF)
        for p in self.paths:
            d_c = np.minimum(d_c, sd_path(x, y, [(q, 1.2) for q in p]))
        d_c = np.where(d_r < 1.5, INF, d_c)                                    # the bridge carries the path over water

        xl, xr, yf, yb = self.rim
        rimd = np.maximum.reduce([x - xr, xl - x, y - yb, yf - y])
        rim = ss(0, 40, rimd) * ss(4, 30, d_r)
        h = self.base + self.amp * _n(x, y, 100, 3, sd + 11) + 0.3 * _n(x, y, 23, 3, sd + 12) - self.slope * (y - ty) * (1 - rim)
        h += 10 * rim ** 1.2 + 2.5 * rim * _n(x, y, 36, 3, sd + 13)
        d_w = np.minimum(d_p, d_r)
        wp = ss(12, 0, d_w)
        h = h * (1 - wp) + self.bank_z * wp
        h -= 2.6 * ss(1.0, -5.0, d_w)
        wt = ss(4.5, -0.5, d_t)
        h = h * (1 - wt) + self.tee_z * wt
        gz, gsy, gsx = self.green_plane
        tgt = gz + gsy * (y - gy) + gsx * (x - gx) + 0.10 * _n(x, y, 14, 2, sd + 14)
        wg = ss(7, -1, d_g)
        h = h * (1 - wg) + tgt * wg
        lip = 0.22 * np.exp(-(np.maximum(d_b, 0) / 1.6) ** 2)
        h += np.where(d_b > 0, lip, 0.22 - 0.55 * ss(0, 1.0, -d_b) - 0.40 * ss(0.8, 3.0, -d_b) + 0.03 * _n(x, y, 6, 2, sd + 15))

        sand = ss(0.12, -0.12, d_b)
        green = ss(0.12, -0.12, d_g) * (1 - sand)
        path = ss(0.08, -0.08, d_c)
        fair = np.maximum.reduce([ss(0.35, -0.35, d_f), ss(1.9, 1.5, d_g), ss(0.2, -0.2, d_t)])
        fair = fair * (1 - green) * (1 - sand) * (1 - path) * ss(0.5, 2.5, d_w)
        h -= 0.04 * path
        rgh = np.clip(1 - fair - green - sand - path, 0, 1)
        h += 0.035 * rgh * _n(x, y, 4.6, 2, sd + 16)

        def band(a, w):
            return np.tanh(3.0 * np.sin(np.pi * (x * np.cos(a) + y * np.sin(a)) / w))
        is_tee = ss(0.2, -0.2, d_t)
        st_fair = 0.25 * (band(0.62, 2.6) + band(-0.62, 2.6))
        stripe = 0.5 + 0.62 * st_fair * fair * (1 - is_tee) + 0.16 * band(1.25, 0.56) * green + 0.2 * band(0.0, 0.56) * is_tee
        macro = 0.5 + 0.5 * _n(x, y, 32, 4, sd + 31)
        macro = macro * (1 - 0.6 * sand) + 0.3 * sand
        wet = ss(2.5, 0.0, d_w)                                               # damp, darker ground at the water's edge
        macro = macro * (1 - 0.55 * wet) * (1 - 0.4 * np.exp(-(d_b / 0.22) ** 2))
        return dict(h=h, fair=fair, green=green, sand=sand, path=path, rough=rgh, stripe=stripe, macro=macro,
                    d_f=d_f, d_g=d_g, d_t=d_t, d_b=d_b, d_p=d_p, d_r=d_r, d_w=d_w, d_c=d_c, rim=rim)


H7 = Hole(
    key="h7", number=7, par=3, name="Widow's Pond", seed=0, step=0.5, mask_step=0.125,
    bounds=(-90.0, 90.0, -125.0, 155.0), rim=(-52, 52, -110, 100),
    tee=(0.0, -95.0), tee_z=3.0, pins=[(7.25, 65.25), (-2.25, 58.25), (9.25, 56.75)],
    base=0.8, amp=1.5, slope=0.012, bank_z=-0.9, water_z=-1.25,
    fairways=[[((0, -72), 9.0), ((-4, -40), 13.0), ((-6, -5), 15.0), ((-2, 25), 13.0), ((3, 44), 9.0), ((4, 51), 8.0)]],
    green=(4, 62, 13, 11, 0.4, 0.7), green_plane=(0.6, 0.016, 0.010),
    bunkers=[(-11, 49, 6.0, 4.0, 0.5, 1.0), (24, 63, 4.5, 6.5, -0.3, 2.0), (0, 80.5, 5.5, 3.2, 0.1, 3.0)],
    pond=(31, 10, 17, 11, 0.5, 5.0),
    paths=[[(-13, -118), (-15, -95), (-25, -72), (-30, -30), (-29, 10), (-25, 45), (-22, 70), (-13, 88)]],
    cart=(-16.2, -92.0, 113.5), tree_gap=30.0,
)

H8 = Hole(
    key="h8", number=8, par=5, name="Gator Alley", seed=100, step=1.0, mask_step=0.25,
    bounds=(-105.0, 115.0, -50.0, 525.0), rim=(-72, 84, -32, 492),
    tee=(0.0, 0.0), tee_z=5.0, pins=[(-1.5, 463.5), (-7.5, 457.5), (4.5, 468.5)],
    base=2.2, amp=1.8, slope=0.004, bank_z=-0.2, water_z=-0.75,
    fairways=[[((0, 28), 10.0), ((-8, 90), 17.0), ((-5, 170), 19.0), ((4, 250), 17.0), ((2, 320), 18.0), ((-4, 366), 14.0)],
              [((-6, 424), 9.0), ((-3, 446), 9.0)]],
    green=(-2, 462, 14, 12, 0.3, 1.9), green_plane=(1.6, 0.014, -0.012),
    bunkers=[(-29, 150, 7.0, 4.5, 1.2, 1.0), (27, 236, 5.0, 7.5, 0.2, 2.0), (-24, 338, 6.0, 4.0, 0.4, 3.0),
             (-22.5, 456, 4.5, 6.0, 0.2, 4.0), (18.5, 470, 5.5, 4.0, 1.0, 5.0), (-4, 482.5, 6.0, 3.2, 0.0, 6.0)],
    river=[(64, -80), (50, 0), (60, 80), (44, 160), (57, 240), (42, 320), (22, 372), (-18, 402), (-60, 410), (-130, 398)],
    river_w=8.0,
    paths=[[(-13, -30), (-15, 0), (-30, 45), (-40, 150), (-36, 260), (-32, 340), (-32, 388), (-32, 428), (-26, 448), (-22, 474)]],
    bridge=((-32, 393.0), (-32, 417.0)),
    cart=(-17.0, 6.0, 108.4), tree_gap=55.0,
)

HOLES = {"h7": H7, "h8": H8}
