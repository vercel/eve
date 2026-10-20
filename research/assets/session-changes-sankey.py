"""Renders the overview's two sankeys (v27, reactions) as one SVG, both at the same scale.

Labels sit outside their boxes: a removed area's label to the left, an added area's to the right.
Colors carry meaning: red for what went away, blue for what was written, green for the net saving.
"""

import sys
from html import escape

PANELS = [
    (
        "v27 (PRs 1–10), production lines by area",
        "v27",
        [
            ("Old v26 protocol and builders", 2832),
            ("Client reducers", 1558),
            ("HITL candidates and coordinator", 1099),
            ("Instrumentation state", 380),
            ("Channel card model and handlers", 206),
            ("Private usage tallies", 214),
            ("Checkpoint migrations and legacy", 144),
        ],
        [
            ("Read model", 1999),
            ("Event contract", 1825),
            ("Writer and session machine", 1169),
            ("Other v27 additions", 366),
            ("Dev checker", 331),
            ("Temporary dynamic adapter", 212),
        ],
        ("Net removed by v27", 531),
    ),
    (
        "Reactions (#4616), production lines by area",
        "Reactions",
        [
            ("Per-kind lifecycles", 2253),
            ("Durable callbacks and tool rebuilding", 1266),
            ("Closure transforms", 1045),
            ("Other reactions deletions", 640),
            ("Participants and change points", 463),
            ("Memory state", 297),
        ],
        [
            ("Runner and kinds", 2672),
            ("Definitions", 233),
        ],
        ("Net removed by reactions", 3059),
    ),
]

REMOVED = "#cf222e"
ADDED = "#0969da"
SAVED = "#1a7f37"
MIDDLE = "#57606a"
TEXT = "#1f2328"
MUTED = "#57606a"

WIDTH = 1080
SCALE = 0.055  # px per line
GAP = 7  # px between stacked nodes
NODE_W = 14
X_LEFT = 330  # left nodes' x
X_MID = (WIDTH - NODE_W) / 2
X_RIGHT = WIDTH - 310 - NODE_W
TITLE_H = 34
PANEL_GAP = 36
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"


def fmt(n: int) -> str:
    return f"{n:,}"


def band(x0, y0a, y0b, x1, y1a, y1b, color):
    """A filled band from [y0a, y0b] at x0 to [y1a, y1b] at x1."""
    mx = (x0 + x1) / 2
    d = (
        f"M{x0:.1f},{y0a:.1f} C{mx:.1f},{y0a:.1f} {mx:.1f},{y1a:.1f} {x1:.1f},{y1a:.1f} "
        f"L{x1:.1f},{y1b:.1f} C{mx:.1f},{y1b:.1f} {mx:.1f},{y0b:.1f} {x0:.1f},{y0b:.1f} Z"
    )
    return f'<path d="{d}" fill="{color}" fill-opacity="0.55"/>'


def column_height(items):
    return sum(v for _, v in items) * SCALE + GAP * (len(items) - 1)


LABEL_STEP = 17  # px between label centers


def spread(centers):
    """Pushes label centers down so neighbours keep at least LABEL_STEP between them."""
    out = list(centers)
    for i in range(1, len(out)):
        out[i] = max(out[i], out[i - 1] + LABEL_STEP)
    return out


def label(x, y, anchor, name, value, color):
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" dominant-baseline="middle">'
        f'<tspan fill="{TEXT}">{escape(name)}</tspan>'
        f'<tspan fill="{color}" font-weight="600" dx="6">{fmt(value)}</tspan></text>'
    )


def panel(top, title, middle, removed, added, saved):
    out = [
        f'<text x="{WIDTH / 2:.1f}" y="{top + 14:.1f}" text-anchor="middle" font-size="15" '
        f'font-weight="600" fill="{TEXT}">{escape(title)}</text>'
    ]
    right = added + [saved]
    total = sum(v for _, v in removed)
    assert total == sum(v for _, v in right), (title, total, sum(v for _, v in right))
    body_top = top + TITLE_H
    h_left = column_height(removed)
    h_right = column_height(right)
    h_mid = total * SCALE
    h = max(h_left, h_right, h_mid)
    mid_top = body_top + (h - h_mid) / 2

    # Left: what went away, into the middle node.
    y = body_top + (h - h_left) / 2
    y_in = mid_top
    centers = []
    for name, value in removed:
        hh = value * SCALE
        out.append(band(X_LEFT + NODE_W, y, y + hh, X_MID, y_in, y_in + hh, REMOVED))
        out.append(f'<rect x="{X_LEFT}" y="{y:.1f}" width="{NODE_W}" height="{hh:.1f}" fill="{REMOVED}"/>')
        centers.append(y + hh / 2)
        y += hh + GAP
        y_in += hh

    for (name, value), c in zip(removed, spread(centers)):
        out.append(label(X_LEFT - 8, c, "end", name, value, REMOVED))

    # Right: what the step wrote, and the net it saved.
    y = body_top + (h - h_right) / 2
    y_out = mid_top
    centers = []
    for i, (name, value) in enumerate(right):
        color = SAVED if i == len(right) - 1 else ADDED
        hh = value * SCALE
        out.append(band(X_MID + NODE_W, y_out, y_out + hh, X_RIGHT, y, y + hh, color))
        out.append(f'<rect x="{X_RIGHT}" y="{y:.1f}" width="{NODE_W}" height="{hh:.1f}" fill="{color}"/>')
        centers.append((y + hh / 2, color))
        y += hh + GAP
        y_out += hh

    for (name, value), c, (_, color) in zip(right, spread([c for c, _ in centers]), centers):
        out.append(label(X_RIGHT + NODE_W + 8, c, "start", name, value, color))

    out.append(f'<rect x="{X_MID:.1f}" y="{mid_top:.1f}" width="{NODE_W}" height="{h_mid:.1f}" fill="{MIDDLE}"/>')
    out.append(
        f'<text x="{X_MID + NODE_W / 2:.1f}" y="{mid_top - 8:.1f}" text-anchor="middle" '
        f'font-weight="600" fill="{TEXT}" paint-order="stroke" stroke="#ffffff" stroke-width="5" '
        f'stroke-linejoin="round">{escape(middle)} · {fmt(total)}</text>'
    )
    return out, TITLE_H + h + 4


def legend(top):
    items = [(REMOVED, "removed"), (ADDED, "written"), (SAVED, "net saving")]
    out, x = [], WIDTH / 2 - 150
    for color, text in items:
        out.append(f'<rect x="{x:.1f}" y="{top:.1f}" width="12" height="12" rx="2" fill="{color}"/>')
        out.append(f'<text x="{x + 18:.1f}" y="{top + 6:.1f}" dominant-baseline="middle" fill="{MUTED}">{text}</text>')
        x += 110
    return out


def main(path):
    parts, top = [], 16
    for title, middle, removed, added, saved in PANELS:
        body, h = panel(top, title, middle, removed, added, saved)
        parts += body
        top += h + PANEL_GAP
    parts += legend(top - PANEL_GAP / 2)
    height = top - PANEL_GAP / 2 + 28
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{height:.0f}" '
        f'viewBox="0 0 {WIDTH} {height:.0f}" font-family="{FONT}" font-size="13">\n'
        f'<rect width="100%" height="100%" rx="6" fill="#ffffff"/>\n'
        + "\n".join(parts)
        + "\n</svg>\n"
    )
    open(path, "w").write(svg)


main(sys.argv[1])
