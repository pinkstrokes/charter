"""The video's narration: Model Studio (DashScope international) Qwen-Audio-TTS.
speak(text, out_wav) writes a 24 kHz mono 16-bit WAV with a correct header; the
same request is served from ~/.cache/charter-tts, so re-renders cost nothing."""
import hashlib
import http.client
import json
import os
import shutil
import ssl
import struct
import time
import urllib.error
import urllib.request
import wave

TTS_MODEL = os.environ.get("TTS_MODEL", "qwen-audio-3.1-tts-flash")
TTS_VOICE = os.environ.get("TTS_VOICE", "Ava_v3.1")  # or Brian_v3.1 (TTS_RATE=1.2), Emily_v3.1
TTS_RATE = float(os.environ.get("TTS_RATE", "1.3"))  # 0.5-2.0; the service time-stretches, pitch kept
TTS_URL = "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
TTS_CACHE = os.environ.get("TTS_CACHE", os.path.expanduser("~/.cache/charter-tts"))  # same request -> same file
# python.org builds of Python on macOS ship without root certificates
_SSL = ssl.create_default_context(cafile="/etc/ssl/cert.pem") if os.path.exists("/etc/ssl/cert.pem") else None


def _api_key():
    if os.environ.get("MODELSTUDIO_API_KEY"):
        return os.environ["MODELSTUDIO_API_KEY"]
    for line in open(os.path.expanduser("~/.config/charter/modelstudio.env")):
        line = line.strip().removeprefix("export ")
        if line.startswith("MODELSTUDIO_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("MODELSTUDIO_API_KEY is not set")


def _write_wav(data, out_wav):
    """The service streams its WAV, so the header claims ~12 hours of data; keep the PCM, write a true header."""
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        if cid == b"fmt ":
            _, channels, rate, _, _, bits = struct.unpack("<HHIIHH", data[pos + 8:pos + 24])
            fmt = (channels, rate, bits // 8)
        elif cid == b"data":
            pcm = data[pos + 8:]
            break
        pos += 8 + size + (size & 1)
    if not fmt or not pcm:
        raise SystemExit("TTS returned no audio")
    channels, rate, width = fmt
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(pcm[: len(pcm) - len(pcm) % (channels * width)])


def speak(text: str, out_wav: str, rate: float | None = None) -> None:
    body = {"model": TTS_MODEL, "input": {"text": text, "voice": TTS_VOICE, "format": "wav", "sample_rate": 24000,
                                          "language_hints": ["en"], "rate": rate or TTS_RATE}}
    cached = os.path.join(TTS_CACHE, hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:24] + ".wav")
    if not os.path.exists(cached):
        req = urllib.request.Request(TTS_URL, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60, context=_SSL) as r:
                    url = json.load(r)["output"]["audio"]["url"]  # a file URL, valid for 24 hours
                with urllib.request.urlopen(url, timeout=60, context=_SSL) as r:
                    data = r.read()
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:300]
                if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                # e.g. AllocationQuota.FreeTierOnly once this model's free quota is used up
                raise SystemExit(f"TTS {TTS_MODEL}/{TTS_VOICE} failed: HTTP {e.code} {detail}")
            except (OSError, http.client.HTTPException, ValueError):  # dropped connection, timeout, cut-off body
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        os.makedirs(TTS_CACHE, exist_ok=True)
        part = f"{cached}.{os.getpid()}-{time.time_ns()}.part"
        _write_wav(data, part)
        os.replace(part, cached)
    shutil.copyfile(cached, out_wav)
