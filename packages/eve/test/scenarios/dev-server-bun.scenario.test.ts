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

  // Bun cannot run the dev server today: Nitro wires crossws's Node adapter
  // into every dev worker, and that adapter refuses to initialize when the
  // Bun global exists. Until that support lands upstream, the contract is a
  // fast, explanatory startup failure instead of a hang or a half-broken
  // server. Replace this with a boot-and-stream assertion when `bun eve dev`
  // becomes supported.
  it.skipIf(!bunAvailable)(
    "fails fast with the worker readiness error when the CLI runs under bun",
    async () => {
      const app = await scenarioApp(BUN_LAYOUT_DESCRIPTOR);

      const result = await runEveDevToExit(app.appRoot, { runtime: "bun" });

      expect(result.code).not.toBe(0);
      expect(result.output).toContain("failed before readiness");
    },
    BUN_DEV_SERVER_TIMEOUT_MS,
  );
});
