import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const RESULT_TIMEOUT_MS = 60_000;

const REMIND_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Remind the user after a short delay.",
  inputSchema: z.object({ note: z.string() }),
  detach: true,
  async execute({ note }) {
    "use workflow";
    await sleep("3s");
    return { reminder: note };
  },
  toModelOutput(output) {
    return { type: "text", value: "Reminder: " + output.reminder };
  },
});
`;

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

/** Collects every event the stream yields within `ms`. */
async function collectFor(
  stream: AsyncIterable<MessageStreamEvent>,
  ms: number,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        iterator.next(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
      ]);
      if (next === "timeout" || next.done) break;
      events.push(next.value);
    }
  } finally {
    void iterator.return?.();
  }
  return events;
}

describe("background tasks through detach: true", () => {
  it(
    "returns a receipt at once, then delivers the result in its own result turn",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Relayed: " + lastUserMessage;
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "remind", input: { note: "stand-up at 10" } }] };
    }
    return "Started your reminder.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Set reminders when asked.\n",
          "agent/tools/remind.ts": REMIND_TOOL,
        },
        installDependencies: true,
        name: "background-remind",
      });
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({
          message: "Please remind me about stand-up.",
        });
        const first = await response.result();

        const receipt = first.events.find((event) => event.type === "action.result");
        expect(receipt?.data.result).toMatchObject({
          output: { status: "working", taskId: expect.stringMatching(/^remind-/u) },
        });
        expect(receipt?.data.result).not.toHaveProperty("modelOutput");
        const started = first.events.find((event) => event.type === "task.started");
        expect(started?.data).toMatchObject({ kind: "workflow", mode: "background" });
        expect(
          first.events.some(
            (event) =>
              event.type === "message.completed" && event.data.message === "Started your reminder.",
          ),
        ).toBe(true);
        expect(first.status).toBe("waiting");

        const later = await collectUntil(session.stream(), (events) =>
          events.some((event) => event.type === "turn.completed"),
        );

        const received = later.filter((event) => event.type === "message.received");
        expect(received).toHaveLength(1);
        expect(received[0]?.data).toMatchObject({
          kind: "task.result",
          taskIds: [started?.data.taskId],
        });
        expect(later).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ status: "completed", taskId: started?.data.taskId }),
            type: "task.settled",
          }),
        );
        const reply = later.find((event) => event.type === "message.completed");
        expect(reply?.data.message).toContain("Reminder: stand-up at 10");
        expect(reply?.data.message).toContain('status="completed"');
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "holds a delegated call until the child's background task reports",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ toolResults }) => {
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "worker", input: { message: "Set a stand-up reminder." } }] };
    }
    return "Parent got: " + JSON.stringify(toolResults[0].output);
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Delegate reminders to the worker.\n",
          "agent/subagents/worker/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Sets reminders.",
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Final: the reminder fired.";
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "remind", input: { note: "stand-up at 10" } }] };
    }
    return "Interim: reminder started.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/subagents/worker/instructions.md": "Set the reminder, then report.\n",
          "agent/subagents/worker/tools/remind.ts": REMIND_TOOL,
        },
        installDependencies: true,
        name: "background-quiescent-child",
      });
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const client = new Client({ host: server.url });
        const { response } = await client.sessions.create({ message: "Remind me about stand-up." });
        const result = await response.result();

        const settled = result.events.find((event) => event.type === "task.settled");
        expect(settled?.data).toMatchObject({
          output: "Final: the reminder fired.",
          status: "completed",
        });
        const reply = result.events.findLast((event) => event.type === "message.completed");
        expect(reply?.data.message).toContain("Final: the reminder fired.");
        expect(reply?.data.message).not.toContain("Interim");
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "stops background tasks through task_cancel and session.cancel({ taskId }) without a later result",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Relayed: " + lastUserMessage;
    const receipts = toolResults.filter((result) => result.name === "remind");
    if (lastUserMessage?.includes("cancel")) {
      const cancelled = toolResults.find((result) => result.name === "task_cancel");
      if (cancelled !== undefined) return "Cancel result: " + JSON.stringify(cancelled.output);
      const taskId = /remind-[0-9a-z]{6}/u.exec(String(receipts[0]?.output))?.[0];
      return { toolCalls: [{ name: "task_cancel", input: { taskIds: [taskId] } }] };
    }
    if (receipts.length === 0) {
      return {
        toolCalls: [
          { name: "remind", input: { note: "stand-up at 10" } },
          { name: "remind", input: { note: "lunch at 12" } },
        ],
      };
    }
    return "Started both reminders.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Set reminders when asked.\n",
          "agent/tools/remind.ts": REMIND_TOOL.replace('sleep("3s")', 'sleep("15s")'),
        },
        installDependencies: true,
        name: "background-cancel",
      });
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({
          message: "Please set my stand-up and lunch reminders.",
        });
        const first = await response.result();
        const started = first.events.flatMap((event) =>
          event.type === "task.started" ? [event.data.taskId] : [],
        );
        expect(started).toHaveLength(2);

        const second = await (
          await session.send("Never mind the stand-up reminder, please cancel it.")
        ).result();
        const stopped = second.events.flatMap((event) =>
          event.type === "task.settled" && event.data.status === "cancelled"
            ? [event.data.taskId]
            : [],
        );
        expect(stopped).toHaveLength(1);
        const stoppedId = stopped[0]!;
        expect(started).toContain(stoppedId);
        const remainingId = started.find((taskId) => taskId !== stoppedId)!;
        const cancelOutputs = second.events.flatMap((event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "task_cancel"
            ? [event.data.result.output]
            : [],
        );
        expect(cancelOutputs).toEqual([
          { alreadyFinished: [], cancelled: [stoppedId], unknown: [] },
        ]);
        const reply = second.events.findLast((event) => event.type === "message.completed");
        expect(reply?.type === "message.completed" ? reply.data.message : "").toContain(
          "Cancel result:",
        );

        await expect(session.cancel({ taskId: remainingId })).resolves.toEqual({
          sessionId: session.state.sessionId,
          status: "accepted",
        });

        // Both runs finish their sleep inside the cleanup window; neither result may reach the model.
        const later = await collectFor(session.stream(), 25_000);
        expect(later).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ status: "cancelled", taskId: remainingId }),
            type: "task.settled",
          }),
        );
        expect(later.filter((event) => event.type === "task.settled")).toHaveLength(1);
        expect(later.some((event) => event.type === "message.received")).toBe(false);
        expect(later.some((event) => event.type === "turn.started")).toBe(false);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
