"""Exercise the spike module over the local HTTP API and report each risk check."""
import json
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3000"
DB = "charter-spike"


def http(method, path, body=None, token=None):
    data = None
    headers = {}
    if body is not None:
        if isinstance(body, str):
            data = body.encode()
            headers["Content-Type"] = "text/plain"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def new_identity():
    status, text = http("POST", "/v1/identity")
    d = json.loads(text)
    return d["identity"], d["token"]


def call(name, args, token=None):
    return http("POST", f"/v1/database/{DB}/call/{name}", args, token)


def sql(query, token=None):
    status, text = http("POST", f"/v1/database/{DB}/sql", query, token)
    if status != 200:
        return status, text
    results = json.loads(text)
    return status, results[0]["rows"] if results else []


def admin_token():
    out = subprocess.run(["spacetime", "login", "show", "--token"], capture_output=True, text=True).stdout
    for word in out.split():
        if word.count(".") == 2 and len(word) > 40:
            return word
    raise RuntimeError("could not read CLI token")


def check_concurrency():
    print("\n== 2. does a slow procedure block reducers? ==")
    llm = {}

    def slow():
        t0 = time.time()
        status, text = call("ask_llm", ["Write about 250 words on why bank reconciliation matters.", 500])
        llm["status"], llm["secs"], llm["chars"] = status, time.time() - t0, len(text)

    th = threading.Thread(target=slow)
    th.start()
    time.sleep(0.2)
    latencies = []
    while th.is_alive():
        t0 = time.time()
        status, _ = call("ping", ["during-llm"])
        latencies.append((time.time() - t0) * 1000)
        time.sleep(0.1)
    th.join()
    print(f"LLM procedure: HTTP {llm['status']}, {llm['secs']:.1f}s, {llm['chars']} chars returned")
    print(f"reducer calls during it: n={len(latencies)}, median={statistics.median(latencies):.0f}ms, max={max(latencies):.0f}ms")

    print("\n== 2b. do two procedures run in parallel? ==")
    times = []

    def one(i):
        t0 = time.time()
        call("ask_llm", [f"Count from 1 to 40, item {i}.", 200])
        times.append(time.time() - t0)

    t0 = time.time()
    single = threading.Thread(target=one, args=(0,))
    single.start(); single.join()
    single_secs = time.time() - t0
    times.clear()
    t0 = time.time()
    pair = [threading.Thread(target=one, args=(i,)) for i in (1, 2)]
    for th in pair: th.start()
    for th in pair: th.join()
    pair_secs = time.time() - t0
    print(f"one call: {single_secs:.1f}s; two concurrent calls finished in {pair_secs:.1f}s (each {[f'{x:.1f}' for x in times]})")


def check_identities(admin):
    print("\n== 4. identities, segregation of duties, per-identity views ==")
    a_id, a_tok = new_identity()
    b_id, b_tok = new_identity()
    c_id, c_tok = new_identity()
    for who, role in ((a_id, "cash_app"), (b_id, "controller"), (c_id, "collections")):
        status, text = call("bind_role", [{"__identity__": "0x" + who}, role], admin)
        if status != 200:
            status, text = call("bind_role", ["0x" + who, role], admin)
        print(f"bind {role}: {status} {text[:120]}")
    print("A (cash_app) requests payment:", call("request_payment", ["Vendor X", 4_800_000], a_tok)[0])
    print("C (collections) requests payment:", call("request_payment", ["Vendor Y", 100], c_tok))
    print("A approves own payment:", call("approve_payment", [1], a_tok))
    print("B (controller) approves payment 1:", call("approve_payment", [1], b_tok)[0])
    print("B requests payment:", call("request_payment", ["Vendor Z", 900], b_tok)[0])
    print("B approves own payment 2:", call("approve_payment", [2], b_tok))
    print("view my_payments as A:", sql("SELECT * FROM my_payments", a_tok))
    print("view my_payments as C:", sql("SELECT * FROM my_payments", c_tok))
    print("private table payment, anonymous:", sql("SELECT * FROM payment"))
    print("private table secret, as A:", sql("SELECT * FROM secret", a_tok))


def check_schedule(admin):
    print("\n== 3. scheduled procedure ==")
    print("schedule:", call("schedule_llm", ["Reply with exactly: TICK", 2], admin)[0])
    time.sleep(7)
    status, rows = sql("SELECT * FROM event_log WHERE kind = 'llm_tick'")
    print("llm_tick rows:", rows)


def check_http_handler():
    print("\n== 5. inbound HTTP handler ==")
    print("GET health:", http("GET", f"/v1/database/{DB}/route/health"))
    print("POST webhook:", http("POST", f"/v1/database/{DB}/route/webhook", "ach_return R01 store S07 amount 412.50"))
    print("inbound rows:", sql("SELECT * FROM inbound")[1])


if __name__ == "__main__":
    admin = admin_token()
    check_concurrency()
    check_identities(admin)
    check_schedule(admin)
    check_http_handler()
