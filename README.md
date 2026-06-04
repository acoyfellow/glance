# Glance

**A local visual glance at what your projects are doing.**

Glance is a local-first, read-only PWA with two views:

- **Watch** — recent file and repository activity.
- **Orb** — an ambient visual view of the same live signals.

```text
local project activity + optional event files
                    ↓
                Glance server
                  ↙     ↘
               Watch    Orb
```

| Watch | Orb |
|---|---|
| ![Watch view showing recent local project activity](./docs/screenshots/watch.png) | ![Orb ambient activity view](./docs/screenshots/orb.png) |

## Run locally

Requires [Bun](https://bun.sh/).

```bash
bun install
GLANCE_ROOT=~/projects bun run server
```

Open:

```text
http://127.0.0.1:8787/       # Watch
http://127.0.0.1:8787/orb    # Orb
```

Check the minimal local contract:

```bash
bun test
```

By default, Glance observes the parent directory of its own checkout. Set `GLANCE_ROOT` to observe another project directory.

## Optional configuration

Copy the example config if you want persistent settings:

```bash
cp glance.config.example.json glance.config.json
```

```json
{
  "root": "~/projects",
  "contextDir": ".glance"
}
```

Configuration can also be supplied by environment variables:

| Setting | Purpose |
|---|---|
| `GLANCE_ROOT` | Directory whose projects and activity should be observed. |
| `GLANCE_CONFIG` | Path to a JSON config file. Defaults to `./glance.config.json`. |
| `GLANCE_CONTEXT_DIR` | Optional directory, relative to root or absolute, containing `runs/` and `events.jsonl`. |
| `GLANCE_GIT_MAX_DEPTH` | Maximum directory depth for discovering git repositories. |
| `MACHINE_ROOT` | Legacy alias for `GLANCE_ROOT`; retained for local upgrades. |

Without `contextDir`, Glance still shows recent files and git status; it simply has no optional event or receipt feed.

## Privacy and security

Glance is designed to bind to `127.0.0.1`. It is deliberately read-only: there are no app action endpoints for starting jobs, running commands, or locking your device.

Glance displays filenames, repository names, git status, and optional event/receipt metadata found beneath directories you configure. It does **not** automatically scan coding-agent conversation history.

Orb also contains opt-in ambient interactions: after a click or keypress, the browser may request microphone/camera access for local visual response and gesture effects. These media streams are used in-page; Glance does not upload or persist camera or microphone content.

Do not expose Glance publicly without adding an authentication and data-filtering model suitable for your environment. See [SECURITY.md](./SECURITY.md).

## Repository layout

- `server.ts` — local PWA server and Watch/Orb surfaces.
- `build-dashboard.ts` — creates optional dashboard/activity summary data.
- `src/git-observer.ts` — observes git repository status.
- `src/config.ts` — configuration loading and path expansion.

Generated state, local configuration, assets, and observation history are ignored from git.

## Naming

**Glance** is the app. **Watch** and **Orb** are its two views. It is an observer, not a runtime, memory system, or control plane.
