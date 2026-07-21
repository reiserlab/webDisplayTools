# Arena Studio — Safe Mode & bookmarked protocol links

A quick, practical guide. Two parts: (1) exactly what **safe mode** does and does
not do, and (2) how to build a **direct bookmark** that opens one protocol from one
repo, in safe mode, ready to run. (For the design rationale see
`safe-mode-spec.md`; this is the how-to.)

---

## 1. Safe mode

Safe mode is the **default** whenever the Studio is opened on a browser that has
never been unlocked. It's the student-facing, "you can look and run, but not
change anything" mode. The 🛡 **Safe mode** chip in the top bar shows the state;
click it to unlock (soft password **`2026`**, or a per-bench override — see below).

### What safe mode DOES block

| Area | Blocked in safe mode |
|---|---|
| **Editor** | Truly view-only. Command-card fields, the Settings form, and the YAML box do not accept edits (inputs are `inert`, YAML is read-only, **Apply changes** is disabled). You can still open the Edit view, browse conditions, switch Designer/YAML tabs, scroll, and read/copy the YAML. |
| **Saving** | Save / Save as… / Promote-to-shared and every protocol mutation are refused (the doc model is frozen). |
| **Patterns (Console)** | **Add ▾** (all six upload sources) and the per-row **delete** are greyed and refused. **Purge** (delete all) and **Download ZIP** are blocked. |
| **Firmware / panels** | Panel programming, ISP copy/batch, firmware pick/flash — blocked. |
| **Controller config** | Panel mode, frame rate, SPI, system reset — blocked. |
| **Raw / low-level** | Raw hex send, load-file — blocked. |
| **Bench setup** | The session-rig selector is hard-locked; GitHub repo / bench-id settings are locked (🔒). |

### What safe mode does NOT block (still fully usable)

- **Viewing** any protocol — the Run summary, the sequence, the Edit view (read-only), the Console.
- **Connecting** to the arena and **running or testing** a protocol (Run / Test experiment / test one condition).
- The **oscilloscope**, including the CLOSED-LOOP marker and sonification.
- Console **queries** (list SD, pattern info, controller/firmware info), the **display test** (all-on/off, stream a frame, step frames), **driving outputs** (analog/digital, **including the LED**), **STOP / abort**, and **downloading a single pattern** from an SD row.

### Important: it's a guardrail, not a security boundary

The password is a **soft gate** checked in the browser — it prevents *accidents*,
not a determined user. Anyone who knows the password (or clears the browser's
`localStorage`) can unlock. Don't rely on it to protect data or hardware from
deliberate misuse.

### Unlocking / re-locking

- Click the 🛡 **Safe mode** chip → enter the password → it becomes **🔓 Advanced ·
  lock**. This is **remembered on that browser** (`localStorage['studio_advanced_unlocked']`).
- Click **🔓 Advanced · lock** to drop back to safe mode.
- Default password is **`2026`**. An instructor can set a per-bench override:
  `localStorage['studio_advanced_pw'] = 'yourpassword'` (the built-in `2026` is only
  a fallback when no override is set).
- **Kiosk tip:** because unlock is *remembered per browser*, a machine that was ever
  unlocked stays advanced until it's re-locked. Two ways to re-lock: click **🔓
  Advanced · lock**, or open **any link with `?advanced=0`** (see below) — that
  forces safe mode and *forgets* the unlock, so the machine then stays safe on later
  loads too. Handing a bookmarked `?advanced=0` link to students guarantees safe mode
  even on a machine that was previously unlocked.

---

## 2. Direct bookmarked links (one protocol, one repo, safe mode)

This is the "here, run this" workflow: a bookmark per protocol that opens it in
safe mode, in the Run view, ready to hit **Connect → Run**.

### The URL parameters

| Param | Meaning |
|---|---|
| `repo=owner/name` | The course/data repo to load from (e.g. `reiserlab/cshl-2026-course`). |
| `p=…` | The protocol. **With `repo`**, it's a repo-relative path under `protocols/` (e.g. `protocols/bench03/looming.yaml`). **Without `repo`**, it's a site-library key from `protocols/index.json` (e.g. `g6_2x10_smoke`). |
| `rig=name` | *(optional)* The session/bench rig, e.g. `cshl_g6_2x10_ball`. Sets the bench rig for geometry; it never rewrites the protocol's own rig (a disagreement raises the mismatch chip). |
| `advanced=1` | *(leave OFF for safe mode)* Requests advanced mode; still password-gated. Omit it and you get safe mode by default. |
| `advanced=0` | **Forces safe mode** — re-locks a browser that was previously unlocked-and-remembered, and forgets the unlock (so it stays safe afterward). Use this on shared/kiosk machines. |

Notes that make these links "just work":

- A `p=` link **always lands in Run** — even `mode=edit` is ignored for a shared
  protocol (newbie safety). So you never need `mode=`.
- Safe mode is the default; **just don't add `advanced=1`.**
- `/` in the path does **not** need URL-encoding — keep it readable.

### Form A — a repo protocol (the course pipeline; what you want)

```
https://reiserlab.github.io/webDisplayTools/arena_studio.html?repo=reiserlab/cshl-2026-course&p=protocols/<bench-id>/<protocol>.yaml
```

- Use `protocols/<bench-id>/…` for a **bench-specific** protocol, or
  `protocols/shared/…` for a **shared** one — exactly the paths shown in File ▾ →
  Open protocol.
- Add `&rig=<rigname>` if you want the bench rig set too.

Example (bench-specific + rig):

```
https://reiserlab.github.io/webDisplayTools/arena_studio.html?repo=reiserlab/cshl-2026-course&p=protocols/bench03/looming.yaml&rig=cshl_g6_2x10_ball
```

**Requirement (private repo):** the course repo is private, so the browser must be
**signed in to GitHub once** (File ▾ → GitHub — the token is then remembered in
`localStorage`). After that, the link loads the protocol directly. If the browser
is *not* signed in, the link is safe about it: it stays in safe/Run and shows a
banner telling you to sign in and use File ▾ → "Open from course repo…". (A signed-in
token is per-browser, so you sign in once per machine.)

### Form B — a site-library protocol (public, no sign-in)

```
https://reiserlab.github.io/webDisplayTools/arena_studio.html?p=g6_2x10_smoke&rig=cshl_g6_2x10_ball
```

These keys come from the site's `protocols/index.json` (public), so they load with
no GitHub sign-in — handy for demos and smoke tests.

### How to build the link from your current settings

1. **Repo** = your File ▾ → GitHub "repo" value (`owner/name`).
2. **Bench id** = your File ▾ → GitHub "bench id" → path prefix `protocols/<bench-id>/`
   (or `protocols/shared/` for a shared protocol).
3. **Protocol filename** = the `.yaml` you saved (the slugged name shown in File ▾ →
   Open). Append it to the prefix.
4. Optionally add `&rig=` with one of the rig names from `configs/rigs/index.json`
   (e.g. `cshl_g6_2x10`, `cshl_g6_2x10_ball`, `cshl_g6_2x8`).
5. Bookmark it. Repeat per protocol.

### Verified behavior (tested 2026-07-08)

- `…/arena_studio.html?p=g6_2x10_smoke&rig=cshl_g6_2x10_ball` → protocol loaded, **Run**
  view, **safe mode** on, editor locked (view-only), rig set, Run button reads
  `15 steps · ~0:50 · Connect to run`. ✓
- `…/arena_studio.html?repo=reiserlab/cshl-2026-course&p=protocols/shared/looming.yaml`
  with **no** stored token → stays safe/Run and shows the "sign in, then Open from
  course repo…" banner (no error). With a token it opens directly. ✓
- `…/arena_studio.html?advanced=0&p=g6_2x10_smoke` on a browser that was
  remembered-unlocked → forced back to **safe** mode (editor re-locked, unlock
  forgotten), protocol loaded in **Run**; a later plain reload stays safe. ✓
