import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { ClientSession, MessageResponse } from "../../src/client/index.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const RESULT_TIMEOUT_MS = 90_000;
const ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };

// The interrupt rule end to end: a steering message ends an attached call
// through the cancel path, and leaves a detached task, and the question it
// waits on, untouched.

/** Collects events from the stream until `done` holds or the timeout passes. */
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
          setTimeout(() => reject(new Error("Timed out waiting for stream events.")), remaining),
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

/** Collects the session stream through the next result turn that delivers task results. */
async function nextResultTurn(session: ClientSession): Promise<MessageStreamEvent[]> {
  return await collectUntil(session.stream(), (events) => {
    const delivered = events.findIndex(
      (event) => event.type === "message.received" && event.data.kind === "task.result",
    );
    return delivered >= 0 && events.slice(delivered).some((e) => e.type === "turn.completed");
  });
}

function count(events: readonly MessageStreamEvent[], type: MessageStreamEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function lastReply(events: readonly MessageStreamEvent[]): string {
  const reply = events.findLast((event) => event.type === "message.completed");
  return reply?.type === "message.completed" ? (reply.data.message ?? "") : "";
}

function outputsByCall(events: readonly MessageStreamEvent[]): Map<string, unknown> {
  return new Map(
    events.flatMap((event) =>
      event.type === "action.result" ? [[event.data.result.callId, event.data.result.output]] : [],
    ),
  );
}

describe("the interrupt rule", () => {
  it(
    "ends an attached sleep on a steering message with the interruption text",
    async () => {
      const app = await scenarioApp({
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (toolResults.length === 0) return { toolCalls: [{ name: "sleep", input: { seconds: 60 } }] };
    return "After sleep: " + JSON.stringify(toolResults.map((r) => r.output)) + " / " + lastUserMessage;
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Wait when asked.\n",
          "agent/tools/sleep.ts": `import { sleep } from "eve/tools/sleep";

export default sleep();
`,
        },
        installDependencies: true,
        name: "interrupt-sleep",
      });
      const server = await startEveDev(app.appRoot, { env: ENV });
      try {
        const client = new Client({ host: server.url });
        const nap = await client.sessions.create({ message: "Wait a minute." });
        const turn = followTurn(nap.response, (events) => count(events, "task.started") === 1);
        await turn.reached;
        await (await nap.session.send("Never mind, let's move on.")).result();
        const events = await turn.finished;

        const sleepTask = events.find((event) => event.type === "task.started");
        expect(sleepTask?.type === "task.started" ? sleepTask.data.mode : undefined).toBe(
          "attached",
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "cancelled",
              taskId: sleepTask?.type === "task.started" ? sleepTask.data.taskId : undefined,
            }),
            type: "task.settled",
          }),
        );
        const stopped = [...outputsByCall(events).values()][0] as {
          status: string;
          waitedMs: number;
        };
        expect(stopped.status).toBe("interrupted");
        expect(stopped.waitedMs).toBeLessThan(60_000);
        const reply = lastReply(events);
        expect(reply).toMatch(/Stopped after .+ because a new message arrived\./u);
        expect(reply).toContain("Never mind, let's move on.");
        expect(count(events, "turn.started")).toBe(1);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "keeps a detached task and its approval through an unrelated message, then reports the answer",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Refund update: " + lastUserMessage;
    if (lastUserMessage === "What are your support hours?") return "Hours: 9 to 5.";
    if (toolResults.length === 0) return { toolCalls: [{ name: "refund", input: { orderId: "42" } }] };
    return "Refund started: " + JSON.stringify(toolResults.map((r) => r.output));
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Refund orders after approval.\n",
          "agent/tools/refund.ts": `import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Refund an order once a person approves it.",
  inputSchema: z.object({ orderId: z.string() }),
  async execute({ orderId }, ctx) {
    "use workflow";
    const answer = await ctx.ask({
      prompt: "Refund order " + orderId + "?",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
    });
    return { orderId, decision: answer.status === "answered" ? answer.optionId : answer.status };
  },
});
`,
        },
        installDependencies: true,
        name: "interrupt-detached-approval",
      });
      const server = await startEveDev(app.appRoot, { env: ENV });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({
          message: "Please refund order 42.",
        });
        const first = await response.result();
        const started = first.events.find((event) => event.type === "task.started");
        const taskId = started?.type === "task.started" ? started.data.taskId : undefined;
        expect(started?.type === "task.started" ? started.data.mode : undefined).toBe("detached");
        expect(lastReply(first.events)).toContain(`Started task ${taskId}.`);

        // The detached run asks on its own; the question outlives the turn that started it.
        const asked = await collectUntil(session.stream({ startIndex: 0 }), (events) =>
          events.some((event) => event.type === "input.requested"),
        );
        const request = asked.find((event) => event.type === "input.requested");
        const requestId =
          request?.type === "input.requested" ? request.data.requests[0]?.requestId : undefined;
        expect(requestId).toBeTruthy();

        const unrelated = await (await session.send("What are your support hours?")).result();
        expect(lastReply(unrelated.events)).toBe("Hours: 9 to 5.");
        expect(
          unrelated.events.some(
            (event) => event.type === "task.settled" && event.data.taskId === taskId,
          ),
        ).toBe(false);

        await session.respond([{ optionId: "approve", requestId: requestId! }]);
        const later = await nextResultTurn(session);
        const received = later.find(
          (event) => event.type === "message.received" && event.data.kind === "task.result",
        );
        expect(received?.type === "message.received" ? received.data.taskIds : []).toEqual([
          taskId,
        ]);
        expect(lastReply(later)).toContain('"decision": "approve"');
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
