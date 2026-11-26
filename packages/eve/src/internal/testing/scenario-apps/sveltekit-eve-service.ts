import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const SVELTE_VERSION = "^5.57.1";
const VITE_VERSION = "^8.1.5";

const SVELTEKIT_VERSIONS = {
  2: { adapter: "^6.3.5", kit: "^2.63.0" },
  3: { adapter: "^7.0.5", kit: "^3.4.1" },
} as const;

interface SvelteKitEveServiceDescriptorOptions {
  readonly installDependencies?: boolean;
  readonly sveltekitMajor?: keyof typeof SVELTEKIT_VERSIONS;
}

export function createSvelteKitEveServiceDescriptor(
  options: SvelteKitEveServiceDescriptorOptions = {},
): ScenarioAppDescriptor {
  const versions = SVELTEKIT_VERSIONS[options.sveltekitMajor ?? 2];
  return {
    dependencies: {
      "@sveltejs/adapter-vercel": versions.adapter,
      "@sveltejs/kit": versions.kit,
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
      "vite.config.js": `import adapter from "@sveltejs/adapter-vercel";
import { sveltekit } from "@sveltejs/kit/vite";
import { eveSvelteKit } from "eve/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [eveSvelteKit({ eveRoot: "agent" }), sveltekit({ adapter: adapter() })],
});
`,
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
    },
    installDependencies: options.installDependencies,
    name: "sveltekit-eve-service",
  };
}
