"""生成托盘图标：渐变圆角方块 + 三条待办线。仅用标准库手写 PNG。"""
import struct, zlib, os

SIZE = 64          # 输出尺寸
SS = 4             # 超采样倍数
N = SIZE * SS

C1 = (0x5B, 0x7C, 0x99)   # 黛蓝
C2 = (0xB0, 0x76, 0x3C)   # 铜
WHITE = (0xFF, 0xFF, 0xFF)

RADIUS = 0.22            # 圆角比例
LINES = [(0.36, 0.045), (0.53, 0.045), (0.70, 0.045)]   # (中心 y 比例, 高度比例)
LINE_X = (0.28, 0.72)    # 左右边界比例


def rounded_rect_alpha(x, y):
    """返回该像素被圆角矩形覆盖的覆盖率 0..1"""
    r = RADIUS
    px, py = x, y
    # 逐点近似：到矩形最近点的距离
    cx = min(max(px, r), 1 - r)
    cy = min(max(py, r), 1 - r)
    d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
    # 0.5/SS 的软化宽度，做抗锯齿
    soft = 0.9 / SS
    if d <= r - soft:
        return 1.0
    if d >= r:
        return 0.0
    return (r - d) / soft


def line_cover(px, py):
    for cy, h in LINES:
        half = h / 2
        if abs(py - cy) <= half and LINE_X[0] <= px <= LINE_X[1]:
            # 端点也做一点圆润
            ex = min(px - LINE_X[0], LINE_X[1] - px)
            ey = half - abs(py - cy)
            e = min(ex, ey)
            return min(1.0, e * SS / 0.7)
    return 0.0


rows = []
for j in range(N):
    row = bytearray()
    row.append(0)  # filter type 0
    y = (j + 0.5) / N
    for i in range(N):
        x = (i + 0.5) / N
        a = rounded_rect_alpha(x, y)
        if a <= 0:
            row += bytes((0, 0, 0, 0))
            continue
        t = (x + y) / 2
        base = tuple(int(C1[k] + (C2[k] - C1[k]) * t) for k in range(3))
        cov = line_cover(x, y)
        if cov > 0:
            cov = cov * min(1.0, (0.5 - abs(y - 0.5)) * 8)
            col = tuple(int(base[k] + (WHITE[k] - base[k]) * min(1.0, cov)) for k in range(3))
        else:
            col = base
        row += bytes((col[0], col[1], col[2], int(round(a * 255))))
    rows.append(bytes(row))

raw = b"".join(rows)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, "tray.png")
with open(out, "wb") as f:
    f.write(png)
print("wrote", out, len(png), "bytes")
