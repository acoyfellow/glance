#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./src/config";

const config = loadConfig(import.meta.url);
const ROOT = config.root;
const DIR = dirname(new URL(import.meta.url).pathname);
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
function type(path: string) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".task")) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}
function pwaHead(title = "Glance") {
  return `<link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#f4f6f8">
  <meta name="application-name" content="Glance">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Glance">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon.svg">
  <meta property="og:title" content="${title}">`;
}
function pwaScript() {
  return `<script>
    async function machineCheckForUpdate() {
      try {
        const res = await fetch("/api/app-version", { cache: "no-store" });
        const body = await res.json();
        const key = "glance-app-version";
        const previous = sessionStorage.getItem(key);
        if (previous && previous !== body.version) location.reload();
        sessionStorage.setItem(key, body.version);
      } catch {}
    }
    async function machineHardRefresh() {
      try { await fetch("/api/rebuild", { cache: "no-store" }); } catch {}
      try {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(async (reg) => {
            try { await reg.update(); } catch {}
            if (reg.active) reg.active.postMessage({ type: "CLEAR_CACHE" });
          }));
        }
      } catch {}
      try {
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.filter((key) => key.startsWith("glance-")).map((key) => caches.delete(key)));
        }
      } catch {}
      const url = new URL(location.href);
      url.searchParams.set("fresh", String(Date.now()));
      location.replace(url.toString());
    }
    window.machineHardRefresh = machineHardRefresh;
    if ("serviceWorker" in navigator) {
      addEventListener("load", async () => {
        try {
          const reg = await navigator.serviceWorker.register("/sw.js");
          await reg.update();
        } catch {}
        machineCheckForUpdate();
        setInterval(machineCheckForUpdate, 7000);
      });
    }
  </script>`;
}
function appVersionJson() {
  let serverMtime = 0;
  let builderMtime = 0;
  try { serverMtime = statSync(join(DIR, "server.ts")).mtimeMs; } catch {}
  try { builderMtime = statSync(join(DIR, "build-dashboard.ts")).mtimeMs; } catch {}
  return JSON.stringify({ version: `${Math.round(serverMtime)}.${Math.round(builderMtime)}`, generatedAt: new Date().toISOString() });
}
function manifestJson() {
  return JSON.stringify({
    name: "Glance",
    short_name: "Glance",
    description: "Local observation layer for repo, file, conversation, and ambient engineering signals.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f6f8",
    theme_color: "#f4f6f8",
    orientation: "any",
    categories: ["productivity", "developer", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
    ],
    shortcuts: [
      { name: "Watch", short_name: "Watch", url: "/", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] },
      { name: "Orb", short_name: "Orb", url: "/orb", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] },
    ],
  }, null, 2);
}
function serviceWorkerJs() {
  return `const CACHE = "glance-shell-v1";
const SHELL = ["/", "/orb", "/manifest.webmanifest", "/icon.svg"];
async function clearMachineCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith("glance-")).map((key) => caches.delete(key)));
}
self.addEventListener("install", (event) => {
  event.waitUntil(clearMachineCaches().then(() => caches.open(CACHE)).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(clearMachineCaches().then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_CACHE") event.waitUntil(clearMachineCaches().then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/dashboard.json" || url.pathname === "/ws" || url.pathname === "/" || url.pathname === "/watch" || url.pathname === "/orb") {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))));
});`;
}
function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="g" cx="38%" cy="28%" r="72%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset=".18" stop-color="#e8fbff"/>
      <stop offset=".44" stop-color="#5fc0e6"/>
      <stop offset=".7" stop-color="#ff8a1e"/>
      <stop offset="1" stop-color="#321b16"/>
    </radialGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#1f2933" flood-opacity=".24"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="112" fill="#f4f6f8"/>
  <circle cx="256" cy="256" r="164" fill="url(#g)" filter="url(#s)"/>
  <path d="M151 218c42-92 155-119 232-44" fill="none" stroke="#fff" stroke-opacity=".72" stroke-width="28" stroke-linecap="round"/>
  <path d="M166 333c68 63 170 58 231-5" fill="none" stroke="#381b12" stroke-opacity=".28" stroke-width="20" stroke-linecap="round"/>
</svg>`;
}
const recentFileIgnoreDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".svelte-kit", ".wrangler", ".turbo", ".alchemy", "coverage", ".cache", ".parcel-cache", ".vite", ".jest", ".nyc_output", ".yarn/cache", ".yarn/unplugged"]);
const recentFileIgnoreFiles = new Set([".DS_Store", "dashboard.json", "playwright.env", ".pnp.cjs", ".pnp.loader.mjs", "install-state.gz"]);
const recentFileIgnorePathParts = [
  "glance/data/",
  "glance/dist/",
  "glance/public/",
  "glance/dashboard.json",
  "glance/dashboard.html",
  ".yarn/cache/",
  ".yarn/install-state.gz",
  ".jest/",
  ".turbo/",
  ".next/cache/",
  "rspack/ssl/local-certs/",
];
type ActivityFile = { path: string; mtime: number; mtimeIso: string; size: number };
type ActivitySignal = "source" | "generated" | "log" | "config" | "secret" | "git" | "context" | "asset";
type ActivityEvent = { kind: "create" | "modify" | "delete" | "burst"; signal: ActivitySignal; path: string; repo: string; size: number; previousSize?: number; mtimeIso: string; count?: number };
type ProjectRoot = { repo: string; latest: number; latestIso: string };
const activityByPath = new Map<string, ActivityFile>();
const projectRoots = new Map<string, ProjectRoot>();
const burstWindows = new Map<string, number[]>();
const pendingActivityEvents = new Map<string, ActivityEvent>();
let activityCache = JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, files: [] });
let activityDirty = true;
let activityBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
function repoForPath(relPath: string) {
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
  return "source";
}
function shouldIgnoreRecentPath(relPath: string, name = relPath.split("/").at(-1) || relPath) {
  const lower = relPath.toLowerCase();
  const lowerName = name.toLowerCase();
  if (recentFileIgnoreFiles.has(name) || recentFileIgnoreFiles.has(lowerName)) return true;
  if (lowerName.endsWith(".pem") && lower.includes("/local-certs/")) return true;
  if (lowerName.endsWith(".map") && lower.includes("cache")) return true;
  if (lower.includes("cache/") || lower.includes("-cache-") || lower.includes("/cache/")) return true;
  if (recentFileIgnorePathParts.some((part) => relPath.startsWith(part) || lower.includes(part.toLowerCase()))) return true;
  return relPath.split("/").some((part) => recentFileIgnoreDirs.has(part) || recentFileIgnoreDirs.has(part.toLowerCase()));
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
  if (notify && event) queueActivity(event);
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
function queueActivity(event: ActivityEvent) {
  const events = withBurstEvent(event);
  for (const next of events) {
    const key = `${next.repo}:${next.signal}:${next.kind}`;
    const previous = pendingActivityEvents.get(key);
    if (previous) {
      pendingActivityEvents.set(key, {
        ...next,
        kind: previous.kind === "burst" || next.kind === "burst" ? "burst" : next.kind,
        count: (previous.count || 1) + (next.count || 1),
        size: Math.max(previous.size || 0, next.size || 0),
      });
    } else {
      pendingActivityEvents.set(key, { ...next, count: next.count || 1 });
    }
  }
  if (activityBroadcastTimer) return;
  activityBroadcastTimer = setTimeout(() => {
    activityBroadcastTimer = null;
    const compact = [...pendingActivityEvents.values()].slice(0, 12);
    pendingActivityEvents.clear();
    broadcastActivity(compact);
  }, 650);
}
function watchHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Glance</title>
  ${pwaHead("Glance")}
  <style>
    :root { color-scheme: light; --font-sans:"Avenir Next", Avenir, "Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --font-mono:"SF Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; --bg:#f4f6f8; --paper:#fff; --line:#d7dee5; --text:#1f2933; --muted:#667085; --hot:#155eef; --glow:#d7f7ea; }
    * { box-sizing:border-box; }
    body { margin:0; overflow-x:hidden; background:var(--bg); color:var(--text); font:13px/1.35 var(--font-sans); }
    main { width:min(100%, 1440px); margin:0 auto; padding:14px; }
    .meta { display:grid; grid-template-columns: 34px 34px minmax(140px,180px) minmax(0,1fr); gap:8px; margin-bottom:8px; color:var(--muted); font-size:12px; align-items:center; min-width:0; }
    .meta > * { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .tool-button { width:26px; height:26px; border:1px solid var(--line); border-radius:999px; cursor:pointer; box-shadow:0 1px 2px rgba(31,41,51,.12); }
    .machine-strip { display:grid; grid-template-columns: 38px minmax(190px,1.5fr) minmax(120px,.65fr) minmax(120px,.75fr) max-content; gap:6px; margin-bottom:8px; align-items:center; min-height:42px; padding:5px; background:rgba(255,255,255,.76); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 24px rgba(31,41,51,.05); }
    .machine-card { min-width:0; padding:0 8px; border-left:1px solid rgba(215,222,229,.72); }
    .machine-card:first-child { border-left:0; padding:0; display:flex; justify-content:center; }
    .machine-card span { display:block; color:var(--muted); font-size:9px; line-height:1; font-weight:500; letter-spacing:.08em; text-transform:uppercase; margin-bottom:3px; }
    .machine-card b { display:block; color:var(--text); font-size:12px; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .machine-card.activity b { white-space:nowrap; display:block; }
    .machine-card.observer span, .machine-card.observer b { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
    .observer-indicator { position:relative; display:block; width:18px; height:18px; border-radius:999px; background:#16a34a; box-shadow:0 0 0 4px rgba(22,163,74,.14); }
    .observer-indicator::before { content:""; position:absolute; inset:-5px; border:2px solid rgba(22,163,74,.24); border-top-color:#16a34a; border-radius:999px; animation:observer-spin 900ms linear infinite; }
    .observer-indicator::after { content:""; position:absolute; inset:5px; border-radius:999px; background:#fff; opacity:.86; }
    .machine-updated { min-width:0; padding:0 8px; border-left:1px solid rgba(215,222,229,.72); color:var(--muted); font-size:11px; font-weight:500; white-space:nowrap; }
    .page-nav { display:inline-flex; align-items:center; gap:4px; max-width:calc(100% - 42px); min-height:42px; margin-bottom:10px; padding:4px; overflow-x:auto; border:1px solid rgba(215,222,229,.92); border-radius:999px; background:rgba(255,255,255,.72); box-shadow:0 8px 24px rgba(31,41,51,.07); scrollbar-width:none; }
    .page-nav::-webkit-scrollbar { display:none; }
    .page-nav a { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; height:32px; border-radius:999px; color:#344054; padding:0 12px; font:500 12px/1 var(--font-sans); text-decoration:none; white-space:nowrap; }
    .page-nav a[aria-current="page"] { background:#1f2933; color:#fff; box-shadow:0 5px 14px rgba(31,41,51,.16); }
    .machine-question { display:none; margin:-2px 0 10px; background:#fff8e5; border:1px solid #edd28a; border-radius:8px; padding:10px; }
    .machine-question.is-open { display:block; }
    .machine-question b { display:block; margin-bottom:6px; color:#7a4d00; }
    .machine-question pre { margin:0 0 8px; max-height:170px; overflow:auto; white-space:pre-wrap; color:#3d2b00; font:12px/1.35 var(--font-sans); }
    .machine-question textarea { width:100%; min-height:72px; resize:vertical; border:1px solid #d7b55f; border-radius:6px; padding:8px; font:13px/1.35 var(--font-sans); }
    .machine-question .question-actions { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
    .machine-question button { border:1px solid var(--line); border-radius:6px; background:#fff; color:#344054; padding:7px 9px; font:500 12px/1 var(--font-sans); cursor:pointer; }
    .machine-question button.primary { background:#9a6700; border-color:#9a6700; color:#fff; }
    .machine-question small { display:block; margin-top:7px; color:#7a4d00; }
    .state-running { color:#177245 !important; }
    .state-waiting { color:#9a6700 !important; }
    .state-stopped { color:#667085 !important; }
    .fullscreen-toggle {
      position:fixed; top:14px; right:14px; z-index:35; background:rgba(255,255,255,.88);
    }
    .fullscreen-toggle::before, .fullscreen-toggle::after {
      content:""; position:absolute; width:8px; height:8px; border-color:#263746; border-style:solid;
    }
    .fullscreen-toggle::before { left:6px; top:6px; border-width:2px 0 0 2px; }
    .fullscreen-toggle::after { right:6px; bottom:6px; border-width:0 2px 2px 0; }
    body.is-fullscreen .fullscreen-toggle::before { left:8px; top:8px; border-width:0 2px 2px 0; }
    body.is-fullscreen .fullscreen-toggle::after { right:8px; bottom:8px; border-width:2px 0 0 2px; }
    body.is-fullscreen main { padding:0; }
    body.is-fullscreen .meta { padding:8px 14px; margin:0; background:rgba(244,246,248,.94); border-bottom:1px solid var(--line); }
    body.is-fullscreen table { border-left:0; border-right:0; border-bottom:0; }
    body.is-fullscreen .machine-strip { padding:8px 14px; margin:0; background:rgba(244,246,248,.94); border-bottom:1px solid var(--line); }
    a.tool-button { display:block; }
    .tool-button:focus-visible { outline:2px solid var(--hot); outline-offset:2px; }
    .project-toggle { background:linear-gradient(135deg, #ffffff 0 24%, #dbe7ef 25% 42%, #7aa6b8 43% 57%, #f2d27c 58% 75%, #ffffff 76% 100%); }
    body.project-view .project-toggle { box-shadow:0 0 0 3px rgba(122,166,184,.22), 0 1px 2px rgba(31,41,51,.12); }
    .source-pill { display:inline-flex; border-radius:999px; padding:3px 7px; background:var(--repo-wash); color:#344054; font-size:11px; font-weight:500; }
    table { width:100%; border-collapse:collapse; background:var(--paper); border:1px solid var(--line); table-layout:auto; }
    th, td { padding:7px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:0; background:#f9fafb; z-index:1; color:var(--muted); font-size:11px; text-transform:uppercase; }
    tr.hot td:first-child { border-left:3px solid var(--repo, var(--hot)); }
    tr.deleted td { color:var(--muted); text-decoration:line-through; text-decoration-thickness:1px; text-decoration-color:var(--repo); }
    tr.secret td { background:linear-gradient(90deg, var(--repo-wash), transparent 42%); }
    tr.generated .path { font-weight:400; }
    tr.log .path { color:#475467; }
    tr.pulse { animation:file-pulse 1200ms ease-out both; }
    tr.pulse td { animation:cell-pulse 1200ms ease-out both; }
    .path { font-weight:400; overflow-wrap:anywhere; }
    .path::before { content:""; display:inline-block; width:7px; height:7px; margin-right:8px; border-radius:50%; background:var(--repo, var(--hot)); box-shadow:0 0 0 3px var(--repo-soft, transparent); vertical-align:1px; }
    .project-name { font-weight:500; }
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
    @keyframes observer-spin {
      to { transform:rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      tr.pulse, tr.pulse td { animation:none; }
      .observer-indicator::before { animation:none; }
    }
    @media (max-width: 980px) {
      main { width:100%; }
      .machine-strip { grid-template-columns:38px minmax(160px,1fr) minmax(120px,.7fr) max-content; }
      .machine-card.focus { display:none; }
    }
    @media (max-width: 720px) {
      table, thead, tbody, tr, th, td { display:block; }
      thead { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
      table { border:0; background:transparent; }
      tr { margin-bottom:8px; overflow:hidden; border:1px solid var(--line); border-radius:8px; background:var(--paper); box-shadow:0 6px 18px rgba(31,41,51,.04); }
      tr.hot td:first-child { border-left:0; box-shadow:inset 3px 0 0 var(--repo, var(--hot)); }
      td { display:grid; grid-template-columns:minmax(76px,28%) minmax(0,1fr); gap:8px; padding:7px 9px; border-bottom:1px solid var(--line); }
      td:last-child { border-bottom:0; }
      td::before { content:attr(data-label); color:var(--muted); font-size:10px; font-weight:500; letter-spacing:.08em; text-transform:uppercase; }
      .spark { min-width:0; width:100%; }
    }
    @media (max-width: 560px) {
      main { padding:10px; }
      .fullscreen-toggle { top:10px; right:10px; }
      .page-nav { max-width:calc(100% - 38px); }
      .page-nav a { padding:0 11px; }
      .meta { grid-template-columns:34px 34px minmax(0,1fr); }
      .meta > div:nth-of-type(2) { display:none; }
      .machine-strip { grid-template-columns:34px minmax(0,1fr) max-content; }
      .machine-card.radar { display:none; }
      .machine-card.activity { border-left:0; }
      td { grid-template-columns:72px minmax(0,1fr); }
    }
    @media (max-width: 380px) {
      .meta { font-size:11px; }
    }
  </style>
</head>
<body>
  <button class="tool-button fullscreen-toggle" id="fullscreenToggle" type="button" aria-label="Toggle fullscreen"></button>
  <main>
    <nav class="page-nav" aria-label="Glance pages">
      <a href="/" aria-current="page">Watch</a>
      <a href="/orb">Orb</a>
    </nav>
    <div class="meta"><button class="tool-button project-toggle" id="projectToggle" type="button" aria-label="Toggle project recency"></button><div id="count">loading</div><div>${ROOT}</div></div>
    <section class="machine-strip" aria-live="polite">
      <div class="machine-card observer"><i class="observer-indicator" aria-hidden="true"></i><span>Observer</span><b id="machineState" class="state-running">loading</b></div>
      <div class="machine-card activity"><span>Latest Signal</span><b id="machineActivity">loading</b></div>
      <div class="machine-card radar"><span>Git Radar</span><b id="gitRadar">—</b></div>
      <div class="machine-card focus"><span>Focus</span><b id="gitFocus">—</b></div>
      <div class="machine-updated" id="updated">Updated —</div>
    </section>
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
    let pageTakeover = false;
    const fullscreenToggle = document.getElementById("fullscreenToggle");
    function syncFullscreenState() {
      const active = pageTakeover || Boolean(document.fullscreenElement);
      document.body.classList.toggle("is-fullscreen", active);
      fullscreenToggle.setAttribute("aria-pressed", active ? "true" : "false");
    }
    fullscreenToggle.addEventListener("click", async () => {
      const next = !(pageTakeover || document.fullscreenElement);
      pageTakeover = next;
      try {
        if (!next && document.fullscreenElement) await document.exitFullscreen();
        else if (next && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      } catch {}
      syncFullscreenState();
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && !pageTakeover) syncFullscreenState();
    });
    addEventListener("keydown", (event) => {
      if (event.key === "Escape" && pageTakeover) {
        pageTakeover = false;
        syncFullscreenState();
      }
    });
    document.getElementById("projectToggle").addEventListener("click", () => {
      projectView = !projectView;
      document.body.classList.toggle("project-view", projectView);
      if (lastData) render(lastData, true);
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
          const tone = repoTone("root");
          note(ctx, ctx.destination, tone, ctx.currentTime, tone.base * 0.7, 0.008, 0.09);
        }
      } catch {}
    }
    addEventListener("pointerdown", wakeAudio);
    addEventListener("keydown", wakeAudio);
    function repoName(path) {
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
          return "source";
    }
    function renderMachine(data) {
      const stateEl = document.getElementById("machineState");
      const activityEl = document.getElementById("machineActivity");
      stateEl.className = "state-running";
      stateEl.textContent = "Observing";
      const latestEvent = [...(data?.events || [])].reverse()[0];
      activityEl.textContent = latestEvent?.summary || latestEvent?.type || "watching local activity";
      document.getElementById("gitRadar").textContent = (data?.gitObserver?.repoCount || 0) + " repos · " + (data?.gitObserver?.attentionCount || 0) + " attention";
      document.getElementById("gitFocus").textContent = data?.gitObserver?.focus?.[0]?.path || "unknown";
    }
    async function loadMachine() {
      try {
        const res = await fetch("/dashboard.json", { cache: "no-store" });
        renderMachine(await res.json());
      } catch {
        document.getElementById("machineState").textContent = "offline";
        document.getElementById("machineActivity").textContent = "dashboard state unavailable";
      }
    }
    function visualPulse(repo, strength, kind = "modify", signal = "source") {
      // Watch stays feed-first now; Orb is the alternate ambient interface.
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
        return '<tr style="--repo:' + color.a + ';--repo-soft:' + color.soft + ';--repo-wash:' + color.wash + '" class="' + dominant + ' ' + (i < 8 ? 'hot ' : '') + '"><td class="age" data-label="Last Active">' + age(project.latest) + ' ago<br><span class="muted">' + fmt.format(new Date(project.latestIso)) + '</span></td><td data-label="Project"><div class="project-name">' + project.repo + '</div><div class="muted">' + project.paths.join(" · ") + '</div></td><td data-label="Files"><div>' + project.files + '</div><div class="spark">' + bars + '</div></td></tr>';
      }).join("");
    }
    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
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
      document.getElementById("updated").textContent = "Updated " + fmt.format(new Date(data.generatedAt));
      const deleted = [...deletedRows.values()].map((event) => ({ path: event.path, signal: event.signal, mtimeIso: event.mtimeIso, size: event.previousSize || 0, deleted: true }));
      const rows = [...deleted, ...data.files].slice(0, 240);
      document.getElementById("files").innerHTML = rows.map((file, i) => {
        const ms = Date.parse(file.mtimeIso);
        const signal = file.signal || signalForPath(file.path);
        return '<tr style="' + repoStyle(file.path) + '" class="' + signal + ' ' + (i < 8 ? 'hot ' : '') + (changed.has(file.path) || file.deleted ? 'pulse ' : '') + (file.deleted ? 'deleted' : '') + '"><td class="age" data-label="Updated">' + age(ms) + ' ago<br><span class="muted">' + fmt.format(new Date(ms)) + '</span></td><td class="path" data-label="File">' + file.path + '</td><td class="muted" data-label="Size">' + Math.round(file.size / 1024) + ' KB</td></tr>';
      }).join("");
      firstRender = false;
    }
    async function tick() {
      const res = await fetch("/api/recent-files", { cache: "no-store" });
      render(await res.json());
    }
    loadMachine();
    setInterval(loadMachine, 2500);
    tick();
    setInterval(tick, 5000);
    const events = new EventSource("/api/recent-files/events");
    events.addEventListener("activity", (event) => render(JSON.parse(event.data)));
    events.onerror = () => setTimeout(tick, 1500);
  </script>
  ${pwaScript()}
</body>
</html>`;
}
function orbHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Glance Orb</title>
  ${pwaHead("Glance Orb")}
  <style>
    :root { --font-sans:"Avenir Next", Avenir, "Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --font-mono:"SF Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; }
    * { box-sizing:border-box; }
    html, body { margin:0; width:100%; height:100%; overflow:hidden; background:#63b7dc; font-family:var(--font-sans); }
    body.buddy-mode { background:transparent; }
    body.buddy-mode::before {
      content:""; position:fixed; inset:8px; z-index:0; pointer-events:none;
      border:1px solid rgba(255,255,255,.22); border-radius:18px;
      background:radial-gradient(circle at 50% 55%, rgba(255,138,30,.055), rgba(80,170,210,.035) 46%, rgba(255,255,255,.02) 72%, rgba(255,255,255,.045));
      box-shadow:inset 0 0 32px rgba(255,255,255,.08), 0 0 0 1px rgba(20,52,79,.05);
    }
    body.buddy-mode .page-nav,
    body.buddy-mode .fullscreen-toggle,
    body.buddy-mode .vortex-toggle,
    body.buddy-mode .gesture-toggle {
      background:rgba(255,255,255,.68);
      box-shadow:0 8px 24px rgba(20,52,79,.18), 0 0 0 2px rgba(255,255,255,.16);
    }
    canvas { display:block; width:100vw; height:100vh; touch-action:none; }
    #memoryCanvas { position:fixed; inset:0; z-index:2; pointer-events:none; opacity:0; mix-blend-mode:screen; }
    .fullscreen-toggle {
      position:fixed; top:14px; right:14px; z-index:10; width:28px; height:28px;
      border:1px solid rgba(255,255,255,.68); border-radius:999px; cursor:pointer;
      background:rgba(255,255,255,.52); box-shadow:0 8px 22px rgba(20,52,79,.16);
      backdrop-filter:blur(12px);
    }
    .fullscreen-toggle::before, .fullscreen-toggle::after {
      content:""; position:absolute; width:8px; height:8px; border-color:#264257; border-style:solid;
    }
    .fullscreen-toggle::before { left:7px; top:7px; border-width:2px 0 0 2px; }
    .fullscreen-toggle::after { right:7px; bottom:7px; border-width:0 2px 2px 0; }
    body.is-fullscreen .fullscreen-toggle::before { left:9px; top:9px; border-width:0 2px 2px 0; }
    body.is-fullscreen .fullscreen-toggle::after { right:9px; bottom:9px; border-width:2px 0 0 2px; }
    body.is-fullscreen .page-nav { opacity:.62; }
    .fullscreen-toggle:focus-visible { outline:2px solid #fff; outline-offset:3px; }
    .page-nav {
      position:fixed; top:14px; left:14px; right:54px; z-index:10; display:inline-flex; width:max-content; max-width:calc(100vw - 68px); height:42px;
      align-items:center; gap:4px; padding:4px; overflow-x:auto; overscroll-behavior:contain; scrollbar-width:none;
      border:1px solid rgba(255,255,255,.68); border-radius:999px; background:rgba(255,255,255,.54);
      box-shadow:0 8px 22px rgba(20,52,79,.14); backdrop-filter:blur(12px); font:500 12px/1 var(--font-sans);
    }
    .page-nav::-webkit-scrollbar { display:none; }
    .page-nav a {
      flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; height:32px;
      color:#264257; text-decoration:none; padding:0 12px; border-radius:999px; white-space:nowrap;
    }
    .page-nav a[aria-current="page"] { background:rgba(32,57,78,.84); color:#fff; box-shadow:0 5px 14px rgba(20,52,79,.18); }
    .gesture-toggle {
      position:fixed; top:52px; right:14px; z-index:10; width:28px; height:28px;
      border:1px solid rgba(255,255,255,.68); border-radius:999px; cursor:pointer;
      color:#264257; font:500 16px/1 var(--font-sans); background:rgba(255,255,255,.52);
      box-shadow:0 8px 22px rgba(20,52,79,.16); backdrop-filter:blur(12px);
    }
    body.presence-armed .gesture-toggle { background:rgba(255,244,185,.72); box-shadow:0 0 0 3px rgba(255,230,98,.2), 0 8px 22px rgba(20,52,79,.16); }
    .gesture-toggle.is-following-head { background:rgba(196,239,255,.78); box-shadow:0 0 0 3px rgba(96,215,255,.22), 0 8px 22px rgba(20,52,79,.16); }
    .gesture-panel {
      position:fixed; top:88px; right:14px; z-index:12; width:min(328px, calc(100vw - 28px)); max-height:calc(100dvh - 112px); overflow:auto; padding:12px;
      color:#1c3448; background:rgba(255,255,255,.62); border:1px solid rgba(255,255,255,.7);
      border-radius:8px; box-shadow:0 18px 40px rgba(20,52,79,.18); backdrop-filter:blur(18px);
      font:12px/1.35 var(--font-sans); opacity:0; transform:translateY(-4px); pointer-events:none;
      transition:opacity 160ms ease, transform 160ms ease;
      overscroll-behavior:contain; -webkit-overflow-scrolling:touch; touch-action:auto;
    }
    .gesture-panel.is-open { opacity:1; transform:none; pointer-events:auto; }
    .gesture-panel b { display:block; margin-bottom:7px; font-size:12px; }
    .gesture-table { width:100%; border-collapse:collapse; }
    .gesture-table th, .gesture-table td { padding:6px 4px; border-top:1px solid rgba(32,57,78,.13); text-align:left; vertical-align:middle; }
    .gesture-table th { border-top:0; font-size:10px; text-transform:uppercase; letter-spacing:.04em; opacity:.62; }
    .gesture-table td:first-child { font-weight:500; white-space:nowrap; }
    .gesture-table td:nth-child(2) { opacity:.82; }
    .gesture-table input { width:16px; height:16px; accent-color:#ff8a1e; }
    .gesture-lab { margin-top:10px; padding-top:10px; border-top:1px solid rgba(32,57,78,.13); }
    .gesture-lab-row { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:7px 0; }
    .gesture-lab button {
      min-height:32px;
      border:1px solid rgba(255,255,255,.72); border-radius:999px; padding:7px 9px; cursor:pointer;
      color:#20394e; background:rgba(255,255,255,.54); font:500 12px/1 var(--font-sans);
    }
    .gesture-lab button:disabled { opacity:.42; cursor:default; }
    .gesture-lab-current { margin:8px 0; padding:8px; border-radius:8px; background:rgba(255,255,255,.34); }
    .gesture-lab-meter { height:5px; margin-top:6px; overflow:hidden; border-radius:999px; background:rgba(32,57,78,.12); }
    .gesture-lab-meter i { display:block; height:100%; width:0%; border-radius:999px; background:linear-gradient(90deg,#ff8a1e,#ffd52a); transition:width 90ms linear; }
    .gesture-signal-grid { display:grid; grid-template-columns:1fr 1fr; gap:4px 8px; margin-top:8px; font-size:11px; }
    .gesture-signal-grid span { display:flex; justify-content:space-between; gap:6px; }
    .gesture-results { max-height:260px; overflow:auto; margin-top:8px; border-top:1px solid rgba(32,57,78,.13); overscroll-behavior:contain; }
    .gesture-result { display:grid; grid-template-columns:18px 1fr 42px; gap:6px; padding:5px 0; border-bottom:1px solid rgba(32,57,78,.08); }
    .gesture-result.pass { color:#1e6a34; }
    .gesture-result.fail { color:#8a2b18; }
    .gesture-feedback {
      position:fixed; left:50%; bottom:24px; z-index:11; transform:translateX(-50%) translateY(10px);
      color:#20394e; background:rgba(255,255,255,.56); border:1px solid rgba(255,255,255,.7);
      border-radius:999px; box-shadow:0 14px 30px rgba(20,52,79,.14); backdrop-filter:blur(16px);
      padding:7px 12px; font:500 12px/1 var(--font-sans); opacity:0; pointer-events:none;
      transition:opacity 180ms ease, transform 180ms ease;
    }
    .gesture-feedback.is-visible { opacity:.92; transform:translateX(-50%) translateY(0); }
    .gesture-live-status {
      position:fixed; left:50%; bottom:58px; z-index:11; min-width:190px; max-width:min(360px, calc(100vw - 32px));
      transform:translateX(-50%); color:#20394e; background:rgba(255,255,255,.46);
      border:1px solid rgba(255,255,255,.64); border-radius:999px; box-shadow:0 12px 28px rgba(20,52,79,.12);
      backdrop-filter:blur(16px); padding:7px 12px; font:500 11px/1.15 var(--font-sans);
      text-align:center; opacity:0; pointer-events:none; transition:opacity 160ms ease;
    }
    .gesture-live-status.is-hot { background:rgba(255,236,174,.62); opacity:.95; }
    .vortex-toggle {
      position:fixed; top:52px; left:14px; z-index:10; width:28px; height:28px;
      border:1px solid rgba(255,255,255,.68); border-radius:999px; cursor:pointer;
      color:#264257; font:500 14px/1 var(--font-sans); background:rgba(255,255,255,.52);
      box-shadow:0 8px 22px rgba(20,52,79,.16); backdrop-filter:blur(12px);
    }
    .vortex-panel {
      position:fixed; top:88px; left:14px; z-index:12; width:min(252px, calc(100vw - 28px)); max-height:calc(100dvh - 112px); overflow:auto; padding:12px;
      color:#1c3448; background:rgba(255,255,255,.58); border:1px solid rgba(255,255,255,.7);
      border-radius:8px; box-shadow:0 18px 40px rgba(20,52,79,.18); backdrop-filter:blur(18px);
      font:12px/1.25 var(--font-sans); opacity:0; transform:translateY(-4px); pointer-events:none;
      transition:opacity 160ms ease, transform 160ms ease;
      overscroll-behavior:contain; -webkit-overflow-scrolling:touch; touch-action:auto;
    }
    .vortex-panel.is-open { opacity:1; transform:none; pointer-events:auto; }
    .vortex-panel b { display:block; margin-bottom:8px; font-size:12px; }
    .vortex-section { margin:10px 0 5px; font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:.08em; opacity:.62; }
    .vortex-control { display:grid; grid-template-columns:72px minmax(0,1fr) 34px; gap:8px; align-items:center; margin:7px 0; }
    .vortex-control span { font-variant-numeric:tabular-nums; text-align:right; opacity:.78; }
    .vortex-control input { width:100%; accent-color:#ff7a00; }
    .mode-row { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:6px 0 9px; }
    .mode-row button {
      min-height:32px;
      border:1px solid rgba(255,255,255,.72); border-radius:999px; padding:6px 8px; cursor:pointer;
      color:#20394e; background:rgba(255,255,255,.38); font:500 12px/1 var(--font-sans);
    }
    .mode-row button.is-active { background:rgba(255,138,30,.78); color:#fff7df; box-shadow:0 7px 18px rgba(166,74,0,.18); }
    .mode-row.frame-mode { grid-template-columns:1fr 1fr; margin-top:9px; }
    .vortex-randomize {
      width:100%; margin-top:7px; border:1px solid rgba(255,255,255,.72); border-radius:999px;
      padding:7px 10px; cursor:pointer; color:#20394e; background:rgba(255,255,255,.54);
      font:500 12px/1 var(--font-sans); box-shadow:0 8px 20px rgba(20,52,79,.12);
    }
    #presenceVideo { position:fixed; width:1px; height:1px; left:-12px; top:-12px; opacity:0; pointer-events:none; }
    @media (max-width: 700px) {
      .page-nav { right:50px; max-width:calc(100vw - 64px); }
      .gesture-panel, .vortex-panel {
        top:88px; max-height:calc(100dvh - 112px);
      }
      .gesture-panel { width:min(360px, calc(100vw - 28px)); }
    }
    @media (max-width: 520px) {
      .fullscreen-toggle, .gesture-toggle, .vortex-toggle { width:34px; height:34px; }
      .fullscreen-toggle { top:10px; right:10px; }
      .vortex-toggle { top:52px; left:10px; }
      .gesture-toggle { top:52px; right:10px; }
      .page-nav { top:10px; left:10px; right:52px; max-width:calc(100vw - 62px); }
      .page-nav a { height:32px; padding:0 11px; }
      .vortex-panel, .gesture-panel {
        left:10px; right:10px; top:96px; width:auto; max-height:calc(100dvh - 156px);
        border-radius:10px;
      }
      .gesture-panel { transform:translateY(8px); }
      .vortex-panel { transform:translateY(8px); }
      .gesture-panel.is-open, .vortex-panel.is-open { transform:none; }
      .gesture-table { font-size:11px; }
      .gesture-table th, .gesture-table td { padding:6px 3px; }
      .gesture-table td:first-child { white-space:normal; }
      .gesture-lab-row, .gesture-signal-grid, .mode-row { grid-template-columns:1fr; }
      .vortex-control { grid-template-columns:64px minmax(0,1fr) 34px; gap:7px; }
      .gesture-live-status { bottom:54px; max-width:calc(100vw - 20px); white-space:normal; }
      .gesture-feedback { bottom:18px; max-width:calc(100vw - 20px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    }
    @media (max-height: 560px) {
      .gesture-panel, .vortex-panel { top:52px; max-height:calc(100dvh - 64px); }
      .gesture-toggle { top:10px; right:50px; }
      .vortex-toggle { top:10px; left:50px; }
      .page-nav { opacity:.78; }
      .gesture-results { max-height:150px; }
    }
    @media (max-width: 360px) {
      .page-nav a { padding:0 9px; font-size:11px; }
      .vortex-control { grid-template-columns:1fr; gap:4px; margin:9px 0; }
      .vortex-control span { text-align:left; }
    }
  </style>
</head>
<body>
  <nav class="page-nav" aria-label="Glance pages">
    <a href="/">Watch</a>
    <a href="/orb" aria-current="page">Orb</a>
  </nav>
  <button class="fullscreen-toggle" id="fullscreenToggle" type="button" aria-label="Toggle fullscreen"></button>
  <button class="vortex-toggle" id="vortexToggle" type="button" aria-label="Show vortex controls">~</button>
  <button class="gesture-toggle" id="gestureToggle" type="button" aria-label="Show gesture help">?</button>
  <div class="vortex-panel" id="vortexPanel" aria-hidden="true">
    <b>Orb Lab</b>
    <div class="mode-row" aria-label="Orb variant">
      <button id="modeLava" type="button" class="is-active">Lava</button>
      <button id="modeWater" type="button">Water</button>
    </div>
    <div class="mode-row frame-mode" aria-label="Window backdrop">
      <button id="frameRoom" type="button" class="is-active">Room</button>
      <button id="frameBuddy" type="button">Buddy</button>
    </div>
    <button class="vortex-randomize" id="visualRandomize" type="button">Randomize All</button>
    <div class="vortex-section">Shape</div>
    <label class="vortex-control">Default <input id="shapeDefault" type="range" min="0" max="2" step="0.01" value="0"><span id="shapeDefaultValue">0.00</span></label>
    <label class="vortex-control">Noise <input id="shapeNoise" type="range" min="0" max="1.2" step="0.01" value="0"><span id="shapeNoiseValue">0.00</span></label>
    <div class="vortex-section">Layers</div>
    <label class="vortex-control">Shell <input id="layerShell" type="checkbox" checked><span id="layerShellValue">on</span></label>
    <label class="vortex-control">Gloss <input id="layerGloss" type="checkbox" checked><span id="layerGlossValue">on</span></label>
    <label class="vortex-control">Core <input id="layerCore" type="checkbox" checked><span id="layerCoreValue">on</span></label>
    <label class="vortex-control">Fluid <input id="layerFluid" type="checkbox" checked><span id="layerFluidValue">on</span></label>
    <label class="vortex-control">Lobes <input id="layerLobes" type="checkbox" checked><span id="layerLobesValue">on</span></label>
    <label class="vortex-control">Water <input id="layerWater" type="checkbox" checked><span id="layerWaterValue">on</span></label>
    <label class="vortex-control">Glitter <input id="layerGlitter" type="checkbox" checked><span id="layerGlitterValue">on</span></label>
    <label class="vortex-control">Traces <input id="layerTraces" type="checkbox" checked><span id="layerTracesValue">on</span></label>
    <div class="vortex-section">Fluid</div>
    <label class="vortex-control">Swirl <input id="vortexSwirl" type="range" min="0" max="2" step="0.01" value="1"><span id="vortexSwirlValue">1.00</span></label>
    <label class="vortex-control">Speed <input id="vortexSpeed" type="range" min="0.15" max="2" step="0.01" value="1"><span id="vortexSpeedValue">1.00</span></label>
    <label class="vortex-control">Soft <input id="vortexSoft" type="range" min="0" max="2" step="0.01" value="1"><span id="vortexSoftValue">1.00</span></label>
    <label class="vortex-control">Lobes <input id="vortexLobes" type="range" min="0" max="2" step="0.01" value="1"><span id="vortexLobesValue">1.00</span></label>
    <label class="vortex-control">Glass <input id="vortexGlass" type="range" min="0.5" max="1.4" step="0.01" value="1"><span id="vortexGlassValue">1.00</span></label>
    <label class="vortex-control">Ease <input id="vortexEase" type="range" min="0.02" max="1" step="0.01" value="0.18"><span id="vortexEaseValue">0.18</span></label>
    <button class="vortex-randomize" id="vortexRandomize" type="button">Randomize Fluid</button>
    <div class="vortex-section">Surface</div>
    <label class="vortex-control">Shine <input id="visualShine" type="range" min="0.2" max="3.2" step="0.01" value="1"><span id="visualShineValue">1.00</span></label>
    <label class="vortex-control">Core <input id="visualCore" type="range" min="0.35" max="1.7" step="0.01" value="1"><span id="visualCoreValue">1.00</span></label>
    <label class="vortex-control">Heat <input id="visualHeat" type="range" min="0" max="2" step="0.01" value="1"><span id="visualHeatValue">1.00</span></label>
    <label class="vortex-control">Contrast <input id="visualContrast" type="range" min="0" max="2" step="0.01" value="1"><span id="visualContrastValue">1.00</span></label>
    <label class="vortex-control">Liquid <input id="visualLiquid" type="range" min="0" max="100" step="1" value="28"><span id="visualLiquidValue">28</span></label>
    <label class="vortex-control">Atmos <input id="visualAtmos" type="range" min="0" max="3" step="0.01" value="1"><span id="visualAtmosValue">1.00</span></label>
    <div class="vortex-section">Motion</div>
    <label class="vortex-control">Mic <input id="visualMic" type="range" min="0" max="2" step="0.01" value="1"><span id="visualMicValue">1.00</span></label>
    <label class="vortex-control">Sense <input id="visualSense" type="range" min="0.5" max="8" step="0.05" value="2.4"><span id="visualSenseValue">2.40</span></label>
    <label class="vortex-control">Idle <input id="visualIdle" type="range" min="0" max="2" step="0.01" value="0.55"><span id="visualIdleValue">0.55</span></label>
    <div class="vortex-section">Water</div>
    <label class="vortex-control">Visc <input id="waterViscosity" type="range" min="0" max="100" step="1" value="68"><span id="waterViscosityValue">68</span></label>
    <label class="vortex-control">Gravity <input id="waterGravity" type="checkbox" checked><span id="waterGravityValue">on</span></label>
    <label class="vortex-control">Slosh <input id="waterSlosh" type="checkbox" checked><span id="waterSloshValue">on</span></label>
    <label class="vortex-control">Waves <input id="waterWaves" type="checkbox" checked><span id="waterWavesValue">on</span></label>
  </div>
  <div class="gesture-panel" id="gesturePanel" aria-hidden="true">
    <b>Gestures</b>
    <table class="gesture-table">
      <thead><tr><th>Gesture</th><th>Response</th><th>On</th></tr></thead>
      <tbody>
        <tr><td>Smile</td><td>Warms room and builds spin while held.</td><td>Always</td></tr>
        <tr><td>Right hand</td><td>Open spins; closed brakes and blips.</td><td><input id="gestureRightHand" type="checkbox" checked></td></tr>
        <tr><td>Left hand</td><td>Open goes; closed goes faster.</td><td><input id="gestureLeftHand" type="checkbox" checked></td></tr>
        <tr><td>Head follow</td><td>Tiny frame follow.</td><td><input id="gestureHead" type="checkbox" checked></td></tr>
        <tr><td>Stillness</td><td>Focus damping when steady.</td><td><input id="gestureStillness" type="checkbox" checked></td></tr>
      </tbody>
    </table>
    <div class="gesture-lab">
      <b>Gesture Lab</b>
      <div class="gesture-lab-row">
        <button id="gestureLabStart" type="button">Reset</button>
        <button id="gestureLabStop" type="button">Pause</button>
      </div>
      <div class="gesture-lab-current">
        <div id="gestureLabPrompt">Move naturally. Checks appear when tracked.</div>
        <div class="gesture-lab-meter"><i id="gestureLabMeter"></i></div>
      </div>
      <div class="gesture-signal-grid" id="gestureSignalGrid"></div>
      <div class="gesture-results" id="gestureResults"></div>
    </div>
  </div>
  <div class="gesture-live-status" id="gestureLiveStatus" aria-hidden="true"></div>
  <div class="gesture-feedback" id="gestureFeedback" aria-hidden="true">Gesture caught</div>
  <canvas id="memoryCanvas" aria-hidden="true"></canvas>
  <video id="presenceVideo" playsinline muted aria-hidden="true"></video>
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js"
      }
    }
  </script>
  <script type="module">
    import * as THREE from "three";
    import { TrackballControls } from "https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/controls/TrackballControls.js";
    import { FaceLandmarker, FilesetResolver, HandLandmarker } from "/vendor/tasks-vision/vision_bundle.mjs";

    const scene = new THREE.Scene();
    const coolBackground = new THREE.Color(0x63b7dc);
    const warmBackground = new THREE.Color(0xd85a1a);
    const stormBackground = new THREE.Color(0x173f69);
    const focusBackground = new THREE.Color(0x2b7b9d);
    scene.background = null;
    scene.fog = new THREE.Fog(coolBackground.clone(), 7.5, 14);
    const bgUniforms = {
      top: { value: new THREE.Color(0x91cfe0) },
      bottom: { value: new THREE.Color(0x0873a2) },
      warmth: { value: 0 },
      depth: { value: 1 },
    };
    const orbHome = new THREE.Vector3(0.3, -0.76, 0);
    const orbCenter = orbHome.clone();

    const camera = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.1, 100);
    camera.position.set(-0.08, 0.08, 8.05);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.36;
    renderer.domElement.style.position = "fixed";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.zIndex = "1";
    document.body.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.cursor = "grab";

    const bgScene = new THREE.Scene();
    const bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const bgMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: bgUniforms,
        depthWrite: false,
        depthTest: false,
        vertexShader: [
          "varying vec2 vUv;",
          "void main(){",
          "  vUv=uv;",
          "  gl_Position=vec4(position.xy,0.0,1.0);",
          "}"
        ].join("\\n"),
        fragmentShader: [
          "uniform vec3 top;",
          "uniform vec3 bottom;",
          "uniform float warmth;",
          "uniform float depth;",
          "varying vec2 vUv;",
          "void main(){",
          "  vec2 p=vUv-0.5;",
          "  float d=clamp(depth,0.0,3.0);",
          "  float radial=smoothstep(1.05,0.04,length(p*vec2(0.84,1.16)));",
          "  float sky=smoothstep(-0.08,1.08,vUv.y);",
          "  vec3 pale=vec3(0.45,0.76,0.86);",
          "  vec3 deep=vec3(0.0,0.34,0.56);",
          "  vec3 high=vec3(0.78,0.94,0.98);",
          "  vec3 cool=mix(pale,mix(deep,top,0.35),sky*d*0.48);",
          "  cool=mix(cool,high,radial*(0.18+0.22*d));",
          "  cool=mix(vec3(0.48,0.75,0.84),cool,smoothstep(0.0,1.0,d));",
          "  vec3 warm=mix(vec3(0.04,0.43,0.62),vec3(0.9,0.38,0.08),smoothstep(0.12,1.0,vUv.y+radial*0.24*d));",
          "  gl_FragColor=vec4(mix(cool,warm,warmth),1.0);",
          "}"
        ].join("\\n"),
      })
    );
    bgMesh.frustumCulled = false;
    bgScene.add(bgMesh);
    renderer.autoClear = false;

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.dynamicDampingFactor = 0.075;
    controls.noZoom = false;
    controls.noPan = false;
    controls.noRotate = false;
    controls.minDistance = 3.2;
    controls.maxDistance = 28;
    controls.panSpeed = 0.7;
    controls.rotateSpeed = 2.2;
    controls.zoomSpeed = 0.8;
    controls.target.copy(orbCenter);
    controls.update();

    let spaceDown = false;
    let grabHold = null;
    let shiftSpacePan = null;
    addEventListener("keydown", (event) => {
      if (event.code === "Space") {
        spaceDown = true;
        if (event.shiftKey) event.preventDefault();
      }
    });
    addEventListener("keyup", (event) => {
      if (event.code === "Space") spaceDown = false;
    });
    renderer.domElement.addEventListener("pointerdown", (event) => {
      grabHold = { pointerId: event.pointerId, born: performance.now() };
      renderer.domElement.style.cursor = "grabbing";
      if (!event.shiftKey || !spaceDown) return;
      event.preventDefault();
      event.stopPropagation();
      renderer.domElement.setPointerCapture(event.pointerId);
      shiftSpacePan = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target: controls.target.clone(),
        camera: camera.position.clone(),
      };
    }, { capture: true });
    renderer.domElement.addEventListener("pointercancel", (event) => {
      if (grabHold && grabHold.pointerId === event.pointerId) grabHold = null;
      if (shiftSpacePan && shiftSpacePan.pointerId === event.pointerId) shiftSpacePan = null;
      renderer.domElement.style.cursor = "grab";
    }, { capture: true });
    renderer.domElement.addEventListener("pointermove", (event) => {
      if (!shiftSpacePan || event.pointerId !== shiftSpacePan.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const dx = event.clientX - shiftSpacePan.x;
      const dy = event.clientY - shiftSpacePan.y;
      const distance = camera.position.distanceTo(controls.target);
      const worldPerPixel = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 2 * distance / innerHeight;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * worldPerPixel);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * worldPerPixel);
      const delta = right.add(up);
      const nextTarget = shiftSpacePan.target.clone().add(delta);
      const bounds = frameBounds();
      frameDrift.x = THREE.MathUtils.clamp(nextTarget.x - orbHome.x, -bounds.x, bounds.x);
      frameDrift.y = THREE.MathUtils.clamp(nextTarget.y - orbHome.y, -bounds.y, bounds.y);
      frameDrift.vx *= 0.55;
      frameDrift.vy *= 0.55;
      orbCenter.set(orbHome.x + frameDrift.x, orbHome.y + frameDrift.y, orbHome.z);
      const clampedDelta = orbCenter.clone().sub(shiftSpacePan.target);
      controls.target.copy(shiftSpacePan.target).add(clampedDelta);
      camera.position.copy(shiftSpacePan.camera).add(clampedDelta);
      controls.update();
    }, { capture: true });
    renderer.domElement.addEventListener("pointerup", (event) => {
      if (grabHold && grabHold.pointerId === event.pointerId) grabHold = null;
      renderer.domElement.style.cursor = "grab";
      if (!shiftSpacePan || event.pointerId !== shiftSpacePan.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      try { renderer.domElement.releasePointerCapture(event.pointerId); } catch {}
      shiftSpacePan = null;
    }, { capture: true });

    const memoryCanvas = document.getElementById("memoryCanvas");
    const memoryCtx = memoryCanvas.getContext("2d");
    const memoryEvents = [];
    function resizeMemoryCanvas() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      memoryCanvas.width = Math.floor(innerWidth * dpr);
      memoryCanvas.height = Math.floor(innerHeight * dpr);
      memoryCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resizeMemoryCanvas();
    addEventListener("resize", resizeMemoryCanvas);

    function frameBounds() {
      const distance = camera.position.distanceTo(controls.target);
      const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * distance;
      const halfW = halfH * camera.aspect;
      const radius = 1.42;
      return {
        x: Math.max(0.15, halfW - radius),
        y: Math.max(0.15, halfH - radius),
      };
    }

    const group = new THREE.Group();
    group.position.copy(orbCenter);
    group.rotation.set(-0.22, -0.2, 0.18);
    group.scale.set(0.98, 0.98, 0.98);
    scene.add(group);

    const clock = new THREE.Clock();
    const pulse = { value: 0 };
    const dance = { value: 0, phase: 0, spinX: 0, spinY: 0, spinZ: 0 };
    const massSpin = { x: 0, y: 0, z: 0, vx: 0, vy: 0.0022, vz: 0 };
    const denseFluid = { x: 0, y: -0.22, z: 0 };
    const idle = {
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      nextAt: performance.now() + 4200 + Math.random() * 3800,
      quietUntil: performance.now() + 2600,
    };
    const weather = {
      charge: 0,
      storm: 0,
      focus: 0,
      lastWorkAt: performance.now(),
      label: "calm",
    };
    const attention = {
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      pull: 0,
    };
    const frameDrift = {
      x: 0,
      y: 0,
      vx: 0.0018,
      vy: -0.0011,
      nextKickAt: performance.now() + 2400,
    };
    const shapeUniforms = {
      shapeFrom: { value: 0 },
      shapeTo: { value: 0 },
      shapeMix: { value: 1 },
      shapeNoise: { value: 0 },
    };
    const shapeState = { from: 0, to: 0, mix: 1, started: 0, duration: 920, returnAt: 0, returning: false };
    let audio;
    let audioUnlocked = false;
    let micStream = null;
    let micSource = null;
    let micAnalyser = null;
    let micData = null;
    let micLevel = 0;
    let micNoiseFloor = 0.018;
    let micPrevRms = 0;
    let micStarted = false;
    const presence = {
      started: false,
      ready: false,
      stream: null,
      face: null,
      hands: null,
      video: null,
      lastVideoTime: -1,
      failed: false,
      lastError: "",
      lastSmileAt: 0,
      lastRightHandAt: 0,
      lastHeadAt: 0,
      faceSeen: 0,
      lastFaceLandmarks: null,
      lastFaceLandmarksAt: 0,
      faceX: 0,
      faceY: 0,
      faceVX: 0,
      faceVY: 0,
      stillness: 0,
      smileRaw: 0,
      smileWarmth: 0,
      smileDetected: false,
      smileHold: 0,
      smileStartedAt: 0,
      lastSmileSpinAt: 0,
      rightHandRaised: false,
      rightHandOpen: false,
      rightHandClosed: false,
      rightHandHold: 0,
      rightHandOpenHold: 0,
      rightHandClosedHold: 0,
      rightHandStartedAt: 0,
      lastRightHandSpinAt: 0,
      leftHandRaised: false,
      leftHandClosed: false,
      leftHandHold: 0,
      leftHandClosedHold: 0,
      leftHandStartedAt: 0,
      lastLeftHandAt: 0,
      coverEyesStartedAt: 0,
      coverEyesTriggeredAt: 0,
    };
    const presenceSignals = {
      face: 0,
      smile: 0,
      mouthOpen: 0,
      browUp: 0,
      browDown: 0,
      lookLeft: 0,
      lookRight: 0,
      lookUp: 0,
      lookDown: 0,
      headLeft: 0,
      headRight: 0,
      headUp: 0,
      headDown: 0,
      headMotion: 0,
      headNod: 0,
      headShake: 0,
      closer: 0,
      farther: 0,
      rightRaised: 0,
      rightOpen: 0,
      rightClosed: 0,
      rightPinch: 0,
      rightPoint: 0,
      rightPeace: 0,
      rightThumb: 0,
      rightWave: 0,
      rightLowOpen: 0,
      rightLowClosed: 0,
      leftRaised: 0,
      leftOpen: 0,
      leftClosed: 0,
      leftPinch: 0,
      leftPoint: 0,
      leftPeace: 0,
      leftThumb: 0,
      leftWave: 0,
      leftLowOpen: 0,
      leftLowClosed: 0,
      eyesCovered: 0,
    };
    const signalHistory = { faceY: [], faceX: [], rightX: [], leftX: [], faceSize: 0 };
    let lastTone = 0;
    let lastObservedMtime = 0;
    let firstSnapshot = true;
    let pageTakeover = false;
    let lastHandShape = 1.5;

    const fullscreenToggle = document.getElementById("fullscreenToggle");
    const gestureToggle = document.getElementById("gestureToggle");
    const gesturePanel = document.getElementById("gesturePanel");
    const gestureFeedback = document.getElementById("gestureFeedback");
    const gestureLiveStatus = document.getElementById("gestureLiveStatus");
    const gestureSettings = {
      rightHand: true,
      leftHand: true,
      head: true,
      stillness: true,
    };
    const PREF_KEY = "machineOrbSettings:v1";
    const savedPrefs = (() => {
      try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; }
    })();
    function savePrefs(patch = {}) {
      Object.assign(savedPrefs, patch);
      try { localStorage.setItem(PREF_KEY, JSON.stringify(savedPrefs)); } catch {}
    }
    [
      ["RightHand", "rightHand"],
      ["LeftHand", "leftHand"],
      ["Head", "head"],
      ["Stillness", "stillness"],
    ].forEach(([id, key]) => {
      const input = document.getElementById("gesture" + id);
      if (savedPrefs.gestures && Object.prototype.hasOwnProperty.call(savedPrefs.gestures, key)) {
        input.checked = Boolean(savedPrefs.gestures[key]);
      }
      input.addEventListener("change", () => {
        gestureSettings[key] = input.checked;
        savePrefs({ gestures: { ...(savedPrefs.gestures || {}), [key]: input.checked } });
      });
      gestureSettings[key] = input.checked;
    });
    const vortexToggle = document.getElementById("vortexToggle");
    const vortexPanel = document.getElementById("vortexPanel");
    const vortexRandomize = document.getElementById("vortexRandomize");
    const visualRandomize = document.getElementById("visualRandomize");
    const modeButtons = {
      lava: document.getElementById("modeLava"),
      water: document.getElementById("modeWater"),
    };
    const orbMode = { value: savedPrefs.orbMode === "water" ? "water" : "lava" };
    const frameButtons = {
      room: document.getElementById("frameRoom"),
      buddy: document.getElementById("frameBuddy"),
    };
    const frameMode = { value: (savedPrefs.frameMode || localStorage.getItem("orbFrameMode")) === "buddy" ? "buddy" : "room" };
    const vortexSettings = {
      current: { swirl: 1, speed: 1, soft: 1, lobes: 1, glass: 1 },
      target: { swirl: 1, speed: 1, soft: 1, lobes: 1, glass: 1 },
      ease: 0.18,
      controls: {},
    };
    const visualSettings = {
      current: { shine: 1, core: 1, heat: 1, contrast: 1, liquid: 28, atmos: 1, mic: 1, sense: 2.4, idle: 0.55 },
      target: { shine: 1, core: 1, heat: 1, contrast: 1, liquid: 28, atmos: 1, mic: 1, sense: 2.4, idle: 0.55 },
      controls: {},
    };
    const shapeSettings = {
      default: Number(savedPrefs.shape?.default ?? 0),
      noise: Number(savedPrefs.shape?.noise ?? 0),
    };
    const layerSettings = {
      shell: true,
      gloss: true,
      core: true,
      fluid: true,
      lobes: true,
      water: true,
      glitter: true,
      traces: true,
    };
    const waterSettings = {
      viscosity: 68,
      gravity: true,
      slosh: true,
      waves: true,
    };
    let glitter = null;
    vortexToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = !vortexPanel.classList.contains("is-open");
      vortexPanel.classList.toggle("is-open", open);
      vortexPanel.setAttribute("aria-hidden", open ? "false" : "true");
    });
    let gestureFeedbackTimer = null;
    function showGestureFeedback(label) {
      gestureFeedback.textContent = label;
      gestureFeedback.classList.add("is-visible");
      if (gestureFeedbackTimer) clearTimeout(gestureFeedbackTimer);
      gestureFeedbackTimer = setTimeout(() => gestureFeedback.classList.remove("is-visible"), 900);
    }
    function updateGestureLiveStatus(label, confidence) {
      const score = clamp01(confidence || 0);
      gestureLiveStatus.textContent = label + (score > 0 ? " " + Math.round(score * 100) + "%" : "");
      gestureLiveStatus.classList.toggle("is-hot", score >= 0.62);
    }
    gestureToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = !gesturePanel.classList.contains("is-open");
      gesturePanel.classList.toggle("is-open", open);
      gesturePanel.setAttribute("aria-hidden", open ? "false" : "true");
    });
    const gestureLabStart = document.getElementById("gestureLabStart");
    const gestureLabStop = document.getElementById("gestureLabStop");
    const gestureLabPrompt = document.getElementById("gestureLabPrompt");
    const gestureLabMeter = document.getElementById("gestureLabMeter");
    const gestureSignalGrid = document.getElementById("gestureSignalGrid");
    const gestureResults = document.getElementById("gestureResults");
    const gestureTests = [
      ["Neutral face", "Relax your face and look at the camera.", (s) => s.face && 1 - Math.max(s.smile, s.mouthOpen, s.browUp, s.browDown, s.headMotion)],
      ["Soft smile", "Give me a small smile.", (s) => s.smile],
      ["Hard smile", "Big smile. Teeth are fine.", (s) => Math.min(1, s.smile * 1.28)],
      ["Smile hold", "Hold that smile.", (s) => s.smile],
      ["Eyebrows up", "Raise your eyebrows.", (s) => s.browUp],
      ["Brows down", "Frown your eyebrows.", (s) => s.browDown],
      ["Mouth open", "Open your mouth.", (s) => s.mouthOpen],
      ["Mouth closed", "Close your mouth, neutral face.", (s) => s.face * (1 - s.mouthOpen)],
      ["Look left", "Move only your eyes to your left.", (s) => s.lookLeft],
      ["Look right", "Move only your eyes to your right.", (s) => s.lookRight],
      ["Look up", "Look up with your eyes.", (s) => s.lookUp],
      ["Look down", "Look down with your eyes.", (s) => s.lookDown],
      ["Head left", "Turn your head left.", (s) => s.headLeft],
      ["Head right", "Turn your head right.", (s) => s.headRight],
      ["Head up", "Lift your chin up.", (s) => s.headUp],
      ["Head down", "Tuck your chin down.", (s) => s.headDown],
      ["Head nod once", "Nod once.", (s) => s.headNod],
      ["Head nod repeat", "Nod a few times.", (s) => s.headNod],
      ["Head shake no", "Shake your head no.", (s) => s.headShake],
      ["Lean closer", "Lean closer to the camera.", (s) => s.closer],
      ["Lean back", "Lean back from the camera.", (s) => s.farther],
      ["Turn away", "Turn away until I lose your face.", (s) => presence.ready ? 1 - s.face : 0],
      ["Re-enter frame", "Come back into frame.", (s) => s.face],
      ["Right absent", "Hide your right hand.", (s) => presence.ready ? 1 - s.rightRaised : 0],
      ["Right raised open", "Raise your right hand open.", (s) => s.rightRaised * s.rightOpen],
      ["Right raised closed", "Raise your right hand in a fist.", (s) => s.rightRaised * s.rightClosed],
      ["Right open low", "Lower your right open hand.", (s) => s.rightLowOpen],
      ["Right closed low", "Lower your right fist.", (s) => s.rightLowClosed],
      ["Right pinch", "Right hand pinch.", (s) => s.rightPinch],
      ["Right point", "Right index finger point.", (s) => s.rightPoint],
      ["Right peace", "Right hand peace sign.", (s) => s.rightPeace],
      ["Right thumb", "Right thumbs up.", (s) => s.rightThumb],
      ["Right wave", "Wave your right hand side to side.", (s) => s.rightWave],
      ["Right hold", "Hold your right hand raised.", (s) => s.rightRaised],
      ["Right open to closed", "Close your right hand into a fist.", (s) => s.rightClosed],
      ["Right closed to open", "Open your right fist.", (s) => s.rightOpen],
      ["Left absent", "Hide your left hand.", (s) => presence.ready ? 1 - s.leftRaised : 0],
      ["Left raised open", "Raise your left hand open.", (s) => s.leftRaised * s.leftOpen],
      ["Left raised closed", "Raise your left hand in a fist.", (s) => s.leftRaised * s.leftClosed],
      ["Left open low", "Lower your left open hand.", (s) => s.leftLowOpen],
      ["Left closed low", "Lower your left fist.", (s) => s.leftLowClosed],
      ["Left pinch", "Left hand pinch.", (s) => s.leftPinch],
      ["Left point", "Left index finger point.", (s) => s.leftPoint],
      ["Left peace", "Left hand peace sign.", (s) => s.leftPeace],
      ["Left thumb", "Left thumbs up.", (s) => s.leftThumb],
      ["Left wave", "Wave your left hand side to side.", (s) => s.leftWave],
      ["Left open to closed", "Close your left hand into a fist.", (s) => s.leftClosed],
      ["Left closed to open", "Open your left fist.", (s) => s.leftOpen],
      ["Smile + left open", "Smile and hold your left hand open.", (s) => Math.min(s.smile, s.leftOpen)],
      ["Smile + right closed", "Smile and hold your right fist.", (s) => Math.min(s.smile, s.rightClosed)],
    ].map(([label, spoken, score]) => ({ label, spoken, score }));
    const gestureLab = {
      paused: false,
      holdMs: 520,
      threshold: 0.72,
      rows: gestureTests.map((test) => ({ label: test.label, score: test.score, seen: false, confidence: 0, greenSince: 0, live: 0 })),
    };
    function renderGestureSignals() {
      const keys = ["face", "eyesCovered", "smile", "mouthOpen", "browUp", "headMotion", "rightOpen", "rightClosed", "leftOpen", "leftClosed", "rightWave", "leftWave", "headNod"];
      gestureSignalGrid.innerHTML = keys.map((key) => '<span><b>' + key + '</b><em>' + Math.round(clamp01(presenceSignals[key]) * 100) + '</em></span>').join("");
    }
    function renderGestureResults() {
      gestureResults.innerHTML = gestureLab.rows.map((result, i) => {
        const pass = result.seen;
        const cls = pass ? "pass" : "fail";
        const confidence = pass ? result.confidence : result.live;
        return '<div class="gesture-result ' + cls + '"><b>' + (pass ? "✓" : "×") + '</b><span>' + (i + 1) + ". " + result.label + '</span><em>' + Math.round(confidence * 100) + '</em></div>';
      }).join("");
    }
    function resetGestureLab() {
      gestureLab.rows.forEach((row) => {
        row.seen = false;
        row.confidence = 0;
        row.greenSince = 0;
        row.live = 0;
      });
      gestureLabMeter.style.width = "0%";
      gestureLabMeter.style.background = "linear-gradient(90deg,#ff8a1e,#ffd52a)";
      gestureLabPrompt.textContent = "Move naturally. Checks appear when tracked.";
      renderGestureResults();
    }
    function tickGestureLab() {
      renderGestureSignals();
      if (!gestureLab.paused) {
        const now = performance.now();
        let hottest = 0;
        let changed = false;
        gestureLab.rows.forEach((row) => {
          const score = clamp01(row.score(presenceSignals));
          row.live = score;
          hottest = Math.max(hottest, score);
          if (!row.seen && score >= gestureLab.threshold) {
            if (!row.greenSince) row.greenSince = now;
            if (now - row.greenSince >= gestureLab.holdMs) {
              row.seen = true;
              row.confidence = score;
              changed = true;
            }
          } else if (!row.seen) {
            row.greenSince = 0;
          } else {
            row.confidence = Math.max(row.confidence, score);
          }
        });
        const seen = gestureLab.rows.filter((row) => row.seen).length;
        const progress = seen / gestureLab.rows.length;
        gestureLabPrompt.textContent = "Tracked " + seen + "/" + gestureLab.rows.length + (seen === gestureLab.rows.length ? " complete." : " · move naturally.");
        gestureLabMeter.style.width = Math.round(progress * 100) + "%";
        gestureLabMeter.style.background = progress >= 1 ? "linear-gradient(90deg,#40c463,#b8f36b)" : "linear-gradient(90deg,#ff8a1e,#ffd52a)";
        if (changed || Math.random() < 0.08 || hottest > 0.82) {
          renderGestureResults();
        }
      }
      requestAnimationFrame(tickGestureLab);
    }
    gestureLabStart.addEventListener("click", (event) => {
      event.stopPropagation();
      resetGestureLab();
    });
    gestureLabStop.addEventListener("click", (event) => {
      event.stopPropagation();
      gestureLab.paused = !gestureLab.paused;
      gestureLabStop.textContent = gestureLab.paused ? "Resume" : "Pause";
      const seen = gestureLab.rows.filter((row) => row.seen).length;
      gestureLabPrompt.textContent = gestureLab.paused ? "Paused at " + seen + "/" + gestureLab.rows.length + "." : "Tracked " + seen + "/" + gestureLab.rows.length + " · move naturally.";
    });
    resetGestureLab();
    tickGestureLab();
    function syncFullscreenState() {
      const active = pageTakeover || Boolean(document.fullscreenElement);
      document.body.classList.toggle("is-fullscreen", active);
      fullscreenToggle.setAttribute("aria-pressed", active ? "true" : "false");
    }
    fullscreenToggle.addEventListener("click", async (event) => {
      event.stopPropagation();
      const next = !(pageTakeover || document.fullscreenElement);
      pageTakeover = next;
      try {
        if (!next && document.fullscreenElement) await document.exitFullscreen();
        else if (next && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      } catch {}
      syncFullscreenState();
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && !pageTakeover) syncFullscreenState();
    });
    addEventListener("keydown", (event) => {
      if (event.key === "Escape" && pageTakeover) {
        pageTakeover = false;
        syncFullscreenState();
      }
    });

    function hashText(text) {
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }
    function repoTone(repo) {
      const hash = hashText(repo || "root");
      const scale = [0, 2, 4, 7, 9, 12];
      const base = 520 * Math.pow(2, scale[hash % scale.length] / 12);
      return {
        hash,
        base,
        high: base * (1.32 + ((hash >>> 5) % 5) * 0.035),
        air: base * (2.02 + ((hash >>> 12) % 7) * 0.028),
        pan: (((hash >>> 20) % 101) - 50) / 100,
        wave: (hash & 1) ? "triangle" : "sine",
        filter: 560 + ((hash >>> 8) % 520),
        q: 2.4 + ((hash >>> 16) % 58) / 10,
        attack: 0.004 + ((hash >>> 24) % 6) * 0.0015,
        release: 0.12 + ((hash >>> 28) % 6) * 0.018,
      };
    }
    function repoColor(repo) {
      const hash = hashText(repo || "root");
      const palette = [0xffd52a, 0xff6a1a, 0xe52018, 0x60d7ff, 0xf2a9c8, 0x1a2f55];
      return palette[hash % palette.length];
    }
    function audioContext() {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      return audio;
    }
    async function wakeAudio() {
      try {
        const ctx = audioContext();
        if (ctx.state !== "running") await ctx.resume();
        if (ctx.state === "running" && !audioUnlocked) {
          audioUnlocked = true;
          document.body.classList.add("audio-armed");
          playChime("root", 4, "modify");
        }
      } catch {}
    }
    async function startMicReactive() {
      if (micStarted || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      try {
        const ctx = audioContext();
        if (ctx.state !== "running") await ctx.resume();
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        micSource = ctx.createMediaStreamSource(micStream);
        micAnalyser = ctx.createAnalyser();
        micAnalyser.fftSize = 512;
        micAnalyser.smoothingTimeConstant = 0.62;
        micData = new Uint8Array(micAnalyser.fftSize);
        micSource.connect(micAnalyser);
        micStarted = true;
        document.body.classList.add("mic-armed");
      } catch {}
    }
    async function startPresenceReactive() {
      if (presence.started || presence.failed || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      presence.started = true;
      try {
        presence.video = document.getElementById("presenceVideo");
        const vision = await FilesetResolver.forVisionTasks("/vendor/tasks-vision/wasm");
        const [face, hands, stream] = await Promise.all([
          FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: "/vendor/mediapipe-models/face_landmarker.task" },
            runningMode: "VIDEO",
            outputFaceBlendshapes: true,
            numFaces: 1,
          }),
          HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: "/vendor/mediapipe-models/hand_landmarker.task" },
            runningMode: "VIDEO",
            numHands: 2,
          }),
          navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: "user" },
            audio: false,
          }),
        ]);
        presence.face = face;
        presence.hands = hands;
        presence.stream = stream;
        presence.video.srcObject = stream;
        await presence.video.play();
        presence.ready = true;
        presence.failed = false;
        presence.lastError = "";
        document.body.classList.add("presence-armed");
        requestAnimationFrame(samplePresence);
      } catch (error) {
        presence.started = false;
        presence.ready = false;
        presence.failed = true;
        presence.lastError = error && error.name ? error.name : "camera failed";
        document.body.classList.remove("presence-armed");
        showGestureFeedback("Camera unavailable");
      }
    }
    function presenceTrigger(name, cooldown, fn) {
      const key = name === "smile" ? "lastSmileAt" : "lastRightHandAt";
      const now = performance.now();
      if (now - presence[key] < cooldown) return;
      presence[key] = now;
      fn();
    }
    function clamp01(value) {
      return Math.max(0, Math.min(1, Number(value) || 0));
    }
    function dist2(a, b) {
      if (!a || !b) return 9;
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function pushHistory(list, value, max = 24) {
      list.push(value);
      if (list.length > max) list.shift();
    }
    function historyRange(list, recent = list.length) {
      const slice = list.slice(Math.max(0, list.length - recent));
      if (!slice.length) return 0;
      return Math.max(...slice) - Math.min(...slice);
    }
    function blendScore(result, name) {
      return result.faceBlendshapes?.[0]?.categories?.find((item) => item.categoryName === name)?.score || 0;
    }
    function handNearEyes(hand, landmarks) {
      if (!hand || !landmarks) return 0;
      const points = [hand[0], hand[4], hand[8], hand[12], hand[16], hand[20]].filter(Boolean);
      if (!points.length) return 0;
      const eyeAnchors = [landmarks[33], landmarks[133], landmarks[263], landmarks[362], landmarks[168]].filter(Boolean);
      if (!eyeAnchors.length) return 0;
      const faceWidth = Math.max(0.08, dist2(landmarks[234], landmarks[454]));
      let best = 9;
      for (const point of points) {
        for (const eye of eyeAnchors) best = Math.min(best, dist2(point, eye));
      }
      const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const eyeCenterX = eyeAnchors.reduce((sum, point) => sum + point.x, 0) / eyeAnchors.length;
      const eyeCenterY = eyeAnchors.reduce((sum, point) => sum + point.y, 0) / eyeAnchors.length;
      const centerDistance = Math.hypot((centerX - eyeCenterX) / faceWidth, (centerY - eyeCenterY) / faceWidth);
      return Math.max(clamp01(1 - best / (faceWidth * 0.55)), clamp01(1 - centerDistance / 1.05));
    }
    function handPose(hand) {
      const wrist = hand[0];
      const indexTip = hand[8];
      const ys = hand.map((point) => point?.y).filter((value) => Number.isFinite(value));
      const top = ys.length ? Math.min(...ys) : 1;
      const centerY = ys.length ? ys.reduce((sum, value) => sum + value, 0) / ys.length : 1;
      const raised = Boolean(wrist && (top < 0.72 || centerY < 0.78 || (indexTip && indexTip.y < wrist.y - 0.07)));
      const fingers = [
        [8, 6],
        [12, 10],
        [16, 14],
        [20, 18],
      ];
      let extended = 0;
      for (const [tipIndex, pipIndex] of fingers) {
        const tip = hand[tipIndex];
        const pip = hand[pipIndex];
        if (tip && pip && tip.y < pip.y - 0.018) extended++;
      }
      const palm = Math.max(0.001, dist2(hand[0], hand[9]));
      const pinch = clamp01(1 - dist2(hand[4], hand[8]) / (palm * 0.72));
      const point = extended === 1 && hand[8] && hand[6] && hand[8].y < hand[6].y - 0.018 ? 1 : 0;
      const peace = extended === 2 && hand[8] && hand[12] && hand[8].y < hand[6].y - 0.018 && hand[12].y < hand[10].y - 0.018 ? 1 : 0;
      const thumb = hand[4] && hand[3] && Math.abs(hand[4].y - wrist.y) > palm * 0.34 && extended <= 2 ? 1 : 0;
      return {
        raised,
        open: extended >= 3,
        closed: extended <= 1,
        extended,
        pinch,
        point,
        peace,
        thumb,
        x: wrist?.x ?? 0.5,
        low: Boolean(wrist && !raised),
      };
    }
    function samplePresence() {
      if (!presence.ready || !presence.video || presence.video.readyState < 2) {
        if (presence.failed) updateGestureLiveStatus("Camera unavailable", 0);
        if (presence.started) requestAnimationFrame(samplePresence);
        return;
      }
      const now = performance.now();
      let faceLandmarks = null;
      if (presence.video.currentTime === presence.lastVideoTime) {
        requestAnimationFrame(samplePresence);
        return;
      }
      presence.lastVideoTime = presence.video.currentTime;
      try {
        const faceResult = presence.face.detectForVideo(presence.video, now);
        Object.keys(presenceSignals).forEach((key) => { presenceSignals[key] *= 0.88; });
        if (faceResult.faceLandmarks && faceResult.faceLandmarks.length) {
          presence.faceSeen = now;
          presenceSignals.face = 1;
          const landmarks = faceResult.faceLandmarks[0];
          faceLandmarks = landmarks;
          presence.lastFaceLandmarks = landmarks;
          presence.lastFaceLandmarksAt = now;
          const nose = landmarks[1] || landmarks[4];
          if (nose) {
            const nx = (0.5 - nose.x) * 2;
            const ny = (0.5 - nose.y) * 2;
            presence.faceVX = nx - presence.faceX;
            presence.faceVY = ny - presence.faceY;
            presence.faceX += (nx - presence.faceX) * 0.28;
            presence.faceY += (ny - presence.faceY) * 0.28;
            const motion = Math.hypot(presence.faceVX, presence.faceVY);
            pushHistory(signalHistory.faceX, presence.faceX);
            pushHistory(signalHistory.faceY, presence.faceY);
            const faceWidth = dist2(landmarks[234], landmarks[454]);
            const faceHeight = dist2(landmarks[10], landmarks[152]);
            const faceSize = faceWidth + faceHeight;
            const previousFaceSize = signalHistory.faceSize || faceSize;
            signalHistory.faceSize = previousFaceSize + (faceSize - previousFaceSize) * 0.18;
            presenceSignals.headMotion = clamp01(motion / 0.08);
            presenceSignals.headLeft = clamp01((-presence.faceX - 0.12) / 0.38);
            presenceSignals.headRight = clamp01((presence.faceX - 0.12) / 0.38);
            presenceSignals.headUp = clamp01((-presence.faceY - 0.08) / 0.34);
            presenceSignals.headDown = clamp01((presence.faceY - 0.08) / 0.34);
            presenceSignals.headNod = clamp01(historyRange(signalHistory.faceY, 18) / 0.2);
            presenceSignals.headShake = clamp01(historyRange(signalHistory.faceX, 18) / 0.24);
            presenceSignals.closer = clamp01((faceSize - signalHistory.faceSize) / 0.06 + 0.5);
            presenceSignals.farther = clamp01((signalHistory.faceSize - faceSize) / 0.06 + 0.5);
            presence.stillness += ((motion < 0.012 ? 1 : 0) - presence.stillness) * 0.018;
            if (gestureSettings.head && motion > 0.045 && now - presence.lastHeadAt > 1800) {
              presence.lastHeadAt = now;
              gestureToggle.classList.add("is-following-head");
              setTimeout(() => gestureToggle.classList.remove("is-following-head"), 420);
            }
          }
          const smileScore = blendScore(faceResult, "mouthSmileLeft");
          const smileScoreRight = blendScore(faceResult, "mouthSmileRight");
          const mouthOpen = Math.max(blendScore(faceResult, "jawOpen"), blendScore(faceResult, "mouthFunnel"), blendScore(faceResult, "mouthPucker"));
          const browUp = Math.max(blendScore(faceResult, "browInnerUp"), blendScore(faceResult, "browOuterUpLeft"), blendScore(faceResult, "browOuterUpRight"));
          const browDown = Math.max(blendScore(faceResult, "browDownLeft"), blendScore(faceResult, "browDownRight"));
          const eyeLookLeft = Math.max(blendScore(faceResult, "eyeLookOutLeft"), blendScore(faceResult, "eyeLookInRight"));
          const eyeLookRight = Math.max(blendScore(faceResult, "eyeLookInLeft"), blendScore(faceResult, "eyeLookOutRight"));
          const eyeLookUp = Math.max(blendScore(faceResult, "eyeLookUpLeft"), blendScore(faceResult, "eyeLookUpRight"));
          const eyeLookDown = Math.max(blendScore(faceResult, "eyeLookDownLeft"), blendScore(faceResult, "eyeLookDownRight"));
          const smileLevel = Math.min(1, Math.max(0, (smileScore + smileScoreRight - 0.42) / 0.7));
          presenceSignals.smile = smileLevel;
          presenceSignals.mouthOpen = clamp01(mouthOpen / 0.72);
          presenceSignals.browUp = clamp01(browUp / 0.55);
          presenceSignals.browDown = clamp01(browDown / 0.45);
          presenceSignals.lookLeft = clamp01(eyeLookLeft / 0.62);
          presenceSignals.lookRight = clamp01(eyeLookRight / 0.62);
          presenceSignals.lookUp = clamp01(eyeLookUp / 0.62);
          presenceSignals.lookDown = clamp01(eyeLookDown / 0.62);
          presence.smileRaw = Math.max(presence.smileRaw, smileLevel);
          presence.smileDetected = smileLevel > 0.28;
          if (presence.smileDetected && presence.smileStartedAt === 0) {
            presence.smileStartedAt = now;
          } else if (!presence.smileDetected) {
            presence.smileStartedAt = 0;
          }
          if (smileScore + smileScoreRight > 0.72) {
            presenceTrigger("smile", 1800, () => {
              showGestureFeedback("Smile caught");
              coreUniforms.projectColor.value.set(0xf2a9c8);
              coreUniforms.projectGlow.value = Math.min(0.95, coreUniforms.projectGlow.value + 0.28);
              pulse.value = Math.min(2.2, pulse.value + 0.34);
            });
          }
        }
        const handResult = presence.hands.detectForVideo(presence.video, now);
        let liveHandLabel = "";
        let liveHandScore = 0;
        let rightHandRaised = false;
        let rightHandOpen = false;
        let rightHandClosed = false;
        let leftHandRaised = false;
        let leftHandClosed = false;
        let rightEyeCover = 0;
        let leftEyeCover = 0;
        const coverScores = [];
        const coverFaceLandmarks = faceLandmarks || (now - presence.lastFaceLandmarksAt < 1400 ? presence.lastFaceLandmarks : null);
        if (handResult.landmarks && handResult.landmarks.length) {
          for (let i = 0; i < handResult.landmarks.length; i++) {
            const handedness = handResult.handednesses?.[i]?.[0]?.categoryName || "";
            const handednessScore = handResult.handednesses?.[i]?.[0]?.score || 0.72;
            const hand = handResult.landmarks[i];
            const pose = handPose(hand);
            const eyeCover = handNearEyes(hand, coverFaceLandmarks) * clamp01(handednessScore);
            coverScores.push(eyeCover);
            if (handedness === "Right") rightEyeCover = Math.max(rightEyeCover, eyeCover);
            if (handedness === "Left") leftEyeCover = Math.max(leftEyeCover, eyeCover);
            const poseScore = Math.max(
              pose.raised ? 0.78 : 0,
              pose.open ? 0.86 : 0,
              pose.closed ? 0.82 : 0,
              pose.pinch,
              pose.point,
              pose.peace,
              pose.thumb
            ) * clamp01(handednessScore);
            if (poseScore > liveHandScore) {
              const heightLabel = pose.raised ? "raised" : "low";
              const shapeLabel = pose.open ? "open" : (pose.closed ? "closed" : (pose.pinch > 0.62 ? "pinch" : (pose.point ? "point" : (pose.peace ? "peace" : (pose.thumb ? "thumb" : "hand")))));
              liveHandLabel = (handedness || "Hand") + " " + heightLabel + " " + shapeLabel;
              liveHandScore = poseScore;
            }
            if (gestureSettings.rightHand && handedness === "Right" && pose.raised) {
              rightHandRaised = true;
              rightHandOpen = pose.open;
              rightHandClosed = pose.closed;
              presenceSignals.rightRaised = 1;
              presenceSignals.rightOpen = pose.open ? 1 : 0;
              presenceSignals.rightClosed = pose.closed ? 1 : 0;
              presenceSignals.rightPinch = pose.pinch;
              presenceSignals.rightPoint = pose.point;
              presenceSignals.rightPeace = pose.peace;
              presenceSignals.rightThumb = pose.thumb;
              pushHistory(signalHistory.rightX, pose.x);
              presenceSignals.rightWave = clamp01(historyRange(signalHistory.rightX, 16) / 0.24);
              presenceTrigger("rightHand", 1700, () => {
                showGestureFeedback(pose.closed ? "Right hand brake" : "Right hand spin");
                handShapeBlip();
              });
            }
            if (handedness === "Right" && !pose.raised) {
              presenceSignals.rightLowOpen = pose.open ? 1 : 0;
              presenceSignals.rightLowClosed = pose.closed ? 1 : 0;
            }
            if (gestureSettings.leftHand && handedness === "Left" && pose.raised) {
              leftHandRaised = true;
              leftHandClosed = pose.closed;
              presenceSignals.leftRaised = 1;
              presenceSignals.leftOpen = pose.open ? 1 : 0;
              presenceSignals.leftClosed = pose.closed ? 1 : 0;
              presenceSignals.leftPinch = pose.pinch;
              presenceSignals.leftPoint = pose.point;
              presenceSignals.leftPeace = pose.peace;
              presenceSignals.leftThumb = pose.thumb;
              pushHistory(signalHistory.leftX, pose.x);
              presenceSignals.leftWave = clamp01(historyRange(signalHistory.leftX, 16) / 0.24);
            }
            if (handedness === "Left" && !pose.raised) {
              presenceSignals.leftLowOpen = pose.open ? 1 : 0;
              presenceSignals.leftLowClosed = pose.closed ? 1 : 0;
            }
          }
        }
        coverScores.sort((a, b) => b - a);
        const twoHandCover = coverScores.length >= 2 ? Math.min(coverScores[0], coverScores[1]) : 0;
        const handedCover = Math.min(rightEyeCover, leftEyeCover);
        const eyesCovered = Math.max(twoHandCover, handedCover);
        presenceSignals.eyesCovered = Math.max(presenceSignals.eyesCovered, eyesCovered);
        if (eyesCovered > 0.62 && now - presence.coverEyesTriggeredAt > 8500) {
          if (!presence.coverEyesStartedAt) {
            presence.coverEyesStartedAt = now;
            showGestureFeedback("Presence gesture detected");
          }
          const held = now - presence.coverEyesStartedAt;
          updateGestureLiveStatus(held > 1800 ? "Read-only mode" : "Watching gesture", eyesCovered);
          if (held > 1800) {
            presence.coverEyesTriggeredAt = now;
            presence.coverEyesStartedAt = 0;
            showGestureFeedback("Read-only mode");
          }
        } else if (eyesCovered <= 0.62) {
          if (presence.coverEyesStartedAt && now - presence.coverEyesStartedAt > 250) showGestureFeedback("Gesture ended");
          presence.coverEyesStartedAt = 0;
        }
        presence.rightHandRaised = rightHandRaised;
        presence.rightHandOpen = rightHandOpen || (rightHandRaised && !rightHandClosed);
        presence.rightHandClosed = rightHandClosed;
        if (rightHandRaised && !presence.rightHandStartedAt) {
          presence.rightHandStartedAt = now;
          presence.lastRightHandSpinAt = now;
        } else if (!rightHandRaised) {
          presence.rightHandStartedAt = 0;
        }
        if (leftHandRaised && !presence.leftHandRaised) {
          presence.leftHandStartedAt = now;
          presence.lastLeftHandAt = now;
          showGestureFeedback(leftHandClosed ? "Left hand faster" : "Left hand go");
        }
        presence.leftHandRaised = leftHandRaised;
        presence.leftHandClosed = leftHandClosed;
        if (presence.coverEyesStartedAt) {
          // Keep the lock countdown visible.
        } else if (liveHandLabel) {
          updateGestureLiveStatus(liveHandLabel, liveHandScore);
        } else {
          const faceScore = Math.max(presenceSignals.smile, presenceSignals.mouthOpen, presenceSignals.browUp, presenceSignals.browDown, presenceSignals.headMotion, presenceSignals.face);
          const faceLabel = presenceSignals.smile > 0.62 ? "Smile detected" : (presenceSignals.headMotion > 0.5 ? "Head movement" : (presenceSignals.face > 0.4 ? "Face tracked" : "No hand detected"));
          updateGestureLiveStatus(faceLabel, faceScore);
        }
      } catch {}
      requestAnimationFrame(samplePresence);
    }
    function sampleMicLevel() {
      if (!micAnalyser || !micData) {
        micLevel *= 0.92;
        return micLevel;
      }
      micAnalyser.getByteTimeDomainData(micData);
      let sum = 0;
      for (let i = 0; i < micData.length; i++) {
        const v = (micData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / micData.length);
      const floorRate = rms > micNoiseFloor * 1.55 ? 0.0007 : 0.018;
      micNoiseFloor += (rms - micNoiseFloor) * floorRate;
      micNoiseFloor = THREE.MathUtils.clamp(micNoiseFloor, 0.0035, 0.06);
      const onset = Math.max(0, rms - micPrevRms);
      micPrevRms += (rms - micPrevRms) * 0.24;
      const gate = Math.max(0.008, micNoiseFloor * 1.22);
      const sensitivity = visualSettings.current.sense;
      const sense01 = Math.min(1, sensitivity / 8);
      const foreground = Math.max(0, rms - gate * THREE.MathUtils.lerp(1.08, 0.18, sense01));
      const transientBoost = onset > 0.0011 / sensitivity ? Math.min(0.65, onset * 38 * sensitivity) : 0;
      const target = Math.min(1, Math.pow(foreground * 82 * sensitivity + transientBoost, 0.56));
      micLevel += (target - micLevel) * (target > micLevel ? 0.62 : 0.12);
      if (micLevel < 0.006) micLevel = 0;
      return micLevel;
    }
    function playTone(ctx, out, freq, time, wave, gain, attack, release) {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, time);
      amp.gain.setValueAtTime(0.0001, time);
      amp.gain.exponentialRampToValueAtTime(gain, time + attack);
      amp.gain.exponentialRampToValueAtTime(0.0001, time + release);
      osc.connect(amp).connect(out);
      osc.start(time);
      osc.stop(time + release + 0.03);
    }
    function playChime(repo, strength = 1, kind = "modify") {
      if (!audioUnlocked) return;
      const ctx = audioContext();
      const now = ctx.currentTime;
      if (now - lastTone < 0.045) return;
      lastTone = now;
      const tone = repoTone(repo);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const filter = ctx.createBiquadFilter();
      const wet = ctx.createGain();
      filter.type = (tone.hash >>> 2) & 1 ? "bandpass" : "highpass";
      filter.frequency.setValueAtTime(kind === "delete" ? tone.filter * 0.62 : tone.filter, now);
      filter.Q.setValueAtTime(tone.q, now);
      wet.gain.setValueAtTime(Math.min(0.4, 0.1 + strength * 0.03 + ((tone.hash >>> 21) % 7) * 0.006), now);
      if (pan) {
        pan.pan.setValueAtTime(tone.pan, now);
        filter.connect(pan).connect(wet).connect(ctx.destination);
      } else {
        filter.connect(wet).connect(ctx.destination);
      }
      const base = kind === "delete" ? tone.base * 0.62 : tone.base;
      const gap = 0.018 + ((tone.hash >>> 9) % 12) * 0.0025;
      const accentWave = ((tone.hash >>> 13) & 1) ? "triangle" : "sine";
      playTone(ctx, filter, base, now, tone.wave, 0.62, tone.attack, tone.release);
      playTone(ctx, filter, tone.high, now + gap, accentWave, 0.32, 0.004, tone.release * 0.82);
      playTone(ctx, filter, tone.air, now + gap * 2.1, "sine", 0.16, 0.003, tone.release * 0.66);
    }
    function playManualPing(strength = 1) {
      if (!audioUnlocked) return;
      const ctx = audioContext();
      const now = ctx.currentTime;
      if (now - lastTone < 0.045) return;
      lastTone = now;
      const filter = ctx.createBiquadFilter();
      const wet = ctx.createGain();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(1040, now);
      filter.Q.setValueAtTime(6.5, now);
      wet.gain.setValueAtTime(Math.min(0.32, 0.14 + strength * 0.035), now);
      filter.connect(wet).connect(ctx.destination);
      playTone(ctx, filter, 880, now, "sine", 0.48, 0.003, 0.08);
      playTone(ctx, filter, 1320, now + 0.018, "triangle", 0.18, 0.002, 0.06);
      playTone(ctx, filter, 1760, now + 0.04, "sine", 0.09, 0.002, 0.05);
    }
    function playHandGestureTone(strength = 1) {
      if (!audioUnlocked) return;
      const ctx = audioContext();
      const now = ctx.currentTime;
      if (now - lastTone < 0.045) return;
      lastTone = now;
      const filter = ctx.createBiquadFilter();
      const wet = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1480, now);
      filter.frequency.exponentialRampToValueAtTime(520, now + 0.22);
      filter.Q.setValueAtTime(4.2, now);
      wet.gain.setValueAtTime(Math.min(0.28, 0.13 + strength * 0.03), now);
      if (pan) {
        pan.pan.setValueAtTime(0.36, now);
        filter.connect(pan).connect(wet).connect(ctx.destination);
      } else {
        filter.connect(wet).connect(ctx.destination);
      }
      playTone(ctx, filter, 520, now, "triangle", 0.42, 0.008, 0.22);
      playTone(ctx, filter, 390, now + 0.035, "sine", 0.2, 0.012, 0.26);
      playTone(ctx, filter, 780, now + 0.08, "sine", 0.08, 0.006, 0.18);
    }
    function playWallDing(strength = 1) {
      if (!audioUnlocked) return;
      const ctx = audioContext();
      const now = ctx.currentTime;
      if (now - lastTone < 0.045) return;
      lastTone = now;
      const filter = ctx.createBiquadFilter();
      const wet = ctx.createGain();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(1380 + Math.min(420, strength * 280), now);
      filter.Q.setValueAtTime(9.5, now);
      wet.gain.setValueAtTime(Math.min(0.3, 0.08 + strength * 0.09), now);
      filter.connect(wet).connect(ctx.destination);
      playTone(ctx, filter, 980 + strength * 120, now, "sine", 0.36, 0.002, 0.11);
      playTone(ctx, filter, 1460 + strength * 160, now + 0.014, "triangle", 0.14, 0.002, 0.08);
    }

    function makeEnvironmentTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 512;
      const ctx = canvas.getContext("2d");
      const sky = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      sky.addColorStop(0, "#fffdf5");
      sky.addColorStop(0.22, "#ffe25a");
      sky.addColorStop(0.48, "#ff5a00");
      sky.addColorStop(0.74, "#5b0712");
      sky.addColorStop(1, "#fff7dc");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const glow = ctx.createRadialGradient(220, 120, 20, 220, 120, 360);
      glow.addColorStop(0, "rgba(255,255,255,.9)");
      glow.addColorStop(0.22, "rgba(255,246,120,.45)");
      glow.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const warm = ctx.createRadialGradient(760, 360, 40, 760, 360, 420);
      warm.addColorStop(0, "rgba(255,30,0,.7)");
      warm.addColorStop(0.3, "rgba(255,196,30,.34)");
      warm.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }
    const environment = makeEnvironmentTexture();
    scene.environment = environment;

    const shapeMorphGLSL = [
      "uniform float shapeFrom;",
      "uniform float shapeTo;",
      "uniform float shapeMix;",
      "uniform float shapeNoise;",
      "vec3 orbShapeTarget(vec3 p,float shape){",
      "  float radius=max(0.0001,length(p));",
      "  vec3 n=normalize(p);",
      "  vec3 sphere=p;",
      "  float cubeFace=max(max(abs(n.x),abs(n.y)),abs(n.z));",
      "  vec3 cube=n/cubeFace*radius*0.82;",
      "  float xz=max(max(abs(n.x),abs(n.z)),0.001);",
      "  vec2 square=n.xz/xz;",
      "  float h=clamp((n.y+1.0)*0.5,0.0,1.0);",
      "  float pyramidWidth=mix(1.02,0.045,h);",
      "  vec3 pyramid=vec3(square.x*pyramidWidth,n.y*1.12,square.y*pyramidWidth)*radius*0.92;",
      "  float projectMix=smoothstep(1.0,2.0,shape);",
      "  vec3 projectShape=mix(pyramid,cube,projectMix);",
      "  return mix(sphere,projectShape,step(0.001,shape));",
      "}",
      "vec3 orbMorphPosition(vec3 p){",
      "  float eased=shapeMix*shapeMix*(3.0-2.0*shapeMix);",
      "  vec3 shaped=mix(orbShapeTarget(p,shapeFrom),orbShapeTarget(p,shapeTo),eased);",
      "  float n=sin(p.x*7.1+p.y*3.8+p.z*5.7)+0.55*sin(p.x*13.4-p.y*8.2+p.z*4.1);",
      "  n+=0.28*sin(p.x*21.0+p.y*15.0-p.z*12.0);",
      "  return shaped+normalize(shaped+vec3(0.0001))*n*0.035*shapeNoise;",
      "}",
    ].join("\\n");

    function superellipsoidGeometry(width, height, depth, nu, nv, power, warp = 0) {
      const positions = [];
      const normals = [];
      const uCount = nu;
      const vCount = nv;
      const signedPow = (value, p) => Math.sign(value) * Math.pow(Math.abs(value), p);
      const poleEps = 0.035;
      const addVertex = (px, py, pz) => {
        positions.push(px, py, pz);
        normals.push(px / width, py / height, pz / depth);
        return positions.length / 3 - 1;
      };
      const topIndex = addVertex(0, height, 0);
      const bottomIndex = addVertex(0, -height, 0);
      for (let y = 0; y <= vCount; y++) {
        const v = -Math.PI / 2 + poleEps + (Math.PI - poleEps * 2) * y / vCount;
        for (let x = 0; x <= uCount; x++) {
          const u = -Math.PI + Math.PI * 2 * x / uCount;
          const cu = Math.cos(u), su = Math.sin(u);
          const cv = Math.cos(v), sv = Math.sin(v);
          const organic = 1 + warp * (
            Math.sin(u * 3.0 + v * 4.7) * 0.55 +
            Math.sin(u * 7.0 - v * 2.3) * 0.25 +
            Math.cos(u * 2.0 + v * 8.0) * 0.2
          );
          const px = width * organic * signedPow(cv, power) * signedPow(cu, power);
          const py = height * organic * signedPow(sv, power);
          const pz = depth * organic * signedPow(cv, power) * signedPow(su, power);
          addVertex(px, py, pz);
        }
      }
      const indices = [];
      for (let y = 0; y < vCount; y++) {
        for (let x = 0; x < uCount; x++) {
          const a = 2 + y * (uCount + 1) + x;
          const b = a + 1;
          const c = a + (uCount + 1);
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      const row = uCount + 1;
      const firstRow = 2;
      const lastRow = 2 + vCount * row;
      for (let x = 0; x < uCount; x++) {
        indices.push(bottomIndex, firstRow + x, firstRow + x + 1);
        indices.push(topIndex, lastRow + x + 1, lastRow + x);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }

    const shellGeo = new THREE.SphereGeometry(1.82, 192, 96);
    const shellMat = new THREE.MeshPhysicalMaterial({
      color: 0xffd15a,
      metalness: 0,
      roughness: 0,
      transmission: 0.99,
      thickness: 7.4,
      ior: 1.78,
      transparent: true,
      opacity: 1,
      clearcoat: 1,
      clearcoatRoughness: 0,
      specularIntensity: 2.6,
      specularColor: 0xfff0b8,
      iridescence: 0.42,
      iridescenceIOR: 1.45,
      iridescenceThicknessRange: [140, 420],
      dispersion: 1.25,
      attenuationColor: 0xff6b00,
      attenuationDistance: 0.2,
      envMapIntensity: 26.0,
      side: THREE.DoubleSide,
    });
    const shellLook = {
      lavaColor: new THREE.Color(0xffd15a),
      waterColor: new THREE.Color(0xffffff),
      lavaAttenuation: new THREE.Color(0xff6b00),
      waterAttenuation: new THREE.Color(0xffffff),
      lavaSpecular: new THREE.Color(0xfff0b8),
      waterSpecular: new THREE.Color(0xffdfa6),
    };
    shellMat.onBeforeCompile = (shader) => {
      shader.uniforms.shapeFrom = shapeUniforms.shapeFrom;
      shader.uniforms.shapeTo = shapeUniforms.shapeTo;
      shader.uniforms.shapeMix = shapeUniforms.shapeMix;
      shader.uniforms.shapeNoise = shapeUniforms.shapeNoise;
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", shapeMorphGLSL + "\\nvoid main() {")
        .replace("#include <begin_vertex>", "vec3 transformed = orbMorphPosition(position);");
    };
    shellMat.customProgramCacheKey = () => "machine-orb-shape-morph";
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.scale.set(1.0, 1.0, 1.0);
    shell.material.depthWrite = false;
    shell.renderOrder = 4;
    group.add(shell);

    const glossMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, pulse, visualShine: { value: 1 }, distanceBoost: { value: 0 }, ...shapeUniforms },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
      vertexShader: [
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        shapeMorphGLSL,
        "void main(){",
        "  vec3 morphed=orbMorphPosition(position);",
        "  vPos=morphed;",
        "  vNormal=normalize(normalMatrix*normal);",
        "  gl_Position=projectionMatrix*modelViewMatrix*vec4(morphed,1.0);",
        "}"
      ].join("\\n"),
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float visualShine;",
        "uniform float distanceBoost;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "void main(){",
        "  vec2 p=vPos.xy/vec2(2.34,2.18);",
        "  float fres=pow(1.0-abs(vNormal.z),1.28);",
        "  float broad=smoothstep(0.98,0.06,length(p-vec2(-0.48,0.36)));",
        "  float lower=smoothstep(0.48,0.0,length(p-vec2(-0.42,-0.58)));",
        "  float right=smoothstep(0.12,0.86,p.x+sin(p.y*3.2+time*0.18)*0.035);",
        "  float rightBand=right*smoothstep(0.98,0.72,length(p-vec2(0.1,-0.05)));",
        "  float crescent=smoothstep(0.22,0.0,abs(length(p-vec2(-0.1,0.03))-0.86))*smoothstep(0.72,-0.18,p.y);",
        "  float amberEdge=smoothstep(0.16,0.0,abs(length(p)-0.88))*smoothstep(-0.78,0.42,p.x-p.y*0.12);",
        "  float shine=clamp(fres*1.0+broad*0.76+lower*0.3+rightBand*0.42+crescent*0.22+amberEdge*0.26+pulse*0.08,0.0,1.0);",
        "  vec3 cream=vec3(1.0,0.88,0.48);",
        "  vec3 amber=vec3(1.0,0.42,0.02);",
        "  vec3 col=mix(amber,cream,0.78);",
        "  col=mix(col,vec3(1.0,0.54,0.02),amberEdge*0.34);",
        "  shine+=distanceBoost*(0.18+fres*0.42+amberEdge*0.2);",
        "  gl_FragColor=vec4(col,shine*0.64*visualShine);",
        "}"
      ].join("\\n"),
    });
    const gloss = new THREE.Mesh(shellGeo.clone(), glossMat);
    gloss.scale.copy(shell.scale).multiplyScalar(1.002);
    gloss.renderOrder = 5;
    group.add(gloss);

    const glossPopMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, pulse, visualShine: { value: 1 }, distanceBoost: { value: 0 }, ...shapeUniforms },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
      vertexShader: [
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        shapeMorphGLSL,
        "void main(){",
        "  vec3 morphed=orbMorphPosition(position);",
        "  vPos=morphed;",
        "  vNormal=normalize(normalMatrix*normal);",
        "  gl_Position=projectionMatrix*modelViewMatrix*vec4(morphed,1.0);",
        "}"
      ].join("\\n"),
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float visualShine;",
        "uniform float distanceBoost;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "void main(){",
        "  vec2 p=vPos.xy/vec2(2.2,2.08);",
        "  float leftSlash=smoothstep(0.08,0.0,abs((p.x+p.y*0.38)+0.52))*smoothstep(0.84,-0.18,p.y)*smoothstep(-0.95,-0.18,p.x);",
        "  float topWash=smoothstep(0.9,0.18,length(p-vec2(-0.46,0.44)));",
        "  float rim=pow(1.0-abs(vNormal.z),0.82);",
        "  float mask=smoothstep(1.1,0.64,length(p));",
        "  float shine=(leftSlash*0.26+topWash*0.18+rim*(0.1+distanceBoost*0.32)+pulse*0.02+distanceBoost*0.08)*mask;",
        "  vec3 col=mix(vec3(0.92,0.2,0.0),vec3(1.0,0.78,0.36),0.72);",
        "  gl_FragColor=vec4(col,clamp(shine*visualShine,0.0,0.3));",
        "}"
      ].join("\\n"),
    });
    const glossPop = new THREE.Mesh(shellGeo.clone(), glossPopMat);
    glossPop.scale.copy(shell.scale).multiplyScalar(1.004);
    glossPop.renderOrder = 6;
    group.add(glossPop);

    const waterRimMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        pulse,
        waterFill: { value: 0.24 },
        visualShine: { value: 1 },
        distanceBoost: { value: 0 },
        viscosity: { value: 0.68 },
        worldDown: { value: new THREE.Vector3(0, -1, 0) },
        clingDir: { value: new THREE.Vector3(0, 1, 0) },
        cling: { value: 0 },
        ...shapeUniforms,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
      vertexShader: [
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        shapeMorphGLSL,
        "void main(){",
        "  vec3 morphed=orbMorphPosition(position);",
        "  vPos=morphed;",
        "  vNormal=normalize(normalMatrix*normal);",
        "  gl_Position=projectionMatrix*modelViewMatrix*vec4(morphed,1.0);",
        "}"
      ].join("\\n"),
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float waterFill;",
        "uniform float visualShine;",
        "uniform float distanceBoost;",
        "uniform float viscosity;",
        "uniform vec3 worldDown;",
        "uniform vec3 clingDir;",
        "uniform float cling;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "void main(){",
        "  vec2 p=vPos.xy/vec2(2.2,2.08);",
        "  vec3 n=normalize(vPos);",
        "  vec3 down=normalize(worldDown+vec3(0.0001,-0.0001,0.0001));",
        "  float edge=pow(1.0-abs(vNormal.z),0.54);",
        "  float outline=smoothstep(0.5,1.0,edge);",
        "  float lower=smoothstep(-0.94,-0.1,-p.y+p.x*0.08);",
        "  float baseBand=smoothstep(0.16,0.0,abs(length(p)-0.88))*smoothstep(-0.9,0.35,p.x-p.y*0.12);",
        "  float topWash=smoothstep(1.05,0.16,length(p-vec2(-0.48,0.46)));",
        "  float oldWall=pow(max(0.0,dot(n,normalize(clingDir))),1.45);",
        "  float verticalRun=pow(max(0.0,dot(n,down))*0.7+0.3,0.55);",
        "  float streaks=0.45+0.55*smoothstep(-0.35,1.0,sin(p.x*14.0+p.y*5.0+time*mix(0.42,0.055,viscosity)));",
        "  float sheets=smoothstep(0.18,0.95,oldWall)*(0.55+0.45*streaks);",
        "  float film=cling*(0.35*oldWall+sheets)*(0.45+0.55*verticalRun);",
        "  float emptyBoost=1.0-waterFill;",
        "  float a=outline*(0.16+emptyBoost*0.26+distanceBoost*0.34)+baseBand*(0.24+emptyBoost*0.18+distanceBoost*0.28)+topWash*(0.12+distanceBoost*0.12)+film*(0.78+viscosity*1.25)+pulse*0.025;",
        "  vec3 col=mix(vec3(1.0,0.62,0.08),vec3(1.0,0.9,0.5),0.42+topWash*0.28);",
        "  col=mix(col,vec3(0.92,0.24,0.0),lower*0.18+film*0.78);",
        "  gl_FragColor=vec4(col,clamp(a*visualShine,0.0,1.0));",
        "}"
      ].join("\\n"),
    });
    const waterRim = new THREE.Mesh(shellGeo.clone(), waterRimMat);
    waterRim.scale.copy(shell.scale).multiplyScalar(1.006);
    waterRim.renderOrder = 7;
    waterRim.visible = false;
    group.add(waterRim);

    const coreUniforms = {
      time: { value: 0 },
      pulse: pulse,
      dance: dance,
      projectGlow: { value: 0 },
      projectColor: { value: new THREE.Color(0xffd52a) },
      projectSpot: { value: new THREE.Vector2(0.18, -0.12) },
      agitation: { value: 0 },
      worldDown: { value: new THREE.Vector3(0, -1, 0) },
      denseOffset: { value: new THREE.Vector2(0, -0.22) },
      vortexSwirl: { value: 1 },
      vortexSpeed: { value: 1 },
      vortexSoft: { value: 1 },
      vortexGlass: { value: 1 },
      visualCore: { value: 1 },
      visualHeat: { value: 1 },
      visualContrast: { value: 1 },
      distanceBoost: { value: 0 },
      ...shapeUniforms,
    };
    const coreMat = new THREE.ShaderMaterial({
      uniforms: coreUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      vertexShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float dance;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        shapeMorphGLSL,
        "void main(){",
        "  vec3 morphed=orbMorphPosition(position);",
        "  vPos=morphed;",
        "  vNormal=normalize(normalMatrix*normal);",
        "  float wave=sin(position.y*3.2+position.x*1.6+position.z*1.1+time*0.28)*0.004;",
        "  wave+=sin(position.x*2.1-position.y*2.7+time*0.55)*0.005;",
        "  wave+=sin(position.z*2.2+position.x*1.2-time*0.5)*0.006*dance;",
        "  vec3 displaced=morphed+normal*(wave+pulse*0.006+dance*0.018);",
        "  gl_Position=projectionMatrix*modelViewMatrix*vec4(displaced,1.0);",
        "}"
      ].join("\\n"),
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float dance;",
        "uniform float projectGlow;",
        "uniform float agitation;",
        "uniform vec3 projectColor;",
        "uniform vec2 projectSpot;",
        "uniform vec3 worldDown;",
        "uniform vec2 denseOffset;",
        "uniform float vortexSwirl;",
        "uniform float vortexSpeed;",
        "uniform float vortexSoft;",
        "uniform float vortexGlass;",
        "uniform float visualCore;",
        "uniform float visualHeat;",
        "uniform float visualContrast;",
        "uniform float distanceBoost;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "void main(){",
        "  vec2 p=vPos.xy/vec2(2.28,2.08);",
        "  float side=pow(1.0-abs(vNormal.z),1.05);",
        "  vec2 q=p;",
        "  float churn=min(0.62,agitation)*0.28+min(0.8,dance)*0.045+min(1.2,pulse)*0.012;",
        "  float flowTime=time*vortexSpeed;",
        "  q.x+=sin(p.y*(1.9+churn*0.45)+flowTime*(0.09+churn*0.12))*0.038*vortexSwirl+sin(flowTime*(0.12+churn*0.09)+p.y*3.2+p.x*1.2)*0.018*(0.35+churn)*vortexSwirl;",
        "  q.y+=sin(p.x*(1.8+churn*0.42)-flowTime*(0.08+churn*0.1))*0.034*vortexSwirl+cos(flowTime*(0.11+churn*0.09)+p.x*3.0-p.y)*0.016*(0.35+churn)*vortexSwirl;",
        "  float swirl=sin((q.x*(2.8+churn*0.42)+q.y*1.45)+flowTime*(0.16+churn*0.16))+0.65*sin((q.x*4.4-q.y*(3.1+churn*0.45))-flowTime*(0.14+churn*0.14));",
        "  float cell=sin(length(q-vec2(-0.38,-0.28))*4.8-flowTime*(0.16+churn*0.18))+0.75*sin(length(q-vec2(0.34,0.2))*4.2+flowTime*(0.14+churn*0.16));",
        "  float lava=(swirl*(0.13+churn*0.035)+cell*(0.08+churn*0.026))*vortexSwirl;",
        "  vec2 gravity=normalize(worldDown.xy+vec2(0.0001,-0.0001));",
        "  float depth=dot(p-denseOffset,gravity);",
        "  float dense=smoothstep(0.2,-0.78,depth+lava*0.22);",
        "  dense+=smoothstep(0.46,-0.08,distance(p,denseOffset+gravity*0.26)+swirl*0.018)*0.32;",
        "  dense=clamp(dense,0.0,1.0);",
        "  vec2 hotDrift=vec2(sin(flowTime*0.055)*0.18,cos(flowTime*0.043)*0.12)+denseOffset*0.34;",
        "  vec2 coolDrift=vec2(cos(flowTime*0.041+1.7)*0.2,sin(flowTime*0.052+0.8)*0.16)-denseOffset*0.24;",
        "  float hotPool=smoothstep(1.18*vortexSoft,0.18,length(q-vec2(-0.36,-0.34)-hotDrift)+lava*0.06);",
        "  float coolPool=smoothstep(1.05*vortexSoft,0.08,length(q-vec2(0.42,0.2)-coolDrift)-lava*0.04);",
        "  float heat=clamp(0.58+hotPool*0.32-coolPool*0.16+lava*0.12+pulse*0.035+dance*0.08,0.0,1.0);",
        "  heat=clamp((heat-0.5)*(0.72+visualContrast*0.74)+0.5+(visualHeat-1.0)*0.24,0.0,1.0);",
        "  float glow=smoothstep(1.04,-0.36,length(p-vec2(-0.42,-0.34)-hotDrift*0.4)+swirl*0.035);",
        "  float projectSignal=smoothstep(0.08,0.42,projectGlow);",
        "  float projectBloom=smoothstep(0.36,0.0,length(q-projectSpot)+swirl*0.025);",
        "  projectBloom*=projectSignal*min(1.0,projectGlow);",
        "  float glass=pow(1.0-smoothstep(0.62,1.16,length(p)),2.0);",
        "  vec3 yellow=mix(vec3(1.0,0.78,0.02),vec3(1.0,0.98,0.2),visualHeat*0.38);",
        "  vec3 orange=mix(vec3(0.86,0.2,0.0),vec3(1.0,0.46,0.0),visualHeat*0.42);",
        "  vec3 red=mix(vec3(0.54,0.0,0.0),vec3(1.0,0.04,0.0),visualHeat*0.32);",
        "  vec3 ember=mix(vec3(0.16,0.012,0.0),vec3(0.58,0.03,0.0),visualHeat*0.32);",
        "  vec3 col=mix(yellow,orange,heat);",
        "  col=mix(col,red,smoothstep(0.34,1.0,heat+lava*0.28)*0.38+dense*0.08);",
        "  col=mix(col,ember,dense*0.09+smoothstep(0.62,1.18,heat+side*0.25)*0.07);",
        "  col=mix(col,vec3(1.0,0.84,0.18),glow*(0.22+visualHeat*0.18));",
        "  col=mix(col,projectColor,projectBloom*0.34);",
        "  col=mix(vec3(1.0,0.62,0.02),col,0.7+glass*0.12+visualContrast*0.08);",
        "  float fres=pow(1.0-abs(vNormal.z),1.2);",
        "  float topEdge=smoothstep(0.36,0.9,p.y-p.x*0.1);",
        "  float veins=0.5+0.5*sin(p.x*11.0+p.y*8.0+swirl*1.3+time*0.42);",
        "  float shadow=smoothstep(-0.28,0.9,-p.y+p.x*0.2);",
        "  col=mix(col,vec3(0.18,0.02,0.0),topEdge*0.035+side*0.07);",
        "  col+=pow(max(0.0,swirl*0.5+0.5),2.0)*(0.045+visualContrast*0.035+dance*0.025+churn*0.03)+veins*(0.004+visualContrast*0.012+churn*0.008)+pulse*0.055+distanceBoost*0.16+projectColor*projectBloom*0.12;",
      "  gl_FragColor=vec4(col,(0.84+shadow*0.05+side*0.03+distanceBoost*0.2)*vortexGlass*visualCore);",
        "}"
      ].join("\\n"),
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.64, 192, 96), coreMat);
    core.position.set(0, 0, 0);
    core.rotation.z = -0.035;
    core.scale.set(1.0, 1.0, 1.0);
    core.renderOrder = 1;
    group.add(core);

    const fluidUniforms = {
      time: coreUniforms.time,
      pulse,
      agitation: coreUniforms.agitation,
      projectGlow: coreUniforms.projectGlow,
      projectColor: coreUniforms.projectColor,
      worldDown: coreUniforms.worldDown,
      denseOffset: coreUniforms.denseOffset,
      vortexSpeed: coreUniforms.vortexSpeed,
      vortexSwirl: coreUniforms.vortexSwirl,
      ...shapeUniforms,
    };
    const fluidMat = new THREE.ShaderMaterial({
      uniforms: fluidUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
      vertexShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float agitation;",
        "uniform vec3 worldDown;",
        "uniform float vortexSpeed;",
        "uniform float vortexSwirl;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "varying vec3 vLocal;",
        shapeMorphGLSL,
        "void main(){",
        "  vec3 n=normalize(position);",
        "  vec3 down=normalize(worldDown+vec3(0.0001,-0.0001,0.0001));",
        "  float bottom=max(0.0,dot(n,down));",
        "  float side=1.0-abs(dot(n,down));",
        "  float slow=time*vortexSpeed*(0.055+agitation*0.05);",
        "  float fold=sin(position.x*2.0+slow*1.4)+sin(position.y*1.8-slow*1.1)+sin(position.z*2.2+slow*0.8);",
        "  float lobe=sin(position.x*3.1-position.z*1.2+slow*1.6)*sin(position.y*2.4+slow*0.7);",
        "  float sag=bottom*0.22-side*0.055;",
        "  float churn=(fold*(0.026+agitation*0.05)+lobe*(0.028+agitation*0.04))*vortexSwirl+pulse*0.014;",
        "  vec3 local=position;",
        "  local+=down*sag;",
        "  local+=normal*(churn+bottom*0.035);",
        "  vec3 morphed=orbMorphPosition(local);",
        "  vLocal=local;",
        "  vPos=morphed;",
        "  vNormal=normalize(normalMatrix*normal);",
        "  gl_Position=projectionMatrix*modelViewMatrix*vec4(morphed,1.0);",
        "}"
      ].join("\\n"),
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float agitation;",
        "uniform float projectGlow;",
        "uniform vec3 projectColor;",
        "uniform vec3 worldDown;",
        "uniform float vortexSpeed;",
        "uniform float vortexSwirl;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "varying vec3 vLocal;",
        "void main(){",
        "  vec3 down=normalize(worldDown+vec3(0.0001,-0.0001,0.0001));",
        "  float bottom=max(0.0,dot(normalize(vLocal),down));",
        "  float rim=pow(1.0-abs(vNormal.z),1.6);",
        "  float slow=time*vortexSpeed*(0.07+agitation*0.08);",
        "  float eddy=(sin(vLocal.x*3.1+vLocal.y*1.4+slow)+0.7*sin(vLocal.z*2.8-vLocal.y*1.7-slow*0.65))*vortexSwirl;",
        "  float dense=smoothstep(0.16,0.86,bottom+eddy*0.08);",
        "  float skin=smoothstep(0.9,0.24,length(vLocal));",
        "  float boundary=smoothstep(0.38,0.7,bottom+eddy*0.1);",
        "  vec3 ember=vec3(0.62,0.04,0.0);",
        "  vec3 red=vec3(1.0,0.08,0.0);",
        "  vec3 orange=vec3(1.0,0.42,0.0);",
        "  vec3 gold=vec3(1.0,0.92,0.12);",
        "  vec3 col=mix(red,ember,dense*0.34);",
        "  col=mix(col,orange,smoothstep(-0.2,0.7,eddy)*0.36);",
        "  col=mix(col,gold,pow(max(0.0,1.0-dense),2.2)*0.22+pulse*0.025);",
        "  col=mix(col,projectColor,min(0.55,projectGlow)*0.16);",
        "  float alpha=(0.12+dense*0.16+rim*0.06+projectGlow*0.04);",
        "  alpha*=skin;",
        "  gl_FragColor=vec4(col,clamp(alpha,0.0,0.34));",
        "}"
      ].join("\\n"),
    });
    const fluid = new THREE.Mesh(new THREE.SphereGeometry(1.02, 128, 64), fluidMat);
    fluid.position.set(0, -0.18, 0.08);
    fluid.scale.set(1.0, 0.58, 0.84);
    fluid.renderOrder = 1;
    group.add(fluid);

    const waterUniforms = {
      time: coreUniforms.time,
      pulse,
      agitation: coreUniforms.agitation,
      projectGlow: coreUniforms.projectGlow,
      projectColor: coreUniforms.projectColor,
      worldDown: coreUniforms.worldDown,
      fillLevel: { value: -1.32 },
      surfaceTilt: { value: new THREE.Vector2(0, 0) },
      viscosity: { value: 0.68 },
      wavesOn: { value: 1 },
      density: { value: 0.68 },
      ...shapeUniforms,
    };
    const waterVolumeMat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      vertexShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float agitation;",
        "uniform float viscosity;",
        "uniform float wavesOn;",
        "varying vec3 vLocal;",
        "varying vec3 vNormal;",
        shapeMorphGLSL,
        "void main(){",
        "  vec3 n=normalize(position);",
        "  float speed=mix(0.7,0.12,viscosity);",
        "  float amp=mix(0.032,0.006,viscosity)*wavesOn;",
        "  float heavy=sin(position.x*2.2+time*speed)+sin(position.z*2.0-time*speed*0.82);",
        "  vec3 local=position+n*(heavy*amp*agitation+pulse*mix(0.012,0.003,viscosity)*wavesOn);",
        "  vLocal=local;",
        "  vNormal=normalize(normalMatrix*normal);",
        "  gl_Position=projectionMatrix*modelViewMatrix*vec4(orbMorphPosition(local),1.0);",
        "}"
      ].join("\\n"),
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "uniform float agitation;",
        "uniform float projectGlow;",
        "uniform vec3 projectColor;",
        "uniform vec3 worldDown;",
        "uniform float fillLevel;",
        "uniform vec2 surfaceTilt;",
        "uniform float viscosity;",
        "uniform float density;",
        "varying vec3 vLocal;",
        "varying vec3 vNormal;",
        "void main(){",
        "  vec3 down=normalize(worldDown+vec3(0.0001,-0.0001,0.0001));",
        "  vec3 up=-down;",
        "  float h=dot(vLocal,up)+dot(vLocal.xz,surfaceTilt)*0.34;",
        "  float meniscus=mix(0.13,0.035,density);",
        "  float below=1.0-smoothstep(fillLevel-0.055,fillLevel+meniscus,h);",
        "  if (below<0.01) discard;",
        "  float depth=smoothstep(fillLevel+0.02,-1.18,h);",
        "  float fres=pow(1.0-abs(vNormal.z),1.15);",
        "  float slow=time*mix(0.12,0.025,viscosity);",
        "  float eddy=0.5+0.5*sin(vLocal.x*3.8+vLocal.z*1.5+slow)+0.2*sin(vLocal.z*3.2-vLocal.y*1.8-slow*0.8);",
        "  vec3 amber=mix(vec3(1.0,0.34,0.0),vec3(0.9,0.22,0.0),density);",
        "  vec3 deep=mix(vec3(0.58,0.06,0.0),vec3(0.22,0.018,0.0),density);",
        "  vec3 honey=mix(vec3(1.0,0.68,0.12),vec3(0.95,0.42,0.03),density);",
        "  vec3 col=mix(amber,deep,depth*(0.42+0.42*density));",
        "  col=mix(col,honey,eddy*(0.12-0.07*density)+pulse*(0.03-0.02*density));",
        "  col=mix(col,projectColor,min(0.5,projectGlow)*(0.18-0.1*density));",
        "  col*=mix(1.0,0.58,density*smoothstep(0.1,1.0,depth));",
        "  float alpha=(0.32+depth*(0.28+0.36*density)+fres*(0.12+0.08*density)+agitation*(0.04-0.025*density)+projectGlow*0.04)*below;",
        "  gl_FragColor=vec4(col,clamp(alpha,0.0,mix(0.62,0.93,density)));",
        "}"
      ].join("\\n"),
    });
    const waterVolume = new THREE.Mesh(new THREE.SphereGeometry(1.68, 192, 96), waterVolumeMat);
    waterVolume.renderOrder = 1;
    waterVolume.visible = false;
    group.add(waterVolume);

    const lavaLobeGeo = new THREE.SphereGeometry(0.72, 96, 48);
    function makeLavaLobe(color, phase, scale, alpha) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          time: coreUniforms.time,
          pulse,
          agitation: coreUniforms.agitation,
          tint: { value: new THREE.Color(color) },
          phase: { value: phase },
          alpha: { value: alpha },
          ...shapeUniforms,
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        blending: THREE.NormalBlending,
        vertexShader: [
          "uniform float time;",
          "uniform float pulse;",
          "uniform float agitation;",
          "uniform float phase;",
          "varying vec3 vLocal;",
          "varying vec3 vNormal;",
          shapeMorphGLSL,
          "void main(){",
          "  float slow=time*(0.045+agitation*0.035)+phase;",
          "  vec3 n=normalize(position);",
          "  float swell=sin(position.x*2.4+slow)*0.035+sin(position.y*2.1-slow*0.8)*0.026+sin(position.z*2.7+slow*0.6)*0.022;",
          "  vec3 local=position+n*(swell+pulse*0.006);",
          "  vLocal=local;",
          "  vNormal=normalize(normalMatrix*normal);",
          "  vec3 morphed=orbMorphPosition(local);",
          "  gl_Position=projectionMatrix*modelViewMatrix*vec4(morphed,1.0);",
          "}"
        ].join("\\n"),
        fragmentShader: [
          "uniform float time;",
          "uniform float agitation;",
          "uniform vec3 tint;",
          "uniform float phase;",
          "uniform float alpha;",
          "varying vec3 vLocal;",
          "varying vec3 vNormal;",
          "void main(){",
          "  float slow=time*(0.052+agitation*0.04)+phase;",
          "  float r=length(vLocal);",
          "  float skin=smoothstep(0.98,0.18,r);",
          "  float rim=pow(1.0-abs(vNormal.z),1.45);",
          "  float fold=0.5+0.5*sin(vLocal.x*3.4+vLocal.y*1.8+slow)+0.25*sin(vLocal.z*4.0-vLocal.y*2.0-slow*0.7);",
          "  vec3 hot=vec3(1.0,0.9,0.08);",
          "  vec3 red=vec3(1.0,0.05,0.0);",
          "  vec3 col=mix(tint,red,smoothstep(0.25,1.0,fold)*0.28);",
          "  col=mix(col,hot,pow(max(0.0,1.0-r),2.0)*0.28);",
          "  float a=alpha*skin*(0.54+fold*0.16+rim*0.12);",
          "  gl_FragColor=vec4(col,clamp(a,0.0,0.24));",
          "}"
        ].join("\\n"),
      });
      const mesh = new THREE.Mesh(lavaLobeGeo, mat);
      mesh.userData.phase = phase;
      mesh.userData.baseScale = scale;
      mesh.renderOrder = 1;
      group.add(mesh);
      return mesh;
    }
    const lavaLobes = [
      makeLavaLobe(0xff5a00, 0.4, new THREE.Vector3(0.82, 0.34, 0.52), 0.13),
      makeLavaLobe(0xffb000, 2.1, new THREE.Vector3(0.56, 0.3, 0.46), 0.11),
      makeLavaLobe(0xff2400, 4.2, new THREE.Vector3(0.68, 0.26, 0.4), 0.1),
    ];
    const waterSlosh = { x: 0, y: 0, vx: 0, vy: 0, amp: 0, gx: 0, gy: -1, gz: 0, cling: 0, clingX: 0, clingY: 1, clingZ: 0 };
    lavaLobes.forEach((lobe) => {
      lobe.userData.baseAlpha = lobe.material.uniforms.alpha.value;
    });
    function applyLayerVisibility() {
      const isWater = orbMode.value === "water";
      shell.visible = layerSettings.shell;
      gloss.visible = !isWater && layerSettings.gloss;
      glossPop.visible = !isWater && layerSettings.gloss;
      core.visible = !isWater && layerSettings.core;
      fluid.visible = !isWater && layerSettings.fluid;
      lavaLobes.forEach((lobe) => { lobe.visible = !isWater && layerSettings.lobes; });
      waterVolume.visible = isWater && layerSettings.water;
      waterRim.visible = isWater && layerSettings.water && layerSettings.gloss;
      if (glitter) glitter.visible = !isWater && layerSettings.glitter;
      memoryCanvas.style.display = layerSettings.traces ? "block" : "none";
    }
    function setOrbMode(mode, applyPreset = true) {
      orbMode.value = mode === "water" ? "water" : "lava";
      modeButtons.lava.classList.toggle("is-active", orbMode.value === "lava");
      modeButtons.water.classList.toggle("is-active", orbMode.value === "water");
      const isWater = orbMode.value === "water";
      applyLayerVisibility();
      if (isWater) {
        shellMat.color.copy(shellLook.waterColor);
        shellMat.attenuationColor.copy(shellLook.waterAttenuation);
        shellMat.attenuationDistance = 28.0;
        shellMat.thickness = 0.28;
        shellMat.iridescence = 0.0;
        shellMat.dispersion = 0.08;
        shellMat.ior = 1.5;
        shellMat.specularColor.copy(shellLook.waterSpecular);
        if (applyPreset) {
          setVisualTarget("shine", Math.max(3.0, visualSettings.target.shine));
          setVisualTarget("core", 0.72);
          setVisualTarget("heat", 1.2);
          setVisualTarget("contrast", 0.82);
          setVisualTarget("liquid", 24);
          setVortexTarget("swirl", 0.34);
          setVortexTarget("speed", 0.28);
          setVortexTarget("soft", 1.55);
          setVortexTarget("lobes", 0.2);
          coreUniforms.agitation.value = Math.min(0.38, coreUniforms.agitation.value + 0.08);
        }
      } else {
        shellMat.color.copy(shellLook.lavaColor);
        shellMat.attenuationColor.copy(shellLook.lavaAttenuation);
        shellMat.attenuationDistance = 0.2;
        shellMat.thickness = 7.4;
        shellMat.iridescence = 0.42;
        shellMat.dispersion = 1.25;
        shellMat.ior = 1.78;
        shellMat.specularColor.copy(shellLook.lavaSpecular);
      }
      shellMat.needsUpdate = true;
      applyLayerVisibility();
    }
    modeButtons.lava.addEventListener("click", (event) => {
      event.stopPropagation();
      setOrbMode("lava");
      savePrefs({ orbMode: "lava" });
    });
    modeButtons.water.addEventListener("click", (event) => {
      event.stopPropagation();
      setOrbMode("water");
      savePrefs({ orbMode: "water" });
    });
    function setFrameMode(mode) {
      frameMode.value = mode === "buddy" ? "buddy" : "room";
      frameButtons.room.classList.toggle("is-active", frameMode.value === "room");
      frameButtons.buddy.classList.toggle("is-active", frameMode.value === "buddy");
      document.body.classList.toggle("buddy-mode", frameMode.value === "buddy");
      localStorage.setItem("orbFrameMode", frameMode.value);
      savePrefs({ frameMode: frameMode.value });
    }
    frameButtons.room.addEventListener("click", (event) => {
      event.stopPropagation();
      setFrameMode("room");
    });
    frameButtons.buddy.addEventListener("click", (event) => {
      event.stopPropagation();
      setFrameMode("buddy");
    });
    setFrameMode(frameMode.value);
    ["Swirl", "Speed", "Soft", "Lobes", "Glass", "Ease"].forEach((name) => {
      const key = name.toLowerCase();
      const input = document.getElementById("vortex" + name);
      const value = document.getElementById("vortex" + name + "Value");
      if (savedPrefs.vortex && Object.prototype.hasOwnProperty.call(savedPrefs.vortex, key)) {
        input.value = String(savedPrefs.vortex[key]);
      }
      vortexSettings.controls[key] = { input, value };
      const sync = () => {
        const next = Number(input.value);
        value.textContent = key === "liquid" ? String(Math.round(next)) : next.toFixed(2);
        if (key === "ease") vortexSettings.ease = next;
        else {
          const safeNext = key === "soft" ? Math.max(0.35, next) : next;
          vortexSettings.target[key] = safeNext;
          vortexSettings.current[key] = safeNext;
        }
        savePrefs({ vortex: { ...(savedPrefs.vortex || {}), [key]: next } });
      };
      input.addEventListener("input", sync);
      sync();
    });
    function setVortexTarget(key, value) {
      const control = vortexSettings.controls[key];
      const next = key === "soft" ? Math.max(0.35, value) : value;
      vortexSettings.target[key] = next;
      if (control) {
        control.input.value = String(next);
        control.value.textContent = next.toFixed(2);
      }
      savePrefs({ vortex: { ...(savedPrefs.vortex || {}), [key]: next } });
    }
    ["Shine", "Core", "Heat", "Contrast", "Liquid", "Atmos", "Mic", "Sense", "Idle"].forEach((name) => {
      const key = name.toLowerCase();
      const input = document.getElementById("visual" + name);
      const value = document.getElementById("visual" + name + "Value");
      if (savedPrefs.visual && Object.prototype.hasOwnProperty.call(savedPrefs.visual, key)) {
        input.value = String(savedPrefs.visual[key]);
      }
      visualSettings.controls[key] = { input, value };
      const sync = () => {
        const next = Number(input.value);
        value.textContent = next.toFixed(2);
        visualSettings.target[key] = next;
        visualSettings.current[key] = next;
        savePrefs({ visual: { ...(savedPrefs.visual || {}), [key]: next } });
      };
      input.addEventListener("input", sync);
      sync();
    });
    const waterViscosityInput = document.getElementById("waterViscosity");
    const waterViscosityValue = document.getElementById("waterViscosityValue");
    if (savedPrefs.water && Object.prototype.hasOwnProperty.call(savedPrefs.water, "viscosity")) {
      waterViscosityInput.value = String(savedPrefs.water.viscosity);
    }
    waterViscosityInput.addEventListener("input", () => {
      waterSettings.viscosity = Number(waterViscosityInput.value);
      waterViscosityValue.textContent = String(Math.round(waterSettings.viscosity));
      savePrefs({ water: { ...(savedPrefs.water || {}), viscosity: waterSettings.viscosity } });
    });
    waterSettings.viscosity = Number(waterViscosityInput.value);
    waterViscosityValue.textContent = String(Math.round(waterSettings.viscosity));
    [
      ["Gravity", "gravity"],
      ["Slosh", "slosh"],
      ["Waves", "waves"],
    ].forEach(([name, key]) => {
      const input = document.getElementById("water" + name);
      const value = document.getElementById("water" + name + "Value");
      if (savedPrefs.water && Object.prototype.hasOwnProperty.call(savedPrefs.water, key)) {
        input.checked = Boolean(savedPrefs.water[key]);
      }
      const sync = () => {
        waterSettings[key] = input.checked;
        value.textContent = input.checked ? "on" : "off";
        savePrefs({ water: { ...(savedPrefs.water || {}), [key]: input.checked } });
      };
      input.addEventListener("change", sync);
      sync();
    });
    const shapeDefaultInput = document.getElementById("shapeDefault");
    const shapeDefaultValue = document.getElementById("shapeDefaultValue");
    const shapeNoiseInput = document.getElementById("shapeNoise");
    const shapeNoiseValue = document.getElementById("shapeNoiseValue");
    shapeDefaultInput.value = String(THREE.MathUtils.clamp(shapeSettings.default, 0, 2));
    shapeNoiseInput.value = String(THREE.MathUtils.clamp(shapeSettings.noise, 0, 1.2));
    function applyDefaultShape(value) {
      shapeSettings.default = THREE.MathUtils.clamp(Number(value), 0, 2);
      shapeDefaultValue.textContent = shapeSettings.default.toFixed(2);
      if (shapeState.returning || shapeState.to === shapeState.from || shapeState.returnAt === 0) {
        shapeState.from = shapeSettings.default;
        shapeState.to = shapeSettings.default;
        shapeState.mix = 1;
        shapeState.returning = false;
        shapeUniforms.shapeFrom.value = shapeSettings.default;
        shapeUniforms.shapeTo.value = shapeSettings.default;
        shapeUniforms.shapeMix.value = 1;
      }
      savePrefs({ shape: { ...(savedPrefs.shape || {}), default: shapeSettings.default, noise: shapeSettings.noise } });
    }
    function applyShapeNoise(value) {
      shapeSettings.noise = THREE.MathUtils.clamp(Number(value), 0, 1.2);
      shapeNoiseValue.textContent = shapeSettings.noise.toFixed(2);
      shapeUniforms.shapeNoise.value = shapeSettings.noise;
      savePrefs({ shape: { ...(savedPrefs.shape || {}), default: shapeSettings.default, noise: shapeSettings.noise } });
    }
    shapeDefaultInput.addEventListener("input", () => applyDefaultShape(shapeDefaultInput.value));
    shapeNoiseInput.addEventListener("input", () => applyShapeNoise(shapeNoiseInput.value));
    applyShapeNoise(shapeNoiseInput.value);
    applyDefaultShape(shapeDefaultInput.value);
    [
      ["Shell", "shell"],
      ["Gloss", "gloss"],
      ["Core", "core"],
      ["Fluid", "fluid"],
      ["Lobes", "lobes"],
      ["Water", "water"],
      ["Glitter", "glitter"],
      ["Traces", "traces"],
    ].forEach(([name, key]) => {
      const input = document.getElementById("layer" + name);
      const value = document.getElementById("layer" + name + "Value");
      if (savedPrefs.layers && Object.prototype.hasOwnProperty.call(savedPrefs.layers, key)) {
        input.checked = Boolean(savedPrefs.layers[key]);
      }
      const sync = () => {
        layerSettings[key] = input.checked;
        value.textContent = input.checked ? "on" : "off";
        applyLayerVisibility();
        savePrefs({ layers: { ...(savedPrefs.layers || {}), [key]: input.checked } });
      };
      input.addEventListener("change", sync);
      sync();
    });
    function setVisualTarget(key, value) {
      const control = visualSettings.controls[key];
      visualSettings.target[key] = value;
      if (control) {
        control.input.value = String(value);
        control.value.textContent = key === "liquid" ? String(Math.round(value)) : value.toFixed(2);
      }
      savePrefs({ visual: { ...(savedPrefs.visual || {}), [key]: value } });
    }
    function randomizeVortex(strength = 1) {
      const amount = Math.min(3, Math.max(0.5, strength || 1));
      const variance = 0.45 + amount * 0.18;
      const around = (key, min, max, spread = variance) => {
        const base = vortexSettings.target[key] ?? vortexSettings.current[key];
        return THREE.MathUtils.clamp(base + (Math.random() - 0.5) * spread, min, max);
      };
      setVortexTarget("swirl", around("swirl", 0.3, 2.0, 0.75 + amount * 0.18));
      setVortexTarget("speed", around("speed", 0.15, 2.0, 0.65 + amount * 0.16));
      setVortexTarget("soft", around("soft", 0.45, 2.0, 0.6 + amount * 0.12));
      setVortexTarget("lobes", around("lobes", 0.25, 2.0, 0.72 + amount * 0.16));
      setVortexTarget("glass", around("glass", 0.65, 1.35, 0.28 + amount * 0.05));
      pulse.value = Math.min(2.4, pulse.value + 0.14 * amount);
      coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.08 * amount);
    }
    const visualRecipes = [
      { shine: 2.85, core: 1.22, heat: 1.72, contrast: 1.55, liquid: 73, atmos: 2.35, mic: 0.24, sense: 3.2, idle: 0.26, vortex: { swirl: 1.65, speed: 0.42, soft: 1.38, lobes: 1.5, glass: 1.2 } },
      { shine: 1.85, core: 0.78, heat: 0.56, contrast: 1.82, liquid: 30, atmos: 0.72, mic: 0.12, sense: 1.4, idle: 0.9, vortex: { swirl: 0.58, speed: 0.24, soft: 1.82, lobes: 0.44, glass: 0.88 } },
      { shine: 3.05, core: 1.55, heat: 1.26, contrast: 0.62, liquid: 86, atmos: 1.75, mic: 0.54, sense: 4.6, idle: 0.18, vortex: { swirl: 1.92, speed: 0.72, soft: 0.76, lobes: 1.86, glass: 1.34 } },
      { shine: 1.18, core: 0.58, heat: 0.22, contrast: 0.34, liquid: 52, atmos: 2.8, mic: 0.0, sense: 0.8, idle: 1.55, vortex: { swirl: 0.28, speed: 0.16, soft: 1.92, lobes: 0.25, glass: 0.74 } },
      { shine: 2.35, core: 1.42, heat: 1.95, contrast: 1.14, liquid: 60, atmos: 1.18, mic: 0.9, sense: 5.4, idle: 0.46, vortex: { swirl: 1.2, speed: 1.18, soft: 0.58, lobes: 1.15, glass: 1.28 } },
      { shine: 0.72, core: 1.05, heat: 0.9, contrast: 1.95, liquid: 18, atmos: 0.28, mic: 0.18, sense: 2.1, idle: 0.04, vortex: { swirl: 0.12, speed: 0.2, soft: 0.52, lobes: 0.35, glass: 0.66 } },
    ];
    let lastRecipeIndex = -1;
    function jitter(value, amount, min, max) {
      return THREE.MathUtils.clamp(value + (Math.random() - 0.5) * amount, min, max);
    }
    vortexRandomize.addEventListener("click", (event) => {
      event.stopPropagation();
      randomizeVortex(1.8);
    });
    function randomizeVisuals(strength = 1, forceRecipe = -1) {
      let recipeIndex = forceRecipe >= 0 ? forceRecipe % visualRecipes.length : Math.floor(Math.random() * visualRecipes.length);
      if (visualRecipes.length > 1 && recipeIndex === lastRecipeIndex) recipeIndex = (recipeIndex + 1 + Math.floor(Math.random() * (visualRecipes.length - 1))) % visualRecipes.length;
      lastRecipeIndex = recipeIndex;
      const recipe = visualRecipes[recipeIndex];
      const wild = Math.min(1.8, Math.max(0.6, strength));
      setVortexTarget("swirl", jitter(recipe.vortex.swirl, 0.22 * wild, 0, 2));
      setVortexTarget("speed", jitter(recipe.vortex.speed, 0.16 * wild, 0.15, 2));
      setVortexTarget("soft", jitter(recipe.vortex.soft, 0.18 * wild, 0.35, 2));
      setVortexTarget("lobes", jitter(recipe.vortex.lobes, 0.2 * wild, 0, 2));
      setVortexTarget("glass", jitter(recipe.vortex.glass, 0.08 * wild, 0.5, 1.4));
      setVisualTarget("shine", jitter(recipe.shine, 0.18 * wild, 0.2, 3.2));
      setVisualTarget("core", jitter(recipe.core, 0.14 * wild, 0.35, 1.7));
      setVisualTarget("heat", jitter(recipe.heat, 0.18 * wild, 0, 2));
      setVisualTarget("contrast", jitter(recipe.contrast, 0.18 * wild, 0, 2));
      setVisualTarget("liquid", jitter(recipe.liquid, 8 * wild, 0, 100));
      setVisualTarget("atmos", jitter(recipe.atmos, 0.22 * wild, 0, 3));
      setVisualTarget("mic", jitter(recipe.mic, 0.16 * wild, 0, 2));
      setVisualTarget("sense", jitter(recipe.sense, 0.9 * wild, 0.5, 8));
      setVisualTarget("idle", jitter(recipe.idle, 0.18 * wild, 0, 2));
      pulse.value = Math.min(2.8, pulse.value + 0.18 * wild);
      coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.1 * wild);
    }
    visualRandomize.addEventListener("click", (event) => {
      event.stopPropagation();
      randomizeVisuals(1.45);
    });

    const glitterCount = 140;
    const glitterPositions = new Float32Array(glitterCount * 3);
    const glitterSeeds = [];
    for (let i = 0; i < glitterCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const r = Math.cbrt(Math.random()) * 1.18;
      const radial = Math.sqrt(Math.max(0, 1 - u * u));
      const x = Math.cos(theta) * radial * r;
      const y = u * r * 0.9;
      const z = Math.sin(theta) * radial * r;
      glitterPositions[i * 3] = x;
      glitterPositions[i * 3 + 1] = y;
      glitterPositions[i * 3 + 2] = z;
      glitterSeeds.push({ x, y, z, phase: Math.random() * Math.PI * 2, speed: 0.16 + Math.random() * 0.42, radius: r });
    }
    const glitterGeo = new THREE.BufferGeometry();
    glitterGeo.setAttribute("position", new THREE.BufferAttribute(glitterPositions, 3));
    const glitterMat = new THREE.PointsMaterial({
      color: 0xfff8a8,
      size: 0.038,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    glitter = new THREE.Points(glitterGeo, glitterMat);
    glitter.renderOrder = 2;
    group.add(glitter);
    setOrbMode(orbMode.value, false);

    const rimMat = new THREE.ShaderMaterial({
      uniforms: { time: coreUniforms.time, pulse },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      vertexShader: [
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "void main(){",
        "  vPos=position;",
        "  vNormal=normalize(normalMatrix*normal);",
        "  vec3 displaced=position+normal*(sin(position.y*18.0+position.x*5.0)*0.035);",
        "  gl_Position=projectionMatrix*modelViewMatrix*vec4(displaced,1.0);",
        "}"
      ].join("\\n"),
      fragmentShader: [
        "uniform float time;",
        "uniform float pulse;",
        "varying vec3 vPos;",
        "varying vec3 vNormal;",
        "void main(){",
        "  vec2 p=vPos.xy/vec2(2.34,1.98);",
        "  float fres=pow(1.0-abs(vNormal.z),0.86);",
        "  float right=smoothstep(0.18,0.92,p.x+sin(p.y*5.0+time*0.45)*0.025);",
        "  float bottom=smoothstep(0.06,0.86,-p.y+p.x*0.12);",
        "  float hot=clamp(right+bottom,0.0,1.0);",
        "  vec3 dark=vec3(0.02,0.015,0.035);",
        "  vec3 red=vec3(1.0,0.05,0.0);",
        "  vec3 gold=vec3(1.0,0.82,0.02);",
        "  vec3 col=mix(dark,red,hot);",
        "  col=mix(col,gold,smoothstep(0.82,1.0,hot));",
        "  float veins=0.55+0.45*sin(p.y*34.0+p.x*9.0+time*1.5);",
        "  float top=smoothstep(0.02,0.8,p.y-p.x*0.18);",
        "  col=mix(col,dark,top*0.55);",
        "  float edge=pow(fres,1.55);",
        "  gl_FragColor=vec4(col*(0.74+veins*0.32+pulse*0.1), edge*(0.36+hot*0.3+top*0.2));",
        "}"
      ].join("\\n"),
    });
    const innerRim = new THREE.Mesh(superellipsoidGeometry(2.44, 2.22, 0.78, 160, 80, 0.52, 0.024), rimMat);
    innerRim.position.set(0, -0.02, 0.16);
    innerRim.rotation.z = 0;
    innerRim.renderOrder = 3;
    innerRim.visible = false;

    function makeRibbon(radius, tube, color, opacity, scaleX, scaleY, z, rot, start = 0.08, length = 5.2) {
      const curve = new THREE.Curve();
      curve.getPoint = function(t) {
        const a = start + t * length;
        const wobble = Math.sin(t * Math.PI * 6.0 + radius) * 0.045 + Math.sin(t * Math.PI * 15.0) * 0.015;
        return new THREE.Vector3(Math.cos(a) * (radius + wobble), Math.sin(a) * (radius * 0.86 + wobble), Math.sin(t * Math.PI * 2.0) * 0.035);
      };
      const geo = new THREE.TubeGeometry(curve, 190, tube, 14, false);
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

    const ribbons = [];

    const streaks = [];
    function makeStreak(x, y, h, color, opacity) {
      const geo = new THREE.PlaneGeometry(0.055, h, 1, 12);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
      const s = new THREE.Mesh(geo, mat);
      s.position.set(x, y, 0.58);
      s.rotation.z = -0.12;
      s.renderOrder = 6;
      group.add(s);
      streaks.push(s);
      return s;
    }
    for (let i = 0; i < 0; i++) {
      makeStreak(1.42 + Math.sin(i * 1.7) * 0.18, -1.44 + i * 0.17, 0.46 + (i % 6) * 0.18, 0xffec32, 0.12);
    }

    function addMemoryTrace(repo = "root", strength = 1, kind = "modify") {
      if (kind === "wake") return;
      const hash = hashText(repo);
      const color = new THREE.Color(kind === "delete" ? 0x17223d : repoColor(repo));
      memoryEvents.push({
        born: performance.now(),
        life: 12000 + Math.min(9000, strength * 900),
        color: "rgb(" + Math.round(color.r * 255) + "," + Math.round(color.g * 255) + "," + Math.round(color.b * 255) + ")",
        start: ((hash >>> 4) % 628) / 100,
        span: 0.9 + Math.min(2.6, strength * 0.18),
        radius: 120 + (hash % 7) * 24,
        x: innerWidth * (0.5 + (((hash >>> 12) % 14) - 7) / 100),
        y: innerHeight * (0.55 + (((hash >>> 18) % 14) - 7) / 100),
        width: 1.2 + Math.min(3, strength * 0.32),
      });
      while (memoryEvents.length > 18) memoryEvents.shift();
    }

    const bubbles = [];
    const glints = { children: [] };
    const highlights = [];

    scene.add(new THREE.HemisphereLight(0xfff2d4, 0xff4300, 5.0));
    const key = new THREE.DirectionalLight(0xffedc4, 15.0);
    key.position.set(-3.8, 3.4, 6.2);
    scene.add(key);
    const red = new THREE.PointLight(0xff2600, 78, 8);
    red.position.set(1.7, 0.8, 2.5);
    scene.add(red);
    const gold = new THREE.PointLight(0xffd41d, 72, 8);
    gold.position.set(-1.55, -1.15, 2.9);
    scene.add(gold);
    const cyan = new THREE.PointLight(0x2f8fc4, 34, 7);
    cyan.position.set(-2.3, 1.3, 2.7);
    scene.add(cyan);
    const whiteKick = new THREE.PointLight(0xffb05a, 92, 7);
    whiteKick.position.set(-2.1, 1.8, 3.2);
    scene.add(whiteKick);
    const rightStripe = new THREE.PointLight(0xff8a1e, 88, 6);
    rightStripe.position.set(2.4, -0.4, 2.6);
    scene.add(rightStripe);

    function randomUnitVector() {
      const theta = Math.random() * Math.PI * 2;
      const z = Math.random() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return { x: Math.cos(theta) * r, y: Math.sin(theta) * r, z };
    }
    function spinPower(strength) {
      const amount = Math.max(1, strength || 1);
      return 0.00045 + Math.min(0.0055, Math.log1p(amount) * 0.00115);
    }
    function projectShape(repo = "root") {
      const hash = hashText(repo || "root");
      return 1 + ((hash >>> 4) % 1000) / 999;
    }
    function currentShapeValue() {
      const eased = shapeState.mix * shapeState.mix * (3 - shapeState.mix * 2);
      return shapeState.from + (shapeState.to - shapeState.from) * eased;
    }
    function spinSpeed() {
      return Math.hypot(massSpin.vx, massSpin.vy, massSpin.vz);
    }
    function shapeReturnDuration() {
      const speed = spinSpeed();
      const inertia = THREE.MathUtils.smoothstep(speed, 0.0025, 0.024);
      return 950 + inertia * 2600;
    }
    function morphToShape(next, duration = 860, hold = 0) {
      shapeState.from = currentShapeValue();
      shapeState.to = next;
      shapeState.mix = 0;
      shapeState.started = performance.now();
      shapeState.duration = duration;
      const isDefault = Math.abs(next - shapeSettings.default) < 0.001;
      shapeState.returnAt = isDefault ? 0 : shapeState.started + duration + hold;
      shapeState.returning = isDefault;
      shapeUniforms.shapeFrom.value = shapeState.from;
      shapeUniforms.shapeTo.value = shapeState.to;
      shapeUniforms.shapeMix.value = 0;
    }
    function handShapeBlip() {
      let next = 1 + Math.random();
      if (Math.abs(next - lastHandShape) < 0.22) next = 1 + ((next + 0.37) % 1);
      lastHandShape = next;
      morphToShape(next, 100, 420);
      pulse.value = Math.min(2.2, pulse.value + 0.22);
      dance.value = Math.min(0.8, dance.value + 0.18);
      dance.phase = performance.now() * 0.001;
      idle.quietUntil = performance.now() + 1800;
      coreUniforms.projectColor.value.set(new THREE.Color().setHSL(0.08 + (next - 1) * 0.04, 1, 0.52));
      coreUniforms.projectGlow.value = Math.min(0.82, coreUniforms.projectGlow.value + 0.18);
      playHandGestureTone(1.4);
    }
    function machinePulse(strength, repo = "root", kind = "modify") {
      const amount = Math.max(1, strength || 1);
      const hash = hashText(repo || "root");
      const direction = randomUnitVector();
      const power = spinPower(amount);
      morphToShape(projectShape(repo), 100, 260 + Math.min(520, amount * 55));
      const projectColor = new THREE.Color(repoColor(repo));
      coreUniforms.projectColor.value.copy(projectColor);
      coreUniforms.projectSpot.value.set(
        (((hash >>> 8) % 100) / 100 - 0.5) * 0.72,
        (((hash >>> 17) % 100) / 100 - 0.5) * 0.58
      );
      coreUniforms.projectGlow.value = Math.min(1.35, coreUniforms.projectGlow.value + 0.28 + Math.log1p(amount) * 0.14);
      coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.14 + Math.log1p(amount) * 0.045);
      pulse.value = Math.min(3.4, pulse.value + 0.42 * amount);
      dance.value = Math.min(2.2, dance.value + 0.75 + amount * 0.18);
      weather.charge = Math.min(1, weather.charge + 0.11 + Math.log1p(amount) * 0.095);
      weather.storm = Math.min(1, weather.storm + Math.max(0, amount - 2) * 0.035);
      weather.lastWorkAt = performance.now();
      dance.phase = performance.now() * 0.001;
      idle.quietUntil = performance.now() + 3200;
      massSpin.vx += direction.x * power * 0.45 + (((hash >>> 3) % 200) - 100) / 180000;
      massSpin.vy += direction.y * power + (((hash >>> 11) % 200) - 100) / 150000;
      massSpin.vz += direction.z * power * 0.28 + (((hash >>> 19) % 200) - 100) / 190000;
      frameDrift.vx += direction.x * 0.0028 * Math.min(2.4, Math.log1p(amount));
      frameDrift.vy += direction.y * 0.0022 * Math.min(2.4, Math.log1p(amount));
      addMemoryTrace(repo, strength, kind);
      playChime(repo, strength, kind);
    }
    function manualPulse(strength = 1) {
      const amount = Math.max(1, strength || 1);
      pulse.value = Math.min(2.4, pulse.value + 0.58 * amount);
      dance.value = Math.min(1.25, dance.value + 0.36 * amount);
      dance.phase = performance.now() * 0.001;
      massSpin.vy += 0.00095 * amount;
      massSpin.vx += (Math.random() - 0.5) * 0.00028 * amount;
      massSpin.vz += (Math.random() - 0.5) * 0.00018 * amount;
      idle.quietUntil = performance.now() + 2400;
      weather.charge = Math.min(1, weather.charge + 0.08 * amount);
      coreUniforms.projectGlow.value = Math.min(0.7, coreUniforms.projectGlow.value + 0.16);
      coreUniforms.agitation.value = Math.min(0.48, coreUniforms.agitation.value + 0.08 * amount);
      playManualPing(amount);
    }
    function waveAwayPulse(strength = 1) {
      const amount = Math.max(1, strength || 1);
      pulse.value = Math.min(2.8, pulse.value + 0.52 * amount);
      dance.value = Math.min(1.7, dance.value + 0.32 * amount);
      dance.phase = performance.now() * 0.001;
      massSpin.vy -= 0.0085 * amount;
      massSpin.vx += (Math.random() - 0.5) * 0.0011 * amount;
      massSpin.vz -= 0.0009 * amount;
      idle.quietUntil = performance.now() + 3600;
      weather.focus = Math.min(1, weather.focus + 0.18 * amount);
      coreUniforms.projectColor.value.set(0x60d7ff);
      coreUniforms.projectGlow.value = Math.min(1.05, coreUniforms.projectGlow.value + 0.32);
      coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.08 * amount);
      playManualPing(amount * 1.1);
    }
    const pendingProjectPulses = new Map();
    let projectPulseTimer = null;
    function queueProjectPulse(strength, repo = "root", kind = "modify") {
      const now = performance.now();
      const key = repo + ":" + kind;
      const previous = pendingProjectPulses.get(key);
      pendingProjectPulses.set(key, {
        repo,
        kind,
        strength: Math.min(18, (previous ? previous.strength : 0) + Math.max(1, strength || 1)),
        at: now,
      });
      if (projectPulseTimer) return;
      projectPulseTimer = setTimeout(() => {
        projectPulseTimer = null;
        const pulses = [...pendingProjectPulses.values()].sort((a, b) => b.strength - a.strength).slice(0, 3);
        pendingProjectPulses.clear();
        pulses.forEach((item, index) => {
          setTimeout(() => scheduleMachinePulse(item.strength, item.repo, item.kind), index * 180);
        });
      }, 520);
    }
    function scheduleMachinePulse(strength, repo = "root", kind = "modify") {
      const amount = Math.max(1, strength || 1);
      const delay = 80 + Math.random() * 420 + Math.min(650, amount * 32 * Math.random());
      setTimeout(() => machinePulse(amount, repo, kind), delay);
    }
    function observeSnapshot(data) {
      if (!data || !Array.isArray(data.files) || !data.files.length) return;
      const latest = data.files[0];
      const mtime = Date.parse(latest.mtimeIso || "");
      if (!Number.isFinite(mtime)) return;
      const previous = lastObservedMtime;
      lastObservedMtime = Math.max(lastObservedMtime, mtime);
      if (firstSnapshot) {
        firstSnapshot = false;
        return;
      }
      if (mtime > previous) {
        const changed = data.files.filter((file) => Date.parse(file.mtimeIso || "") > previous).slice(0, 8);
        const repo = ((changed[0] && changed[0].path) || latest.path || "root").split("/")[0];
        queueProjectPulse(Math.max(1, changed.length), repo, "modify");
      }
    }
    async function pollRecentFiles() {
      try {
        const res = await fetch("/api/recent-files", { cache: "no-store" });
        observeSnapshot(await res.json());
      } catch {}
    }
    try {
      const events = new EventSource("/api/recent-files/events");
      events.addEventListener("activity", (event) => {
        try {
          const data = JSON.parse(event.data);
          const count = Array.isArray(data.events) ? data.events.reduce((n, item) => n + (item.count || 1), 0) : 1;
          if (data.events && data.events.length) {
            const byRepo = new Map();
            for (const item of data.events.slice(0, 12)) {
              const key = (item.repo || "root") + ":" + (item.kind || "modify");
              byRepo.set(key, {
                repo: item.repo || "root",
                kind: item.kind || "modify",
                count: (byRepo.get(key)?.count || 0) + (item.count || 1),
              });
            }
            for (const item of byRepo.values()) queueProjectPulse(Math.min(18, item.count), item.repo, item.kind);
          }
        } catch {}
      });
    } catch {}

    addEventListener("pointerdown", async () => {
      await wakeAudio();
      await startMicReactive();
      await startPresenceReactive();
      manualPulse(1.6);
    });
    addEventListener("keydown", async () => {
      await wakeAudio();
      await startMicReactive();
      await startPresenceReactive();
      manualPulse(1.2);
    });
    pollRecentFiles();
    setInterval(pollRecentFiles, 1500);

    function resize() {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    }
    addEventListener("resize", resize);

    function animate() {
      const t = clock.getElapsedTime();
      pulse.value *= 0.93;
      coreUniforms.projectGlow.value = coreUniforms.projectGlow.value < 0.015 ? 0 : coreUniforms.projectGlow.value * 0.88;
      coreUniforms.agitation.value = coreUniforms.agitation.value < 0.006 ? 0 : coreUniforms.agitation.value * 0.996;
      if (shapeState.mix < 1) {
        shapeState.mix = Math.min(1, (performance.now() - shapeState.started) / shapeState.duration);
        shapeUniforms.shapeMix.value = shapeState.mix;
      } else if (shapeState.returnAt && performance.now() >= shapeState.returnAt && !shapeState.returning) {
        morphToShape(shapeSettings.default, shapeReturnDuration(), 0);
      }
      const now = performance.now();
      const vortexEase = vortexSettings.ease;
      ["swirl", "speed", "soft", "lobes", "glass"].forEach((key) => {
        vortexSettings.current[key] += (vortexSettings.target[key] - vortexSettings.current[key]) * vortexEase;
      });
      ["shine", "core", "heat", "contrast", "liquid", "atmos", "mic", "sense", "idle"].forEach((key) => {
        visualSettings.current[key] += (visualSettings.target[key] - visualSettings.current[key]) * vortexEase;
      });
      coreUniforms.vortexSwirl.value = vortexSettings.current.swirl;
      coreUniforms.vortexSpeed.value = vortexSettings.current.speed;
      coreUniforms.vortexSoft.value = vortexSettings.current.soft;
      coreUniforms.vortexGlass.value = vortexSettings.current.glass;
      coreUniforms.visualCore.value = visualSettings.current.core;
      coreUniforms.visualHeat.value = visualSettings.current.heat;
      coreUniforms.visualContrast.value = visualSettings.current.contrast;
      const cameraDistance = camera.position.distanceTo(controls.target);
      const distanceBoost = THREE.MathUtils.smoothstep(cameraDistance, 7.5, 18.0);
      coreUniforms.distanceBoost.value = distanceBoost;
      glossMat.uniforms.distanceBoost.value = distanceBoost;
      glossPopMat.uniforms.distanceBoost.value = distanceBoost;
      waterRimMat.uniforms.distanceBoost.value = distanceBoost;
      glossMat.uniforms.visualShine.value = visualSettings.current.shine * (1 + distanceBoost * 0.42);
      glossPopMat.uniforms.visualShine.value = visualSettings.current.shine * (1 + distanceBoost * 0.38);
      waterRimMat.uniforms.time.value = t;
      waterRimMat.uniforms.visualShine.value = 0.8 + visualSettings.current.shine * 0.18 + distanceBoost * 0.55;
      waterRimMat.uniforms.waterFill.value = THREE.MathUtils.clamp(visualSettings.current.liquid / 100, 0, 1);
      shellMat.envMapIntensity = 11 + visualSettings.current.shine * 17 + distanceBoost * 18;
      shellMat.specularIntensity = 1.15 + visualSettings.current.shine * 1.55 + distanceBoost * 1.4;
      if (orbMode.value === "water") {
        const fillPercent = THREE.MathUtils.clamp(visualSettings.current.liquid / 100, 0, 1);
        const waterDensity = THREE.MathUtils.clamp(waterSettings.viscosity / 100, 0, 1);
        const emptyBoost = 1 - fillPercent;
        shellMat.envMapIntensity = 24 + visualSettings.current.shine * 15 + distanceBoost * 22;
        shellMat.specularIntensity = 2.6 + visualSettings.current.shine * 1.15 + emptyBoost * 0.9 + waterDensity * 0.35 + distanceBoost * 1.5;
        shellMat.opacity = Math.min(1, 0.84 + fillPercent * 0.12 + waterDensity * 0.04 + distanceBoost * 0.12);
      } else {
        shellMat.opacity = Math.min(1, 0.92 + distanceBoost * 0.08);
      }
      bgUniforms.depth.value = visualSettings.current.atmos;
      const faceActive = presence.ready && now - presence.faceSeen < 800;
      gestureToggle.style.opacity = faceActive ? "1" : ".58";
      const leftHandBoosting = presence.leftHandRaised && gestureSettings.leftHand;
      if (faceActive && gestureSettings.head) {
        attention.tx = 0;
        attention.ty = 0;
        attention.pull *= 0.94;
      } else {
        attention.tx = 0;
        attention.ty = 0;
        attention.pull *= 0.965;
        presence.stillness *= 0.96;
      }
      const bounds = frameBounds();
      const held = grabHold && now - grabHold.born > 120;
      const driftScale = visualSettings.current.idle * (weather.charge * 0.2 + (faceActive ? 0.28 : 0));
      if (faceActive && gestureSettings.head) {
        frameDrift.vx += THREE.MathUtils.clamp(presence.faceVX, -0.08, 0.08) * 0.00125;
        frameDrift.vy += THREE.MathUtils.clamp(-presence.faceVY, -0.08, 0.08) * 0.001;
      }
      if (!shiftSpacePan) {
        frameDrift.x += frameDrift.vx * Math.max(0.18, driftScale);
        frameDrift.y += frameDrift.vy * Math.max(0.18, driftScale);
        frameDrift.vx *= 0.94;
        frameDrift.vy *= 0.94;
        let wallHit = 0;
        if (frameDrift.x > bounds.x) {
          frameDrift.x = bounds.x;
          wallHit = Math.max(wallHit, Math.abs(frameDrift.vx));
          frameDrift.vx = -Math.abs(frameDrift.vx) * 0.82;
          massSpin.vz -= 0.0007;
        } else if (frameDrift.x < -bounds.x) {
          frameDrift.x = -bounds.x;
          wallHit = Math.max(wallHit, Math.abs(frameDrift.vx));
          frameDrift.vx = Math.abs(frameDrift.vx) * 0.82;
          massSpin.vz += 0.0007;
        }
        if (frameDrift.y > bounds.y) {
          frameDrift.y = bounds.y;
          wallHit = Math.max(wallHit, Math.abs(frameDrift.vy));
          frameDrift.vy = -Math.abs(frameDrift.vy) * 0.82;
          massSpin.vx += 0.0006;
        } else if (frameDrift.y < -bounds.y) {
          frameDrift.y = -bounds.y;
          wallHit = Math.max(wallHit, Math.abs(frameDrift.vy));
          frameDrift.vy = Math.abs(frameDrift.vy) * 0.82;
          massSpin.vx -= 0.0006;
        }
        if (wallHit > 0.004) {
          const hitStrength = Math.min(2.4, wallHit * 22);
          pulse.value = Math.min(3.4, pulse.value + 0.08 + hitStrength * 0.05);
          coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.025 + hitStrength * 0.018);
          playWallDing(hitStrength);
        }
        frameDrift.x = THREE.MathUtils.clamp(frameDrift.x, -bounds.x, bounds.x);
        frameDrift.y = THREE.MathUtils.clamp(frameDrift.y, -bounds.y, bounds.y);
      }
      orbCenter.set(orbHome.x + frameDrift.x, orbHome.y + frameDrift.y, orbHome.z);
      group.position.lerp(orbCenter, 0.08);
      attention.x += (attention.tx - attention.x) * 0.028;
      attention.y += (attention.ty - attention.y) * 0.028;
      const attentionTarget = new THREE.Vector3(
        orbCenter.x + attention.x * attention.pull,
        orbCenter.y - attention.y * attention.pull,
        orbCenter.z
      );
      controls.target.lerp(attentionTarget, 0.018);
      const focus = faceActive && gestureSettings.stillness ? presence.stillness : 0;
      presence.rightHandHold += ((presence.rightHandRaised ? 1 : 0) - presence.rightHandHold) * (presence.rightHandRaised ? 0.18 : 0.08);
      presence.rightHandOpenHold += ((presence.rightHandOpen ? 1 : 0) - presence.rightHandOpenHold) * (presence.rightHandOpen ? 0.2 : 0.08);
      presence.rightHandClosedHold += ((presence.rightHandClosed ? 1 : 0) - presence.rightHandClosedHold) * (presence.rightHandClosed ? 0.22 : 0.08);
      presence.leftHandHold += ((presence.leftHandRaised ? 1 : 0) - presence.leftHandHold) * (presence.leftHandRaised ? 0.24 : 0.08);
      presence.leftHandClosedHold += ((presence.leftHandClosed ? 1 : 0) - presence.leftHandClosedHold) * (presence.leftHandClosed ? 0.26 : 0.09);
      const smileSpinning = faceActive && presence.smileDetected;
      presence.smileHold += ((smileSpinning ? 1 : 0) - presence.smileHold) * (smileSpinning ? 0.18 : 0.055);
      if (!smileSpinning) presence.smileStartedAt = 0;
      dance.value *= 0.965;
      dance.spinX *= 0.965;
      dance.spinY *= 0.965;
      dance.spinZ *= 0.965;
      const handBrake = held ? 0.9 : 1;
      const gestureBrake = Math.max(0.18, 1 - presence.rightHandClosedHold * 0.82);
      massSpin.vx *= (0.99925 - focus * 0.00022) * handBrake * gestureBrake;
      massSpin.vy *= (0.99935 - focus * 0.00022) * handBrake * gestureBrake;
      massSpin.vz *= (0.9992 - focus * 0.00022) * handBrake * gestureBrake;
      if (presence.rightHandOpenHold > 0.02) {
        const heldSeconds = presence.rightHandStartedAt ? Math.max(0, (now - presence.rightHandStartedAt) / 1000) : 0;
        const ramp = Math.min(1, heldSeconds / 0.42);
        const power = (0.00085 + ramp * 0.00325) * presence.rightHandOpenHold;
        massSpin.vy += power * 1.12;
        massSpin.vx -= power * 0.28 * Math.sin(now * 0.0019);
        massSpin.vz += power * 0.42;
        pulse.value = Math.min(3.4, pulse.value + 0.004 + ramp * 0.008);
        coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.002 + ramp * 0.0045);
        if (now - presence.lastRightHandSpinAt > 1500) {
          presence.lastRightHandSpinAt = now;
          showGestureFeedback(ramp > 0.65 ? "Right spin building" : "Right hand spin");
        }
      }
      if (leftHandBoosting) {
        const heldSeconds = Math.max(0, (now - presence.leftHandStartedAt) / 1000);
        const ramp = Math.min(1, heldSeconds / 0.34);
        const closedBoost = 1 + presence.leftHandClosedHold * 1.85;
        const power = (0.00115 + ramp * 0.0042) * presence.leftHandHold * closedBoost;
        massSpin.vy += power * 1.34;
        massSpin.vx += power * 0.36 * Math.sin(now * 0.0021);
        massSpin.vz += power * 0.52;
        pulse.value = Math.min(3.4, pulse.value + 0.007 + ramp * 0.012);
        coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.0032 + ramp * 0.006);
        if (now - presence.lastLeftHandAt > 1500) {
          presence.lastLeftHandAt = now;
          showGestureFeedback(presence.leftHandClosed ? "Left hand faster" : (ramp > 0.65 ? "Spin building" : "Left hand go"));
        }
      }
      if (presence.smileHold > 0.02) {
        const heldSeconds = presence.smileStartedAt ? Math.max(0, (now - presence.smileStartedAt) / 1000) : 0;
        const ramp = Math.min(1, heldSeconds / 0.85);
        const power = (0.00035 + ramp * 0.00215) * presence.smileHold;
        massSpin.vy += power * 1.08;
        massSpin.vx += power * 0.24 * Math.sin(now * 0.0017);
        massSpin.vz += power * 0.34;
        pulse.value = Math.min(3.4, pulse.value + 0.003 + ramp * 0.006);
        coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + 0.0015 + ramp * 0.0035);
        if (smileSpinning && now - presence.lastSmileSpinAt > 1700) {
          presence.lastSmileSpinAt = now;
          showGestureFeedback(ramp > 0.65 ? "Smile spin building" : "Smile spin");
        }
      }
      const idleBrake = 1 - presence.rightHandClosedHold * 0.03;
      idle.vx *= idleBrake;
      idle.vy *= idleBrake;
      idle.vz *= idleBrake;
      if (held) {
        idle.vx *= 0.88;
        idle.vy *= 0.88;
        idle.vz *= 0.88;
      }
      massSpin.x += massSpin.vx;
      massSpin.y += massSpin.vy;
      massSpin.z += massSpin.vz;
      coreUniforms.time.value = t;
      glossMat.uniforms.time.value = t;
      glossPopMat.uniforms.time.value = t;
      const invGroupRotation = new THREE.Matrix4().extractRotation(group.matrixWorld).invert();
      const localDown = new THREE.Vector3(0, -1, 0).applyMatrix4(invGroupRotation).normalize();
      const screenDownWorld = new THREE.Vector3(0, -1, 0).applyQuaternion(camera.quaternion).normalize();
      const waterDownRaw = screenDownWorld.applyMatrix4(invGroupRotation).normalize();
      const waterDown = waterSettings.gravity ? waterDownRaw : new THREE.Vector3(waterSlosh.gx, waterSlosh.gy, waterSlosh.gz).normalize();
      coreUniforms.worldDown.value.copy(localDown);
      waterUniforms.worldDown.value.copy(waterDown);
      const gravityDeltaX = waterDown.x - waterSlosh.gx;
      const gravityDeltaY = waterDown.y - waterSlosh.gy;
      const gravityDeltaZ = waterDown.z - waterSlosh.gz;
      const gravityShift = Math.hypot(gravityDeltaX, gravityDeltaY, gravityDeltaZ);
      if (orbMode.value === "water" && gravityShift > 0.004) {
        waterSlosh.clingX += (waterSlosh.gx - waterSlosh.clingX) * 0.62;
        waterSlosh.clingY += (waterSlosh.gy - waterSlosh.clingY) * 0.62;
        waterSlosh.clingZ += (waterSlosh.gz - waterSlosh.clingZ) * 0.62;
        const clingLen = Math.hypot(waterSlosh.clingX, waterSlosh.clingY, waterSlosh.clingZ) || 1;
        waterSlosh.clingX /= clingLen;
        waterSlosh.clingY /= clingLen;
        waterSlosh.clingZ /= clingLen;
      }
      waterSlosh.gx = waterDown.x;
      waterSlosh.gy = waterDown.y;
      waterSlosh.gz = waterDown.z;
      denseFluid.x += (localDown.x * 0.22 - denseFluid.x) * 0.018;
      denseFluid.y += (-0.24 + localDown.y * 0.18 - denseFluid.y) * 0.018;
      denseFluid.z += (localDown.z * 0.16 - denseFluid.z) * 0.016;
      denseFluid.x += massSpin.vx * 0.55 + idle.vx * 0.012;
      denseFluid.y += massSpin.vy * 0.18 + idle.vy * 0.006;
      denseFluid.z += massSpin.vz * 0.22 + idle.vz * 0.008;
      denseFluid.x = THREE.MathUtils.clamp(denseFluid.x, -0.38, 0.38);
      denseFluid.y = THREE.MathUtils.clamp(denseFluid.y, -0.52, 0.1);
      denseFluid.z = THREE.MathUtils.clamp(denseFluid.z, -0.26, 0.26);
      coreUniforms.denseOffset.value.set(denseFluid.x, denseFluid.y);
      const viscosity = THREE.MathUtils.clamp(waterSettings.viscosity / 100, 0, 1);
      const thin = 1 - viscosity;
      const gravityPower = waterSettings.gravity ? THREE.MathUtils.lerp(1.0, 0.18, viscosity) : 0;
      const sloshPower = waterSettings.slosh ? THREE.MathUtils.lerp(1.0, 0.22, viscosity) : 0;
      const wavePower = waterSettings.waves ? THREE.MathUtils.lerp(1.0, 0.18, viscosity) : 0;
      waterUniforms.viscosity.value = viscosity;
      waterUniforms.density.value = viscosity;
      waterUniforms.wavesOn.value = waterSettings.waves ? 1 : 0;
      const clingTarget = THREE.MathUtils.clamp(0.12 * viscosity + gravityShift * 6.5 * viscosity + Math.hypot(waterSlosh.x, waterSlosh.y) * 0.42 * viscosity, 0, 1);
      waterSlosh.cling += (clingTarget - waterSlosh.cling) * THREE.MathUtils.lerp(0.12, 0.045, viscosity);
      waterSlosh.cling *= THREE.MathUtils.lerp(0.92, 0.996, viscosity);
      waterSlosh.cling = THREE.MathUtils.clamp(waterSlosh.cling, 0, 1);
      waterRimMat.uniforms.worldDown.value.copy(waterDown);
      waterRimMat.uniforms.clingDir.value.set(waterSlosh.clingX, waterSlosh.clingY, waterSlosh.clingZ);
      waterRimMat.uniforms.cling.value = waterSlosh.cling;
      waterRimMat.uniforms.viscosity.value = viscosity;
      waterUniforms.surfaceTilt.value.set(
        THREE.MathUtils.clamp((denseFluid.x * 0.75 + massSpin.vx * 28) * sloshPower + gravityDeltaX * 0.32 * gravityPower, -0.82, 0.82),
        THREE.MathUtils.clamp((denseFluid.z * 0.75 + massSpin.vz * 30) * sloshPower + gravityDeltaZ * 0.32 * gravityPower, -0.82, 0.82)
      );
      const sloshKickX = (massSpin.vx * 12 + idle.vx * 0.12 + denseFluid.x * 0.055) * sloshPower + gravityDeltaX * 1.65 * gravityPower;
      const sloshKickY = (massSpin.vz * 14 + idle.vz * 0.12 + denseFluid.z * 0.065) * sloshPower + gravityDeltaZ * 1.65 * gravityPower;
      const response = THREE.MathUtils.lerp(0.018, 0.0035, viscosity);
      const damping = THREE.MathUtils.lerp(0.972, 0.91, viscosity);
      waterSlosh.vx += (sloshKickX - waterSlosh.x) * response + pulse.value * 0.00075 * thin * wavePower * Math.sin(t * 1.15);
      waterSlosh.vy += (sloshKickY - waterSlosh.y) * response + pulse.value * 0.00075 * thin * wavePower * Math.cos(t * 1.05);
      waterSlosh.vx *= damping;
      waterSlosh.vy *= damping;
      waterSlosh.x += waterSlosh.vx;
      waterSlosh.y += waterSlosh.vy;
      waterSlosh.x = THREE.MathUtils.clamp(waterSlosh.x, -0.9, 0.9);
      waterSlosh.y = THREE.MathUtils.clamp(waterSlosh.y, -0.9, 0.9);
      waterSlosh.amp += ((Math.hypot(waterSlosh.x, waterSlosh.y) * 0.45 * wavePower + coreUniforms.agitation.value * 0.34 * wavePower + pulse.value * 0.06 * wavePower) - waterSlosh.amp) * THREE.MathUtils.lerp(0.055, 0.018, viscosity);
      const breath = Math.sin(t * 0.09);
      const mic = sampleMicLevel() * visualSettings.current.mic;
      pulse.value = Math.min(3.4, pulse.value + mic * 0.028);
      coreUniforms.agitation.value = Math.min(0.68, coreUniforms.agitation.value + mic * 0.0075);
      weather.charge = Math.max(0, weather.charge * 0.9986 + mic * 0.0035);
      weather.storm = Math.max(0, weather.storm * 0.9968 + Math.max(0, mic - 0.18) * 0.0025);
      const smileTarget = presence.ready ? presence.smileRaw : 0;
      presence.smileWarmth += (smileTarget - presence.smileWarmth) * (smileTarget > presence.smileWarmth ? 0.22 : 0.018);
      presence.smileRaw *= 0.9;
      const quietCandidate = now > idle.quietUntil && pulse.value < 0.12 && dance.value < 0.08 && mic < 0.05 && shapeState.to === 0 && shapeState.mix >= 1;
      weather.focus += ((quietCandidate && now - weather.lastWorkAt > 4500 ? 1 : 0) - weather.focus) * 0.006;
      const warmth = Math.min(1, Math.pow(presence.smileWarmth, 0.48) * 1.45 + weather.charge * 0.25);
      const storm = Math.min(1, weather.storm);
      const focusWeather = Math.min(1, weather.focus);
      bgUniforms.warmth.value = Math.min(1, warmth + storm * 0.18);
      if (frameMode.value === "room") {
        document.body.style.backgroundColor = "#" + coolBackground.clone().lerp(warmBackground, warmth * 0.95).getHexString();
      } else {
        document.body.style.backgroundColor = "";
      }
      const weatherColor = coolBackground.clone()
        .lerp(focusBackground, focusWeather * 0.42)
        .lerp(warmBackground, warmth * 0.98)
        .lerp(stormBackground, storm * 0.46);
      scene.fog.color.copy(weatherColor);
      const quiet = quietCandidate;
      if (quiet && now > idle.nextAt) {
        idle.vx += (Math.random() - 0.5) * 0.055 * visualSettings.current.idle;
        idle.vy += (Math.random() - 0.5) * 0.075 * visualSettings.current.idle;
        idle.vz += (Math.random() - 0.5) * 0.046 * visualSettings.current.idle;
        idle.nextAt = now + 3600 + Math.random() * 7600;
      }
      idle.vx *= 0.982;
      idle.vy *= 0.982;
      idle.vz *= 0.982;
      idle.x = (idle.x + idle.vx) * 0.992;
      idle.y = (idle.y + idle.vy) * 0.992;
      idle.z = (idle.z + idle.vz) * 0.992;
      const kick = dance.value;
      const round = Math.min(1.0, kick * 0.55);
      const wobble = Math.sin((t - dance.phase) * 5.8);
      const wobble2 = Math.sin((t - dance.phase) * 7.2 + 0.8);
      group.rotation.y = -0.2 + massSpin.y + Math.sin(t * 0.1) * 0.008 + pulse.value * 0.004 + dance.spinY + wobble * kick * 0.008 + mic * 0.028 + idle.y + attention.x * attention.pull * 0.12;
      group.rotation.x = -0.22 + massSpin.x + Math.sin(t * 0.09) * 0.006 + dance.spinX + wobble2 * kick * 0.006 + mic * 0.018 + idle.x - attention.y * attention.pull * 0.12;
      group.rotation.z = 0.18 + massSpin.z + Math.sin(t * 0.07) * 0.006 + dance.spinZ + wobble * kick * 0.007 + mic * 0.016 + idle.z + attention.x * attention.pull * 0.035;
      shell.scale.set(
        1.0 + pulse.value * 0.008 + breath * 0.0025 * visualSettings.current.idle + mic * 0.085 - focus * 0.006,
        1.0 + pulse.value * 0.006 + breath * 0.0025 * visualSettings.current.idle + mic * 0.065 - focus * 0.005,
        1.0 + pulse.value * 0.008 + breath * 0.0025 * visualSettings.current.idle + mic * 0.085 - focus * 0.006
      );
      gloss.scale.copy(shell.scale).multiplyScalar(1.002);
      glossPop.scale.copy(shell.scale).multiplyScalar(1.004);
      waterRim.scale.copy(shell.scale).multiplyScalar(1.006);
      innerRim.scale.setScalar(1 + pulse.value * 0.01 + breath * 0.004 * visualSettings.current.idle);
      core.scale.set(
        1.0 + pulse.value * 0.008 + round * 0.025 + mic * 0.052,
        1.0 + pulse.value * 0.006 + round * 0.025 + mic * 0.04,
        1.0 + pulse.value * 0.006 + round * 0.025 + mic * 0.052
      );
      const agitation = coreUniforms.agitation.value;
      fluid.position.set(denseFluid.x * 0.9, denseFluid.y * 0.72 - 0.2, denseFluid.z * 0.72 + 0.08);
      fluid.rotation.x = group.rotation.x * -0.18 + Math.sin(t * 0.075) * 0.035 + agitation * 0.08;
      fluid.rotation.y = group.rotation.y * -0.14 + Math.cos(t * 0.061) * 0.03 + agitation * 0.06;
      fluid.rotation.z = group.rotation.z * -0.12 + Math.sin(t * 0.052) * 0.035;
      fluid.scale.set(
        0.98 + pulse.value * 0.006 + agitation * 0.06,
        0.58 + pulse.value * 0.004 - Math.min(0.1, Math.abs(localDown.y) * 0.035),
        0.84 + pulse.value * 0.005 + agitation * 0.05
      );
      if (orbMode.value === "water") {
        const fillPercent = THREE.MathUtils.clamp(visualSettings.current.liquid / 100, 0, 1);
        const fillLevel = THREE.MathUtils.lerp(-1.68, 1.68, fillPercent) + denseFluid.y * 0.05 + Math.sin(t * 0.18) * 0.008 + pulse.value * 0.006;
        waterUniforms.fillLevel.value = fillLevel;
        waterVolume.scale.set(
          1.0 + pulse.value * 0.003 * thin + agitation * 0.014 * wavePower + waterSlosh.amp * 0.01,
          1.0 + pulse.value * 0.002 * thin + agitation * 0.009 * wavePower,
          1.0 + pulse.value * 0.003 * thin + agitation * 0.014 * wavePower + waterSlosh.amp * 0.01
        );
      }
      lavaLobes.forEach((lobe, i) => {
        const phase = lobe.userData.phase;
        const base = lobe.userData.baseScale;
        const slow = t * coreUniforms.vortexSpeed.value * (0.055 + i * 0.012) + phase;
        const sink = 0.14 + i * 0.045;
        const lavaLiquidScale = visualSettings.current.liquid / 50;
        lobe.material.uniforms.alpha.value = lobe.userData.baseAlpha * vortexSettings.current.lobes * (0.78 + lavaLiquidScale * 0.3);
        lobe.position.set(
          denseFluid.x * (0.52 + i * 0.08) + Math.sin(slow) * (0.2 - i * 0.025) + (i - 1) * 0.12,
          denseFluid.y * 0.5 - sink + Math.cos(slow * 0.8) * 0.11,
          denseFluid.z * 0.42 + Math.cos(slow * 0.72) * (0.16 - i * 0.018)
        );
        lobe.rotation.x = group.rotation.x * -0.12 + Math.sin(slow * 0.7) * 0.12;
        lobe.rotation.y = group.rotation.y * -0.16 + Math.cos(slow * 0.62) * 0.16;
        lobe.rotation.z = group.rotation.z * -0.1 + Math.sin(slow * 0.54) * 0.18;
        const liquidScale = visualSettings.current.liquid / 50;
        const slosh = (0.76 + liquidScale * 0.28) + agitation * 0.18 * coreUniforms.vortexSwirl.value + pulse.value * 0.012;
        lobe.scale.set(
          base.x * slosh * (1 + Math.sin(slow * 0.9) * 0.035),
          base.y * (0.82 + liquidScale * 0.2) * (1 + Math.cos(slow * 0.7) * 0.045),
          base.z * slosh * (1 + Math.sin(slow * 0.63) * 0.04)
        );
      });
      const positions = glitter.geometry.attributes.position.array;
      for (let i = 0; i < glitterSeeds.length; i++) {
        const seed = glitterSeeds[i];
        const swirl = t * (0.055 + agitation * 0.28) * seed.speed + seed.phase;
        const tumble = Math.sin(t * (0.16 + agitation * 0.24) + seed.phase);
        const lift = agitation * Math.sin(swirl * 1.1 + seed.phase) * 0.08;
        const settle = -Math.max(0, 1 - agitation) * 0.12;
        const turn = swirl * agitation * 0.12;
        const x = seed.x * Math.cos(turn) - seed.z * Math.sin(turn);
        const z = seed.x * Math.sin(turn) + seed.z * Math.cos(turn);
        positions[i * 3] = x + Math.sin(swirl) * agitation * 0.025;
        positions[i * 3 + 1] = seed.y + lift + tumble * agitation * 0.024 + settle * (1.2 - seed.radius);
        positions[i * 3 + 2] = z + Math.cos(swirl * 0.8) * agitation * 0.025;
      }
      glitter.geometry.attributes.position.needsUpdate = true;
      glitter.rotation.y = t * (0.012 + agitation * 0.035);
      glitter.rotation.z = Math.sin(t * 0.08) * 0.025 + agitation * 0.018;
      glitter.material.opacity = Math.min(0.28, agitation * 0.2 + Math.max(0, pulse.value - 0.2) * 0.018);
      glitter.material.size = 0.018 + agitation * 0.014;
      ribbons.forEach((r, i) => {
        r.rotation.z += 0.00016 * (i + 1);
        r.material.emissiveIntensity = 0.2 + pulse.value * 0.18 + Math.sin(t * 0.55 + i) * 0.035;
      });
      streaks.forEach((s, i) => {
        s.material.opacity = 0.08 + Math.max(0, Math.sin(t * 0.65 + i * 0.41)) * 0.14 + pulse.value * 0.035;
        s.scale.y = 0.92 + Math.sin(t * 0.55 + i) * 0.05 + pulse.value * 0.05;
      });
      bubbles.forEach((b, i) => {
        const u = b.userData;
        b.position.x = u.x + Math.sin(t * 0.28 + u.phase) * 0.024;
        b.position.y = u.y + Math.sin(t * 0.42 + u.phase) * 0.032 + pulse.value * 0.012;
        b.scale.setScalar(u.scale * (1 + Math.sin(t * 0.9 + u.phase) * 0.14 + pulse.value * 0.12));
        b.material.opacity = 0.64 + Math.max(0, Math.sin(t * 0.9 + u.phase)) * 0.2 + pulse.value * 0.08;
      });
      glints.children.forEach((g, i) => {});
      highlights.forEach((h, i) => {});
      memoryCtx.clearRect(0, 0, innerWidth, innerHeight);
      memoryCtx.globalCompositeOperation = "lighter";
      for (let i = memoryEvents.length - 1; i >= 0; i--) {
        const event = memoryEvents[i];
        const age = performance.now() - event.born;
        const fade = Math.max(0, 1 - age / event.life);
        if (fade <= 0) {
          memoryEvents.splice(i, 1);
          continue;
        }
        const drift = age * 0.00008;
        memoryCtx.globalAlpha = 0.18 * fade * fade;
        memoryCtx.strokeStyle = event.color;
        memoryCtx.lineWidth = event.width;
        memoryCtx.beginPath();
        memoryCtx.ellipse(event.x, event.y, event.radius + age * 0.006, (event.radius * 0.58) + age * 0.003, -0.18, event.start + drift, event.start + event.span + drift);
        memoryCtx.stroke();
        memoryCtx.globalAlpha = 0.08 * fade;
        memoryCtx.lineWidth = Math.max(1, event.width * 0.45);
        memoryCtx.beginPath();
        memoryCtx.ellipse(event.x, event.y, event.radius * 0.72, event.radius * 0.42, -0.18, event.start + event.span * 0.28, event.start + event.span * 0.88);
        memoryCtx.stroke();
      }
      memoryCtx.globalAlpha = 1;
      memoryCtx.globalCompositeOperation = "source-over";
      controls.update();
      renderer.clear();
      if (frameMode.value === "room") {
        renderer.render(bgScene, bgCamera);
        renderer.clearDepth();
      }
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    }
    animate();
  </script>
  ${pwaScript()}
</body>
</html>`;
}
function readStatic(pathname: string) {
  if (pathname === "/dashboard.json") {
    const p = join(DIR, "dashboard.json");
    return existsSync(p) ? { p, data: readFileSync(p) } : null;
  }
  const p = normalize(join(DIST, pathname));
  if (!p.startsWith(DIST) || !existsSync(p)) return null;
  return { p, data: readFileSync(p) };
}
function readVendor(pathname: string) {
  const taskPrefix = "/vendor/tasks-vision/";
  const modelPrefix = "/vendor/mediapipe-models/";
  if (pathname.startsWith(taskPrefix)) {
    const p = normalize(join(DIR, "node_modules/@mediapipe/tasks-vision", pathname.slice(taskPrefix.length)));
    const root = normalize(join(DIR, "node_modules/@mediapipe/tasks-vision"));
    if (p.startsWith(root) && existsSync(p)) return { p, data: readFileSync(p) };
  }
  if (pathname.startsWith(modelPrefix)) {
    const p = normalize(join(DIR, "public/vendor/mediapipe-models", pathname.slice(modelPrefix.length)));
    const root = normalize(join(DIR, "public/vendor/mediapipe-models"));
    if (p.startsWith(root) && existsSync(p)) return { p, data: readFileSync(p) };
  }
  return null;
}

for (const p of [config.contextDir && join(config.contextDir, "runs"), join(DIR, "src"), join(DIR, "server.ts"), join(DIR, "build-dashboard.ts")].filter((path): path is string => Boolean(path))) {
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
    if (url.pathname === "/manifest.webmanifest") return new Response(manifestJson(), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/sw.js") return new Response(serviceWorkerJs(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "service-worker-allowed": "/" } });
    if (url.pathname === "/icon.svg") return new Response(iconSvg(), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" } });
    if (url.pathname === "/api/app-version") return new Response(appVersionJson(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (url.pathname === "/" || url.pathname === "/watch") return new Response(watchHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard.html" || url.pathname === "/index.html") return Response.redirect(`http://${HOST}:${PORT}/`, 302);
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
    const got = readVendor(decodeURIComponent(url.pathname)) || readStatic(decodeURIComponent(url.pathname));
    if (!got) return new Response("not found", { status: 404 });
    return new Response(got.data, { headers: { "content-type": type(got.p), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
  },
});
console.log(`Glance: http://${HOST}:${PORT}`);
setInterval(() => {}, 1 << 30);
