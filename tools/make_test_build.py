#!/usr/bin/env python3
"""Build dist/TEST-harness.html: the real page with a stub window.claude, so
the shared-store, coverage, notes, summary and download paths run locally.

Serve dist/ over http (not file://) and open several tabs, one per person:

    TEST-harness.html?as=alice
    TEST-harness.html?as=bob
    TEST-harness.html?as=carol&user=none     no verified identity (local id path)

Tabs on one origin share the stub store through localStorage, so writes in one
tab reach the others live, like the real store. Each ?as= gets its own copy of
the app's own local state. Failure switches, combinable:

    &dbfail=write     every set/delete rejects invalid_argument
    &dbfail=ghost     writes resolve but never land (read-back must catch it)
    &sample=fail      sample rejects rate_limited
    &sample=declined  sample rejects not_granted
    &cap=3000         tiny sample input cap, to force the chunked team summary
    &reset=1          wipe the shared stub store on load
    &selftest=1       run tools/selftest.js and show PASS/FAIL at the top

Never published — a test fixture only.
"""
import pathlib

ROOT = pathlib.Path(__file__).parent.parent

STUB = r"""<meta charset="utf-8">
<script>
/* ---- local test stub for window.claude (NEVER shipped) ---- */
(function () {
  const Q = new URLSearchParams(location.search);
  const AS = Q.get("as") || "alice";
  const KEY = "__stubdb";

  // Each simulated person keeps their own copy of the app's local state.
  const P = Storage.prototype, g = P.getItem, s = P.setItem, rm = P.removeItem;
  const ns = k => (typeof k === "string" && k.startsWith("ri26.")) ? AS + ":" + k : k;
  P.getItem = function (k) { return g.call(this, ns(k)); };
  P.setItem = function (k, v) { return s.call(this, ns(k), v); };
  P.removeItem = function (k) { return rm.call(this, ns(k)); };

  if (Q.get("reset")) localStorage.removeItem(KEY);
  const load = () => new Map(Object.entries(JSON.parse(localStorage.getItem(KEY) || "{}")));
  let store = load();
  const save = () => localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(store)));
  const subs = [];
  const clone = o => JSON.parse(JSON.stringify(o));
  const fire = () => subs.slice().forEach(x => x.run());
  window.addEventListener("storage", e => { if (e.key === KEY) { store = load(); fire(); } });
  const fail = Q.get("dbfail");
  const err = code => Object.assign(new Error(code), {code});
  const write = (fn) => { if (fail === "write") throw err("invalid_argument");
                          if (fail === "ghost") return; fn(); save(); fire(); };
  const snapOf = (id, v) => ({id, exists: !!v, data: () => v && clone(v),
                              metadata: {fromCache: false, hasPendingWrites: false}});
  const leases = new Map();

  function docsUnder(col) {
    return [...store.entries()]
      .filter(([p]) => p.startsWith(col + "/") && p.slice(col.length + 1).indexOf("/") < 0)
      .map(([p, v]) => snapOf(p.split("/").pop(), v));
  }
  function collection(col) {
    const filters = [];
    const api = {
      path: col,
      doc: id => docRef(col + "/" + (id || Math.random().toString(36).slice(2))),
      where(f, op, v) { filters.push([f, op, v]); return api; },
      orderBy() { return api; }, limit() { return api; },
      async get() {
        await new Promise(r => setTimeout(r, 5));
        const docs = docsUnder(col).filter(d =>
          filters.every(([f, op, v]) => op === "==" ? d.data()[f] === v : true));
        return {docs, size: docs.length, empty: !docs.length, docChanges: () => [],
                metadata: {fromCache: false, hasPendingWrites: false}};
      },
      onSnapshot(next) {
        const x = {run: async () => next(await api.get())};
        subs.push(x); x.run();
        return () => { const i = subs.indexOf(x); if (i >= 0) subs.splice(i, 1); };
      },
    };
    return api;
  }
  function docRef(path) {
    const id = path.split("/").pop();
    return {
      id, path,
      async get() { return snapOf(id, store.get(path)); },
      async set(d) { write(() => store.set(path, clone(d))); },
      async update(d) { if (!store.has(path)) throw err("invalid_argument");
        write(() => store.set(path, Object.assign(store.get(path), clone(d)))); },
      async delete() { write(() => store.delete(path)); },
      async acquire({holder, ttlMs}) {
        const cur = leases.get(path), now = Date.now();
        if (cur && cur.until > now && cur.holder !== holder) return {acquired: false};
        leases.set(path, {holder, until: now + (ttlMs || 30000)});
        return {acquired: true, holder, version: 1};
      },
      collection: sub => collection(path + "/" + sub),
      onSnapshot(next) { const x = {run: async () => next(await this.get())};
        subs.push(x); x.run(); return () => { const i = subs.indexOf(x); if (i >= 0) subs.splice(i, 1); }; },
    };
  }
  const db = Object.freeze({doc: docRef, collection});

  const sfail = Q.get("sample");
  window.__sampleCalls = [];
  const sample = Object.assign(
    async (input, opts) => {
      window.__sampleCalls.push(input.length);
      await new Promise(r => setTimeout(r, 150));
      if (sfail === "fail") throw Object.assign(new Error("x"), {code: "rate_limited"});
      if (sfail === "declined") throw Object.assign(new Error("x"), {code: "not_granted"});
      const codes = [...new Set(input.match(/\b[A-Z]{3}\d{3}(-[A-Z0-9]+)?\b/g) || [])];
      const text = `STUB SUMMARY (call ${window.__sampleCalls.length}, ${input.length} chars in). `
        + `Sessions mentioned: ${codes.join(", ") || "none"}.`;
      if (opts?.onText) opts.onText({text, delta: text});
      return {text, truncated: false};
    },
    {json: async () => ({}), limits: async () => ({maxPromptBytes: +(Q.get("cap") || 65536)})});

  window.__lastDownload = null;
  const downloads = Object.freeze({save: async ({filename, data}) => {
    window.__lastDownload = {filename, data}; return {status: "saved"}; }});

  const NAMES = {};
  const user = Q.get("user") === "none" ? null : Object.freeze({
    id: async () => "u_" + AS,
    name: async () => AS[0].toUpperCase() + AS.slice(1),
    me: async () => ({id: "u_" + AS, name: AS[0].toUpperCase() + AS.slice(1)}),
    isOwner: async () => AS === "alice", canEdit: async () => AS === "alice", can: async () => null,
    profiles: async ids => Object.fromEntries([].concat(ids).map(id => [id, {id,
      name: id.startsWith("u_") ? id[2].toUpperCase() + id.slice(3) : "", isMe: id === "u_" + AS}])),
  });

  const map = {db, sample, downloads, user};
  window.claude = {use: async name => { await new Promise(r => setTimeout(r, 30)); return map[name] || null; }};
  window.__stub = {store: () => store, seed: (p, v) => { store.set(p, v); save(); fire(); }};
})();
</script>
"""


def main():
    src = (ROOT / "dist" / "reinvent-2026-planner.html").read_text(encoding="utf-8")
    outp = ROOT / "dist" / "TEST-harness.html"
    tests = (ROOT / "tools" / "selftest.js").read_text(encoding="utf-8")
    outp.write_text(STUB + src + "\n<script>\n" + tests + "\n</script>\n", encoding="utf-8")
    print(f"  wrote {outp.relative_to(ROOT)} ({outp.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
