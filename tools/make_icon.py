#!/usr/bin/env python3
"""Рисует иконку и собирает launcher/rsrc_windows_amd64.syso (ресурс иконки для .exe).

Нужен Pillow:  pip install pillow
Go сам подхватывает *.syso из папки launcher при сборке.
"""
import io, os, struct
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'launcher', 'rsrc_windows_amd64.syso')


def draw(sz):
    S = sz * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=(217, 72, 15, 255))
    w = max(2, int(S * 0.08))
    d.rounded_rectangle([S * 0.20, S * 0.33, S * 0.80, S * 0.67], radius=int(S * 0.07), outline=(255, 255, 255, 255), width=w)
    x, y, seg, gap, lw = S * 0.5, S * 0.14, S * 0.08, S * 0.05, max(2, int(S * 0.06))
    while y < S * 0.86:
        d.line([x, y, x, min(y + seg, S * 0.86)], fill=(255, 255, 255, 255), width=lw)
        y += seg + gap
    return im.resize((sz, sz), Image.LANCZOS)


def build_syso():
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = []
    for s in sizes:
        b = io.BytesIO(); draw(s).save(b, 'PNG'); imgs.append(b.getvalue())
    draw(256).save(os.path.join(ROOT, 'tools', 'icon.png'))
    n = len(imgs)
    grp = struct.pack('<HHH', 0, 1, n)
    for i, (s, data) in enumerate(zip(sizes, imgs)):
        grp += struct.pack('<BBBBHHIH', s % 256, s % 256, 0, 0, 1, 32, len(data), i + 1)
    LANG = 0x0409
    types = [(3, [(i + 1, imgs[i]) for i in range(n)]), (14, [(1, grp)])]  # RT_ICON, RT_GROUP_ICON

    def dirhdr(nid): return struct.pack('<IIHHHH', 0, 0, 0, 0, 0, nid)
    off = 16 + 8 * len(types); typedir, namedir, dataent, dataoff = {}, {}, {}, {}
    for t, items in types: typedir[t] = off; off += 16 + 8 * len(items)
    for t, items in types:
        for nid, _ in items: namedir[(t, nid)] = off; off += 16 + 8
    for t, items in types:
        for nid, _ in items: dataent[(t, nid)] = off; off += 16
    for t, items in types:
        for nid, blob in items: off = (off + 7) & ~7; dataoff[(t, nid)] = off; off += len(blob)
    total = (off + 7) & ~7
    buf = bytearray(total)

    def put(o, b): buf[o:o + len(b)] = b
    put(0, dirhdr(len(types)))
    for k, (t, items) in enumerate(types):
        put(16 + 8 * k, struct.pack('<II', t, 0x80000000 | typedir[t]))
        put(typedir[t], dirhdr(len(items)))
        for j, (nid, blob) in enumerate(items):
            put(typedir[t] + 16 + 8 * j, struct.pack('<II', nid, 0x80000000 | namedir[(t, nid)]))
            put(namedir[(t, nid)], dirhdr(1))
            put(namedir[(t, nid)] + 16, struct.pack('<II', LANG, dataent[(t, nid)]))
            put(dataent[(t, nid)], struct.pack('<IIII', dataoff[(t, nid)], len(blob), 0, 0))
            put(dataoff[(t, nid)], blob)
    relocs = list(dataent.values())  # RVA данных правятся линковщиком (IMAGE_REL_AMD64_ADDR32NB)
    raw_ptr = 20 + 40; rel_ptr = raw_ptr + total; sym_ptr = rel_ptr + 10 * len(relocs)
    coff = struct.pack('<HHIIIHH', 0x8664, 1, 0, sym_ptr, 1, 0, 0)
    sec = b'.rsrc\0\0\0' + struct.pack('<IIIIIIHHI', 0, 0, total, raw_ptr, rel_ptr, 0, len(relocs), 0, 0x40000040)
    rel = b''.join(struct.pack('<IIH', r, 0, 3) for r in relocs)
    sym = b'.rsrc\0\0\0' + struct.pack('<IhHBB', 0, 1, 0, 3, 0)
    with open(OUT, 'wb') as f:
        f.write(coff + sec + bytes(buf) + rel + sym + struct.pack('<I', 4))
    print('готово:', OUT)


if __name__ == '__main__':
    build_syso()
