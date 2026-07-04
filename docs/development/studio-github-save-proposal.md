# Studio → GitHub save: lean proposal (for review)

**Status: COURSE SCOPE SHIPPED (2026-07-03, Session 2 — Arena Studio v0.5).**
The course-pipeline slice of this proposal is implemented; the generic
per-user/template-repo phases below remain the unbuilt follow-on. Shipped:
repo owner/name + bench-id settings + "commit directly to default branch"
(File ▾ gh-block, localStorage), `directCommit()` orchestration + binary-safe
base64 + `runlogs/` allowlist + root `roster.yaml` read in
`js/studio-github.js`, universal bridge run-logging (recorded runs gated on a
live bridge; `run_metadata` line; auto-commit of the exported bridge JSONL to
`runlogs/<bench-id>/<proto>__<exp>__<STAMP>__<run_id>.jsonl`), roster
prefill + MAC cross-check chip, missing-pattern preflight block, "Open from
library…" / "Open from course repo…" pickers, promote-to-shared with the
hash-compare guard, `?repo=owner/name&p=<path>` links, and the pattern
editor's "⇪ Push to course repo".
Originally requested during the #107 write-side session ("our eventual plan is
to be able to merge onto a github repo … a per-user repo, which would hold all
the YAML, patterns, etc."). Related: parity-doc Direction note, issue #107
(URL state), issue #135 (session rig).

## Where we are today

- File ▾ / 💾 Save already has a GitHub path: sign in with a fine-grained PAT →
  "Save → Pull Request" commits to a branch of `reiserlab/webDisplayTools` and
  opens a PR (`js/studio-github.js` — pure request builders: repo → ref →
  create-branch → PUT (create-vs-update sha) → PR; path allowlist `protocols/`
  + `configs/metadata/`; token lives only in the Authorization header,
  session/localStorage).
- Save is the run-gate **provenance anchor**: `markSaved` records the content
  sha; run logs pair with the saved artifact. Export YAML is NOT save (it's a
  regenerated roundtrip copy for diffing).
- Limitations: target repo is hardcoded; writes only `protocols/`; sharing
  (`?p=`) resolves only against this site's own `protocols/index.json`.

## Goal

Associate a Studio session with a **per-user (or per-lab) GitHub repo** that
holds that user's protocol YAMLs, pattern sets, and rig configs. Save =
commit/PR there; later, load and share from there.

## Proposal — three thin phases (plus a v0 that needs no GitHub at all)

### v0 — "Open from library…" picker (site-only; the missing registry door)

Today the URL is the **only** way to load a registry protocol — File ▾ Open and
the Run view's button are local-file pickers, so even a byte-identical local
copy loads as `local` with no provenance. Fix: an **Open from library…** entry
(File ▾ + beside Run's "Open protocol") listing `protocols/index.json` by
`label`, loading via the same path `initFromUrl` uses —
`Studio.loadProtocol(text, name, 'committed', {key})` — so `?p=` and the
provenance key follow automatically. The Edit view's demo fixtures join the
same list (either promoted into the registry or shown as a second "demos"
group), which also closes the "editing a demo shows no `?p=`" seam. This
picker is the UI slot v2 later re-points at a user repo's index — build it
once against the site registry, parameterize it later.

### v1 — save to *my* repo (one focused session)

- Settings gains **"GitHub repo: `owner/name`"** (validated via `GET /repos/…`;
  stored in localStorage per browser) next to the existing PAT sign-in.
- `saveViaPR` parameterized on that repo (today's `GH_OWNER`/`GH_REPO`
  constants become session values). Add a **"commit directly to default
  branch"** checkbox for solo repos; branch+PR stays the default (right for
  shared/lab repos).
- A **template repo** (e.g. `reiserlab/arena-protocols-template`, "Use this
  template") defines the expected layout so the load side (v2) has a contract:

  ```
  protocols/        *.yaml + index.json   (same schema as this site's registry)
  patterns/         *.pat (+ MANIFEST.txt)
  configs/rigs/     *.yaml + index.json
  ```

- Provenance unchanged: sha over the exact uploaded text; run-log `meta` gains
  `repo` + `path`.

### v2 — load + share (the `?p=` repo dimension)

- **`?repo=owner/name&p=key`**: fetch that repo's `protocols/index.json`
  (GitHub contents API or raw.githubusercontent — both CORS-enabled), validate
  the key against it, fetch the protocol. Public repo → the link works for
  anyone. Private repo → works only for someone holding their own token —
  documented boundary; the **token is never part of the URL**.
- Codec: `repo` param validated as an `owner/name` slug; `encodeApp` grows a
  `repo` field (the #107 write side was built for this — one chokepoint).
- In-app **"Open from repo"** picker listing the index keys — also closes the
  current gap where `?p=` is the *only* way to open a registry protocol.

### v3 — patterns + rigs

- Pattern-set builder ZIP → commit `.pat` files via the git blob/tree API (the
  contents API caps ~1 MB per file and one-file-per-request; batches want a
  tree commit anyway).
- Rig configs in the user repo feed the session-rig selector + `?rig=` (#135).

## Auth — the one real decision

- **v1 keeps fine-grained PATs** (client-side; scoped to Contents + Pull
  requests on the one repo). Zero infrastructure; the cost is a one-time token
  paste per browser.
- OAuth sign-in (nicer UX) requires a token-exchange **secret**, i.e. *some*
  server: a ~20-line Cloudflare Worker, or a GitHub App with device flow.
  Defer until PAT friction is demonstrated to matter. Explicitly out: any
  server that ever sees repo *content* — exchange tokens only.

## Security boundaries (carry-overs from today)

- Token: Authorization header only — never in URLs, logs, or run-log exports;
  session-vs-local storage stays a visible user choice.
- Per-repo path allowlist (`protocols/`, `patterns/`, `configs/`) — no
  arbitrary-path writes, ever.
- Everything fetched still passes `parseV3Protocol` validation + the v2-reject
  guard; `repo`/`p`/`rig` params validated by shape and by registry membership
  (same belt-and-suspenders as `isSafePath` today).

## Portability: protocols ↔ pattern sets (direction settled 2026-07-03 — colocate per protocol)

A protocol alone is **not portable**. v3 protocols reference patterns **by
filename** (`pattern:` in trialParams), and at run time the Studio resolves
name → SD index from the live SD listing (SD-first picker). A shared protocol
only runs — and only runs *correctly* — if the target card holds files with
the same names **and the same content**: a missing name refuses to run
(annoying); a same-name file with different content **silently shows the wrong
stimulus** (invalidates the experiment without any error).

**Repo layout (user-proposed, adopted): each protocol carries its own patterns
directory** — `protocols/looming_v3.yaml` + `protocols/looming_v3_patterns/`.
Colocation IS the link:

- No manifest indirection for linkage; referential integrity is a **static
  lint** — every `pattern:` name must resolve inside the sibling dir —
  checkable in CI and at protocol load, no SD needed.
- Share/fork = copy two paths; one commit updates both; and identical `.pat`
  content across protocols is the **same git blob**, so repo storage is free.
- Divergence-proof by design: another protocol editing *its* copy of a shared
  pattern can never change this protocol's stimulus (a reproducibility
  feature, not waste).

**The one remaining problem: packing multiple protocols onto one SD card.**
Flat namespace + name-based resolution means two protocols with same-named,
different-content patterns clobber each other. The invariant to enforce: **on
a card, filename → content must be one-to-one.** Options:

- **(b) Content-addressed SD names — recommended.** Upload as
  `<name>.<sha8>.pat`. The Studio already controls the on-card name (the
  upload + rename 0x83 path) and already owns name→index resolution, so
  protocol names resolve via the sibling dir's hashes → SD name → index — no
  firmware change. Collisions impossible by construction; shared content
  dedupes to one file; **preflight collapses to a listing check** (the name
  certifies the content — no over-the-wire hashing); run-log meta records the
  hashed names, certifying the protocol+set **pair**. Costs: suffixed names in
  the raw Console picker (cosmetic — display can strip), and a firmware
  filename-length sanity check (current names are already long).
- (a) SD subdirectory per protocol — cleanest *if* firmware pattern ops accept
  paths (the card already has dirs: `/firmware/panel.bin`); needs a fw check.
- (c) Flat names + card-level manifest + collision prompts at upload — works
  on any firmware but pushes the problem into UX.

**"Fix it" flow** (any option): the Console already batch-uploads folders — so
the remedy is one action: fetch the protocol's `_patterns/` from the repo,
batch-upload (hashing names en route under (b)), re-verify via listing.

### Pattern previews everywhere (Editor / Console / Run) — falls out of colocation

Today previews exist only where the `.pat` bytes happen to be local (built-in
manifest set or a hand-picked folder); SD-only patterns show "no local
preview". Colocation fixes the data-availability problem:

- **Tier 1 — live rendering from the `.pat` source of truth (v2 read side).**
  When a protocol loads from the registry/repo, fetch its sibling
  `_patterns/*.pat` (KB-scale files) and render with the machinery the Studio
  already has (`PatParser` / `PatPreview` / icon generator): thumbnails on
  pattern fields in the Edit inspector, Console-picker previews for SD-only
  names (hash-name → repo bytes), Run-view sequence row thumbnails. Bonus:
  parsing the bytes closes the known `patternFramesByName` gap (Mode-3 frame
  clamp for SD-only patterns in Run-view protocol runs).
- **Tier 2 — stored animated GIFs (optional, for humans outside the Studio).**
  Pre-rendered per-pattern GIFs, content-hash-named
  (`_patterns/previews/<name>.<sha8>.gif`) and generated by **CI only** (a
  node script reusing `pat-parser` + a GIF encoder) — never hand-authored, so
  the derived-artifact drift problem is structurally avoided, same trick as
  the SD names. What GIFs buy that live rendering doesn't: previews inside
  GitHub's own file/PR browsing (review a stimulus change by *watching* it),
  embeds in docs/quickstarts, and picker thumbnails without fetching every
  `.pat`. In-app rendering still prefers the `.pat` — GIFs are presentation,
  never the source of truth.

## Open questions — ANSWERED (2026-07-03 course-pipeline review)

Answered during the CSHL course-pipeline interview + plan review. The full
decision record lives as a comment on
[#135](https://github.com/reiserlab/webDisplayTools/issues/135); the reviewed
build plan splits the work into Session 1 (#135 rig identity + firmware MAC)
and Session 2 (course data pipeline). Answers below are scoped to the course;
the generic per-user story stays as sketched in the phases above.

1. **Per-user vs per-lab: per-course shared repo.** ONE dedicated course-data
   repo (e.g. `reiserlab/cshl-2026-course`), 7 fixed bench rigs, one
   shared fine-grained PAT (instructor-installed per bench, localStorage;
   students never see the token). Writes are namespaced by an
   **instructor-set bench id** (`bench03`) — NOT the rig-config name (only 3
   arena-TYPE configs are shared across 7 benches, so a name-derived id
   collides) and NOT a MAC slug (MAC is a roster *cross-check* via 0xC2, not
   identity). The generic per-user template-repo story is deferred, unchanged.
2. **Direct commit for the course repo, via a Settings checkbox** ("commit
   directly to default branch" — exactly the v1 sketch). Safe because rig-id
   namespacing means no two rigs write the same path; promote-to-shared is the
   exception and gets a hash-compare-before-overwrite guard.
   `reiserlab/webDisplayTools` keeps branch+PR as the default.
3. **Yes** — the site registry (`protocols/index.json`) stays the read-only
   demo/curriculum home, unchanged; course work lives in the course repo.
4. **Per-browser localStorage is the operating mode**; `?repo=owner/name` is
   still built (shape-validated, no allowlist — access gated by the PAT the
   browser holds). With `repo` present, `p` becomes a repo-relative *path*
   with a new validator (the existing `SAFE_PATH_RE` targets the document's
   `rig:` field and doesn't match repo paths).
5. **SD packing deferred past the course.** Course week = pre-matched SD
   cards + the existing manual Console upload (0x8D + 0x83 rename) for
   student patterns. Preflight is a **block**, not a warn: a recorded run
   refuses to start when a `pattern:` name doesn't resolve in the SD-first
   picker, with the message naming the Console upload as the remedy.
   Content-addressed names (option b) remain the recommended follow-on.
6. **Live `.pat` rendering is enough** — single middle-frame render through
   the existing `generatePatternIcon`/`PatPreview` pipeline, plus a
   repo-byte-source fetcher using the raw media type
   (`Accept: application/vnd.github.raw`; the contents API omits `content`
   for files >1 MB). CI-generated GIFs stay an optional Tier-2 follow-on.
