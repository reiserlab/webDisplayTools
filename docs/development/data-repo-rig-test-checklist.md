# Data-repo rig test checklist (Studio v0.72, PR #178)

Validates the data-repo generalization on a real rig: repo picker, "Rig id",
roster-fed rig list, and the full save / open / promote / run-log path against the
private lab repo `reiserlab/arena-experiments`. About 30 minutes with a rig.

**Before you start.** Serve the PR branch (`git checkout feat/data-repo-registry`,
`pixi run serve`, open `http://127.0.0.1:8000/arena_studio.html`) or merge #178 and
hard-refresh the rig after the Pages deploy (Cmd+Shift+R). You need your own
fine-grained token for `arena-experiments` (`data-repo-token-runbook.md` §B).
Steps 1–5 and 13–14 need no token and no arena.

## A. Picker and labels (no token)

1. **Fresh state.** Private window → Studio. GitHub block: Repo "— none (local
   files) —", label **Rig id**, Save button "Save → local file", footer v0.72.
2. **Lock.** Repo dropdown is greyed. 🛡 advanced → 🔓 enables it; 🔒 greys it again.
3. **Lab repo.** Pick *Reiser lab experiments*. Label stays **Rig id**, placeholder
   `e.g. 3e229-g6a`, bottom-corner quick links read "Reiser lab experiments ↗" and
   point at `reiserlab/arena-experiments`.
4. **Course repo.** Pick *CSHL 2026 course*. Label flips to **Bench id**, placeholder
   `e.g. bench03`, quick links repoint. Switch back to the lab repo.
5. **Other.** Pick *Other…*, type `nonsense`, Enter → banner "Repo must be
   owner/name", previous repo restored. Type a valid `owner/name` → it sticks.

## B. Signed in against the lab repo

6. **Sign in.** File ▾ → Sign in… → paste your fine-grained token → YES to remember
   (rig computer). Block reads `✓ @<you> → reiserlab/arena-experiments`. Run-view log
   shows five "… from the Reiser lab experiments" lines (roster, genotypes, ages,
   sexes, fly_numbers). Experimenter dropdown = the Janelia names from the roster.
7. **Rig id.** Click the Rig id field: no suggestions yet (lab roster has no rigs).
   Type e.g. `3e229-g6a`, tick **Commit directly to default branch**, 🔒.
8. **Save.** Open any protocol → Save. Button reads "Save → Reiser lab experiments";
   the file appears under `protocols/<rig-id>/` on GitHub within seconds.
9. **Open from Repo.** Shows "This rig — <rig-id>" with your save and "Shared
   protocols (lab-wide)" (empty).
10. **Promote.** File ▾ → Promote to shared… → file appears in `protocols/shared/`
    and under the shared header of the picker.
11. **Roster rigs + MAC chip.** In the repo, edit `roster.yaml`:
    ```yaml
    rigs:
      - rig_id: 3e229-g6a
        mac: "00:00:00:00:00:00"
    ```
    Reload the Studio, connect the arena. The Rig id field now suggests that id; the
    "⚠ rig ≠ roster" chip appears (wrong MAC). Put the real MAC from the connect log
    into the roster → reload → chip gone.
12. **Run log.** Run a short protocol as an *experiment* (bridge connected). Expect
    "✓ Run log committed" and a file under `runlogs/<rig-id>/`.

## C. Other pages

13. **Pattern Designer.** Open via the Studio's *Patterns ↗* link. ⇪ Save to Repo →
    the protocol destination row reads "rig <rig-id>" (not "bench").
14. **Dashboard.** `dashboard/data-browser/`: the repo field suggests both repos; pick
    the lab repo → it lists your `runlogs/<rig-id>` folder.

## D. Course-bench regression

15. On a bench that already had the course repo stored, load v0.72: Repo shows
    *CSHL 2026 course* pre-selected, label **Bench id**, "Save → CSHL 2026 course"
    works as before.

## Known limits to keep in mind

- **Run-log size.** The browser commits via the GitHub Contents API, which rejects
  files above ~35 MiB (measured; HTTP 422). A 20 s-trial P3 full run is ~26 MB; a
  40 s-trial run is ~51 MB and will NOT auto-commit — the Studio says "saved locally
  on the bridge machine". Push those from a clone (`git push` allows up to 100 MB per
  file) until the Studio gains a large-file path (see release notes / issues).
- Aborted or test runs never auto-commit (by design) — use ⇪ Push log.

If anything in B misbehaves, the Run-view log line is the fastest diagnostic.
