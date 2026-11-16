import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  DEV_SERVER_SCENARIO_TIMEOUT_MS,
  TRANSACTIONAL_REBUILD_DESCRIPTOR,
  createInstrumentationSource,
} from "./dev-server-descriptors.js";
import {
  createGenerationMarkerToolSource,
  readCompletedMessages,
} from "./dev-server-generation-tools.js";
import {
  fetchText,
  forceDevelopmentRebuild,
  startEveDev,
  waitForPath,
  withinDeadline,
} from "#internal/testing/dev-server-harness.js";

const scenarioApp = useScenarioApp();

const WORKFLOW_GENERATION_DESCRIPTOR: ScenarioAppDescriptor = {
  ...TRANSACTIONAL_REBUILD_DESCRIPTOR,
  files: {
    ...Object.fromEntries(
      Object.entries(TRANSACTIONAL_REBUILD_DESCRIPTOR.files).filter(
        ([path]) => path !== "agent/tools/get_weather.ts" && !path.startsWith("agent/skills/"),
      ),
    ),
    "agent/tools/get_marker.ts": createGenerationMarkerToolSource("generation-one", true),
  },
};

describe("eve dev server workflow generations", () => {
  it(
    "recovers an interrupted inline turn after promotion and uses the new generation in a fresh session",
    async () => {
      const app = await scenarioApp(WORKFLOW_GENERATION_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const turnStartedPath = join(app.appRoot, ".turn-started");
      const crashWorkerPath = join(app.appRoot, ".crash-turn-worker");

      try {
        const firstTurn = sendDevelopmentMessage({
          message: "Use get_marker.",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        await waitForPath(turnStartedPath);

        await writeFile(
          join(app.appRoot, "agent", "tools", "get_marker.ts"),
          createGenerationMarkerToolSource("generation-two", false),
        );
        await writeFile(
          join(app.appRoot, "agent", "tools", "get_next_marker.ts"),
          createGenerationMarkerToolSource("generation-two", false),
        );
        await writeFile(
          join(app.appRoot, "agent", "instrumentation", "reload.ts"),
          createInstrumentationSource("two"),
        );
        await forceDevelopmentRebuild(server.url);
        await expect(fetchText(server.url, "/instrumentation-marker")).resolves.toBe("two");

        await writeFile(crashWorkerPath, "crash");
        const firstResult = await withinDeadline(
          firstTurn,
          `Timed out waiting for the interrupted turn to settle.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );
        // The crashed call never runs again; the model reads that it may have, and calls again.
        expect(
          firstResult.events.flatMap((event) =>
            event.type === "call.settled" ? [event.data.outcome] : [],
          ),
        ).toEqual(["abandoned", "completed"]);
        expect(firstResult.events.filter((event) => event.type === "turn.settled")).toMatchObject([
          { data: { outcome: "completed" } },
        ]);
        expect(firstResult.events.filter((event) => event.type === "session.ended")).toEqual([]);

        const secondResult = await sendDevelopmentMessage({
          message: "Use get_next_marker.",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        expect(secondResult.session.sessionId).not.toBe(firstResult.session.sessionId);
        expect(readCompletedMessages(secondResult.events)).toContain("generation-two");
        expect(readCompletedMessages(secondResult.events)).toContain("instrumentation-two");
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
