"""Terminal colors from TINA's existing dark theme; no color in JSON or pipes."""
import json
import os
from pathlib import Path
import sys

PALETTE = json.loads((Path(__file__).resolve().parents[3] / "branding/tokens.json").read_text())["theme"]["dark"]


def rgb(token):
    value = PALETTE[token].lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


def xterm_index(token):
    steps = [0, 95, 135, 175, 215, 255]
    colors = [(16 + 36 * r + 6 * g + b, (red, green, blue))
              for r, red in enumerate(steps) for g, green in enumerate(steps) for b, blue in enumerate(steps)]
    colors += [(232 + i, (8 + i * 10,) * 3) for i in range(24)]
    target = rgb(token)
    return min(colors, key=lambda item: sum((a - b) ** 2 for a, b in zip(item[1], target)))[0]


def paint(text, token="brand", *, stream=None, bold=False):
    stream = sys.stdout if stream is None else stream
    if "NO_COLOR" in os.environ or os.environ.get("TERM") == "dumb" or not stream.isatty():
        return text
    if os.environ.get("COLORTERM") in {"truecolor", "24bit"}:
        color = "38;2;" + ";".join(map(str, rgb(token)))
    elif "256color" in os.environ.get("TERM", ""):
        color = "38;5;" + str(xterm_index(token))
    else:
        color = "32" if token not in {"muted", "rejected", "draft"} else {"muted": "37", "rejected": "31", "draft": "33"}[token]
    return f"\033[{('1;' if bold else '')}{color}m{text}\033[0m"


def curses_theme(curses):
    attrs = {"text": 0, "brand": curses.A_BOLD, "muted": 0,
             "selected": curses.A_REVERSE | curses.A_BOLD, "line": 0}
    originals = {}
    try:
        if "NO_COLOR" in os.environ or not curses.has_colors():
            return attrs, lambda: None
        curses.start_color()
        tokens = ["canvas", "ink", "brand", "muted", "line", "on-brand"]
        colors = {}
        custom = curses.COLORS >= 256 and curses.can_change_color()
        for i, token in enumerate(tokens):
            if custom:
                index = curses.COLORS - len(tokens) + i
                originals[index] = curses.color_content(index)
                curses.init_color(index, *(round(component * 1000 / 255) for component in rgb(token)))
            elif curses.COLORS >= 256:
                index = xterm_index(token)
            else:
                index = {"canvas": curses.COLOR_BLACK, "on-brand": curses.COLOR_BLACK,
                         "brand": curses.COLOR_GREEN, "line": curses.COLOR_GREEN,
                         "ink": curses.COLOR_WHITE, "muted": curses.COLOR_WHITE}[token]
            colors[token] = index
        for pair, (role, foreground, background) in enumerate([
            ("text", "ink", "canvas"), ("brand", "brand", "canvas"),
            ("muted", "muted", "canvas"), ("selected", "on-brand", "brand"),
            ("line", "line", "canvas"),
        ], 1):
            curses.init_pair(pair, colors[foreground], colors[background])
            attrs[role] = curses.color_pair(pair)
        attrs["brand"] |= curses.A_BOLD
        attrs["selected"] |= curses.A_BOLD
    except curses.error:
        pass

    def restore():
        for index, color in originals.items():
            try:
                curses.init_color(index, *color)
            except curses.error:
                pass
    return attrs, restore
