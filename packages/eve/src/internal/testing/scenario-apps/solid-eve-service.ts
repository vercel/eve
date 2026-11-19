import { createRequire } from "node:module";

import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const require = createRequire(import.meta.url);
const NITRO_VERSION = (require("nitro/package.json") as { version: string }).version;
const SOLID_VERSION = "2.0.1";
const SOLID_VITE_PLUGIN_VERSION = "3.0.1";
const VITE_VERSION = "^8.3.8";

interface SolidEveServiceDescriptorOptions {
  readonly nitro?: boolean;
  readonly ssr: boolean;
}

export function createSolidEveServiceDescriptor(
  options: SolidEveServiceDescriptorOptions,
): ScenarioAppDescriptor {
  const dependencies: Record<string, string> = {
    "@solidjs/vite-plugin": SOLID_VITE_PLUGIN_VERSION,
    "@solidjs/web": SOLID_VERSION,
    "solid-js": SOLID_VERSION,
    vite: VITE_VERSION,
  };
  if (options.nitro) dependencies.nitro = NITRO_VERSION;

  return {
    dependencies,
    files: {
      "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4" });
`,
      "agent/instructions.md": "You are a test agent.\n",
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
      "src/App.tsx": `import { useEveAgent } from "eve/solid";

export default function App() {
  const agent = useEveAgent();
  return <main data-status={agent.status()}>{agent.messages().length} messages</main>;
}
`,
      "vite.config.ts": `import solid from "@solidjs/vite-plugin";
import { eveVite } from "eve/vite";
${options.nitro ? 'import { nitro } from "nitro/vite";\n' : ""}import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solid({ start: true${options.ssr ? ", ssr: true" : ""} }), ${options.nitro ? "nitro(), " : ""}eveVite()],
});
`,
    },
    installDependencies: true,
    name: `solid-${options.ssr ? "ssr" : "spa"}${options.nitro ? "-nitro" : ""}-eve-service`,
  };
}
