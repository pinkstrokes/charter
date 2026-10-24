"""Build the demo video from screenshots and a script: each scene is one image,
narrated with macOS text-to-speech and captioned, then all scenes are joined.
  python3 tools/video/make_video.py tools/video/scenes.json docs/video/charter.mp4
scenes.json: [{"image": "path.png", "say": "narration", "hold": 0.6}]"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap

VOICE = os.environ.get("VOICE", "Samantha")
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
W, H = 1920, 1080


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def compose(image, caption, out):
    from PIL import Image, ImageDraw, ImageFont

    canvas = Image.new("RGB", (W, H), (11, 13, 16))
    shot = Image.open(image).convert("RGB")
    shot.thumbnail((W, H - 150), Image.LANCZOS)
    canvas.paste(shot, ((W - shot.width) // 2, max(0, (H - 150 - shot.height) // 2)))
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rectangle([0, H - 150, W, H], fill=(0, 0, 0, 200))
    font = ImageFont.truetype(FONT, 34)
    lines = textwrap.wrap(caption, 92)[:3]
    y = H - 150 + (150 - len(lines) * 44) // 2
    for line in lines:
        width = draw.textlength(line, font=font)
        draw.text(((W - width) / 2, y), line, font=font, fill=(240, 240, 240))
        y += 44
    canvas.save(out)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip() or 0)


def main(scenes_path, out_path):
    scenes = json.load(open(scenes_path))
    base = os.path.dirname(os.path.abspath(scenes_path))
    work = tempfile.mkdtemp(prefix="charter-video-")
    parts = []
    for i, sc in enumerate(scenes):
        img = sc["image"] if os.path.isabs(sc["image"]) else os.path.join(base, sc["image"])
        audio = os.path.join(work, f"s{i}.aiff")
        run(["say", "-v", VOICE, "-r", str(sc.get("rate", 178)), "-o", audio, sc["say"]])
        secs = duration(audio) + float(sc.get("hold", 0.6))
        frame = os.path.join(work, f"s{i}.png")
        compose(img, sc.get("caption", sc["say"]), frame)
        seg = os.path.join(work, f"s{i}.mp4")
        run(["ffmpeg", "-y", "-loop", "1", "-i", frame, "-i", audio, "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
             "-r", "30", "-c:a", "aac", "-b:a", "160k", "-t", f"{secs:.2f}", "-af", "apad", seg])
        parts.append(seg)
        print(f"scene {i + 1}/{len(scenes)}: {secs:.1f}s")
    listing = os.path.join(work, "parts.txt")
    open(listing, "w").write("".join(f"file '{p}'\n" for p in parts))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", out_path])
    print(f"wrote {out_path} ({duration(out_path):.0f}s)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
