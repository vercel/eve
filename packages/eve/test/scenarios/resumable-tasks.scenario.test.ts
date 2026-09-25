import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import {
  materializeScenarioApp,
  type ScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { taskLifecycleViolations } from "../../src/internal/testing/task-lifecycle.js";
import { startEveDev, type RunningEveDev } from "./dev-server-harness.js";
import { throughFirstBoundary } from "./first-boundary.js";

// Resumable tasks end to end, driven by scripted mock models: a resumable
// workflow tool takes more input through its taskId until its body returns;
// a send to a working task is read into its work, or left unread when the
// body returns; task_cancel stops a generation but leaves the task open;
// ctx.reply cancels the agent tasks its generation still owns; a send to
// another tool's or another principal's task is refused; and an agent takes
// a send while idle (the next piece of work in the same child session) and
// while working (a correction that brings a new output schema).

const SETUP_TIMEOUT_MS = 480_000;
const SCENARIO_TIMEOUT_MS = 360_000;
const EVENT_TIMEOUT_MS = 120_000;
const ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };

const RELEASE_NOTES_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Draft release notes, then revise them on request.",
  inputSchema: z.object({ request: z.string() }),
  resumable: true,
  async execute(input, ctx) {
    "use workflow";
    let notes = "notes(" + input.request + ")";
    for (;;) {
      ctx.reply(notes);
      const next = await ctx.receive();
      if (next.request === "publish") return "published " + notes;
      notes = notes + ">" + next.request;
    }
  },
});
`;

// One plan per session, picked by its first message. Each step either calls
// a tool with a fixed call ID or answers from the results so far.
const ROOT_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const PRICING_SCHEMA = {
  additionalProperties: false,
  properties: { messages: { type: "number" }, title: { type: "string" } },
  required: ["title", "messages"],
  type: "object",
};

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults, userMessages }) => {
    const result = (id) => toolResults.find((candidate) => candidate.id === id);
    const text = (id) => String(result(id)?.output);
    const taskIdOf = (id, tool) => new RegExp(tool + "-[0-9a-z]{6}", "u").exec(text(id))?.[0];
    const callThenWait = (callId, call, taskId, finish) => {
      if (result(callId) === undefined) return { toolCalls: [{ id: callId, ...call }] };
      if (result(callId).isError) return "Refused: " + text(callId);
      const waitId = callId + "-wait";
      if (result(waitId) === undefined) {
        return { toolCalls: [{ id: waitId, name: "task_wait", input: { taskId: taskId ?? taskIdOf(callId, call.name) } }] };
      }
      return finish(text(waitId) + " | receipt: " + text(callId));
    };

    if (userMessages[0] === "Draft the 0.67 release notes.") {
      const notes = (request) => ({ name: "release_notes", input: { request, taskId: taskIdOf("notes-start", "release_notes") } });
      switch (lastUserMessage) {
        case "Draft the 0.67 release notes.":
          return callThenWait("notes-start", { name: "release_notes", input: { request: "0.67" } }, undefined, (out) => "Draft: " + out);
        case "Make them shorter.":
          return callThenWait("notes-send-1", notes("shorter"), taskIdOf("notes-start", "release_notes"), (out) => "Revised: " + out);
        case "Publish them.":
          return callThenWait("notes-send-2", notes("publish"), taskIdOf("notes-start", "release_notes"), (out) => "Published: " + out);
        case "One more tweak, please.":
          return result("notes-send-3") === undefined
            ? { toolCalls: [{ id: "notes-send-3", ...notes("tweak") }] }
            : "Refused: " + text("notes-send-3");
      }
    }

    if (userMessages[0] === "Draft the launch post.") {
      if (lastUserMessage?.startsWith("<task_result")) return "Structured: " + lastUserMessage;
      const writerTask = taskIdOf("writer-start", "writer");
      const writer = (message, extra = {}) => ({ name: "writer", input: { message, taskId: writerTask, ...extra } });
      switch (lastUserMessage) {
        case "Draft the launch post.":
          return callThenWait("writer-start", { name: "writer", input: { message: "Draft the launch post." } }, undefined, (out) => "Writer: " + out);
        case "Add a title to it.":
          return callThenWait("writer-send-1", writer("Add a title."), writerTask, (out) => "Writer: " + out);
        case "Now write the pricing page.":
          return result("writer-send-2") === undefined
            ? { toolCalls: [{ id: "writer-send-2", ...writer("Write the pricing page slowly.") }] }
            : "Started the pricing page.";
        case "Make the pricing page structured.":
          return result("writer-send-3") === undefined
            ? { toolCalls: [{ id: "writer-send-3", ...writer("Return the pricing page with a title.", { outputSchema: PRICING_SCHEMA }) }] }
            : "Sent the format.";
      }
    }

    if (userMessages[0] === "Collect notes on the launch.") {
      if (lastUserMessage?.startsWith("<task_result")) return "Collected: " + lastUserMessage;
      const collect = (id, request, taskId) => ({ id, name: "collect", input: taskId === undefined ? { request } : { request, taskId } });
      if (result("collect-start") === undefined) return { toolCalls: [collect("collect-start", "launch")] };
      const collectTask = taskIdOf("collect-start", "collect");
      if (result("collect-send-1") === undefined) {
        return { toolCalls: [collect("collect-send-1", "pricing", collectTask), collect("collect-send-2", "support", collectTask)] };
      }
      return "Sent two corrections.";
    }

    if (userMessages[0] === "Draft the copy slowly.") {
      const draftTask = taskIdOf("draft-start", "draft");
      if (lastUserMessage === "Now draft it quickly.") {
        return callThenWait("draft-send", { name: "draft", input: { request: "quickly", taskId: draftTask } }, draftTask, (out) => "Drafted: " + out);
      }
      if (result("draft-start") === undefined) return { toolCalls: [{ id: "draft-start", name: "draft", input: { request: "slowly" } }] };
      if (result("draft-cancel") === undefined) return { toolCalls: [{ id: "draft-cancel", name: "task_cancel", input: { taskId: draftTask } }] };
      return "Cancelled: " + text("draft-cancel");
    }

    if (userMessages[0] === "Brief the pricing page.") {
      return callThenWait("brief-start", { name: "brief", input: { topic: "pricing" } }, undefined, (out) => "Brief: " + out);
    }

    if (userMessages[0] === "Draft the 0.68 release notes.") {
      const notesTask = taskIdOf("other-start", "release_notes");
      const refused = (id, call) => (result(id) === undefined ? { toolCalls: [{ id, ...call }] } : "Refused.");
      switch (lastUserMessage) {
        case "Draft the 0.68 release notes.":
          return callThenWait("other-start", { name: "release_notes", input: { request: "0.68" } }, undefined, (out) => "Draft: " + out);
        case "Hand the notes to the writer.":
          return refused("other-mismatch", { name: "writer", input: { message: "Polish these notes.", taskId: notesTask } });
        case "Bob here: make the notes shorter.":
          return refused("other-principal", { name: "release_notes", input: { request: "shorter", taskId: notesTask } });
      }
    }
    return "Unexpected: " + lastUserMessage;
  }),
  modelContextWindowTokens: 32_000,
});
`;

// Answers with how many messages its session has seen, so a send that reached
// the same child session is visible. A request to go slowly gathers first; a
// turn given an output schema answers through final_output.
const WRITER_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Drafts launch copy.",
  model: mockModel(({ lastUserMessage, toolResults, tools, userMessages }) => {
    if (tools.some((tool) => tool.name === "final_output")) {
      return { toolCalls: [{ name: "final_output", input: { messages: userMessages.length, title: "Orbit pricing" } }] };
    }
    if (lastUserMessage?.includes("slowly") && !toolResults.some((result) => result.name === "gather")) {
      return { toolCalls: [{ name: "gather", input: {} }] };
    }
    // A new child's first message wraps the caller's; the caller's message is its last line.
    return "Draft " + userMessages.length + ": " + lastUserMessage?.split("\\n").at(-1);
  }),
  modelContextWindowTokens: 32_000,
});
`;

const GATHER_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  attached: true,
  description: "Gather pricing notes.",
  inputSchema: z.object({}),
  async execute() {
    "use workflow";
    await sleep(15_000);
    return { notes: "Orbit costs $49 per team each month." };
  },
});
`;

// Reads one correction sent while it works, then pauses so a second send
// arrives before it returns with that send unread.
const COLLECT_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Collect notes on a topic, taking a correction while it works.",
  inputSchema: z.object({ request: z.string() }),
  resumable: true,
  async execute(input, ctx) {
    "use workflow";
    const correction = await Promise.race([ctx.receive(), sleep("30s").then(() => undefined)]);
    await sleep("2s");
    return "notes: " + input.request + (correction === undefined ? "" : " + " + correction.request);
  },
});
`;

// A slow request works until it is cancelled; the body then waits for the
// next request, so the task stays open.
const DRAFT_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Draft copy on request.",
  inputSchema: z.object({ request: z.string() }),
  resumable: true,
  async execute(input, ctx) {
    "use workflow";
    for (;;) {
      if (input.request === "slowly") {
        const signal = ctx.abortSignal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      } else {
        ctx.reply("draft(" + input.request + ")");
      }
      input = await ctx.receive();
    }
  },
});
`;

// Replies while the writer it asked is still working, so the reply cancels
// that agent task first.
const BRIEF_TOOL = `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Brief a topic.",
  inputSchema: z.object({ topic: z.string() }),
  resumable: true,
  async execute(input, ctx) {
    "use workflow";
    ctx.agent("writer", { message: "Write the " + input.topic + " page slowly." }).catch(() => undefined);
    await sleep("5s");
    ctx.reply("brief(" + input.topic + ")");
  },
});
`;

const BOB_TOKEN = "bob-resumable-token";

// Bob's token names Bob; every other caller is Alice.
const CHANNEL = `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth(request) {
    const bob = request.headers.get("authorization") === "Bearer ${BOB_TOKEN}";
    return { attributes: {}, authenticator: "scenario-bearer", principalId: bob ? "bob" : "alice", principalType: "user" };
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

function types(events: readonly MessageStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

function replies(events: readonly MessageStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "message.completed" && typeof event.data.message === "string"
      ? [event.data.message]
      : [],
  );
}

function resultOf(events: readonly MessageStreamEvent[], callId: string) {
  const event = events.find(
    (candidate) => candidate.type === "action.result" && candidate.data.result.callId === callId,
  );
  return event?.type === "action.result" ? event.data.result : undefined;
}

/** The task a call started, from its receipt. */
function taskIdOf(events: readonly MessageStreamEvent[], callId: string): string | undefined {
  return (resultOf(events, callId)?.output as { readonly taskId?: string } | undefined)?.taskId;
}

function settledFor(events: readonly MessageStreamEvent[], taskId: string) {
  return events.flatMap((event) =>
    event.type === "task.settled" && event.data.taskId === taskId ? [event.data] : [],
  );
}

describe("resumable tasks", () => {
  let server: RunningEveDev;
  let app: ScenarioApp;

  beforeAll(async () => {
    app = await materializeScenarioApp({
      dependencies: { zod: "^4.3.6" },
      files: {
        "agent/agent.ts": ROOT_AGENT,
        "agent/channels/eve.ts": CHANNEL,
        "agent/instructions.md": "Draft release notes, and delegate copy to the writer.\n",
        "agent/subagents/writer/agent.ts": WRITER_AGENT,
        "agent/subagents/writer/instructions.md": "Draft the copy you are asked for.\n",
        "agent/subagents/writer/tools/gather.ts": GATHER_TOOL,
        "agent/tools/brief.ts": BRIEF_TOOL,
        "agent/tools/collect.ts": COLLECT_TOOL,
        "agent/tools/draft.ts": DRAFT_TOOL,
        "agent/tools/release_notes.ts": RELEASE_NOTES_TOOL,
      },
      installDependencies: true,
      name: "resumable-tasks",
    });
    server = await startEveDev(app.appRoot, { env: ENV });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await app?.cleanup().catch(() => {});
  }, 120_000);

  it(
    "sends more input to a resumable workflow tool until its body returns, then refuses the task",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({
        message: "Draft the 0.67 release notes.",
      });

      const first = (await throughFirstBoundary(response)).events;
      const start = resultOf(first, "notes-start");
      const taskId = (start?.output as { readonly taskId?: string } | undefined)?.taskId;
      expect(taskId).toMatch(/^release_notes-[0-9a-z]{6}$/u);
      expect(start).toMatchObject({ output: { status: "working", taskId } });
      expect(replies(first).at(-1)).toMatch(/^Draft: <task_result [^>]*status="completed"/u);
      expect(replies(first).at(-1)).toContain("notes(0.67)");
      expect(replies(first).at(-1)).toContain(
        `receipt: Started task ${taskId}. Call release_notes again with taskId ${taskId} to send it more input; use task_wait for its result.`,
      );

      // The task is idle: a send starts its next generation under the send's call.
      const second = (await throughFirstBoundary(await session.send("Make them shorter."))).events;
      expect(resultOf(second, "notes-send-1")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(second).at(-1)).toContain(
        `receipt: Sent to task ${taskId}, which is now working on it. Use task_wait for its result.`,
      );
      expect(second).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            callId: "notes-send-1",
            generation: 2,
            resumable: true,
            taskId,
          }),
          type: "task.started",
        }),
      );
      expect(settledFor(second, taskId!)).toEqual([
        expect.objectContaining({
          callId: "notes-send-1",
          generation: 2,
          output: "notes(0.67)>shorter",
          status: "completed",
        }),
      ]);
      expect(replies(second).at(-1)).toContain("notes(0.67)>shorter");

      // A send the body answers by returning ends the task with that result.
      const third = (await throughFirstBoundary(await session.send("Publish them."))).events;
      expect(settledFor(third, taskId!)).toEqual([
        expect.objectContaining({
          callId: "notes-send-2",
          generation: 3,
          output: "published notes(0.67)>shorter",
          status: "completed",
        }),
      ]);
      expect(replies(third).at(-1)).toContain("published notes(0.67)>shorter");

      // The ended task takes no more input.
      const fourth = (await throughFirstBoundary(await session.send("One more tweak, please.")))
        .events;
      expect(resultOf(fourth, "notes-send-3")).toMatchObject({
        isError: true,
        output: { code: "UNKNOWN_TASK" },
      });
      expect(replies(fourth).at(-1)).toMatch(/^Refused: /u);
      expect(settledFor(fourth, taskId!)).toEqual([]);
      // The run reports its end apart from its last result, so it can land after that turn.
      const events = (await session.snapshot()).events;
      expect(events).toContainEqual(
        expect.objectContaining({ data: { taskId }, type: "task.ended" }),
      );
      expect(taskLifecycleViolations(events)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "continues an idle agent in its session and corrects a working one with a new output schema",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({
        message: "Draft the launch post.",
      });

      const first = (await throughFirstBoundary(response)).events;
      const taskId = (resultOf(first, "writer-start")?.output as { readonly taskId?: string })
        ?.taskId;
      expect(taskId).toMatch(/^writer-[0-9a-z]{6}$/u);
      expect(replies(first).at(-1)).toContain("Draft 1: Draft the launch post.");

      // Idle: the send is the agent's next piece of work, in the same child session.
      const second = (await throughFirstBoundary(await session.send("Add a title to it."))).events;
      expect(resultOf(second, "writer-send-1")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(second).at(-1)).toContain("Draft 2: Add a title.");

      // Working: the pricing page gathers for a while, so the turn holds.
      const third = (await throughFirstBoundary(await session.send("Now write the pricing page.")))
        .events;
      expect(resultOf(third, "writer-send-2")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(third).at(-1)).toBe("Started the pricing page.");
      // The turn holds, open to input without ending.
      expect(types(third).at(-1)).toBe("session.waiting");
      expect(types(third)).not.toContain("turn.completed");

      // A correction joins the running work and brings the output schema its result takes.
      const fourth = (
        await throughFirstBoundary(await session.send("Make the pricing page structured."))
      ).events;
      expect(resultOf(fourth, "writer-send-3")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(fourth).at(-1)).toBe("Sent the format.");

      const later = await collectUntil(session.stream(), (events) =>
        replies(events).some((reply) => reply.startsWith("Structured: ")),
      );
      // The correction joined generation 3 rather than starting another.
      expect(settledFor([...fourth, ...later], taskId!)).toEqual([
        expect.objectContaining({
          generation: 3,
          output: { messages: 4, title: "Orbit pricing" },
          status: "completed",
        }),
      ]);
      expect(replies(later).at(-1)).toContain("Orbit pricing");
      expect(taskLifecycleViolations((await session.snapshot()).events)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "reads a send to a working task into its work, and fails a send the body returns without reading",
    async () => {
      const client = new Client({ host: server.url });
      const { response } = await client.sessions.create({
        message: "Collect notes on the launch.",
      });

      const events = (await response.result()).events;
      const taskId = taskIdOf(events, "collect-start");
      expect(taskId).toMatch(/^collect-[0-9a-z]{6}$/u);
      for (const callId of ["collect-send-1", "collect-send-2"]) {
        expect(resultOf(events, callId)).toMatchObject({ output: { status: "working", taskId } });
      }
      // The first send joined generation 1; the second got its own generation, which
      // failed when the body returned without reading it.
      expect(settledFor(events, taskId!)).toEqual([
        expect.objectContaining({
          callId: "collect-start",
          generation: 1,
          output: "notes: launch + pricing",
          status: "completed",
        }),
        expect.objectContaining({
          callId: "collect-send-2",
          error: { code: "EXECUTION_FAILED", message: "The task ended before it read this input." },
          generation: 2,
          status: "failed",
        }),
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({ data: { taskId }, type: "task.ended" }),
      );
      expect(replies(events).join("\n")).toContain("notes: launch + pricing");
      expect(taskLifecycleViolations(events)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "cancels a generation with task_cancel and keeps the task open for the next send",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({
        message: "Draft the copy slowly.",
      });

      const first = (await response.result()).events;
      const taskId = taskIdOf(first, "draft-start");
      expect(resultOf(first, "draft-cancel")).toMatchObject({ output: { status: "cancelled" } });
      expect(settledFor(first, taskId!)).toEqual([
        expect.objectContaining({ callId: "draft-start", generation: 1, status: "cancelled" }),
      ]);
      expect(replies(first).at(-1)).toMatch(/^Cancelled: /u);

      // Unlike a body that returns, a cancel ends only the work: the task takes the next send.
      const second = (await (await session.send("Now draft it quickly.")).result()).events;
      expect(resultOf(second, "draft-send")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(settledFor(second, taskId!)).toEqual([
        expect.objectContaining({
          callId: "draft-send",
          generation: 2,
          output: "draft(quickly)",
          status: "completed",
        }),
      ]);
      expect(replies(second).at(-1)).toContain("draft(quickly)");
      const events = (await session.snapshot()).events;
      expect(
        events.filter((event) => event.type === "task.ended" && event.data.taskId === taskId),
      ).toEqual([]);
      expect(taskLifecycleViolations(events)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "cancels the agent tasks a generation still owns when it replies, before its result",
    async () => {
      const client = new Client({ host: server.url });
      const { session, response } = await client.sessions.create({
        message: "Brief the pricing page.",
      });

      const events = (await response.result()).events;
      const briefId = taskIdOf(events, "brief-start");
      const writer = events.find(
        (event) => event.type === "task.started" && event.data.name === "writer",
      );
      expect(writer).toMatchObject({ data: { kind: "agent", mode: "attached" } });
      const writerId = writer?.type === "task.started" ? writer.data.taskId : undefined;
      const settledAt = (taskId: string | undefined) =>
        events.findIndex((event) => event.type === "task.settled" && event.data.taskId === taskId);
      expect(events[settledAt(writerId)]).toMatchObject({ data: { status: "cancelled" } });
      expect(settledAt(writerId)).toBeLessThan(settledAt(briefId));
      expect(settledFor(events, briefId!)).toEqual([
        expect.objectContaining({ generation: 1, output: "brief(pricing)", status: "completed" }),
      ]);
      expect(replies(events).at(-1)).toContain("brief(pricing)");
      // Cancelled work never reaches the model.
      expect(replies(events).join("\n")).not.toContain('tool="writer"');
      expect(taskLifecycleViolations((await session.snapshot()).events)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "refuses a send to another tool's task and to another principal's task",
    async () => {
      const alice = new Client({ host: server.url });
      const bob = new Client({ auth: { bearer: BOB_TOKEN }, host: server.url });
      const { session, response } = await alice.sessions.create({
        message: "Draft the 0.68 release notes.",
      });

      const first = (await throughFirstBoundary(response)).events;
      const taskId = taskIdOf(first, "other-start");
      expect(taskId).toMatch(/^release_notes-[0-9a-z]{6}$/u);

      const mismatch = (
        await throughFirstBoundary(await session.send("Hand the notes to the writer."))
      ).events;
      expect(resultOf(mismatch, "other-mismatch")).toMatchObject({
        isError: true,
        output: {
          code: "TASK_MISMATCH",
          message: `Task "${taskId}" belongs to release_notes; call release_notes with it.`,
        },
      });

      const refused = (
        await throughFirstBoundary(
          await bob.sessions.attach(response.sessionId).send("Bob here: make the notes shorter."),
        )
      ).events;
      expect(resultOf(refused, "other-principal")).toMatchObject({
        isError: true,
        output: {
          code: "TASK_OTHER_PRINCIPAL",
          message: `Task "${taskId}" was started by a different caller, so you can't use it. Start a new one by calling its tool without taskId.`,
        },
      });

      // Neither refused send reached the task.
      const events = (await session.snapshot()).events;
      expect(
        events.filter((event) => event.type === "task.started" && event.data.taskId === taskId),
      ).toHaveLength(1);
      expect(taskLifecycleViolations(events)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
