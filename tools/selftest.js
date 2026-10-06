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
  const reset = () => { plan = new Set(); chosen = {}; cmps = []; booking = {}; state.f.clear(); saveCmp(); };
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

  /* ---------- Days: the chip row picks the day ---------- */
  const goView = v => { state.view = v; syncViewButtons(); render(); };
  const railDays = () => [...document.querySelectorAll("#trackChips .chip.day")];
  await t("Days: the topic chips become one chip per day", () => {
    reset(); goView("days");
    const chips = railDays();
    eq(chips.length, DAYS.length, "day chips");
    eq(document.querySelectorAll("#trackChips .chip.t").length, 0, "topic chips still shown");
    ok(/^Mon Nov 30\b/.test(chips[0].textContent.trim()), chips[0].textContent);
    eq($("#trackChips").getAttribute("aria-label"), "Choose day");
    ok(/^Monday Nov 30, \d+ sessions$/.test(chips[0].getAttribute("aria-label")), chips[0].getAttribute("aria-label"));
  });
  await t("Days: exactly one chip is pressed, the current day", () => {
    const on = railDays().filter(b => b.getAttribute("aria-pressed") === "true");
    eq(on.map(b => b.dataset.day), [state.day]);
  });
  await t("Days: no duplicate day tabs above the list", () => {
    eq(document.querySelectorAll("#out .daytab").length, 0);
  });
  await t("Days: clicking a chip switches the day and its sessions", async () => {
    const target = DAYS[2].sort;
    railDays().find(b => b.dataset.day === target).click(); await tick();
    eq(state.day, target, "state.day");
    eq(railDays().filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.dataset.day), [target], "pressed");
    const codes = [...document.querySelectorAll("#out .slotrow .code")].map(el => el.textContent);
    ok(codes.length > 0, "no rows");
    const want = dayRows(target).map(x => x.r.c);
    eq(codes, want, "rows are that day's sessions in time order");
  });
  await t("Days: chip counts match the day's list and follow filters", async () => {
    railDays().forEach(b => eq(Number(b.querySelector(".dn").textContent), dayRows(b.dataset.day).length, b.dataset.day));
    const before = Number(railDays()[0].querySelector(".dn").textContent);
    document.querySelector('#miscChips [data-f="hands"]').click(); await tick();
    const after = Number(railDays()[0].querySelector(".dn").textContent);
    ok(after < before, `Hands-on should shrink Monday (${before} → ${after})`);
    document.querySelector('#miscChips [data-f="hands"]').click(); await tick();
  });
  await t("topic filters are kept but don't apply in Days", async () => {
    goView("tracks");
    document.querySelector('#trackChips .chip.t').click(); await tick();
    const tr = [...state.tracks][0];
    ok(tr, "track not selected");
    const curated = document.querySelectorAll("#out .card").length;
    goView("days");
    eq(Number(railDays().find(b => b.dataset.day === state.day).querySelector(".dn").textContent),
       dayRows(state.day).length, "count");
    ok(dayRows(state.day).some(x => !(x.r.pick && x.r.pick.track === tr)), "Days still filtered by topic");
    goView("tracks");
    eq(document.querySelector(`#trackChips [data-t="${tr}"]`).getAttribute("aria-pressed"), "true", "selection lost");
    eq(document.querySelectorAll("#out .card").length, curated, "topic filter no longer applied outside Days");
    $("#reset").click(); await tick();
    eq(state.tracks.size, 0, "Clear");
  });
  await t("Clear in Days keeps the current day selected", async () => {
    goView("days"); const d = state.day;
    $("#reset").click(); await tick();
    eq(railDays().filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.dataset.day), [d]);
    goView("foryou");
  });

  /* ---------- For you: the chip row filters by day ---------- */
  const fyChips = () => [...document.querySelectorAll("#trackChips .chip.day[data-fyday]")];
  const pressed = () => fyChips().filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.dataset.fyday);
  const fyProfile = {tp: ["Artificial Intelligence"], ai: [], ro: [], in: [], levels: ["300", "400"], fmt: [], hands: true};
  await t("For you: topic chips become All days + one chip per day", () => {
    reset(); profile = fyProfile; rank(); state.fyDay = null; goView("foryou");
    const chips = fyChips();
    ok(chips.length >= DAYS.length + 1, `chips: ${chips.length}`);
    eq(chips[0].textContent.replace(/\s+/g, " ").trim().replace(/ \d+$/, ""), "All days");
    eq(document.querySelectorAll("#trackChips .chip.t").length, 0, "topic chips still shown");
    eq(pressed(), [""], "All days pressed by default");
  });
  await t("For you: day counts add up to All days", () => {
    const n = b => Number(b.querySelector(".dn").textContent);
    const [all, ...days] = fyChips();
    eq(days.reduce((a, b) => a + n(b), 0), n(all), "sum");
    eq(n(all), fyMatches().length, "All = matches");
  });
  await t("For you: picking a day shows only that day, top 60 drawn from it", async () => {
    const tue = DAYS[1].sort;
    fyChips().find(b => b.dataset.fyday === tue).click(); await tick();
    eq(pressed(), [tue], "pressed");
    const tiles = [...document.querySelectorAll("#out .tile")];
    ok(tiles.length > 0, "no tiles");
    ok(tiles.every(el => dayOf(SESS.get(el.dataset.code)) === tue), "a tile from another day");
    eq(tiles.length, Math.min(60, fyMatches().filter(x => dayOf(x.r) === tue).length), "count");
    eq(document.querySelectorAll("#out .dayhead").length, 1, "one day section");
    eq(Number($("#count b").textContent), fyVisible().length, "rail count");
  });
  await t("For you: clicking the day again (or All days) returns to every day", async () => {
    const tue = DAYS[1].sort;
    fyChips().find(b => b.dataset.fyday === tue).click(); await tick();
    eq(pressed(), [""], "toggle off");
    fyChips().find(b => b.dataset.fyday === DAYS[3].sort).click(); await tick();
    fyChips()[0].click(); await tick();
    eq(pressed(), [""], "All days"); eq(state.fyDay, null);
    ok(document.querySelectorAll("#out .dayhead").length > 1, "not grouped by day again");
  });
  await t("For you: a session is filed under the showing you chose", () => {
    plan = new Set([R2.c]); chosen = {[R2.c]: k2};
    eq(dayOf(R2), R2.s[1].daySort); chosen = {}; eq(dayOf(R2), R2.s[0].daySort); plan = new Set();
  });
  await t("For you: topic filters are kept but not applied; Curated keeps them", async () => {
    goView("tracks");
    document.querySelector("#trackChips .chip.t").click(); await tick();
    const tr = [...state.tracks][0];
    goView("foryou");
    eq(fyChips().length > 0, true, "day chips");
    ok(fyMatches().some(x => !(x.r.pick && x.r.pick.track === tr)), "For you still filtered by topic");
    goView("tracks");
    eq(document.querySelector(`#trackChips [data-t="${tr}"]`).getAttribute("aria-pressed"), "true");
    $("#reset").click(); await tick();
  });
  await t("Clear resets the For you day to All days", async () => {
    goView("foryou");
    fyChips().find(b => b.dataset.fyday === DAYS[0].sort).click(); await tick();
    $("#reset").click(); await tick();
    eq(state.fyDay, null); eq(pressed(), [""]);
  });
  await t("For you without survey answers keeps the topic chips", () => {
    profile = null; state.fyDay = null; goView("foryou");
    eq(fyChips().length, 0); ok(document.querySelectorAll("#trackChips .chip.t").length > 0);
  });

  /* ---------- Days: replacements for a clash or a too-short walk ---------- */
  // Independent rules, written separately from the app's: travel from the
  // campus table (or 30 min when unknown), no overlap, inside the opening.
  const need = (a, b) => ((TRAVEL[a.venue] || {})[b.venue]?.minutes) ?? (a.venue && a.venue === b.venue ? 10 : 30);
  const clash = (a, b) => a.startMin < b.endMin && b.startMin < a.endMin;
  const monday = DAYS[0].sort;
  const singlesOn = d => CATALOG.filter(r => (r.s || []).length === 1 && r.s[0].daySort === d && r.s[0].venue);
  // A too-short walk: no overlap, but less time than the trip needs.
  const pairWalk = (() => { const xs = singlesOn(monday);
    for (const a of xs) for (const b of xs) { if (a === b || a.s[0].venue === b.s[0].venue) continue;
      const gap = b.s[0].startMin - a.s[0].endMin;
      if (gap >= 0 && gap < need(a.s[0], b.s[0])) return [a, b]; }
    return null; })();
  const problemsFor = codes => { plan = new Set(codes); chosen = {};
    const mine = myDay(monday); return {mine, notes: analyseDay(mine).filter(n => n.verdict !== "ok")}; };
  const independentValid = (n, mine) => {
    const {keep, drop} = suggestFor(n);
    const others = mine.filter(x => x.r !== drop.r);
    const i = others.findIndex(x => x.r === keep.r), after = drop.slot.startMin >= keep.slot.startMin;
    const prev = after ? keep : others[i - 1], next = after ? others[i + 1] : keep;
    const ok1 = (r, sl) => sl.daySort === monday && sl !== drop.slot && (!plan.has(r.c) || r === drop.r)
      && sl.startMin >= drop.slot.startMin - 60 && sl.endMin <= drop.slot.endMin + 60   // fills the hole, not another part of the day
      && !others.some(o => clash(o.slot, sl))
      && (!prev || sl.startMin - prev.slot.endMin >= need(prev.slot, sl) + 10)   // not even "tight"
      && (!next || next.slot.startMin - sl.endMin >= need(sl, next.slot) + 10);
    const all = []; CATALOG.forEach(r => (r.s || []).forEach(sl => { if (ok1(r, sl)) all.push(r.c + "@" + slotKey(sl)); }));
    return {all, ok1, drop};
  };

  // A clash: two single-showing sessions overlapping at different venues that
  // something else could replace (judged by the independent rules, no answers set).
  const pairOverlap = (() => { const xs = singlesOn(monday), sv = profile; profile = null;
    try {
      for (const a of xs) for (const b of xs) {
        if (a === b || a.s[0].venue === b.s[0].venue || a.s[0].startMin >= b.s[0].startMin || !clash(a.s[0], b.s[0])) continue;
        const {mine, notes} = problemsFor([a.c, b.c]);
        if (notes.length && independentValid(notes[0], mine).all.length >= 3) return [a, b];
      }
      return null;
    } finally { profile = sv; plan = new Set(); chosen = {}; }
  })();
  await t("fixtures: a clash and a too-short walk exist on Monday", () => {
    ok(pairOverlap, "no overlapping pair"); ok(pairWalk, "no short-walk pair");
  });
  await t("a clash gets a collapsed suggestions bar under its notice", () => {
    reset(); profile = null; state.sugOpen.clear();
    plan = new Set(pairOverlap.map(r => r.c)); chosen = {}; state.day = monday; goView("days");
    const li = document.querySelector(".advice li");
    ok(li, "no problem listed");
    const d = li.querySelector("details.sugg");
    ok(d, "no suggestions bar"); ok(!d.open, "should start collapsed");
    ok(new RegExp("instead of " + pairOverlap[1].c).test(d.querySelector("summary").textContent), d.querySelector("summary").textContent);
  });
  await t("every suggestion fits: same day, no overlap, enough travel, not already planned", () => {
    const {mine, notes} = problemsFor(pairOverlap.map(r => r.c));
    const list = replacementsFor(notes[0], mine);
    ok(list.length > 0, "nothing suggested");
    const {ok1} = independentValid(notes[0], mine);
    list.forEach(x => ok(ok1(x.r, x.slot), `${x.r.c} ${x.slot.start} breaks a rule`));
  });
  await t("suggestions are complete: nothing that fits is missed", () => {
    const {mine, notes} = problemsFor(pairOverlap.map(r => r.c));
    const got = replacementsFor(notes[0], mine).map(x => x.r.c + "@" + slotKey(x.slot)).sort();
    eq(got, independentValid(notes[0], mine).all.sort());
  });
  await t("best matches first, five shown, the total in the summary", () => {
    profile = {tp: ["Artificial Intelligence"], ai: ["Agentic AI"], ro: [], in: [], levels: ["300", "400"], fmt: [], hands: true}; rank();
    const {mine, notes} = problemsFor(pairOverlap.map(r => r.c));
    const list = replacementsFor(notes[0], mine);
    ok(list.every((x, i) => i === 0 || list[i - 1].score >= x.score), "not ranked by score");
    state.day = monday; goView("days");
    const d = document.querySelector(".advice details.sugg");
    eq(d.querySelectorAll(".sugrow").length, Math.min(5, list.length), "rows");
    ok(d.querySelector("summary").textContent.startsWith(list.length + " session"), d.querySelector("summary").textContent);
    eq(d.querySelector(".sugrow .code").textContent, list[0].r.c, "first row is the best");
  });
  await t("a too-short walk gets suggestions too", () => {
    const {mine, notes} = problemsFor(pairWalk.map(r => r.c));
    ok(notes.length && !notes[0].overlap, "not a travel problem");
    const list = replacementsFor(notes[0], mine), {ok1} = independentValid(notes[0], mine);
    list.forEach(x => ok(ok1(x.r, x.slot), x.r.c));
    state.day = monday; goView("days");
    ok(document.querySelector(".advice details.sugg, .advice .sugg.none"), "no suggestions block");
  });
  await t("the bar stays open (or closed) across re-renders", async () => {
    plan = new Set(pairOverlap.map(r => r.c)); chosen = {}; state.day = monday; goView("days");
    document.querySelector(".advice details.sugg summary").click(); await tick();
    render();
    ok(document.querySelector(".advice details.sugg").open, "closed after re-render");
    document.querySelector(".advice details.sugg summary").click(); await tick();
    render();
    ok(!document.querySelector(".advice details.sugg").open, "open after closing");
  });
  await t("Swap replaces the dropped session and clears that problem", async () => {
    plan = new Set(pairOverlap.map(r => r.c)); chosen = {}; savePlan(); state.day = monday; goView("days");
    const btn = document.querySelector(".advice details.sugg .sugrow button[data-swap]");
    const inCode = btn.dataset.in, slotK = btn.dataset.slot, dropCode = btn.dataset.swap;
    btn.click(); await tick();
    ok(!plan.has(dropCode), "dropped session still planned"); ok(plan.has(inCode), "replacement not planned");
    eq(slotKey(committedSlot(SESS.get(inCode))), slotK, "wrong showing");
    const left = analyseDay(myDay(monday)).filter(n => n.verdict !== "ok");
    ok(!left.some(n => n.A.r.c === inCode || n.B.r.c === inCode), "replacement causes a new problem (even a tight one)");
  });
  await t("Swap releases a session you were covering", async () => {
    plan = new Set(pairOverlap.map(r => r.c)); chosen = {}; savePlan();
    const {mine, notes} = problemsFor(pairOverlap.map(r => r.c));
    const {drop} = suggestFor(notes[0]), first = replacementsFor(notes[0], mine)[0];
    if (!me?.name) await joinAs("Selftest");
    const res = await claimSession(drop.r.c);
    ok(res.ok, "claim failed: " + res.msg);
    swapIn(drop.r.c, first.r.c, slotKey(first.slot));
    for (let i = 0; i < 40 && claims.has(drop.r.c); i++) await tick(50);
    ok(!claims.has(drop.r.c), "claim kept");
  });
  await t("a long session spanning the keeper still blocks suggestions", () => {
    profile = null; rank();   // no answers: the earlier session is kept, the opening is after it
    // Plan the clash plus a long session D that starts before the keeper and runs past it.
    // D isn't the keeper's neighbour in the opening, so only the overlap rule stops
    // suggestions from landing on top of it.
    const [a, b] = pairOverlap;
    const D = CATALOG.find(r => (r.s || []).length === 1 && r.s[0].daySort === monday && r !== a && r !== b
      && r.s[0].startMin < a.s[0].startMin && r.s[0].endMin > a.s[0].endMin + 45);
    ok(D, "no spanning session on Monday");
    const {mine, notes} = problemsFor([a.c, b.c, D.c]);
    const n = notes.find(x => (x.A.r === a && x.B.r === b) || (x.A.r === b && x.B.r === a)) || notes[0];
    const got = replacementsFor(n, mine);
    got.forEach(x => ok(!clash(x.slot, D.s[0]), `${x.r.c} ${x.slot.start} overlaps ${D.c}`));
    eq(got.map(x => x.r.c + "@" + slotKey(x.slot)).sort(), independentValid(n, mine).all.sort(), "complete");
  });
  await t("a session already in your plan (another day) isn't suggested again", () => {
    profile = null; rank();   // no answers: the earlier session is kept, the opening is after it
    const [a, b] = pairOverlap;
    const base = problemsFor([a.c, b.c]);
    const {ok1} = independentValid(base.notes[0], base.mine);
    // E: committed to a later showing on another day, with a Monday showing that would fit.
    const E = CATALOG.find(r => r !== a && r !== b && (r.s || []).length > 1
      && r.s.some(sl => ok1(r, sl)) && r.s.some(sl => sl.daySort !== monday));
    ok(E, "no fixture session with a fitting Monday showing");
    const elsewhere = E.s.find(sl => sl.daySort !== monday);
    plan = new Set([a.c, b.c, E.c]); chosen = {[E.c]: slotKey(elsewhere)};
    const mine = myDay(monday), n = analyseDay(mine).find(x => x.verdict !== "ok");
    ok(!replacementsFor(n, mine).some(x => x.r === E), `${E.c} suggested though it's already planned`);
  });
  await t("with nothing that fits, the notice says so instead of an empty bar", () => {
    const {mine, notes} = problemsFor(pairOverlap.map(r => r.c));
    const html = suggestionsBlock(notes[0], mine, []);
    ok(/No other session fits/.test(html) && !/<details/.test(html), html);
  });
  await t("filters can't hide a clash from the check", async () => {
    const [a, b] = pairOverlap;
    plan = new Set([a.c, b.c]); chosen = {}; state.day = monday; goView("days");
    const before = document.querySelectorAll(".advice li").length;
    state.f.add(a.h ? "deep" : "hands"); state.f.add("plan"); render();   // hide at least one of them
    eq(document.querySelectorAll(".advice li").length, before, "problem vanished under a filter");
    state.f.clear(); render();
  });
  await t("suggestions stay within an hour of the dropped session", () => {
    profile = null; rank();
    const {mine, notes} = problemsFor(pairOverlap.map(r => r.c));
    const {drop} = suggestFor(notes[0]);
    const list = replacementsFor(notes[0], mine);
    ok(list.length > 0, "nothing suggested");
    list.forEach(x => ok(x.slot.startMin >= drop.slot.startMin - 60 && x.slot.endMin <= drop.slot.endMin + 60,
      `${x.r.c} ${x.slot.start}-${x.slot.end} is far from ${drop.r.c} ${drop.slot.start}`));
    const html = suggestionsBlock(notes[0], mine);
    ok(!/earlier in the day/.test(html) && /(after|from) .*(before|until) /.test(html), "summary should name the window");
  });
  await t("the import is findable: the toolbar link says Share / import", () => {
    eq($("#share").textContent.trim(), "Share / import");
    share(); ok(/Import a teammate's schedule/.test($("#sharepanel").textContent), "panel heading"); $("#share").click();
  });
  await t("unknown venue pairs need 30 minutes, not zero", () => {
    eq(needMin({venue: "nowhere"}, {venue: "elsewhere"}), 30);
    eq(needMin({}, {}), 30);
  });
  reset(); profile = null; state.view = "foryou";

  /* ---------- Days: sessions that fit the open time in your plan ---------- */
  const dayBounds = d => { let a = Infinity, b = -Infinity;
    CATALOG.forEach(r => (r.s || []).forEach(sl => { if (sl.daySort === d) { a = Math.min(a, sl.startMin); b = Math.max(b, sl.endMin); } }));
    return [a, b]; };
  // Two Monday sessions with at least two free hours between them, and room on either side.
  const pairGap = (() => { const xs = singlesOn(monday);
    for (const a of xs) for (const b of xs)
      if (a !== b && b.s[0].startMin - a.s[0].endMin >= 120 && a.s[0].startMin >= 600 && b.s[0].endMin <= 960) return [a, b];
    return null; })();
  // Independent check: does showing sl of r fit between p and q (either may be null) on Monday?
  const fitsGap = (r, sl, p, q, mine) => {
    const [first, last] = dayBounds(monday);
    return sl.daySort === monday && !plan.has(r.c)
      && !mine.some(x => clash(x.slot, sl))
      && (p ? sl.startMin - p.slot.endMin >= need(p.slot, sl) + 10 : sl.startMin >= first)
      && (q ? q.slot.startMin - sl.endMin >= need(sl, q.slot) + 10 : sl.endMin <= last);
  };
  const bruteGap = (p, q, mine) => { const all = [];
    CATALOG.forEach(r => (r.s || []).forEach(sl => { if (fitsGap(r, sl, p, q, mine)) all.push(r.c + "@" + slotKey(sl)); }));
    return all.sort(); };

  await t("fixture: two Monday sessions with a two-hour gap", () => ok(pairGap, "none found"));
  await t("an open-time panel lists the gap, collapsed", () => {
    reset(); profile = null; rank(); state.sugOpen.clear();
    plan = new Set(pairGap.map(r => r.c)); chosen = {}; state.day = monday; goView("days");
    const panel = document.querySelector(".advice.freetime");
    ok(panel, "no open-time panel");
    const li = [...panel.querySelectorAll(":scope > ul > li")].find(el => /Between/.test(el.textContent));
    ok(li && li.textContent.includes(pairGap[0].c) && li.textContent.includes(pairGap[1].c), "gap between the two not listed");
    ok(!li.querySelector("details").open, "should start collapsed");
  });
  await t("gap between sessions: suggestions are exactly what fits (brute force)", () => {
    plan = new Set(pairGap.map(r => r.c)); chosen = {};
    const mine = myDay(monday), g = gapsIn(monday, mine).find(x => x.prev && x.next);
    ok(g, "gap missing");
    eq(g.fits.map(x => x.r.c + "@" + slotKey(x.slot)).sort(), bruteGap(g.prev, g.next, mine));
  });
  await t("before your first and after your last: within the day's hours", () => {
    const mine = myDay(monday), gs = gapsIn(monday, mine);
    const before = gs.find(x => !x.prev), after = gs.find(x => !x.next);
    ok(before && after, "edge gaps missing");
    eq(before.fits.map(x => x.r.c + "@" + slotKey(x.slot)).sort(), bruteGap(null, before.next, mine), "before");
    eq(after.fits.map(x => x.r.c + "@" + slotKey(x.slot)).sort(), bruteGap(after.prev, null, mine), "after");
  });
  await t("Add to plan adds that showing and creates no new problem", async () => {
    plan = new Set(pairGap.map(r => r.c)); chosen = {}; savePlan(); state.day = monday; goView("days");
    const btn = [...document.querySelectorAll(".advice.freetime > ul > li")].find(el => /Between/.test(el.textContent))
      .querySelector("button[data-addfit]");
    const code = btn.dataset.addfit, key = btn.dataset.slot;
    btn.click(); await tick();
    ok(plan.has(code), "not added"); eq(slotKey(committedSlot(SESS.get(code))), key, "wrong showing");
    eq(analyseDay(myDay(monday)).filter(n => n.verdict !== "ok").length, 0, "adding it created a problem");
  });
  await t("an added session isn't suggested again, and the gap splits around it", () => {
    const mine = myDay(monday), added = mine.find(x => !pairGap.includes(x.r));
    ok(added, "nothing added");
    const gs = gapsIn(monday, mine);
    ok(!gs.some(g => g.fits.some(x => x.r === added.r)), "suggested again");
    ok(!gs.some(g => g.prev && g.next && g.prev.r === pairGap[0] && g.next.r === pairGap[1]), "old gap still whole");
  });
  await t("Add to plan records the showing you picked, not the first one", async () => {
    // A later day, where a repeat session's non-first showing can fill a gap.
    let x = null;
    for (const d of DAYS.slice(1)) {
      for (const anchor of singlesOn(d.sort).slice(0, 40)) {
        plan = new Set([anchor.c]); chosen = {};
        x = gapsIn(d.sort, myDay(d.sort)).flatMap(g => g.fits).find(f => (f.r.s || []).length > 1 && f.slot !== f.r.s[0]);
        if (x) break;
      }
      if (x) break;
    }
    ok(x, "no multi-showing fit to try");
    const b = document.createElement("button");
    b.dataset.addfit = x.r.c; b.dataset.slot = slotKey(x.slot); out.appendChild(b);
    b.click(); await tick();
    eq(committedSlot(x.r), x.slot, "recorded the wrong showing");
  });
  await t("with a clash already in the plan, gaps respect every session and the true last one", () => {
    // D: a long Monday session; E: inside it (a clash you haven't fixed); F: later on.
    const xs = singlesOn(monday);
    let D, E, F;
    for (const d of xs) { if (d.s[0].endMin - d.s[0].startMin < 120) continue;
      E = xs.find(e => e !== d && e.s[0].startMin > d.s[0].startMin && e.s[0].endMin <= d.s[0].endMin - 45);
      F = xs.find(f => f.s[0].startMin >= d.s[0].endMin + 90 && f.s[0].endMin <= 1080);
      if (E && F) { D = d; break; } }
    ok(D, "no long session with one inside it");
    plan = new Set([D.c, E.c, F.c]); chosen = {};
    const mine = myDay(monday), gs = gapsIn(monday, mine);
    gs.forEach(g => g.fits.forEach(x => ok(!mine.some(m => clash(m.slot, x.slot)), `${x.r.c} ${x.slot.start} overlaps your plan`)));
    const ef = gs.find(g => g.prev?.r === E && g.next?.r === F);
    if (ef) eq(ef.fits.map(x => x.r.c + "@" + slotKey(x.slot)).sort(), bruteGap(E.s.length ? mine.find(m => m.r === E) : null, mine.find(m => m.r === F), mine), "E→F");
    const end = gs.find(g => !g.next);
    ok(!end || end.prev.r === F, "after-last gap should follow the session that finishes last");
    plan = new Set([D.c, E.c]); chosen = {};
    const tail = gapsIn(monday, myDay(monday)).find(g => !g.next);
    ok(!tail || tail.prev.r === D, `after-last gap follows ${tail && tail.prev.r.c}, not ${D.c} which ends later`);
  });
  await t("no open-time panel on a day with nothing planned", () => {
    plan = new Set(); state.day = monday; goView("days");
    ok(!document.querySelector(".advice.freetime"), "panel shown with an empty plan");
    eq(gapsIn(monday, []).length, 0);
  });
  await t("gaps where nothing fits aren't listed", () => {
    plan = new Set(pairGap.map(r => r.c)); chosen = {};
    eq(gapsIn(monday, myDay(monday), []).length, 0);
    eq(gapsPanel(monday, myDay(monday), []), "");
  });
  await t("open-time lists stay open across re-renders", async () => {
    plan = new Set(pairGap.map(r => r.c)); chosen = {}; state.day = monday; goView("days");
    document.querySelector(".advice.freetime details summary").click(); await tick(); render();
    ok(document.querySelector(".advice.freetime details").open, "closed after re-render");
  });
  reset(); profile = null; state.view = "foryou";

  /* ---------- booking status and backups ---------- */
  // The owner's real plan on 2026-10-06, with the two seats actually held then.
  const REAL = ["IND352","AIM408","DVT409","AIM347","IND401","CON401","IND308","DVT339","INV527","AIM458-S","TNC312","INV526","IND328","IND345","AIM402"];
  const REAL_SLOTS = {"AIM347":"20261201:720","AIM402":"20261203:480","AIM408":"20261130:510","AIM458-S":"20261202:750","CON401":"20261201:900","DVT339":"20261202:540","DVT409":"20261130:900","IND308":"20261201:810","IND328":"20261204:510","IND345":"20261204:540","IND352":"20261130:690","IND401":"20261201:960","INV526":"20261203:720","INV527":"20261202:630","TNC312":"20261202:930"};
  const realPlan = () => { plan = new Set(REAL.filter(c => SESS.has(c))); chosen = {...REAL_SLOTS}; booking = {}; };
  const rowFor = (code, slotStart) => [...document.querySelectorAll("#out .slotrow")].find(el =>
    el.querySelector(".code")?.textContent === code && (!slotStart || el.querySelector(".when b")?.textContent === slotStart));

  await t("fixture: the real plan is in this catalog", () => ok(REAL.filter(c => SESS.has(c)).length >= 14, "plan codes missing"));
  await t("Mark booked records the seat, shows the badge and counts it", async () => {
    reset(); profile = null; rank(); realPlan(); savePlan();
    state.day = "20261202"; goView("days");
    const row = rowFor("INV527");
    ok(row && /Not booked/i.test(row.textContent), "INV527 should start Not booked");
    row.querySelector('[data-book][data-st="booked"]').click(); await tick();
    eq(booking.INV527, {status: "booked", slot: "20261202:630"});
    ok(/Booked/.test(rowFor("INV527").querySelector(".bk").textContent), "badge");
    ok(/1<\/b> booked|1 booked/.test($("#count").innerHTML.replace(/<b>/g, "")), $("#count").textContent);
    eq(JSON.parse(localStorage.getItem(K.book)).INV527.status, "booked", "saved locally");
  });
  await t("booking is shared: it goes into your team row and comes back on another device", async () => {
    if (!me?.name) await joinAs("Selftest");
    await pushNow();
    const row = __stub.store().get("attendees/" + myId());
    eq(row.booking.INV527.status, "booked", "not in the shared row");
    const saved = booking; booking = {};
    adoptRemote(row);
    eq(booking.INV527?.status, "booked", "not restored from the shared row"); booking = saved;
  });
  await t("a booked showing wins over the showing you'd picked", () => {
    realPlan();
    const r = SESS.get("AIM408"), wed = r.s.find(sl => sl.daySort === "20261202");
    ok(wed, "no Wednesday AIM408");
    eq(committedSlot(r).daySort, "20261130", "picked Monday");
    booking.AIM408 = {status: "booked", slot: slotKey(wed)};
    eq(committedSlot(r), wed, "booked Wednesday seat should win");
  });
  await t("in a clash, the booked session is kept even if it scores lower", () => {
    realPlan();
    profile = {tp: ["Artificial Intelligence"], ai: ["Agentic AI"], ro: [], in: [], levels: ["300","400"], fmt: [], hands: true}; rank();
    const n = analyseDay(myDay("20261201")).find(x => x.overlap);
    ok(n, "no Tuesday clash in the real plan");
    const low = scoreOf(n.A.r).score <= scoreOf(n.B.r).score ? n.A : n.B;
    booking[low.r.c] = {status: "booked", slot: slotKey(low.slot)};
    const s2 = suggestFor(n);
    eq(s2.keep.r.c, low.r.c, "booked session not kept"); ok(s2.keptBooked);
    state.day = "20261201"; goView("days");
    ok(new RegExp("You hold a seat in " + low.r.c).test(document.querySelector(".advice").textContent), "notice wording");
    profile = null; rank();
  });
  await t("Not booked yet lists only open sessions — not booked or walk-up ones", () => {
    realPlan(); booking.INV527 = {status: "booked", slot: "20261202:630"}; booking.TNC312 = {status: "walkup"};
    state.day = "20261202"; goView("days");
    const panel = document.querySelector(".advice.backups");
    ok(panel, "no backups panel");
    const listed = [...panel.querySelectorAll(":scope > ul > li > b")].map(b => b.textContent);
    ok(!listed.includes("INV527") && !listed.includes("TNC312"), "lists " + listed);
    ok(listed.includes("DVT339") && listed.includes("AIM458-S"), "missing open ones: " + listed);
  });
  await t("backups for a slot are exactly what fits there (brute force)", () => {
    realPlan(); booking.INV527 = {status: "booked", slot: "20261202:630"};
    const day = "20261202", mine = myDay(day), x = mine.find(m => m.r.c === "AIM458-S");
    const {here} = backupsFor(x, mine);
    const others = mine.filter(o => o.r !== x.r);
    const prev = [...others].reverse().find(o => o.slot.endMin <= x.slot.startMin), next = others.find(o => o.slot.startMin >= x.slot.endMin);
    const want = [];
    CATALOG.forEach(r => (r.s || []).forEach(sl => {
      if (sl.daySort !== day || r === x.r || plan.has(r.c)) return;
      if (sl.startMin < x.slot.startMin - 60 || sl.endMin > x.slot.endMin + 60) return;
      if (others.some(o => clash(o.slot, sl))) return;
      if (prev && sl.startMin - prev.slot.endMin < need(prev.slot, sl) + 10) return;
      if (next && next.slot.startMin - sl.endMin < need(sl, next.slot) + 10) return;
      want.push(r.c + "@" + slotKey(sl)); }));
    eq(here.map(f => f.r.c + "@" + slotKey(f.slot)).sort(), want.sort());
  });
  await t("other showings are offered only where they fit that day's plan", () => {
    realPlan();
    const mine = myDay("20261201"), x = mine.find(m => m.r.c === "IND308");
    const {again} = backupsFor(x, mine);
    ok(again.length > 0, "IND308's Friday showing should fit");
    again.forEach(f => { ok(f.r === x.r && f.slot !== x.slot, "not its own other showing");
      const day = myDay(f.slot.daySort).filter(o => o.r !== x.r);
      ok(!day.some(o => clash(o.slot, f.slot)), `${f.slot.dayName} showing overlaps that day's plan`); });
    const x2 = myDay("20261201").find(m => m.r.c === "IND401");
    ok(!backupsFor(x2, myDay("20261201")).again.some(f => f.slot.daySort === "20261202"),
      "IND401's Wednesday 9:00 clashes with DVT339 and must not be offered");
  });
  await t("Walk-up only and Unmark booked change the status", async () => {
    realPlan(); savePlan(); state.day = "20261203"; goView("days");
    rowFor("AIM402").querySelector('[data-book][data-st="walkup"]').click(); await tick();
    eq(bookStatus("AIM402"), "walkup");
    rowFor("AIM402").querySelector('[data-book][data-st="booked"]').click(); await tick();
    eq(bookStatus("AIM402"), "booked");
    rowFor("AIM402").querySelector('[data-book][data-st="open"]').click(); await tick();
    eq(bookStatus("AIM402"), "open");
  });
  await t("tiles show Booked for a session you hold", () => {
    realPlan(); booking.INV527 = {status: "booked", slot: "20261202:630"};
    profile = {tp: ["Artificial Intelligence"], ai: [], ro: [], in: [], levels: [], fmt: [], hands: false}; rank();
    ok(/Booked/.test(text(bookBadge("INV527"))) && /Not booked/.test(text(bookBadge("DVT339"))), "badges");
    eq(bookBadge("ZZZ"), "", "unplanned sessions get no badge");
    profile = null; rank();
  });
  await t("swapping a session out drops its booking; Start over clears all bookings", async () => {
    realPlan(); booking.DVT339 = {status: "walkup"};
    swapIn("DVT339", CATALOG.find(r => !plan.has(r.c)).c, "x");
    ok(!booking.DVT339, "booking kept for a swapped-out session");
    booking.INV527 = {status: "booked", slot: "20261202:630"}; lsSet(K.book, booking);
    $("#startOver").click(); $("#startOver").click();
    for (let i = 0; i < 40 && Object.keys(booking).length; i++) await tick(50);
    eq(booking, {}); eq(localStorage.getItem(K.book), null);
    $("#wizmount").innerHTML = "";
  });
  reset(); booking = {}; profile = null; state.view = "foryou";

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
