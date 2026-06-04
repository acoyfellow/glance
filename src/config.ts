import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type GlanceConfig = {
  root: string;
  contextDir?: string;
};

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function appDir(metaUrl: string): string {
  return dirname(new URL(metaUrl).pathname);
}

export function loadConfig(metaUrl: string): GlanceConfig {
  const dir = appDir(metaUrl);
  const configPath = expandHome(process.env.GLANCE_CONFIG ?? join(dir, "glance.config.json"));
  let file: Partial<GlanceConfig> = {};
  if (existsSync(configPath)) {
    try { file = JSON.parse(readFileSync(configPath, "utf8")); } catch { file = {}; }
  }
  const configuredRoot = process.env.GLANCE_ROOT ?? process.env.MACHINE_ROOT ?? file.root ?? dirname(dir);
  const root = resolve(expandHome(configuredRoot));
  const contextValue = process.env.GLANCE_CONTEXT_DIR ?? file.contextDir;
  const contextDir = contextValue ? resolve(root, expandHome(contextValue)) : undefined;
  return { root, contextDir };
}
