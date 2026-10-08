import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { materializeVercelWorkflowFunctionOutput } from "./vercel-workflow-output.js";
it("matches duration and memory only for hub, preserving default builds", async () => {
  for (const hub of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "eve-hub-output-"));
    const server = join(root, "functions/__server.func");
    const flow = join(root, "functions/.well-known/workflow/v1/flow.func");
    try {
      await mkdir(server, { recursive: true });
      await mkdir(flow, { recursive: true });
      await writeFile(
        join(server, ".vc-config.json"),
        JSON.stringify({ runtime: "nodejs24.x", maxDuration: 60, memory: 1024 }),
      );
      await writeFile(
        join(flow, ".vc-config.json"),
        JSON.stringify({ runtime: "nodejs24.x", maxDuration: 800, memory: 2048 }),
      );
      await materializeVercelWorkflowFunctionOutput(root, hub);
      expect(JSON.parse(await readFile(join(server, ".vc-config.json"), "utf8"))).toEqual({
        runtime: "nodejs24.x",
        maxDuration: hub ? 800 : 60,
        memory: hub ? 2048 : 1024,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});
