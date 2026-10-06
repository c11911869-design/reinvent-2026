#!/usr/bin/env python3
"""Build the re:Invent 2026 planner.

    python3 build.py            fetch the catalog, then build dist/
    python3 build.py --offline  rebuild dist/ from cached data/ (no network)

Pulls the public catalog, attaches any published times to the curated picks,
slims the full catalog down for the onboarding recommender, and concatenates
src/page/* into a single self-contained HTML file in dist/.
"""
import argparse, json, re, sys, time, urllib.request, urllib.parse, pathlib

ROOT = pathlib.Path(__file__).parent
SRC, DATA, DIST = ROOT / "src", ROOT / "data", ROOT / "dist"
sys.path.insert(0, str(SRC))
from notes import NOTES          # noqa: E402
import venues as V               # noqa: E402

API = "https://catalog.awsevents.com/api/search"
PROFILE = "W7g1iXGSnubuepOruvDWMM9ecuUXKP4v"
HDRS = {"rfapiprofileid": PROFILE,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0"}
BASE = re.compile(r"-R\d*$")     # repeat offerings: AIM347-R1 -> AIM347
LIGHTNING_MIN = 20               # assumed length when a slot publishes end == start


# ---------------------------------------------------------------- fetch

def fetch_all():
    out, frm = [], 0
    while True:
        body = urllib.parse.urlencode({"size": 50, "from": frm, "type": "session"}).encode()
        for attempt in range(4):
            try:
                j = json.load(urllib.request.urlopen(
                    urllib.request.Request(API, data=body, headers=HDRS), timeout=60))
                break
            except Exception as e:
                if attempt == 3:
                    raise
                print(f"  retry from={frm}: {e}", file=sys.stderr)
                time.sleep(2)
        items = j["sectionList"][0]["items"] if j.get("sectionList") else j.get("items", [])
        out += items
        if not items or frm > 8000:
            break
        frm += 50
        time.sleep(0.25)
    return out


# ---------------------------------------------------------------- shape

def attrs(rec, name):
    return [x["value"] for x in rec.get("attributevalues", []) if x.get("attribute") == name]


def slots_for(rec):
    got = []
    for t in rec.get("times") or []:
        if t.get("isHidden") or not t.get("startTime"):
            continue
        room = (t.get("room") or "").strip()
        got.append({
            "code": rec["code"], "date": t.get("date", ""),
            "daySort": t.get("daySort", ""),
            "dayName": t.get("dayName") or t.get("dayDisplayName", ""),
            "start": t.get("startTimeFormatted", ""), "end": t.get("endTimeFormatted", ""),
            "startMin": int(t.get("startTimeMin") or 0),
            "endMin": int(t.get("endTimeMin") or 0),
            "room": room, "venue": V.venue_key(room),
            "capacity": int(t.get("capacity") or 0),
        })
    return got


def fix_zero_length(catalog):
    """Some lightning talks publish end == start. A zero-length slot can never
    clash with anything, so assume the standard length and flag the end time
    as an estimate rather than let it slip through the clash checks."""
    n = 0
    for r in catalog:
        for s in r["s"]:
            if s["endMin"] > s["startMin"] or s.get("endEst"):
                continue
            s["endMin"] = s["startMin"] + LIGHTNING_MIN
            h, m = divmod(s["endMin"], 60)
            s["end"] = f"{(h - 1) % 12 + 1:02d}:{m:02d} {'AM' if h < 12 else 'PM'}"
            s["endEst"] = True
            n += 1
    return n


def build_catalog(recs):
    """Every session, slimmed, for the onboarding recommender."""
    by_base = {}
    for r in recs:
        by_base.setdefault(BASE.sub("", r["code"]), []).append(r)
    out = []
    for code, group in by_base.items():
        primary = next((r for r in group if r["code"] == code), group[0])
        lvl = (attrs(primary, "Level") or ["?"])[0]
        slots = sorted((s for r in group for s in slots_for(r)),
                       key=lambda s: (s["daySort"], s["startMin"]))
        out.append({
            "c": code, "t": primary["title"].strip(), "y": primary["type"],
            "l": lvl.split("–")[0].strip(),
            "tp": attrs(primary, "Topic"), "ai": attrs(primary, "Area of Interest"),
            "ro": attrs(primary, "Role"), "in": attrs(primary, "Industry"),
            "sv": attrs(primary, "Services")[:3],
            "h": "Hands-on" in attrs(primary, "Features"),
            "sp": "Sponsored" in attrs(primary, "Session Appendices"),
            "a": (primary.get("abstract") or "").strip()[:280],
            "s": slots,
        })
    out.sort(key=lambda r: r["c"])
    return out


def build_picks(catalog):
    """The 97 curated picks, keyed to catalog entries by code."""
    byc = {r["c"]: r for r in catalog}
    picks = []
    for code, (track, tier, note) in NOTES.items():
        r = byc.get(code)
        if not r:
            print(f"  !! {code} no longer in catalog", file=sys.stderr)
            continue
        picks.append({"code": code, "track": track, "tier": tier, "note": note})
    picks.sort(key=lambda p: (p["tier"], p["code"]))
    return picks


# ---------------------------------------------------------------- emit

def build_page(catalog, picks, meta):
    parts = [
        (SRC / "page" / "head.html").read_text(encoding="utf-8"),
        (SRC / "page" / "body.html").read_text(encoding="utf-8"),
        "<script>",
        "const CATALOG=" + json.dumps(catalog, separators=(",", ":"), ensure_ascii=False) + ";",
        "const PICKS=" + json.dumps(picks, separators=(",", ":"), ensure_ascii=False) + ";",
        "const META=" + json.dumps(meta, separators=(",", ":"), ensure_ascii=False) + ";",
        "const VENUES=" + json.dumps(
            [{"k": k, "n": n, "d": d} for k, n, d in V.VENUES],
            separators=(",", ":"), ensure_ascii=False) + ";",
        "const TRAVEL=" + json.dumps(V.matrix(), separators=(",", ":"), ensure_ascii=False) + ";",
        (SRC / "page" / "app.js").read_text(encoding="utf-8"),
        "</script>",
    ]
    DIST.mkdir(exist_ok=True)
    out = DIST / "reinvent-2026-planner.html"
    out.write_text("\n".join(parts), encoding="utf-8")
    return out


def facet_index(catalog):
    """Every facet value and how many sessions carry it — drives onboarding."""
    idx = {}
    for field in ("tp", "ai", "ro", "in"):
        counts = {}
        for r in catalog:
            for v in r.get(field, []):
                counts[v] = counts.get(v, 0) + 1
        idx[field] = sorted(counts.items(), key=lambda kv: -kv[1])
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true",
                    help="rebuild from cached data/catalog.json, no network")
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    if args.offline:
        catalog = json.loads((DATA / "catalog.json").read_text())
        cached = json.loads((DATA / "meta.json").read_text())
        recs_n = cached.get("catalogTotal", len(catalog))
        pulled = cached.get("pulled")          # the cache is as old as its last fetch
        print(f"offline: {len(catalog)} sessions from cache")
    else:
        pulled = None
        print("fetching catalog…")
        recs = fetch_all()
        recs_n = len(recs)
        print(f"  {recs_n} records")
        catalog = build_catalog(recs)
        (DATA / "catalog.json").write_text(
            json.dumps(catalog, separators=(",", ":"), ensure_ascii=False))

    fixed = fix_zero_length(catalog)
    if fixed:
        print(f"  {fixed} zero-length slots given an estimated {LIGHTNING_MIN}-min end")
        (DATA / "catalog.json").write_text(
            json.dumps(catalog, separators=(",", ":"), ensure_ascii=False))

    picks = build_picks(catalog)
    (DATA / "picks.json").write_text(json.dumps(picks, indent=0, ensure_ascii=False))

    scheduled = [r for r in catalog if r["s"]]
    days = sorted({(s["daySort"], s["dayName"], s["date"])
                   for r in catalog for s in r["s"]})
    meta = {"pulled": pulled or time.strftime("%Y-%m-%d"), "catalogTotal": recs_n,
            "sessions": len(catalog), "picks": len(picks),
            "scheduled": len(scheduled),
            "days": [{"sort": d[0], "name": d[1], "date": d[2]} for d in days],
            "facets": facet_index(catalog)}
    (DATA / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))

    out = build_page(catalog, picks, meta)
    print(f"  {len(catalog)} sessions · {len(picks)} picks · "
          f"{len(scheduled)} scheduled · {len(days)} days")
    print(f"  wrote {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
