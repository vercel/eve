import { describe, expect, it } from "vitest";
import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

describe("nested background subagent result", () => {
  it("waits for a specialist's nested researcher before reporting completion", async () => {
    const app = await scenarioApp({
      name: "nested-background-result",
      installDependencies: true,
      files: {
        "agent/instructions.md":
          "Ask the specialist for the report. Do not report an unfinished report as final.\n",
        "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  model: mockModel(({ toolResults, messages }) => {
    const state = messages.map(m => m.text).reverse().find(m => m.startsWith("[Task state]\\n"));
    if (state?.includes("NESTED-FINAL")) return "PARENT-FINAL: NESTED-FINAL";
    if (state?.includes('"status":"completed"') && state.includes("SPECIALIST-STARTED")) return "PARENT-PREMATURE: specialist task reported complete";
    if (toolResults.length === 0) return { toolCalls: [{ id: "specialist-call", name: "specialist", input: { message: "Prepare the report with the researcher." } }] };
    return "PARENT-LAUNCHED";
  }),
  modelContextWindowTokens: 32000,
});`,
        "agent/subagents/specialist/instructions.md": "Ask the researcher for the report.\n",
        "agent/subagents/specialist/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  description: "Prepare a report with a researcher.",
  model: mockModel(({ toolResults, messages }) => {
    const state = messages.map(m => m.text).reverse().find(m => m.startsWith("[Task state]\\n"));
    if (state?.includes("NESTED-FINAL")) return "SPECIALIST-FINAL: NESTED-FINAL";
    if (toolResults.length === 0) return { toolCalls: [{ id: "research-call", name: "researcher", input: { message: "Research the report." } }] };
    return "SPECIALIST-STARTED: researcher is still working";
  }),
  modelContextWindowTokens: 32000,
});`,
        "agent/subagents/specialist/subagents/researcher/instructions.md": "Research the report.\n",
        "agent/subagents/specialist/subagents/researcher/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  description: "Research a report.",
  model: mockModel(async () => {
    await new Promise(resolve => setTimeout(resolve, 20000));
    return "NESTED-FINAL";
  }),
  modelContextWindowTokens: 32000,
});`,
      },
    });
    const server = await startEveDev(app.appRoot, {
      env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
    });
    try {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({
        message: "Prepare the report.",
      });
      const launch = await response.result();
      expect(launch.message).toBe("PARENT-LAUNCHED");
      const called = await firstSubagentCall(
        session.stream({ follow: true, signal: AbortSignal.timeout(30_000) }),
      );
      const child = client.sessions.attach(called.data.childSessionId);
      const childEvents = await throughWaiting(
        child.stream({ follow: true, signal: AbortSignal.timeout(30_000) }),
      );
      expect(childEvents).toContainEqual(
        expect.objectContaining({
          type: "action.result",
          data: expect.objectContaining({
            result: expect.objectContaining({
              toolName: "researcher",
              output: expect.objectContaining({ status: "working" }),
            }),
          }),
        }),
      );
      expect(childEvents).toContainEqual(
        expect.objectContaining({
          type: "message.appended",
          data: expect.objectContaining({
            messageDelta: "SPECIALIST-STARTED: researcher is still working",
          }),
        }),
      );

      const parentEvents = await throughWaiting(
        session.stream({ follow: true, signal: AbortSignal.timeout(30_000) }),
      );
      expect(parentEvents).toContainEqual(
        expect.objectContaining({
          type: "message.appended",
          data: expect.objectContaining({ messageDelta: "PARENT-FINAL: NESTED-FINAL" }),
        }),
      );
      expect(
        parentEvents.some(
          (event) =>
            event.type === "message.appended" &&
            event.data.messageDelta.includes("PARENT-PREMATURE"),
        ),
      ).toBe(false);
      expect(parentEvents).toContainEqual(
        expect.objectContaining({
          type: "subagent.completed",
          data: expect.objectContaining({ output: "SPECIALIST-FINAL: NESTED-FINAL" }),
        }),
      );
    } catch (error) {
      throw new Error(`${String(error)}\n${server.stdout()}\n${server.stderr()}`, { cause: error });
    } finally {
      await server.stop();
    }
  }, 360_000);
});

async function firstSubagentCall(
  events: AsyncIterable<MessageStreamEvent>,
): Promise<Extract<MessageStreamEvent, { type: "subagent.called" }>> {
  for await (const event of events) {
    if (event.type === "subagent.called") return event;
  }
  throw new Error("Missing subagent.called event");
}

async function throughWaiting<T extends { type: string }>(events: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === "session.waiting") return seen;
  }
  throw new Error("Missing session.waiting event");
}
