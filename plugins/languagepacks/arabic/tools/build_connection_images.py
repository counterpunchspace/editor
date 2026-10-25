#!/usr/bin/env python3
"""Draw the Add Glyphs preview images for the Arabic connection sets.

Each image is a sample word set in the pack font (``data/arabic.babelfont``,
built from Fustat). The two glyphs a connection substitutes are blue, the
rest black. Rerun after editing the connection outlines:

    python3 plugins/languagepacks/arabic/tools/build_connection_images.py
"""
import json
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "counterpunch_arabic" / "data"
FONT = json.loads((DATA / "arabic.babelfont").read_text())
BY = {g["name"]: g for g in FONT["glyphs"]}
BLACK, BLUE = "#000000", "#1F6FEB"

def layer(name):
    return BY[name]["layers"][0]

def anchor(name, aname):
    for a in layer(name).get("anchors", []):
        if a["name"] == aname:
            return a["x"], a["y"]
    raise KeyError((name, aname))

def contour_d(nodes, dx, dy):
    f = lambda n: f"{n['x'] + dx:g} {-(n['y'] + dy):g}"
    start = next(i for i, n in enumerate(nodes) if n["nodetype"] != "OffCurve")
    seq = nodes[start + 1:] + nodes[:start + 1]
    d, off = [f"M{f(nodes[start])}"], []
    for n in seq:
        t = n["nodetype"]
        if t == "OffCurve":
            off.append(n); continue
        if t == "Line" or not off:
            d.append(f"L{f(n)}")
        elif len(off) == 2:
            d.append(f"C{f(off[0])} {f(off[1])} {f(n)}")
        elif len(off) == 1:
            d.append(f"Q{f(off[0])} {f(n)}")
        else:
            raise ValueError(off)
        off = []
    return "".join(d) + "Z"

def glyph_d(name, dx, dy):
    out = []
    for s in layer(name)["shapes"]:
        if "nodes" in s:
            out.append(contour_d(s["nodes"], dx, dy))
        else:
            raise ValueError(f"component in {name}")
    return "".join(out)

def bbox(name, dx, dy):
    pts = [(n["x"] + dx, n["y"] + dy) for s in layer(name)["shapes"] for n in s["nodes"]]
    return pts

def render(word, out):
    """word: logical-order list of (base, [(mark, anchor)], blue)."""
    total = sum(layer(b)["width"] for b, _, _ in word)
    x = total
    parts, pts = [], []
    for base, marks, blue in word:
        x -= layer(base)["width"]
        color = BLUE if blue else BLACK
        d = glyph_d(base, x, 0)
        pts += bbox(base, x, 0)
        for mark, an in marks:
            bx, by = anchor(base, an)
            mx, my = anchor(mark, "_" + an)
            d += glyph_d(mark, x + bx - mx, by - my)
            pts += bbox(mark, x + bx - mx, by - my)
        parts.append(f'  <path fill="{color}" d="{d}"/>')
    pad = 40
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    x0, x1 = min(xs) - pad, max(xs) + pad
    y0, y1 = min(ys) - pad, max(ys) + pad
    vb = f"{x0:g} {-y1:g} {x1 - x0:g} {y1 - y0:g}"
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">\n' + "\n".join(parts) + "\n</svg>\n"
    (DATA / out).write_text(svg)
    print(f"Wrote {out}")

# خبر: khah, beh (high connection), reh (high connection)
render([
    ("hah-ar.init", [("dotAbove-ar", "top")], False),
    ("behDotless-ar.medi.conn-high1-1", [("dotBelow-ar", "bottom")], True),
    ("reh-ar.fina.conn-high1-2", [], True),
], "conn-high1.svg")
# لحم: lam and hah (hah connection), meem
render([
    ("lam-ar.init.conn-hah-1", [], True),
    ("hah-ar.medi.conn-hah-2", [], True),
    ("meem-ar.fina", [], False),
], "conn-hah.svg")
