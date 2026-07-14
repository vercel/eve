import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  fetchAgentInfo,
  fetchText,
  forceDevelopmentRebuild,
  hasKnownDevServerFailure,
  readDevelopmentRevision,
  startEveDev,
  wait,
  waitForCondition,
  withinDeadline,
  type RunningEveDev,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const CHAOS_SCENARIO_TIMEOUT_MS = 360_000;

const CHAOS_CHANNEL_SOURCE = [
  'import { randomUUID } from "node:crypto";',
  'import { defineChannel, GET } from "eve/channels";',
  "",
  "const workerId = randomUUID();",
  "",
  "export default defineChannel({",
  "  routes: [",
  '    GET("/chaos/worker-id", () => new Response(workerId)),',
  '    GET("/chaos/crash", () => {',
  "      setTimeout(() => process.exit(7), 25);",
  '      return new Response("crashing");',
  "    }),",
  '    GET("/chaos/request-ip", (_request, context) => new Response(String(context.requestIp))),',
  '    GET("/chaos/slow-stream", () => {',
  "      let timer: ReturnType<typeof setInterval> | undefined;",
  "      const body = new ReadableStream({",
  "        start(controller) {",
  '          controller.enqueue(new TextEncoder().encode("chunk\\n"));',
  "          timer = setInterval(() => {",
  '            controller.enqueue(new TextEncoder().encode("chunk\\n"));',
  "          }, 50);",
  "        },",
  "        cancel() {",
  "          clearInterval(timer);",
  "        },",
  "      });",
  "      return new Response(body);",
  "    }),",
  "  ],",
  "});",
  "",
].join("\n");

const CHAOS_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...WEATHER_AGENT_DESCRIPTOR.files,
    "agent/channels/chaos.ts": CHAOS_CHANNEL_SOURCE,
  },
  name: "weather-agent-chaos",
};

function toolSource(marker: string): string {
  return [
    'import { defineTool } from "eve/tools";',
    'import { z } from "zod";',
    "",
    "export default defineTool({",
    `  description: ${JSON.stringify(`Report the weather (${marker}).`)},`,
    "  inputSchema: z.object({ city: z.string() }),",
    "  execute: ({ city }) => `sunny in ${city}`,",
    "});",
    "",
  ].join("\n");
}

interface HealthProbe {
  readonly failures: readonly string[];
  stop(): Promise<number>;
}

function startHealthProbe(serverUrl: string): HealthProbe {
  const failures: string[] = [];
  let probes = 0;
  let stopped = false;
  const run = (async () => {
    while (!stopped) {
      probes += 1;
      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, serverUrl), {
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 200) {
          failures.push(`health returned ${String(response.status)}`);
        }
        await response.arrayBuffer();
      } catch (error) {
        failures.push(`health request failed: ${String(error)}`);
      }
      await wait(50);
    }
  })();

  return {
    failures,
    async stop() {
      stopped = true;
      await run;
      return probes;
    },
  };
}

async function completeStreamedTurn(server: RunningEveDev, message: string): Promise<void> {
  const result = await sendDevelopmentMessage({
    message,
    session: createDevelopmentSessionState(),
    serverUrl: server.url,
  });
  expect(
    result.events.some((event) => event.type === "message.completed"),
    [
      "Expected a streamed turn to complete after the chaos sequence.",
      `stdout:\n${server.stdout()}`,
      `stderr:\n${server.stderr()}`,
    ].join("\n\n"),
  ).toBe(true);
}

async function waitForToolMarker(serverUrl: string, marker: string): Promise<void> {
  await waitForCondition(async () => {
    const info = await fetchAgentInfo(serverUrl);
    return info.tools.authored.some((tool) => tool.description?.includes(marker));
  }, `Timed out waiting for the "${marker}" tool revision to publish.`);
}

describe("eve dev server chaos", () => {
  it(
    "keeps every request succeeding through an authored edit storm",
    async () => {
      const app = await scenarioApp(CHAOS_DESCRIPTOR);
      const toolPath = join(app.appRoot, "agent", "tools", "get_weather.ts");
      const server = await startEveDev(app.appRoot);
      const probe = startHealthProbe(server.url);

      try {
        for (let round = 1; round <= 3; round += 1) {
          await writeFile(toolPath, toolSource(`storm-${String(round)}-a`));
          await writeFile(toolPath, toolSource(`storm-${String(round)}-b`));
          const revisionBeforeBreak = await readDevelopmentRevision(server.url);
          await writeFile(toolPath, "export default { this is not valid typescript\n");
          // The watcher survives a failed candidate, so the forced rebuild
          // resolves — the deterministic proof the broken build was
          // attempted and rejected is the unchanged revision.
          await forceDevelopmentRebuild(server.url);
          await expect(readDevelopmentRevision(server.url)).resolves.toBe(revisionBeforeBreak);
          await rm(toolPath);
          await writeFile(toolPath, toolSource(`storm-${String(round)}-fixed`));
          await Promise.all([
            forceDevelopmentRebuild(server.url),
            forceDevelopmentRebuild(server.url),
          ]);
        }

        await writeFile(join(app.appRoot, ".env.local"), "EVE_CHAOS_STRUCTURAL=1\n");
        await writeFile(toolPath, toolSource("storm-final"));
        await forceDevelopmentRebuild(server.url);
        await waitForToolMarker(server.url, "storm-final");
        await completeStreamedTurn(server, "What's the weather in Lisbon?");

        const probes = await probe.stop();
        expect(probe.failures, probe.failures.join("\n")).toEqual([]);
        // The floor proves the probe ran continuously through the storm;
        // the storm itself is deterministic-length now, not wall-clock.
        expect(probes).toBeGreaterThan(30);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await probe.stop();
        await server.stop();
      }
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );

  it(
    "recovers through worker crashes, aborted streams, and concurrent rebuilds",
    async () => {
      const app = await scenarioApp(CHAOS_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const firstWorkerId = await fetchText(server.url, "/chaos/worker-id");

        const abort = new AbortController();
        const streamResponse = await fetch(new URL("/chaos/slow-stream", server.url), {
          signal: abort.signal,
        });
        const reader = streamResponse.body?.getReader();
        await reader?.read();
        abort.abort();

        const crashResponse = await fetch(new URL("/chaos/crash", server.url));
        expect([200, 503]).toContain(crashResponse.status);
        await waitForCondition(async () => {
          try {
            return (await fetchText(server.url, "/chaos/worker-id")) !== firstWorkerId;
          } catch {
            return false;
          }
        }, "Timed out waiting for a replacement worker after the crash.");
        const burst = await Promise.all(
          Array.from({ length: 10 }, async () => {
            const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
            return response.status;
          }),
        );
        expect(burst).toEqual(Array.from({ length: 10 }, () => 200));

        await Promise.all([
          fetch(new URL("/chaos/crash", server.url)),
          forceDevelopmentRebuild(server.url),
        ]);
        await waitForCondition(async () => {
          try {
            const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
            return response.status === 200;
          } catch {
            return false;
          }
        }, "Timed out waiting for the dev server to recover from a crash during rebuild.");

        await completeStreamedTurn(server, "What's the weather in Lisbon?");
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );

  it(
    "terminates an open stream within a bounded deadline when its worker crashes",
    async () => {
      const app = await scenarioApp(CHAOS_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const streamResponse = await fetch(new URL("/chaos/slow-stream", server.url));
        const reader = streamResponse.body?.getReader();
        await reader?.read();

        await fetch(new URL("/chaos/crash", server.url));
        await withinDeadline(
          (async () => {
            for (;;) {
              const result = await reader?.read();
              if (result === undefined || result.done) {
                return;
              }
            }
          })().catch(() => undefined),
          "Timed out waiting for the crashed worker's stream to settle.",
          15_000,
        );

        await waitForCondition(async () => {
          try {
            const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
            return response.status === 200;
          } catch {
            return false;
          }
        }, "Timed out waiting for the dev server to recover after the crash.");
        await completeStreamedTurn(server, "What's the weather in Lisbon?");
      } finally {
        await server.stop();
      }
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );

  it(
    "shuts down within a bounded deadline while a stream is open",
    async () => {
      const app = await scenarioApp(CHAOS_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const streamResponse = await fetch(new URL("/chaos/slow-stream", server.url));
      const reader = streamResponse.body?.getReader();
      await reader?.read();

      const stopStart = Date.now();
      await server.stop();

      // The harness escalates to SIGKILL at 10s; a graceful exit must beat it.
      expect(Date.now() - stopStart).toBeLessThan(9_000);
      await expect(
        withinDeadline(
          (async () => {
            for (;;) {
              const result = await reader?.read();
              if (result === undefined || result.done) {
                return "done";
              }
            }
          })().catch(() => "errored"),
          "Timed out waiting for the shutdown stream to settle.",
          5_000,
        ),
      ).resolves.toBeDefined();
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );

  it(
    "reports the socket peer as the client address despite forged headers",
    async () => {
      const app = await scenarioApp(CHAOS_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        // Forged client-address metadata is stripped and re-stamped by the
        // parent from the accepted socket, so the handler observes the real
        // peer even when a client supplies every trusted header name.
        const response = await fetch(new URL("/chaos/request-ip", server.url), {
          headers: {
            "x-eve-dev-client-address": "203.0.113.7",
            "x-eve-dev-client-address-signature": "forged",
            "x-forwarded-for": "203.0.113.7",
          },
        });
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("127.0.0.1");
      } finally {
        await server.stop();
      }
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );

  it(
    "rejects untrusted internal transport requests on the public listener",
    async () => {
      const app = await scenarioApp(CHAOS_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const worldCall = await fetch(new URL("/eve/v1/dev/internal/workflow-world", server.url), {
          body: "{}",
          method: "POST",
        });
        expect(worldCall.status).toBe(401);

        const forgedDelivery = await fetch(new URL("/.well-known/workflow/v1/flow", server.url), {
          body: JSON.stringify({ runId: "wrun_forged" }),
          headers: {
            "x-eve-dev-workflow-delivery": "forged",
            "x-vqs-message-attempt": "1",
            "x-vqs-message-id": "msg_forged",
            "x-vqs-queue-name": "forged-queue",
          },
          method: "POST",
        });
        expect(forgedDelivery.status).toBe(401);
      } finally {
        await server.stop();
      }
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );
});
