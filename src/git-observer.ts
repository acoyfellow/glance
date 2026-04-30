import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.env.MACHINE_ROOT ?? "/Users/jcoeyman/cloudflare";
const DATA_DIR = join(ROOT, ".context/machine-dashboard/data/git-observer");
const OUT = join(DATA_DIR, "state.json");
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
  sample: string[];
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
    sample,
  };
}

export function scanGitObserver() {
  mkdirSync(DATA_DIR, { recursive: true });
  const repos = findRepos(ROOT)
    .sort((a, b) => relative(ROOT, a).localeCompare(relative(ROOT, b)))
    .map(summarize);
  const state = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    mode: ".git observer",
    repoCount: repos.length,
    dirtyCount: repos.filter((repo) => repo.dirty > 0).length,
    aheadCount: repos.filter((repo) => repo.ahead > 0).length,
    behindCount: repos.filter((repo) => repo.behind > 0).length,
    repos,
  };
  writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n");
  return state;
}

if (import.meta.main) {
  scanGitObserver();
  console.log(OUT);
}
