"""生成「桌边 DeskPlan」的图标 assets/app.ico（多尺寸 PNG 打包进 ICO），仅用标准库。

图案语言：
  圆角方块（黛蓝 → 铜的斜向渐变）当作桌面上的"牌子"；
  牌子里是一张月历：顶部一条粗横条代表表头，下面两行圆点代表排好的事；
  右侧一条竖条代表贴边常驻的侧边栏——这也是这个应用最显眼的特征。

小尺寸（16px）能不能认出来是唯一标准，所以先按 4 倍超采样渲染，
再做预乘 alpha 的盒子降采样，最后逐尺寸输出。
（上一版就是栽在这里：超采样完没降采样直接写 PNG，声明 256×256 的图
  里塞了 1024×1024 的行数据，Windows 解出来是花的，桌面上就只剩
  一个"图片样"的占位图标。）
"""
import os
import struct
import zlib

# 配色与侧边栏/计划页保持一致
C1 = (0x3E, 0x5F, 0x80)      # 黛蓝（左上）
C2 = (0xB0, 0x82, 0x56)      # 铜（右下）
WHITE = (0xFF, 0xFF, 0xFF)

SS = 4                        # 超采样倍数
RADIUS = 0.225                # 圆角半径（占边长比例）
EDGE_PAD = 0.055              # 图形离画布边缘的留白

# 月历表头：x0, x1, y0, y1
HEAD = (0.20, 0.62, 0.235, 0.345)
# 两行圆点：每行三个（x 圆心），y 圆心
DOT_XS = (0.265, 0.425, 0.585)
DOT_YS = (0.505, 0.685)
DOT_R = 0.062
# 右侧竖条（侧边栏）
BAR = (0.755, 0.885, 0.235, 0.765)
BAR_R = 0.045


def smooth(edge, size):
    """覆盖率：edge > 0 表示在图形内部。
    软边宽度固定为最终分辨率的 1 个像素（1/size），大图才清晰、小图才不糊。"""
    return max(0.0, min(1.0, edge * size + 0.5))


def rounded_rect(x, y, x0, x1, y0, y1, r, size):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    inside = min(min(x - x0, x1 - x), min(y - y0, y1 - y))
    if inside >= r:
        return 1.0
    return smooth(r - d, size)


def circle(x, y, cx, cy, r, size):
    return smooth(r - ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5, size)


def sample(x, y, size):
    """返回 (alpha, 白色图形覆盖率)。alpha=0 时第二个值无意义"""
    p, q = EDGE_PAD, 1 - EDGE_PAD
    a = rounded_rect(x, y, p, q, p, q, RADIUS, size)
    if a <= 0:
        return 0.0, 0.0
    ink = rounded_rect(x, y, *HEAD, r=0.035, size=size)
    ink = max(ink, rounded_rect(x, y, *BAR, r=BAR_R, size=size))
    for cy in DOT_YS:
        for cx in DOT_XS:
            ink = max(ink, circle(x, y, cx, cy, DOT_R, size))
    return a, ink


def render_pixels(size):
    """超采样渲染 + 预乘降采样，返回 size×size 的逐行 RGBA（不带滤镜字节）"""
    n = size * SS
    buf = []
    for j in range(n):
        y = (j + 0.5) / n
        line = bytearray()
        for i in range(n):
            x = (i + 0.5) / n
            a, ink = sample(x, y, size)
            ia = int(round(a * 255))
            if ia == 0:
                line += bytes((0, 0, 0, 0))
                continue
            t = (x + y) / 2
            r, g, b = [C1[k] + (C2[k] - C1[k]) * t for k in range(3)]
            ink = max(0.0, min(1.0, ink))
            r = int(r + (WHITE[0] - r) * ink)
            g = int(g + (WHITE[1] - g) * ink)
            b = int(b + (WHITE[2] - b) * ink)
            line += bytes((r, g, b, ia))
        buf.append(line)

    out = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            sr = sg = sb = sa = 0
            for dy in range(SS):
                line = buf[y * SS + dy]
                for dx in range(SS):
                    o = (x * SS + dx) * 4
                    a = line[o + 3]
                    if a == 0:
                        continue
                    af = a / 255.0
                    sr += line[o] * af
                    sg += line[o + 1] * af
                    sb += line[o + 2] * af
                    sa += a
            if sa == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((
                    int(round(sr / (sa / 255.0))),
                    int(round(sg / (sa / 255.0))),
                    int(round(sb / (sa / 255.0))),
                    int(round(sa / (SS * SS)))))
        out.append(bytes(row))
    return out


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def png_from_rows(rows, size):
    raw = b"".join(b"\x00" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def write_preview(path, sizes=(16, 32, 64, 256), tile=128):
    """把几个尺寸就近放大拼成一张预览图，肉眼检查小尺寸是否还认得出来"""
    gap = 10
    W = gap + sum(tile + gap for _ in sizes)
    H = tile + 2 * gap
    canvas = [[(240, 240, 238, 255) for _ in range(W)] for _ in range(H)]
    x0 = gap
    for s in sizes:
        rows = PIXELS[s]
        step = s / tile
        for y in range(tile):
            src = rows[min(s - 1, int(y * step))]
            for x in range(tile):
                o = 4 * min(s - 1, int(x * step))
                a = src[o + 3] / 255
                if a <= 0:
                    continue
                bg = (240, 240, 238)
                canvas[gap + y][x0 + x] = (
                    int(src[o] * a + bg[0] * (1 - a)),
                    int(src[o + 1] * a + bg[1] * (1 - a)),
                    int(src[o + 2] * a + bg[2] * (1 - a)), 255)
        x0 += tile + gap
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in canvas)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return path


SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
PIXELS = {s: render_pixels(s) for s in SIZES}
imgs = [(s, png_from_rows(PIXELS[s], s)) for s in SIZES]

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(out_dir, exist_ok=True)

png_path = os.path.join(out_dir, "app.png")
with open(png_path, "wb") as f:
    f.write(dict(imgs)[256])

# 托盘图标：直接用 64 那张，交给 Electron 缩到 16
tray_path = os.path.join(out_dir, "tray.png")
with open(tray_path, "wb") as f:
    f.write(dict(imgs)[64])

# ICO：ICONDIR + 若干 ICONDIRENTRY + PNG 数据（256 那档宽度字节写 0 表示 256）
head = struct.pack("<HHH", 0, 1, len(imgs))
offset = 6 + 16 * len(imgs)
entries, blobs = b"", b""
for s, data in imgs:
    entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
    blobs += data
    offset += len(data)

ico_path = os.path.join(out_dir, "app.ico")
with open(ico_path, "wb") as f:
    f.write(head + entries + blobs)

prev_path = write_preview(os.path.join(out_dir, "..", "data", "icon-preview.png"))

print("wrote", png_path, os.path.getsize(png_path), "bytes")
print("wrote", tray_path, os.path.getsize(tray_path), "bytes")
print("wrote", ico_path, os.path.getsize(ico_path), "bytes, sizes:", SIZES)
print("wrote", os.path.normpath(prev_path))
