# re:Invent 2026 — Mission Track

**Docs:** `~/Documents/personal/projects/reinvent-2026` · **Origin:** `~/git/reinvent-2026.git`

A personalised AWS re:Invent 2026 session planner, built from the live event
catalog and published as an Artifact.

**Live page:** https://claude.ai/code/artifact/2209d4e3-0e28-4c27-a946-6640868d8091

## What it does

- **Onboarding.** Five questions built from the catalog's own facet tags (topic,
  area of interest, role, industry, level, format). Your answers score all
  published sessions and build the **For you** page.
- **Curated.** 92 hand-picked sessions across 8 tracks, each with commentary,
  weighted up in the ranking.
- **Days.** Your plan in time order per conference day, with **travel checks**
  between consecutive sessions, clash flags, and advice on which of two
  overlapping sessions to keep — plus one-click moves to an alternate showing.
- **Team.** Everyone who joins. Plans sync live. **Doubled up** lists sessions
  two or more people plan; one person claims each ("I'll cover it") and the
  rest can drop it. **Who's where** shows the whole team's day in time order,
  using the showing each person picked.
- **Notes.** Per-session notes shared across the group (clear the text and save
  to delete). A saved AI summary per session, and an end-of-conference **team
  summary** across every note — chunked to fit the model's input cap, saved for
  everyone, flagged stale when notes change. Export all of it as Markdown.
- **Start over.** Toolbar button (two clicks): deletes your plan, survey answers and claims here and in the shared store, then reopens the survey. Your notes stay. If the shared delete fails, nothing local is wiped.
- **Share / import.** Export your plan as an `RI26-…` code (it carries the showing you picked for
  repeated sessions). Import any number of teammates' codes: tiles show who else has a session and
  whether they're at the same showing, **Days** shows each teammate on the showing they picked, and
  the Both / Only mine / Only theirs filters slice the overlap. Re-importing a name updates it. This
  is how people running it locally compare; on the published page **Team** does it live.

## Running it

No dependencies — standard library only.

```bash
./run.sh                      # build if needed, serve on 127.0.0.1:8790, open the browser
./run.sh --refresh            # pull the live catalog first
./run.sh --test               # test harness with a stub team store (?as=<name>)
```

**Tests.** `./run.sh --test`, then open
`http://127.0.0.1:8790/TEST-harness.html?as=selftest&reset=1&selftest=1`. The suite
(`tools/selftest.js`) runs against the real page code and shows PASS/FAIL at the top;
the tab title reads `PASS n/n`.

Run locally, there is no shared team store: your plan stays in that browser,
and the Team view falls back to comparing `RI26-…` plan codes.

```bash
python3 build.py              # fetch the catalog, rebuild dist/
python3 build.py --offline    # rebuild from data/ without network
```

Lightning talks that publish end == start get an estimated 20-minute end
(`endEst`) so they still take part in clash checks.

`dist/reinvent-2026-planner.html` is the file to publish. Regenerating it does
**not** update the published Artifact — ask Claude to republish it to the URL
above (passing that URL, so it updates in place).

## Layout

| Path | Role |
|---|---|
| `run.sh` | Build if needed and serve locally |
| `build.py` | Fetch, shape, and emit the page |
| `src/notes.py` | The curation: track, tier, commentary per session code. **Edit here** to change picks |
| `src/venues.py` | Campus graph and travel estimates between venues |
| `src/page/head.html` | Styles |
| `src/page/body.html` | Markup shell |
| `src/page/app.js` | Application logic |
| `data/` | Generated: `catalog.json`, `picks.json`, `meta.json` |
| `dist/` | Generated: the publishable page |
| `tools/selftest.js` | In-page test suite, injected into the harness, runs with `?selftest=1` |
| `tools/make_test_build.py` | Test harness — the real page plus a stub `window.claude` whose store is shared across tabs, so several simulated people (`?as=alice`, `?as=bob`) and failure modes (`&dbfail=`, `&sample=`) can be exercised locally over http. Never published. |

## Runtime capabilities

The published page declares `db`, `sample`, `downloads`, and
`user` (scope `profile`).

- `db` — shared plans and notes. **Declaring it makes the artifact
  organisation-internal: it cannot be shared publicly**, and everyone who can
  open it can read every plan and note on it.
- `user` — a verified account id per viewer, so the same person on a phone
  and a laptop is one attendee with one plan. Names shown are the viewer's
  claude.ai profile names, falling back to the name typed on joining. Where the
  page cannot verify identity it falls back to a random id per browser and asks
  "is that you on another device?" when a name is already taken.
- Shared collections: `attendees/<id>` (plan + chosen showings),
  `notes/<code>__<id>`, `claims/<code>` (who covers a session; written under a
  short lease so two people can't both win), `summaries/<code>` and
  `summaries/_team`.
- `sample` — the notes synthesis. Runs on the *viewer's* Claude usage and asks
  their consent on first use.
- `downloads` — saves the booking sheet as a file.

Locally (`file://` or a dev server) none of these exist; the page detects their
absence and falls back to local-only plans and the paste-a-code comparison.

## Travel estimates

`src/venues.py` documents its sourcing. AWS has published no 2026 campus map or
venue-to-venue time table, so the walk minutes there are **conservative
estimates, not AWS figures**. What is documented and used: AWS advises allowing
30–45 minutes between activities; free shuttles run between venues more than
about a 15-minute walk apart; Encore–Wynn are connected, a bridge links
Wynn–Venetian, and an indoor route links Caesars Forum–Venetian during Expo
hours. MGM Grand is the outlier, south near Tropicana.

## Automated watch

Two scheduled checks — see `~/.claude/scheduled-tasks/reinvent-2026-watch/`
(local, daily, runs `build.py`) and the cloud backstop routine
<https://claude.ai/code/routines/trig_01HC3AjKA3FPLW2CV1L9iZ89> (weekly,
reservation date only — its sandbox blocks the catalog API).

## Data source

Public RainFocus endpoint, no auth for reads:

```
POST https://catalog.awsevents.com/api/search
     header  rfapiprofileid: W7g1iXGSnubuepOruvDWMM9ecuUXKP4v
     body    size=50&from=<offset>&type=session
```

Paginate 50 at a time; the first page nests results under `sectionList[0].items`
and later pages return `items` at the top level. Repeat offerings are separate
records whose code is the base code plus `-R`/`-R<n>`; `build.py` folds them into
one session with several showings.

This is read-only. Reserving seats happens in the attendee portal under your own
login — nothing here automates that.
