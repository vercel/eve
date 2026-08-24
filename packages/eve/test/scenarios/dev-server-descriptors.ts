import type { ScenarioAppDescriptor } from "../../src/internal/testing/scenario-app.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";

/**
 * Scenario app descriptors and authored-source factories shared by the
 * `dev-server-*` scenario files. Each file boots real `eve dev` processes, so
 * the suite is split by theme to keep individual files short under parallel
 * scenario workers.
 */

export const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;

export const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...Object.fromEntries(
      Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
        ([path]) => !path.startsWith("agent/channels/"),
      ),
    ),
    "agent/channels/dev-generation.ts": [
      'import { defineChannel, GET } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [GET("/dev-generation", () => new Response(process.env.EVE_SCENARIO_RELOAD ?? process.env.EVE_WEBSOCKET_RELOAD ?? "initial"))],',
      "});",
      "",
    ].join("\n"),
  },
};

export const TRANSACTIONAL_REBUILD_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    "agent/channels/dev-generation.ts": createTransactionalRouteSource(),
    "agent/instrumentation.ts": createInstrumentationSource("one"),
  },
};

export function createInstrumentationSource(marker: string): string {
  return [
    "declare global {",
    "  var __EVE_INSTRUMENTATION_MARKER__: string | undefined;",
    "}",
    "",
    `globalThis.__EVE_INSTRUMENTATION_MARKER__ = ${JSON.stringify(marker)};`,
    "export default {};",
    "",
  ].join("\n");
}

export function createTransactionalRouteSource(): string {
  return createTransactionalChannelSource([
    '    GET("/overlap/parameter/:slug", (_request, context) => new Response(`parameter:${context.params.slug}`)),',
    '    GET("/overlap/static", () => new Response("static")),',
  ]);
}

export function createTransactionalChannelSource(routeLines: readonly string[]): string {
  return [
    'import { threadId } from "node:worker_threads";',
    'import { defineChannel, GET } from "eve/channels";',
    "",
    "export default defineChannel({",
    "  routes: [",
    '    GET("/instrumentation-marker", () => new Response(String(globalThis.__EVE_INSTRUMENTATION_MARKER__ ?? "missing"))),',
    '    GET("/worker-id", () => new Response(String(threadId))),',
    ...routeLines,
    "  ],",
    "});",
    "",
  ].join("\n");
}
