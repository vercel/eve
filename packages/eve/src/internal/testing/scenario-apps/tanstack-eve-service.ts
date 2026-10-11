import { createRequire } from "node:module";

import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

// Not resolved from the installed workspace like the Next.js descriptor's
// dependencies: TanStack Start is not an eve dependency, so no copy is
// installed to resolve a version from. `nitro` is the copy eve ships.
const require = createRequire(import.meta.url);
const TANSTACK_ROUTER_VERSION = "^1.170.0";
const TANSTACK_START_VERSION = "^1.168.0";
const NITRO_VERSION = (require("nitro/package.json") as { version: string }).version;
const VITE_REACT_VERSION = "^6.1.0";
const VITE_VERSION = "^8.1.5";
const REACT_VERSION = "^19.0.0";

interface TanStackEveServiceDescriptorOptions {
  readonly installDependencies?: boolean;
}

/**
 * A TanStack Start host with a generated eve Vercel service. The agent lives
 * in the host root, next to the `vite.config.ts` that registers `nitro()`
 * with a user catch-all route that must not shadow eve's route.
 */
export function createTanStackEveServiceDescriptor(
  options: TanStackEveServiceDescriptorOptions = {},
): ScenarioAppDescriptor {
  return {
    dependencies: {
      "@tanstack/react-router": TANSTACK_ROUTER_VERSION,
      "@tanstack/react-start": TANSTACK_START_VERSION,
      "@vitejs/plugin-react": VITE_REACT_VERSION,
      nitro: NITRO_VERSION,
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
      vite: VITE_VERSION,
    },
    files: {
      "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4" });
`,
      "agent/instructions.md": "You are a test agent.\n",
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
      "src/router.tsx": `import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({ routeTree });
}
`,
      "src/routes/__root.tsx": `import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
`,
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <main>eve TanStack Start deployment</main>,
});
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2024"
  }
}
`,
      "vite.config.ts": `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { eveTanStack } from "eve/tanstack";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    eveTanStack(),
    tanstackStart(),
    viteReact(),
    nitro({ vercel: { config: { routes: [{ src: "/(.*)", dest: "/" }] } } }),
  ],
});
`,
    },
    installDependencies: options.installDependencies,
    name: "tanstack-eve-service",
  };
}
