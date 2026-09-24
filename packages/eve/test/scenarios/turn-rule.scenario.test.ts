import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent, TaskStartedStreamEvent } from "../../src/protocol/message.js";
import {
  materializeScenarioApp,
  type ScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev, type RunningEveDev } from "./dev-server-harness.js";

// The turn rule end to end: no turn ends while tasks it started are working.
// eve holds the turn and calls the model again once a task settles, in every
// kind of session. Only an interactive root turn shows the waiting boundary,
// and it resumes under the same turn ID.

const SETUP_TIMEOUT_MS = 480_000;
const SCENARIO_TIMEOUT_MS = 360_000;
const EVENT_TIMEOUT_MS = 120_000;
const ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };

const LOOKUP_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Look up a quarter's revenue.",
  inputSchema: z.object({ quarter: z.string(), seconds: z.number() }),
  async execute({ quarter, seconds }) {
    "use workflow";
    await sleep(seconds * 1000);
    return { quarter, revenue: quarter === "Q3" ? "4.2M" : "3.9M" };
  },
});
`;

// Each session starts with one message that picks its plan; every plan starts
// a detached lookup and ends its turn without waiting, except the one that
// waits on the analyst agent.
const ROOT_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const idOf = (output) => /analyst-[0-9a-z]{6}/u.exec(String(output))?.[0] ?? "missing";
const lookup = (quarter, seconds) => ({ toolCalls: [{ name: "lookup", input: { quarter, seconds } }] });

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults, userMessages }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Final: " + lastUserMessage;
    const outputs = toolResults.map((result) => String(result.output));
    switch (userMessages[0]) {
      case "Ask the analyst about Q3.":
        if (toolResults.length === 0) {
          return { toolCalls: [{ name: "analyst", input: { message: "Report Q3 revenue." } }] };
        }
        if (toolResults.length === 1) {
          return { toolCalls: [{ name: "task_wait", input: { taskId: idOf(outputs[0]) } }] };
        }
        return "Parent: " + outputs.at(-1);
      case "Look up Q3.":
        if (lastUserMessage === "Any update?") return "Still working on Q3.";
        return toolResults.length === 0 ? lookup("Q3", 20) : "Started the Q3 lookup.";
      case "Summarize Q2.":
        return toolResults.length === 0 ? lookup("Q2", 5) : "Started the Q2 lookup.";
      case "Look up Q4.":
        return toolResults.length === 0 ? lookup("Q4", 20) : "Started the Q4 lookup.";
      default:
        return "Unexpected: " + lastUserMessage;
    }
  }),
  modelContextWindowTokens: 32_000,
});
`;

const ANALYST_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Reports revenue.",
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) {
      return "Analyst: Q3 revenue is " + /"revenue":\\s*"([^"]+)"/u.exec(lastUserMessage)?.[1];
    }
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "lookup", input: { quarter: "Q3", seconds: 8 } }] };
    }
    return "Analyst started a lookup.";
  }),
  modelContextWindowTokens: 32_000,
});
`;

/** Collects events from the stream until `done` holds or the timeout passes. */
async function collectUntil(
  stream: AsyncIterable<MessageStreamEvent>,
  done: (events: readonly MessageStreamEvent[]) => boolean,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  try {
    while (!done(events)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out; saw ${types(events).join(", ")}`);
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timed out; saw ${types(events).join(", ")}`)),
            remaining,
          ),
        ),
      ]);
      if (next.done) break;
      events.push(next.value);
    }
  } finally {
    void iterator.return?.();
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

function types(events: readonly MessageStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

function count(events: readonly MessageStreamEvent[], type: MessageStreamEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function replies(events: readonly MessageStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "message.completed" &&
    event.data.finishReason !== "tool-calls" &&
    typeof event.data.message === "string"
      ? [event.data.message]
      : [],
  );
}

function turnIds(events: readonly MessageStreamEvent[]): Set<string> {
  return new Set(
    events.flatMap((event) => {
      const data = "data" in event ? (event.data as { readonly turnId?: unknown }) : undefined;
      return typeof data?.turnId === "string" ? [data.turnId] : [];
    }),
  );
}

/** The data of the first event of `type`, for matching against. */
function dataOf(events: readonly MessageStreamEvent[], type: MessageStreamEvent["type"]): unknown {
  const event = events.find((candidate) => candidate.type === type);
  return event !== undefined && "data" in event ? event.data : undefined;
}

function indexOf(
  events: readonly MessageStreamEvent[],
  predicate: (event: MessageStreamEvent) => boolean,
): number {
  return events.findIndex(predicate);
}

function endsWithFinal(events: readonly MessageStreamEvent[]): boolean {
  const final = indexOf(events, (event) =>
    replies([event]).some((reply) => reply.startsWith("Final: ")),
  );
  return final >= 0 && events.slice(final).some((event) => event.type === "session.waiting");
}

describe("the turn rule", () => {
  let server: RunningEveDev;
  let app: ScenarioApp;

  beforeAll(async () => {
    app = await materializeScenarioApp({
      dependencies: { zod: "^4.3.6" },
      files: {
        "agent/agent.ts": ROOT_AGENT,
        "agent/instructions.md": "Look up revenue, and ask the analyst when asked.\n",
        "agent/subagents/analyst/agent.ts": ANALYST_AGENT,
        "agent/subagents/analyst/instructions.md": "Look up revenue, then report it.\n",
        "agent/subagents/analyst/tools/lookup.ts": LOOKUP_TOOL,
        "agent/tools/lookup.ts": LOOKUP_TOOL,
      },
      installDependencies: true,
      name: "turn-rule",
    });
    server = await startEveDev(app.appRoot, { env: ENV });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await app?.cleanup().catch(() => {});
  }, 120_000);

  it(
    "holds a child session's turn until its task settles, so the caller gets one reply",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({
        message: "Ask the analyst about Q3.",
      });
      const parent = (await response.result()).events;
      const started = parent.find(
        (event): event is MessageStreamEvent & TaskStartedStreamEvent =>
          event.type === "task.started" && event.data.name === "analyst",
      );
      expect(started?.data.child?.sessionId).toBeTruthy();
      // The caller's one reply is the answer the child gave after its own task settled.
      const settled = parent.filter(
        (event) => event.type === "task.settled" && event.data.taskId === started?.data.taskId,
      );
      expect(settled).toHaveLength(1);
      expect(dataOf(settled, "task.settled")).toMatchObject({
        output: "Analyst: Q3 revenue is 4.2M",
        status: "completed",
      });
      expect(replies(parent).at(-1)).toContain("Analyst: Q3 revenue is 4.2M");

      const child = await collectUntil(session.streamSubagent(started!), (events) =>
        events.some((event) => event.type === "session.waiting"),
      );
      // One child turn, held without a waiting boundary: it ends once, after its task settled.
      expect(count(child, "turn.started")).toBe(1);
      expect(count(child, "turn.completed")).toBe(1);
      expect(count(child, "session.waiting")).toBe(1);
      expect(replies(child)).toEqual(["Analyst started a lookup.", "Analyst: Q3 revenue is 4.2M"]);
      const lookupSettled = indexOf(child, (event) => event.type === "task.settled");
      const answer = indexOf(child, (event) =>
        replies([event]).includes("Analyst: Q3 revenue is 4.2M"),
      );
      expect(lookupSettled).toBeGreaterThan(-1);
      expect(answer).toBeGreaterThan(lookupSettled);
      expect(indexOf(child, (event) => event.type === "turn.completed")).toBeGreaterThan(answer);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "shows an interactive turn's waiting boundary and resumes it under the same turn ID",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({ message: "Look up Q3." });

      const first = (await response.result()).events;
      const turnStarted = first.find((event) => event.type === "turn.started");
      const id = turnStarted?.type === "turn.started" ? turnStarted.data.turnId : undefined;
      expect(id).toBeTruthy();
      expect(types(first).slice(-2)).toEqual(["turn.completed", "session.waiting"]);
      expect(dataOf(first.slice(-2), "turn.completed")).toMatchObject({ turnId: id });
      expect(replies(first)).toEqual(["Started the Q3 lookup."]);
      expect(count(first, "task.settled")).toBe(0);

      // The same person writes while the turn holds: it answers within the turn.
      const second = (await (await session.send("Any update?")).result()).events;
      expect(count(second, "turn.started")).toBe(0);
      expect(dataOf(second, "message.received")).toMatchObject({
        message: "Any update?",
        turnId: id,
      });
      expect(replies(second)).toEqual(["Still working on Q3."]);
      expect(types(second).slice(-2)).toEqual(["turn.completed", "session.waiting"]);

      // The result and the final answer arrive in the same turn.
      const later = await collectUntil(session.stream(), endsWithFinal);
      expect(count(later, "turn.started")).toBe(0);
      expect(dataOf(later, "message.received")).toMatchObject({
        kind: "task.result",
        turnId: id,
      });
      expect(replies(later).at(-1)).toMatch(/^Final: <task_result [^>]*status="completed">/u);
      expect(replies(later).at(-1)).toContain("4.2M");
      expect([...turnIds([...first, ...second, ...later])]).toEqual([id]);
      expect(count([...first, ...second, ...later], "turn.completed")).toBe(3);

      // Idle now: nothing wakes the session.
      const idle = await collectFor(session.stream(), 5_000);
      expect(count(idle, "turn.started")).toBe(0);
      expect(count(idle, "message.received")).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "holds a task-mode run without a waiting boundary and ends it with one result",
    async () => {
      const created = await fetch(new URL("/eve/v1/session", server.url), {
        body: JSON.stringify({ message: "Summarize Q2.", mode: "task" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(created.status).toBe(202);
      const { sessionId } = (await created.json()) as { readonly sessionId: string };
      const client = new Client({ host: server.url });
      const events = await collectUntil(
        client.sessions.attach(sessionId).stream({ startIndex: 0 }),
        (seen) => seen.some((event) => event.type === "session.completed"),
      );

      expect(count(events, "turn.started")).toBe(1);
      expect(count(events, "turn.completed")).toBe(1);
      expect(count(events, "session.waiting")).toBe(0);
      expect(types(events).at(-1)).toBe("session.completed");
      const settled = indexOf(events, (event) => event.type === "task.settled");
      const result = indexOf(events, (event) =>
        replies([event]).some((reply) => reply.startsWith("Final: ")),
      );
      expect(settled).toBeGreaterThan(-1);
      expect(result).toBeGreaterThan(settled);
      // The run's one result is its last message; nothing marks the interim one as an answer.
      expect(replies(events).filter((reply) => reply.startsWith("Final: "))).toHaveLength(1);
      expect(replies(events).at(-1)).toContain("3.9M");
      expect(indexOf(events, (event) => event.type === "turn.completed")).toBeGreaterThan(result);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "cancels a held turn and its task with session.cancel(), and no result arrives afterwards",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({ message: "Look up Q4." });
      const first = (await response.result()).events;
      const started = first.find((event) => event.type === "task.started");
      const taskId = started?.type === "task.started" ? started.data.taskId : undefined;
      const turnStarted = first.find((event) => event.type === "turn.started");
      const id = turnStarted?.type === "turn.started" ? turnStarted.data.turnId : undefined;
      expect(types(first).slice(-2)).toEqual(["turn.completed", "session.waiting"]);

      await expect(session.cancel()).resolves.toEqual({
        sessionId: session.state.sessionId,
        status: "accepted",
      });

      // The lookup would finish inside this window; its result must never reach the model.
      const later = await collectFor(session.stream(), 30_000);
      expect(later).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ status: "cancelled", taskId }),
          type: "task.settled",
        }),
      );
      expect(count(later, "task.settled")).toBe(1);
      // turn.completed at the waiting boundary, then turn.cancelled for the same turn ID.
      expect(later).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ turnId: id }),
          type: "turn.cancelled",
        }),
      );
      expect(count(later, "message.received")).toBe(0);
      expect(count(later, "turn.started")).toBe(0);
      expect(replies(later)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
