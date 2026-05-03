#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join, normalize, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.MACHINE_ROOT ?? "/Users/jcoeyman/cloudflare";
const DIR = join(ROOT, ".context/machine-dashboard");
const DIST = join(DIR, "dist");
const PORT = Number(process.env.MACHINE_DASHBOARD_PORT ?? 8787);
const HOST = "127.0.0.1";
const builder = join(DIR, "build-dashboard.ts");
const clients = new Set<ServerWebSocket<unknown>>();
const activityClients = new Set<ReadableStreamDefaultController>();
let lastState = "{}";
let timer: Timer | null = null;
let lastBroadcast = "";
let lastBroadcastAt = 0;
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const tokenPath = join(DIR, "token");
function token() { try { return readFileSync(tokenPath, "utf8").trim(); } catch { return ""; } }
function authed(req: Request) { return req.headers.get("x-machine-token") === token(); }
function emit(type: string, data: Record<string, unknown>) {
  const evt = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
  spawnSync("/bin/sh", ["-lc", `printf '%s\n' ${JSON.stringify(evt)} >> ${JSON.stringify(join(ROOT, ".context/events.jsonl"))}`]);
}
function rig(args: string[]) { return spawnSync(join(ROOT, ".context/bin/rig"), args, { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 10000 }); }

const projectPaths: Record<string, string> = {
  "cloudshell": join(ROOT, "cloudshell"),
  "filepath": join(ROOT, "filepath"),
  "deja": join(ROOT, "deja"),
  "guardrail": join(ROOT, "guardrail"),
  "capa": join(ROOT, "capa"),
  "lab": join(ROOT, "lab"),
  "cloudterm": join(ROOT, "cloudterm"),
  "cloudeval": join(ROOT, "cloudeval"),
  "unsurf": join(ROOT, "unsurf"),
  "contributron": join(ROOT, "contributron"),
  "hermes": join(ROOT, "hermes"),
  "t2t": join(ROOT, "t2t"),
  "mcpu": join(ROOT, "mcpu"),
  "coey.dev": join(ROOT, "coey.dev"),
  ".context rig": ROOT,
};

function findRecentRuns(project: string, n = 3): { path: string; mtime: string; content: string }[] {
  const runsDir = join(ROOT, ".context/runs");
  if (!existsSync(runsDir)) return [];
  const fs = require("node:fs");
  const out: any[] = [];
  for (const ent of fs.readdirSync(runsDir, { withFileTypes: true })) {
    const p = join(runsDir, ent.name);
    if (ent.isDirectory()) {
      for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
        if (sub.isFile() && sub.name.endsWith(".md")) {
          const fp = join(p, sub.name);
          try {
            const txt = fs.readFileSync(fp, "utf8");
            if (txt.toLowerCase().includes(project.toLowerCase())) {
              out.push({ path: fp.replace(ROOT + "/", ""), mtime: fs.statSync(fp).mtimeMs, content: txt.slice(0, 2000) });
            }
          } catch {}
        }
      }
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      try {
        const txt = fs.readFileSync(p, "utf8");
        if (txt.toLowerCase().includes(project.toLowerCase())) {
          out.push({ path: p.replace(ROOT + "/", ""), mtime: fs.statSync(p).mtimeMs, content: txt.slice(0, 2000) });
        }
      } catch {}
    }
  }
  return out.sort((a: any, b: any) => b.mtime - a.mtime).slice(0, n).map((r: any) => ({ ...r, mtime: new Date(r.mtime).toISOString() }));
}

function gitStatus(projectPath: string): string {
  if (!existsSync(join(projectPath, ".git"))) return "(not a git repo)";
  const r = spawnSync("git", ["status", "--short"], { cwd: projectPath, encoding: "utf8", timeout: 5000 });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: projectPath, encoding: "utf8", timeout: 5000 });
  return `branch: ${branch.stdout.trim() || "unknown"}\nstatus:\n${r.stdout.trim() || "clean"}`;
}

function generatePrompt(project: string, projectPath: string): string {
  // Read lane data from dashboard.json
  let lane: any = null;
  try {
    const dash = JSON.parse(readFileSync(join(DIR, "dashboard.json"), "utf8"));
    lane = (dash.lanes || []).find((l: any) => l.name === project);
  } catch {}

  const runs = findRecentRuns(project, 2);
  const git = existsSync(projectPath) ? gitStatus(projectPath) : "(path not found)";

  const recentRunsBlock = runs.length
    ? runs.map(r => `--- ${r.path} (${r.mtime}) ---\n${r.content}`).join("\n\n")
    : "(no recent run receipts found)";

  return `You are resuming work on the \`${project}\` project.

## Project context

| Field | Value |
|---|---|
| Name | ${project} |
| Path | ${projectPath} |
| State | ${lane?.state || "unknown"} |
| Risk | ${lane?.risk || "unknown"} |
| Why it matters | ${lane?.why || ""} |
| Current finding | ${lane?.finding || ""} |
| Next action | ${lane?.next || ""} |

## Git status

\`\`\`
${git}
\`\`\`

## Recent activity

${recentRunsBlock}

## Boot sequence

1. Read \`.context/START-HERE.md\` for the latest handoff.
2. Read \`.context/NOW.md\` for current priorities.
3. Read \`.context/ACTIVE-PORTFOLIO-2026-04-26.md\` for the project map.
4. Inspect the repo at \`${projectPath}\`.
5. Begin with the "Next action" above.

## Rules

- Do not edit, commit, deploy, or mutate external services unless explicitly asked.
- Cloudflare-work is gated unless Jordan says work mode.
- a0 is archive/reference — mine lessons, but do not resume implementation casually.
- End with DONE, HANDOFF, QUESTION, or BLOCKED.
`;
}

function generateRepoBrief(repoPath: string): string {
  const dash = JSON.parse(readFileSync(join(DIR, "dashboard.json"), "utf8"));
  const observer = dash.gitObserver;
  const repo = (observer.repos || []).find((item: any) => item.path === repoPath);
  if (!repo) throw new Error("unknown repo");
  const delta = observer.delta || {};
  const relatedDelta = [
    ...(delta.newDirty || []).includes(repo.path) ? [`newly dirty: ${repo.path}`] : [],
    ...(delta.cleaned || []).includes(repo.path) ? [`cleaned: ${repo.path}`] : [],
    ...(delta.branchChanged || []).filter((item: any) => item.path === repo.path).map((item: any) => `branch changed: ${item.from} -> ${item.to}`),
    ...(delta.headChanged || []).filter((item: any) => item.path === repo.path).map((item: any) => `head changed: ${item.from} -> ${item.to}`),
    ...(delta.dirtyChanged || []).filter((item: any) => item.path === repo.path).map((item: any) => `dirty count changed: ${item.from} -> ${item.to}`),
  ];
  return `You are starting work from the Machine Observe loop.

## Repo

Path: ${join(ROOT, repo.path)}
Branch: ${repo.branch}
Head: ${repo.head}
Attention: ${repo.attention}
Dirty files: ${repo.dirty}
Staged: ${repo.staged}
Unstaged: ${repo.unstaged}
Untracked: ${repo.untracked}
Ahead/behind: ${repo.ahead}/${repo.behind}
Noise: ${repo.noiseReason || "none"}

## Observe delta

Previous scan: ${observer.delta?.previousAt || "none"}
${relatedDelta.length ? relatedDelta.map((line) => `- ${line}`).join("\n") : "- No repo-specific delta since previous scan."}

## Git sample

\`\`\`
${(repo.sample || []).join("\n") || "clean"}
\`\`\`

## Rules

- Treat this Observe state as the source of truth before acting.
- Inspect the repo before editing.
- Do not deploy, push, pull, fetch, or mutate external services unless Jordan explicitly asks.
- End with DONE, HANDOFF, QUESTION, or BLOCKED.
`;
}

function allowed(req: Request) {
  const host = req.headers.get("host") ?? "";
  const origin = req.headers.get("origin");
  if (!allowedHosts.has(host)) return false;
  if (origin && !allowedOrigins.has(origin)) return false;
  return true;
}
function rebuild() {
  spawnSync("bun", ["run", builder], { cwd: ROOT, env: process.env, encoding: "utf8" });
  try { lastState = readFileSync(join(DIR, "dashboard.json"), "utf8"); } catch { lastState = JSON.stringify({ error: "missing dashboard.json" }); }
  const now = Date.now();
  if (lastState === lastBroadcast && now - lastBroadcastAt < 1000) return;
  lastBroadcast = lastState;
  lastBroadcastAt = now;
  for (const ws of clients) if (ws.readyState === 1) ws.send(lastState);
}
function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(rebuild, 120); }
function type(path: string) { return path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : path.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8"; }
const recentFileIgnoreDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".svelte-kit", ".wrangler", ".turbo", ".alchemy", "coverage"]);
const recentFileIgnoreFiles = new Set([".DS_Store", "dashboard.json"]);
const recentFileIgnorePathParts = [
  ".context/machine-dashboard/data/",
  ".context/machine-dashboard/dist/",
  ".context/machine-dashboard/public/",
  ".context/machine-dashboard/dashboard.json",
  ".context/machine-dashboard/dashboard.html",
];
type ActivityFile = { path: string; mtime: number; mtimeIso: string; size: number };
type ActivitySignal = "source" | "generated" | "log" | "config" | "secret" | "git" | "context" | "asset";
type ActivityEvent = { kind: "create" | "modify" | "delete" | "burst"; signal: ActivitySignal; path: string; repo: string; size: number; previousSize?: number; mtimeIso: string; count?: number };
type ProjectRoot = { repo: string; latest: number; latestIso: string };
const activityByPath = new Map<string, ActivityFile>();
const projectRoots = new Map<string, ProjectRoot>();
const burstWindows = new Map<string, number[]>();
let activityCache = JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, files: [] });
let activityDirty = true;
function repoForPath(relPath: string) {
  if (relPath.startsWith(".context/")) return ".context";
  return relPath.split("/")[0] || "root";
}
function shouldIgnoreProjectRoot(name: string) {
  return recentFileIgnoreDirs.has(name) || recentFileIgnoreFiles.has(name);
}
function signalForPath(relPath: string): ActivitySignal {
  const lower = relPath.toLowerCase();
  const name = lower.split("/").at(-1) || lower;
  if (lower.includes("/.git/") || lower.endsWith("/.git") || name === ".gitignore" || name === ".gitattributes") return "git";
  if (name.includes("secret") || name === ".env" || name.startsWith(".env.") || lower.includes("/.env")) return "secret";
  if (name.endsWith(".log") || lower.includes("/logs/") || lower.includes("/.local/")) return "log";
  if (lower.includes("/dist/") || lower.includes("/build/") || lower.includes("/.astro/") || lower.includes("/public/artifacts/") || name.endsWith(".lock")) return "generated";
  if (name.endsWith(".toml") || name.endsWith(".json") || name.endsWith(".jsonc") || name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".config.ts") || name.endsWith(".config.js")) return "config";
  if (/\.(png|jpe?g|gif|webp|svg|mp3|wav|mp4|mov|bin|wasm)$/i.test(name)) return "asset";
  if (lower.startsWith(".context/") || lower.includes("/.context/")) return "context";
  return "source";
}
function shouldIgnoreRecentPath(relPath: string, name = relPath.split("/").at(-1) || relPath) {
  if (recentFileIgnoreFiles.has(name)) return true;
  if (recentFileIgnorePathParts.some((part) => relPath.startsWith(part))) return true;
  return relPath.split("/").some((part) => recentFileIgnoreDirs.has(part));
}
function indexRecentFiles(dir = ROOT, depth = 0) {
  if (depth > 8) return;
  let entries: ReturnType<typeof readdirSync> = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const path = join(dir, ent.name);
    const relPath = relative(ROOT, path);
    if (shouldIgnoreRecentPath(relPath, ent.name)) continue;
    if (ent.isDirectory()) {
      if (depth === 0) indexProjectRoot(path, false);
      indexRecentFiles(path, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    indexOneFile(path, false);
  }
}
function indexProjectRoot(path: string, notify = true) {
  const relPath = relative(ROOT, path);
  if (!relPath || relPath.startsWith("..") || relPath.includes("/") || shouldIgnoreProjectRoot(relPath)) return;
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return;
    projectRoots.set(relPath, { repo: relPath, latest: st.mtimeMs, latestIso: new Date(st.mtimeMs).toISOString() });
    activityDirty = true;
    if (notify) broadcastActivity();
  } catch {
    if (projectRoots.delete(relPath)) {
      activityDirty = true;
      if (notify) broadcastActivity();
    }
  }
}
function indexOneFile(path: string, notify = true) {
  const relPath = relative(ROOT, path);
  if (!relPath || relPath.startsWith("..") || shouldIgnoreRecentPath(relPath)) return;
  const previous = activityByPath.get(relPath);
  let event: ActivityEvent | null = null;
  try {
    const st = statSync(path);
    if (!st.isFile()) return;
    const next = { path: relPath, mtime: st.mtimeMs, mtimeIso: new Date(st.mtimeMs).toISOString(), size: st.size };
    activityByPath.set(relPath, next);
    event = { kind: previous ? "modify" : "create", signal: signalForPath(relPath), path: relPath, repo: repoForPath(relPath), size: st.size, previousSize: previous?.size, mtimeIso: next.mtimeIso };
  } catch {
    if (previous) {
      activityByPath.delete(relPath);
      event = { kind: "delete", signal: signalForPath(relPath), path: relPath, repo: repoForPath(relPath), size: 0, previousSize: previous.size, mtimeIso: new Date().toISOString() };
    }
  }
  activityDirty = true;
  if (notify && event) broadcastActivity(withBurstEvent(event));
}
function withBurstEvent(event: ActivityEvent): ActivityEvent[] {
  if (event.kind === "delete") return [event];
  const now = Date.now();
  const key = `${event.repo}:${event.signal}`;
  const hits = (burstWindows.get(key) || []).filter((hit) => now - hit < 1800);
  hits.push(now);
  burstWindows.set(key, hits);
  if (hits.length === 4 || hits.length === 8 || hits.length === 14) {
    return [event, { ...event, kind: "burst", count: hits.length, path: `${event.repo}/`, size: event.size }];
  }
  return [event];
}
function recentFilesJsonString() {
  if (!activityDirty) return activityCache;
  const allFiles = [...activityByPath.values()].sort((a, b) => b.mtime - a.mtime);
  const files = allFiles.slice(0, 240);
  const projects = projectsFromActivity(allFiles);
  activityCache = JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, files, projects }, null, 2);
  activityDirty = false;
  return activityCache;
}
function projectsFromActivity(files: ActivityFile[]) {
  const projects = new Map<string, { repo: string; latest: number; latestIso: string; files: number; size: number; signals: Record<string, number>; paths: string[]; activity: number[] }>();
  const now = Date.now();
  for (const file of files) {
    const repo = repoForPath(file.path);
    const signal = signalForPath(file.path);
    let project = projects.get(repo);
    if (!project) {
      project = { repo, latest: file.mtime, latestIso: file.mtimeIso, files: 0, size: 0, signals: {}, paths: [], activity: Array(12).fill(0) };
      projects.set(repo, project);
    }
    project.files++;
    project.size += file.size || 0;
    project.signals[signal] = (project.signals[signal] || 0) + 1;
    if (project.paths.length < 3) project.paths.push(file.path);
    if (file.mtime > project.latest) {
      project.latest = file.mtime;
      project.latestIso = file.mtimeIso;
    }
    const hours = Math.max(0, Math.floor((now - file.mtime) / 3600000));
    const bucket = Math.min(11, Math.floor(hours / 6));
    project.activity[bucket]++;
  }
  for (const root of projectRoots.values()) {
    if (projects.has(root.repo)) continue;
    projects.set(root.repo, { repo: root.repo, latest: root.latest, latestIso: root.latestIso, files: 0, size: 0, signals: { source: 0 }, paths: [], activity: Array(12).fill(0) });
  }
  return [...projects.values()].sort((a, b) => b.latest - a.latest);
}
function activityPayload(events: ActivityEvent[] = []) {
  return JSON.stringify({ ...JSON.parse(recentFilesJsonString()), events });
}
function broadcastActivity(events: ActivityEvent[] = []) {
  const data = `event: activity\ndata: ${activityPayload(events)}\n\n`;
  for (const controller of activityClients) {
    try { controller.enqueue(data); } catch { activityClients.delete(controller); }
  }
}
function watchHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Machine File Watch</title>
  <style>
    :root { color-scheme: light; --bg:#f4f6f8; --paper:#fff; --line:#d7dee5; --text:#1f2933; --muted:#667085; --hot:#155eef; --glow:#d7f7ea; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:13px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { padding:14px; }
    .meta { display:grid; grid-template-columns: 34px 34px 180px 1fr 120px; gap:8px; margin-bottom:8px; color:var(--muted); font-size:12px; align-items:center; }
    .tool-button { width:26px; height:26px; border:1px solid var(--line); border-radius:999px; cursor:pointer; box-shadow:0 1px 2px rgba(31,41,51,.12); }
    .tool-button:focus-visible { outline:2px solid var(--hot); outline-offset:2px; }
    .ambient-toggle { background:radial-gradient(circle at 35% 30%, #ffffff 0 15%, #bfeadc 16% 38%, #6d9ff8 39% 61%, #314b62 62% 100%); }
    .project-toggle { background:linear-gradient(135deg, #ffffff 0 24%, #dbe7ef 25% 42%, #7aa6b8 43% 57%, #f2d27c 58% 75%, #ffffff 76% 100%); }
    body.project-view .project-toggle { box-shadow:0 0 0 3px rgba(122,166,184,.22), 0 1px 2px rgba(31,41,51,.12); }
    body.ambient-on { overflow:hidden; }
    #ambient { position:fixed; inset:0; width:100vw; height:100vh; z-index:20; opacity:0; pointer-events:none; background:#f6f8f5; transition:opacity 260ms ease; }
    body.ambient-on #ambient { opacity:1; pointer-events:auto; }
    body.ambient-on table, body.ambient-on .meta > div, body.ambient-on .project-toggle { visibility:hidden; }
    body.ambient-on .ambient-toggle { position:fixed; top:14px; left:14px; z-index:30; }
    table { width:100%; border-collapse:collapse; background:var(--paper); border:1px solid var(--line); }
    th, td { padding:7px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:0; background:#f9fafb; z-index:1; color:var(--muted); font-size:11px; text-transform:uppercase; }
    tr.hot td:first-child { border-left:3px solid var(--repo, var(--hot)); }
    tr.deleted td { color:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; text-decoration-color:var(--repo); }
    tr.secret td { background:linear-gradient(90deg, var(--repo-wash), transparent 42%); }
    tr.generated .path { font-weight:620; }
    tr.log .path { color:#475467; }
    tr.pulse { animation:file-pulse 1200ms ease-out both; }
    tr.pulse td { animation:cell-pulse 1200ms ease-out both; }
    .path { font-weight:750; overflow-wrap:anywhere; }
    .path::before { content:""; display:inline-block; width:7px; height:7px; margin-right:8px; border-radius:50%; background:var(--repo, var(--hot)); box-shadow:0 0 0 3px var(--repo-soft, transparent); vertical-align:1px; }
    .project-name { font-weight:800; }
    .project-name::before { content:""; display:inline-block; width:9px; height:9px; margin-right:8px; border-radius:50%; background:var(--repo, var(--hot)); box-shadow:0 0 0 3px var(--repo-soft, transparent); vertical-align:1px; }
    .spark { display:flex; gap:3px; align-items:end; height:18px; min-width:76px; }
    .spark i { display:block; width:5px; min-height:3px; border-radius:2px 2px 0 0; background:var(--repo); opacity:.34; }
    .spark i.hotbar { opacity:.9; }
    .muted { color:var(--muted); }
    .age { white-space:nowrap; font-variant-numeric:tabular-nums; }
    @keyframes file-pulse {
      0% { transform:translateY(-1px); }
      35% { transform:translateY(0); }
      100% { transform:translateY(0); }
    }
    @keyframes cell-pulse {
      0% { background:var(--repo-wash, var(--glow)); }
      100% { background:transparent; }
    }
    @media (prefers-reduced-motion: reduce) {
      tr.pulse, tr.pulse td { animation:none; }
    }
  </style>
</head>
<body>
  <canvas id="ambient" aria-hidden="true"></canvas>
  <main>
    <div class="meta"><button class="tool-button ambient-toggle" id="ambientToggle" type="button" aria-label="Toggle ambient visualizer"></button><button class="tool-button project-toggle" id="projectToggle" type="button" aria-label="Toggle project recency"></button><div id="count">loading</div><div>${ROOT}</div><div id="updated"></div></div>
    <table>
      <thead id="head"><tr><th>Updated</th><th>File</th><th>Size</th></tr></thead>
      <tbody id="files"><tr><td colspan="3">loading</td></tr></tbody>
    </table>
  </main>
  <script>
    const fmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    const seen = new Map();
    const deletedRows = new Map();
    let projectView = false;
    let lastData;
    let firstRender = true;
    let audio;
    let audioReadyPinged = false;
    let lastChime = 0;
    const recentHits = [];
    const canvas = document.getElementById("ambient");
    const paint = canvas.getContext("2d");
    const visualEvents = [];
    const modes = ["ripples", "radar", "waves"];
    let mode = 0;
    let visualOn = false;
    let lastFrame = 0;
    function resizeAmbient() {
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.floor(innerWidth * dpr);
      canvas.height = Math.floor(innerHeight * dpr);
      paint.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeAmbient();
    addEventListener("resize", resizeAmbient);
    document.getElementById("ambientToggle").addEventListener("click", () => {
      visualOn = !visualOn;
      document.body.classList.toggle("ambient-on", visualOn);
      if (visualOn) {
        seedAmbient(mode);
        requestAnimationFrame(drawAmbient);
      }
    });
    document.getElementById("projectToggle").addEventListener("click", () => {
      projectView = !projectView;
      document.body.classList.toggle("project-view", projectView);
      if (lastData) render(lastData, true);
    });
    canvas.addEventListener("click", () => {
      mode = (mode + 1) % modes.length;
      seedAmbient(mode);
    });
    function audioContext() {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      return audio;
    }
    async function wakeAudio() {
      try {
        const ctx = audioContext();
        if (ctx.state !== "running") await ctx.resume();
        if (ctx.state === "running" && !audioReadyPinged) {
          audioReadyPinged = true;
          const tone = repoTone(".context");
          note(ctx, ctx.destination, tone, ctx.currentTime, tone.base * 0.7, 0.008, 0.09);
        }
      } catch {}
    }
    addEventListener("pointerdown", wakeAudio);
    addEventListener("keydown", wakeAudio);
    function repoName(path) {
      if (path.startsWith(".context/")) return ".context";
      return path.split("/")[0] || "root";
    }
    function hashText(text) {
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }
    function repoTone(repo) {
      const hash = hashText(repo);
      const scale = [0, 2, 4, 7, 9, 12];
      const base = 740 * Math.pow(2, scale[hash % scale.length] / 12);
      return {
        base,
        high: base * (1.25 + ((hash >>> 4) % 5) * 0.025),
        overtone: base * (1.48 + ((hash >>> 9) % 6) * 0.018),
        detune: -10 + ((hash >>> 15) % 21),
        pan: (((hash >>> 21) % 101) - 50) / 100,
        wave: (hash & 1) ? "triangle" : "sine",
      };
    }
    function repoColor(repo) {
      const hash = hashText(repo);
      const hue = (hash % 360);
      return {
        a: "hsl(" + hue + " 72% 48%)",
        b: "hsl(" + ((hue + 48) % 360) + " 68% 62%)",
        c: "hsl(" + ((hue + 180) % 360) + " 58% 56%)",
        soft: "hsl(" + hue + " 72% 48% / 0.16)",
        wash: "hsl(" + hue + " 72% 48% / 0.11)",
      };
    }
    function repoStyle(path) {
      const color = repoColor(repoName(path));
      return "--repo:" + color.a + ";--repo-soft:" + color.soft + ";--repo-wash:" + color.wash;
    }
    function signalForPath(path) {
      const lower = path.toLowerCase();
      const name = lower.split("/").at(-1) || lower;
      if (lower.includes("/.git/") || lower.endsWith("/.git") || name === ".gitignore" || name === ".gitattributes") return "git";
      if (name.includes("secret") || name === ".env" || name.startsWith(".env.") || lower.includes("/.env")) return "secret";
      if (name.endsWith(".log") || lower.includes("/logs/") || lower.includes("/.local/")) return "log";
      if (lower.includes("/dist/") || lower.includes("/build/") || lower.includes("/.astro/") || lower.includes("/public/artifacts/") || name.endsWith(".lock")) return "generated";
      if (name.endsWith(".toml") || name.endsWith(".json") || name.endsWith(".jsonc") || name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".config.ts") || name.endsWith(".config.js")) return "config";
      if (/\.(png|jpe?g|gif|webp|svg|mp3|wav|mp4|mov|bin|wasm)$/i.test(name)) return "asset";
      if (lower.startsWith(".context/") || lower.includes("/.context/")) return "context";
      return "source";
    }
    function visualPulse(repo, strength, kind = "modify", signal = "source") {
      const tone = repoTone(repo);
      const color = repoColor(repo);
      const x = innerWidth * (0.5 + tone.pan * 0.42);
      visualEvents.push({ repo, kind, signal, color, x, y: innerHeight * (0.24 + ((hashText(repo) >>> 6) % 52) / 100), t: performance.now(), strength: Math.min(5, strength), seed: hashText(repo) });
      while (visualEvents.length > 80) visualEvents.shift();
      if (visualOn) requestAnimationFrame(drawAmbient);
    }
    function seedAmbient(nextMode) {
      const repos = [...new Set([...seen.keys()].slice(0, 24).map(repoName))];
      if (!repos.length) repos.push(".context", "cloudshell", "deja", "living-artifact");
      for (let i = 0; i < Math.min(7, repos.length); i++) {
        setTimeout(() => visualPulse(repos[(i + nextMode) % repos.length], 1, "modify", "source"), i * 80);
      }
    }
    function drawAmbient(now) {
      if (!visualOn) return;
      if (now - lastFrame < 24) {
        requestAnimationFrame(drawAmbient);
        return;
      }
      lastFrame = now;
      paint.clearRect(0, 0, innerWidth, innerHeight);
      const bg = paint.createLinearGradient(0, 0, innerWidth, innerHeight);
      bg.addColorStop(0, "#f7f8f3");
      bg.addColorStop(0.52, "#eef5f3");
      bg.addColorStop(1, "#f6f2ea");
      paint.fillStyle = bg;
      paint.fillRect(0, 0, innerWidth, innerHeight);
      if (modes[mode] === "ripples") drawRipples(now);
      else if (modes[mode] === "radar") drawRadar(now);
      else drawWaves(now);
      for (let i = visualEvents.length - 1; i >= 0; i--) if (now - visualEvents[i].t > 4200) visualEvents.splice(i, 1);
      requestAnimationFrame(drawAmbient);
    }
    function drawRipples(now) {
      for (const event of visualEvents) {
        const age = Math.max(0, (now - event.t) / 1000);
        const alpha = Math.max(0, 1 - age / 3.6);
        for (let i = 0; i < 3; i++) {
          const r = (age * 115 + i * 34) * (0.7 + event.strength * 0.08);
          paint.beginPath();
          paint.arc(event.x, event.y, r, 0, Math.PI * 2);
          paint.strokeStyle = (event.kind === "delete" ? event.color.c : event.color.a).replace(")", " / " + (alpha * (0.23 - i * 0.045)) + ")");
          paint.lineWidth = 1.8 + event.strength * 0.55;
          paint.stroke();
        }
        paint.beginPath();
        paint.arc(event.x, event.y, event.kind === "burst" ? 12 + event.strength * 3 : event.kind === "delete" ? Math.max(2, 7 - age * 2) : 5 + event.strength * 2, 0, Math.PI * 2);
        paint.fillStyle = (event.signal === "secret" ? event.color.c : event.color.b).replace(")", " / " + (alpha * (event.signal === "generated" ? 0.18 : 0.34)) + ")");
        paint.fill();
      }
    }
    function drawRadar(now) {
      const cx = innerWidth * 0.5;
      const cy = innerHeight * 0.52;
      const maxR = Math.min(innerWidth, innerHeight) * 0.42;
      const sweep = (now * 0.00042) % (Math.PI * 2);
      paint.save();
      paint.translate(cx, cy);
      for (let i = 1; i <= 5; i++) {
        paint.beginPath();
        paint.arc(0, 0, maxR * i / 5, 0, Math.PI * 2);
        paint.strokeStyle = "hsl(205 24% 52% / " + (0.05 + i * 0.012) + ")";
        paint.lineWidth = 1;
        paint.stroke();
      }
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        paint.beginPath();
        paint.moveTo(Math.cos(a) * maxR * 0.18, Math.sin(a) * maxR * 0.18);
        paint.lineTo(Math.cos(a) * maxR, Math.sin(a) * maxR);
        paint.strokeStyle = "hsl(205 24% 52% / 0.035)";
        paint.stroke();
      }
      const sweepGradient = paint.createRadialGradient(0, 0, 0, 0, 0, maxR);
      sweepGradient.addColorStop(0, "hsl(185 70% 55% / 0.22)");
      sweepGradient.addColorStop(1, "hsl(185 70% 55% / 0)");
      paint.beginPath();
      paint.moveTo(0, 0);
      paint.arc(0, 0, maxR, sweep - 0.36, sweep);
      paint.closePath();
      paint.fillStyle = sweepGradient;
      paint.fill();
      paint.beginPath();
      paint.moveTo(0, 0);
      paint.lineTo(Math.cos(sweep) * maxR, Math.sin(sweep) * maxR);
      paint.strokeStyle = "hsl(185 70% 45% / 0.34)";
      paint.lineWidth = 1.5;
      paint.stroke();
      paint.restore();
      for (const event of visualEvents) {
        const age = Math.max(0, (now - event.t) / 1000);
        const alpha = Math.max(0, 1 - age / 3.2);
        const hashAngle = ((event.seed % 6283) / 1000);
        const range = maxR * (0.26 + ((event.seed >>> 12) % 62) / 100);
        const x = cx + Math.cos(hashAngle) * range;
        const y = cy + Math.sin(hashAngle) * range;
        const pulse = 1 + Math.sin(now * 0.009 + event.seed) * 0.18;
        paint.beginPath();
        paint.arc(x, y, (event.kind === "burst" ? 14 + event.strength * 3 : event.signal === "log" ? 4 : event.kind === "delete" ? 5 : 7 + event.strength * 2.2) * pulse, 0, Math.PI * 2);
        paint.fillStyle = (event.kind === "delete" ? event.color.c : event.color.a).replace(")", " / " + (alpha * 0.24) + ")");
        paint.fill();
        paint.beginPath();
        paint.arc(x, y, (20 + age * 42) * pulse, 0, Math.PI * 2);
        paint.strokeStyle = (event.kind === "create" ? event.color.b : event.color.c).replace(")", " / " + (alpha * 0.22) + ")");
        paint.lineWidth = 1.4;
        paint.stroke();
        paint.beginPath();
        paint.moveTo(cx, cy);
        paint.lineTo(x, y);
        paint.strokeStyle = event.color.a.replace(")", " / " + (alpha * 0.055) + ")");
        paint.lineWidth = 1;
        paint.stroke();
      }
    }
    function drawWaves(now) {
      paint.lineCap = "round";
      for (const event of visualEvents) {
        const age = Math.max(0, (now - event.t) / 1000);
        const alpha = Math.max(0, 1 - age / 3.4);
        for (let band = 0; band < 4; band++) {
          paint.beginPath();
          for (let x = -20; x <= innerWidth + 20; x += 18) {
            const distance = Math.abs(x - event.x) / innerWidth;
            const amp = (34 + event.strength * 10) * Math.max(0, 1 - distance * 1.5) * alpha;
            const y = innerHeight * (0.45 + band * 0.075) + Math.sin(x * 0.014 + age * 3.8 + band) * amp;
            if (x === -20) paint.moveTo(x, y); else paint.lineTo(x, y);
          }
          paint.strokeStyle = (band % 2 ? event.color.c : event.color.a).replace(")", " / " + (alpha * 0.16) + ")");
          paint.lineWidth = 1.4 + event.strength * 0.2;
          paint.stroke();
        }
      }
    }
    function note(ctx, destination, tone, at, frequency, volume, duration) {
      const gain = ctx.createGain();
      const osc = ctx.createOscillator();
      const extra = ctx.createOscillator();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(volume, at + 0.014);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.frequency.setValueAtTime(frequency, at);
      osc.frequency.exponentialRampToValueAtTime(frequency * 1.08, at + duration * 0.45);
      extra.frequency.setValueAtTime(tone.overtone * (frequency / tone.base), at + 0.018);
      osc.type = "sine";
      extra.type = tone.wave;
      extra.detune.setValueAtTime(tone.detune, at);
      osc.connect(gain);
      extra.connect(gain);
      gain.connect(destination);
      osc.start(at);
      extra.start(at + 0.018);
      osc.stop(at + duration);
      extra.stop(at + duration * 0.78);
    }
    function chime(repo, strength, kind = "modify", signal = "source") {
      if (firstRender || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const now = Date.now();
      if (now - lastChime < 420) return;
      lastChime = now;
      recentHits.push(now);
      while (recentHits.length && now - recentHits[0] > 3500) recentHits.shift();
      visualPulse(repo, strength, kind, signal);
      try {
        const ctx = audioContext();
        if (ctx.state !== "running") {
          ctx.resume().then(() => playChime(ctx, repo, strength, kind, signal)).catch(() => {});
          return;
        }
        playChime(ctx, repo, strength, kind, signal);
      } catch {}
    }
    function playChime(ctx, repo, strength, kind, signal) {
      try {
        const tone = repoTone(repo);
        const t = ctx.currentTime;
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        const destination = pan || ctx.destination;
        if (pan) {
          pan.pan.setValueAtTime(tone.pan, t);
          pan.connect(ctx.destination);
        }
        const density = Math.min(4, recentHits.length);
        const drops = kind === "burst" ? 4 : signal === "log" || signal === "generated" ? 1 : Math.min(4, Math.max(1, strength));
        const volume = Math.min(signal === "generated" ? 0.016 : signal === "log" ? 0.012 : 0.027, 0.012 + density * 0.0025);
        const pattern = kind === "burst"
          ? [tone.base * 0.75, tone.base, tone.high, tone.high * 1.28]
          : signal === "secret"
          ? [tone.base * 0.5, tone.high * 1.5]
          : signal === "generated"
            ? [tone.overtone * 0.72]
            : kind === "delete"
          ? [tone.high * 0.82, tone.base * 0.72]
          : kind === "create"
            ? [tone.base * 0.92, tone.high, tone.high * 1.22]
            : [tone.base, tone.high, tone.base * 1.5, tone.high * 1.125];
        for (let i = 0; i < drops; i++) {
          note(ctx, destination, tone, t + i * 0.055, pattern[i % pattern.length], volume * (1 - i * 0.12), kind === "delete" || signal === "secret" ? 0.22 : 0.16);
        }
      } catch {}
    }
    function age(ms) {
      const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      if (h < 48) return h + "h";
      const d = Math.floor(h / 24);
      return d + "d";
    }
    function projectsFromFiles(files) {
      const projects = new Map();
      for (const file of files) {
        const repo = repoName(file.path);
        const signal = file.signal || signalForPath(file.path);
        let project = projects.get(repo);
        if (!project) {
          project = { repo, latest: file.mtime, latestIso: file.mtimeIso, files: 0, size: 0, signals: {}, paths: [], activity: Array(12).fill(0) };
          projects.set(repo, project);
        }
        project.files++;
        project.size += file.size || 0;
        project.signals[signal] = (project.signals[signal] || 0) + 1;
        if (project.paths.length < 3) project.paths.push(file.path);
        if (file.mtime > project.latest) {
          project.latest = file.mtime;
          project.latestIso = file.mtimeIso;
        }
        const minutes = Math.max(0, Math.floor((Date.now() - file.mtime) / 60000));
        const bucket = Math.min(11, Math.floor(minutes / 10));
        project.activity[bucket]++;
      }
      return [...projects.values()].sort((a, b) => b.latest - a.latest);
    }
    function renderProjects(data) {
      const projects = Array.isArray(data.projects) ? data.projects : projectsFromFiles(data.files);
      document.getElementById("count").textContent = projects.length + " projects";
      document.getElementById("head").innerHTML = "<tr><th>Last Active</th><th>Project</th><th>Files</th></tr>";
      document.getElementById("files").innerHTML = projects.map((project, i) => {
        const color = repoColor(project.repo);
        const dominant = Object.entries(project.signals).sort((a, b) => b[1] - a[1])[0]?.[0] || "source";
        const max = Math.max(1, ...project.activity);
        const bars = project.activity.map((count, index) => '<i class="' + (index < 3 ? 'hotbar' : '') + '" style="height:' + Math.max(3, Math.round(18 * count / max)) + 'px"></i>').join("");
        return '<tr style="--repo:' + color.a + ';--repo-soft:' + color.soft + ';--repo-wash:' + color.wash + '" class="' + dominant + ' ' + (i < 8 ? 'hot ' : '') + '"><td class="age">' + age(project.latest) + ' ago<br><span class="muted">' + fmt.format(new Date(project.latestIso)) + '</span></td><td><div class="project-name">' + project.repo + '</div><div class="muted">' + project.paths.join(" · ") + '</div></td><td><div>' + project.files + '</div><div class="spark">' + bars + '</div></td></tr>';
      }).join("");
    }
    async function render(data, preserveEffects = false) {
      lastData = data;
      const changed = new Set();
      const changedRepos = new Map();
      const eventList = Array.isArray(data.events) ? data.events : [];
      const now = Date.now();
      for (const event of eventList) {
        if (event.kind === "delete") deletedRows.set(event.path, { ...event, expiresAt: now + 5500 });
        const signal = event.signal || "source";
        const key = event.repo + ":" + event.kind + ":" + signal;
        changedRepos.set(key, { repo: event.repo, kind: event.kind, signal, count: Math.max(event.count || 1, (changedRepos.get(key)?.count || 0) + 1) });
      }
      for (const file of data.files) {
        const previous = seen.get(file.path);
        if (!firstRender && previous !== undefined && previous !== file.mtimeIso) {
          changed.add(file.path);
          const repo = repoName(file.path);
          if (!eventList.length) {
            const key = repo + ":modify";
            changedRepos.set(key, { repo, kind: "modify", signal: "source", count: (changedRepos.get(key)?.count || 0) + 1 });
          }
        }
        seen.set(file.path, file.mtimeIso);
      }
      for (const [path, event] of deletedRows) if (event.expiresAt < now) deletedRows.delete(path);
      if (!preserveEffects && changedRepos.size) {
        let offset = 0;
        for (const event of changedRepos.values()) setTimeout(() => chime(event.repo, event.count, event.kind, event.signal), offset++ * 85);
      }
      if (projectView) {
        renderProjects(data);
        firstRender = false;
        return;
      }
      document.getElementById("count").textContent = data.files.length + " recent files";
      document.getElementById("head").innerHTML = "<tr><th>Updated</th><th>File</th><th>Size</th></tr>";
      document.getElementById("updated").textContent = fmt.format(new Date(data.generatedAt));
      const deleted = [...deletedRows.values()].map((event) => ({ path: event.path, signal: event.signal, mtimeIso: event.mtimeIso, size: event.previousSize || 0, deleted: true }));
      const rows = [...deleted, ...data.files].slice(0, 240);
      document.getElementById("files").innerHTML = rows.map((file, i) => {
        const ms = Date.parse(file.mtimeIso);
        const signal = file.signal || signalForPath(file.path);
        return '<tr style="' + repoStyle(file.path) + '" class="' + signal + ' ' + (i < 8 ? 'hot ' : '') + (changed.has(file.path) || file.deleted ? 'pulse ' : '') + (file.deleted ? 'deleted' : '') + '"><td class="age">' + age(ms) + ' ago<br><span class="muted">' + fmt.format(new Date(ms)) + '</span></td><td class="path">' + file.path + '</td><td class="muted">' + Math.round(file.size / 1024) + ' KB</td></tr>';
      }).join("");
      firstRender = false;
    }
    async function tick() {
      const res = await fetch("/api/recent-files", { cache: "no-store" });
      render(await res.json());
    }
    tick();
    const events = new EventSource("/api/recent-files/events");
    events.addEventListener("activity", (event) => render(JSON.parse(event.data)));
    events.onerror = () => setTimeout(tick, 1500);
  </script>
</body>
</html>`;
}
function orbHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Machine Orb</title>
  <style>
    html, body { margin:0; width:100%; height:100%; overflow:hidden; background:#67b6dc; }
    canvas { display:block; width:100vw; height:100vh; }
  </style>
</head>
<body>
  <script type="module">
    import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x5baed7);
    scene.fog = new THREE.Fog(0x5baed7, 7.5, 14);

    const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.1, 100);
    camera.position.set(0.08, 0.06, 7.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    document.body.appendChild(renderer.domElement);

    const group = new THREE.Group();
    group.rotation.set(-0.18, -0.28, 0.12);
    scene.add(group);

    const clock = new THREE.Clock();
    const pulse = { value: 0 };

    function superellipsoidGeometry(width, height, depth, nu, nv, power) {
      const positions = [];
      const normals = [];
      const uCount = 96;
      const vCount = 48;
      const signedPow = (value, p) => Math.sign(value) * Math.pow(Math.abs(value), p);
      for (let y = 0; y <= vCount; y++) {
        const v = -Math.PI / 2 + Math.PI * y / vCount;
        for (let x = 0; x <= uCount; x++) {
          const u = -Math.PI + Math.PI * 2 * x / uCount;
          const cu = Math.cos(u), su = Math.sin(u);
          const cv = Math.cos(v), sv = Math.sin(v);
          const px = width * signedPow(cv, power) * signedPow(cu, power);
          const py = height * signedPow(sv, power);
          const pz = depth * signedPow(cv, power) * signedPow(su, power);
          positions.push(px, py, pz);
          normals.push(px / width, py / height, pz / depth);
        }
      }
      const indices = [];
      for (let y = 0; y < vCount; y++) {
        for (let x = 0; x < uCount; x++) {
          const a = y * (uCount + 1) + x;
          const b = a + 1;
          const c = a + (uCount + 1);
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }

    const shellGeo = superellipsoidGeometry(2.2, 2.05, 0.68, 96, 48, 0.36);
    const shellMat = new THREE.MeshPhysicalMaterial({
      color: 0xd7f4ff,
      metalness: 0,
      roughness: 0.02,
      transmission: 0.88,
      thickness: 1.15,
      ior: 1.42,
      transparent: true,
      opacity: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      attenuationColor: 0xff5d18,
      attenuationDistance: 1.35,
      side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.scale.set(1.18, 1.04, 1.02);
    shell.material.depthWrite = false;
    shell.renderOrder = 4;
    group.add(shell);

    const coreUniforms = { time: { value: 0 }, pulse: pulse };
    const coreMat = new THREE.ShaderMaterial({
      uniforms: coreUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      vertexShader: "varying vec2 vUv; varying vec3 vPos; void main(){ vUv=uv; vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "varying vec2 vUv;",
        "varying vec3 vPos;",
        "float softBox(vec2 p, vec2 b, float r){ vec2 q=abs(p)-b+r; return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r; }",
        "void main(){",
        "  vec2 p=vUv*2.0-1.0;",
        "  p.x*=1.18;",
        "  float d=softBox(p, vec2(0.82,0.72), 0.34);",
        "  float mask=smoothstep(0.05,-0.08,d);",
        "  float heat=smoothstep(-0.75,0.88,p.x+p.y*0.18+sin(time*0.38+p.y*2.4)*0.08);",
        "  vec3 yellow=vec3(1.0,0.86,0.08);",
        "  vec3 orange=vec3(1.0,0.37,0.0);",
        "  vec3 red=vec3(0.78,0.0,0.03);",
        "  vec3 col=mix(yellow,orange,heat);",
        "  col=mix(col,red,smoothstep(0.2,1.0,p.x+p.y*0.12));",
        "  float glow=0.22+0.18*sin(time+p.x*5.0)+pulse*0.3;",
        "  gl_FragColor=vec4(col+glow, mask*0.96);",
        "}"
      ].join("\\n"),
    });
    const core = new THREE.Mesh(new THREE.PlaneGeometry(3.55, 3.05, 80, 80), coreMat);
    core.position.set(-0.08, -0.2, 0.08);
    core.rotation.z = -0.08;
    core.renderOrder = 1;
    group.add(core);

    function makeRibbon(radius, tube, color, opacity, scaleX, scaleY, z, rot) {
      const geo = new THREE.TorusGeometry(radius, tube, 22, 220);
      const mat = new THREE.MeshPhysicalMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.25,
        metalness: 0.0,
        roughness: 0.04,
        transmission: 0.28,
        thickness: 0.7,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(scaleX, scaleY, 0.16);
      mesh.position.z = z;
      mesh.rotation.set(0.06, -0.08, rot);
      mesh.material.depthWrite = false;
      mesh.renderOrder = 2;
      group.add(mesh);
      return mesh;
    }

    const ribbons = [
      makeRibbon(1.72, 0.085, 0xff2500, 0.66, 1.23, 0.94, 0.12, -0.16),
      makeRibbon(1.92, 0.045, 0xffd719, 0.75, 1.18, 0.98, 0.21, -0.20),
      makeRibbon(2.02, 0.035, 0x0b2442, 0.72, 1.12, 1.02, 0.27, -0.22),
      makeRibbon(2.16, 0.025, 0x7bd7ff, 0.82, 1.08, 1.04, 0.31, -0.23),
    ];

    const bubbleGroup = new THREE.Group();
    group.add(bubbleGroup);
    const bubbleMat = new THREE.MeshPhysicalMaterial({
      color: 0xfff2b5,
      emissive: 0xff8c00,
      emissiveIntensity: 0.35,
      roughness: 0.01,
      metalness: 0,
      transmission: 0.58,
      thickness: 0.55,
      transparent: true,
      opacity: 0.78,
    });
    const bubbleGeo = new THREE.SphereGeometry(1, 24, 16);
    const bubbles = [];
    for (let i = 0; i < 34; i++) {
      const b = new THREE.Mesh(bubbleGeo, bubbleMat.clone());
      const band = i / 33;
      const x = -1.25 + Math.sin(i * 12.989) * 0.55 + band * 2.25;
      const y = -1.1 + Math.sin(i * 4.27) * 1.28;
      const z = 0.33 + Math.cos(i * 3.1) * 0.12;
      const s = 0.022 + Math.pow((i * 37) % 19 / 19, 2.2) * 0.075;
      b.position.set(x, y, z);
      b.scale.setScalar(s);
      b.userData = { x, y, z, phase: i * 0.73, scale: s };
      bubbleGroup.add(b);
      bubbles.push(b);
    }

    const glints = new THREE.Group();
    group.add(glints);
    const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.58 });
    for (let i = 0; i < 18; i++) {
      const g = new THREE.Mesh(new THREE.SphereGeometry(0.025 + (i % 4) * 0.01, 14, 8), glintMat.clone());
      g.position.set(-1.7 + Math.sin(i * 1.9) * 0.38 + i * 0.12, 0.45 + Math.cos(i * 0.8) * 0.5, 0.86 + Math.sin(i) * 0.04);
      g.renderOrder = 5;
      glints.add(g);
    }

    scene.add(new THREE.HemisphereLight(0xbbeeff, 0xff4a00, 2.7));
    const key = new THREE.DirectionalLight(0xffffff, 4.2);
    key.position.set(-3.4, 3.0, 5.5);
    scene.add(key);
    const red = new THREE.PointLight(0xff2600, 28, 8);
    red.position.set(1.6, 0.9, 2.4);
    scene.add(red);
    const gold = new THREE.PointLight(0xffd41d, 22, 8);
    gold.position.set(-1.4, -1.1, 2.8);
    scene.add(gold);
    const cyan = new THREE.PointLight(0x56d8ff, 12, 7);
    cyan.position.set(-2.2, 1.2, 2.6);
    scene.add(cyan);

    function machinePulse(strength) {
      pulse.value = Math.min(2.4, pulse.value + 0.32 * Math.max(1, strength || 1));
    }
    try {
      const events = new EventSource("/api/recent-files/events");
      events.addEventListener("activity", (event) => {
        try {
          const data = JSON.parse(event.data);
          const count = Array.isArray(data.events) ? data.events.reduce((n, item) => n + (item.count || 1), 0) : 1;
          if (data.events && data.events.length) machinePulse(Math.min(8, count));
        } catch {}
      });
    } catch {}

    addEventListener("pointerdown", () => machinePulse(2));

    function resize() {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    }
    addEventListener("resize", resize);

    function animate() {
      const t = clock.getElapsedTime();
      pulse.value *= 0.93;
      coreUniforms.time.value = t;
      group.rotation.y = -0.28 + Math.sin(t * 0.23) * 0.08 + pulse.value * 0.018;
      group.rotation.x = -0.18 + Math.sin(t * 0.19) * 0.045;
      group.rotation.z = 0.12 + Math.sin(t * 0.13) * 0.03;
      shell.scale.set(1.18 + pulse.value * 0.018, 1.04 + pulse.value * 0.012, 1.02 + pulse.value * 0.02);
      ribbons.forEach((r, i) => {
        r.rotation.z += 0.0009 * (i + 1);
        r.material.emissiveIntensity = 0.22 + pulse.value * 0.16 + Math.sin(t * 0.8 + i) * 0.05;
      });
      bubbles.forEach((b, i) => {
        const u = b.userData;
        b.position.x = u.x + Math.sin(t * 0.36 + u.phase) * 0.035;
        b.position.y = u.y + Math.sin(t * 0.52 + u.phase) * 0.045 + pulse.value * 0.01;
        b.scale.setScalar(u.scale * (1 + Math.sin(t * 1.2 + u.phase) * 0.18 + pulse.value * 0.08));
        b.material.emissiveIntensity = 0.28 + pulse.value * 0.2;
      });
      glints.children.forEach((g, i) => {
        g.material.opacity = 0.28 + Math.max(0, Math.sin(t * 1.1 + i)) * 0.38 + pulse.value * 0.08;
      });
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    }
    animate();
  </script>
</body>
</html>`;
}
function readStatic(pathname: string) {
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/dashboard.html") pathname = "/index.html";
  if (pathname === "/dashboard.json") {
    const p = join(DIR, "dashboard.json");
    return existsSync(p) ? { p, data: readFileSync(p) } : null;
  }
  const p = normalize(join(DIST, pathname));
  if (!p.startsWith(DIST) || !existsSync(p)) return null;
  return { p, data: readFileSync(p) };
}

for (const p of [join(ROOT, ".context/workers"), join(ROOT, ".context/runs"), join(DIR, "src"), join(DIR, "server.ts"), join(DIR, "build-dashboard.ts")]) {
  try { watch(p, { recursive: true }, schedule); } catch {}
}
indexRecentFiles();
try {
  watch(ROOT, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const path = join(ROOT, String(filename));
    indexProjectRoot(path);
    indexOneFile(path);
  });
} catch {}
rebuild();

Bun.serve({
  hostname: HOST,
  port: PORT,
  websocket: {
    open(ws) { clients.add(ws); ws.send(lastState); },
    close(ws) { clients.delete(ws); },
    message(ws, msg) { try { if (JSON.parse(String(msg)).type === "refresh") rebuild(); } catch {} },
  },
  async fetch(req, server) {
    if (!allowed(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/ws") return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    if (url.pathname === "/watch") return new Response(watchHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/orb") return new Response(orbHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/api/recent-files") return new Response(recentFilesJsonString(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (url.pathname === "/api/recent-files/events") {
      let activityController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          activityController = controller;
          activityClients.add(controller);
          controller.enqueue(`event: activity\ndata: ${activityPayload()}\n\n`);
        },
        cancel() {
          if (activityController) activityClients.delete(activityController);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "connection": "keep-alive" } });
    }
    if (url.pathname === "/api/token") return new Response(JSON.stringify({ token: token() }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (url.pathname === "/api/rebuild") { rebuild(); return new Response(lastState, { headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
    if (url.pathname === "/api/project-prompt") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!authed(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json().catch(() => ({})) as any;
      const project = String(body.project ?? "");
      const projectPath = projectPaths[project];
      if (!projectPath) return new Response(JSON.stringify({ error: "unknown project" }), { status: 400, headers: { "content-type": "application/json" } });
      const prompt = generatePrompt(project, projectPath);
      emit("dashboard.prompt", { project, promptChars: prompt.length });
      return new Response(JSON.stringify({ project, prompt }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/repo-brief") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!authed(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json().catch(() => ({})) as any;
      try {
        const prompt = generateRepoBrief(String(body.repo ?? ""));
        emit("dashboard.repo_brief", { repo: String(body.repo ?? ""), promptChars: prompt.length });
        return new Response(JSON.stringify({ repo: body.repo, prompt }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || "failed" }), { status: 400, headers: { "content-type": "application/json" } });
      }
    }
    if (url.pathname === "/api/machine/action") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!authed(req)) return new Response("unauthorized", { status: 401 });
      const body = await req.json().catch(() => ({})) as any;
      const action = String(body.action ?? "");
      const name = String(body.name ?? "portfolio-loop");
      let r;
      if (action === "start") {
        const objective = String(body.objective ?? "Run a durable multi-session read-only portfolio orchestration loop. Prioritize Cloudshell auth/access posture, Filepath worker-loop fit, and one next implementation task. Do not edit product repos, commit, deploy, or mutate external services. Use HANDOFF between phases and DONE only when complete.");
        r = rig(["start", name, "--background", "--objective", objective, "--max", String(body.max ?? 3)]);
      } else if (action === "stop") {
        r = rig(["stop", name]);
      } else if (action === "kill") {
        r = rig(["stop", name, "--kill"]);
      } else if (action === "resume") {
        r = rig(["resume", name, "--background", "--answer", String(body.answer ?? ""), "--max", String(body.max ?? 1)]);
      } else if (action === "dismiss") {
        const fs = await import("node:fs");
        const p = join(ROOT, ".context/workers", `${name}.json`);
        const st = JSON.parse(fs.readFileSync(p, "utf8"));
        st.status = "stopped"; st.question = null; st.currentActivity = "Question dismissed"; st.updated_at = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(st, null, 2) + "\n");
        r = { status: 0, stdout: JSON.stringify(st), stderr: "" } as any;
      } else return new Response("bad action", { status: 400 });
      emit("dashboard.action", { action, worker: name, code: r.status ?? 0 });
      rebuild();
      return new Response(JSON.stringify({ code: r.status ?? 0, stdout: r.stdout, stderr: r.stderr }), { headers: { "content-type": "application/json", "cache-control": "no-store" }, status: (r.status ?? 0) === 0 ? 200 : 500 });
    }
    const got = readStatic(decodeURIComponent(url.pathname));
    if (!got) return new Response("not found", { status: 404 });
    return new Response(got.data, { headers: { "content-type": type(got.p), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
  },
});
console.log(`The Machine dashboard: http://${HOST}:${PORT}`);
setInterval(() => {}, 1 << 30);
