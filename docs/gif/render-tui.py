"""The README's terminal GIF from keel TUI's full-screen captures (docs/gif/record-tui.sh): each <name>.ansi is one
screen with keel's colours; it is drawn in a small terminal window (Menlo, keel's dark palette) and held for a while,
then the frames become one GIF.

    uv run --with pillow --with pyte --with fonttools python docs/gif/render-tui.py <captures folder> <out.gif>
"""

from __future__ import annotations

import sys
from pathlib import Path

import pyte
from fontTools.ttLib import TTCollection, TTFont
from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = 110, 30
SIZE = 15
FONTS = Path("/System/Library/Fonts")
BG, FG = (19, 19, 20), (247, 246, 243)
CHROME, DOTS = (36, 36, 39), [(255, 95, 87), (254, 188, 46), (40, 200, 64)]
NAMED = {"black": (19, 19, 20), "red": (240, 104, 90), "green": (78, 192, 124), "yellow": (233, 181, 58),
         "blue": (87, 174, 255), "magenta": (164, 139, 255), "cyan": (124, 194, 255), "white": (247, 246, 243),
         "brightblack": (107, 103, 95), "brightred": (240, 104, 90), "brightgreen": (78, 192, 124),
         "brightyellow": (233, 181, 58), "brightblue": (87, 174, 255), "brightmagenta": (164, 139, 255),
         "brightcyan": (124, 194, 255), "brightwhite": (255, 255, 255)}
# how long each frame stays (ms), by the start of its name; the rest 1500
HOLD = [("01-", 3000), ("02-", 1100), ("03-", 1100), ("04-", 1100), ("05-", 600), ("06-", 1200), ("07-", 1800),
        ("08-", 1500), ("09-", 1500), ("10-", 2800), ("11-", 2800), ("12-", 900), ("13-", 1000), ("14-", 1000),
        ("15-", 3500), ("16-", 4000)]

mono = ImageFont.truetype(str(FONTS / "Menlo.ttc"), SIZE, index=0)
bold = ImageFont.truetype(str(FONTS / "Menlo.ttc"), SIZE, index=1)
braille = ImageFont.truetype(str(FONTS / "Apple Braille.ttf"), SIZE)
symbols = ImageFont.truetype(str(FONTS / "Apple Symbols.ttf"), SIZE)
emoji_font = ImageFont.truetype(str(FONTS / "Apple Color Emoji.ttc"), 160)
menlo_has = set(TTCollection(str(FONTS / "Menlo.ttc")).fonts[0].getBestCmap())
symbols_has = set(TTFont(str(FONTS / "Apple Symbols.ttf")).getBestCmap())
CW = round(mono.getlength("M"))
CH = round(SIZE * 1.42)
PAD, BAR = 18, 34
W, H = COLS * CW + 2 * PAD, ROWS * CH + 2 * PAD + BAR


def color(c: str, default):
    if c in ("default", ""):
        return default
    if len(c) == 6 and all(x in "0123456789abcdefABCDEF" for x in c):
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    return NAMED.get(c.replace("_", "").lower(), default)


_emoji: dict[str, Image.Image] = {}


def emoji(ch: str) -> Image.Image:
    if ch not in _emoji:
        im = Image.new("RGBA", (200, 200))
        ImageDraw.Draw(im).text((0, 0), ch, font=emoji_font, embedded_color=True)
        box = im.getbbox() or (0, 0, 1, 1)
        side = 2 * CW if 2 * CW < CH else CH
        _emoji[ch] = im.crop(box).resize((side - 2, side - 2), Image.LANCZOS)
    return _emoji[ch]


def draw_screen(text: str) -> Image.Image:
    screen = pyte.Screen(COLS, ROWS)
    pyte.Stream(screen).feed(text.replace("\r\n", "\n").replace("\n", "\r\n"))
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # the terminal window: a bar with its three dots and the app's name
    d.rectangle([0, 0, W, BAR], fill=CHROME)
    for i, c in enumerate(DOTS):
        d.ellipse([16 + i * 22, BAR // 2 - 6, 28 + i * 22, BAR // 2 + 6], fill=c)
    title = "keel2"
    d.text(((W - mono.getlength(title)) / 2, BAR // 2 - SIZE // 2 - 1), title, font=mono, fill=(154, 149, 140))
    for y in range(ROWS):
        line = screen.buffer[y]
        x = 0
        while x < COLS:
            ch = line[x]
            fg, bg = color(ch.fg, FG), color(ch.bg, BG)
            if ch.reverse:
                fg, bg = bg, fg
            px, py = PAD + x * CW, BAR + PAD + y * CH
            wide = x + 1 < COLS and line[x + 1].data == ""
            if bg != BG:
                d.rectangle([px, py, px + CW * (2 if wide else 1) - 1, py + CH - 1], fill=bg)
            s = ch.data
            if s and s != " ":
                o = ord(s[0])
                if o >= 0x1F000 or (wide and o > 0x2000 and o not in menlo_has):
                    e = emoji(s)
                    img.paste(e, (px + 1, py + (CH - e.height) // 2), e)
                else:
                    f = braille if 0x2800 <= o <= 0x28FF else (bold if ch.bold else mono) if o in menlo_has or o < 128 \
                        else symbols if o in symbols_has else mono
                    d.text((px, py + (CH - SIZE) // 2 - 1), s, font=f, fill=fg)
            x += 2 if wide else 1
    return img


def hold(name: str) -> int:
    return next((ms for p, ms in HOLD if name.startswith(p)), 1500)


def main(src: str, out: str) -> None:
    files = sorted(Path(src).glob("*.ansi"))
    if not files:
        raise SystemExit(f"no captures in {src}")
    frames = [draw_screen(f.read_text()) for f in files]
    durations = [hold(f.name) for f in files]
    # one palette for every frame (keel's colours stay the same across the GIF)
    pal = frames[0].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    paletted = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    paletted[0].save(out, save_all=True, append_images=paletted[1:], duration=durations, loop=0, optimize=True)
    first = Path(out).with_suffix(".png")
    frames[0].save(first)
    print(f"{out}: {len(frames)} frames, {sum(durations) / 1000:.1f}s, {Path(out).stat().st_size // 1024} KB; first frame {first}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
