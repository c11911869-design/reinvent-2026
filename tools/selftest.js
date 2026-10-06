/* In-page test suite for the planner. make_test_build.py appends this to the
   test harness; it runs only with ?selftest=1, against the real app code and
   the stub store:

       ./run.sh --test   then open   TEST-harness.html?as=selftest&reset=1&selftest=1

   Results land in window.__selftest = {pass, fail, results} and in a panel at
   the top of the page. Never published. */
(async function selftest() {
  if (!new URLSearchParams(location.search).has("selftest")) return;
  const results = [];
  const t = async (name, fn) => {
    try { await fn(); results.push({name, ok: true}); }
    catch (e) { results.push({name, ok: false, err: String(e && e.message || e)}); }
  };
  const eq = (a, b, what) => { const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error(`${what || "value"}: expected ${B}, got ${A}`); };
  const ok = (c, what) => { if (!c) throw new Error(what || "assertion failed"); };
  const throws = (fn, re) => { try { fn(); } catch (e) {
      if (re && !re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return; }
    throw new Error("expected an error"); };
  const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
  const text = html => { const d = document.createElement("div"); d.innerHTML = html; return d.textContent.replace(/\s+/g, " ").trim(); };

  // Let boot finish (capabilities resolve asynchronously).
  for (let i = 0; i < 100 && dbState === "connecting"; i++) await tick(50);

  // Fixtures from the real catalog.
  const R2 = CATALOG.find(r => (r.s || []).length > 1 && r.s[0].daySort !== r.s[1].daySort);
  const singles = CATALOG.filter(r => (r.s || []).length === 1);
  const A = singles[0], B = singles[1], C = singles[2];
  const k1 = slotKey(R2.s[0]), k2 = slotKey(R2.s[1]);
  const reset = () => { plan = new Set(); chosen = {}; cmps = []; state.f.clear(); saveCmp(); };
  const codeFor = (name, codes, slots) => { const sv = [plan, chosen];
    plan = new Set(codes); chosen = {...(slots || {})};
    const c = encodePlan(name); [plan, chosen] = sv; return c; };
  const share = () => { const p = $("#sharepanel"); if (p.hidden) $("#share").click(); };
  const importCode = async code => { share(); $("#impIn").value = code; $("#impBtn").click(); await tick(); return $("#impMsg").textContent; };

  reset();

  /* ---------- codec ---------- */
  await t("export → import round-trips sessions, name and chosen showing", () => {
    const d = decodePlan(codeFor("Bob", [R2.c, A.c], {[R2.c]: k2}));
    eq(d.name, "Bob", "name"); eq([...d.codes].sort(), [R2.c, A.c].sort(), "codes");
    eq(d.slots, {[R2.c]: k2}, "slots (single-showing sessions carry none)"); eq(d.dropped, 0, "dropped");
  });
  await t("old v1 codes (no showings) still import", () => {
    const d = decodePlan(TAG + b64e(JSON.stringify({v: 1, name: "Old", codes: [A.c]})));
    eq([...d.codes], [A.c]); eq(d.slots, {});
  });
  await t("a plain JSON body is accepted", () => {
    eq([...decodePlan(JSON.stringify({codes: [B.c]})).codes], [B.c]);
  });
  await t("bad input gives a readable error", () => {
    throws(() => decodePlan(""), /Paste a code/);
    throws(() => decodePlan("RI26-%%%"), /incomplete or corrupted/);
    throws(() => decodePlan("hello"), /isn't a schedule code/);
    throws(() => decodePlan(JSON.stringify({name: "x"})), /No sessions/);
    throws(() => decodePlan(JSON.stringify({codes: ["NOPE999"]})), /None of those/);
  });
  await t("unknown sessions are dropped and counted; duplicates collapse", () => {
    const d = decodePlan(JSON.stringify({codes: [A.c, A.c, "ZZZ999"]}));
    eq([...d.codes], [A.c]); eq(d.dropped, 2);
  });
  await t("a showing that doesn't exist is ignored", () => {
    eq(decodePlan(JSON.stringify({codes: [R2.c], slots: {[R2.c]: "20261299:1"}})).slots, {});
  });
  await t("blank name falls back; long names are cut to 40", () => {
    eq(decodePlan(JSON.stringify({name: "  ", codes: [A.c]})).name, "Their plan");
    eq(decodePlan(JSON.stringify({name: "x".repeat(60), codes: [A.c]})).name.length, 40);
  });
  await t("names can't inject markup", () => {
    reset(); plan = new Set([A.c]);
    cmps = [{name: '<img src=x onerror=alert(1)>', codes: new Set([A.c]), slots: {}}];
    ok(!/<img/.test(cmpBadge(A)) && !/<img/.test(cmpBar()), "raw tag rendered");
  });

  /* ---------- importing teammates ---------- */
  await t("importing adds a teammate and clears the box", async () => {
    reset();
    const m = await importCode(codeFor("Bob", [R2.c, A.c], {[R2.c]: k2}));
    ok(/Added Bob/.test(m), m); eq(cmps.length, 1); eq($("#impIn").value, "", "input cleared");
  });
  await t("a second teammate is added alongside, not instead", async () => {
    await importCode(codeFor("Dana", [A.c, B.c]));
    eq(cmps.map(x => x.name), ["Bob", "Dana"]);
  });
  await t("re-importing the same name (any case) updates that teammate", async () => {
    const m = await importCode(codeFor("bob", [C.c]));
    ok(/Updated bob/.test(m), m); eq(cmps.length, 2); eq([...cmps[0].codes], [C.c]);
    await importCode(codeFor("Bob", [R2.c, A.c], {[R2.c]: k2}));
  });
  await t("imports persist in this browser, showings included", () => {
    const saved = JSON.parse(localStorage.getItem(K.cmp));
    eq(saved.map(x => x.name), ["Bob", "Dana"]); eq(saved[0].slots, {[R2.c]: k2});
    eq(loadCmps(saved).length, 2);
  });
  await t("the old single-comparison format still loads", () => {
    const l = loadCmps({name: "Legacy", codes: [A.c]});
    eq(l.length, 1); eq(l[0].name, "Legacy"); eq(l[0].slots, {});
    eq(loadCmps("junk"), []); eq(loadCmps(null), []); eq(loadCmps([{nope: 1}]), []);
  });
  await t(`at most ${MAX_CMP} teammates`, async () => {
    const keep = cmps.slice();
    cmps = Array.from({length: MAX_CMP}, (_, i) => ({name: "P" + i, codes: new Set([A.c]), slots: {}}));
    const m = await importCode(codeFor("One too many", [A.c]));
    ok(/up to 12/.test(m), m); eq(cmps.length, MAX_CMP);
    cmps = keep; saveCmp();
  });

  /* ---------- what you see ---------- */
  await t("tile: same session, different showing is called out", () => {
    plan = new Set([R2.c]); chosen = {};               // you: first showing; Bob: second
    const b = text(cmpBadge(R2));
    ok(/Bob · other showing/.test(b), b); ok(!/Both/.test(b), b);
  });
  await t("tile: same showing reads Both", () => {
    chosen = {[R2.c]: k2};
    ok(/Both · Bob/.test(text(cmpBadge(R2))), text(cmpBadge(R2)));
  });
  await t("tile: a session only they plan names them", () => {
    plan = new Set();
    eq(text(cmpBadge(A)), "Bob, Dana");
  });
  await t("Days: a teammate shows only on the showing they picked", () => {
    plan = new Set([R2.c]); chosen = {};
    ok(/Bob here/.test(text(cmpBadge(R2, R2.s[1]))), "missing on their showing");
    eq(cmpBadge(R2, R2.s[0]), "", "shown on the wrong showing");
    chosen = {[R2.c]: k2};
    ok(/With Bob/.test(text(cmpBadge(R2, R2.s[1]))), "attending together");
  });
  await t("Days view renders the teammate badge on their row", () => {
    plan = new Set([R2.c]); chosen = {};
    state.view = "days"; state.day = R2.s[1].daySort; render();
    const row = [...document.querySelectorAll(".slotrow")].find(el => el.textContent.includes(R2.c) && el.textContent.includes(R2.s[1].start));
    ok(row && /Bob here/i.test(row.textContent), "badge not on the row");
    state.view = "foryou"; render();
  });
  await t("filters: Both / Only mine / Only theirs", () => {
    plan = new Set([R2.c, C.c]);                     // Bob: R2, A · Dana: A, B
    const pick = f => { state.f.clear(); state.f.add(f); return CATALOG.filter(matches).map(r => r.c).sort(); };
    eq(pick("both"), [R2.c].sort(), "both");
    eq(pick("onlyMine"), [C.c], "only mine");
    eq(pick("onlyTheirs"), [A.c, B.c].sort(), "only theirs");
    state.f.clear();
  });
  await t("comparison bar: one row per teammate with same-showing count", () => {
    plan = new Set([R2.c, A.c]); chosen = {[R2.c]: k2}; render();
    const rows = document.querySelectorAll("#cmpbar .cmpbar");
    eq(rows.length, 2, "rows");
    ok(/2 in common \(2 same showing\)/.test(rows[0].textContent.replace(/\s+/g, " ")), rows[0].textContent);
    ok($("#cmpOff"), "Remove all shown for 2+");
  });
  await t("Remove drops just that teammate; Remove all clears", async () => {
    document.querySelector('#cmpbar [data-rmcmp="0"]').click(); await tick();
    eq(cmps.map(x => x.name), ["Dana"]); ok(!$("#cmpOff"), "Remove all hidden for one");
    eq(JSON.parse(localStorage.getItem(K.cmp)).length, 1, "saved");
    cmps.push({name: "Eli", codes: new Set([A.c]), slots: {}}); saveCmp(); render();
    $("#cmpOff").click(); await tick();
    eq(cmps.length, 0); eq(localStorage.getItem(K.cmp), null); eq($("#cmpChips").innerHTML, "", "chips gone");
  });

  /* ---------- regressions: earlier features ---------- */
  await t("Start over clears plan, answers and comparisons", async () => {
    plan = new Set([A.c]); savePlan(); profile = {tp: [], ai: [], ro: [], in: [], levels: ["300"], fmt: [], hands: true};
    lsSet(K.prof, profile); cmps = [{name: "Bob", codes: new Set([A.c]), slots: {}}]; saveCmp();
    $("#startOver").click(); $("#startOver").click();
    for (let i = 0; i < 40 && plan.size; i++) await tick(50);
    eq(plan.size, 0); eq(cmps.length, 0); eq(localStorage.getItem(K.cmp), null); eq(localStorage.getItem(K.prof), null);
    ok(document.querySelector(".wiz"), "survey reopened");
    $("#wizmount").innerHTML = "";
  });
  await t("match bar never exceeds its stated maximum", () => {
    const P = [[], ["tp"], ["levels"], ["hands"], ["tp", "ai", "ro", "in", "levels", "fmt", "hands"]];
    for (const fields of P) {
      profile = {tp: [], ai: [], ro: [], in: [], levels: [], fmt: [], hands: false};
      if (fields.includes("tp")) profile.tp = ["Artificial Intelligence"];
      if (fields.includes("ai")) profile.ai = ["Agentic AI"];
      if (fields.includes("ro")) profile.ro = ["Developer / Engineer"];
      if (fields.includes("in")) profile.in = ["Government"];
      if (fields.includes("levels")) profile.levels = ["300"];
      if (fields.includes("fmt")) profile.fmt = ["Workshop"];
      if (fields.includes("hands")) profile.hands = true;
      rank(); ok(cutoff <= maxScore, `cutoff ${cutoff} > max ${maxScore} for [${fields}]`);
    }
  });
  await t("For you: every tile has a time, grouped by day in time order", () => {
    profile = {tp: ["Artificial Intelligence"], ai: [], ro: [], in: [], levels: ["300", "400"], fmt: [], hands: true};
    rank(); plan = new Set(); chosen = {}; state.view = "foryou"; render();
    const tiles = [...document.querySelectorAll("#out .tile")];
    ok(tiles.length > 0, "no tiles");
    ok(tiles.every(el => el.querySelector(".whenl")), "a tile has no time");
    const keys = tiles.map(el => whenKey(SESS.get(el.dataset.code)));
    ok(keys.every((k, i) => i === 0 || keys[i - 1] <= k), "tiles out of time order");
    profile = null;
  });

  reset(); render();
  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  window.__selftest = {pass, fail, results};
  const box = document.createElement("pre");
  box.id = "selftest-out";
  box.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999;max-height:50vh;overflow:auto;margin:0;"
    + `padding:10px 14px;font:12px/1.5 ui-monospace,monospace;background:${fail ? "#5a1d1d" : "#16351f"};color:#fff`;
  box.textContent = `SELFTEST ${fail ? "FAIL" : "PASS"} — ${pass}/${results.length}\n`
    + results.map(r => `${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : "\n       " + r.err}`).join("\n");
  document.body.appendChild(box);
  document.title = `${fail ? "FAIL" : "PASS"} ${pass}/${results.length}`;
})();
