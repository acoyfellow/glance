import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("exposes only Watch and Orb over a configured local root", async () => {
  const root = mkdtempSync(join(tmpdir(), "glance-smoke-"));
  mkdirSync(join(root, "demo", ".git"), { recursive: true });
  writeFileSync(join(root, "demo", "hello.ts"), "export const hello = 'world';\n");
  const port = "18789";
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  let stderr = "";
  const child = spawn("bun", ["run", "server.ts"], {
    cwd: repo,
    env: { ...process.env, GLANCE_ROOT: root, MACHINE_DASHBOARD_PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => stderr += String(chunk));
  const request = (path: string) => fetch(`http://localhost:${port}${path}`);

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if ((await request("/orb")).ok) { ready = true; break; }
      } catch {}
      await Bun.sleep(100);
    }
    expect(ready, stderr || "server did not start").toBe(true);

    const manifest = await (await request("/manifest.webmanifest")).json() as any;
    expect(manifest.name).toBe("Glance");
    expect(manifest.shortcuts.map((entry: any) => entry.name)).toEqual(["Watch", "Orb"]);
    for (const route of ["/agents", "/harnesses", "/api/token", "/api/system/lock", "/api/conversations"]) {
      expect((await request(route)).status).toBe(404);
    }
    const activity = await (await request("/api/recent-files")).json() as any;
    expect(String(activity.root)).toContain("glance-smoke-");
  } finally {
    child.kill();
  }
});
