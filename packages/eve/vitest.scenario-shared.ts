import type { AliasOptions } from "vite";
import type { TestUserConfig } from "vitest/config";

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
  globalSetup: ["./test/setup/pack-scenario-tarball.ts"],
  server: {
    deps: {
      external: [/[\\/]\.output[\\/]/u, /[\\/]\.vercel[\\/]output[\\/]/u],
    },
  },
  setupFiles: ["./test/setup/mock-ai-gateway.ts"],
  testTimeout: 120_000,
} satisfies TestUserConfig;

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

export const PACKAGING_SCENARIO_FILES = [
  "src/ai/package.scenario.test.ts",
  "src/self-modification/package-consumption.scenario.test.ts",
  "test/scenarios/bundle-module-evaluation.scenario.test.ts",
  "test/scenarios/cli.scenario.test.ts",
  "test/scenarios/eve-init.scenario.test.ts",
  "test/scenarios/file-memory-provider.scenario.test.ts",
  "test/scenarios/mounted-extension-installed.scenario.test.ts",
  "test/scenarios/packed-host-build.scenario.test.ts",
];

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

export const PUBLIC_TYPES_SCENARIO_FILES = [
  "test/scenarios/packed-client-types.scenario.test.ts",
  "test/scenarios/packed-public-types.scenario.test.ts",
  "test/scenarios/public-api-portability.scenario.test.ts",
];
