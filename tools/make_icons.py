"""Draw the Super Prompt Creator icon (a "> _" prompt with a spark) and write
the PNG/ICO files Tauri embeds. Run: python tools/make_icons.py"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
S = 1024  # master size, downsampled for every output


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    stops = [(0.0, (255, 150, 60)), (0.5, (255, 77, 141)), (1.0, (124, 92, 255))]
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t <= t1:
                    px[x, y] = lerp(c0, c1, (t - t0) / (t1 - t0))
                    break
    return img


def sparkle(draw, cx, cy, r, fill):
    pts = []
    for i in range(8):
        ang = math.pi / 4 * i - math.pi / 2
        rad = r if i % 2 == 0 else r * 0.26
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    draw.polygon(pts, fill=fill)


def master():
    base = gradient(S).convert("RGBA")
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([24, 24, S - 24, S - 24], radius=230, fill=255)
    tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tile.paste(base, (0, 0), mask)

    # soft inner highlight at the top
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse([-200, -520, S + 200, 430], fill=(255, 255, 255, 46))
    hl = hl.filter(ImageFilter.GaussianBlur(40))
    hl_mask = Image.new("L", (S, S), 0)
    hl_mask.paste(mask, (0, 0))
    tile = Image.alpha_composite(tile, Image.composite(hl, Image.new("RGBA", (S, S)), hl_mask))

    # glyph shadow + glyph
    glyph = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    g = ImageDraw.Draw(glyph)
    w = 96
    chevron = [(262, 330), (468, 512), (262, 694)]
    g.line(chevron, fill=(255, 255, 255, 255), width=w, joint="curve")
    for p in (chevron[0], chevron[2]):
        g.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=(255, 255, 255, 255))
    g.rounded_rectangle([548, 646, 790, 646 + w], radius=w // 2, fill=(255, 255, 255, 255))
    sparkle(g, 742, 300, 150, (255, 255, 255, 255))

    shadow = glyph.copy()
    shadow_alpha = shadow.split()[3].point(lambda a: int(a * 0.28))
    shadow = Image.new("RGBA", (S, S), (60, 10, 60, 0))
    shadow.putalpha(shadow_alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    shifted = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shifted.paste(shadow, (0, 16), shadow)
    tile = Image.alpha_composite(tile, shifted)
    tile = Image.alpha_composite(tile, glyph)
    return tile


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    m = master()
    sizes = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}
    for name, size in sizes.items():
        m.resize((size, size), Image.LANCZOS).save(OUT / name)
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    m.resize((256, 256), Image.LANCZOS).save(OUT / "icon.ico", sizes=[(s, s) for s in ico_sizes])
    # favicon-sized copy for the UI's own logo is drawn as SVG, so nothing else to write.
    print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir())))


if __name__ == "__main__":
    sys.exit(main())
