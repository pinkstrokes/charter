"""Compare two runs of the same ledger, month by month and on the locked test
split: e.g. company C started from the cash skill company B learned, and the
same company started from the hand-written day-one skill.
  python3 tools/evolve/compare.py data/companyC data/companyC-alone
Reads each run's eval/report.json (tools/evolve/report.ts) and writes
<first>/eval/compare.json."""
import json
import os
import sys


def load(run):
    return json.load(open(os.path.join(run, "eval", "report.json")))


def summary(r):
    months = [(m["month"], m["domains"]["allocation"]) for m in r["trend"] if "allocation" in m["domains"]]
    gens = [g for g in r["generations"] if g["key"].startswith("allocation@")]
    tot = lambda g, k: sum(v[k] for v in g["test"].values())  # noqa: E731
    landed = r["cashLanded"]["test"]
    return {
        "months": [{"month": m, "decisions": a["decisions"], "aloneShare": round(a["aloneShare"], 3), "questions": a["questions"],
                    "wrongAlone": a["aloneGraded"] - a["aloneRight"], "gradedAlone": a["aloneGraded"]} for m, a in months],
        "versions": [{"key": g["key"], "liveFrom": g["activatedAt"], "alone": tot(g, "alone"), "wrong": tot(g, "wrong"), "right": tot(g, "right"), "n": tot(g, "n")} for g in gens],
        "landed": {"right": sum(v["right"] for v in landed.values()), "n": sum(v["n"] for v in landed.values())},
        "knowingWhenToAsk": r["knowingWhenToAsk"].get("allocation"),
    }


def main(a, b):
    out = {"runs": {a: summary(load(a)), b: summary(load(b))}}
    sa, sb = out["runs"][a], out["runs"][b]
    for name, s in ((a, sa), (b, sb)):
        print(f"== {name}: landed {s['landed']['right']}/{s['landed']['n']}; alone {s['knowingWhenToAsk']}")
        for m in s["months"]:
            print(f"   {m['month']}: {m['decisions']} decisions, {m['aloneShare'] * 100:.0f}% alone, {m['questions']} questions, wrong alone {m['wrongAlone']}/{m['gradedAlone']}")
        for v in s["versions"]:
            print(f"   {v['key']} live {v['liveFrom']}: test alone {v['alone']}, wrong {v['wrong']}, right {v['right']}/{v['n']}")
    json.dump(out, open(os.path.join(a, "eval", "compare.json"), "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
