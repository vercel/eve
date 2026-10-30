import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

// Not resolved from the installed workspace like the Next.js descriptor's
// dependencies: `nuxt` is only an optional peer of eve, so no copy is
// installed to resolve a version from.
const NUXT_VERSION = "^4.0.0";
const VUE_VERSION = "^3.5.0";

interface NuxtEveServiceDescriptorOptions {
  readonly installDependencies?: boolean;
}

/**
 * A Nuxt host with a generated eve Vercel service whose page uses the
 * auto-imported `useEveAgent()` composable.
 */
export function createNuxtEveServiceDescriptor(
  options: NuxtEveServiceDescriptorOptions = {},
): ScenarioAppDescriptor {
  return {
    dependencies: {
      nuxt: NUXT_VERSION,
      vue: VUE_VERSION,
    },
    files: {
      "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4" });
`,
      "agent/instructions.md": "You are a test agent.\n",
      "app/app.vue": `<script setup lang="ts">
const { status } = useEveAgent();
</script>

<template>
  <main>eve nuxt deployment: {{ status }}</main>
</template>
`,
      "nuxt.config.ts": `export default defineNuxtConfig({
  compatibilityDate: "2026-05-27",
  eve: { eveRoot: "agent" },
  modules: ["eve/nuxt"],
  telemetry: false,
});
`,
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
    },
    installDependencies: options.installDependencies,
    name: "nuxt-eve-service",
  };
}
