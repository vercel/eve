import { describe, expect, it } from "vitest";
import { Client } from "../../src/client/client.js";
import { type MessageStreamEvent, isCurrentTurnBoundaryEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

describe("durable generation steering", () => {
  it("does not repeat a model step when subagent children wake the owner mid-lease", async () => {
    const app = await scenarioApp({
      name: "steering-child-wakes",
      installDependencies: true,
      files: {
        "agent/instructions.md": "Delegate the five work items.\n",
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(async ({ toolResults }) => {
    if (toolResults.length === 0) return { toolCalls: Array.from({ length: 5 }, (_, i) => ({
      id: "work-" + i, name: "worker", input: { message: "Work item " + i },
    })) };
    await new Promise(resolve => setTimeout(resolve, 3000));
    return "Work delegated";
  }),
  modelContextWindowTokens: 32000,
});`,
        "agent/subagents/worker/instructions.md": "Complete the work item.\n",
        "agent/subagents/worker/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  description: "Complete a work item.",
  model: mockModel(async () => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    return "Work complete";
  }),
  modelContextWindowTokens: 32000,
});`,
      },
    });
    const server = await startEveDev(app.appRoot, {
      env: {
        EVE_MOCK_AUTHORED_MODELS: "",
        NODE_ENV: "production",
        // A one-second lease expires mid-step, so the ownership backstop
        // races the child wakes into the single-flight guard.
        WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "1",
      },
    });
    try {
      const client = new Client({ host: server.url });
      const { response } = await client.sessions.create({ message: "Start five work items." });
      const result = await response.result();
      const events = result.events;
      const steps = events
        .filter((event) => event.type === "step.started")
        .map((event) => `${event.data.turnId}:${event.data.stepIndex}`);
      expect(steps).toHaveLength(2);
      expect(new Set(steps).size).toBe(steps.length);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(server.stderr()).toContain("Step execution already in flight in this process");
    } finally {
      await server.stop();
    }
  }, 360_000);
  it("interrupts a pending request through the public session API and keeps one turn", async () => {
    const app = await scenarioApp({
      name: "generation-steering",
      installDependencies: true,
      files: {
        "agent/instructions.md": "Answer the latest request.\n",
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(async ({ lastUserMessage }) => {
    if (lastUserMessage?.includes("Actually 2025")) return "Corrected 2025 answer";
    await new Promise(resolve => setTimeout(resolve, 10000));
    return "Stale 2026 answer";
  }),
  modelContextWindowTokens: 32000,
  experimental: { workflow: { modelCallsPerStep: 3 } },
});`,
      },
    });
    const server = await startEveDev(app.appRoot, {
      env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
    });
    try {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({ message: "Who won in 2026?" });
      const events: MessageStreamEvent[] = [];
      const started = Promise.withResolvers<void>();
      const collecting = (async () => {
        for await (const event of response) {
          events.push(event);
          if (event.type === "step.started") started.resolve();
          if (isCurrentTurnBoundaryEvent(event)) break;
        }
      })();
      await started.promise;
      const corrected = await session.send("Actually 2025", { turnPolicy: "steer" });
      const result = await corrected.result();
      await collecting;
      expect(result.status).toBe("waiting");
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "message.received")).toHaveLength(2);
      expect(
        events.some((event) => event.type === "turn.cancelled" || event.type === "turn.failed"),
      ).toBe(false);
      expect(
        events
          .filter((event) => event.type === "message.appended")
          .map((event) => event.data.messageDelta)
          .join(""),
      ).toBe("Corrected 2025 answer");
    } finally {
      await server.stop();
    }
  }, 360_000);
});
