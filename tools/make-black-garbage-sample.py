"""生成「真·无价值」极限样本：纯黑画面 + 乱码字幕（无音轨）

用途：测「画面不可读 + 字幕不可读」时，fisheye 是否判无价值（不请求读图）。
产物：test/samples/black-garbage.mp4（1280x720，60s，无音轨）
"""
import os
import random
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
SEC = 60
random.seed(42)

# 乱码素材：罕见汉字/符号/方框，视觉上像"有字但读不懂"
GARBAGE = (
    "龘靐齉爩麤灪龖厵纞虋齾爨儵爩癵驫麣籱"
    "▓▒░█▀▄▌▐■□▲△▼▽◆◇○●"
    "♠♣♥♦♪♫☼☽☾"
    "????!!!~~~"
)

def find_font():
    for p in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]:
        if os.path.exists(p):
            return p
    return None

def make_frame(seed_idx, font_path):
    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(font_path, 42) if font_path else ImageFont.load_default()
    rnd = random.Random(seed_idx)
    for row in range(3):
        s = "".join(rnd.choice(GARBAGE) for _ in range(rnd.randint(12, 20)))
        d.text((120, 300 + row * 70), s, font=f, fill=(230, 230, 230))
    return img

def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "test", "samples")
    os.makedirs(out_dir, exist_ok=True)
    font_path = find_font()
    tmp = tempfile.mkdtemp(prefix="black-garbage-")
    # 30 张独立帧（每 2 秒一张），乱码内容每次不同
    for i in range(SEC // 2):
        make_frame(i, font_path).save(os.path.join(tmp, f"f-{i:03d}.png"))
    out = os.path.abspath(os.path.join(out_dir, "black-garbage.mp4"))
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-framerate", "1/2", "-i", os.path.join(tmp, "f-%03d.png"),
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", "-t", str(SEC), out]
    subprocess.run(cmd, check=True)
    print(f"生成: {out}")
    print(f"规格: {W}x{H}, {SEC}s, 30 帧乱码, 无音轨")
    print("预期: 变化率低（黑底）、无字幕轨、无音频、画面不可读 → 应判无价值")

if __name__ == "__main__":
    main()
