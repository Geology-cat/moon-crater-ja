#!/usr/bin/env python3
"""月面地名データ（data/features.json）を生成するスクリプト。

入力:
  - USGS Gazetteer of Planetary Nomenclature の月の地名ポイント（DBF）
    https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip
  - tools/sources/ 以下の日本語名ソース（Wikidata / 日本語版 Wikipedia）
  - tools/names_manual.json（手作業の補完・表記の上書き）

使い方:
  python3 tools/build_features.py path/to/MOON_nomenclature_center_pts.dbf
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dbf import read_dbf  # noqa: E402

SRC = os.path.join(HERE, "sources")
OUT = os.path.join(HERE, "..", "data", "features.json")

# 表側（秤動で見える範囲を含む）の経度範囲
MAX_ABS_LON = 100.0


def lon180(v):
    v = float(v)
    return v - 360.0 if v > 180.0 else v


def clean_ja(s):
    """Wikidata/Wikipedia の日本語名から曖昧さ回避の括弧などを除く。"""
    if not s:
        return None
    s = re.sub(r"\s*[\(（].*?[\)）]", "", s)
    s = re.sub(r"\{\{.*$", "", s)
    s = re.sub(r"(クレーター|火口)$", "", s)
    s = s.strip().strip("・").strip()
    s = s.replace(" ", "")
    if not s or re.search(r"[A-Za-z{}()|]", s):
        return None
    return s


def load_known(recs):
    gid2ja = {}
    for fn in ("wikidata_moon_ja.json", "wikidata_gpn_ja.json"):
        for b in json.load(open(os.path.join(SRC, fn)))["results"]["bindings"]:
            v = b.get("ja") or b.get("jw")
            c = clean_ja(v["value"]) if v else None
            if c:
                gid2ja.setdefault(b["gid"]["value"], c)
    known = {}
    for r in recs:
        gid = r["link"].rsplit("/", 1)[-1]
        if gid in gid2ja:
            known.setdefault(r["clean_name"], gid2ja[gid])
    for k, v in json.load(open(os.path.join(SRC, "jawiki_lists.json"))).items():
        c = clean_ja(v)
        if c:
            known.setdefault(k, c)
    for k, v in json.load(open(os.path.join(SRC, "enwiki_crater_langlinks.json"))).items():
        c = clean_ja(v)
        # 小地名が山のページへ転送されているものは除く
        if c and not c.endswith("山"):
            known.setdefault(k, c)
    return known


# 地形の種類を表す語と日本語の接尾辞
SUFFIX = {
    "Rima": "谷", "Rimae": "谷群", "Vallis": "谷",
    "Dorsum": "尾根", "Dorsa": "尾根群",
    "Catena": "クレーター列",
    "Mons": "山", "Montes": "山脈",
    "Promontorium": "岬", "Rupes": "崖",
}
PFX_RE = re.compile(r"^(" + "|".join(SUFFIX) + r") (.+)$")
SAT_RE = re.compile(r"^(.+?)\s+([A-Z]{1,2})$")


def main(dbf_path):
    _, recs = read_dbf(dbf_path)
    manual = {k: v for k, v in json.load(open(os.path.join(HERE, "names_manual.json"))).items()
              if not k.startswith("_")}
    known = load_known(recs)

    def base_ja(name):
        if name in manual:
            return manual[name]
        if name in known:
            return known[name]
        m = PFX_RE.match(name)
        if m:
            b = base_ja(m.group(2))
            if b:
                return b + SUFFIX[m.group(1)]
        return None

    out = []
    missing = []
    for r in recs:
        if not r["approval"].startswith("Adopted"):
            continue
        lon = lon180(r["center_lon"])
        if abs(lon) > MAX_ABS_LON:
            continue
        name = r["clean_name"]
        code = r["code"]
        ja = None
        if code == "SF":
            m = SAT_RE.match(name)
            if m:
                b = base_ja(m.group(1))
                if b:
                    ja = b + m.group(2)
        if ja is None:
            ja = base_ja(name)
        if ja is None:
            missing.append(name)
            ja = name  # 日本語名がないときはラテン名のまま
        d = float(r["diameter"] or 0)
        # 経度・緯度の広がり（海の大きさの目安）
        try:
            ext = [round(lon180(r["min_lon"]), 2), round(lon180(r["max_lon"]), 2),
                   round(float(r["min_lat"]), 2), round(float(r["max_lat"]), 2)]
        except ValueError:
            ext = None
        rec = [ja, r["name"], round(lon, 4), round(float(r["center_lat"]), 4), round(d, 2), code]
        if code in ("ME", "OC", "LC", "SI", "PA", "PL", "MO", "RU", "VA", "RI", "DO", "CA") and ext:
            rec.append(ext)
        out.append(rec)

    out.sort(key=lambda x: -x[4])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        f.write('{"source":"IAU/USGS Gazetteer of Planetary Nomenclature; 日本語名: Wikidata, 日本語版Wikipedia, 手作業による補完",\n')
        f.write('"fields":["ja","name","lon","lat","diam_km","code","extent[lon_min,lon_max,lat_min,lat_max]"],\n"features":[\n')
        f.write(",\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in out))
        f.write("\n]}\n")
    print(f"{len(out)} features -> {os.path.normpath(OUT)}")
    print(f"日本語名なし: {len(missing)}", missing[:50])


if __name__ == "__main__":
    main(sys.argv[1])
