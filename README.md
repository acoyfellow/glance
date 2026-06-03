# Glance

**A local visual glance at what your projects are doing.**

Glance is a local-first, read-only-focused PWA for observing project activity through two views:

- **Watch** — a compact activity and repository view.
- **Orb** — a visual ambient view of the same live signals.

```text
local project activity + context files
                 ↓
             Glance server
               ↙     ↘
            Watch    Orb
```

## Status

Glance is being separated from a personal local workspace into an independently maintained repository. It is functional today, but not yet prepared as a general-purpose public release.

- Runs locally on `127.0.0.1` only.
- Serves a PWA with Watch and Orb views.
- Reads local portfolio/context state from `../.context/` via `MACHINE_ROOT`.
- Exposes no app action endpoints; Watch and Orb only read local activity data.

## Run locally

Requires [Bun](https://bun.sh/).

```bash
bun install
MACHINE_ROOT=~/cloudflare bun run server
```

Open:

```text
http://127.0.0.1:8787/       # Watch
http://127.0.0.1:8787/orb    # Orb
```

## Repository boundary

This repo owns only the visual local application:

- `server.ts` — local PWA server and Watch/Orb surfaces.
- `build-dashboard.ts` — derives display data from local context and activity.
- `src/git-observer.ts` — observes repository activity.

Runtime/personal state remains outside the repo under configured `MACHINE_ROOT`, primarily:

```text
.context/runs/
.context/workers/
.context/events.jsonl
```

Do not commit tokens, generated dashboard state, local observation data, or personal run receipts.

## Security

Glance is intended to bind to localhost. It displays local project metadata and currently assumes local filesystem access. It is **not** suitable for public hosting or multi-user deployment in its present form.

Before an OSS/general release, it needs:

- removal or isolation of personal portfolio assumptions;
- fixture/demo data for a clean first-run experience;
- dependency, asset, and privacy review.

## Naming

**Glance** is the app. **Watch** and **Orb** are its two views. It is intentionally not a runtime, memory system, or control plane.
