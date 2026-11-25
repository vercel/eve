import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "../../src/internal/testing/scenario-app.js";
import {
  DEV_SERVER_AGENT_DESCRIPTOR,
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
} from "./dev-server-descriptors.js";
import {
  fetchText,
  forceDevelopmentRebuild,
  type RunningEveDev,
  startEveDev,
} from "#internal/testing/dev-server-harness.js";

function platformSource(marker: string): string {
  return [
    'import { definePlatform } from "eve/experimental/platform";',
    "",
    "declare global {",
    "  var __EVE_PLATFORM_MARKER__: string | undefined;",
    "}",
    "",
    "export default definePlatform({",
    "  context: () => {",
    `    globalThis.__EVE_PLATFORM_MARKER__ = ${JSON.stringify(marker)};`,
    "  },",
    "  deployment: () => ({",
    '    environment: () => "development",',
    "    deploymentId: () => undefined,",
    "    host: () => undefined,",
    "    scope: () => undefined,",
    "  }),",
    "});",
    "",
  ].join("\n");
}

const PLATFORM_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  name: "dev-platform-module",
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    "agent/platform.ts": platformSource("alice"),
    "agent/channels/platform-marker.ts": [
      'import { defineChannel, GET } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [GET("/platform-marker", () => new Response(String(globalThis.__EVE_PLATFORM_MARKER__ ?? "missing")))],',
      "});",
      "",
    ].join("\n"),
  },
};

describe("eve dev with agent/platform.ts", () => {
  let appRoot: string;
  let cleanupApp: (() => Promise<void>) | undefined;
  let server: RunningEveDev;

  beforeAll(async () => {
    const app = await materializeScenarioApp(PLATFORM_DESCRIPTOR);
    appRoot = app.appRoot;
    cleanupApp = app.cleanup;
    server = await startEveDev(appRoot);
  }, DEV_SERVER_SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await cleanupApp?.();
  }, DEV_SERVER_SCENARIO_TIMEOUT_MS);

  it(
    "starts the dev worker on the platform the agent gives, and keeps it until eve dev restarts",
    async () => {
      expect(await fetchText(server.url, "/platform-marker")).toBe("alice");

      await writeFile(join(appRoot, "agent", "platform.ts"), platformSource("bob"));
      await forceDevelopmentRebuild(server.url);

      expect(await fetchText(server.url, "/platform-marker")).toBe("alice");
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
