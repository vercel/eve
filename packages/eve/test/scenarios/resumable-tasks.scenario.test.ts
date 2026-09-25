import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import {
  materializeScenarioApp,
  type ScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev, type RunningEveDev } from "./dev-server-harness.js";

// Resumable tasks end to end, driven by scripted mock models: a resumable
// workflow tool takes more input through its taskId until its body returns,
// and an agent takes a send while idle (the next piece of work in the same
// child session) and while working (a correction that brings a new output
// schema).

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
        "agent/instructions.md": "Draft release notes, and delegate copy to the writer.\n",
        "agent/subagents/writer/agent.ts": WRITER_AGENT,
        "agent/subagents/writer/instructions.md": "Draft the copy you are asked for.\n",
        "agent/subagents/writer/tools/gather.ts": GATHER_TOOL,
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

      const first = (await response.result()).events;
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
      const second = (await (await session.send("Make them shorter.")).result()).events;
      expect(resultOf(second, "notes-send-1")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(second).at(-1)).toContain(
        `receipt: Sent to task ${taskId}, which is now working on it. Use task_wait for its result.`,
      );
      expect(second).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ callId: "notes-send-1", taskId }),
          type: "task.started",
        }),
      );
      expect(settledFor(second, taskId!)).toEqual([
        expect.objectContaining({
          callId: "notes-send-1",
          output: "notes(0.67)>shorter",
          status: "completed",
        }),
      ]);
      expect(replies(second).at(-1)).toContain("notes(0.67)>shorter");

      // A send the body answers by returning ends the task with that result.
      const third = (await (await session.send("Publish them.")).result()).events;
      expect(settledFor(third, taskId!)).toEqual([
        expect.objectContaining({
          callId: "notes-send-2",
          output: "published notes(0.67)>shorter",
          status: "completed",
        }),
      ]);
      expect(replies(third).at(-1)).toContain("published notes(0.67)>shorter");

      // The ended task takes no more input.
      const fourth = (await (await session.send("One more tweak, please.")).result()).events;
      expect(resultOf(fourth, "notes-send-3")).toMatchObject({
        isError: true,
        output: { code: "UNKNOWN_TASK" },
      });
      expect(replies(fourth).at(-1)).toMatch(/^Refused: /u);
      expect(settledFor(fourth, taskId!)).toEqual([]);
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

      const first = (await response.result()).events;
      const taskId = (resultOf(first, "writer-start")?.output as { readonly taskId?: string })
        ?.taskId;
      expect(taskId).toMatch(/^writer-[0-9a-z]{6}$/u);
      expect(replies(first).at(-1)).toContain("Draft 1: Draft the launch post.");

      // Idle: the send is the agent's next piece of work, in the same child session.
      const second = (await (await session.send("Add a title to it.")).result()).events;
      expect(resultOf(second, "writer-send-1")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(second).at(-1)).toContain("Draft 2: Add a title.");

      // Working: the pricing page gathers for a while, so the turn holds.
      const third = (await (await session.send("Now write the pricing page.")).result()).events;
      expect(resultOf(third, "writer-send-2")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(third).at(-1)).toBe("Started the pricing page.");
      expect(types(third).slice(-2)).toEqual(["turn.completed", "session.waiting"]);

      // A correction joins the running work and brings the output schema its result takes.
      const fourth = (await (await session.send("Make the pricing page structured.")).result())
        .events;
      expect(resultOf(fourth, "writer-send-3")).toMatchObject({
        output: { status: "working", taskId },
      });
      expect(replies(fourth).at(-1)).toBe("Sent the format.");

      const later = await collectUntil(session.stream(), (events) =>
        replies(events).some((reply) => reply.startsWith("Structured: ")),
      );
      expect(settledFor([...fourth, ...later], taskId!)).toEqual([
        expect.objectContaining({
          output: { messages: 4, title: "Orbit pricing" },
          status: "completed",
        }),
      ]);
      expect(replies(later).at(-1)).toContain("Orbit pricing");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
