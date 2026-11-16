import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

/**
 * A Vite host with a generated eve Vercel service. The agent lives in the
 * host root, and a stand-in for a framework adapter writes the Vercel Build
 * Output in `closeBundle`, as real adapters do, so `eveVite()` must run after
 * the environment builds.
 */
export function createViteEveServiceDescriptor(): ScenarioAppDescriptor {
  return {
    dependencies: { vite: "^8.3.1" },
    files: {
      "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4" });
`,
      "agent/instructions.md": "You are a test agent.\n",
      "index.html": "<!doctype html><title>eve Vite deployment</title>\n",
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
      "vite.config.ts": `import { mkdir, writeFile } from "node:fs/promises";

import { eveVite } from "eve/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "build-output",
      async closeBundle() {
        await mkdir(".vercel/output", { recursive: true });
        await writeFile(
          ".vercel/output/config.json",
          JSON.stringify({ routes: [{ handle: "filesystem" }], version: 3 }),
        );
      },
    },
    eveVite(),
  ],
});
`,
    },
    installDependencies: true,
    name: "vite-eve-service",
  };
}
