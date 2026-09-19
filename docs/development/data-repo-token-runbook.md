# Data-repo tokens — renewal and setup runbook

Arena Studio, the Pattern Designer and the data-browser dashboard write protocols,
patterns and run logs to a GitHub **data repo** (the CSHL course repo today; the lab's
`reiserlab/arena-experiments` next) using a personal access token pasted once per
browser (File ▾ → GitHub → **Sign in…**). The token is stored in that browser only
(`studio_gh_pat`, sessionStorage or localStorage) and sent only as an
`Authorization` header. This page is the operational how-to; design background is in
`studio-github-save-proposal.md`, the course-week checklist in
`cshl-pipeline-test-plan.md`.

## Which token type — the one rule

| Who | Token type | Why |
|---|---|---|
| A `reiserlab` **org member** (lab members, incl. Michael) | **Fine-grained** PAT, resource owner `reiserlab`, only the repo(s) needed, *Contents: Read and write* | Narrowest possible scope; expires; attributed to the person |
| The shared course guest account **`cshl-2026`** (an *outside collaborator*) | **Classic** PAT, scope **`public_repo`** (the course repo is public) | GitHub only lets a fine-grained token target an org when the token owner is an org *member*. Never make the guest an org member — the org grants members write on every repo |
| Any other non-member collaborator on a **private** data repo | Classic PAT, scope `repo` | Same reason; `public_repo` cannot see private repos |

What an expired or revoked token looks like: on the next page load the Studio shows
**"The stored GitHub token is no longer valid. Sign in again from File ▾."** and drops
the stored token; a save or run-log commit made with a dead token falls back to
"saved locally". Nothing else breaks — reads of a public repo keep working signed-out.

## A. Renew the shared course token (guest account `cshl-2026`)

1. Sign in to GitHub as `cshl-2026`. The account was registered on 2026-07-04 to
   Michael's Janelia address (its commits carry `reiserm@janelia.hhmi.org`), so a
   forgotten password is reset via <https://github.com/password_reset> with that
   address, and any 2FA recovery codes were saved by whoever set it up (check the
   password manager / the 2026-07-04 GitHub emails). Sign out of your own account
   or use a private window first — GitHub keeps one session per browser profile.
2. Settings → Developer settings → Personal access tokens → **Tokens (classic)**.
   Delete the expired `cshl-2026-benches` token (or **Regenerate** it — same effect,
   new value).
3. **Generate new token (classic)**: Note `cshl-2026-benches`, **Expiration** = a date
   you put in the calendar (≤ 1 year), scopes = **`public_repo` only**. Copy the
   `ghp_…` value once; store it in the lab password manager.
4. On each bench browser (served from `http://127.0.0.1:8000/`, not `file://`):
   File ▾ → **Sign in…** → paste → **YES** to "Remember this token" → 🛡 advanced
   (instructor password) → 🔓 in the GitHub block → **Repo** `reiserlab/cshl-2026-course`,
   **Bench id** `bench01`…`bench07` (must match `roster.yaml`), tick **Commit
   directly to default branch** → 🔒. Connect the arena; the roster pre-fills the
   experimenter.
5. Check: the run log shows `ages list from the course repo (… 5 entries)` and no
   "unreadable" lines; a test save lands in `protocols/<bench-id>/`.

## B. Lab member recipe (the recommendation going forward)

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → **Generate new token**.
2. Name it after the machine (`rig-3e229-a` or `laptop`), **Expiration** ≤ 366 days
   (calendar reminder), **Resource owner = `reiserlab`** (if `reiserlab` is missing you
   are not an org member — ask Michael to add you, or use a classic token per row 3).
3. **Repository access → Only select repositories** → `reiserlab/arena-experiments`
   (add `reiserlab/cshl-2026-course` only if you still write there).
4. **Repository permissions → Contents: Read and write**. Metadata read is added
   automatically. Add *Pull requests: Read and write* only if you use "Save as Pull
   Request" against `reiserlab/webDisplayTools`. Nothing else.
5. Generate. If the org policy requires approval, the token is pending until an org
   owner approves it (Organization settings → Personal access tokens → Pending
   requests). Copy the `github_pat_…` value once.
6. In the Studio: File ▾ → **Sign in…** → paste. Answer **YES** to "Remember" only on a
   rig computer you control or your own laptop; answer **NO** (session-only) on a
   shared or borrowed machine. **Sign out** clears the token everywhere.
7. Set **Repo** and your **Rig id** once (🔓 needed); saves go to `protocols/<rig-id>/`,
   run logs to `runlogs/<rig-id>/`, and your commits carry your GitHub identity.

Sharing across the lab needs no extra permission: everyone with a token sees every
rig's folder, **File ▾ → Promote to shared…** copies a protocol and its patterns into
`protocols/shared/`, and the Pattern Designer's **Save to Repo → library** writes the
root `patterns/` library.

## C. Org-owner checklist (Michael)

- **PAT policy**: Organization settings → Third-party access → Personal access
  tokens. Confirm fine-grained tokens are allowed; choose "no approval required" for
  members or approve each request. Optionally set a maximum lifetime.
- **New private data repo**: no branch protection on the default branch (the Studio
  commits straight to it). Org members already have write via the org default
  (`default_repository_permission = write`); invite non-members per repo.
- **Someone leaves**: remove them from the org (or the repo) — their tokens lose
  access immediately. For the shared guest account, delete/regenerate its classic
  token (§A) so every bench stops writing at once.
- **Never** ask for a token in a URL, issue, chat, or run log; the Studio only ever
  sends it as an `Authorization` header.
