import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageResponse } from "../../src/client/index.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;

const REMIND_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Remind the user after a delay.",
  inputSchema: z.object({ note: z.string() }),
  async execute({ note }) {
    "use workflow";
    await sleep("20s");
    return { reminder: note };
  },
});
`;

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

/**
 * Follows a turn's response to its boundary, and resolves `reached` once
 * `ready` holds, so the test can send a message while the turn still waits.
 */
function followTurn(
  response: MessageResponse,
  ready: (events: readonly MessageStreamEvent[]) => boolean,
) {
  const events: MessageStreamEvent[] = [];
  const reached = Promise.withResolvers<void>();
  const finished = (async () => {
    for await (const event of response) {
      events.push(event);
      if (ready(events)) reached.resolve();
      if (isCurrentTurnBoundaryEvent(event)) break;
    }
    reached.reject(new Error(`The turn ended first; saw ${events.map((e) => e.type).join(", ")}`));
    return events;
  })();
  return { finished, reached: reached.promise };
}

describe("background tasks", () => {
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
      return { toolCalls: [{ name: "task_cancel", input: { taskId } }] };
    }
    if (receipts.length === 0) {
      return {
        toolCalls: [
          { name: "remind", input: { note: "stand-up at 10" } },
          { name: "remind", input: { note: "lunch at 12" } },
        ],
      };
    }
    return "Both reminders keep running.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Set reminders when asked.\n",
          "agent/tools/remind.ts": REMIND_TOOL,
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
        // A steering message moves both waited calls to the background.
        const turn = followTurn(
          response,
          (events) => events.filter((event) => event.type === "task.started").length === 2,
        );
        await turn.reached;
        await (await session.send("Thanks, keep them going.")).result();
        const first = await turn.finished;
        const started = first.flatMap((event) =>
          event.type === "task.started" ? [event.data.taskId] : [],
        );
        expect(started).toHaveLength(2);
        expect(first.filter((event) => event.type === "task.detached")).toHaveLength(2);

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
        expect(cancelOutputs).toEqual([{ status: "cancelled" }]);
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
