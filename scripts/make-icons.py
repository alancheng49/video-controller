#!/usr/bin/env python3
"""產生擴充功能圖示（不需要 PIL）：先畫 512px 母圖，再用 sips 縮成各尺寸。"""
import os
import struct
import subprocess
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'extension', 'icons')
N = 512
SS = 3  # 每像素 3x3 超取樣做反鋸齒


def write_png(path, w, h, rows):
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(x, y, a, b, c):
    def s(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = s((x, y), a, b), s((x, y), b, c), s((x, y), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


# 圖形（以 0..1 座標）
BG = (0.06, 0.06, 0.94, 0.94, 0.215)
TRI = ((0.43, 0.29), (0.43, 0.71), (0.76, 0.50))
LINES = [  # 速度線：x0, x1, y, 半粗
    (0.20, 0.36, 0.38, 0.032),
    (0.14, 0.36, 0.50, 0.032),
    (0.20, 0.36, 0.62, 0.032),
]
TOP = (0x2E, 0x9B, 0xFF)
BOTTOM = (0x5B, 0x3D, 0xF0)


def in_glyph(x, y):
    if in_triangle(x, y, *TRI):
        return True
    for x0, x1, ly, hw in LINES:
        if x0 <= x <= x1 and abs(y - ly) <= hw:
            return True
        for ex in (x0, x1):  # 圓頭
            if (x - ex) ** 2 + (y - ly) ** 2 <= hw * hw:
                return True
    return False


def render():
    rows = []
    for py in range(N):
        row = []
        for px in range(N):
            bg = glyph = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / N
                    y = (py + (sy + 0.5) / SS) / N
                    if in_rounded_rect(x, y, *BG):
                        bg += 1
                        if in_glyph(x, y):
                            glyph += 1
            total = SS * SS
            if bg == 0:
                row += [0, 0, 0, 0]
                continue
            t = py / N
            base = [TOP[i] + (BOTTOM[i] - TOP[i]) * t for i in range(3)]
            g = glyph / bg
            rgb = [round(base[i] * (1 - g) + 255 * g) for i in range(3)]
            row += rgb + [round(255 * bg / total)]
        rows.append(row)
    return rows


def main():
    os.makedirs(OUT, exist_ok=True)
    master = os.path.join(OUT, 'icon-512.png')
    write_png(master, N, N, render())
    sizes = {f'icon-{s}.png': s for s in (16, 32, 48, 96, 128, 256)}
    sizes.update({f'toolbar-{s}.png': s for s in (16, 19, 32, 38)})
    for name, s in sizes.items():
        subprocess.run(['sips', '-z', str(s), str(s), master, '--out', os.path.join(OUT, name)],
                       check=True, stdout=subprocess.DEVNULL)
    print('icons written to', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
