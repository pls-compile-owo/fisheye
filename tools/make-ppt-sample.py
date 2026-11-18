"""生成 PPT/演示类测试样本：静态页面 + 文字 + 无音频（用于测 adaptive 轨与类型判定）

产物：test/samples/ppt-sample.mp4（1280x720，5 页 × 12 秒 = 60 秒，无音轨）
用法：python tools/make-ppt-sample.py
"""
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
SEC_PER_PAGE = 12
PAGES = [
    ("数据压缩的三个层次", ["1. 无损压缩：重复消除", "2. 有损压缩：感知阈值", "3. 语义压缩：只留结论"]),
    ("为什么 token 是瓶颈", ["上下文窗口有限", "每 token 都是成本", "视频天然是 token 黑洞"]),
    ("字幕优先原则", ["同一信息：文本 10 token / 图片 1000 token", "先读文本，再决定要不要看图"]),
    ("分段懒加载", ["按段给骨架，按需取全文", "读帧放到最后"]),
    ("结论", ["压缩不是判断", "判断交给 agent"]),
]

def find_font():
    for p in [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ]:
        if os.path.exists(p):
            return p
    return None

def make_page(title, bullets, idx, font_path):
    img = Image.new("RGB", (W, H), (250, 250, 248))
    d = ImageDraw.Draw(img)
    # 顶部色条
    d.rectangle([0, 0, W, 8], fill=(60, 100, 200))
    ft = ImageFont.truetype(font_path, 56) if font_path else ImageFont.load_default()
    fb = ImageFont.truetype(font_path, 36) if font_path else ImageFont.load_default()
    fs = ImageFont.truetype(font_path, 22) if font_path else ImageFont.load_default()
    d.text((80, 90), title, font=ft, fill=(30, 30, 40))
    y = 220
    for b in bullets:
        d.text((110, y), "•", font=fb, fill=(60, 100, 200))
        d.text((150, y), b, font=fb, fill=(60, 60, 70))
        y += 80
    d.text((80, H - 60), f"{idx + 1} / {len(PAGES)}", font=fs, fill=(150, 150, 160))
    return img

def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "test", "samples")
    os.makedirs(out_dir, exist_ok=True)
    font_path = find_font()
    if not font_path:
        print("警告：没找到中文字体，文字可能显示为方块")
    tmp = tempfile.mkdtemp(prefix="ppt-pages-")
    for i, (title, bullets) in enumerate(PAGES):
        make_page(title, bullets, i, font_path).save(os.path.join(tmp, f"page-{i:02d}.png"))

    out = os.path.abspath(os.path.join(out_dir, "ppt-sample.mp4"))
    # 每页一张图，-loop 1 -t SEC_PER_PAGE，无音频
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for i in range(len(PAGES)):
        cmd += ["-loop", "1", "-t", str(SEC_PER_PAGE), "-i", os.path.join(tmp, f"page-{i:02d}.png")]
    filt = "".join(f"[{i}:v]" for i in range(len(PAGES))) + f"concat=n={len(PAGES)}:v=1:a=0[v]"
    cmd += ["-filter_complex", filt, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "10", out]
    subprocess.run(cmd, check=True)
    dur = len(PAGES) * SEC_PER_PAGE
    print(f"生成: {out}")
    print(f"规格: {W}x{H}, {dur}s, {len(PAGES)} 页, 无音轨")
    print(f"预期特征: 变化率极低（每 12s 一次硬切）、无字幕轨、无音频、字幕带无")

if __name__ == "__main__":
    main()
