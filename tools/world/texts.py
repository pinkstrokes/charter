"""Persona prose from qwen3.8-flash, cached by a stable id in data/companyA/texts.json.

A rerun reads every text from the cache and makes zero model calls. When the
model's answer fails a check (a required amount or invoice number is missing),
it is asked once more; after that a plain template is cached instead, so the
world never depends on prose it could not verify.

The API key is read from ~/.config/charter/modelstudio.env and handed to curl
on stdin as a header, so it never appears in argv, logs or files.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stdb import load_key  # noqa: E402

from common import DATA, read_json, write_json  # noqa: E402

ENDPOINT = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "qwen3.8-flash"


class Texts:
    def __init__(self, path: Path = DATA / "texts.json", offline: bool = False):
        self.path = path
        self.offline = offline
        self.cache: dict[str, object] = read_json(path, {})
        self.calls = 0
        self.failures = 0
        self.used: set[str] = set()
        self._key: str | None = None

    def get(self, key: str, system: str, prompt: str, *, fallback, check: Callable[[object], bool] | None = None,
            json_mode: bool = False, max_tokens: int = 300, temperature: float = 0.8):
        """The cached text for `key`, generating it once if needed.

        The cache key is the stable id plus a fingerprint of the prompt, so the
        same request always hits the cache and a changed fact never reuses old prose.
        """
        key = f"{key}#{hashlib.sha256((system + chr(0) + prompt).encode()).hexdigest()[:10]}"
        self.used.add(key)
        if key in self.cache:
            return self.cache[key]
        if self.offline:
            return fallback
        for _ in range(2):
            out = self._complete(system, prompt, json_mode, max_tokens, temperature)
            if out is not None and (check is None or check(out)):
                return self._remember(key, out)
        self.failures += 1
        return self._remember(key, fallback)

    def prune(self, prefixes: tuple[str, ...]) -> int:
        """Drop cached entries with these prefixes that this build did not use (prose for facts that changed)."""
        stale = [k for k in self.cache if k.startswith(prefixes) and k not in self.used]
        for k in stale:
            del self.cache[k]
        if stale:
            write_json(self.path, self.cache)
        return len(stale)

    def _remember(self, key: str, value):
        self.cache[key] = value
        write_json(self.path, self.cache)
        return value

    def _complete(self, system: str, prompt: str, json_mode: bool, max_tokens: int, temperature: float):
        if self._key is None:
            self._key = load_key()
        body = {"model": MODEL, "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
                "max_tokens": max_tokens, "temperature": temperature, "enable_thinking": False}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        fd, body_path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(body, f)
            self.calls += 1
            p = subprocess.run(["curl", "-sS", "--max-time", "90", "-H", "@-", "--data-binary", f"@{body_path}", ENDPOINT],
                               input=f"Authorization: Bearer {self._key}\nContent-Type: application/json\n", capture_output=True, text=True)
        finally:
            os.unlink(body_path)
        if p.returncode != 0:
            return None
        try:
            content = json.loads(p.stdout)["choices"][0]["message"]["content"].strip()
        except (ValueError, KeyError, IndexError):
            return None
        if not json_mode:
            return content.strip().strip('"')
        start, end = content.find("{"), content.rfind("}")
        try:
            return json.loads(content[start:end + 1]) if start >= 0 else None
        except ValueError:
            return None
