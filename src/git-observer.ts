import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.MACHINE_ROOT ?? "/Users/jcoeyman/cloudflare";
const DATA_DIR = join(ROOT, ".context/machine-dashboard/data/git-observer");
const OUT = join(DATA_DIR, "state.json");
const HISTORY_DIR = join(DATA_DIR, "history");
const MAX_DEPTH = Number(process.env.GIT_OBSERVER_MAX_DEPTH ?? 3);
const SKIP = new Set(["node_modules", ".next", ".svelte-kit", "dist", "build", ".wrangler", ".turbo", ".cache"]);

type RepoState = {
  path: string;
  branch: string;
  head: string;
  dirty: number;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  attention: "clean" | "low" | "medium" | "high" | "noise";
  noiseReason: string | null;
  sample: string[];
};

type ObserverState = {
  generatedAt: string;
  root: string;
  mode: string;
  repoCount: number;
  dirtyCount: number;
  aheadCount: number;
  behindCount: number;
  delta: {
    previousAt: string | null;
    newDirty: string[];
    cleaned: string[];
    branchChanged: { path: string; from: string; to: string }[];
    headChanged: { path: string; from: string; to: string }[];
    dirtyChanged: { path: string; from: number; to: number }[];
  };
  repos: RepoState[];
};

function findRepos(dir: string, depth = 0, out: string[] = []): string[] {
  if (existsSync(join(dir, ".git"))) {
    out.push(dir);
    return out;
  }
  if (depth >= MAX_DEPTH) return out;
  let entries: ReturnType<typeof readdirSync> = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory() || SKIP.has(ent.name)) continue;
    if (ent.name.startsWith(".") && ent.name !== ".context") continue;
    findRepos(join(dir, ent.name), depth + 1, out);
  }
  return out;
}

function git(repo: string, args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 4500 });
}

function summarize(repo: string): RepoState {
  const porcelain = git(repo, ["status", "--porcelain=v1", "--branch"]);
  const lines = porcelain.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## ")) ?? "## unknown";
  const changes = lines.filter((line) => !line.startsWith("## "));
  const sample = changes.slice(0, 8);
  let branch = branchLine.replace(/^##\s+/, "").replace(/\.\.\..*$/, "");
  if (branch === "HEAD (no branch)") branch = "detached";
  const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0);
  const head = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim() || "unknown";
  const classification = classify(changes);
  return {
    path: relative(ROOT, repo) || ".",
    branch,
    head,
    dirty: changes.length,
    staged: changes.filter((line) => line[0] !== " " && line[0] !== "?").length,
    unstaged: changes.filter((line) => line[1] !== " " && line[0] !== "?").length,
    untracked: changes.filter((line) => line.startsWith("??")).length,
    ahead,
    behind,
    ...classification,
    sample,
  };
}

function classify(changes: string[]): Pick<RepoState, "attention" | "noiseReason"> {
  if (changes.length === 0) return { attention: "clean", noiseReason: null };
  const paths = changes.map((line) => line.slice(3));
  const nodeModules = paths.filter((path) => path.includes("node_modules/")).length;
  const generated = paths.filter((path) => /(^|\/)(dist|build|\.svelte-kit|\.next|coverage)\//.test(path)).length;
  const dsStore = paths.filter((path) => path.endsWith(".DS_Store")).length;
  if (nodeModules / changes.length > 0.6) return { attention: "noise", noiseReason: "mostly node_modules" };
  if ((generated + dsStore) / changes.length > 0.6) return { attention: "noise", noiseReason: "mostly generated files" };
  if (changes.length > 100) return { attention: "high", noiseReason: null };
  if (changes.length > 10) return { attention: "medium", noiseReason: null };
  return { attention: "low", noiseReason: null };
}

export function scanGitObserver() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(HISTORY_DIR, { recursive: true });
  const previous = readPrevious();
  const repos = findRepos(ROOT)
    .sort((a, b) => relative(ROOT, a).localeCompare(relative(ROOT, b)))
    .map(summarize)
    .sort((a, b) => attentionRank(b) - attentionRank(a) || b.dirty - a.dirty || a.path.localeCompare(b.path));
  const state: ObserverState = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    mode: ".git observer",
    repoCount: repos.length,
    dirtyCount: repos.filter((repo) => repo.dirty > 0).length,
    attentionCount: repos.filter((repo) => ["medium", "high"].includes(repo.attention)).length,
    noiseCount: repos.filter((repo) => repo.attention === "noise").length,
    aheadCount: repos.filter((repo) => repo.ahead > 0).length,
    behindCount: repos.filter((repo) => repo.behind > 0).length,
    delta: diff(previous, repos),
    repos,
  };
  writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n");
  writeFileSync(join(HISTORY_DIR, `${state.generatedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(state, null, 2) + "\n");
  return state;
}

function attentionRank(repo: RepoState) {
  return { high: 5, medium: 4, low: 3, noise: 2, clean: 1 }[repo.attention];
}

function readPrevious(): ObserverState | null {
  try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return null; }
}

function diff(previous: ObserverState | null, repos: RepoState[]): ObserverState["delta"] {
  const prevByPath = new Map((previous?.repos ?? []).map((repo) => [repo.path, repo]));
  const nextByPath = new Map(repos.map((repo) => [repo.path, repo]));
  return {
    previousAt: previous?.generatedAt ?? null,
    newDirty: repos.filter((repo) => repo.dirty > 0 && (prevByPath.get(repo.path)?.dirty ?? 0) === 0).map((repo) => repo.path),
    cleaned: [...prevByPath.values()].filter((repo) => repo.dirty > 0 && (nextByPath.get(repo.path)?.dirty ?? 0) === 0).map((repo) => repo.path),
    branchChanged: repos
      .filter((repo) => prevByPath.has(repo.path) && prevByPath.get(repo.path)!.branch !== repo.branch)
      .map((repo) => ({ path: repo.path, from: prevByPath.get(repo.path)!.branch, to: repo.branch })),
    headChanged: repos
      .filter((repo) => prevByPath.has(repo.path) && prevByPath.get(repo.path)!.head !== repo.head)
      .map((repo) => ({ path: repo.path, from: prevByPath.get(repo.path)!.head, to: repo.head })),
    dirtyChanged: repos
      .filter((repo) => prevByPath.has(repo.path) && prevByPath.get(repo.path)!.dirty !== repo.dirty)
      .map((repo) => ({ path: repo.path, from: prevByPath.get(repo.path)!.dirty, to: repo.dirty })),
  };
}

if (import.meta.main) {
  scanGitObserver();
  console.log(OUT);
}
