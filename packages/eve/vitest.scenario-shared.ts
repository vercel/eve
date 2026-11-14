import type { AliasOptions } from "vite";
import type { TestUserConfig } from "vitest/config";

/**
 * Settings shared by every config that runs scenario files, and the lists
 * that split scenario files by area: `test:scenario` runs eve (`eve dev`,
 * `eve start`, real files and shells), `test:build` builds and packages apps
 * with eve, and `test:public-types` type-checks the published declarations.
 */

export const SCENARIO_ALIASES: AliasOptions = [
  {
    find: /^#compiled\/(.+)\.js$/,
    replacement: new URL("./.generated/compiled/$1.js", import.meta.url).pathname,
  },
  {
    find: /^#(.+)\.js$/,
    replacement: new URL("./src/$1.ts", import.meta.url).pathname,
  },
];

export const SCENARIO_TEST_OPTIONS = {
  environment: "node",
  exclude: ["**/node_modules/**"],
  // Packs the eve tarball once, from the prebuilt dist, before workers fork.
  globalSetup: ["./test/setup/pack-scenario-tarball.ts"],
  server: {
    deps: {
      // Built app output is self-contained, multi-megabyte JavaScript. Node
      // loads it as a deployment would; transforming it through Vite costs
      // seconds per import.
      external: [/[\\/]\.output[\\/]/u, /[\\/]\.vercel[\\/]output[\\/]/u],
    },
  },
  setupFiles: ["./test/setup/mock-ai-gateway.ts"],
  testTimeout: 120_000,
} satisfies TestUserConfig;

/**
 * Builds and dev servers of framework hosts, run by `test:build` as the
 * `framework-builds` project.
 */
export const FRAMEWORK_SCENARIO_FILES = [
  "test/scenarios/framework-next-build.scenario.test.ts",
  "test/scenarios/framework-nuxt-build.scenario.test.ts",
  "test/scenarios/framework-nuxt-dev.scenario.test.ts",
  "test/scenarios/framework-sveltekit-build.scenario.test.ts",
  "test/scenarios/framework-tanstack-build.scenario.test.ts",
  "test/scenarios/framework-vite-build.scenario.test.ts",
  "test/scenarios/framework-vite-dev.scenario.test.ts",
  "test/scenarios/hostless-agent-workspace.scenario.test.ts",
  "test/scenarios/next-entrypoint-isolation.scenario.test.ts",
  "test/scenarios/registry-channel-web-tanstack.scenario.test.ts",
  "test/scenarios/web-chat-service-build.scenario.test.ts",
];

/**
 * Consumers of the packed eve tarball and the CLI it ships, run by
 * `test:build` as the `packaging` project.
 */
export const PACKAGING_SCENARIO_FILES = [
  "src/ai/package.scenario.test.ts",
  "src/self-modification/package-consumption.scenario.test.ts",
  "test/scenarios/bundle-module-evaluation.scenario.test.ts",
  "test/scenarios/cli.scenario.test.ts",
  "test/scenarios/dev-host-reuse.scenario.test.ts",
  "test/scenarios/eve-init.scenario.test.ts",
  "test/scenarios/file-memory-provider.scenario.test.ts",
  "test/scenarios/mounted-extension-installed.scenario.test.ts",
  "test/scenarios/packed-host-build.scenario.test.ts",
];

/**
 * `eve build` and the Nitro and Vercel host output it writes, run by
 * `test:build` as the `production-build` project.
 */
export const PRODUCTION_BUILD_SCENARIO_FILES = [
  "src/internal/external-resources.scenario.test.ts",
  "src/internal/nitro/host/authored-workflow-scope.scenario.test.ts",
  "src/internal/nitro/host/build-deployment-id.scenario.test.ts",
  "src/internal/nitro/host/build-extension.scenario.test.ts",
  "src/internal/nitro/host/generated-host-data.scenario.test.ts",
  "src/internal/nitro/host/host-config-isolation.scenario.test.ts",
  "src/internal/nitro/host/host-routes.scenario.test.ts",
  "src/internal/nitro/host/instrumentation-entry.scenario.test.ts",
  "src/internal/nitro/host/react-server-module-map.scenario.test.ts",
  "src/internal/nitro/host/relocated-production.scenario.test.ts",
  "src/internal/nitro/host/start-production-server.scenario.test.ts",
  "src/internal/nitro/host/vercel-schedules-output.scenario.test.ts",
  "src/internal/nitro/host/vercel-service-output.scenario.test.ts",
  "src/internal/workflow-bundle/builder.scenario.test.ts",
  "test/scenarios/app-external-dependencies.scenario.test.ts",
  "test/scenarios/app-runtime-dependencies.scenario.test.ts",
  "test/scenarios/bin-build-output.scenario.test.ts",
  "test/scenarios/compile-agent.scenario.test.ts",
  "test/scenarios/nitro-bundle-report.scenario.test.ts",
  "test/scenarios/production-build-isolation.scenario.test.ts",
];

/** Type checks of the published declarations, run by `test:public-types`. */
export const PUBLIC_TYPES_SCENARIO_FILES = [
  "test/scenarios/packed-client-types.scenario.test.ts",
  "test/scenarios/packed-public-types.scenario.test.ts",
  "test/scenarios/public-api-portability.scenario.test.ts",
];
