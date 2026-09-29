# Release manifests

One JSON file per Production release (and per hotfix), written by the release commit
that `pixi run candidate` builds — see `docs/development/release-process.md`.

A manifest records exactly what shipped:

- `main_sha`: the main commit the candidate was built on
- `prs[]`: each PR's number, title and **head SHA** (the pinned commit that was tested)
- `versions`: each tool's version bump (`from` → `to`)
- `rc`: which rebuild of the candidate was released
- `kind`: `candidate` or `hotfix` (hotfixes carry `hotfix_reason`)

The deploy workflow finds a candidate's manifest through the `Release-Manifest:` trailer
of its release commit, and stamps the build identity into every page served under `/next/`.
Don't edit these by hand: they are the provenance record for run logs
(`run_metadata.build`) and for rollbacks (`release-<name>` tags).
