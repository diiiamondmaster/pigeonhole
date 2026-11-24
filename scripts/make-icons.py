#!/usr/bin/env python3
"""Generate Pigeonhole app icons: a rounded amber square with a 2x2 grid,
one cell filled (the 'pigeonhole' mark). Outputs build/icon.png (512) and
build/icon.ico (multi-size)."""
from PIL import Image, ImageDraw

BG = (242, 177, 85, 255)        # amber
DARK = (26, 20, 10, 255)        # near-black brown
GAP = 30                        # space around cells

def rounded(draw, box, r, fill=None, outline=None, width=0):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def make(size):
    s = size / 512.0
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # background rounded square
    pad = int(14 * s)
    rounded(d, [pad, pad, size - pad, size - pad], int(116 * s), fill=BG)

    # 2x2 cells
    area_l, area_t, area_r, area_b = int(96 * s), int(96 * s), int(416 * s), int(416 * s)
    cw = (area_r - area_l - 2 * int(20 * s)) // 2
    cell_r = int(40 * s)
    stroke = max(2, int(24 * s))
    coords = []
    for row in range(2):
        for col in range(2):
            x0 = area_l + col * (cw + int(20 * s))
            y0 = area_t + row * (cw + int(20 * s))
            coords.append((x0, y0, x0 + cw, y0 + cw))

    for i, box in enumerate(coords):
        if i == 3:   # bottom-right cell is filled - the occupied pigeonhole
            rounded(d, box, cell_r, fill=DARK)
        else:
            rounded(d, box, cell_r, outline=DARK, width=stroke)
    return img

base = make(512)
base.save('build/icon.png')
base.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
# small preview
make(64).save('build/icon-64.png')
print('icons written to build/')
