import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

// Not resolved from the installed workspace like the Next.js descriptor's
// dependencies: `nuxt` is only an optional peer of eve, so no copy is
// installed to resolve a version from.
const NUXT_VERSION = "^4.0.0";
const VUE_VERSION = "^3.5.0";

interface NuxtEveServiceDescriptorOptions {
  readonly installDependencies?: boolean;
  /**
   * Origin of a separately deployed agent. When set, the host has no `agent/`
   * directory and configures `eve.remote` instead of `eve.eveRoot`.
   */
  readonly remote?: string;
}

/**
 * A Nuxt host with a generated eve Vercel service, or a host that routes to a
 * remote agent when `remote` is set.
 */
export function createNuxtEveServiceDescriptor(
  options: NuxtEveServiceDescriptorOptions = {},
): ScenarioAppDescriptor {
  const eveConfig =
    options.remote === undefined ? `{ eveRoot: "agent" }` : `{ remote: "${options.remote}" }`;
  const agentFiles: Record<string, string> =
    options.remote === undefined
      ? {
          "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "${DEFAULT_AGENT_MODEL_ID}" });
`,
          "agent/instructions.md": "You are a test agent.\n",
        }
      : {};

  return {
    dependencies: {
      nuxt: NUXT_VERSION,
      vue: VUE_VERSION,
    },
    files: {
      ...agentFiles,
      "app/app.vue": `<template>
  <main>eve nuxt deployment</main>
</template>
`,
      "nuxt.config.ts": `export default defineNuxtConfig({
  compatibilityDate: "2026-05-27",
  eve: ${eveConfig},
  modules: ["eve/nuxt"],
  telemetry: false,
});
`,
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
    },
    installDependencies: options.installDependencies,
    name: options.remote === undefined ? "nuxt-eve-service" : "nuxt-eve-remote",
  };
}
