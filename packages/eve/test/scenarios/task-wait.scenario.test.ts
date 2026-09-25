import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { ClientSession, MessageResponse } from "../../src/client/index.js";
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";
import { throughFirstBoundary } from "./first-boundary.js";

// task_wait end to end over detached agent calls: a settled result, a
// timeout whose result arrives later in the same held turn, a wait a steering
// message interrupts, two waits in one step, and a wait's timeout next to
// the task's own time limit.

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const RESULT_TIMEOUT_MS = 90_000;
const ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };

const PARENT_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const PLANS = {
  "Research d0.": { message: "source=d0 seconds=4" },
  "Research sre briefly.": { message: "source=sre seconds=15", timeout: 2000 },
  "Research plain.": { message: "source=plain seconds=15" },
};
const idOf = (output) => /(?:researcher|auditor)-[0-9a-z]{6}/u.exec(String(output))?.[0] ?? "missing";
const research = (message) => ({ name: "researcher", input: { message } });

export default defineAgent({
  model: mockModel(({ lastUserMessage, messages, toolResults, userMessages }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Late: " + lastUserMessage;
    if (lastUserMessage === "Did any result arrive twice?") {
      const count = (role) =>
        messages.filter((m) => m.role === role && m.text.includes("<task_result")).length;
      return "Seen task_result blocks: tool=" + count("tool") + " user=" + count("user");
    }
    const outputs = toolResults.map((result) => String(result.output));
    if (lastUserMessage === "Actually, hold off on plain.") return "Interrupted: " + outputs.at(-1);
    if (userMessages[0] === "Fan in d1 and d2.") {
      if (toolResults.length === 0) return { toolCalls: [research("source=d1 seconds=3"), research("source=d2 seconds=6")] };
      if (toolResults.length === 2) {
        return {
          toolCalls: outputs.map((output) => ({ name: "task_wait", input: { taskId: idOf(output) } })),
        };
      }
      return "FanIn: " + outputs.slice(2).join(" | ");
    }
    if (userMessages[0] === "Audit the ledger.") {
      if (toolResults.length === 0) return { toolCalls: [{ name: "auditor", input: { message: "source=ledger seconds=20" } }] };
      const taskId = idOf(outputs[0]);
      // A short wait times out first; the next wait lasts until the audit's own limit.
      if (toolResults.length === 1) return { toolCalls: [{ name: "task_wait", input: { taskId, timeout: 1000 } }] };
      if (toolResults.length === 2) return { toolCalls: [{ name: "task_wait", input: { taskId } }] };
      return "Audited: " + outputs.at(-1);
    }
    const plan = PLANS[userMessages[0]];
    if (plan === undefined) return "Unexpected: " + lastUserMessage;
    if (toolResults.length === 0) return { toolCalls: [research(plan.message)] };
    if (toolResults.length === 1) {
      const taskId = idOf(outputs[0]);
      const input = plan.timeout === undefined ? { taskId } : { taskId, timeout: plan.timeout };
      return { toolCalls: [{ name: "task_wait", input }] };
    }
    return "Waited: " + outputs.at(-1);
  }),
  modelContextWindowTokens: 32_000,
});
`;

const RESEARCHER_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Researches one source.",
  model: mockModel(({ messages, toolResults }) => {
    const text = messages.map((message) => message.text).join(" ");
    const [, source, seconds] = /source=(\\w+) seconds=(\\d+)/u.exec(text) ?? [];
    const [gathered] = toolResults;
    if (gathered === undefined) {
      return { toolCalls: [{ name: "gather", input: { seconds: Number(seconds), source } }] };
    }
    return "Found " + gathered.output.source + " healthy.";
  }),
  modelContextWindowTokens: 32_000,
});
`;

// The researcher with a 5-second limit on each piece of its work.
const AUDITOR_AGENT = RESEARCHER_AGENT.replace(
  "modelContextWindowTokens: 32_000,",
  "modelContextWindowTokens: 32_000,\n  timeout: 5_000,",
);

const GATHER_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  attached: true,
  description: "Gather notes on a source.",
  inputSchema: z.object({ seconds: z.number(), source: z.string() }),
  async execute({ seconds, source }) {
    "use workflow";
    await sleep(seconds * 1000);
    return { source };
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

/** Collects the session stream through the step that delivers task results and the turn's end. */
async function nextTaskResults(session: ClientSession): Promise<MessageStreamEvent[]> {
  return await collectUntil(session.stream(), (events) => {
    const delivered = events.findIndex(
      (event) => event.type === "message.received" && event.data.kind === "task.result",
    );
    return delivered >= 0 && events.slice(delivered).some((e) => e.type === "turn.completed");
  });
}

function waitCallIds(events: readonly MessageStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "actions.requested"
      ? event.data.actions.flatMap((action) =>
          "toolName" in action && action.toolName === "task_wait" ? [action.callId] : [],
        )
      : [],
  );
}

function outputOf(events: readonly MessageStreamEvent[], callId: string | undefined): unknown {
  const event = events.find(
    (candidate) => candidate.type === "action.result" && candidate.data.result.callId === callId,
  );
  return event?.type === "action.result" ? event.data.result.output : undefined;
}

function receiptTaskIds(events: readonly MessageStreamEvent[], toolName = "researcher"): string[] {
  return events.flatMap((event) =>
    event.type === "action.result" &&
    event.data.result.kind === "tool-result" &&
    event.data.result.toolName === toolName
      ? [(event.data.result.output as { readonly taskId: string }).taskId]
      : [],
  );
}

function taskResultMessages(events: readonly MessageStreamEvent[]): number {
  return events.filter(
    (event) => event.type === "message.received" && event.data.kind === "task.result",
  ).length;
}

function lastReply(events: readonly MessageStreamEvent[]): string {
  const reply = events.findLast((event) => event.type === "message.completed");
  return reply?.type === "message.completed" ? (reply.data.message ?? "") : "";
}

describe("task_wait", () => {
  it(
    "returns a detached result, times out, yields to a steering message, fans in, and returns the task's own timeout",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": PARENT_AGENT,
          "agent/instructions.md": "Research sources and wait when asked.\n",
          "agent/subagents/researcher/agent.ts": RESEARCHER_AGENT,
          "agent/subagents/researcher/instructions.md": "Gather notes, then report.\n",
          "agent/subagents/researcher/tools/gather.ts": GATHER_TOOL,
          "agent/subagents/auditor/agent.ts": AUDITOR_AGENT,
          "agent/subagents/auditor/instructions.md": "Gather notes, then report.\n",
          "agent/subagents/auditor/tools/gather.ts": GATHER_TOOL,
        },
        installDependencies: true,
        name: "task-wait",
      });
      const server = await startEveDev(app.appRoot, { env: ENV });
      try {
        const client = new Client({ host: server.url });

        // 1. Settled: the wait receives the result as its own tool result, exactly once.
        const d0 = await client.sessions.create({ message: "Research d0." });
        const first = await throughFirstBoundary(d0.response);
        const [d0Task] = receiptTaskIds(first.events);
        const [d0Wait] = waitCallIds(first.events);
        expect(outputOf(first.events, d0Wait)).toEqual({
          name: "researcher",
          outcome: { output: "Found d0 healthy.", status: "completed" },
          status: "settled",
          taskId: d0Task,
        });
        expect(lastReply(first.events)).toContain(`Waited: <task_result id="${d0Task}"`);
        expect(taskResultMessages(first.events)).toBe(0);
        const followUp = await throughFirstBoundary(
          await d0.session.send("Did any result arrive twice?"),
        );
        expect(taskResultMessages(followUp.events)).toBe(0);
        expect(lastReply(followUp.events)).toBe("Seen task_result blocks: tool=1 user=0");

        // 2. Timed out: the wait ends, the task keeps working, and the turn holds until its
        // result arrives once.
        const sre = await client.sessions.create({ message: "Research sre briefly." });
        const timed = await throughFirstBoundary(sre.response);
        const [sreTask] = receiptTaskIds(timed.events);
        const [sreWait] = waitCallIds(timed.events);
        expect(outputOf(timed.events, sreWait)).toEqual({ status: "timed_out", taskId: sreTask });
        expect(lastReply(timed.events)).toContain("Waited: Stopped waiting after");
        expect(lastReply(timed.events)).toContain(`${sreTask} is still working.`);
        const late = await nextTaskResults(sre.session);
        expect(taskResultMessages(late)).toBe(1);
        expect(lastReply(late)).toContain(`Late: <task_result id="${sreTask}"`);
        expect(lastReply(late)).toContain("Found sre healthy.");

        // 3. Interrupted: a steering message ends the wait in the same turn, not the task.
        const plain = await client.sessions.create({ message: "Research plain." });
        const turn = followTurn(plain.response, (events) => waitCallIds(events).length === 1);
        await turn.reached;
        await throughFirstBoundary(await plain.session.send("Actually, hold off on plain."));
        const interrupted = await turn.finished;
        const [plainTask] = receiptTaskIds(interrupted);
        const [plainWait] = waitCallIds(interrupted);
        expect(outputOf(interrupted, plainWait)).toEqual({
          status: "interrupted",
          taskId: plainTask,
        });
        expect(lastReply(interrupted)).toContain(
          "Interrupted: A new message arrived, so the wait ended after",
        );
        expect(
          interrupted.some(
            (event) => event.type === "task.settled" && event.data.status === "cancelled",
          ),
        ).toBe(false);
        const plainLate = await nextTaskResults(plain.session);
        expect(lastReply(plainLate)).toContain("Found plain healthy.");

        // 4. Fan-in: two waits in one step; the step ends once both results are in.
        const fan = await client.sessions.create({ message: "Fan in d1 and d2." });
        const fanned = await throughFirstBoundary(fan.response);
        const fanCalls = waitCallIds(fanned.events);
        expect(fanCalls).toHaveLength(2);
        for (const callId of fanCalls) {
          expect(outputOf(fanned.events, callId)).toMatchObject({ status: "settled" });
        }
        expect(lastReply(fanned.events)).toMatch(/Found d1 healthy\.[\s\S]*Found d2 healthy\./u);
        expect(taskResultMessages(fanned.events)).toBe(0);

        // 5. A wait's timeout ends only the wait, and the audit keeps working; the audit's
        // own 5-second limit then fails it with TIMED_OUT, which the next wait returns.
        const audit = await client.sessions.create({ message: "Audit the ledger." });
        const audited = (await audit.response.result()).events;
        const [auditTask] = receiptTaskIds(audited, "auditor");
        const [shortWait, longWait] = waitCallIds(audited);
        expect(outputOf(audited, shortWait)).toEqual({ status: "timed_out", taskId: auditTask });
        expect(outputOf(audited, longWait)).toMatchObject({
          name: "auditor",
          outcome: { error: { code: "TIMED_OUT" }, status: "failed" },
          status: "settled",
          taskId: auditTask,
        });
        expect(
          audited.flatMap((event) =>
            event.type === "task.settled" && event.data.taskId === auditTask ? [event.data] : [],
          ),
        ).toEqual([
          expect.objectContaining({
            error: expect.objectContaining({ code: "TIMED_OUT" }),
            status: "failed",
          }),
        ]);
        expect(lastReply(audited)).toContain(
          `<task_result id="${auditTask}" tool="auditor" status="failed" code="TIMED_OUT">`,
        );
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
