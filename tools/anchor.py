"""Anchor every closed period's certificate and the chain head into this git
repository, so that history cannot be rewritten afterwards without the commit
log showing it. Commits locally; pushing (a public timestamp) is a separate,
deliberate step.  STDB_DB=charter-a python3 tools/anchor.py data/companyA"""
import hashlib
import json
import os
import subprocess
import sys

from stdb import Client, admin_token

ROOT = os.path.join(os.path.dirname(__file__), "..")


def main(company_dir):
    admin = Client(admin_token(), "admin")
    out_dir = os.path.join(ROOT, company_dir, "anchors")
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for c in admin.sql("SELECT period, closed_at, closed_by, certificate, certificate_hash FROM period_close"):
        cert = json.loads(c["certificate"])
        recomputed = hashlib.sha256(c["certificate"].encode()).hexdigest()
        if recomputed != c["certificate_hash"]:
            print(f"{c['period']}: certificate hash does not match its text; not anchoring")
            continue
        anchor = {"period": c["period"], "closedAt": c["closed_at"], "closedBy": c["closed_by"], "certificateHash": c["certificate_hash"],
                  "chainHead": cert["chain"]["head"], "lastActivityId": cert["chain"]["lastActivityId"], "auditorOpinion": cert["auditorOpinion"]["opinion"]}
        path = os.path.join(out_dir, f"{c['period']}.json")
        if os.path.exists(path) and json.load(open(path)) == anchor:
            continue
        json.dump(anchor, open(path, "w"), indent=1)
        written.append(path)
    head = admin.sql("SELECT hash, last_activity_id FROM chain_head")[0]
    json.dump({"chainHead": head["hash"], "lastActivityId": head["last_activity_id"]}, open(os.path.join(out_dir, "latest.json"), "w"), indent=1)
    written.append(os.path.join(out_dir, "latest.json"))
    subprocess.run(["git", "add", *written], cwd=ROOT, check=True)
    r = subprocess.run(["git", "commit", "-q", "-m", f"Anchor {company_dir}: {len(written) - 1} period certificate(s), chain head {head['hash'][:12]}"], cwd=ROOT)
    print(f"anchored {len(written) - 1} period(s); chain head {head['hash'][:16]}…" + ("" if r.returncode == 0 else " (nothing new to commit)"))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/dev")
