#!/usr/bin/env python3
"""Build dist/TEST-harness.html: the real page, plus
  (a) real 2025 session times grafted on, so the Days / travel / conflict
      code runs against realistically-shaped schedule data, and
  (b) a stub window.claude so db / sample / downloads paths execute locally.
Never published — a test fixture only.
"""
import json, pathlib, random, sys, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "src"))
import venues as V

H = {"rfapiprofileid": "3RLnuUk7l89cKK2yD9L4v4RTlGwEyJLx",
     "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0"}


def harvest_slots(n=900):
    recs = []
    for frm in range(0, n, 50):
        j = json.load(urllib.request.urlopen(urllib.request.Request(
            "https://catalog.awsevents.com/api/search",
            data=urllib.parse.urlencode({"size": 50, "from": frm, "type": "session"}).encode(),
            headers=H), timeout=60))
        recs += (j["sectionList"][0]["items"] if j.get("sectionList") else j.get("items", []))
    slots = []
    for r in recs:
        for t in r.get("times") or []:
            room = (t.get("room") or "").strip()
            slots.append({"date": t.get("date",""), "daySort": t.get("daySort",""),
                          "dayName": t.get("dayName",""), "start": t.get("startTimeFormatted",""),
                          "end": t.get("endTimeFormatted",""),
                          "startMin": int(t.get("startTimeMin") or 0),
                          "endMin": int(t.get("endTimeMin") or 0),
                          "room": room, "venue": V.venue_key(room),
                          "capacity": int(t.get("capacity") or 0)})
    return slots


STUB = r"""
<script>
/* ---- local test stub for window.claude (NEVER shipped) ---- */
(function () {
  const store = new Map();                     // path -> body
  const subs = [];
  const clone = o => JSON.parse(JSON.stringify(o));
  const fire = () => subs.forEach(s => s.run());
  function docsUnder(col) {
    return [...store.entries()]
      .filter(([p]) => p.startsWith(col + "/") && p.slice(col.length + 1).indexOf("/") < 0)
      .map(([p, v]) => ({id: p.split("/").pop(), exists: true, data: () => clone(v)}));
  }
  function collection(col) {
    const filters = [];
    const api = {
      doc: id => docRef(col + "/" + id),
      where(f, op, v) { filters.push([f, op, v]); return api; },
      async get() {
        const docs = docsUnder(col).filter(d =>
          filters.every(([f, op, v]) => op === "==" ? d.data()[f] === v : true));
        return {docs, size: docs.length, empty: !docs.length, docChanges: () => [],
                metadata: {fromCache: false, hasPendingWrites: false}};
      },
      onSnapshot(next) {
        const s = {run: async () => next(await api.get())};
        subs.push(s); s.run();
        return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
      },
    };
    return api;
  }
  function docRef(path) {
    return {
      id: path.split("/").pop(), path,
      async get() { const v = store.get(path);
        return {id: path.split("/").pop(), exists: !!v, data: () => v && clone(v),
                metadata: {fromCache: false, hasPendingWrites: false}}; },
      async set(d) { store.set(path, clone(d)); fire(); },
      async update(d) { if (!store.has(path)) { const e = new Error("no doc"); e.code = "invalid_argument"; throw e; }
        store.set(path, Object.assign(store.get(path), clone(d))); fire(); },
      async delete() { store.delete(path); fire(); },
      collection: sub => collection(path + "/" + sub),
      onSnapshot(next) { const s = {run: async () => next(await this.get())};
        subs.push(s); s.run(); return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); }; },
    };
  }
  const db = Object.freeze({doc: docRef, collection});
  const sample = Object.assign(
    async (input, opts) => {
      const text = "STUB SUMMARY. All three notes converge on the same point: the "
        + "architecture holds up, but the governance story is what makes it shippable. "
        + "Follow-up named by two of them: get the CloudFormation templates reviewed.";
      if (opts?.onText) opts.onText({text, delta: text});
      return {text, truncated: false};
    },
    {json: async () => ({}), limits: async () => ({images: false})});
  const downloads = Object.freeze({save: async ({filename}) => {
    window.__lastDownload = filename; return {status: "saved"}; }});
  const map = {db, sample, downloads};
  window.claude = {use: async name => { await new Promise(r => setTimeout(r, 30)); return map[name] || null; }};
  window.__stub = {store, seed: (p, v) => { store.set(p, v); fire(); }};
})();
</script>
"""


def main():
    src = (ROOT / "dist" / "reinvent-2026-planner.html").read_text(encoding="utf-8")
    catalog = json.loads((ROOT / "data" / "catalog.json").read_text())
    meta = json.loads((ROOT / "data" / "meta.json").read_text())

    print("harvesting real 2025 slots…")
    pool = harvest_slots()
    print(f"  {len(pool)} slots, "
          f"{sum(1 for s in pool if s['venue'])} mapped to a venue")

    random.seed(11)
    # Schedule the curated picks (so the Days view has meaningful content),
    # some with repeats, so conflict + alternate-showing logic is exercised.
    picks = {p["code"] for p in json.loads((ROOT / "data" / "picks.json").read_text())}
    for r in catalog:
        if r["c"] in picks:
            n = random.choices([1, 2, 3], weights=[64, 26, 10])[0]
            r["s"] = sorted((dict(s, code=r["c"]) for s in random.sample(pool, n)),
                            key=lambda s: (s["daySort"], s["startMin"]))
    days = sorted({(s["daySort"], s["dayName"], s["date"]) for r in catalog for s in r["s"]})
    meta["days"] = [{"sort": d[0], "name": d[1], "date": d[2]} for d in days]
    meta["scheduled"] = sum(1 for r in catalog if r["s"])
    meta["pulled"] = "TEST-FIXTURE"

    body = src
    body = body.replace("const CATALOG=" + json.dumps(
        json.loads((ROOT / "data" / "catalog.json").read_text()),
        separators=(",", ":"), ensure_ascii=False) + ";",
        "const CATALOG=" + json.dumps(catalog, separators=(",", ":"), ensure_ascii=False) + ";")
    # meta is small; replace by locating its line
    import re
    body = re.sub(r"const META=\{.*?\};\n",
                  "const META=" + json.dumps(meta, separators=(",", ":"), ensure_ascii=False) + ";\n",
                  body, count=1, flags=re.S)
    body = STUB + body

    outp = ROOT / "dist" / "TEST-harness.html"
    outp.write_text(body, encoding="utf-8")
    print(f"  {meta['scheduled']} scheduled across {len(days)} days")
    print(f"  wrote {outp.relative_to(ROOT)} ({outp.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
