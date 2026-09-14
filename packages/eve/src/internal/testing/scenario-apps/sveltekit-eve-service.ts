import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const SVELTEKIT_VERSION = "^2.63.0";
const SVELTE_VERSION = "^5.0.0";
const VITE_VERSION = "^8.1.5";

export interface SvelteKitEveServiceDescriptorOptions {
  readonly installDependencies?: boolean;
}

/**
 * A SvelteKit host with a generated eve Vercel service.
 */
export function createSvelteKitEveServiceDescriptor(
  options: SvelteKitEveServiceDescriptorOptions = {},
): ScenarioAppDescriptor {
  return {
    dependencies: {
      "@sveltejs/adapter-vercel": "^6.3.0",
      "@sveltejs/kit": SVELTEKIT_VERSION,
      svelte: SVELTE_VERSION,
      vite: VITE_VERSION,
    },
    files: {
      "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4" });
`,
      "agent/instructions.md": "You are a test agent.\n",
      "src/app.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">%sveltekit.body%</body>
</html>
`,
      "src/routes/+page.svelte": "<main>eve SvelteKit deployment</main>\n",
      "svelte.config.js": `import adapter from "@sveltejs/adapter-vercel";

export default { kit: { adapter: adapter() } };
`,
      "vite.config.js": `import { sveltekit } from "@sveltejs/kit/vite";
import { eveSvelteKit } from "eve/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [eveSvelteKit({ eveRoot: "agent" }), sveltekit()] });
`,
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
    },
    installDependencies: options.installDependencies,
    name: "sveltekit-eve-service",
  };
}
