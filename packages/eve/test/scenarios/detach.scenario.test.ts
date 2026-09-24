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

describe("detaching waited calls", () => {
  it(
    "detaches both calls on a steering message, lists them, and delivers them in one result turn",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, messages, toolResults }) => {
    const note = messages.findLast((m) => m.role === "user" && m.text.startsWith("[Tasks]"))?.text ?? "";
    if (lastUserMessage?.startsWith("<task_result")) return "Combined: " + lastUserMessage;
    if (lastUserMessage === "Also check Plain, please.") {
      return "Detached: " + JSON.stringify(toolResults.map((r) => r.output)) + " Note: " + note;
    }
    if (lastUserMessage === "Where are d0 and sre?") return "Status: " + note;
    if (toolResults.length === 0) {
      return {
        toolCalls: [
          { name: "lookup", input: { source: "d0", seconds: 8 } },
          { name: "lookup", input: { source: "sre", seconds: 16 } },
        ],
      };
    }
    return "Unexpected: " + lastUserMessage;
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Look things up when asked.\n",
          "agent/tools/lookup.ts": `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Look up a source.",
  inputSchema: z.object({ source: z.string(), seconds: z.number() }),
  async execute({ source, seconds }) {
    "use workflow";
    await sleep(seconds * 1000);
    return { source, status: "healthy" };
  },
});
`,
        },
        installDependencies: true,
        name: "detach-steer-group",
      });
      const server = await startEveDev(app.appRoot, { env: ENV });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({
          message: "Check d0 and sre.",
        });
        const turn = followTurn(response, (events) => count(events, "task.started") === 2);
        await turn.reached;
        await (await session.send("Also check Plain, please.")).result();
        const events = await turn.finished;

        const started = events.flatMap((event) =>
          event.type === "task.started" ? [event.data] : [],
        );
        expect(started.map((data) => data.mode)).toEqual(["foreground", "foreground"]);
        const detached = events.flatMap((event) =>
          event.type === "task.detached" ? [event.data] : [],
        );
        expect(detached.map(({ reason }) => reason)).toEqual(["steer", "steer"]);
        expect(detached.map(({ taskId }) => taskId).toSorted()).toEqual(
          started.map(({ taskId }) => taskId).toSorted(),
        );
        const outputs = outputsByCall(events);
        for (const { callId, taskId } of started) {
          expect(outputs.get(callId)).toEqual({ status: "working", taskId });
        }
        // Receipts and the steering message reach the model in the same step.
        const reply = lastReply(events);
        expect(reply).toContain("A new message arrived, so this call moved to the background");
        expect(reply).toContain("[Tasks]");
        expect(count(events, "turn.started")).toBe(1);

        const status = await (await session.send("Where are d0 and sre?")).result();
        for (const { taskId } of started) expect(lastReply(status.events)).toContain(taskId);

        const later = await nextResultTurn(session);
        const received = later.filter(
          (event) => event.type === "message.received" && event.data.kind === "task.result",
        );
        expect(received).toHaveLength(1);
        expect(
          received[0]?.type === "message.received" ? received[0].data.taskIds?.toSorted() : [],
        ).toEqual(started.map(({ taskId }) => taskId).toSorted());
        const combined = lastReply(later);
        for (const { taskId } of started) expect(combined).toContain(`id="${taskId}"`);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "detaches a slow detach: { timeout } call but not a fast one, and ends a sleep early on steer",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults, userMessages }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Late: " + lastUserMessage;
    if (userMessages[0] === "Run both checks.") {
      if (toolResults.length === 0) {
        return {
          toolCalls: [
            { name: "check", input: { name: "fast", seconds: 1 } },
            { name: "check", input: { name: "slow", seconds: 12 } },
          ],
        };
      }
      return "Checks: " + JSON.stringify(toolResults.map((r) => r.output));
    }
    if (toolResults.length === 0) return { toolCalls: [{ name: "sleep", input: { seconds: 60 } }] };
    return "After sleep: " + JSON.stringify(toolResults.map((r) => r.output)) + " / " + lastUserMessage;
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Run checks and wait when asked.\n",
          "agent/tools/check.ts": `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Run one check.",
  inputSchema: z.object({ name: z.string(), seconds: z.number() }),
  detach: { timeout: 4_000 },
  async execute({ name, seconds }) {
    "use workflow";
    await sleep(seconds * 1000);
    return { check: name, passed: true };
  },
});
`,
          "agent/tools/sleep.ts": `import { sleep } from "eve/tools/sleep";

export default sleep();
`,
        },
        installDependencies: true,
        name: "detach-timeout-sleep",
      });
      const server = await startEveDev(app.appRoot, { env: ENV });
      try {
        const client = new Client({ host: server.url });

        const checks = await client.sessions.create({ message: "Run both checks." });
        const first = await checks.response.result();
        const started = first.events.flatMap((event) =>
          event.type === "task.started" ? [event.data] : [],
        );
        expect(started).toHaveLength(2);
        const detached = first.events.flatMap((event) =>
          event.type === "task.detached" ? [event.data] : [],
        );
        expect(detached).toHaveLength(1);
        expect(detached[0]?.reason).toBe("timeout");
        const slow = started.find(({ taskId }) => taskId === detached[0]?.taskId)!;
        const fast = started.find(({ taskId }) => taskId !== slow.taskId)!;
        const outputs = outputsByCall(first.events);
        expect(outputs.get(fast.callId)).toEqual({ check: "fast", passed: true });
        expect(outputs.get(slow.callId)).toEqual({ status: "working", taskId: slow.taskId });
        expect(lastReply(first.events)).toContain("This call is taking a while");

        const late = await nextResultTurn(checks.session);
        const received = late.find(
          (event) => event.type === "message.received" && event.data.kind === "task.result",
        );
        expect(received?.type === "message.received" ? received.data.taskIds : []).toEqual([
          slow.taskId,
        ]);
        expect(lastReply(late)).toContain('"check": "slow"');

        const nap = await client.sessions.create({ message: "Wait a minute." });
        const turn = followTurn(nap.response, (events) => count(events, "task.started") === 1);
        await turn.reached;
        await (await nap.session.send("Never mind, let's move on.")).result();
        const events = await turn.finished;

        const sleepTask = events.find((event) => event.type === "task.started");
        expect(count(events, "task.detached")).toBe(0);
        expect(events).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "cancelled",
              taskId: sleepTask?.type === "task.started" ? sleepTask.data.taskId : undefined,
            }),
            type: "task.settled",
          }),
        );
        const waited = [...outputsByCall(events).values()][0] as { waitedSeconds: number };
        expect(waited.waitedSeconds).toBeLessThan(60);
        const reply = lastReply(events);
        expect(reply).toContain("The sleep ended early after");
        expect(reply).toContain("Never mind, let's move on.");
        expect(count(events, "turn.started")).toBe(1);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "detaches a call waiting on approval for an unrelated message, then reports the answer",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Refund update: " + lastUserMessage;
    if (lastUserMessage === "What are your support hours?") {
      return "Refund pending: " + JSON.stringify(toolResults.map((r) => r.output)) + " Hours: 9 to 5.";
    }
    if (toolResults.length === 0) return { toolCalls: [{ name: "refund", input: { orderId: "42" } }] };
    return "Unexpected: " + lastUserMessage;
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
        name: "detach-approval",
      });
      const server = await startEveDev(app.appRoot, { env: ENV });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({
          message: "Please refund order 42.",
        });
        // A surfaced question closes the stream's turn while the call keeps waiting.
        await response.result();
        await (await session.send("What are your support hours?")).result();
        // `task.detached` belongs to the delivery that made the call, so read the whole log.
        const events: MessageStreamEvent[] = [];
        for await (const event of session.stream({ follow: false, startIndex: 0 })) {
          events.push(event);
        }

        const asked = events.find((event) => event.type === "input.requested");
        const requestId =
          asked?.type === "input.requested" ? asked.data.requests[0]?.requestId : "";
        expect(requestId).toBeTruthy();
        const detached = events.flatMap((event) =>
          event.type === "task.detached" ? [event.data] : [],
        );
        expect(detached).toEqual([expect.objectContaining({ reason: "steer" })]);
        const reply = lastReply(events);
        expect(reply).toContain("Refund pending:");
        expect(reply).toContain(`moved to the background as task ${detached[0]?.taskId}`);

        await session.respond([{ optionId: "approve", requestId: requestId! }]);
        const later = await nextResultTurn(session);
        const received = later.find(
          (event) => event.type === "message.received" && event.data.kind === "task.result",
        );
        expect(received?.type === "message.received" ? received.data.taskIds : []).toEqual([
          detached[0]?.taskId,
        ]);
        expect(lastReply(later)).toContain('"decision": "approve"');
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
