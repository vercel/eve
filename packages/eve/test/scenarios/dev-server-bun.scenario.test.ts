import { describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import {
  hasKnownDevServerFailure,
  isBunAvailable,
  runEveDevToExit,
  startEveDev,
} from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

const BUN_DEV_SERVER_TIMEOUT_MS = 360_000;
const BUN_LAYOUT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  name: "weather-agent-bun",
  packageManager: "bun",
};

const bunAvailable = isBunAvailable();

describe("eve dev server with bun", () => {
  it("keeps bun available in CI so the suite cannot silently skip", () => {
    if (process.env.CI !== undefined) {
      expect(bunAvailable).toBe(true);
    }
  });

  it.skipIf(!bunAvailable)(
    "serves a bun-installed app under the Node runtime",
    async () => {
      const app = await scenarioApp(BUN_LAYOUT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const messageResult = await sendDevelopmentMessage({
          message: "What's the weather in Lisbon?",
          session: createDevelopmentSessionState(),
          serverUrl: server.url,
        });
        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected the bun-installed dev server to complete a streamed turn.",
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        expect(hasKnownDevServerFailure(`${server.stdout()}\n${server.stderr()}`)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    BUN_DEV_SERVER_TIMEOUT_MS,
  );

  // Bun is supported as the fixture's package manager above, but the eve CLI
  // itself requires Node. Reject it at the bootstrap boundary before loading
  // Node-only compiler or development-worker modules.
  it.skipIf(!bunAvailable)(
    "fails fast with the Node runtime requirement when the CLI runs under bun",
    async () => {
      const app = await scenarioApp(BUN_LAYOUT_DESCRIPTOR);

      const result = await runEveDevToExit(app.appRoot, { runtime: "bun" });

      expect(result.code).not.toBe(0);
      expect(result.output).toContain("eve requires Node.js >=24. You are running Bun");
    },
    BUN_DEV_SERVER_TIMEOUT_MS,
  );
});
