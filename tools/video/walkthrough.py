"""Build the demo video from live recordings of the UI: each scene is narrated
with macOS text-to-speech, recorded while record.mjs does what a person would
do for as long as the narration runs, captioned, and joined.
  python3 tools/video/walkthrough.py tools/video/walkthrough.json docs/video/charter.mp4
A scene is {"say", "caption"?, "url"?, "ready"?, "before"?, "steps"?} (see record.mjs)
or a text card {"title": {"heading", "lines"}, "say"}."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap

VOICE = os.environ.get("VOICE", "Samantha")
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
W, H = 1920, 1080
PAGE_H = 930  # the browser viewport; the caption bar fills the rest of the frame
SLACK = 3.0  # seconds a scene may run past its narration before its recording is played faster


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip() or 0)


def title_card(title, caption, out):
    """A heading and up to four lines under it, with the caption bar."""
    from PIL import Image, ImageDraw, ImageFont

    canvas = Image.new("RGB", (W, H), (11, 13, 16))
    draw = ImageDraw.Draw(canvas)
    big, small = ImageFont.truetype(FONT, 88), ImageFont.truetype(FONT, 40)
    lines = [line for part in title.get("lines", []) for line in textwrap.wrap(part, 70)]
    y = (PAGE_H - 120 - len(lines) * 58) // 2
    draw.text(((W - draw.textlength(title["heading"], font=big)) / 2, y), title["heading"], font=big, fill=(240, 240, 240))
    y += 140
    for line in lines:
        draw.text(((W - draw.textlength(line, font=small)) / 2, y), line, font=small, fill=(190, 190, 200))
        y += 58
    canvas.paste(caption_bar(caption), (0, PAGE_H))
    canvas.save(out)


def caption_bar(text):
    from PIL import Image, ImageDraw, ImageFont

    bar = Image.new("RGB", (W, H - PAGE_H), (0, 0, 0))
    draw = ImageDraw.Draw(bar)
    font = ImageFont.truetype(FONT, 34)
    lines = textwrap.wrap(text, 92)[:3]
    y = (H - PAGE_H - len(lines) * 44) // 2
    for line in lines:
        draw.text(((W - draw.textlength(line, font=font)) / 2, y), line, font=font, fill=(240, 240, 240))
        y += 44
    return bar


def main(spec_path, out_path):
    scenes = json.load(open(spec_path))
    work = tempfile.mkdtemp(prefix="charter-walkthrough-")
    for i, sc in enumerate(scenes):
        audio = os.path.join(work, f"s{i}.aiff")
        run(["say", "-v", VOICE, "-r", str(sc.get("rate", 186)), "-o", audio, sc["say"]])
        sc["audio"], sc["seconds"] = audio, round(duration(audio) + float(sc.get("hold", 0.8)), 2)
    timed = os.path.join(work, "scenes.json")
    json.dump(scenes, open(timed, "w"))
    subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "record.mjs"), timed, work], check=True)
    # A scene can run longer than its narration (waiting for the seats, a slow
    # page); it keeps all of it, played faster when it would end more than SLACK
    # seconds after the narration.
    recorded = json.load(open(os.path.join(work, "recorded.json")))
    for i, sc in enumerate(scenes):
        took = round(recorded.get(str(i), 0), 2)
        sc["speed"] = max(1.0, took / (sc["seconds"] + SLACK))
        sc["seconds"] = max(sc["seconds"], min(took, sc["seconds"] + SLACK))
    parts = []
    for i, sc in enumerate(scenes):
        seg = os.path.join(work, f"s{i}.mp4")
        caption = sc.get("caption", sc["say"])
        if "title" in sc:
            frame = os.path.join(work, f"s{i}.png")
            title_card(sc["title"], caption, frame)
            run(["ffmpeg", "-y", "-loop", "1", "-i", frame, "-i", sc["audio"], "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30",
                 "-c:a", "aac", "-b:a", "160k", "-t", f"{sc['seconds']:.2f}", "-af", "apad", seg])
        else:
            bar = os.path.join(work, f"s{i}-caption.png")
            caption_bar(caption).save(bar)
            video = os.path.join(work, f"scene-{i}.webm")
            run(["ffmpeg", "-y", "-i", video, "-i", bar, "-i", sc["audio"],
                 "-filter_complex", f"[0:v]setpts=PTS/{sc['speed']:.3f},scale={W}:{PAGE_H},pad={W}:{H}:0:0:black,fps=30[v];[v][1:v]overlay=0:{PAGE_H}[out]",
                 "-map", "[out]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
                 "-t", f"{sc['seconds']:.2f}", "-af", "apad", seg])
        parts.append(seg)
        faster = sc.get("speed", 1.0)
        print(f"scene {i + 1}/{len(scenes)}: {sc['seconds']:.1f}s" + (f" (recording played {faster:.1f}x)" if faster > 1 else ""))
    listing = os.path.join(work, "parts.txt")
    open(listing, "w").write("".join(f"file '{p}'\n" for p in parts))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    # Re-encoded, since still cards and recordings come out of the encoder differently.
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", out_path])
    print(f"wrote {out_path} ({duration(out_path):.0f}s)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
