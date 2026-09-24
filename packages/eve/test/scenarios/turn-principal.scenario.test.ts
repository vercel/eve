import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageResponse } from "../../src/client/index.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

// Only a turn's own principal steers it: Bob's message during Alice's turn
// waits for that turn to end, then starts a turn of Bob's own, while Bob's
// answer to a request Alice's turn waits on reaches it at once.

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const RESULT_TIMEOUT_MS = 90_000;
const ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };
const ALICE_TOKEN = "alice-scenario-token";
const BOB_TOKEN = "bob-scenario-token";

const AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const actors = (toolResults) =>
  toolResults.filter((r) => r.name === "whoami").map((r) => JSON.stringify(r.output));

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage === "Please wait a moment.") {
      const slept = toolResults.find((r) => r.name === "sleep");
      if (slept === undefined) return { toolCalls: [{ name: "sleep", input: { seconds: 8 } }] };
      if (actors(toolResults).length === 0) return { toolCalls: [{ name: "whoami", input: {} }] };
      return "Waited as " + actors(toolResults)[0] + ": " + JSON.stringify(slept.output);
    }
    if (lastUserMessage === "Bob here, can you help?") {
      if (actors(toolResults).length < 2) return { toolCalls: [{ name: "whoami", input: {} }] };
      return "Own turn as " + actors(toolResults)[1];
    }
    if (lastUserMessage === "Refund order 42, then wait for it.") {
      const waited = toolResults.find((r) => r.name === "task_wait");
      if (waited !== undefined) return "Refund: " + String(waited.output);
      const receipt = toolResults.find((r) => r.name === "refund");
      if (receipt === undefined) return { toolCalls: [{ name: "refund", input: { orderId: "42" } }] };
      const taskId = /Started task ([\\w-]+)\\./u.exec(String(receipt.output))?.[1];
      return { toolCalls: [{ name: "task_wait", input: { taskId } }] };
    }
    return "Unexpected: " + lastUserMessage;
  }),
  modelContextWindowTokens: 32_000,
});
`;

const CHANNEL = `import { eveChannel } from "eve/channels/eve";

const PRINCIPALS = { "Bearer ${ALICE_TOKEN}": "alice", "Bearer ${BOB_TOKEN}": "bob" };

export default eveChannel({
  auth(request) {
    const principalId = PRINCIPALS[request.headers.get("authorization") ?? ""];
    if (principalId === undefined) return null;
    return { attributes: {}, authenticator: "scenario-bearer", principalId, principalType: "user" };
  },
});
`;

const WHOAMI_TOOL = `import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Report who the current turn acts for.",
  inputSchema: z.object({}),
  approval: never(),
  execute(_input, ctx) {
    return ctx.session.auth.current?.principalId ?? "anonymous";
  },
});
`;

const REFUND_TOOL = `import { defineWorkflowTool } from "eve/tools";
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
`;

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
 * `ready` holds, so the test can send a message while the turn still runs.
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

function count(events: readonly MessageStreamEvent[], type: MessageStreamEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function lastReply(events: readonly MessageStreamEvent[]): string {
  const reply = events.findLast((event) => event.type === "message.completed");
  return reply?.type === "message.completed" ? (reply.data.message ?? "") : "";
}

describe("the principal check", () => {
  it(
    "queues another principal's message behind the turn, and routes that principal's answer at once",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": AGENT,
          "agent/channels/eve.ts": CHANNEL,
          "agent/instructions.md": "Help whoever writes.\n",
          "agent/tools/refund.ts": REFUND_TOOL,
          "agent/tools/sleep.ts": `import { sleep } from "eve/tools/sleep";\n\nexport default sleep();\n`,
          "agent/tools/whoami.ts": WHOAMI_TOOL,
        },
        installDependencies: true,
        name: "turn-principal",
      });
      const server = await startEveDev(app.appRoot, { env: ENV });
      try {
        const alice = new Client({ auth: { bearer: ALICE_TOKEN }, host: server.url });
        const bob = new Client({ auth: { bearer: BOB_TOKEN }, host: server.url });

        // Bob writes while Alice's turn waits on an attached sleep.
        const nap = await alice.sessions.create({ message: "Please wait a moment." });
        const turn = followTurn(nap.response, (events) => count(events, "task.started") === 1);
        await turn.reached;
        await bob.sessions.attach(nap.response.sessionId).send("Bob here, can you help?");
        const aliceTurn = await turn.finished;

        // Bob's message did not steer: the sleep ran to its end, as Alice.
        const sleepTask = aliceTurn.find((event) => event.type === "task.started");
        const sleepId = sleepTask?.type === "task.started" ? sleepTask.data.taskId : undefined;
        expect(aliceTurn).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ status: "completed", taskId: sleepId }),
            type: "task.settled",
          }),
        );
        expect(lastReply(aliceTurn)).toMatch(/^Waited as "alice": /u);
        expect(lastReply(aliceTurn)).not.toContain("interrupted");
        expect(count(aliceTurn, "turn.started")).toBe(1);
        expect(JSON.stringify(aliceTurn)).not.toContain("Bob here");

        // Once Alice's turn ended, Bob's message started a turn of his own, as Bob.
        const both = await collectUntil(
          nap.session.stream({ startIndex: 0 }),
          (events) =>
            count(events, "turn.completed") >= 2 && events.at(-1)?.type === "session.waiting",
        );
        expect(count(both, "turn.started")).toBe(2);
        expect(lastReply(both)).toBe('Own turn as "bob"');

        // Bob answers the question Alice's turn waits on; the answer is not queued behind it.
        const refund = await alice.sessions.create({
          message: "Refund order 42, then wait for it.",
        });
        const asked = await collectUntil(refund.session.stream({ startIndex: 0 }), (events) =>
          events.some((event) => event.type === "input.requested"),
        );
        const request = asked.find((event) => event.type === "input.requested");
        const requestId =
          request?.type === "input.requested" ? request.data.requests[0]?.requestId : undefined;
        expect(requestId).toBeTruthy();
        await bob.sessions
          .attach(refund.response.sessionId)
          .respond([{ optionId: "approve", requestId: requestId! }]);

        const answered = await collectUntil(
          refund.session.stream({ startIndex: 0 }),
          (events) =>
            lastReply(events).startsWith("Refund:") && events.at(-1)?.type === "session.waiting",
        );
        // The answer resolved the task_wait inside Alice's turn, not a later result turn.
        expect(lastReply(answered)).toMatch(/^Refund: <task_result [^>]*status="completed">/u);
        expect(lastReply(answered)).toMatch(/"decision":\s*"approve"/u);
        expect(JSON.stringify(answered)).not.toContain("Unexpected:");
      } catch (error) {
        throw new Error(
          [`stdout:\n${server.stdout()}`, `stderr:\n${server.stderr()}`].join("\n\n"),
          { cause: error },
        );
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
