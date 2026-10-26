import { afterEach, expect, it, vi } from "vitest";

import { Client } from "../../src/client/client.js";
import { buildApplication } from "../../src/internal/nitro/host.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startPackagedEveStart } from "./eve-start-harness.js";

const scenarioApp = useScenarioApp();

afterEach(() => vi.unstubAllEnvs());

it("accepts only own-queue workflow deliveries in the built production server", async () => {
  vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "");
  vi.stubEnv("NODE_ENV", "production");
  const { appRoot } = await scenarioApp({
    name: "local-workflow-delivery-auth",
    installDependencies: true,
    files: {
      "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(() => "Noted, Alice."),
  modelContextWindowTokens: 32_000,
});`,
      "agent/instructions.md": "Acknowledge Alice's messages briefly.\n",
      "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
export default eveChannel({ auth: httpBasic({ username: "alice", password: "fixture" }) });`,
    },
  });
  await buildApplication(appRoot, { skipSandboxPrewarm: true });
  const server = await startPackagedEveStart(appRoot);
  try {
    for (const proof of [undefined, "incorrect-delivery-proof"]) {
      const response = await fetch(new URL("/.well-known/workflow/v1/flow", server.url), {
        method: "POST",
        body: "{}",
        headers: proof === undefined ? {} : { "x-eve-workflow-delivery": proof },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status, server.stderr()).toBe(401);
      expect(await response.json()).toEqual({ error: "Untrusted workflow delivery." });
    }

    const client = new Client({
      host: server.url,
      auth: { basic: { username: "alice", password: "fixture" } },
    });
    const { session } = await client.sessions.create();
    const result = await (
      await session.send("Alice asks you to acknowledge receipt.", {
        signal: AbortSignal.timeout(30_000),
      })
    ).result();
    expect(result.message, server.stderr()).toBe("Noted, Alice.");
  } finally {
    await server.stop();
  }
}, 120_000);
