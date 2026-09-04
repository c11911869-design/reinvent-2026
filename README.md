# re:Invent 2026 — Mission Track

A personalised AWS re:Invent 2026 session planner, built from the live event
catalog and published as an Artifact.

**Live page:** https://claude.ai/code/artifact/2209d4e3-0e28-4c27-a946-6640868d8091

## What it does

- **Onboarding.** Five questions built from the catalog's own facet tags (topic,
  area of interest, role, industry, level, format). Your answers score all
  published sessions and build the **For you** page.
- **Curated.** 97 hand-picked sessions across 8 tracks, each with commentary,
  weighted up in the ranking.
- **Days.** Your plan in time order per conference day, with **travel checks**
  between consecutive sessions, clash flags, and advice on which of two
  overlapping sessions to keep — plus one-click moves to an alternate showing.
- **People.** Everyone who opens the page and adds a name. Plans sync live;
  see who overlaps with you and where.
- **Notes.** Per-session notes shared across the group, with an AI synthesis
  across everyone's notes for a session.
- **Share.** Offline fallback: export a `RI26-…` plan code and compare by paste.

## Running it

No dependencies — standard library only.

```bash
python3 build.py              # fetch the catalog, rebuild dist/
python3 build.py --offline    # rebuild from data/ without network
```

`dist/reinvent-2026-planner.html` is the file to publish. Regenerating it does
**not** update the published Artifact — ask Claude to republish it to the URL
above (passing that URL, so it updates in place).

## Layout

| Path | Role |
|---|---|
| `build.py` | Fetch, shape, and emit the page |
| `src/notes.py` | The curation: track, tier, commentary per session code. **Edit here** to change picks |
| `src/venues.py` | Campus graph and travel estimates between venues |
| `src/page/head.html` | Styles |
| `src/page/body.html` | Markup shell |
| `src/page/app.js` | Application logic |
| `data/` | Generated: `catalog.json`, `picks.json`, `meta.json` |
| `dist/` | Generated: the publishable page |
| `tools/make_test_build.py` | Test harness — grafts real 2025 times on and stubs `window.claude` so the schedule, travel, sharing and notes paths can be exercised locally. Never published. |

## Runtime capabilities

The published page declares `db`, `sample`, and `downloads`.

- `db` — shared plans and notes. **Declaring it makes the artifact
  organisation-internal: it cannot be shared publicly**, and everyone who can
  open it can read every plan and note on it.
- Identities are **self-declared names, not authenticated** — the `user`
  capability is not available on this account, so there is no verified identity
  and no per-viewer private storage.
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
