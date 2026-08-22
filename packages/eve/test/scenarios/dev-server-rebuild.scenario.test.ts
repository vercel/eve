import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import {
  readDevelopmentRuntimeArtifactsSnapshotRoot,
  resolveDevelopmentRuntimeArtifactsPointerPath,
} from "../../src/internal/nitro/dev-runtime-artifacts.js";
import { STRUCTURAL_RELOAD_LOG_LINE } from "../../src/internal/nitro/host/dev-watcher-log.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  DEV_SERVER_AGENT_DESCRIPTOR,
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
  createInstrumentationSource,
  createOverlappingChannelSource,
  createTransactionalChannelSource,
} from "./dev-server-descriptors.js";
import {
  fetchAgentInfo,
  fetchText,
  forceDevelopmentRebuild,
  hasKnownDevServerFailure,
  readDevelopmentRevision,
  startEveDev,
  waitForCondition,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

function createCandidateChannelSource(): string {
  return createTransactionalChannelSource([
    '    GET("/candidate-only", () => new Response("candidate")),',
  ]);
}

describe("eve dev server rebuild transactions", () => {
  it(
    "publishes authored tool removals without replacing the active host",
    async () => {
      const app = await scenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const initialRevision = await readDevelopmentRevision(server.url);
        const initialWorkerId = await fetchText(server.url, "/worker-id");
        expect(
          (await fetchAgentInfo(server.url)).tools.authored.map((tool) => tool.name),
        ).toContain("get_weather");

        await rm(join(app.appRoot, "agent", "tools", "get_weather.ts"));
        await forceDevelopmentRebuild(server.url);

        await expect(readDevelopmentRevision(server.url)).resolves.not.toBe(initialRevision);
        await expect(fetchText(server.url, "/worker-id")).resolves.toBe(initialWorkerId);
        expect(
          (await fetchAgentInfo(server.url)).tools.authored.map((tool) => tool.name),
        ).not.toContain("get_weather");
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "replaces the worker for instrumentation changes and preserves Nitro's selected route",
    async () => {
      const app = await scenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");
        await expect(fetchText(server.url, "/overlap/static")).resolves.toBe("static");
        const initialWorkerId = await fetchText(server.url, "/worker-id");

        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/worker-id")).resolves.toBe(initialWorkerId);

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("two"),
        );
        await forceDevelopmentRebuild(server.url);

        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");
        await expect(fetchText(server.url, "/worker-id")).resolves.not.toBe(initialWorkerId);
        await expect(fetchText(server.url, "/overlap/static")).resolves.toBe("static");
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps the complete prior generation active when a structural candidate fails",
    async () => {
      const app = await scenarioApp(TRANSACTIONAL_REBUILD_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const initialRevision = await readDevelopmentRevision(server.url);
        await writeFile(
          join(app.appRoot, "agent", "channels", "dev-generation.ts"),
          ['import "./missing-candidate-module.ts";', createCandidateChannelSource()].join("\n"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          'throw new Error("stage 4 rejected candidate");\nexport default {};\n',
        );
        await writeFile(
          join(app.appRoot, "agent", "channels", "dev-generation.ts"),
          createCandidateChannelSource(),
        );
        try {
          await forceDevelopmentRebuild(server.url);
        } catch (error) {
          throw new Error(
            `Rejected candidate rebuild request failed.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
            { cause: error },
          );
        }

        await expect(readDevelopmentRevision(server.url)).resolves.toBe(initialRevision);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");
        const candidateRoute = await fetch(new URL("/candidate-only", server.url));
        expect(candidateRoute.status).toBe(404);

        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("two"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(readDevelopmentRevision(server.url)).resolves.not.toBe(initialRevision);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");
        await expect(fetchText(server.url, "/candidate-only")).resolves.toBe("candidate");

        await writeFile(
          join(app.appRoot, "agent", "channels", "dev-generation.ts"),
          createOverlappingChannelSource(),
        );
        await writeFile(
          join(app.appRoot, "agent", "instrumentation.ts"),
          createInstrumentationSource("one"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("one");
        await expect(fetchText(server.url, "/overlap/static")).resolves.toBe("static");
        const revertedCandidateRoute = await fetch(new URL("/candidate-only", server.url));
        expect(revertedCandidateRoute.status).toBe(404);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "rebuilds after its startup runtime generation is force-pruned and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(app.appRoot);
        const startupRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (startupRuntimeRoot === undefined) {
          throw new Error("Expected eve dev to publish an initial runtime snapshot.");
        }

        await writeFile(
          join(app.appRoot, "agent", "instructions.md"),
          "Use the weather tool and answer with the current conditions.\n",
        );
        await waitForCondition(() => {
          const currentRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
          return currentRuntimeRoot !== undefined && currentRuntimeRoot !== startupRuntimeRoot;
        }, `Timed out waiting for authored HMR.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);

        const authoredRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (authoredRuntimeRoot === undefined) {
          throw new Error("Expected authored HMR to publish a runtime snapshot.");
        }

        await rm(startupRuntimeRoot, { force: true, recursive: true });
        expect(existsSync(startupRuntimeRoot)).toBe(false);

        await writeFile(join(app.appRoot, ".env.local"), "EVE_SCENARIO_RELOAD=1\n");
        await waitForCondition(
          () => server.stdout().includes(STRUCTURAL_RELOAD_LOG_LINE),
          `Timed out waiting for a structural Nitro reload.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );
        expect(readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath)).toBe(authoredRuntimeRoot);
        await waitForCondition(async () => {
          const generation = await fetch(new URL("/dev-generation", server.url));
          return (await generation.text()) === "1";
        }, `Timed out waiting for a ready replacement worker.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);
        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevServerFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
