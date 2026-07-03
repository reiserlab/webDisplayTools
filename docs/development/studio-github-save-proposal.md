# Studio → GitHub save: lean proposal (for review)

**Status: PROPOSAL (2026-07-03) — not scheduled. Review + edit before any build.**
Requested during the #107 write-side session ("our eventual plan is to be able
to merge onto a github repo … a per-user repo, which would hold all the YAML,
patterns, etc."). Related: parity-doc Direction note, issue #107 (URL state),
issue #135 (session rig).

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

## Proposal — three thin phases

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

## Open questions (answer during review)

1. Default mental model: **per-user** repo or **per-lab** repo? (changes the
   template/fork story and whether PRs are the norm)
2. Own repo: direct commit or always-PR?
3. Does this site's built-in registry stay the demo/curriculum home while user
   work lives in user repos? (assumed yes)
4. Is the repo association per-browser (localStorage) only, or encoded into
   shared URLs by default (`?repo=` on every share)?
