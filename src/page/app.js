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
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const out = $("#out");

/* ---------- local state ---------- */
const K = {plan:"ri26.plan", prof:"ri26.profile", me:"ri26.me", cmp:"ri26.compare", slots:"ri26.slots"};
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} };

let plan = new Set(lsGet(K.plan, []));
let profile = lsGet(K.prof, null);
let me = lsGet(K.me, null);           // {id, name}
let chosen = lsGet(K.slots, {});   // code -> "daySort:startMin" of the showing you'll attend
let cmp = (() => { const r = lsGet(K.cmp, null);
  return r && Array.isArray(r.codes) ? {name:r.name||"Imported", codes:new Set(r.codes)} : null; })();

const savePlan = () => { lsSet(K.plan, [...plan]); pushPlan(); };
const slotKey = sl => `${sl.daySort}:${sl.startMin}`;
/* A repeated session is attended ONCE. Default to its first showing. */
function committedSlot(r) {
  const all = r.s || [];
  if (!all.length) return null;
  const want = chosen[r.c];
  return all.find(sl => slotKey(sl) === want) || all[0];
}
const isCommitted = (r, sl) => committedSlot(r) === sl;
function chooseSlot(code, key) { chosen[code] = key; lsSet(K.slots, chosen); }
const saveCmp  = () => cmp ? lsSet(K.cmp, {name:cmp.name, codes:[...cmp.codes]}) : localStorage.removeItem(K.cmp);

const state = {q:"", tracks:new Set(), f:new Set(), view:"foryou", day:null};

/* ---------- capabilities (resolve late, never assumed) ---------- */
let DB = null, SAMPLE = null, DL = null;
let attendees = [];            // [{id,name,plan:[],updated}]
let notesByCode = new Map();   // code -> [{id,by,name,text,updated}]

async function bootCaps() {
  if (typeof window.claude?.use !== "function") return;
  try { DB = await window.claude.use("db"); } catch(e) { DB = null; }
  try { SAMPLE = await window.claude.use("sample"); } catch(e) { SAMPLE = null; }
  try { DL = await window.claude.use("downloads"); } catch(e) { DL = null; }
  if (DB) {
    try {
      DB.collection("attendees").onSnapshot(
        snap => { attendees = snap.docs.map(d => ({id:d.id, ...d.data()})); render(); },
        () => {});
    } catch(e) {}
    pushPlan();
  }
  render();
}

/* Mirror my plan into the shared store, debounced. */
let pushT = null;
function pushPlan() {
  if (!DB || !me?.id) return;
  clearTimeout(pushT);
  pushT = setTimeout(() => {
    DB.doc("attendees/" + me.id).set({
      name: me.name, plan: [...plan], updated: new Date().toISOString(),
      topics: profile?.tp || [], areas: profile?.ai || [],
    }).catch(() => {});
  }, 600);
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

let ranked = [], cutoff = 0, ceiling = 0, positives = 0;
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
  const all = CATALOG.map(r => ({r, ...scoreOf(r)}))
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score || (a.r.pick?1:0) - (b.r.pick?1:0) || a.r.c.localeCompare(b.r.c));
  positives = all.length;

  const targetN = Math.min(180, Math.max(24, Math.round(CATALOG.length * SHARE)));
  const atTarget = all.length > targetN ? all[targetN - 1].score : 0;
  cutoff = Math.max(MIN_SIGNAL, Math.ceil(ceiling * FRACTION), atTarget);

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
  const keep = sa >= sb ? n.A : n.B, drop = sa >= sb ? n.B : n.A;
  const alts = (drop.r.s || []).filter(s => s !== drop.slot);
  return {keep, drop, keepScore:Math.max(sa,sb), dropScore:Math.min(sa,sb), alts};
}

/* ===================================================================
   Rendering
   =================================================================== */
function matches(r) {
  if (state.tracks.size && !(r.pick && state.tracks.has(r.pick.track))) return false;
  if (state.f.has("core") && r.pick?.tier !== 1) return false;
  if (state.f.has("hands") && !r.h) return false;
  if (state.f.has("deep") && !["400","500"].includes(r.l)) return false;
  if (state.f.has("plan") && !plan.has(r.c)) return false;
  if (cmp) {
    const mine = plan.has(r.c), theirs = cmp.codes.has(r.c);
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

function cmpBadge(r) {
  if (!cmp) return "";
  const mine = plan.has(r.c), theirs = cmp.codes.has(r.c);
  if (mine && theirs) return '<span class="both">Both</span>';
  if (theirs) return `<span class="theirs">${esc(cmp.name)}</span>`;
  return "";
}

function alsoGoing(code) {
  return attendees.filter(a => a.id !== me?.id && (a.plan || []).includes(code));
}

function metaRow(r) {
  const bits = [r.y, r.l];
  const others = alsoGoing(r.c);
  if (others.length) bits.push(others.length + " going");
  return bits;
}

function tile(x) {
  const r = x.r, on = plan.has(r.c), lc = r.pick ? `var(--t-${r.pick.track})` : "var(--accent)";
  return `<button class="tile${on?" on":""}" style="--lc:${lc}" data-code="${esc(r.c)}">
    <div class="c-top"><span class="code">${esc(r.c)}</span><span class="lvl">${esc(r.l)}</span>
      ${r.pick?.tier===1 ? '<span class="star">Core</span>' : ""}
      ${cmpBadge(r)}${r.h ? '<span class="tag hands">Hands-on</span>' : ""}</div>
    <h3>${esc(r.t)}</h3>
    ${x.why.length ? `<p class="why">Matches <b>${x.why.map(esc).join("</b>, <b>")}</b></p>` : ""}
    <p class="ab">${esc(r.pick?.note || r.a)}</p>
    <div class="c-foot">${metaRow(r).map(t => `<span class="tag">${esc(t)}</span>`).join("")}
      <span class="plan" aria-pressed="${on}">${on ? "In plan" : "+ Plan"}</span></div>
  </button>`;
}

function renderForYou() {
  if (!profile) return `<p class="empty">Answer a few questions to build this page. <button class="btn" id="startWiz" type="button">Start</button></p>`;
  const vis = ranked.filter(x => matches(x.r));
  if (!vis.length) return `<p class="empty">Nothing matches those filters.</p>`;
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
      : `The bar is <b>${cutoff} points of a possible ${ceiling}</b>, and it rises automatically as you pick more interests — so widening your profile surfaces better matches rather than simply more of them. ${positives.toLocaleString()} sessions score above zero; these clear the bar.`
    } Curated picks are weighted up and carry my commentary; sponsor sessions are weighted down.${vis.length>60 ? " Showing the top 60." : ""}</p>
    <div class="tiles">${top.map(tile).join("")}</div></section>`;
}

function card(r) {
  const on = plan.has(r.c), p = r.pick;
  return `<button class="card${p?.tier===1?" core":""}${on?" on":""}" style="--lc:var(--t-${p.track})" data-code="${esc(r.c)}">
    <div class="c-top"><span class="code">${esc(r.c)}</span><span class="lvl">${esc(r.l)}</span>
      ${p.tier===1 ? '<span class="star">Core</span>' : ""}${cmpBadge(r)}
      ${r.h ? '<span class="tag hands">Hands-on</span>' : ""}${r.sp ? '<span class="tag">Sponsor</span>' : ""}</div>
    <h3 class="c-title">${esc(r.t)}</h3>
    <p class="c-note">${esc(p.note)}</p>
    <div class="c-foot">${metaRow(r).map(t => `<span class="tag">${esc(t)}</span>`).join("")}
      <span class="plan" aria-pressed="${on}">${on ? "In plan" : "+ Plan"}</span></div>
  </button>`;
}

function renderTracks() {
  const vis = CURATED.filter(matches);
  if (!vis.length) return `<p class="empty">No sessions match those filters.</p>`;
  return TRACKS.map(([id,name,desc]) => {
    const rows = vis.filter(r => r.pick.track === id);
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
      <span class="dur">${slot.endMin-slot.startMin} min</span></div>
    <div class="what">
      <div class="c-top"><span class="code">${esc(r.c)}</span><span class="lvl">${esc(r.l)}</span>
        ${r.pick?.tier===1 ? '<span class="star">Core</span>' : ""}${cmpBadge(r)}
        ${alt ? '<span class="rpt">Alternate showing</span>' : ""}
        ${clash && !alt ? '<span class="clash">Clash</span>' : ""}</div>
      <h4>${esc(r.t)}</h4>
      ${slot.room ? `<div class="where">${esc(slot.room)}</div>` : ""}
      <div class="rowfoot"><span class="tag">${esc(r.y)}</span>
        ${slot.capacity ? `<span class="tag">${slot.capacity} seats</span>` : ""}
        <button class="plan" data-code="${esc(r.c)}" aria-pressed="${on}">${on ? "In plan" : "+ Plan"}</button>
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
  const tabs = DAYS.map(d => `<button class="daytab" data-d="${d.sort}" aria-pressed="${state.day===d.sort}">
    ${esc(d.name)} <span class="dn">${dayRows(d.sort).length}</span></button>`).join("");
  const rows = dayRows(state.day);
  const mine = rows.filter(x => plan.has(x.r.c) && isCommitted(x.r, x.slot));
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
        if (n.overlap) return `<li><b>${esc(n.A.r.c)}</b> and <b>${esc(n.B.r.c)}</b> overlap. Your interests score ${esc(s.keep.r.c)} higher (${s.keepScore} vs ${s.dropScore}), so keep it.${alt}</li>`;
        return `<li><b>${esc(n.A.r.c)}</b> → <b>${esc(n.B.r.c)}</b> leaves ${n.gap} min for a trip that needs about ${n.travel?.minutes ?? 45}.${alt}</li>`;
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
  return `<div class="daytabs" role="group" aria-label="Choose day">${tabs}</div>${advice}
    <div class="agenda">${body}</div>`;
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

/* ---------- people ---------- */
function renderPeople() {
  const nameBar = `<div class="namebar">
    <label class="field" style="flex:1 1 200px"><span>Your name on this page</span>
      <input id="myName" maxlength="40" placeholder="e.g. Caleb" value="${esc(me?.name||"")}"></label>
    <button class="btn" id="saveName" type="button">${me?.name ? "Update" : "Join"}</button>
    <span class="msg" id="nameMsg">${DB ? "" : "Shared mode is unavailable in this view — your plan stays local."}</span>
  </div>`;
  if (!DB) return nameBar + `<p class="empty">Live sharing needs the published page. Use <b>Share</b> to exchange plan codes instead.</p>`;
  if (!attendees.length) return nameBar + `<p class="empty">No one has joined yet. Add your name above, then send whoever you're going with this page's link.</p>`;

  const mineSet = plan;
  const cards = attendees.map(a => {
    const theirs = new Set(a.plan || []);
    const both = [...mineSet].filter(c => theirs.has(c));
    const isMe = a.id === me?.id;
    return `<div class="person${isMe?" me":""}">
      <h4>${esc(a.name || "Unnamed")}${isMe ? " (you)" : ""}</h4>
      <span class="stat"><b>${theirs.size}</b> sessions planned</span>
      ${!isMe ? `<div class="overlap"><span class="stat"><b>${both.length}</b> in common with you</span>
        ${both.length ? `<div class="why" style="margin-top:5px">${both.slice(0,6).map(esc).join(", ")}${both.length>6?` +${both.length-6}`:""}</div>` : ""}</div>` : ""}
    </div>`;
  }).join("");

  // Sessions where two or more people overlap
  const tally = new Map();
  attendees.forEach(a => (a.plan||[]).forEach(c => tally.set(c, (tally.get(c)||0)+1)));
  const shared = [...tally.entries()].filter(([,n]) => n > 1)
    .sort((a,b) => b[1]-a[1]).slice(0, 24)
    .map(([c,n]) => { const r = SESS.get(c); if (!r) return "";
      return `<button class="tile" style="--lc:var(--accent)" data-code="${esc(c)}">
        <div class="c-top"><span class="code">${esc(c)}</span><span class="lvl">${esc(r.l)}</span>
          <span class="fit">${n} going</span></div>
        <h3>${esc(r.t)}</h3></button>`; }).join("");

  return nameBar + `<section class="sect" style="--lc:var(--accent)">
    <div class="sect-head"><h2>Who's going</h2><span class="n">${attendees.length}</span></div>
    <p class="sect-desc">Everyone who has opened this page and added a name. Plans sync live. Names are self-declared, not verified, and every plan and note here is visible to anyone who can open this page.</p>
    <div class="people">${cards}</div></section>
    ${shared ? `<section class="sect" style="--lc:var(--accent)">
      <div class="sect-head"><h2>Where you overlap</h2><span class="n">${shared.length}</span></div>
      <p class="sect-desc">Sessions more than one of you plans to attend — the ones worth splitting up or comparing notes on afterwards.</p>
      <div class="tiles">${shared}</div></section>` : ""}`;
}

/* ===================================================================
   Session drawer
   =================================================================== */
let openCode = null;

function drawerHTML(code) {
  const r = SESS.get(code); if (!r) return "";
  const on = plan.has(code);
  const mine = notesByCode.get(code)?.find(n => n.by === me?.id);
  const others = (notesByCode.get(code) || []).filter(n => n.by !== me?.id);
  const going = alsoGoing(code);
  const slots = r.s || [];
  return `<div class="drawer-head">
      <button class="dclose" id="dClose" type="button">Close</button>
      <div class="c-top"><span class="code" style="color:${r.pick?`var(--t-${r.pick.track})`:"var(--accent)"}">${esc(r.c)}</span>
        <span class="lvl">${esc(r.l)}</span><span class="tag">${esc(r.y)}</span>
        ${r.h ? '<span class="tag hands">Hands-on</span>' : ""}</div>
      <h2>${esc(r.t)}</h2>
    </div>
    <div class="dsec"><div class="share-actions">
      <button class="btn" id="dPlan" type="button">${on ? "Remove from plan" : "Add to plan"}</button>
      ${going.length ? `<span class="msg">${going.map(a => esc(a.name)).join(", ")} also going</span>` : ""}
    </div></div>
    ${r.pick ? `<div class="dsec"><h3>Why it's on the shortlist</h3><p>${esc(r.pick.note)}</p></div>` : ""}
    <div class="dsec"><h3>Abstract</h3><p>${esc(r.a)}${r.a.length>=280 ? "…" : ""}</p></div>
    ${(r.tp||[]).length || (r.ai||[]).length ? `<div class="dsec"><h3>Tagged</h3>
      <div class="chips">${[...(r.tp||[]),...(r.ai||[])].slice(0,8).map(v=>`<span class="chip">${esc(v)}</span>`).join("")}</div></div>` : ""}
    ${slots.length ? `<div class="dsec"><h3>Showings</h3>${slots.map(s => {
        const c = isCommitted(r, s);
        return `<p><b>${esc(s.dayName)} ${esc(s.start)}</b> — ${esc(s.room||"room TBA")}${
          c ? ' <span class="fit" style="--lc:var(--accent)">Attending</span>'
            : ` <button class="plan" data-move="${esc(r.c)}" data-slot="${esc(slotKey(s))}">Attend this one</button>`}</p>`;
      }).join("")}${slots.length>1 ? '<p style="font-size:12.5px;color:var(--muted);margin-top:6px">Repeated sessions are counted once — only the showing marked <b>Attending</b> is checked for clashes.</p>' : ""}</div>` : ""}
    <div class="dsec"><h3>Your note</h3>
      <textarea id="dNote" rows="4" placeholder="What you want out of it, or what you took away.">${esc(mine?.text||"")}</textarea>
      <div class="share-actions" style="margin-top:8px">
        <button class="btn" id="dSaveNote" type="button">Save note</button>
        <span class="msg" id="dNoteMsg">${DB ? "" : "Notes need the published page."}</span></div>
    </div>
    ${others.length ? `<div class="dsec"><h3>Notes from others (${others.length})</h3>
      ${others.map(n => `<div class="note"><div class="by">${esc(n.name||"Someone")}</div><p>${esc(n.text)}</p></div>`).join("")}
      ${SAMPLE ? `<div class="share-actions"><button class="btn ghost" id="dSum" type="button">Summarize all notes</button>
        <span class="msg" id="dSumMsg"></span></div><div id="dSumOut"></div>` : ""}
    </div>` : ""}`;
}

function openDrawer(code) {
  openCode = code;
  const d = $("#drawer");
  d.hidden = false; d.innerHTML = drawerHTML(code);
  requestAnimationFrame(() => { d.classList.add("on"); $("#scrim").classList.add("on"); });
  if (DB) loadNotes(code);
}
function closeDrawer() {
  openCode = null;
  $("#drawer").classList.remove("on"); $("#scrim").classList.remove("on");
  setTimeout(() => { if (!openCode) $("#drawer").hidden = true; }, 220);
}

async function loadNotes(code) {
  if (!DB) return;
  try {
    const snap = await DB.collection("notes").where("code", "==", code).get();
    notesByCode.set(code, snap.docs.map(d => ({id:d.id, ...d.data()})));
    if (openCode === code) {
      const typed = $("#dNote")?.value;
      $("#drawer").innerHTML = drawerHTML(code);
      const box = $("#dNote");
      if (box && typed != null && typed !== box.value) box.value = typed;
    }
  } catch(e) {}
}

/* ===================================================================
   Share / export / import  (offline fallback for comparison)
   =================================================================== */
const TAG = "RI26-";
const b64e = t => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const b64d = b => new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)));

function encodePlan(name) {
  const body = JSON.stringify({v:1, name:(name||"").trim().slice(0,40),
    at:new Date().toISOString().slice(0,10), codes:[...plan].sort()});
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
  const valid = o.codes.filter(c => SESS.has(c));
  if (!valid.length) throw new Error("None of those sessions are in this catalog.");
  return {name:(o.name||"Their plan").trim().slice(0,40) || "Their plan",
          codes:new Set(valid), dropped:o.codes.length - valid.length};
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
      <h3>Compare with someone else</h3>
      <p>Paste their code to overlay their picks. Shared sessions are flagged <span class="both">Both</span>. For live sharing instead, use <b>People</b>.</p>
      <textarea id="impIn" rows="3" placeholder="RI26-…" aria-label="Paste a schedule code"></textarea>
      <div class="share-actions"><button class="btn" id="impBtn" type="button">Compare</button>
        <span class="msg" id="impMsg"></span></div>
    </div></div>`;
}

function cmpBar() {
  if (!cmp) return "";
  const both = [...plan].filter(c => cmp.codes.has(c)).length;
  return `<div class="cmpbar"><span class="who">${esc(cmp.name)}</span>
    <span class="stat"><b>${both}</b> in common &middot; <b>${plan.size-both}</b> only yours &middot; <b>${cmp.codes.size-both}</b> only theirs</span>
    <button class="btn ghost" id="cmpOff" type="button">Stop comparing</button></div>`;
}
const syncExport = () => { const o = $("#expOut"); if (o) o.value = encodePlan($("#expName")?.value); };

/* ===================================================================
   Shell
   =================================================================== */
function cmpChips() {
  const box = $("#cmpChips");
  if (!cmp) { ["both","onlyMine","onlyTheirs"].forEach(f => state.f.delete(f)); box.innerHTML = ""; return; }
  box.innerHTML = [["both","Both"],["onlyMine","Only mine"],["onlyTheirs","Only theirs"]]
    .map(([f,l]) => `<button class="chip" data-f="${f}" aria-pressed="${state.f.has(f)}">${l}</button>`).join("");
}

function syncViewButtons() {
  document.querySelectorAll(".vtog button").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.v === state.view));
}

function render() {
  const body = state.view === "foryou" ? renderForYou()
             : state.view === "tracks" ? renderTracks()
             : state.view === "days"   ? renderDays()
             : renderPeople();
  out.innerHTML = body;
  $("#cmpbar").innerHTML = cmpBar();
  cmpChips();
  const nPeople = attendees.length || (me ? 1 : 0);
  $("#tally").innerHTML = [
    [META.sessions.toLocaleString(), "published"],
    [String(plan.size), "planned"],
    [String(nPeople), nPeople === 1 ? "attendee" : "attendees"],
  ].map(([b,s]) => `<div><b>${b}</b><span>${s}</span></div>`).join("");
  const shown = state.view === "foryou" ? ranked.filter(x => matches(x.r)).length
              : state.view === "tracks" ? CURATED.filter(matches).length : null;
  $("#count").innerHTML = (shown !== null ? `<b>${shown}</b> shown &middot; ` : "")
    + `<b>${plan.size}</b> planned` + (META.scheduled ? ` &middot; <b>${META.scheduled}</b> scheduled` : "");
  $("#fnote").innerHTML = `Catalog pulled ${esc(META.pulled)} — ${META.catalogTotal.toLocaleString()} records, `
    + `${META.sessions.toLocaleString()} distinct sessions, ${META.scheduled} with times. `
    + `Travel estimates are mine, not AWS's; AWS advises allowing 30–45 minutes between anything. `
    + `Commentary on the ${PICKS.length} curated picks is editorial.`;
}

/* ---------- events ---------- */
out.addEventListener("click", e => {
  const open = e.target.closest("[data-open]");
  if (open) { openDrawer(open.dataset.open); return; }
  const planBtn = e.target.closest("button.plan[data-code]");
  if (planBtn) {
    const c = planBtn.dataset.code;
    plan.has(c) ? plan.delete(c) : plan.add(c); savePlan(); render(); return;
  }
  const mv = e.target.closest("[data-move]");
  if (mv) { chooseSlot(mv.dataset.move, mv.dataset.slot); plan.add(mv.dataset.move); savePlan(); render(); return; }
  const tab = e.target.closest(".daytab");
  if (tab) { state.day = tab.dataset.d; render(); return; }
  if (e.target.closest("#startWiz")) { openWizard(false); return; }
  if (e.target.closest("#saveName")) {
    const v = ($("#myName")?.value || "").trim().slice(0,40);
    if (!v) { $("#nameMsg").textContent = "Enter a name first."; return; }
    me = {id: me?.id || ("u" + Math.random().toString(36).slice(2,10)), name: v};
    lsSet(K.me, me); pushPlan(); render(); return;
  }
  const t = e.target.closest(".tile, .card");
  if (t?.dataset.code) {
    if (e.target.closest(".plan")) {
      const c = t.dataset.code;
      plan.has(c) ? plan.delete(c) : plan.add(c); savePlan(); render();
    } else openDrawer(t.dataset.code);
  }
});

$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape" && openCode) closeDrawer(); });

$("#drawer").addEventListener("click", async e => {
  if (e.target.id === "dClose") return closeDrawer();
  if (e.target.id === "dPlan") {
    plan.has(openCode) ? plan.delete(openCode) : plan.add(openCode);
    savePlan(); $("#drawer").innerHTML = drawerHTML(openCode); render(); return;
  }
  if (e.target.id === "dSaveNote") {
    const msg = $("#dNoteMsg"), text = ($("#dNote")?.value || "").trim();
    if (!DB) { msg.textContent = "Notes need the published page."; return; }
    if (!me?.name) { msg.textContent = "Add your name under People first."; return; }
    if (!text) { msg.textContent = "Nothing to save."; return; }
    msg.textContent = "Saving…";
    try {
      await DB.doc(`notes/${openCode}__${me.id}`).set(
        {code:openCode, by:me.id, name:me.name, text, updated:new Date().toISOString()});
      await loadNotes(openCode);
      const m2 = $("#dNoteMsg"); if (m2) { m2.textContent = "Saved."; m2.className = "msg ok"; }
    } catch(err) { msg.textContent = "Could not save (" + (err.code||"error") + ")."; }
    return;
  }
  if (e.target.id === "dSum") {
    const msg = $("#dSumMsg"), box = $("#dSumOut");
    const all = notesByCode.get(openCode) || [];
    if (!SAMPLE || all.length < 2) { msg.textContent = "Need at least two notes."; return; }
    e.target.disabled = true; msg.textContent = "Thinking…";
    const r = SESS.get(openCode);
    const input = `These are notes several colleagues took on one AWS re:Invent session.\n\n`
      + `Session ${r.c}: ${r.t}\n\n`
      + all.map(n => `--- ${n.name || "Anonymous"}\n${n.text}`).join("\n\n")
      + `\n\nWrite a short synthesis for the team: what they collectively took away, where they disagree or emphasise different things, and any concrete follow-up actions named. Three short paragraphs at most. Plain prose, no headings.`;
    try {
      const {text} = await SAMPLE(input, {onText:({text}) => { box.innerHTML = `<div class="summary">${esc(text)}</div>`; }});
      box.innerHTML = `<div class="summary">${esc(text)}</div>`;
      msg.textContent = `Synthesised from ${all.length} notes.`;
    } catch(err) {
      msg.textContent = err.code === "not_granted" ? "You declined AI access."
        : err.code === "rate_limited" ? "Rate limited — try again shortly." : "Could not summarize.";
      if (err.text) box.innerHTML = `<div class="summary">${esc(err.text)}</div>`;
    } finally { e.target.disabled = false; }
  }
});

document.querySelector(".vtog").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  state.view = b.dataset.v; syncViewButtons(); render();
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
  const t = b.dataset.t;
  state.tracks.has(t) ? state.tracks.delete(t) : state.tracks.add(t);
  b.setAttribute("aria-pressed", state.tracks.has(t)); render();
});
$("#q").addEventListener("input", e => { state.q = e.target.value.trim().toLowerCase(); render(); });
$("#prefs").addEventListener("click", () => openWizard(true));
$("#reset").addEventListener("click", () => {
  state.q = ""; state.tracks.clear(); state.f.clear(); $("#q").value = "";
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
      cmp = {name:got.name, codes:got.codes}; saveCmp();
      msg("#impMsg", `Comparing with ${got.name}.` + (got.dropped ? ` ${got.dropped} unknown skipped.` : ""), "ok");
      render();
    } catch(err) { msg("#impMsg", err.message, "err"); }
  }
});
$("#cmpbar").addEventListener("click", e => {
  if (e.target.id !== "cmpOff") return;
  cmp = null; saveCmp();
  if (!panel.hidden) { panel.innerHTML = sharePanel(); syncExport(); }
  render();
});

/* ---------- boot ---------- */
$("#trackChips").innerHTML = TRACKS.map(([id]) =>
  `<button class="chip t" data-t="${id}" style="--lc:var(--t-${id})" aria-pressed="false">${esc(TSHORT[id])}</button>`).join("");
(() => { const q = $("#q"); if (q?.dataset.ph) q.placeholder = q.dataset.ph.replace("{n}", CATALOG.length.toLocaleString()); })();
if (profile) rank();
render();
if (!profile) openWizard(false);
bootCaps();
