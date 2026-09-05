# Data repos — setup for a lab rig (and how the course repo fits)

Arena Studio, the Pattern Designer and the data-browser dashboard read and write a
GitHub **data repo**: protocols (`protocols/<rig-id>/`), their colocated patterns
(`…_patterns/`), the shared pattern library (`patterns/`), promoted protocols
(`protocols/shared/`) and one run log per completed recorded run
(`runlogs/<rig-id>/`). The root YAMLs (`roster.yaml`, `genotypes.yaml`, `ages.yaml`,
`sexes.yaml`, `fly_numbers.yaml`) are the controlled pick-lists for the Run-details
panel while that repo is configured; otherwise the site library
(`configs/metadata/*.yaml`) is used.

Two repos are registered in `js/studio-data-repos.js` and offered in the Studio's
File ▾ → GitHub **Repo** picker:

| Repo | Use | Visibility | Id label |
|---|---|---|---|
| `reiserlab/cshl-2026-course` | CSHL 2026 course showcase (kept as-is) | public | Bench id |
| `reiserlab/arena-experiments` | the lab's day-to-day experiments | private | Rig id |

A fresh browser has **no repo selected** — saves go to local files until someone picks
one. "Other…" accepts any `owner/name`.

## Set up a rig computer (once)

1. Get a token — see `data-repo-token-runbook.md` §B (org members: fine-grained,
   resource owner `reiserlab`, only the repo, Contents read/write).
2. Arena Studio → **File ▾** → GitHub **Sign in…** → paste → **YES** to remember on a
   dedicated rig computer (NO on a shared laptop).
3. 🛡 advanced mode → click **🔓** in the GitHub block → **Repo** = *Reiser lab
   experiments* → **Rig id** = this station's id (pick from the roster list or type a
   new one, e.g. `3e229-g6a`; unique per rig) → tick **Commit directly to default
   branch** → **🔒**.
4. Add the rig to the repo's `roster.yaml` under `rigs:` (with the controller MAC
   from the Studio connect log) and give people `rig_id`s if they own a station.

The label next to the id field follows the repo: "Bench id" for the course repo,
"Rig id" otherwise. The localStorage key is the same (`studio_bench_id`); switching
repos does not reset it — check it when you switch.

## Sharing across the lab

Everyone with access sees every rig's folders. **File ▾ → Promote to shared…** copies
a protocol and its `_patterns/` into `protocols/shared/` (refuses to overwrite a
*different* same-named file). The Pattern Designer's **Save to Repo → library**
writes `patterns/`. Nothing else is needed.

## Adding another data repo

1. Create + seed it: `scripts/seed-data-repo.sh --repo owner/name --apply`
   (dry run without `--apply`; private by default; idempotent).
2. Add an entry to `DATA_REPOS` in `js/studio-data-repos.js` (label, id label,
   placeholder, shared label, visibility). Tests: `tests/test-studio-data-repos.js`.
3. Never enable branch protection — the Studio commits straight to the default branch.

## Migrating rig folders between repos

Planned for the week of 2026-09-08 (`scripts/migrate-data-repo-dirs.sh`, see the
plan): copy `protocols/<id>/` + `runlogs/<id>/` from the course repo into the lab
repo under a new rig id without rewriting file contents; record the mapping in
`MIGRATION.md`. Removing from the public repo hides the files but not their git
history.
