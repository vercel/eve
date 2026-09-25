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
  model: mockModel(({ lastUserMessage, messages, toolResults, userMessages }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Final: " + lastUserMessage;
    // Asked after the session compacted while the turn held on its lookup.
    if (lastUserMessage === "Do you still see the lookup?") {
      const noted = messages.some(
        (message) => message.role === "user" && message.text.includes("[Tasks]") && message.text.includes("lookup-"),
      );
      return noted ? "Tasks note: yes" : "Tasks note: no";
    }
    // A scheduled turn's message follows eve's delivery note.
    if (userMessages.includes("Look up Q1 for the board.")) {
      return toolResults.length === 0 ? lookup("Q1", 5) : "Started the Q1 lookup.";
    }
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
      case "Look up Q5.":
        return toolResults.length === 0 ? lookup("Q5", 25) : "Started the Q5 lookup.";
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

// Posts the way the built-in channels do: only a turn's reply, never tool-call
// narration or an interim message.
const BOARD_CHANNEL = `import { defineChannel, POST } from "eve/channels";

export default defineChannel<undefined, void, { id: string }>({
  routes: [POST("/board", async () => new Response("ok"))],
  receive(input, { from }) {
    return from(input.target.id).send(input.message, { auth: input.auth });
  },
  events: {
    "message.completed"(event) {
      if (event.finishReason === "tool-calls" || event.interim === true || !event.message) return;
      console.log("BOARD_POST " + JSON.stringify(event.message));
    },
  },
});
`;

const BOARD_SCHEDULE = `import { defineSchedule } from "eve/schedules";
import board from "../channels/board";

export default defineSchedule({
  cron: "0 0 * * 0",
  async run({ appAuth, to }) {
    await to(board, { id: "q1" }).send("Look up Q1 for the board.", { auth: appAuth });
  },
});
`;

/** Reads `iterator` until `done` holds, without ending it, or until the timeout passes. */
async function readUntil(
  iterator: AsyncIterator<MessageStreamEvent>,
  done: (events: readonly MessageStreamEvent[]) => boolean,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
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
  return events;
}

/** Whether the events end at a held turn's waiting boundary. */
function atHeldBoundary(events: readonly MessageStreamEvent[]): boolean {
  const [completed, waiting] = events.slice(-2);
  return (
    completed?.type === "turn.completed" &&
    completed.data.held === true &&
    waiting?.type === "session.waiting"
  );
}

/** The data of each `message.completed` whose text starts with `prefix`. */
function completedMessages(events: readonly MessageStreamEvent[], prefix: string) {
  return events.flatMap((event) =>
    event.type === "message.completed" && event.data.message?.startsWith(prefix) === true
      ? [event.data]
      : [],
  );
}

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

/** Every assistant text that ends a step, interim messages included. */
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
        "agent/channels/board.ts": BOARD_CHANNEL,
        "agent/schedules/board-q1.ts": BOARD_SCHEDULE,
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
      // With no boundary, the child's interim text says it is not the reply yet.
      expect(completedMessages(child, "Analyst started")).toEqual([
        expect.objectContaining({ interim: true }),
      ]);
      expect(completedMessages(child, "Analyst: Q3")[0]?.interim).toBeUndefined();
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
      const turn = response[Symbol.asyncIterator]();

      // The response does not end at the held boundary; read up to it.
      const first = await readUntil(turn, atHeldBoundary);
      const turnStarted = first.find((event) => event.type === "turn.started");
      const id = turnStarted?.type === "turn.started" ? turnStarted.data.turnId : undefined;
      expect(id).toBeTruthy();
      expect(dataOf(first.slice(-2), "turn.completed")).toEqual({
        held: true,
        sequence: expect.any(Number),
        turnId: id,
      });
      // In an interactive session the interim message is an ordinary reply.
      expect(completedMessages(first, "Started the Q3")).toEqual([
        expect.not.objectContaining({ interim: true }),
      ]);
      expect(count(first, "task.settled")).toBe(0);

      // The same person writes while the turn holds: it answers within the turn,
      // and that message's result follows the turn to its end.
      const second = await (await session.send("Any update?")).result();
      expect(count(second.events, "turn.started")).toBe(0);
      expect(dataOf(second.events, "message.received")).toMatchObject({
        message: "Any update?",
        turnId: id,
      });
      expect(replies(second.events)[0]).toBe("Still working on Q3.");
      const heldAgain = indexOf(
        second.events,
        (event) => event.type === "turn.completed" && event.data.held === true,
      );
      expect(heldAgain).toBeGreaterThan(-1);
      // The result and the final answer arrive in the same turn.
      expect(second.events.slice(heldAgain)).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ kind: "task.result", turnId: id }),
          type: "message.received",
        }),
      );
      expect(second.message).toMatch(/^Final: <task_result [^>]*status="completed">/u);
      expect(second.message).toContain("4.2M");
      expect(types(second.events).slice(-2)).toEqual(["turn.completed", "session.waiting"]);
      expect(dataOf(second.events.slice(-2), "turn.completed")).not.toHaveProperty("held");

      // The first message's response ends at the same final boundary.
      const rest = await readUntil(turn, endsWithFinal);
      expect(replies(rest).at(-1)).toBe(second.message);
      expect([...turnIds([...first, ...second.events])]).toEqual([id]);
      await turn.return?.();

      // Idle now: nothing wakes the session.
      const idle = await collectFor(session.stream(), 5_000);
      expect(count(idle, "turn.started")).toBe(0);
      expect(count(idle, "message.received")).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "compacts while a turn holds, and the [Tasks] note still lists its working task",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({ message: "Look up Q5." });
      const turn = response[Symbol.asyncIterator]();
      await readUntil(turn, atHeldBoundary);

      const compacted = await fetch(
        new URL(
          `/eve/v1/session/${encodeURIComponent(session.state.sessionId)}/compact`,
          server.url,
        ),
        { body: "{}", headers: { "content-type": "application/json" }, method: "POST" },
      );
      expect(compacted.status).toBe(202);
      // Compaction runs while the turn holds, without a boundary of its own.
      const compaction = await readUntil(turn, (events) =>
        events.some((event) => event.type === "compaction.completed"),
      );
      expect(count(compaction, "session.waiting")).toBe(0);
      expect(count(compaction, "turn.started")).toBe(0);

      // The model's next call re-announces the note that compaction summarized away.
      await session.send("Do you still see the lookup?");
      const asked = await readUntil(turn, atHeldBoundary);
      expect(replies(asked)).toContain("Tasks note: yes");
      await turn.return?.();
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
      // The run's one result is its last message; the interim one is marked as not the reply.
      expect(replies(events).filter((reply) => reply.startsWith("Final: "))).toHaveLength(1);
      expect(completedMessages(events, "Started the Q2")).toEqual([
        expect.objectContaining({ interim: true }),
      ]);
      expect(completedMessages(events, "Final: ")[0]?.interim).toBeUndefined();
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
      const turn = response[Symbol.asyncIterator]();
      const first = await readUntil(turn, atHeldBoundary);
      const started = first.find((event) => event.type === "task.started");
      const taskId = started?.type === "task.started" ? started.data.taskId : undefined;
      const turnStarted = first.find((event) => event.type === "turn.started");
      const id = turnStarted?.type === "turn.started" ? turnStarted.data.turnId : undefined;

      await expect(session.cancel()).resolves.toEqual({
        sessionId: session.state.sessionId,
        status: "accepted",
      });
      // The message's response ends with the cancelled turn.
      const ended = await readUntil(turn, () => false);
      expect(types(ended).slice(-2)).toEqual(["turn.cancelled", "session.waiting"]);

      // The lookup would finish inside this window; its result must never reach the model.
      const later = [...ended, ...(await collectFor(session.stream(), 30_000))];
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

  it(
    "holds a scheduled turn without a boundary, so its channel posts exactly one message",
    async () => {
      const dispatched = await fetch(new URL("/eve/v1/dev/schedules/board-q1", server.url), {
        method: "POST",
      });
      expect(dispatched.status).toBe(200);
      const { sessionIds } = (await dispatched.json()) as { readonly sessionIds: string[] };
      expect(sessionIds).toHaveLength(1);

      const client = new Client({ host: server.url });
      const events = await collectUntil(
        client.sessions.attach(sessionIds[0]!).stream({ startIndex: 0 }),
        endsWithFinal,
      );

      expect(count(events, "turn.started")).toBe(1);
      expect(count(events, "turn.completed")).toBe(1);
      expect(dataOf(events, "turn.completed")).not.toHaveProperty("held");
      expect(count(events, "session.waiting")).toBe(1);
      expect(completedMessages(events, "Started the Q1")).toEqual([
        expect.objectContaining({ interim: true }),
      ]);
      const final = completedMessages(events, "Final: ");
      expect(final).toHaveLength(1);
      expect(final[0]?.interim).toBeUndefined();

      // The channel posted the turn's reply once, and never the interim message.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const posts = server
        .stdout()
        .split("\n")
        .filter((line) => line.includes("BOARD_POST "));
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain("Final: ");
      expect(posts[0]).toContain("3.9M");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
