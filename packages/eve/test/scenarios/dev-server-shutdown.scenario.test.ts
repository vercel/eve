import { describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { signalEveDevDuringStartup, startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

describe("eve dev shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`returns within one second after ${signal}`, async () => {
      const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      const exit = await server.signalAndAwaitExit(signal);

      expect(exit.forcedKill).toBe(false);
      expect(exit.durationMs).toBeLessThan(1_000);
      expect(exit.code).toBe(0);
      expect(exit.signal).toBe(null);
      await expect(fetch(server.url)).rejects.toThrow();
    }, 120_000);
  }

  it("returns within one second when signalled during startup", async () => {
    const app = await scenarioApp(WEATHER_AGENT_DESCRIPTOR);
    const exit = await signalEveDevDuringStartup(app.appRoot, "SIGTERM");

    expect(exit.forcedKill).toBe(false);
    expect(exit.durationMs).toBeLessThan(1_000);
  }, 120_000);
});
