import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const ADAPTER_VITE_CONFIG = `import { mkdir, writeFile } from "node:fs/promises";

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
`;

const SPA_VITE_CONFIG = `import { eveVite } from "eve/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [eveVite()],
});
`;

export function createViteEveServiceDescriptor(
  options: { readonly buildOutputAdapter?: boolean } = {},
): ScenarioAppDescriptor {
  const buildOutputAdapter = options.buildOutputAdapter ?? true;
  return {
    dependencies: { vite: "^8.3.1" },
    files: {
      "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4" });
`,
      "agent/instructions.md": "You are a test agent.\n",
      "index.html":
        '<!doctype html><title>eve Vite deployment</title><script type="module" src="/main.js"></script>\n',
      "main.js": 'document.body.textContent = "eve";\n',
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
      "vite.config.ts": buildOutputAdapter ? ADAPTER_VITE_CONFIG : SPA_VITE_CONFIG,
    },
    installDependencies: true,
    name: buildOutputAdapter ? "vite-eve-service" : "vite-spa-eve-service",
  };
}
