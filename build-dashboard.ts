#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appDir, loadConfig } from "./src/config";
import { scanGitObserver } from "./src/git-observer";

const config = loadConfig(import.meta.url);
const ROOT = config.root;
const DIR = appDir(import.meta.url);
const RUNS = config.contextDir ? join(config.contextDir, "runs") : undefined;
const EVENTS = config.contextDir ? join(config.contextDir, "events.jsonl") : undefined;
const OUT = join(DIR, "dashboard.json");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out = out.concat(files(path));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(path);
  }
  return out;
}

function readEvents(limit = 120) {
  if (!EVENTS || !existsSync(EVENTS)) return [];
  return readFileSync(EVENTS, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return { ts: null, type: "raw", summary: line }; }
  });
}

const runFiles = RUNS
  ? files(RUNS).map((path) => ({ path: relative(ROOT, path), mtime: statSync(path).mtimeMs, size: statSync(path).size })).sort((a, b) => b.mtime - a.mtime).slice(0, 12)
  : [];

const gitObserver = scanGitObserver(config);
const dashboard = {
  generatedAt: new Date().toISOString(),
  status: "observing",
  root: ROOT,
  gitObserver,
  events: readEvents(160),
  recentRuns: runFiles.map((file) => ({ ...file, mtime: new Date(file.mtime).toISOString() })),
};
writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + "\n");
console.log(OUT);
