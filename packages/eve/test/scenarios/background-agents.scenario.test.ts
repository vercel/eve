import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const RESULT_TIMEOUT_MS = 90_000;

/** Collects events from the session stream until `done` holds or the timeout passes. */
async function collectUntil(
  stream: AsyncIterable<MessageStreamEvent>,
  done: (events: readonly MessageStreamEvent[]) => boolean,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  try {
    while (!done(events)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out; saw ${events.map((e) => e.type).join(", ")}`);
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for the result turn.")), remaining),
        ),
      ]);
      if (next.done) break;
      events.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return events;
}

describe("detached agent calls", () => {
  it(
    "returns a receipt, steers the working agent with agentId, and reports one result later",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Relayed: " + lastUserMessage;
    const texts = toolResults.map((result) => String(result.output));
    if (lastUserMessage?.includes("pricing")) {
      if (texts.some((text) => text.startsWith("Sent your message"))) return "Sent the pricing note.";
      const agentId = /writer-[0-9a-z]{6}/u.exec(texts.join(" "))?.[0];
      return { toolCalls: [{ name: "writer", input: { agentId, message: "Also mention the pricing." } }] };
    }
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "writer", input: { message: "Draft the launch post." } }] };
    }
    return "Started the draft.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Delegate writing to the writer.\n",
          "agent/subagents/writer/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Drafts launch posts.",
  model: mockModel(({ toolResults, userMessages }) => {
    if (toolResults.length === 0) return { toolCalls: [{ name: "gather", input: {} }] };
    return userMessages.some((message) => message.includes("pricing"))
      ? "Draft with pricing."
      : "Draft without pricing.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/subagents/writer/instructions.md": "Gather notes, then draft.\n",
          "agent/subagents/writer/tools/gather.ts": `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Gather the launch notes.",
  inputSchema: z.object({}),
  async execute() {
    "use workflow";
    await sleep("8s");
    return { notes: "Orbit ships today." };
  },
});
`,
        },
        installDependencies: true,
        name: "background-agent-steer",
      });
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({
          message: "Draft the launch post, no rush.",
        });
        const first = await response.result();

        // The turn does not wait, so the child's task.started may land after it ends.
        const receipt = first.events.find((event) => event.type === "action.result");
        expect(receipt?.data.result).toMatchObject({
          output: { status: "working", taskId: expect.stringMatching(/^writer-/u) },
        });
        const taskId =
          receipt?.type === "action.result"
            ? (receipt.data.result.output as { readonly taskId: string }).taskId
            : undefined;
        expect(first.events).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ message: "Started the draft." }),
            type: "message.completed",
          }),
        );
        expect(first.events.some((event) => event.type === "task.settled")).toBe(false);

        const second = await (await session.send("Also mention the pricing.")).result();
        const steering = second.events.flatMap((event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "writer"
            ? [event.data.result]
            : [],
        );
        expect(steering).toEqual([
          expect.objectContaining({ output: { status: "working", taskId } }),
        ]);
        expect(second.events).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ message: "Sent the pricing note." }),
            type: "message.completed",
          }),
        );

        const later = await collectUntil(session.stream(), (events) =>
          events.some(
            (event) =>
              event.type === "message.completed" &&
              typeof event.data.message === "string" &&
              event.data.message.startsWith("Relayed:"),
          ),
        );
        const settled = later.filter((event) => event.type === "task.settled");
        expect(settled).toHaveLength(1);
        expect(settled[0]?.data).toMatchObject({
          output: "Draft with pricing.",
          status: "completed",
          taskId,
        });
        const received = later.filter((event) => event.type === "message.received");
        expect(received).toHaveLength(1);
        expect(received[0]?.data).toMatchObject({ kind: "task.result", taskIds: [taskId] });
        // One generation: the steering message started nothing new.
        const starts = [...first.events, ...second.events, ...later].flatMap((event) =>
          event.type === "task.started" ? [event.data] : [],
        );
        expect(starts).toHaveLength(1);
        expect(starts[0]).toMatchObject({
          kind: "agent",
          mode: "detached",
          name: "writer",
          taskId,
        });
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
