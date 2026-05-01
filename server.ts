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
const activityByPath = new Map<string, ActivityFile>();
let activityCache = JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, files: [] });
let activityDirty = true;
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
      indexRecentFiles(path, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    indexOneFile(path, false);
  }
}
function indexOneFile(path: string, notify = true) {
  const relPath = relative(ROOT, path);
  if (!relPath || relPath.startsWith("..") || shouldIgnoreRecentPath(relPath)) return;
  try {
    const st = statSync(path);
    if (!st.isFile()) return;
    activityByPath.set(relPath, { path: relPath, mtime: st.mtimeMs, mtimeIso: new Date(st.mtimeMs).toISOString(), size: st.size });
  } catch {
    activityByPath.delete(relPath);
  }
  activityDirty = true;
  if (notify) broadcastActivity();
}
function recentFilesJsonString() {
  if (!activityDirty) return activityCache;
  const files = [...activityByPath.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 240);
  activityCache = JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, files }, null, 2);
  activityDirty = false;
  return activityCache;
}
function broadcastActivity() {
  const data = `event: activity\ndata: ${JSON.stringify(JSON.parse(recentFilesJsonString()))}\n\n`;
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
    .meta { display:grid; grid-template-columns: 180px 1fr 120px; gap:8px; margin-bottom:8px; color:var(--muted); font-size:12px; }
    table { width:100%; border-collapse:collapse; background:var(--paper); border:1px solid var(--line); }
    th, td { padding:7px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:0; background:#f9fafb; z-index:1; color:var(--muted); font-size:11px; text-transform:uppercase; }
    tr.hot td:first-child { border-left:3px solid var(--hot); }
    tr.pulse { animation:file-pulse 1200ms ease-out both; }
    tr.pulse td { animation:cell-pulse 1200ms ease-out both; }
    .path { font-weight:750; overflow-wrap:anywhere; }
    .muted { color:var(--muted); }
    .age { white-space:nowrap; font-variant-numeric:tabular-nums; }
    @keyframes file-pulse {
      0% { transform:translateY(-1px); }
      35% { transform:translateY(0); }
      100% { transform:translateY(0); }
    }
    @keyframes cell-pulse {
      0% { background:var(--glow); }
      100% { background:transparent; }
    }
    @media (prefers-reduced-motion: reduce) {
      tr.pulse, tr.pulse td { animation:none; }
    }
  </style>
</head>
<body>
  <main>
    <div class="meta"><div id="count">loading</div><div>${ROOT}</div><div id="updated"></div></div>
    <table>
      <thead><tr><th>Updated</th><th>File</th><th>Size</th></tr></thead>
      <tbody id="files"><tr><td colspan="3">loading</td></tr></tbody>
    </table>
  </main>
  <script>
    const fmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    const seen = new Map();
    let firstRender = true;
    let audio;
    let lastChime = 0;
    function audioContext() {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      return audio;
    }
    async function wakeAudio() {
      try {
        const ctx = audioContext();
        if (ctx.state !== "running") await ctx.resume();
      } catch {}
    }
    addEventListener("pointerdown", wakeAudio, { once: true });
    addEventListener("keydown", wakeAudio, { once: true });
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
        wave: (hash & 1) ? "triangle" : "sine",
      };
    }
    function chime(repo, strength) {
      if (firstRender || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const now = Date.now();
      if (now - lastChime < 700) return;
      lastChime = now;
      try {
        const ctx = audioContext();
        if (ctx.state !== "running") return;
        const tone = repoTone(repo);
        const gain = ctx.createGain();
        const osc = ctx.createOscillator();
        const extra = ctx.createOscillator();
        const t = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(Math.min(0.035, 0.014 + strength * 0.004), t + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.frequency.setValueAtTime(tone.base, t);
        osc.frequency.exponentialRampToValueAtTime(tone.high, t + 0.08);
        extra.frequency.setValueAtTime(tone.overtone, t + 0.025);
        osc.type = "sine";
        extra.type = tone.wave;
        extra.detune.setValueAtTime(tone.detune, t);
        osc.connect(gain);
        extra.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        extra.start(t + 0.02);
        osc.stop(t + 0.18);
        extra.stop(t + 0.14);
      } catch {}
    }
    function age(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return s + "s";
      const m = Math.round(s / 60);
      if (m < 60) return m + "m";
      const h = Math.round(m / 60);
      return h + "h";
    }
    async function render(data) {
      const changed = new Set();
      let changedRepo = "";
      for (const file of data.files) {
        const previous = seen.get(file.path);
        if (!firstRender && previous !== undefined && previous !== file.mtimeIso) {
          changed.add(file.path);
          if (!changedRepo) changedRepo = repoName(file.path);
        }
        seen.set(file.path, file.mtimeIso);
      }
      if (changed.size) chime(changedRepo, changed.size);
      document.getElementById("count").textContent = data.files.length + " recent files";
      document.getElementById("updated").textContent = fmt.format(new Date(data.generatedAt));
      document.getElementById("files").innerHTML = data.files.map((file, i) => {
        const ms = Date.parse(file.mtimeIso);
        return '<tr class="' + (i < 8 ? 'hot ' : '') + (changed.has(file.path) ? 'pulse' : '') + '"><td class="age">' + age(ms) + ' ago<br><span class="muted">' + fmt.format(new Date(ms)) + '</span></td><td class="path">' + file.path + '</td><td class="muted">' + Math.round(file.size / 1024) + ' KB</td></tr>';
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
    indexOneFile(join(ROOT, String(filename)));
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
    if (url.pathname === "/api/recent-files") return new Response(recentFilesJsonString(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (url.pathname === "/api/recent-files/events") {
      let activityController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          activityController = controller;
          activityClients.add(controller);
          controller.enqueue(`event: activity\ndata: ${JSON.stringify(JSON.parse(recentFilesJsonString()))}\n\n`);
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
