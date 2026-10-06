/* ===================================================================
   Mission Track — re:Invent 2026 planner
   CATALOG: every session (slim)   PICKS: curated overlay
   META: build stats + facet index VENUES/TRAVEL: campus graph
   =================================================================== */

const TRACKS = [
 ["mission","Public Sector & Mission","Agencies that actually shipped: the IRS, the Air Force SOC, a state HHS eligibility engine, a university landing zone. ATO paths, IL4/IL5, GovCloud, sovereignty boundaries.","Public Sector"],
 ["train","Training & Inference Infrastructure","The deepest technical material in the catalog. GPU and Trainium clusters, distributed training, disaggregated inference, and the failure modes that only appear at scale.","Training Infra"],
 ["mlops","ML Platform & ModelOps","Lineage, model cards, approval gates, drift monitoring, multi-account isolation — the machinery that turns a model into something an authorizing official will sign.","ML Platform"],
 ["physical","Robotics & Physical AI","World models, VLA policies, sim-to-real, digital twins, and the compute pipelines underneath them.","Robotics"],
 ["hpc","HPC & Simulation","Parallel Computing Service, Batch-driven burst simulation, EFA fabric, and the storage that keeps a cluster fed.","HPC & Sim"],
 ["data","Data Engineering & Data Science","Iceberg lakehouses, retrieval that survives agent-scale query volume, forecasting foundation models, and the data-quality work everything else rests on.","Data"],
 ["build","Agentic App Development","Steering agents rather than prompting them: reusable skills, spec validation, deterministic orchestration.","App Dev"],
 ["rigor","Evaluation, Verification & Safety","Formal guarantees instead of vibes — provable safety envelopes, neurosymbolic verification, continuous eval pipelines.","Eval & Safety"],
];
const TNAME = Object.fromEntries(TRACKS.map(([id,n]) => [id,n]));
const TSHORT = Object.fromEntries(TRACKS.map(([id,,,s]) => [id,s]));

/* ---------- index ---------- */
const SESS = new Map();
CATALOG.forEach(r => { r.pick = null; SESS.set(r.c, r); });
PICKS.forEach(p => { const r = SESS.get(p.code); if (r) r.pick = p; });
const CURATED = PICKS.map(p => SESS.get(p.code)).filter(Boolean);
const VNAME = Object.fromEntries(VENUES.map(v => [v.k, v.n]));

const $ = s => document.querySelector(s);
/* Script errors are otherwise invisible inside the viewer's frame; keep the
   last one for the diagnostics line. */
let lastError = "";
function noteError(e) { lastError = String(e?.message || e?.reason?.message || e?.reason || e).slice(0, 160); }
window.addEventListener("error", e => noteError(e.error || e.message));
window.addEventListener("unhandledrejection", e => noteError(e.reason));
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const out = $("#out");

/* ---------- local state ---------- */
const K = {plan:"ri26.plan", prof:"ri26.profile", me:"ri26.me", cmp:"ri26.compare", slots:"ri26.slots", book:"ri26.booking"};
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} };

let plan = new Set(lsGet(K.plan, []));
let profile = lsGet(K.prof, null);
let me = lsGet(K.me, null);           // {id, name}
let chosen = lsGet(K.slots, {});   // code -> "daySort:startMin" of the showing you'll attend
/* What happened in the AWS portal: code -> {status: "booked"|"walkup", slot}. A
   booked seat pins the showing; "walkup" means AWS won't take a reservation. */
let booking = lsGet(K.book, {});
const saveBooking = () => { lsSet(K.book, booking); pushPlan(); };
const bookStatus = code => plan.has(code) ? (booking[code]?.status || "open") : null;
/* Teammates' imported plans, for comparison: [{name, codes:Set, slots:{code: slotKey}}].
   Older pages stored a single {name, codes}; read that as a list of one. */
const MAX_CMP = 12;
function loadCmps(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.codes) ? [raw] : []);
  return arr.filter(x => x && Array.isArray(x.codes)).slice(0, MAX_CMP).map(x => ({
    name: String(x.name || "Imported").slice(0, 40), codes: new Set(x.codes),
    slots: x.slots && typeof x.slots === "object" ? x.slots : {}}));
}
let cmps = loadCmps(lsGet(K.cmp, null));

const savePlan = () => { lsSet(K.plan, [...plan]); pushPlan(); };
const slotKey = sl => `${sl.daySort}:${sl.startMin}`;
/* A repeated session is attended ONCE. Default to its first showing. */
function committedSlot(r) {
  const all = r.s || [];
  if (!all.length) return null;
  // A booked seat wins over the showing you'd picked.
  const want = booking[r.c]?.status === "booked" && booking[r.c].slot ? booking[r.c].slot : chosen[r.c];
  return all.find(sl => slotKey(sl) === want) || all[0];
}
const isCommitted = (r, sl) => committedSlot(r) === sl;
function chooseSlot(code, key) { chosen[code] = key; lsSet(K.slots, chosen); }
/* Replace a planned session with a suggested one (or move it to another showing).
   A claim you held on the one you drop is released so a teammate can take it. */
function swapIn(dropCode, inCode, key) {
  if (inCode !== dropCode) {
    plan.delete(dropCode); delete chosen[dropCode]; delete booking[dropCode]; lsSet(K.book, booking);
    if (claims.get(dropCode) && isMe(claims.get(dropCode).by)) releaseSession(dropCode).then(render);
  }
  plan.add(inCode); chooseSlot(inCode, key); savePlan(); render();
}
const saveCmp = () => cmps.length
  ? lsSet(K.cmp, cmps.map(x => ({name:x.name, codes:[...x.codes], slots:x.slots})))
  : localStorage.removeItem(K.cmp);
const whoHas = code => cmps.filter(x => x.codes.has(code));
/* The showing a teammate picked, falling back to the first like committedSlot. */
function theirSlot(x, r) {
  const all = r.s || [];
  return all.find(sl => slotKey(sl) === x.slots[r.c]) || all[0] || null;
}

const state = {q:"", tracks:new Set(), f:new Set(), view:"foryou", day:null, fyDay:null, sugOpen:new Set()};

/* ---------- capabilities (resolve late, never assumed) ---------- */
let DB = null, SAMPLE = null, DL = null, USER = null;
let uid = null;                // verified account id from the user capability, when served
let attendees = [];            // [{id,name,plan:[],slots:{},updated}]
let notesByCode = new Map();   // code -> [{id,by,name,text,updated}]
let claims = new Map();        // code -> {code,by,at}: who is covering a session for the team
let summaries = new Map();     // code | "_team" -> {text,by,at,noteCount,stamp}
let dbState = "connecting";    // connecting | ready | unavailable
let dbError = "";              // last write error code, surfaced in the UI
let feedError = "";            // a live subscription died; the view may be stale
const explain = {
  not_persisted: "The write was accepted locally but never reached the shared store.",
  readback_failed: "The write was sent but could not be read back.",
  invalid_argument: "The shared store refused the write as invalid.",
  not_granted: "This view was not granted access to the shared store.",
  revoked: "Access to the shared store was withdrawn while the page was open.",
  quota_exceeded: "The shared store is full.",
  resource_exhausted: "Too many writes at once — wait a moment and try again.",
};
const explainDb = c => explain[c] || "The shared store rejected the last write.";

/* Who am I? A verified account id when the page is served with `user`,
   otherwise the random id this browser minted when you joined. */
const myId = () => uid || me?.id || null;
const isMe = id => !!id && id === myId();

/* Display names. Profile names are resolved per viewer and never stored;
   the self-declared name on the attendee row is the fallback. */
let profileNames = {};
function nameOf(id, fallback) {
  return profileNames[id] || fallback
    || attendees.find(a => a.id === id)?.name || "Someone";
}
let namesInFlight = false;
async function resolveNames() {
  if (!USER || namesInFlight) return;
  const ids = [...new Set([...attendees.map(a => a.id),
    ...[...claims.values()].map(c => c.by),
    ...[...notesByCode.values()].flat().map(n => n.by)].filter(Boolean))];
  const missing = ids.filter(id => !(id in profileNames));
  if (!missing.length) return;
  namesInFlight = true;
  try {
    const ps = await USER.profiles(ids);
    let changed = false;
    ids.forEach(id => { const n = ps[id]?.name || ""; if (profileNames[id] !== n) { profileNames[id] = n; changed = true; } });
    if (changed) { render(); if (openCode) refreshDrawer(); }
  } catch (e) { /* profiles() never rejects; nothing to do */ }
  finally { namesInFlight = false; }
}

function watch(col, onDocs) {
  try {
    DB.collection(col).onSnapshot(
      snap => { onDocs(snap.docs.map(d => ({id:d.id, ...d.data()}))); render(); if (openCode) refreshDrawer(); resolveNames(); },
      err => { feedError = `${col}: ${err?.code || "error"}`; render(); });
  } catch (e) { feedError = `${col}: ${e?.code || "error"}`; }
}

async function bootCaps() {
  if (typeof window.claude?.use !== "function") { dbState = "unavailable"; render(); return; }
  const use = async n => { try { return await window.claude.use(n); } catch (e) { return null; } };
  [DB, SAMPLE, DL, USER] = await Promise.all([use("db"), use("sample"), use("downloads"), use("user")]);
  if (USER) { try { uid = await USER.id(); } catch (e) { uid = null; } }
  dbState = DB ? "ready" : "unavailable";
  if (DB) {
    watch("attendees", docs => {
      attendees = docs;
      // The same person on another device changed their plan: take it.
      const row = docs.find(a => isMe(a.id));
      if (row?.updated && lastPushed && row.updated > lastPushed && !pushT) adoptRemote(row);
    });
    watch("notes", docs => {
      notesByCode = new Map();
      docs.forEach(n => { if (!n.code) return;
        (notesByCode.get(n.code) || notesByCode.set(n.code, []).get(n.code)).push(n); });
    });
    // A lease can leave a claim doc with no owner in its body — that is unclaimed.
    watch("claims", docs => { claims = new Map(docs.filter(c => c.by).map(c => [c.id, c])); });
    watch("summaries", docs => { summaries = new Map(docs.map(s => [s.id, s])); });
    if (me?.id && uid && me.id !== uid) await adoptVerifiedId();
    // What the store holds for me wins over this browser's copy: it is how a
    // second device picks up your plan instead of overwriting it with nothing.
    let remote = null;
    if (myId()) { try { const s = await DB.doc("attendees/" + myId()).get(); if (s.exists) remote = s.data(); } catch (e) {} }
    if (remote) { adoptRemote(remote); lastPushed = remote.updated || ""; }
    else if (me?.name) pushNow();   // joined before the store was reachable
  }
  if (USER && !me?.name) { try { suggestedName = await USER.name(); } catch (e) {} }
  render();
}
let suggestedName = "";

/* Replace this browser's plan with the shared copy of it. */
function adoptRemote(row) {
  plan = new Set(row.plan || []); lsSet(K.plan, [...plan]);
  Object.assign(chosen, row.slots || {}); lsSet(K.slots, chosen);
  if (row.booking && typeof row.booking === "object") { booking = row.booking; lsSet(K.book, booking); }
  me = {id: myId(), name: row.name || me?.name || ""}; lsSet(K.me, me);
  if (profile) rank();
}
let lastPushed = "";

/* This browser joined under a random local id before the page could verify
   who you are. Move that row and your notes onto the verified id, once. */
async function adoptVerifiedId() {
  const old = me.id;
  try {
    const mine = (await DB.collection("notes").where("by", "==", old).get()).docs;
    for (const d of mine) {
      const n = d.data();
      await DB.doc(`notes/${n.code}__${uid}`).set({...n, by:uid});
      await DB.doc(`notes/${d.id}`).delete();
    }
    const held = (await DB.collection("claims").where("by", "==", old).get()).docs;
    for (const d of held) await DB.doc(`claims/${d.id}`).set({...d.data(), by:uid});
    await DB.doc("attendees/" + old).delete();
  } catch (e) { dbError = e?.code || "error"; }
  me = {...me, id:uid}; lsSet(K.me, me);
}

function planDoc() {
  const slots = {};
  plan.forEach(c => { const r = SESS.get(c), sl = r && committedSlot(r); if (sl) slots[c] = slotKey(sl); });
  const bk = {}; plan.forEach(c => { if (booking[c]) bk[c] = booking[c]; });
  return {name: me.name, plan: [...plan], slots, booking: bk, updated: new Date().toISOString(),
          topics: profile?.tp || [], areas: profile?.ai || []};
}

/* Write my plan to the shared store, then READ IT BACK before claiming success.
   set() can resolve from the local cache before the server has confirmed, so a
   resolved promise is not evidence the row persisted — only a read-back is. */
async function pushNow() {
  if (!DB || !me?.name || !myId()) return false;
  const ref = DB.doc("attendees/" + myId());
  const body = planDoc();
  try {
    await ref.set(body); lastPushed = body.updated;
  } catch (err) { dbError = err?.code || "error"; render(); return false; }
  try {
    const snap = await ref.get();
    if (!snap.exists) { dbError = "not_persisted"; render(); return false; }
  } catch (err) { dbError = err?.code || "readback_failed"; render(); return false; }
  dbError = ""; return true;
}

/* Debounced mirror, for ordinary plan edits. */
let pushT = null;
function pushPlan() {
  if (!DB || !me?.name) return;
  clearTimeout(pushT);
  pushT = setTimeout(() => { pushT = null; pushNow(); }, 600);
}

/* ---------- coverage: one person takes each session for the team ---------- */
/* A claim is first-come. A bare get-then-set races (both think they won), so
   hold a short lease on the claim doc while checking and writing it. */
async function claimSession(code, takeOver) {
  if (!DB || !me?.name) return {ok:false, msg:"Join under Team first."};
  const ref = DB.doc("claims/" + code);
  try {
    const lease = await ref.acquire({holder: myId(), ttlMs: 5000});
    if (!lease.acquired) return {ok:false, msg:"Someone is claiming this right now — try again in a few seconds."};
    const cur = await ref.get();
    const by = cur.exists ? cur.data().by : null;
    if (by && !isMe(by) && !takeOver) return {ok:false, msg:`${nameOf(by)} is already covering it.`};
    await ref.set({code, by: myId(), at: new Date().toISOString()});
    const back = await ref.get();
    if (!back.exists || back.data().by !== myId()) return {ok:false, msg:"The claim did not stick — someone else may have taken it."};
  } catch (err) { return {ok:false, msg:`${explainDb(err?.code)} (${err?.code || "error"})`}; }
  claims.set(code, {code, by: myId()});
  if (!plan.has(code)) { plan.add(code); savePlan(); }
  return {ok:true, msg:"You're covering it."};
}
async function releaseSession(code) {
  const c = claims.get(code);
  if (!DB || !c || !isMe(c.by)) return {ok:false, msg:"Only the person covering it can release it."};
  try { await DB.doc("claims/" + code).delete(); }
  catch (err) { return {ok:false, msg:`${explainDb(err?.code)} (${err?.code || "error"})`}; }
  claims.delete(code);
  return {ok:true, msg:"Released — it's open for someone else."};
}
/* Who plans a session, with the showing each of them picked. */
function plannersOf(code) {
  const r = SESS.get(code);
  return attendees.filter(a => (a.plan || []).includes(code)).map(a => {
    const want = a.slots?.[code];
    const slot = r && ((r.s || []).find(s => slotKey(s) === want) || (r.s || [])[0]);
    return {a, slot};
  });
}

/* ===================================================================
   Recommender
   =================================================================== */
const W = {tp:3, ai:3, ro:2, in:4, level:2, fmt:2, hands:2, curated:5, core:4, sponsored:-2};

function scoreOf(r) {
  if (!profile) return {score:0, why:[]};
  let s = 0; const why = [];
  const hit = (field, weight, label) => {
    const want = new Set(profile[field] || []);
    const got = (r[field] || []).filter(v => want.has(v));
    if (got.length) { s += weight * Math.min(got.length, 2); why.push(...got.slice(0,2)); }
  };
  hit("tp", W.tp); hit("ai", W.ai); hit("ro", W.ro); hit("in", W.in);
  const lv = parseInt(r.l, 10);
  if (!isNaN(lv) && profile.levels?.length) {
    if (profile.levels.includes(r.l)) s += W.level;
    else if (profile.levels.some(x => Math.abs(parseInt(x,10) - lv) === 100)) s += 1;
  }
  if (profile.fmt?.length && profile.fmt.includes(r.y)) { s += W.fmt; why.push(r.y); }
  if (profile.hands && r.h) { s += W.hands; why.push("Hands-on"); }
  if (r.pick) { s += W.curated; if (r.pick.tier === 1) s += W.core; }
  if (r.sp) s += W.sponsored;
  return {score:s, why:[...new Set(why)].slice(0,3)};
}

/* The most a session can score against THIS profile. Only fields the profile
   actually populates can contribute, so a sparse profile has a low ceiling. */
function profileCeiling() {
  if (!profile) return 0;
  return (profile.tp?.length ? W.tp * 2 : 0)
       + (profile.ai?.length ? W.ai * 2 : 0)
       + (profile.ro?.length ? W.ro * 2 : 0)
       + (profile.in?.length ? W.in * 2 : 0)
       + (profile.levels?.length ? W.level : 0)
       + (profile.fmt?.length ? W.fmt : 0)
       + (profile.hands ? W.hands : 0);
}

let ranked = [], cutoff = 0, ceiling = 0, maxScore = 0, positives = 0;
const MIN_SIGNAL = 6;      // one weak tag hit never counts as a match
const SHARE = 0.10;        // keep at most this share of the catalog
const FRACTION = 0.35;     // ...and at least this fraction of what's achievable

/* Adaptive bar. Scores inflate two ways as a profile broadens: more fields
   populated raises every score, and more options inside a field makes the
   two-hit cap easier to reach. A fixed threshold misses both, so the bar is
   the strictest of three rules — an absolute floor, a share of the profile's
   own ceiling, and a share of the catalog. */
function rank() {
  ceiling = profileCeiling();
  // Scores also carry the curated/core bonus, so the true top score is higher
  // than what interests alone can reach. Quote that, or the bar can read as
  // "6 of a possible 4".
  maxScore = ceiling + W.curated + W.core;
  const all = CATALOG.map(r => ({r, ...scoreOf(r)}))
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score || (a.r.pick?1:0) - (b.r.pick?1:0) || a.r.c.localeCompare(b.r.c));
  positives = all.length;

  const targetN = Math.min(180, Math.max(24, Math.round(CATALOG.length * SHARE)));
  const atTarget = all.length > targetN ? all[targetN - 1].score : 0;
  // The floor can't ask for more than your answers can award, or a sparse
  // profile would let nothing but curated picks through.
  const floor = ceiling ? Math.min(MIN_SIGNAL, ceiling) : MIN_SIGNAL;
  cutoff = Math.max(floor, Math.ceil(ceiling * FRACTION), atTarget);

  // Filter by score, not by index, so a run of tied scores is never cut in half.
  // Scores are coarse integers, so the group sitting exactly on the bar can be
  // large; when keeping it overshoots the target badly, step the bar up a point
  // rather than cut equivalent sessions apart arbitrarily.
  ranked = all.filter(x => x.score >= cutoff);
  const floorN = Math.max(24, Math.round(targetN * 0.4));
  while (ranked.length > targetN * 1.6) {
    const tighter = all.filter(x => x.score >= cutoff + 1);
    if (tighter.length < floorN) break;
    cutoff += 1; ranked = tighter;
  }
  if (ranked.length < 12) { ranked = all.slice(0, Math.min(24, all.length)); cutoff = 0; }
}

/* ===================================================================
   Onboarding
   =================================================================== */
const FACETS = META.facets || {};
const topFacet = (f, n) => (FACETS[f] || []).slice(0, n);

const STEPS = [
  {key:"tp", title:"What do you work on?",
   help:"Pick the topics you'd actually block time for. These are the catalog's own topic tags — the count is how many sessions carry each.",
   opts:() => topFacet("tp", 18)},
  {key:"ai", title:"Anything more specific?",
   help:"Areas of interest sit under the topics. Choose the ones that describe your day, not your aspirations.",
   opts:() => topFacet("ai", 20)},
  {key:"ro", title:"How would you describe your role?",
   help:"AWS tags sessions by intended audience. Picking one or two sharpens the ranking more than picking five.",
   opts:() => topFacet("ro", 12)},
  {key:"in", title:"Any industry that matters to you?",
   help:"Only 145 sessions carry an industry tag, but when one matches it is a strong signal. Skip this if none apply.",
   opts:() => topFacet("in", 12)},
];
const LEVELS = [["100","100 — Foundational"],["200","200 — Intermediate"],
                ["300","300 — Advanced"],["400","400 — Expert"],["500","500 — Distinguished"]];
const FORMATS = ["Chalk talk","Workshop","Builders' session","Code talk",
                 "Breakout session","Lightning talk","Lab","Bootcamp"];

let draft = null, step = 0;

function openWizard(reopen) {
  draft = reopen && profile
    ? JSON.parse(JSON.stringify(profile))
    : {tp:[], ai:[], ro:[], in:[], levels:["300","400"], fmt:[], hands:true};
  step = 0;
  renderWizard();
}

function renderWizard() {
  const total = STEPS.length + 1;
  const bars = Array.from({length:total}, (_,i) => `<i class="${i<=step?"on":""}"></i>`).join("");
  let body;
  if (step < STEPS.length) {
    const st = STEPS[step];
    const sel = new Set(draft[st.key]);
    body = `<div class="q"><h2>${esc(st.title)}</h2><p>${esc(st.help)}</p>
      <div class="opts" data-key="${st.key}">${st.opts().map(([v,n]) =>
        `<button class="opt" type="button" data-v="${esc(v)}" aria-pressed="${sel.has(v)}">
           ${esc(v)}<span class="n">${n}</span></button>`).join("")}</div></div>`;
  } else {
    const lv = new Set(draft.levels), fm = new Set(draft.fmt);
    body = `<div class="q"><h2>Depth and format</h2>
      <p>Level is the first digit of a session code. Format decides whether you should book a seat at all — breakouts are recorded, everything else is not.</p>
      <div class="opts" data-key="levels">${LEVELS.map(([v,l]) =>
        `<button class="opt" type="button" data-v="${v}" aria-pressed="${lv.has(v)}">${esc(l)}</button>`).join("")}</div>
      <div style="height:16px"></div>
      <div class="opts" data-key="fmt">${FORMATS.map(v =>
        `<button class="opt" type="button" data-v="${esc(v)}" aria-pressed="${fm.has(v)}">${esc(v)}</button>`).join("")}</div>
      <div style="height:16px"></div>
      <div class="opts" data-key="hands"><button class="opt" type="button" data-v="hands"
        aria-pressed="${!!draft.hands}">Prefer hands-on sessions<span class="n">400</span></button></div>
    </div>`;
  }
  const chosen = STEPS.reduce((n,s) => n + draft[s.key].length, 0);
  $("#wizmount").innerHTML = `<div class="wiz"><div class="wiz-in">
    <div class="wiz-head">
      <h1>${step===0 ? "Let's tune this to you" : "A few more"}</h1>
      <p>${step===0
        ? "Five quick questions. They score all "+CATALOG.length.toLocaleString()+" published sessions against what you care about and build your front page. Nothing leaves your browser."
        : "You can change any of this later from <b>Interests</b> in the toolbar."}</p>
    </div>
    <div class="steps">${bars}</div>
    ${body}
    <div class="wiz-nav">
      ${step>0 ? '<button class="btn ghost" id="wBack" type="button">Back</button>' : ""}
      <button class="btn" id="wNext" type="button">${step<STEPS.length ? "Next" : "Build my page"}</button>
      ${step<STEPS.length ? '<button class="btn ghost" id="wSkip" type="button">Skip</button>' : ""}
      <span class="msg">${chosen} selected</span>
    </div>
  </div></div>`;
}

$("#wizmount").addEventListener("click", e => {
  const opt = e.target.closest(".opt");
  if (opt) {
    const key = opt.parentElement.dataset.key;
    const v = opt.dataset.v;
    if (key === "hands") draft.hands = !draft.hands;
    else {
      const arr = draft[key] || (draft[key] = []);
      const i = arr.indexOf(v);
      i < 0 ? arr.push(v) : arr.splice(i, 1);
    }
    renderWizard(); return;
  }
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "wBack") { step--; renderWizard(); }
  if (b.id === "wSkip") { step++; renderWizard(); }
  if (b.id === "wNext") {
    if (step < STEPS.length) { step++; renderWizard(); }
    else {
      profile = draft; lsSet(K.prof, profile);
      $("#wizmount").innerHTML = "";
      rank(); state.view = "foryou"; syncViewButtons(); render(); pushPlan();
    }
  }
});

/* ===================================================================
   Travel & conflicts
   =================================================================== */
function travelBetween(a, b) {
  if (!a || !b) return null;
  if (a === b) return {minutes:10, same:true, shuttle:false, note:"Same venue, but these properties are large."};
  return (TRAVEL[a] || {})[b] || null;
}

/* Day plan with gaps annotated. rows: [{r, slot}] sorted by start. */
function analyseDay(rows) {
  const notes = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const A = rows[i], B = rows[i+1];
    const overlap = A.slot.startMin < B.slot.endMin && B.slot.startMin < A.slot.endMin;
    const gap = B.slot.startMin - A.slot.endMin;
    const t = travelBetween(A.slot.venue, B.slot.venue);
    notes.push({A, B, overlap, gap, travel:t,
      verdict: overlap ? "overlap"
             : !t ? "ok"
             : gap < t.minutes ? "bad"
             : gap < t.minutes + 10 ? "tight" : "ok"});
  }
  return notes;
}

/* For a clash, suggest which to keep and whether a repeat rescues the other. */
function suggestFor(n) {
  const sa = scoreOf(n.A.r).score, sb = scoreOf(n.B.r).score;
  // A seat you already hold is kept over a better-scoring one you don't.
  const ba = bookStatus(n.A.r.c) === "booked", bb = bookStatus(n.B.r.c) === "booked";
  const keepA = ba !== bb ? ba : sa >= sb;
  const keep = keepA ? n.A : n.B, drop = keepA ? n.B : n.A;
  const alts = (drop.r.s || []).filter(s => s !== drop.slot);
  return {keep, drop, keepScore: keepA ? sa : sb, dropScore: keepA ? sb : sa, keptBooked: ba !== bb, alts};
}

/* Your committed sessions on a day, in time order — whatever the view's
   filters hide, so a clash can't vanish behind "Hands-on". */
function myDay(daySort) {
  return [...plan].map(c => SESS.get(c)).filter(Boolean)
    .map(r => ({r, slot: committedSlot(r)}))
    .filter(x => x.slot && x.slot.daySort === daySort)
    .sort((a, b) => a.slot.startMin - b.slot.startMin || a.r.c.localeCompare(b.r.c));
}

/* Minutes needed to get from one showing to the next. Unknown venue pairs get
   AWS's own advice rather than a free pass. */
const FALLBACK_TRAVEL = 30;
const needMin = (a, b) => travelBetween(a.venue, b.venue)?.minutes ?? FALLBACK_TRAVEL;
const overlaps = (a, b) => a.startMin < b.endMin && b.startMin < a.endMin;
/* analyseDay calls a gap under travel + 10 "tight"; a suggestion must clear that too,
   or swapping it in just trades one warning for another. */
const TIGHT_MARGIN = 10;

/* The free stretch the dropped session leaves, on its side of the one you keep
   (after the keeper if it started later, before it if earlier), and no more
   than an hour either side of the dropped session — a replacement fills that
   hole, not some other part of the day. */
const OPENING_SLACK = 60;
function openingFor(n, mine) {
  const {keep, drop} = suggestFor(n);
  const others = mine.filter(x => x.r !== drop.r);
  const i = others.findIndex(x => x.r === keep.r);
  const after = drop.slot.startMin >= keep.slot.startMin;
  const prev = after ? keep : (others[i - 1] || null);
  const next = after ? (others[i + 1] || null) : keep;
  const lo = drop.slot.startMin - OPENING_SLACK, hi = drop.slot.endMin + OPENING_SLACK;
  return {keep, drop, others, prev, next, lo, hi};
}
const clock = m => { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
  return `${String((h + 11) % 12 + 1).padStart(2, "0")}:${mm} ${h < 12 ? "AM" : "PM"}`; };

/* Sessions that could take the dropped one's place: inside that opening, with
   enough time to get there from the session before and on to the one after,
   and overlapping nothing else you've planned that day. Best match first. */
/* Every showing that fits between prev and next (either may be null) on a day:
   inside [lo, hi], reachable from prev and on to next with the travel time plus
   the "tight" margin, overlapping nothing in `others`, and not already in your
   plan (except `allow`, a session whose other showing may be offered). Best
   interest match first; ties go to curated picks, then to the time nearest `near`. */
function fitsIn({day, prev, next, others, lo = -Infinity, hi = Infinity, allow = null, skip = null, near = 0}, pool = CATALOG) {
  const out = [];
  pool.forEach(r => (r.s || []).forEach(slot => {
    if (slot.daySort !== day || slot === skip) return;
    if (slot.startMin < lo || slot.endMin > hi) return;
    if (plan.has(r.c) && r.c !== allow?.c) return;
    if (prev && slot.startMin - prev.slot.endMin < needMin(prev.slot, slot) + TIGHT_MARGIN) return;
    if (next && next.slot.startMin - slot.endMin < needMin(slot, next.slot) + TIGHT_MARGIN) return;
    if (others.some(o => overlaps(o.slot, slot))) return;
    const sc = scoreOf(r);
    out.push({r, slot, score: sc.score, why: sc.why,
      before: prev && {from: prev, spare: slot.startMin - prev.slot.endMin - needMin(prev.slot, slot)},
      after: next && {to: next, spare: next.slot.startMin - slot.endMin - needMin(slot, next.slot)}});
  }));
  const tier = r => r.pick ? (r.pick.tier === 1 ? 2 : 1) : 0;
  return out.sort((x, y) => y.score - x.score || tier(y.r) - tier(x.r)
    || Math.abs(x.slot.startMin - near) - Math.abs(y.slot.startMin - near)
    || x.r.c.localeCompare(y.r.c));
}
function replacementsFor(n, mine, pool = CATALOG) {
  const {drop, others, prev, next, lo, hi} = openingFor(n, mine);
  return fitsIn({day: drop.slot.daySort, prev, next, others, lo, hi,
                 allow: drop.r, skip: drop.slot, near: drop.slot.startMin}, pool);
}

/* Free time in your day: before your first session, between each pair, and
   after the one that finishes last (first/last are only for the labels — no
   session runs outside them). Only stretches where something fits are returned. */
function gapsIn(daySort, mine, pool = CATALOG) {
  if (!mine.length) return [];
  let first = Infinity, last = -Infinity;
  CATALOG.forEach(r => (r.s || []).forEach(sl => { if (sl.daySort === daySort) {
    first = Math.min(first, sl.startMin); last = Math.max(last, sl.endMin); } }));
  const spans = [{prev: null, next: mine[0], from: first, to: mine[0].slot.startMin}];
  for (let i = 0; i < mine.length - 1; i++)
    spans.push({prev: mine[i], next: mine[i + 1], from: mine[i].slot.endMin, to: mine[i + 1].slot.startMin});
  const end = mine.reduce((m, x) => x.slot.endMin > m.slot.endMin ? x : m, mine[0]);
  spans.push({prev: end, next: null, from: end.slot.endMin, to: last});
  return spans.filter(g => g.to > g.from).map(g => ({...g,
    fits: fitsIn({day: daySort, prev: g.prev, next: g.next, others: mine, near: g.from}, pool)}))
    .filter(g => g.fits.length);
}

/* The collapsible list under a problem. Closed until you open it; stays open
   across re-renders. */
const SUG_SHOWN = 5;
function sugRow(x, button, tag = "") {
  const venue = VNAME[x.slot.venue] || x.slot.room || "";
  const fit = [x.before && `${x.before.spare} min to spare after ${esc(x.before.from.r.c)}`,
               x.after && `${x.after.spare} min to spare before ${esc(x.after.to.r.c)}`].filter(Boolean).join(" · ");
  return `<li class="sugrow">
      <div class="sugwhen"><b>${esc(x.slot.start)}</b>&ndash;${esc(x.slot.end)}<span>${esc(venue)}</span></div>
      <div class="sugwhat"><span class="code">${esc(x.r.c)}</span> <span class="lvl">${esc(x.r.l)}</span>${tag}
        <button class="linkish" type="button" data-open="${esc(x.r.c)}">${esc(x.r.t)}</button>
        <span class="sugfit">${esc(x.r.y)}${x.why.length ? " · matches " + x.why.map(esc).join(", ") : ""}${fit ? " · " + fit : ""}</span></div>
      ${button}
    </li>`;
}
function suggestionsBlock(n, mine, pool) {
  const {drop, prev, next, lo, hi} = openingFor(n, mine);
  const list = replacementsFor(n, mine, pool);
  const key = `${drop.r.c}@${slotKey(drop.slot)}`;
  // Name the window: a neighbour where there is one, else the clock time.
  const from = prev && prev.slot.endMin >= lo ? "after " + esc(prev.r.c) : "from " + clock(Math.max(lo, prev ? prev.slot.endMin : lo));
  const to = next && next.slot.startMin <= hi ? "before " + esc(next.r.c) : "until " + clock(Math.min(hi, next ? next.slot.startMin : hi));
  const span = `${from}, ${to}`;
  if (!list.length) return `<p class="sugg none">No other session fits ${span} with time to get there.</p>`;
  const rows = list.slice(0, SUG_SHOWN).map(x => { const same = x.r === drop.r;
    return sugRow(x, `<button class="plan" type="button" data-swap="${esc(drop.r.c)}" data-in="${esc(x.r.c)}" data-slot="${esc(slotKey(x.slot))}">${same ? "Move to this showing" : "Swap for " + esc(drop.r.c)}</button>`,
      same ? ' <span class="rpt">Same session, other showing</span>' : ""); }).join("");
  return `<details class="sugg" data-sug="${esc(key)}"${state.sugOpen.has(key) ? " open" : ""}>
    <summary>${list.length} session${list.length === 1 ? "" : "s"} fit${list.length === 1 ? "s" : ""} instead of ${esc(drop.r.c)} — ${span}${list.length > SUG_SHOWN ? `, best ${SUG_SHOWN} shown` : ""}</summary>
    <ul>${rows}</ul></details>`;
}

/* Backups for a planned session you haven't got a seat in: sessions that fit its
   slot (within an hour, between its neighbours, travel + margin either side),
   plus its own other showings that fit the rest of your plan. */
function backupsFor(x, mine, pool = CATALOG) {
  const others = mine.filter(o => o.r !== x.r);
  const i = mine.indexOf(x);
  const prev = [...mine.slice(0, i)].reverse().find(o => o.r !== x.r && o.slot.endMin <= x.slot.startMin) || null;
  const next = mine.slice(i + 1).find(o => o.r !== x.r && o.slot.startMin >= x.slot.endMin) || null;
  const here = fitsIn({day: x.slot.daySort, prev, next, others,
    lo: x.slot.startMin - OPENING_SLACK, hi: x.slot.endMin + OPENING_SLACK, skip: x.slot, near: x.slot.startMin}, pool)
    .filter(f => f.r !== x.r);
  // Its other showings, on any day, checked against that day's plan.
  const again = (x.r.s || []).filter(sl => sl !== x.slot).flatMap(sl => {
    const day = myDay(sl.daySort).filter(o => o.r !== x.r);
    const p = [...day].reverse().find(o => o.slot.endMin <= sl.startMin) || null;
    const n = day.find(o => o.slot.startMin >= sl.endMin) || null;
    return fitsIn({day: sl.daySort, prev: p, next: n, others: day, allow: x.r, near: sl.startMin}, [{...x.r, s: [sl]}])
      .map(f => ({...f, r: x.r, slot: sl}));
  });
  return {here, again};
}
function backupsPanel(daySort, mine, pool) {
  const open = mine.filter(x => bookStatus(x.r.c) === "open");
  if (!open.length) return "";
  const items = open.map(x => {
    const {here, again} = backupsFor(x, mine, pool);
    const key = `bk@${x.r.c}@${slotKey(x.slot)}`;
    const rows = again.map(f => sugRow(f, `<button class="plan" type="button" data-move="${esc(x.r.c)}" data-slot="${esc(slotKey(f.slot))}">Move to this showing</button>`,
        ` <span class="rpt">Same session, ${esc(f.slot.dayName)}</span>`))
      .concat(here.slice(0, SUG_SHOWN).map(f => sugRow(f,
        `<button class="plan" type="button" data-swap="${esc(x.r.c)}" data-in="${esc(f.r.c)}" data-slot="${esc(slotKey(f.slot))}">Swap for ${esc(x.r.c)}</button>`))).join("");
    const n = again.length + here.length;
    return `<li><b>${esc(x.r.c)}</b> ${esc(x.slot.start)} &middot; no seat yet
      ${n ? `<details class="sugg" data-sug="${esc(key)}"${state.sugOpen.has(key) ? " open" : ""}>
        <summary>${again.length ? `${again.length} other showing${again.length === 1 ? "" : "s"} + ` : ""}${here.length} session${here.length === 1 ? "" : "s"} for this slot${here.length > SUG_SHOWN ? `, best ${SUG_SHOWN} shown` : ""}</summary>
        <ul>${rows}</ul></details>` : `<p class="sugg none">Nothing else fits this slot with time to get there.</p>`}</li>`;
  }).join("");
  return `<div class="advice backups"><b>Not booked yet.</b> Backups if you don't get a seat: other showings that fit your plan, then sessions for the same slot with travel time to spare. Mark a session <b>Booked</b> or <b>Walk-up only</b> once you know.<ul>${items}</ul></div>`;
}

/* "Open time in your plan": one collapsible list per gap. */
function gapsPanel(daySort, mine, pool) {
  const gaps = gapsIn(daySort, mine, pool);
  if (!gaps.length) return "";
  const dur = m => m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}` : `${m} min`;
  const items = gaps.map(g => {
    const key = `gap@${daySort}@${g.prev ? g.prev.r.c : "start"}@${g.next ? g.next.r.c : "end"}`;
    const label = g.prev && g.next ? `Between <b>${esc(g.prev.r.c)}</b> and <b>${esc(g.next.r.c)}</b>`
                : g.next ? `Before <b>${esc(g.next.r.c)}</b>, your first session`
                : `After <b>${esc(g.prev.r.c)}</b>, your last session`;
    const rows = g.fits.slice(0, SUG_SHOWN).map(x => sugRow(x,
      `<button class="plan" type="button" data-addfit="${esc(x.r.c)}" data-slot="${esc(slotKey(x.slot))}">Add to plan</button>`)).join("");
    return `<li>${label} &middot; ${clock(g.from)}&ndash;${clock(g.to)} (${dur(g.to - g.from)} free)
      <details class="sugg" data-sug="${esc(key)}"${state.sugOpen.has(key) ? " open" : ""}>
        <summary>${g.fits.length} session${g.fits.length === 1 ? "" : "s"} fit${g.fits.length === 1 ? "s" : ""} with time to get there${g.fits.length > SUG_SHOWN ? `, best ${SUG_SHOWN} shown` : ""}</summary>
        <ul>${rows}</ul></details></li>`;
  }).join("");
  return `<div class="advice freetime"><b>Open time in your plan.</b> Sessions that fit each gap, leaving travel time plus ${TIGHT_MARGIN} minutes either side.<ul>${items}</ul></div>`;
}

/* ===================================================================
   Rendering
   =================================================================== */
function matches(r) {
  if (!dayChipView() && state.tracks.size && !(r.pick && state.tracks.has(r.pick.track))) return false;
  if (state.f.has("core") && r.pick?.tier !== 1) return false;
  if (state.f.has("hands") && !r.h) return false;
  if (state.f.has("deep") && !["400","500"].includes(r.l)) return false;
  if (state.f.has("plan") && !plan.has(r.c)) return false;
  if (cmps.length) {
    const mine = plan.has(r.c), theirs = whoHas(r.c).length > 0;
    if (state.f.has("both") && !(mine && theirs)) return false;
    if (state.f.has("onlyMine") && !(mine && !theirs)) return false;
    if (state.f.has("onlyTheirs") && !(theirs && !mine)) return false;
  }
  if (state.q) {
    const hay = (r.c+" "+r.t+" "+(r.pick?.note||"")+" "+r.y+" "+(r.sv||[]).join(" ")+" "+
                 (r.tp||[]).join(" ")+" "+(r.ai||[]).join(" ")+" "+r.a).toLowerCase();
    if (!state.q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

/* Who else from your imported teammates has this session. On a tile, say
   whether they picked the same showing as you; on a Days row (slot given),
   name only the people attending that exact showing. */
function cmpBadge(r, slot) {
  let who = whoHas(r.c);
  if (!who.length) return "";
  const names = xs => esc(xs.map(x => x.name).join(", "));
  if (slot) {
    who = who.filter(x => theirSlot(x, r) === slot);
    if (!who.length) return "";
    return plan.has(r.c) && isCommitted(r, slot)
      ? `<span class="both" title="${names(who)}">With ${names(who)}</span>`
      : `<span class="theirs" title="${names(who)}">${names(who)} here</span>`;
  }
  if (!plan.has(r.c)) return `<span class="theirs" title="${names(who)}">${names(who)}</span>`;
  const mineSl = committedSlot(r);
  const same = who.filter(x => theirSlot(x, r) === mineSl), other = who.filter(x => theirSlot(x, r) !== mineSl);
  return (same.length ? `<span class="both" title="${names(same)}">Both &middot; ${names(same)}</span>` : "")
       + (other.length ? `<span class="theirs" title="${names(other)}">${names(other)} &middot; other showing</span>` : "");
}

function alsoGoing(code) {
  return attendees.filter(a => !isMe(a.id) && (a.plan || []).includes(code));
}

function metaRow(r) {
  const bits = [r.y, r.l];
  const others = alsoGoing(r.c);
  if (others.length) bits.push(others.length + " going");
  const c = claims.get(r.c);
  if (c) bits.push(isMe(c.by) ? "You cover" : "Covered · " + nameOf(c.by));
  return bits;
}

/* Your booking state for a planned session, as a badge. */
function bookBadge(code) {
  const st = bookStatus(code);
  return st === "booked" ? '<span class="bk booked">Booked</span>'
       : st === "walkup" ? '<span class="bk walkup">Walk-up</span>'
       : st === "open" ? '<span class="bk open">Not booked</span>' : "";
}
/* Buttons to record what the AWS portal said, on your committed showing. */
function bookButtons(r, slot) {
  if (!plan.has(r.c) || !isCommitted(r, slot)) return "";
  const st = bookStatus(r.c), k = slotKey(slot);
  return st === "booked"
    ? `<button class="plan" type="button" data-book="${esc(r.c)}" data-st="open">Unmark booked</button>`
    : `<button class="plan" type="button" data-book="${esc(r.c)}" data-st="booked" data-slot="${esc(k)}">Mark booked</button>`
      + (st === "walkup" ? `<button class="plan" type="button" data-book="${esc(r.c)}" data-st="open">Not walk-up</button>`
                         : `<button class="plan" type="button" data-book="${esc(r.c)}" data-st="walkup">Walk-up only</button>`);
}

/* The badge that says who is covering a session for the team. */
function coverBadge(code) {
  const c = claims.get(code);
  if (!c) return "";
  return isMe(c.by) ? '<span class="cover me">You cover</span>'
                    : `<span class="cover">Covered · ${esc(nameOf(c.by))}</span>`;
}
const durLabel = sl => sl.endEst ? "end TBA · ~" + (sl.endMin - sl.startMin) + " min" : (sl.endMin - sl.startMin) + " min";

/* When a session happens: the showing you'll attend (the first, unless you
   picked another), plus how many other showings exist. */
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const dateLabel = sl => { const [, m, d] = (sl.date || "").split("-").map(Number);
  return `${(sl.dayName || "").slice(0,3)} ${MON[m-1] || ""} ${d || ""}`.trim(); };
function whenLine(r) {
  const sl = committedSlot(r);
  if (!sl) return `<p class="whenl tba">Time not yet published</p>`;
  const more = (r.s || []).length - 1;
  return `<p class="whenl"><b>${esc(dateLabel(sl))}</b> &middot; ${esc(sl.start)}&ndash;${esc(sl.endEst ? "TBA" : sl.end)}
    &middot; ${esc(VNAME[sl.venue] || sl.room || "")}${more > 0 ? ` <span class="more">+${more} more showing${more>1?"s":""}</span>` : ""}</p>`;
}
/* Sort key: day, then start time; unscheduled sessions last. */
const whenKey = r => { const sl = committedSlot(r); return sl ? sl.daySort * 10000 + sl.startMin : Infinity; };
const byWhen = (a, b) => whenKey(a) - whenKey(b) || a.c.localeCompare(b.c);

function tile(x) {
  const r = x.r, on = plan.has(r.c), lc = r.pick ? `var(--t-${r.pick.track})` : "var(--accent)";
  return `<button class="tile${on?" on":""}" style="--lc:${lc}" data-code="${esc(r.c)}">
    <div class="c-top"><span class="code">${esc(r.c)}</span><span class="lvl">${esc(r.l)}</span>
      ${r.pick?.tier===1 ? '<span class="star">Core</span>' : ""}
      ${cmpBadge(r)}${bookBadge(r.c)}${r.h ? '<span class="tag hands">Hands-on</span>' : ""}</div>
    <h3>${esc(r.t)}</h3>
    ${whenLine(r)}
    ${x.why.length ? `<p class="why">Matches <b>${x.why.map(esc).join("</b>, <b>")}</b></p>` : ""}
    <p class="ab">${esc(r.pick?.note || r.a)}</p>
    <div class="c-foot">${metaRow(r).map(t => `<span class="tag">${esc(t)}</span>`).join("")}
      <span class="plan" aria-pressed="${on}">${on ? "In plan" : "+ Plan"}</span></div>
  </button>`;
}

/* For you's day filter: the day you'd attend a session (its committed showing). */
const dayOf = r => committedSlot(r)?.daySort || "tba";
const fyMatches = () => ranked.filter(x => matches(x.r));
const fyVisible = () => { const v = fyMatches(); return state.fyDay ? v.filter(x => dayOf(x.r) === state.fyDay) : v; };

function renderForYou() {
  if (!profile) return `<p class="empty">Answer a few questions to build this page. <button class="btn" id="startWiz" type="button">Start</button></p>`;
  const vis = fyVisible();
  if (!vis.length) return `<p class="empty">Nothing matches ${state.fyDay ? "on that day with " : ""}those filters.</p>`;
  const top = vis.slice(0, 60);
  const inPlan = vis.filter(x => plan.has(x.r.c)).length;
  return `<section class="sect" style="--lc:var(--accent)">
    <div class="sect-head"><h2>Suggested for you</h2>
      <span class="n">${vis.length} match${vis.length===1?"":"es"} &middot; ${inPlan} planned</span></div>
    <p class="sect-desc">${
      !ceiling ? `You haven't picked any interests yet, so this is the curated core rather than a ranking — open <b>Interests</b> to tune it to your work.`
      : `Ranked against your interests across all ${CATALOG.length.toLocaleString()} published sessions. `}${
      !ceiling ? ``
      : !cutoff ? `Your profile is narrow, so this is simply the best-scoring ${ranked.length} rather than a fixed bar. Add interests to sharpen it.`
      : `The bar is <b>${cutoff} points of a possible ${maxScore}</b>, and it rises automatically as you pick more interests — so widening your profile surfaces better matches rather than simply more of them. ${positives.toLocaleString()} sessions score above zero; ${ranked.length} clear the bar.${cutoff > ceiling
        ? ` Your answers so far can award at most ${ceiling}, so they can't tell hundreds of sessions apart — the curated picks lead until you add topics or areas.` : ""}`
    } Curated picks are weighted up and carry my commentary; sponsor sessions are weighted down.${vis.length>60 ? " Showing the top 60" : ` Showing all ${vis.length}`}${state.fyDay ? "" : " by day"}, in time order.</p>
    ${dayGroups(top)}</section>`;
}

/* The top matches, regrouped by the day you'd attend them, in time order. */
function dayGroups(xs) {
  const groups = new Map();
  [...xs].sort((a, b) => byWhen(a.r, b.r)).forEach(x => {
    const sl = committedSlot(x.r), k = sl ? sl.daySort : "tba";
    (groups.get(k) || groups.set(k, {sl, xs: []}).get(k)).xs.push(x);
  });
  return [...groups.values()].map(g => `<h3 class="dayhead">${g.sl
      ? `${esc(g.sl.dayName)} <span>${esc(dateLabel(g.sl).slice(4))}</span>`
      : "Time not yet published"}<span class="n">${g.xs.length} session${g.xs.length===1?"":"s"}</span></h3>
    <div class="tiles">${g.xs.map(tile).join("")}</div>`).join("");
}

function card(r) {
  const on = plan.has(r.c), p = r.pick;
  return `<button class="card${p?.tier===1?" core":""}${on?" on":""}" style="--lc:var(--t-${p.track})" data-code="${esc(r.c)}">
    <div class="c-top"><span class="code">${esc(r.c)}</span><span class="lvl">${esc(r.l)}</span>
      ${p.tier===1 ? '<span class="star">Core</span>' : ""}${cmpBadge(r)}${bookBadge(r.c)}
      ${r.h ? '<span class="tag hands">Hands-on</span>' : ""}${r.sp ? '<span class="tag">Sponsor</span>' : ""}</div>
    <h3 class="c-title">${esc(r.t)}</h3>
    ${whenLine(r)}
    <p class="c-note">${esc(p.note)}</p>
    <div class="c-foot">${metaRow(r).map(t => `<span class="tag">${esc(t)}</span>`).join("")}
      <span class="plan" aria-pressed="${on}">${on ? "In plan" : "+ Plan"}</span></div>
  </button>`;
}

function renderTracks() {
  const vis = CURATED.filter(matches);
  if (!vis.length) return `<p class="empty">No sessions match those filters.</p>`;
  return TRACKS.map(([id,name,desc]) => {
    const rows = vis.filter(r => r.pick.track === id).sort(byWhen);
    if (!rows.length) return "";
    return `<section class="sect" style="--lc:var(--t-${id})">
      <div class="sect-head"><h2>${esc(name)}</h2><span class="n">${rows.length}</span></div>
      <p class="sect-desc">${esc(desc)}</p>
      <div class="grid">${rows.map(card).join("")}</div></section>`;
  }).join("");
}

/* ---------- days ---------- */
const DAYS = META.days || [];
if (DAYS.length && !state.day) state.day = DAYS[0].sort;

function dayRows(daySort) {
  const rows = [];
  CATALOG.forEach(r => (r.s || []).forEach(slot => {
    if (slot.daySort === daySort && matches(r)) rows.push({r, slot});
  }));
  return rows.sort((a,b) => a.slot.startMin - b.slot.startMin || a.r.c.localeCompare(b.r.c));
}

function slotRow(row, clash) {
  const {r, slot} = row, on = plan.has(r.c);
  const alt = on && !isCommitted(r, slot);
  const lc = r.pick ? `var(--t-${r.pick.track})` : "var(--accent)";
  return `<div class="slotrow${on && !alt ? " on" : ""}" style="--lc:${lc}${alt?";opacity:.55":""}">
    <div class="when"><b>${esc(slot.start)}</b><span>&rarr; ${esc(slot.end)}</span>
      <span class="dur">${esc(durLabel(slot))}</span></div>
    <div class="what">
      <div class="c-top"><span class="code">${esc(r.c)}</span><span class="lvl">${esc(r.l)}</span>
        ${r.pick?.tier===1 ? '<span class="star">Core</span>' : ""}${cmpBadge(r, slot)}
        ${alt ? '<span class="rpt">Alternate showing</span>' : ""}
        ${clash && !alt ? '<span class="clash">Clash</span>' : ""}${on && !alt ? bookBadge(r.c) : ""}${coverBadge(r.c)}
        ${alsoGoing(r.c).length ? `<span class="tag">${alsoGoing(r.c).length} teammate${alsoGoing(r.c).length>1?"s":""} going</span>` : ""}</div>
      <h4>${esc(r.t)}</h4>
      ${slot.room ? `<div class="where">${esc(slot.room)}</div>` : ""}
      <div class="rowfoot"><span class="tag">${esc(r.y)}</span>
        ${slot.capacity ? `<span class="tag">${slot.capacity} seats</span>` : ""}
        <button class="plan" data-code="${esc(r.c)}" aria-pressed="${on}">${on ? "In plan" : "+ Plan"}</button>${bookButtons(r, slot)}
        ${alt ? `<button class="plan" data-move="${esc(r.c)}" data-slot="${esc(slotKey(slot))}">Attend this one</button>` : ""}
        <button class="plan" data-open="${esc(r.c)}">Notes</button></div>
    </div></div>`;
}

function gapRow(n) {
  if (n.verdict === "ok" && n.gap >= 0) return "";
  const t = n.travel;
  if (n.overlap) return `<div class="gap bad">Overlaps by ${Math.min(n.A.slot.endMin,n.B.slot.endMin)-n.B.slot.startMin} min — you cannot do both.</div>`;
  const where = t?.same ? "same venue" : `${esc(VNAME[n.A.slot.venue]||"?")} → ${esc(VNAME[n.B.slot.venue]||"?")}`;
  const how = t ? `${t.minutes} min ${t.shuttle ? "by shuttle" : "on foot"}` : "unknown";
  return `<div class="gap ${n.verdict}">${n.gap} min gap &middot; ${where} &middot; needs ~${how}${
    n.verdict==="bad" ? " — not realistic" : n.verdict==="tight" ? " — tight" : ""}</div>`;
}

function renderDays() {
  if (!DAYS.length) return pendingPanel();
  const rows = dayRows(state.day);
  const mine = myDay(state.day);
  const notes = analyseDay(mine);
  const problems = notes.filter(n => n.verdict !== "ok");
  const clashCodes = new Set();
  problems.forEach(n => { if (n.overlap) { clashCodes.add(n.A.r.c); clashCodes.add(n.B.r.c); } });

  const seenPair = new Set();
  const uniqueProblems = problems.filter(n => {
    const k = [n.A.r.c, n.B.r.c].sort().join("|") + "@" + n.A.slot.startMin;
    if (seenPair.has(k)) return false; seenPair.add(k); return true;
  });
  let advice = "";
  if (uniqueProblems.length) {
    advice = `<div class="advice"><b>${uniqueProblems.length} problem${uniqueProblems.length>1?"s":""} in your plan this day.</b><ul>${
      uniqueProblems.slice(0, 6).map(n => {
        const s = suggestFor(n);
        const alt = s.alts.length
          ? ` ${esc(s.drop.r.c)} runs again ${esc(s.alts[0].dayName)} ${esc(s.alts[0].start)} — <button class="plan" data-move="${esc(s.drop.r.c)}" data-slot="${esc(slotKey(s.alts[0]))}">move to it</button>`
          : ` ${esc(s.drop.r.c)} has no other showing.`;
        const sug = suggestionsBlock(n, mine);
        if (n.overlap) return `<li><b>${esc(n.A.r.c)}</b> and <b>${esc(n.B.r.c)}</b> overlap. ${s.keptBooked ? `You hold a seat in ${esc(s.keep.r.c)}, so keep it.` : `Your interests score ${esc(s.keep.r.c)} higher (${s.keepScore} vs ${s.dropScore}), so keep it.`}${alt}${sug}</li>`;
        return `<li><b>${esc(n.A.r.c)}</b> → <b>${esc(n.B.r.c)}</b> leaves ${n.gap} min for a trip that needs about ${n.travel?.minutes ?? 45}.${alt}${sug}</li>`;
      }).join("")}</ul>
      ${uniqueProblems.length > 6 ? `<p style="margin:8px 0 0;font-size:12.5px;color:var(--muted)">…and ${uniqueProblems.length-6} more. Resolve these first — each fix often clears the next.</p>` : ""}
      <p style="margin:9px 0 0;font-size:12.5px;color:var(--muted)">Travel figures are estimates, not AWS's numbers. AWS advises allowing 30–45 minutes between anything.</p></div>`;
  }
  const body = rows.length
    ? rows.map(row => {
        const html = slotRow(row, clashCodes.has(row.r.c));
        const n = notes.find(n => n.A.r.c === row.r.c && n.A.slot === row.slot);
        return html + (n ? gapRow(n) : "");
      }).join("")
    : `<p class="empty">Nothing matches on this day.</p>`;
  return `${advice}${backupsPanel(state.day, mine)}${gapsPanel(state.day, mine)}<div class="agenda">${body}</div>`;
}

function pendingPanel() {
  return `<div class="pending">
    <h2>Times aren't published yet</h2>
    <p>AWS has the catalog live but hasn't assigned days, times, or rooms to any of the ${META.sessions.toLocaleString()} sessions. Scheduling lands alongside reserved seating, which AWS says opens this fall.</p>
    <p>This view is wired to the catalog's schedule format and switches on by itself as soon as the data appears. It will then show:</p>
    <ul>
      <li>One tab per conference day, your plan in time order.</li>
      <li><b>Travel checks between consecutive sessions</b> — the campus runs from Encore down to Caesars Palace with MGM Grand off on its own, and a 30-minute gap does not cover every pair.</li>
      <li><b>Clash flags and advice</b>: which of two overlapping sessions your interests favour, and whether the other has a repeat you can move to.</li>
      <li><b>Repeat offerings.</b> Popular chalk talks run several times under codes like <code>AIM347-R1</code>; each showing gets its own row.</li>
    </ul>
    <p class="stamp">Catalog checked ${esc(META.pulled)} · ${META.catalogTotal.toLocaleString()} records · ${META.scheduled} scheduled.</p>
  </div>`;
}

/* ---------- team ---------- */
let flash = null;              // {text, ok} — the result of the last coverage action
let confirmTake = null;        // code awaiting a second click to take over

function coverActions(code, compact) {
  const c = claims.get(code);
  const inPlan = plan.has(code);
  const b = (attr, label, ghost) =>
    `<button class="${compact ? "plan" : "btn" + (ghost ? " ghost" : "")}" type="button" ${attr}="${esc(code)}">${label}</button>`;
  if (!me?.name) return "";
  if (!c) return b("data-claim", "I'll cover it");
  if (isMe(c.by)) return b("data-release", "Release", true);
  return (inPlan ? b("data-drop", "Drop mine", true) : "")
    + (confirmTake === code ? b("data-takeover", "Confirm take over") : b("data-asktake", "Take over", true));
}

function renderTeam() {
  const status =
    dbError ? `<span class="msg err">${esc(explainDb(dbError))} (${esc(dbError)}) Your plan is still saved locally — use <b>Share / import</b> to compare by code.</span>`
    : feedError ? `<span class="msg err">Live updates stopped (${esc(feedError)}). Reload the page to reconnect.</span>`
    : dbState === "connecting" ? `<span class="msg">Connecting to the shared store…</span>`
    : dbState === "unavailable" ? `<span class="msg">Shared mode is unavailable in this view — your plan stays local.</span>`
    : me?.name ? `<span class="msg ok">Joined as ${esc(nameOf(myId(), me.name))} — write confirmed. ${attendees.length} ${attendees.length===1?"person":"people"} on the team.</span>`
    : `<span class="msg">Connected. Join to share your plan with the team.</span>`;
  const diag = `dbState=${dbState} err=${dbError||"none"} feed=${feedError||"ok"} attendees=${attendees.length} `
             + `claims=${claims.size} notes=${[...notesByCode.values()].flat().length} `
             + `me=${me?.id ? (uid ? "verified" : "local") : "unset"} user=${USER?"y":"n"} `
             + `sample=${SAMPLE?"y":"n"} dl=${DL?"y":"n"} use=${typeof window.claude?.use === "function" ? "y":"n"} `
             + `jsErr=${lastError || "none"}`;
  const diagBar = `<div class="namebar" style="border-left-color:var(--faint)">
      <span class="msg" style="flex:1 1 auto;word-break:break-all">Diagnostics: ${esc(diag)}</span>
      <button class="btn ghost" id="copyDiag" type="button">Copy</button></div>`;
  const nameBar = `<div class="namebar">
    <label class="field" style="flex:1 1 200px"><span>Your name on this page</span>
      <input id="myName" maxlength="40" placeholder="e.g. Caleb" value="${esc(me?.name || suggestedName || "")}"></label>
    <button class="btn" id="saveName" type="button">${me?.name ? "Update" : "Join"}</button>
    <span class="msg" id="nameMsg">${status}</span>
  </div>`;
  const flashBar = flash ? `<p class="msg ${flash.ok ? "ok" : "err"}" style="margin:-10px 0 18px">${esc(flash.text)}</p>` : "";
  if (dbState !== "ready") return nameBar + diagBar + `<p class="empty">Live sharing needs the published page. Use <b>Share / import</b> to exchange plan codes instead.</p>`;
  if (!attendees.length) return nameBar + diagBar + `<p class="empty">No one has joined yet. Join above, then send whoever you're going with this page's link.</p>`;

  // Every session anyone plans, with who plans it.
  const tally = new Map();
  attendees.forEach(a => (a.plan || []).forEach(c => { if (SESS.has(c)) tally.set(c, (tally.get(c) || 0) + 1); }));
  const doubled = [...tally.entries()].filter(([, n]) => n > 1).map(([c]) => c)
    .sort((a, b) => (claims.has(a) - claims.has(b)) || tally.get(b) - tally.get(a) || a.localeCompare(b));
  const open = doubled.filter(c => !claims.has(c)).length;

  const stats = `<div class="teamstats">
    <div><b>${attendees.length}</b><span>people</span></div>
    <div><b>${tally.size}</b><span>sessions planned</span></div>
    <div><b>${claims.size}</b><span>covered</span></div>
    <div class="${open ? "warn" : ""}"><b>${doubled.length}</b><span>doubled up · ${open} unassigned</span></div></div>`;

  const dupRows = doubled.map(c => {
    const r = SESS.get(c), who = plannersOf(c);
    const sameSlot = new Set(who.map(w => w.slot && slotKey(w.slot))).size === 1;
    return `<div class="duprow">
      <div class="what"><div class="c-top"><span class="code" style="color:var(--accent)">${esc(c)}</span>
        <span class="lvl">${esc(r.l)}</span>${coverBadge(c) || '<span class="cover open">Unassigned</span>'}</div>
        <h4>${esc(r.t)}</h4>
        <div class="who">${who.map(w => `<span class="pchip${isMe(w.a.id) ? " me" : ""}">${esc(nameOf(w.a.id, w.a.name))}${
          w.slot ? ` · ${esc(w.slot.dayName.slice(0,3))} ${esc(w.slot.start)}` : ""}</span>`).join("")}
          <span class="msg">${sameSlot ? "same showing" : "different showings"}</span></div></div>
      <div class="acts">${coverActions(c)}<button class="btn ghost" type="button" data-open="${esc(c)}">Notes</button></div>
    </div>`;
  }).join("");

  const cards = attendees.map(a => {
    const theirs = new Set(a.plan || []);
    const both = [...plan].filter(c => theirs.has(c));
    const covering = [...claims.values()].filter(c => c.by === a.id).length;
    const mine = isMe(a.id);
    return `<div class="person${mine ? " me" : ""}">
      <h4>${esc(nameOf(a.id, a.name))}${mine ? " (you)" : ""}</h4>
      <span class="stat"><b>${theirs.size}</b> planned &middot; <b>${covering}</b> covering</span>
      ${!mine ? `<div class="overlap"><span class="stat"><b>${both.length}</b> in common with you</span>
        ${both.length ? `<div class="why" style="margin-top:5px">${both.slice(0,6).map(esc).join(", ")}${both.length>6?` +${both.length-6}`:""}</div>` : ""}</div>` : ""}
    </div>`;
  }).join("");

  return nameBar + flashBar + stats + `
    <section class="sect" style="--lc:var(--t-hpc)">
      <div class="sect-head"><h2>Doubled up</h2><span class="n">${doubled.length}</span></div>
      <p class="sect-desc">Sessions two or more of you plan to attend. Pick one person to cover each — they take the notes — and the others can drop it to free the slot for something nobody is seeing. Unassigned ones are listed first.</p>
      ${doubled.length ? `<div class="duplist">${dupRows}</div>` : `<p class="msg ok">No overlap — nobody is doubled up.</p>`}
    </section>
    <section class="sect" style="--lc:var(--accent)">
      <div class="sect-head"><h2>Who's where</h2></div>
      <p class="sect-desc">Everyone's plan in time order, using the showing each person picked. Use it to spot a slot where the whole team is in one room.</p>
      ${renderWhere()}
    </section>
    <section class="sect" style="--lc:var(--accent)">
      <div class="sect-head"><h2>People</h2><span class="n">${attendees.length}</span></div>
      <p class="sect-desc">Everyone who has joined. Plans, coverage and notes are visible to anyone who can open this page.</p>
      <div class="people">${cards}</div></section>` + diagBar;
}

/* One day of the whole team's plans, time-ordered, one row per showing. */
function renderWhere() {
  if (!DAYS.length) return `<p class="msg">Times aren't published yet.</p>`;
  const day = state.teamDay || DAYS[0].sort;
  const rows = new Map();          // code@slot -> {r, slot, people:[]}
  attendees.forEach(a => (a.plan || []).forEach(c => {
    const hit = plannersOf(c).find(w => w.a.id === a.id);
    if (!hit?.slot || hit.slot.daySort !== day) return;
    const k = c + "@" + slotKey(hit.slot);
    (rows.get(k) || rows.set(k, {r: SESS.get(c), slot: hit.slot, people: []}).get(k)).people.push(a);
  }));
  const list = [...rows.values()].sort((x, y) => x.slot.startMin - y.slot.startMin || x.r.c.localeCompare(y.r.c));
  const tabs = DAYS.map(d => `<button class="daytab" data-tday="${d.sort}" aria-pressed="${day === d.sort}">${esc(d.name)}</button>`).join("");
  const body = list.length ? list.map(x => `<div class="whererow${x.people.length > 1 ? " dup" : ""}">
      <div class="when"><b>${esc(x.slot.start)}</b><span>${esc(VNAME[x.slot.venue] || x.slot.room || "")}</span></div>
      <div class="what"><div class="c-top"><span class="code" style="color:var(--accent)">${esc(x.r.c)}</span>${coverBadge(x.r.c)}
        ${x.people.length > 1 ? `<span class="clash">${x.people.length} of you</span>` : ""}</div>
        <h4><button class="linkish" type="button" data-open="${esc(x.r.c)}">${esc(x.r.t)}</button></h4>
        <div class="who">${x.people.map(a => `<span class="pchip${isMe(a.id) ? " me" : ""}">${esc(nameOf(a.id, a.name))}</span>`).join("")}</div></div>
    </div>`).join("") : `<p class="msg">Nobody has anything planned this day.</p>`;
  return `<div class="daytabs" role="group" aria-label="Choose day">${tabs}</div><div class="agenda">${body}</div>`;
}


/* ===================================================================
   Session drawer
   =================================================================== */
let openCode = null;
let covMsg = null;             // {code, text, ok} — shown in the drawer after a coverage action

/* A summary being generated survives re-renders: live snapshots redraw the
   drawer and the Notes view while Claude is still writing. */
const live = {session:null, team:null};   // {code?, text, msg, busy}

const noteStamp = ns => ns.length + "|" + ns.map(n => n.updated || "").sort().pop();
const whenOf = sl => sl ? `${sl.dayName} ${sl.start}` : "Unscheduled";

/* Summaries come back as light Markdown. Escape first, then allow only
   headings, bold and bullets — nothing from the model becomes live HTML. */
function mdLite(src) {
  const out = []; let list = null;
  const inline = t => t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  esc(src).split("\n").forEach(line => {
    const b = line.match(/^\s*[-*] (.*)$/);
    if (b) { (list || (list = [])).push(`<li>${inline(b[1])}</li>`); return; }
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  });
  if (list) out.push(`<ul>${list.join("")}</ul>`);
  return out.join("");
}

function summaryBlock(saved, liveS, stampNow, label) {
  if (liveS?.text || liveS?.busy) return `<div class="summary">${liveS.text ? mdLite(liveS.text) : "Thinking…"}</div>`;
  if (!saved) return "";
  const stale = saved.stamp !== stampNow;
  return `<div class="summary">${mdLite(saved.text)}</div>
    <p class="msg${stale ? " err" : ""}" style="margin-top:6px">${esc(label)} by ${esc(nameOf(saved.by))} on ${esc((saved.at || "").slice(0,10))} from ${saved.noteCount} note${saved.noteCount === 1 ? "" : "s"}.${stale ? " Notes have changed since — regenerate to include them." : ""}</p>`;
}

function drawerHTML(code) {
  const r = SESS.get(code); if (!r) return "";
  const on = plan.has(code);
  const all = notesByCode.get(code) || [];
  const mine = all.find(n => isMe(n.by));
  const others = all.filter(n => !isMe(n.by));
  const going = alsoGoing(code);
  const slots = r.s || [];
  const c = claims.get(code);
  const saved = summaries.get(code);
  const liveS = live.session?.code === code ? live.session : null;
  const cov = !DB ? `<p class="msg">Coverage needs the published page.</p>`
    : `<p>${!c ? "Nobody is covering this for the team yet."
        : isMe(c.by) ? "<b>You're covering this</b> — your note is the team's record of it."
        : `<b>${esc(nameOf(c.by))}</b> is covering this for the team.`}${
        going.length ? ` Also planning it: ${going.map(a => esc(nameOf(a.id, a.name))).join(", ")}.` : ""}</p>
      <div class="share-actions">${me?.name ? coverActions(code) : '<span class="msg">Join under <b>Team</b> to cover sessions.</span>'}
        ${covMsg?.code === code ? `<span class="msg ${covMsg.ok ? "ok" : "err"}">${esc(covMsg.text)}</span>` : ""}</div>`;
  return `<div class="drawer-head">
      <button class="dclose" id="dClose" type="button">Close</button>
      <div class="c-top"><span class="code" style="color:${r.pick?`var(--t-${r.pick.track})`:"var(--accent)"}">${esc(r.c)}</span>
        <span class="lvl">${esc(r.l)}</span><span class="tag">${esc(r.y)}</span>
        ${r.h ? '<span class="tag hands">Hands-on</span>' : ""}${coverBadge(code)}</div>
      <h2>${esc(r.t)}</h2>
    </div>
    <div class="dsec"><div class="share-actions">
      <button class="btn" id="dPlan" type="button">${on ? "Remove from plan" : "Add to plan"}</button>
    </div></div>
    <div class="dsec"><h3>Team coverage</h3>${cov}</div>
    ${r.pick ? `<div class="dsec"><h3>Why it's on the shortlist</h3><p>${esc(r.pick.note)}</p></div>` : ""}
    <div class="dsec"><h3>Abstract</h3><p>${esc(r.a)}${r.a.length>=280 ? "…" : ""}</p></div>
    ${(r.tp||[]).length || (r.ai||[]).length ? `<div class="dsec"><h3>Tagged</h3>
      <div class="chips">${[...(r.tp||[]),...(r.ai||[])].slice(0,8).map(v=>`<span class="chip">${esc(v)}</span>`).join("")}</div></div>` : ""}
    ${slots.length ? `<div class="dsec"><h3>Showings</h3>${slots.map(s => {
        const cm = on && isCommitted(r, s);
        return `<p><b>${esc(s.dayName)} ${esc(s.start)}</b> — ${esc(s.room||"room TBA")}${s.endEst ? " · end time not published" : ""}${
          cm ? ' <span class="fit" style="--lc:var(--accent)">Attending</span>'
             : ` <button class="plan" type="button" data-move="${esc(r.c)}" data-slot="${esc(slotKey(s))}">Attend this one</button>`}</p>`;
      }).join("")}${slots.length>1 ? '<p style="font-size:12.5px;color:var(--muted);margin-top:6px">Repeated sessions are counted once — only the showing marked <b>Attending</b> is checked for clashes.</p>' : ""}</div>` : ""}
    <div class="dsec"><h3>Your note</h3>
      <textarea id="dNote" rows="5" placeholder="What you want out of it, or what you took away.">${esc(mine?.text||"")}</textarea>
      <div class="share-actions" style="margin-top:8px">
        <button class="btn" id="dSaveNote" type="button">Save note</button>
        <span class="msg" id="dNoteMsg">${!DB ? "Notes need the published page."
          : mine ? `Saved ${esc((mine.updated||"").slice(0,16).replace("T"," "))} UTC. Clear the text and save to delete it.` : ""}</span></div>
    </div>
    ${others.length ? `<div class="dsec"><h3>Notes from others (${others.length})</h3>
      ${others.map(n => `<div class="note"><div class="by">${esc(nameOf(n.by, n.name))}</div><p>${esc(n.text)}</p></div>`).join("")}
    </div>` : ""}
    ${all.length >= 2 || saved ? `<div class="dsec"><h3>Summary of everyone's notes</h3>
      ${summaryBlock(saved, liveS, noteStamp(all), "Summarized")}
      ${canSample() && all.length >= 2 ? `<div class="share-actions" style="margin-top:8px">
        <button class="btn ghost" id="dSum" type="button" ${liveS?.busy ? "disabled" : ""}>${saved ? "Regenerate" : "Summarize"} ${all.length} notes</button>
        <span class="msg">${esc(liveS?.msg || "")}</span></div>` : liveS?.msg ? `<p class="msg err">${esc(liveS.msg)}</p>` : ""}
    </div>` : ""}`;
}

/* A drawer that fails to build says so instead of silently not opening. */
function safeDrawerHTML(code) {
  try { return drawerHTML(code); }
  catch (e) {
    noteError(e);
    return `<div class="drawer-head"><button class="dclose" id="dClose" type="button">Close</button><h2>${esc(code)}</h2></div>
      <p class="msg err">This session could not be shown: ${esc(e?.message || e)}. Copy the diagnostics line under Team and send it to Caleb.</p>`;
  }
}

function openDrawer(code) {
  openCode = code; covMsg = null; confirmTake = null;
  const d = $("#drawer");
  d.hidden = false; d.innerHTML = safeDrawerHTML(code); d.scrollTop = 0;
  requestAnimationFrame(() => { d.classList.add("on"); $("#scrim").classList.add("on"); });
}
function closeDrawer() {
  openCode = null;
  $("#drawer").classList.remove("on"); $("#scrim").classList.remove("on");
  setTimeout(() => { if (!openCode) $("#drawer").hidden = true; }, 220);
}
/* Redraw the open drawer without losing a half-written note. */
function refreshDrawer() {
  if (!openCode) return;
  const box = $("#dNote"), typed = box?.value, focused = document.activeElement === box;
  const sel = focused ? [box.selectionStart, box.selectionEnd] : null;
  const dirty = box && typed !== box.defaultValue;
  $("#drawer").innerHTML = safeDrawerHTML(openCode);
  const nb = $("#dNote");
  if (nb && dirty) nb.value = typed;
  if (nb && focused) { nb.focus(); try { nb.setSelectionRange(...sel); } catch (e) {} }
}

/* Save — or, with empty text, delete — my note, then read it back. */
async function saveNote(code, text) {
  const ref = DB.doc(`notes/${code}__${myId()}`);
  if (!text) {
    await ref.delete();
    if ((await ref.get()).exists) throw {code:"not_persisted"};
    return "Deleted.";
  }
  await ref.set({code, by:myId(), name:me.name, text, updated:new Date().toISOString()});
  const back = await ref.get();
  if (!back.exists || back.data().text !== text) throw {code:"not_persisted"};
  return "Saved.";
}

/* Codes after which this view can never summarize: hide the buttons. */
const SAMPLE_OFF = new Set(["not_granted","sampling_disabled","not_declared","capability_disabled","capability_removed"]);
let sampleOff = false;
function sampleErr(err) {
  const c = err?.code || "error";
  if (SAMPLE_OFF.has(c)) sampleOff = true;
  return (c === "not_granted" ? "AI access was not allowed for this page."
    : c === "sampling_disabled" ? "AI isn't available for this account."
    : c === "rate_limited" ? "Rate limited, or your usage limit was reached — try again later."
    : c === "session_expired" ? "Your session expired — sign in again."
    : c === "prompt_too_large" ? "Too much text to summarize in one go."
    : c === "refused" ? "Claude declined to summarize these notes."
    : c === "empty_completion" ? "Claude returned nothing — try again."
    : "Could not summarize.") + ` (${c})`;
}
const canSample = () => SAMPLE && !sampleOff;

async function summarizeSession(code) {
  const all = notesByCode.get(code) || [], r = SESS.get(code);
  live.session = {code, text:"", msg:"Thinking…", busy:true}; refreshDrawer();
  const input = `These are notes several colleagues took on one AWS re:Invent session.\n\n`
    + `Session ${r.c}: ${r.t}\n\n`
    + all.map(n => `--- ${nameOf(n.by, n.name)}\n${n.text}`).join("\n\n")
    + `\n\nWrite a short synthesis for the team: what they collectively took away, where they disagree or emphasise different things, and any concrete follow-up actions named. Three short paragraphs at most. Plain prose, no headings.`;
  try {
    const {text} = await SAMPLE(input, {onText:({text}) => { live.session.text = text; refreshDrawer(); }});
    live.session = {code, text, msg:"", busy:false};
    try {
      await DB.doc("summaries/" + code).set({code, text, by:myId(), at:new Date().toISOString(),
        noteCount:all.length, stamp:noteStamp(all)});
      live.session = null;             // the saved copy arrives via the snapshot
    } catch (err) { live.session.msg = "Summary written but not saved for the team (" + (err?.code || "error") + ")."; }
  } catch (err) {
    live.session = {code, text: err?.text || "", msg: sampleErr(err), busy:false};
  }
  refreshDrawer();
}

/* ===================================================================
   Notes view: every note, the end-of-conference team summary, export
   =================================================================== */
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
function allNotes() { return [...notesByCode.values()].flat(); }

/* Sessions that have notes, in the order they happened. */
function notedSessions(filter) {
  const codes = [...notesByCode.keys()].filter(c => SESS.has(c) && (notesByCode.get(c) || []).length);
  const keep = filter === "mine" ? c => notesByCode.get(c).some(n => isMe(n.by))
             : filter === "cover" ? c => isMe(claims.get(c)?.by) : () => true;
  const at = c => { const r = SESS.get(c), sl = committedSlot(r); return sl ? sl.daySort + String(sl.startMin).padStart(4,"0") : "9"; };
  return codes.filter(keep).sort((a, b) => at(a).localeCompare(at(b)) || a.localeCompare(b));
}

function renderNotes() {
  if (dbState !== "ready") return `<p class="empty">Shared notes need the published page. Open a session and use <b>Notes</b> there once it's published.</p>`;
  const f = state.notesFilter || "all";
  const every = allNotes(), codes = notedSessions(f);
  const people = new Set(every.map(n => n.by)).size;
  const saved = summaries.get("_team");
  const todo = [...claims.values()].filter(c => isMe(c.by) && !(notesByCode.get(c.code) || []).some(n => isMe(n.by)))
    .map(c => c.code).filter(c => SESS.has(c));
  const chips = [["all","All notes"],["mine","Mine"],["cover","Sessions I cover"]].map(([k,l]) =>
    `<button class="chip" type="button" data-nf="${k}" aria-pressed="${f===k}">${l}</button>`).join("");
  const list = codes.map(c => {
    const r = SESS.get(c), ns = notesByCode.get(c), s = summaries.get(c);
    return `<div class="notesess">
      <div class="c-top"><span class="code" style="color:var(--accent)">${esc(c)}</span>
        <span class="tag">${esc(whenOf(committedSlot(r)))}</span>${coverBadge(c)}</div>
      <h4><button class="linkish" type="button" data-open="${esc(c)}">${esc(r.t)}</button></h4>
      ${s ? `<div class="summary" style="margin:6px 0 8px">${mdLite(s.text)}</div>` : ""}
      ${ns.map(n => `<div class="note"><div class="by">${esc(nameOf(n.by, n.name))}</div><p>${esc(n.text)}</p></div>`).join("")}
    </div>`;
  }).join("");
  const T = live.team;
  return `<section class="sect" style="--lc:var(--accent)">
      <div class="sect-head"><h2>Team summary</h2><span class="n">${plural(every.length, "note")} · ${plural(codes.length, "session")} · ${plural(people, "person", "people")}</span></div>
      <p class="sect-desc">One write-up across every note the team has taken — takeaways by theme, follow-ups and open questions. It is saved here for everyone, and says when newer notes aren't in it yet. Generating it uses your own Claude usage.</p>
      ${summaryBlock(saved, T, noteStamp(every), "Written")}
      <div class="share-actions" style="margin-top:10px">
        ${canSample() ? `<button class="btn" id="tsGo" type="button" ${T?.busy || !every.length ? "disabled" : ""}>${saved ? "Regenerate" : "Write"} team summary</button>` : `<span class="msg">Summaries aren't available in this view.</span>`}
        <button class="btn ghost" id="exCopy" type="button" ${every.length ? "" : "disabled"}>Copy as Markdown</button>
        ${DL ? `<button class="btn ghost" id="exDl" type="button" ${every.length ? "" : "disabled"}>Download .md</button>` : ""}
        <span class="msg" id="exMsg">${esc(T?.msg || "")}</span></div>
      <textarea id="exOut" rows="8" readonly hidden aria-label="Notes as Markdown"></textarea>
    </section>
    ${todo.length ? `<div class="advice"><b>You're covering ${todo.length} session${todo.length>1?"s":""} with no note from you yet:</b>
      ${todo.map(c => `<button class="linkish" type="button" data-open="${esc(c)}">${esc(c)}</button>`).join(", ")}</div>` : ""}
    <section class="sect" style="--lc:var(--accent)">
      <div class="sect-head"><h2>Notes by session</h2><div class="chips" style="margin-left:auto">${chips}</div></div>
      ${feedError ? `<p class="msg err">Live updates stopped (${esc(feedError)}). Reload to see the latest notes.</p>` : ""}
      ${codes.length ? list : `<p class="empty">${every.length ? "Nothing matches that filter." : "No notes yet. Open any session and write one under <b>Your note</b>."}</p>`}
    </section>`;
}

/* Pack session blocks into prompts that fit the sample input cap. */
async function teamSummary() {
  const every = allNotes(), codes = notedSessions("all");
  live.team = {text:"", msg:"Thinking…", busy:true}; render();
  const cap = (await SAMPLE.limits().catch(() => null))?.maxPromptBytes || 60000;
  const budget = Math.floor(cap * 0.8) - 2000;
  const bytes = t => new TextEncoder().encode(t).length;
  const blocks = codes.map(c => {
    const r = SESS.get(c), cl = claims.get(c);
    let b = `### ${c}: ${r.t}${cl ? ` (covered by ${nameOf(cl.by)})` : ""}\n`
      + notesByCode.get(c).map(n => `- ${nameOf(n.by, n.name)}: ${n.text.replace(/\s+/g, " ")}`).join("\n");
    while (bytes(b) > budget) b = b.slice(0, Math.floor(b.length * 0.8)) + " …[trimmed]";
    return b;
  });
  const chunks = [];
  blocks.forEach(b => { const last = chunks[chunks.length - 1];
    if (last && bytes(last + "\n\n" + b) <= budget) chunks[chunks.length - 1] = last + "\n\n" + b; else chunks.push(b); });
  const brief = `A team of colleagues split up the AWS re:Invent 2026 sessions between them and each took notes on the ones they attended.`;
  const final = `Write the team's end-of-conference summary in Markdown with three sections: "Key takeaways" (grouped by theme, citing session codes), "Follow-ups" (concrete actions or things to evaluate, with who raised them), and "Open questions" (disagreements and unknowns). Be specific and brief; bullets, no preamble.`;
  const onText = ({text}) => { live.team.text = text; const box = document.querySelector(".sect .summary"); if (box && state.view === "notes") box.innerHTML = mdLite(text); };
  try {
    let text;
    if (chunks.length === 1) {
      ({text} = await SAMPLE(`${brief}\n\nTheir notes, by session:\n\n${chunks[0]}\n\n${final}`, {onText}));
    } else {
      const partials = [];
      for (let i = 0; i < chunks.length; i++) {
        live.team.msg = `Reading notes, part ${i + 1} of ${chunks.length}…`; render();
        const p = await SAMPLE(`${brief}\n\nHere is part ${i + 1} of ${chunks.length} of their notes:\n\n${chunks[i]}\n\nCondense this part into dense bullet points that keep every concrete takeaway, follow-up (with who raised it), disagreement and session code. These will be merged with the other parts, so no introduction.`);
        partials.push(p.text);
      }
      live.team.msg = "Merging the parts…"; render();
      ({text} = await SAMPLE(`${brief}\n\nTheir notes were condensed in ${partials.length} parts:\n\n${partials.join("\n\n---\n\n")}\n\n${final}`, {onText}));
    }
    live.team = {text, msg:"", busy:false};
    try {
      await DB.doc("summaries/_team").set({text, by:myId(), at:new Date().toISOString(),
        noteCount:every.length, stamp:noteStamp(every)});
      live.team = null;
    } catch (err) { live.team.msg = "Summary written but not saved for the team (" + (err?.code || "error") + ")."; }
  } catch (err) {
    live.team = {text: err?.text || "", msg: sampleErr(err), busy:false};
  }
  render();
}

function notesMarkdown() {
  const every = allNotes(), codes = notedSessions("all"), t = summaries.get("_team");
  const lines = [`# re:Invent 2026 — team notes`, ``,
    `Exported ${new Date().toISOString().slice(0,10)} · ${every.length} notes on ${codes.length} sessions from ${new Set(every.map(n => n.by)).size} people.`, ``];
  if (t) lines.push(`## Team summary`, ``, `_Written ${(t.at||"").slice(0,10)} by ${nameOf(t.by)} from ${t.noteCount} notes${t.stamp !== noteStamp(every) ? " — notes have changed since" : ""}._`, ``, t.text, ``);
  lines.push(`## Sessions`, ``);
  codes.forEach(c => {
    const r = SESS.get(c), sl = committedSlot(r), cl = claims.get(c), s = summaries.get(c);
    lines.push(`### ${c} — ${r.t}`, ``, `${whenOf(sl)}${sl?.room ? " · " + sl.room : ""}${cl ? " · covered by " + nameOf(cl.by) : ""}`, ``);
    if (s) lines.push(`**Summary:** ${s.text}`, ``);
    notesByCode.get(c).forEach(n => lines.push(`**${nameOf(n.by, n.name)}:** ${n.text}`, ``));
  });
  return lines.join("\n");
}

/* ===================================================================
   Share / export / import  (offline fallback for comparison)
   =================================================================== */
const TAG = "RI26-";
const b64e = t => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const b64d = b => new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)));

function encodePlan(name) {
  const codes = [...plan].sort(), slots = {};
  codes.forEach(c => { const r = SESS.get(c), sl = r && committedSlot(r); if (sl && (r.s || []).length > 1) slots[c] = slotKey(sl); });
  const body = JSON.stringify({v:2, name:(name||"").trim().slice(0,40),
    at:new Date().toISOString().slice(0,10), codes, slots});
  try { return TAG + b64e(body); } catch(e) { return body; }
}
function decodePlan(txt) {
  txt = (txt||"").trim();
  if (!txt) throw new Error("Paste a code first.");
  let body = txt;
  if (txt.startsWith(TAG)) {
    try { body = b64d(txt.slice(TAG.length).replace(/\s+/g,"")); }
    catch(e) { throw new Error("That code is incomplete or corrupted — copy the whole thing."); }
  }
  let o; try { o = JSON.parse(body); } catch(e) { throw new Error("That isn't a schedule code."); }
  if (!Array.isArray(o.codes)) throw new Error("No sessions in that code.");
  const valid = [...new Set(o.codes.filter(c => typeof c === "string" && SESS.has(c)))];
  if (!valid.length) throw new Error("None of those sessions are in this catalog.");
  // v2 codes carry the showing picked for repeated sessions; keep only real ones.
  const slots = {};
  if (o.slots && typeof o.slots === "object") valid.forEach(c => {
    const k = o.slots[c];
    if (typeof k === "string" && (SESS.get(c).s || []).some(sl => slotKey(sl) === k)) slots[c] = k;
  });
  return {name:String(o.name||"").trim().slice(0,40) || "Their plan",
          codes:new Set(valid), slots, dropped:o.codes.length - valid.length};
}

function bookingSheet() {
  const cap = new Set(["Chalk talk","Builders' session","Workshop","Code talk","Bootcamp","Lab","Gamified learning","Exam prep"]);
  const rows = [...plan].map(c => SESS.get(c)).filter(Boolean).sort((a,b) =>
    (a.pick?.tier||9) - (b.pick?.tier||9) || (cap.has(b.y)-cap.has(a.y)) || a.c.localeCompare(b.c));
  const lines = rows.map((r,i) => {
    const when = (r.s||[]).map(s => `${s.dayName} ${s.start}${s.room?" · "+s.room:""}`).join("  |  ");
    return `${String(i+1).padStart(2)}. ${r.c.padEnd(9)} ${cap.has(r.y)?"[BOOK]":"[walk-up]"} ${r.t}`
      + `\n    ${r.y} · Level ${r.l}${when?"\n    "+when:""}`;
  });
  return `re:Invent 2026 — booking sheet (${rows.length} sessions)\n`
    + `Priority: curated core first, then capacity-capped formats.\n`
    + `[BOOK] = reserve a seat. [walk-up] = breakouts, recorded afterward.\n\n`
    + lines.join("\n\n");
}

function sharePanel() {
  return `<div class="share">
    <div class="share-col">
      <h3>Export your plan</h3>
      <p>${plan.size} session${plan.size===1?"":"s"}. Copy this code and send it to whoever you're comparing with — it's plain text, so it pastes anywhere.</p>
      <label class="field"><span>Label (optional)</span>
        <input id="expName" maxlength="40" placeholder="e.g. Caleb" value="${esc(me?.name||"")}"></label>
      <textarea id="expOut" readonly rows="3" aria-label="Your schedule code"></textarea>
      <div class="share-actions"><button class="btn" id="copyBtn" type="button">Copy code</button>
        <button class="btn ghost" id="sheetBtn" type="button">Copy booking sheet</button>
        ${DL ? '<button class="btn ghost" id="dlBtn" type="button">Download .txt</button>' : ""}
        <span class="msg" id="copyMsg"></span></div>
    </div>
    <div class="share-col">
      <h3>Import a teammate's schedule</h3>
      <p>Paste their code to overlay their picks — add as many teammates as you like; pasting the same name again updates them. Tiles say whether they're at the same showing as you, and <b>Days</b> shows where each of them will be. For live sharing instead, use <b>Team</b>.</p>
      <textarea id="impIn" rows="3" placeholder="RI26-…" aria-label="Paste a schedule code"></textarea>
      <div class="share-actions"><button class="btn" id="impBtn" type="button">Import</button>
        <span class="msg" id="impMsg"></span></div>
    </div></div>`;
}

function cmpStats(x) {
  let both = 0, same = 0;
  plan.forEach(c => { if (!x.codes.has(c)) return; both++;
    const r = SESS.get(c); if (r && theirSlot(x, r) === committedSlot(r)) same++; });
  return {both, same, mineOnly: plan.size - both, theirsOnly: x.codes.size - both};
}
function cmpBar() {
  if (!cmps.length) return "";
  return cmps.map((x, i) => { const st = cmpStats(x);
    return `<div class="cmpbar"><span class="who">${esc(x.name)}</span>
    <span class="stat"><b>${st.both}</b> in common (<b>${st.same}</b> same showing) &middot; <b>${st.mineOnly}</b> only yours &middot; <b>${st.theirsOnly}</b> only theirs</span>
    <button class="btn ghost" data-rmcmp="${i}" type="button">Remove</button></div>`; }).join("")
    + (cmps.length > 1 ? `<p style="margin:-12px 0 22px;text-align:right"><button class="reset" id="cmpOff" type="button">Remove all</button></p>` : "");
}
const syncExport = () => { const o = $("#expOut"); if (o) o.value = encodePlan($("#expName")?.value); };

/* ===================================================================
   Shell
   =================================================================== */
function cmpChips() {
  const box = $("#cmpChips");
  if (!cmps.length) { ["both","onlyMine","onlyTheirs"].forEach(f => state.f.delete(f)); box.innerHTML = ""; return; }
  box.innerHTML = [["both","Both"],["onlyMine","Only mine"],["onlyTheirs","Only theirs"]]
    .map(([f,l]) => `<button class="chip" data-f="${f}" aria-pressed="${state.f.has(f)}">${l}</button>`).join("");
}

/* The first chip row filters by topic — except in Days, where it picks the
   day instead (topic filters are kept, and apply again outside Days). */
const dayChipView = () => DAYS.length > 0 && (state.view === "days" || (state.view === "foryou" && !!profile));
const dayChipLabel = (d, n) => { const [, m, dd] = d.date.split("-").map(Number);
  return {short: `${d.name.slice(0,3)} ${MON[m-1]} ${dd}`, aria: `${d.name} ${MON[m-1]} ${dd}, ${n} session${n===1?"":"s"}`}; };
function railChips() {
  const box = $("#trackChips");
  if (state.view === "foryou" && dayChipView()) {
    // A filter: All days, or one day's matches (the top 60 is then drawn from that day).
    const all = fyMatches(), per = new Map();
    all.forEach(x => { const k = dayOf(x.r); per.set(k, (per.get(k) || 0) + 1); });
    const chip = (key, short, aria, n) => `<button class="chip day" data-fyday="${key}" aria-pressed="${(state.fyDay || "") === key}"
        aria-label="${esc(aria)}">${esc(short)} <span class="dn">${n}</span></button>`;
    box.setAttribute("aria-label", "Filter by day");
    box.innerHTML = chip("", "All days", `All days, ${all.length} matches`, all.length)
      + DAYS.map(d => { const n = per.get(d.sort) || 0, l = dayChipLabel(d, n); return chip(d.sort, l.short, l.aria, n); }).join("")
      + (per.get("tba") ? chip("tba", "Time TBA", `Time not yet published, ${per.get("tba")} sessions`, per.get("tba")) : "");
    return;
  }
  if (state.view === "days" && DAYS.length) {
    box.setAttribute("aria-label", "Choose day");
    box.innerHTML = DAYS.map(d => {
      const n = dayRows(d.sort).length, l = dayChipLabel(d, n);
      return `<button class="chip day" data-day="${d.sort}" aria-pressed="${state.day === d.sort}"
        aria-label="${esc(l.aria)}">${esc(l.short)} <span class="dn">${n}</span></button>`;
    }).join("");
  } else {
    box.setAttribute("aria-label", "Filter by track");
    box.innerHTML = TRACKS.map(([id]) =>
      `<button class="chip t" data-t="${id}" style="--lc:var(--t-${id})" aria-pressed="${state.tracks.has(id)}">${esc(TSHORT[id])}</button>`).join("");
  }
}

function syncViewButtons() {
  document.querySelectorAll(".vtog button").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.v === state.view));
}

function render() {
  // Live snapshots re-render while people type; keep what they typed.
  const act = document.activeElement;
  const keep = [...out.querySelectorAll("input[id], textarea[id]")]
    .filter(el => el.value !== el.defaultValue).map(el => [el.id, el.value]);
  const focus = act && out.contains(act) && act.id
    ? {id: act.id, sel: [act.selectionStart, act.selectionEnd]} : null;

  const body = state.view === "foryou" ? renderForYou()
             : state.view === "tracks" ? renderTracks()
             : state.view === "days"   ? renderDays()
             : state.view === "notes"  ? renderNotes()
             : renderTeam();
  out.innerHTML = body;

  keep.forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.value = v; });
  if (focus) { const el = document.getElementById(focus.id);
    if (el) { el.focus(); try { el.setSelectionRange(...focus.sel); } catch (e) {} } }

  $("#cmpbar").innerHTML = cmpBar();
  cmpChips();
  railChips();
  const nPeople = attendees.length || (me?.name ? 1 : 0);
  $("#tally").innerHTML = [
    [META.sessions.toLocaleString(), "published"],
    [String(plan.size), "planned"],
    [String(nPeople), nPeople === 1 ? "attendee" : "attendees"],
  ].map(([b,s]) => `<div><b>${b}</b><span>${s}</span></div>`).join("");
  const shown = state.view === "foryou" ? fyVisible().length
              : state.view === "tracks" ? CURATED.filter(matches).length : null;
  $("#count").innerHTML = (shown !== null ? `<b>${shown}</b> shown &middot; ` : "")
    + `<b>${plan.size}</b> planned`
    + (plan.size ? ` &middot; <b>${[...plan].filter(c => bookStatus(c) === "booked").length}</b> booked` : "")
    + (META.scheduled ? ` &middot; <b>${META.scheduled}</b> scheduled` : "");
  $("#fnote").innerHTML = `Catalog pulled ${esc(META.pulled)} — ${META.catalogTotal.toLocaleString()} records, `
    + `${META.sessions.toLocaleString()} distinct sessions, ${META.scheduled} with times. `
    + `Travel estimates are mine, not AWS's; AWS advises allowing 30–45 minutes between anything. `
    + `Commentary on the ${PICKS.length} curated picks is editorial.`;
}

/* ---------- events ---------- */
/* Coverage buttons appear in the Team view, the Days rows and the drawer. */
async function onCoverClick(el) {
  const code = el.dataset.claim || el.dataset.release || el.dataset.drop || el.dataset.takeover || el.dataset.asktake;
  let res = null;
  if (el.dataset.asktake) { confirmTake = code; }
  else {
    el.disabled = true; confirmTake = null;
    if (el.dataset.claim) res = await claimSession(code, false);
    else if (el.dataset.takeover) res = await claimSession(code, true);
    else if (el.dataset.release) res = await releaseSession(code);
    else if (el.dataset.drop) { plan.delete(code); savePlan(); res = {ok:true, msg:`Dropped ${code} from your plan.`}; }
  }
  if (res) { flash = {text: res.msg, ok: res.ok}; covMsg = {code, text: res.msg, ok: res.ok}; }
  render(); refreshDrawer();
}
const COVER = "[data-claim],[data-release],[data-drop],[data-takeover],[data-asktake]";

out.addEventListener("click", async e => {
  const cov = e.target.closest(COVER);
  if (cov) { await onCoverClick(cov); return; }
  const open = e.target.closest("[data-open]");
  if (open) { openDrawer(open.dataset.open); return; }
  const planBtn = e.target.closest("button.plan[data-code]");
  if (planBtn) {
    const c = planBtn.dataset.code;
    plan.has(c) ? plan.delete(c) : plan.add(c); savePlan(); render(); return;
  }
  const mv = e.target.closest("[data-move]");
  if (mv) { chooseSlot(mv.dataset.move, mv.dataset.slot); plan.add(mv.dataset.move); savePlan(); render(); return; }
  const af = e.target.closest("[data-addfit]");
  if (af) { plan.add(af.dataset.addfit); chooseSlot(af.dataset.addfit, af.dataset.slot); savePlan(); render(); return; }
  const bkb = e.target.closest("[data-book]");
  if (bkb) { const c = bkb.dataset.book, st = bkb.dataset.st;
    if (st === "open") delete booking[c]; else booking[c] = {status: st, ...(bkb.dataset.slot ? {slot: bkb.dataset.slot} : {})};
    saveBooking(); render(); return; }
  const sw = e.target.closest("[data-swap]");
  if (sw) { swapIn(sw.dataset.swap, sw.dataset.in, sw.dataset.slot); return; }
  const sum = e.target.closest("details.sugg > summary");
  if (sum) { const k = sum.parentElement.dataset.sug;
    // The click toggles it after this handler; record the state it is about to take.
    sum.parentElement.open ? state.sugOpen.delete(k) : state.sugOpen.add(k); return; }
  const td = e.target.closest("[data-tday]");
  if (td) { state.teamDay = td.dataset.tday; render(); return; }
  const nf = e.target.closest("[data-nf]");
  if (nf) { state.notesFilter = nf.dataset.nf; render(); return; }
  if (e.target.closest("#startWiz")) { openWizard(false); return; }
  if (e.target.closest("#saveName")) { await joinAs($("#myName")?.value); return; }
  const adopt = e.target.closest("[data-adopt]");
  if (adopt) { await joinAs($("#myName")?.value, adopt.dataset.adopt); return; }
  if (e.target.closest("#forceJoin")) { await joinAs($("#myName")?.value, null, true); return; }
  if (e.target.closest("#tsGo")) { if (canSample() && !live.team?.busy) await teamSummary(); return; }
  if (e.target.closest("#exCopy")) {
    const md = notesMarkdown(), box = $("#exOut");
    let ok = false;
    try { await navigator.clipboard.writeText(md); ok = true; } catch (err) {}
    if (!ok && box) { box.hidden = false; box.value = md; box.select(); }
    const m = $("#exMsg"); if (m) { m.textContent = ok ? "Copied." : "Press Cmd/Ctrl+C to copy."; m.className = "msg" + (ok ? " ok" : ""); }
    return;
  }
  if (e.target.closest("#exDl")) {
    const m = $("#exMsg");
    try { await DL.save({filename:"reinvent-2026-team-notes.md", data:notesMarkdown()});
      if (m) { m.textContent = "Saved."; m.className = "msg ok"; } }
    catch (err) { if (m) { m.textContent = err?.code === "declined" ? "Save cancelled." : "Could not save."; m.className = "msg err"; } }
    return;
  }
  if (e.target.closest("#copyDiag")) {
    const t = e.target.closest(".namebar").querySelector(".msg").textContent;
    try { await navigator.clipboard.writeText(t); e.target.textContent = "Copied"; }
    catch (err) { e.target.textContent = "Select and copy"; }
    return;
  }
  const t = e.target.closest(".tile, .card");
  if (t?.dataset.code) {
    if (e.target.closest(".plan")) {
      const c = t.dataset.code;
      plan.has(c) ? plan.delete(c) : plan.add(c); savePlan(); render();
    } else openDrawer(t.dataset.code);
  }
});

/* Join, or rename. Without a verified identity the page cannot tell a second
   device from a second person, so a name that is already taken asks which. */
async function joinAs(raw, adoptId, force) {
  const v = (raw || "").trim().slice(0, 40);
  const msg = $("#nameMsg");
  const say = (html, cls) => { if (msg) { msg.innerHTML = html; msg.className = "msg " + (cls || ""); } };
  if (!v) return say("Enter a name first.", "err");
  if (!uid && !me?.id && !adoptId && !force) {
    const twin = attendees.find(a => (a.name || "").trim().toLowerCase() === v.toLowerCase());
    if (twin) return say(`“${esc(twin.name)}” has already joined. Is that you on another device?
      <button class="plan" type="button" data-adopt="${esc(twin.id)}">Yes, that's me</button>
      <button class="plan" type="button" id="forceJoin">No, someone else</button>`);
  }
  if (adoptId) {
    const row = attendees.find(a => a.id === adoptId);
    me = {id: adoptId, name: row?.name || v}; lsSet(K.me, me);
    if (row) adoptRemote(row);
    render(); return;
  }
  me = {id: uid || me?.id || ("u" + Math.random().toString(36).slice(2,10)), name: v};
  lsSet(K.me, me);
  say("Saving…");
  const ok = await pushNow();
  render();
  const m2 = $("#nameMsg");
  if (m2 && !ok && dbState === "ready") {
    m2.textContent = `${explainDb(dbError)} (${dbError || "error"}) Your plan is saved locally.`;
    m2.className = "msg err";
  }
}

/* Enter in the name field submits — typing a name and hitting return is the
   obvious gesture, and silently doing nothing looks like a broken page. */
out.addEventListener("keydown", e => {
  if (e.target.id === "myName" && e.key === "Enter") { e.preventDefault(); joinAs(e.target.value); }
});

$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape" && openCode) closeDrawer(); });

$("#drawer").addEventListener("click", async e => {
  if (e.target.id === "dClose") return closeDrawer();
  const cov = e.target.closest(COVER);
  if (cov) { await onCoverClick(cov); return; }
  const mv = e.target.closest("[data-move]");
  if (mv) {
    chooseSlot(mv.dataset.move, mv.dataset.slot); plan.add(mv.dataset.move);
    savePlan(); refreshDrawer(); render(); return;
  }
  if (e.target.id === "dPlan") {
    plan.has(openCode) ? plan.delete(openCode) : plan.add(openCode);
    savePlan(); refreshDrawer(); render(); return;
  }
  if (e.target.id === "dSaveNote") {
    const msg = $("#dNoteMsg"), box = $("#dNote"), text = (box?.value || "").trim();
    const had = (notesByCode.get(openCode) || []).some(n => isMe(n.by));
    if (!DB) { msg.textContent = "Notes need the published page."; return; }
    if (!me?.name) { msg.textContent = "Join under Team first."; return; }
    if (!text && !had) { msg.textContent = "Nothing to save."; return; }
    msg.textContent = "Saving…"; msg.className = "msg"; e.target.disabled = true;
    const code = openCode;
    try {
      const done = await saveNote(code, text);
      if (box) box.defaultValue = text;       // no longer a draft
      const m2 = $("#dNoteMsg"); if (m2 && openCode === code) { m2.textContent = done; m2.className = "msg ok"; }
    } catch (err) {
      const m2 = $("#dNoteMsg");
      if (m2) { m2.textContent = `Not saved — ${explainDb(err?.code)} (${err?.code || "error"}). Your text is still in the box.`; m2.className = "msg err"; }
    } finally { const b = $("#dSaveNote"); if (b) b.disabled = false; }
    return;
  }
  if (e.target.id === "dSum") {
    if (canSample() && (notesByCode.get(openCode) || []).length >= 2 && !live.session?.busy) await summarizeSession(openCode);
  }
});

document.querySelector(".vtog").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  state.view = b.dataset.v; flash = null; syncViewButtons(); render();
});
function onFilterChip(e) {
  const b = e.target.closest(".chip"); if (!b) return;
  const f = b.dataset.f;
  state.f.has(f) ? state.f.delete(f) : state.f.add(f);
  b.setAttribute("aria-pressed", state.f.has(f)); render();
}
$("#miscChips").addEventListener("click", onFilterChip);
$("#cmpChips").addEventListener("click", onFilterChip);
$("#trackChips").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  if (b.dataset.fyday !== undefined) {
    // Clicking the selected day again goes back to all days.
    const k = b.dataset.fyday || null;
    state.fyDay = state.fyDay === k ? null : k; render();
    const top = out.getBoundingClientRect().top + window.scrollY - ($(".rail").offsetHeight || 0) - 8;
    if (window.scrollY > top) window.scrollTo(0, Math.max(0, top));
    return;
  }
  if (b.dataset.day) {
    state.day = b.dataset.day; render();
    // Jump back to the top of the day if you'd scrolled down the previous one.
    const top = out.getBoundingClientRect().top + window.scrollY - ($(".rail").offsetHeight || 0) - 8;
    if (window.scrollY > top) window.scrollTo(0, Math.max(0, top));
    return;
  }
  const t = b.dataset.t;
  state.tracks.has(t) ? state.tracks.delete(t) : state.tracks.add(t);
  b.setAttribute("aria-pressed", state.tracks.has(t)); render();
});
$("#q").addEventListener("input", e => { state.q = e.target.value.trim().toLowerCase(); render(); });
$("#prefs").addEventListener("click", () => openWizard(true));

/* Start over: wipe this person's plan, survey answers and claims — here and in
   the shared store — then retake the survey. Notes stay: they are the team's.
   Two clicks rather than confirm(), which a sandboxed frame may block. */
let wipeArmed = null;
$("#startOver").addEventListener("click", async () => {
  const btn = $("#startOver");
  if (!wipeArmed) {
    btn.textContent = "Wipe my plan? Click again";
    wipeArmed = setTimeout(() => { wipeArmed = null; btn.textContent = "Start over"; }, 4000);
    return;
  }
  clearTimeout(wipeArmed); wipeArmed = null;
  btn.disabled = true; btn.textContent = "Wiping…";
  clearTimeout(pushT); pushT = null;
  let failed = "";
  if (DB && myId()) {
    try {
      for (const [code, c] of claims) if (isMe(c.by)) { await DB.doc("claims/" + code).delete(); claims.delete(code); }
      const ref = DB.doc("attendees/" + myId());
      await ref.delete();
      if ((await ref.get()).exists) failed = "not_deleted";
    } catch (err) { failed = err?.code || "error"; }
  }
  // Wipe this browser only once the shared copy is gone; otherwise the next
  // load would quietly restore the plan from the store.
  if (failed) { dbError = failed; btn.disabled = false; btn.textContent = "Start over"; render(); return; }
  plan = new Set(); chosen = {}; profile = null; cmps = []; booking = {};
  [K.plan, K.prof, K.slots, K.cmp, K.book].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  lastPushed = ""; dbError = "";
  btn.disabled = false; btn.textContent = "Start over";
  render();
  openWizard(false);
});
$("#reset").addEventListener("click", () => {
  state.q = ""; state.tracks.clear(); state.f.clear(); state.fyDay = null; $("#q").value = "";
  document.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed","false"));
  render();
});

const panel = $("#sharepanel");
$("#share").addEventListener("click", () => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { panel.innerHTML = sharePanel(); syncExport();
    panel.scrollIntoView({block:"nearest", behavior:"smooth"}); }
});
panel.addEventListener("input", e => { if (e.target.id === "expName") syncExport(); });
panel.addEventListener("click", async e => {
  const msg = (id,t,cls) => { const m = $(id); if (m) { m.textContent = t; m.className = "msg " + (cls||""); } };
  if (e.target.id === "copyBtn" || e.target.id === "sheetBtn") {
    if (!plan.size) return msg("#copyMsg", "Nothing in your plan yet.", "err");
    const box = $("#expOut");
    if (e.target.id === "sheetBtn") { box.value = bookingSheet(); box.rows = 10; }
    box.select();
    let ok = false;
    try { await navigator.clipboard.writeText(box.value); ok = true; }
    catch(err) { try { ok = document.execCommand("copy"); } catch(e2) { ok = false; } }
    msg("#copyMsg", ok ? "Copied." : "Press Cmd/Ctrl+C to copy.", ok ? "ok" : "");
    return;
  }
  if (e.target.id === "dlBtn") {
    if (!DL) return;
    try {
      await DL.save({filename:"reinvent-2026-booking-sheet.txt", data:bookingSheet()});
      msg("#copyMsg", "Saved.", "ok");
    } catch(err) {
      msg("#copyMsg", err.code === "declined" ? "Save cancelled." : "Could not save.", "err");
    }
    return;
  }
  if (e.target.id === "impBtn") {
    try {
      const got = decodePlan($("#impIn").value);
      const i = cmps.findIndex(x => x.name.toLowerCase() === got.name.toLowerCase());
      if (i < 0 && cmps.length >= MAX_CMP) throw new Error(`You can compare up to ${MAX_CMP} people — remove someone first.`);
      const entry = {name:got.name, codes:got.codes, slots:got.slots};
      i < 0 ? cmps.push(entry) : (cmps[i] = entry); saveCmp();
      $("#impIn").value = "";
      msg("#impMsg", `${i < 0 ? "Added" : "Updated"} ${got.name} — ${got.codes.size} session${got.codes.size===1?"":"s"}.`
        + (got.dropped ? ` ${got.dropped} not in this catalog, skipped.` : ""), "ok");
      render();
    } catch(err) { msg("#impMsg", err.message, "err"); }
  }
});
$("#cmpbar").addEventListener("click", e => {
  const rm = e.target.closest("[data-rmcmp]");
  if (rm) cmps.splice(Number(rm.dataset.rmcmp), 1);
  else if (e.target.id === "cmpOff") cmps = [];
  else return;
  saveCmp();
  if (!panel.hidden) { panel.innerHTML = sharePanel(); syncExport(); }
  render();
});

/* ---------- boot ---------- */
(() => { const q = $("#q"); if (q?.dataset.ph) q.placeholder = q.dataset.ph.replace("{n}", CATALOG.length.toLocaleString()); })();
if (profile) rank();
render();
if (!profile) openWizard(false);
bootCaps();
