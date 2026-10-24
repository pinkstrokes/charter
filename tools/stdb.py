"""Minimal client for the Charter module over SpacetimeDB's HTTP API (stdlib only)."""
import http.client as httpclient
import json
import os
import ssl
import subprocess
import urllib.parse

BASE = os.environ.get("STDB_URL", "http://127.0.0.1:3000")
DB = os.environ.get("STDB_DB", "charter-iqwfr")
_conn = None  # one kept-alive connection: against a remote server it halves every call


class CallError(Exception):
    pass


def _connection(timeout):
    global _conn
    if _conn is None:
        u = urllib.parse.urlsplit(BASE)
        if u.scheme == "https":
            _conn = httpclient.HTTPSConnection(u.netloc, timeout=timeout, context=ssl.create_default_context())
        else:
            _conn = httpclient.HTTPConnection(u.netloc, timeout=timeout)
    return _conn


def http(method, path, body=None, token=None, timeout=300):
    global _conn
    data, headers = None, {}
    if body is not None:
        if isinstance(body, str):
            data, headers["Content-Type"] = body.encode(), "text/plain"
        else:
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    prefix = urllib.parse.urlsplit(BASE).path.rstrip("/")
    for attempt in (1, 2):
        try:
            conn = _connection(timeout)
            conn.request(method, prefix + path, body=data, headers=headers)
            r = conn.getresponse()
            return r.status, r.read().decode()
        except (httpclient.HTTPException, OSError):
            # A dropped connection (the server closed it, or the machine slept): reconnect once.
            if _conn is not None:
                _conn.close()
            _conn = None
            if attempt == 2:
                raise


def new_identity():
    _, text = http("POST", "/v1/identity")
    d = json.loads(text)
    return d["identity"], d["token"]


def admin_token():
    out = subprocess.run(["spacetime", "login", "show", "--token"], capture_output=True, text=True).stdout
    for word in out.split():
        if word.count(".") == 2 and len(word) > 40:
            return word
    raise RuntimeError("could not read the CLI token")


class Client:
    def __init__(self, token, name=""):
        self.token, self.name = token, name

    def call(self, fn, *args, check=True):
        status, text = http("POST", f"/v1/database/{DB}/call/{fn}", list(args), self.token)
        if check and status != 200:
            raise CallError(f"{self.name} {fn} -> {status}: {text[:400]}")
        return status, text

    def sql(self, query):
        status, text = http("POST", f"/v1/database/{DB}/sql", query, self.token)
        if status != 200:
            raise CallError(f"sql {query!r} -> {status}: {text[:400]}")
        res = json.loads(text)
        if not res:
            return []
        names = [e["name"]["some"] for e in res[0]["schema"]["elements"]]
        return [dict(zip(names, row)) for row in res[0]["rows"]]


def identity_arg(hex_identity):
    return {"__identity__": hex_identity if hex_identity.startswith("0x") else "0x" + hex_identity}


def load_key():
    path = os.path.expanduser("~/.config/charter/modelstudio.env")
    for line in open(path):
        line = line.strip()
        if line.startswith("export MODELSTUDIO_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("MODELSTUDIO_API_KEY not found")
