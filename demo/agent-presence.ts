#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(process.argv[2] || process.env.GLANCE_AGENTS_LOG || ".glance/agents.jsonl");
const states = [
  ["working", "Exploring the project"],
  ["uncertain", "Two approaches look viable"],
  ["blocked", "Waiting for human attention"],
  ["waiting", "A decision would help"],
  ["risky", "Approaching a consequential change"],
  ["done", "Loop complete"],
] as const;

mkdirSync(dirname(output), { recursive: true });
console.log(`Writing Glance agent presence to ${output}`);
for (const [state, note] of states) {
  const event = { version: "glance.agent.v1", ts: new Date().toISOString(), agent: "demo-agent", repo: "glance", state, note, ttlMs: 120000 };
  appendFileSync(output, JSON.stringify(event) + "\n");
  console.log(`${event.agent}: ${state} — ${note}`);
  await Bun.sleep(2200);
}
