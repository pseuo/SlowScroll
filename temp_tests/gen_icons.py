"""生成 MV3 所需的 PNG 图标（16/32/48/128）。
设计沿用 assets/icons/icon.svg：蓝色圆形底+ 白色向下箭头 + 速度线。
用4 倍超采样绘制再缩放，边缘更平滑。
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'icons')
SS = 4  # 超采样倍数

BG = (66, 133, 244, 255)
BORDER = (25, 118, 210, 255)
WHITE = (255, 255, 255, 255)


def draw_icon(size):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = S / 128.0  # 以 128 为设计基准做缩放

    # 背景圆形
    d.ellipse([4 * k, 4 * k, 124 * k, 124 * k], fill=BG, outline=BORDER, width=max(1, int(2 * k)))

    # 三个向下的箭头，形成连续滚动感
    d.polygon([(x * k, y * k) for x, y in [
        (64, 35), (80, 55), (68, 55), (68, 65), (60, 65), (60, 55), (48, 55)
    ]], fill=WHITE)
    d.polygon([(x * k, y * k) for x, y in [
        (64, 55), (80, 75), (68, 75), (68, 85), (60, 85), (60, 75), (48, 75)
    ]], fill=WHITE)
    d.polygon([(x * k, y * k) for x, y in [
        (64, 75), (76, 90), (70, 90), (70, 95), (58, 95), (58, 90), (52, 90)
    ]], fill=WHITE)

    # 速度指示线
    w = max(1, int(2.4 * k))
    for y, x2 in [(45, 35), (55, 40), (65, 45)]:
        d.line([25 * k, y * k, x2 * k, y * k], fill=WHITE, width=w)

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 32, 48, 128):
        p = os.path.join(OUT, f'icon{s}.png')
        draw_icon(s).save(p, 'PNG', optimize=True)
        print('generated', p)


if __name__ == '__main__':
    main()