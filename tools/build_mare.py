#!/usr/bin/env python3
"""月の海の輪郭データ（data/mare.json）を生成するスクリプト。

入力: LROC Global Mare Boundaries（Nelson et al. 2014）の -180〜180 版シェープファイル
  https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/SHAPEFILE/LROC_GLOBAL_MARE/LROC_GLOBAL_MARE_180.ZIP

使い方:
  python3 tools/build_mare.py path/to/LROC_GLOBAL_MARE_180.SHP

出力形式:
  {"levels":[{"tol":度, "rings":[[名前番号, x0, y0, dx1, dy1, ...], ...]}, ...], "names":[...]}
  座標は経度・緯度を 100 倍した整数で、2 点目以降は前の点との差分。
"""
import json
import math
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dbf import read_dbf  # noqa: E402

OUT = os.path.join(HERE, "..", "data", "mare.json")
MAX_ABS_LON = 105.0
# 簡略化の許容誤差（度）。粗い版は全体表示用、細かい版は拡大時用。
LEVELS = [0.12, 0.025]
# この面積（km²）未満の小さな海の断片は粗い版では省く
MIN_AREA_COARSE = 400.0

# LROC の海の名前（ラテン語）→ 日本語。features.json の名前と揃える。
def norm_name(s):
    return re.sub(r"[^a-z ]", "", s.lower()).strip()


# LROC 側の表記ゆれ・部分名の対応
ALIASES = {
    "Lacus Somniorium": "Lacus Somniorum",
    "Oceanus Procellarum - south": "Oceanus Procellarum",
    "Mare Orientale - south": "Mare Orientale",
    "Cognitum East": "Mare Cognitum",
    "Mare Temporis": "Lacus Temporis",
    "South Pole Aitken Basin": "",
    "Lacus Perseveramtiae": "Lacus Perseverantiae",
}
EXTRA_JA = {"Lacus Solitudinis": "荒野の湖", "Artamonov": "アルタモノフ"}
DIRS = {"East": "東", "West": "西", "North": "北", "South": "南"}


def load_ja_names():
    path = os.path.join(HERE, "..", "data", "features.json")
    feats = json.load(open(path))["features"]
    m = {}
    m.update(EXTRA_JA)
    for f in feats:
        m.setdefault(f[1], f[0])
        m.setdefault(norm_name(f[1]), f[0])
    return m


def ja_name(ja, latin):
    latin = ALIASES.get(latin, latin)
    if not latin:
        return "", ""
    hit = ja.get(latin) or ja.get(norm_name(latin))
    if not hit:
        mm = re.match(r"^(.+) (East|West|North|South)$", latin)
        if mm:
            base = ja.get(mm.group(1)) or ja.get(norm_name(mm.group(1)))
            if base:
                hit = base + DIRS[mm.group(2)]
    return hit or latin, latin


def read_shp_polygons(path):
    """シェープファイル（ポリゴン, type 5）を読み、レコードごとのリング一覧を返す。"""
    data = open(path, "rb").read()
    pos = 100
    out = []
    while pos < len(data):
        _, clen = struct.unpack(">ii", data[pos:pos + 8])
        pos += 8
        rec = data[pos:pos + clen * 2]
        pos += clen * 2
        stype = struct.unpack("<i", rec[0:4])[0]
        if stype == 0:
            out.append([])
            continue
        if stype not in (5, 15, 25):
            raise ValueError(f"unsupported shape type {stype}")
        nparts, npts = struct.unpack("<ii", rec[36:44])
        parts = list(struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts]))
        p0 = 44 + 4 * nparts
        pts = struct.unpack(f"<{2 * npts}d", rec[p0:p0 + 16 * npts])
        rings = []
        for i, s in enumerate(parts):
            e = parts[i + 1] if i + 1 < nparts else npts
            rings.append([(pts[2 * k], pts[2 * k + 1]) for k in range(s, e)])
        out.append(rings)
    return out


def simplify(pts, tol):
    """Douglas-Peucker（経度方向は cos(緯度) で縮めて距離を測る）。"""
    if len(pts) < 4:
        return pts
    lat0 = sum(p[1] for p in pts) / len(pts)
    c = math.cos(math.radians(lat0))
    xy = [(p[0] * c, p[1]) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if L == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * (px - ax) - dx * (py - ay)) / L
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(pts, keep) if k]


def ring_area_km2(pts):
    lat0 = sum(p[1] for p in pts) / len(pts)
    c = math.cos(math.radians(lat0))
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i - 1]
        x2, y2 = pts[i]
        s += (x1 * c) * y2 - (x2 * c) * y1
    k = math.radians(1) * 1737.4
    return abs(s) / 2 * k * k


def main(shp_path):
    dbf_path = shp_path[:-4] + ".DBF"
    if not os.path.exists(dbf_path):
        dbf_path = shp_path[:-4] + ".dbf"
    _, recs = read_dbf(dbf_path)
    polys = read_shp_polygons(shp_path)
    ja = load_ja_names()
    names = []
    name_idx = {}
    levels = []
    for li, tol in enumerate(LEVELS):
        rings_out = []
        npts = 0
        for rec, rings in zip(recs, polys):
            latin = (rec.get("MARE_NAME") or "").strip()
            for ring in rings:
                if not ring or all(abs(p[0]) > MAX_ABS_LON for p in ring):
                    continue
                if li == 0 and ring_area_km2(ring) < MIN_AREA_COARSE:
                    continue
                sp = simplify(ring, tol)
                if len(sp) < 4:
                    continue
                if latin not in name_idx:
                    name_idx[latin] = len(names)
                    names.append(list(ja_name(ja, latin)))
                q = [name_idx[latin]]
                px = py = None
                for lon, lat in sp:
                    x, y = round(lon * 100), round(lat * 100)
                    if px is None:
                        q += [x, y]
                    else:
                        q += [x - px, y - py]
                    px, py = x, y
                rings_out.append(q)
                npts += len(sp)
        levels.append({"tol": tol, "rings": rings_out})
        print(f"level tol={tol}: {len(rings_out)} rings, {npts} points")
    with open(OUT, "w") as f:
        json.dump({
            "source": "LROC Global Mare Boundaries (Nelson et al. 2014, LPSC 45, 2861)",
            "names": names,
            "levels": levels,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"-> {os.path.normpath(OUT)} ({os.path.getsize(OUT) // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
