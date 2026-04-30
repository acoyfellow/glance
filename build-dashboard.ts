#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scanGitObserver } from "./src/git-observer";

const ROOT = process.env.MACHINE_ROOT ?? "/Users/jcoeyman/cloudflare";
const CTX = join(ROOT, ".context");
const WORKERS = join(CTX, "workers");
const RUNS = join(CTX, "runs");
const OUT = join(CTX, "machine-dashboard", "dashboard.json");
const EVENTS = join(CTX, "events.jsonl");
const workerName = process.env.MACHINE_DEFAULT ?? "portfolio-loop";

const lanes: Record<string, any> = {
  ".context rig": { name: ".context rig", state: "active", risk: "medium", why: "local orchestration substrate", finding: "rig + MCP + menubar + dashboard exist", next: "cloud lift for run/session/scheduler primitives", source: ".context" },
  "cloudshell": { name: "cloudshell", state: "active", risk: "low", why: "browser terminal on Cloudflare Sandbox", finding: "Option B allow-list gate LIVE in prod; terminal WS authenticated", next: "Jordan verifies positive-path signup in browser", source: "NOW.md" },
  "filepath": { name: "filepath", state: "active", risk: "medium", why: "future hosted worker-loop/workspace backend", finding: "heartbeat/task/HITL/result primitives exist; dirty schema/migration files", next: "stabilize migration story; define run/session model", source: "portfolio" },
  "deja": { name: "deja", state: "active", risk: "low", why: "memory and steering layer", finding: "dirty feature branch: MCP, recall, bench, docs, marketing. tests/typecheck green", next: "final diff review, split commits, validate", source: "portfolio" },
  "guardrail": { name: "guardrail", state: "active", risk: "medium", why: "policy/safety gate", finding: "dirty hardening branch: shim/config/auth refactors", next: "review behavior risks, split/commit", source: "portfolio" },
  "hermes": { name: "hermes", state: "supporting", risk: "low", why: "secure local agent harness", finding: "smoke pong ok; cf-portal MCP OAuth may open browser", next: "make startup path boring and documented", source: "portfolio" },
  "capa": { name: "capa", state: "supporting", risk: "low", why: "capability/evidence layer for third-party APIs", finding: "Stripe/GitLab/Jira bindings; codegen from OpenAPI", next: "strengthen evidence vocab; connect to Lab/Guardrail", source: "portfolio" },
  "lab": { name: "lab", state: "supporting", risk: "low", why: "trace/receipt product for agent work", finding: "lab.coey.dev live; compose, result viewer, MCP, client pkg", next: "protect trace-first thesis; avoid feature sprawl", source: "portfolio" },
  "cloudterm": { name: "cloudterm", state: "supporting", risk: "low", why: "web terminal emulator component", finding: "~6.7 KiB gz; ANSI/CSI/OSC parser; DOM renderer", next: "keep small and boring as Cloudshell dependency", source: "portfolio" },
  "cloudeval": { name: "cloudeval", state: "supporting", risk: "low", why: "model/agent eval runner and reports", finding: "API/viewer split; runs storage/detail pages", next: "use for focused regression checks", source: "portfolio" },
  "unsurf": { name: "unsurf", state: "watch", risk: "low", why: "browser automation proof layer", finding: "v0.4.0; private traces, MCP, search shipped", next: "use when browser recording/proof needed", source: "portfolio" },
  "contributron": { name: "contributron", state: "watch", risk: "low", why: "GitLab contribution analytics", finding: "local DuckDB + GitLab API scripts", next: "decide script vs real repo/product", source: "portfolio" },
  "coey.dev": { name: "coey.dev", state: "watch", risk: "low", why: "public website / narrative surface", finding: "GitHub repo exists but not cloned locally", next: "clone when website work requested", source: "portfolio" },
  "t2t": { name: "t2t", state: "watch", risk: "low", why: "voice cockpit through MCP", finding: "moved into portfolio root; not configured for Machine", next: "later add Machine MCP config + CF Gateway", source: "portfolio" },
  "mcpu": { name: "mcpu", state: "active", risk: "low", why: "tiny MCP starter-pack substrate: repo-shaped packs that agents can read, write, and commit over MCP", finding: "brand-new local repo, no commits yet; tools are pack.ls/read/write/commit/history backed by Worker KV", next: "make first real commit; validate MCP protocol shape and pack history semantics", source: "git-observer" },
  "cloudflare-work": { name: "cloudflare-work", state: "parked", risk: "gated", why: "day-job lane: stratus, lee, cloudchamber, ai-benchmarking", finding: "ai-benchmarking dirty; others clean. work mode gated", next: "do not touch unless Jordan says work mode", source: "policy" },
  "a0": { name: "a0", state: "watch", risk: "low", why: "archive/reference lane for agent packaging, git-backed skills, gates, and Worker runtime lessons", finding: "no longer branded burned; useful source material, not active implementation", next: "mine lessons when relevant; resume only with explicit narrow trigger", source: "policy" },
};

function readJson(path: string) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function tail(path: string, n: number) { if (!existsSync(path)) return []; return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-n); }
function pidAlive(pid: any) { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function files(dir: string): string[] { if (!existsSync(dir)) return []; let out: string[]=[]; for (const ent of readdirSync(dir,{withFileTypes:true})) { const p=join(dir,ent.name); if (ent.isDirectory()) out=out.concat(files(p)); else if (ent.isFile() && ent.name.endsWith('.md')) out.push(p); } return out; }
function readEvents(n=120) {
  if (!existsSync(EVENTS)) return [];
  return readFileSync(EVENTS, "utf8").split(/\r?\n/).filter(Boolean).slice(-n).map(line => { try { return JSON.parse(line); } catch { return { ts: null, type: "raw", summary: line }; } });
}
function rel(p: string) { return p.replace(ROOT + "/", ""); }

const workerFiles = existsSync(WORKERS) ? readdirSync(WORKERS).filter(f => f.endsWith(".json")) : [];
const workers = workerFiles.map(f => { const st = readJson(join(WORKERS, f)); return st ? { ...st, controllerAlive: pidAlive(st.pid) } : null; }).filter(Boolean);
const activeWorkers = workers.filter((w:any) => w.controllerAlive || ["running", "starting-background", "waiting_for_input", "stop-requested"].includes(w.status));
const state = readJson(join(WORKERS, `${workerName}.json`));
const pings = tail(join(WORKERS, `${workerName}.ping.log`), 20);
const runFiles = files(RUNS).map(p => ({ path: rel(p), mtime: statSync(p).mtimeMs, size: statSync(p).size })).sort((a,b)=>b.mtime-a.mtime).slice(0, 12);

for (const f of runFiles.slice().reverse()) {
  let txt = ""; try { txt = readFileSync(join(ROOT, f.path), "utf8"); } catch {}
  const lower = txt.toLowerCase();
  for (const key of Object.keys(lanes)) {
    if (lower.includes(key.toLowerCase())) {
      lanes[key].lastTouched = new Date(f.mtime).toISOString();
      lanes[key].source = f.path;
    }
  }
  if (lower.includes("cloudshell") && (lower.includes("unauth") || lower.includes("public shell") || lower.includes("/api/terminal"))) {
    Object.assign(lanes.cloudshell, { state: "active", risk: "critical", finding: "public unauthenticated shell/WebSocket/PTY risk", next: "gate with Cloudflare Access/auth or take offline", source: f.path, lastTouched: new Date(f.mtime).toISOString() });
  }
  if (lower.includes("filepath") && lower.includes("heartbeat")) {
    Object.assign(lanes.filepath, { state: "active", risk: "medium", finding: "strong worker-loop fit: heartbeat/task/cancel/HITL/results", next: "add explicit run/session/scheduler/receipt model", source: f.path, lastTouched: new Date(f.mtime).toISOString() });
  }
}

const events = readEvents(160);
const gitObserver = scanGitObserver();
// NOTE: activeNow / "WORKING" column was removed because scanning event text for
// project name mentions is too brittle. A durable "current focus" signal will be
// added later (e.g. worker objective, explicit user toggle, or lane heartbeat).

const dashboard = {
  generatedAt: new Date().toISOString(),
  workers,
  activeWorkers,
  machine: {
    worker: workerName,
    state,
    controllerAlive: state ? pidAlive(state.pid) : false,
    lastPing: pings[pings.length - 1] ?? null,
    pings,
  },
  gitObserver,
  lanes: Object.values(lanes),
  events,
  recentRuns: runFiles.map(f => ({ ...f, mtime: new Date(f.mtime).toISOString() })),
};
writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + "\n");
console.log(OUT);
