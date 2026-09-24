import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const RESULT_TIMEOUT_MS = 90_000;
/** How long the grandchild waits before it writes its marker, unless it was stopped. */
const GRANDCHILD_SLEEP_MS = 12_000;

/** Collects events from a stream until `done` holds or the timeout passes. */
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
          setTimeout(() => reject(new Error("Timed out waiting for the stream.")), remaining),
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

type TaskStarted = Extract<MessageStreamEvent, { readonly type: "task.started" }>;
type TaskSettled = Extract<MessageStreamEvent, { readonly type: "task.settled" }>;

function startedTask(events: readonly MessageStreamEvent[], name: string): TaskStarted | undefined {
  return events.find(
    (event): event is TaskStarted => event.type === "task.started" && event.data.name === name,
  );
}

function settledTask(
  events: readonly MessageStreamEvent[],
  taskId: string,
): TaskSettled | undefined {
  return events.find(
    (event): event is TaskSettled => event.type === "task.settled" && event.data.taskId === taskId,
  );
}

describe("session end", () => {
  it(
    "stops a grandchild's work when the root session ends",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ toolResults }) => {
    if (toolResults.length === 0) {
      return {
        toolCalls: [{ name: "writer", input: { background: true, message: "Draft the note." } }],
      };
    }
    return "Started the draft.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Delegate writing to the writer.\n",
          "agent/subagents/writer/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Drafts notes.",
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Draft ready.";
    if (toolResults.length === 0) return { toolCalls: [{ name: "slow_note", input: {} }] };
    return "Waiting on the note.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/subagents/writer/instructions.md": "Write the note in the background.\n",
          "agent/subagents/writer/lib/marker.ts": `import { writeFile } from "node:fs/promises";

export async function writeMarker(): Promise<void> {
  "use step";
  await writeFile(process.env.EVE_SCENARIO_GRANDCHILD_MARKER!, "written");
}
`,
          "agent/subagents/writer/tools/slow_note.ts": `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";
import { writeMarker } from "../lib/marker.ts";

export default defineWorkflowTool({
  description: "Write a note after a delay.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    "use workflow";
    await sleep(${String(GRANDCHILD_SLEEP_MS)});
    if (ctx.abortSignal.aborted) return { stopped: true };
    await writeMarker();
    return { written: true };
  },
});
`,
        },
        installDependencies: true,
        name: "session-end-cascade",
      });
      const marker = join(app.appRoot, ".grandchild-marker");
      const server = await startEveDev(app.appRoot, {
        env: {
          EVE_MOCK_AUTHORED_MODELS: "",
          EVE_SCENARIO_GRANDCHILD_MARKER: marker,
          NODE_ENV: "production",
        },
      });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({
          message: "Draft the note, no rush.",
        });
        await response.result();

        // A background child reports task.started on its own, possibly after the turn ended.
        const root = await collectUntil(
          session.stream(),
          (events) => startedTask(events, "writer") !== undefined,
        );
        const writer = startedTask(root, "writer")!;

        // The writer's turn waits on its slow note.
        const writerStream = session.streamSubagent(writer);
        const beforeEnd = await collectUntil(
          writerStream,
          (events) => startedTask(events, "slow_note") !== undefined,
        );
        const note = startedTask(beforeEnd, "slow_note")!;
        const noteStartedAt = Date.now();

        await session.reset();

        // The writer ends its own session, which cancels its task before it can write.
        const writerEvents = await collectUntil(
          session.streamSubagent(writer),
          (events) => settledTask(events, note.data.taskId) !== undefined,
        );
        expect(settledTask(writerEvents, note.data.taskId)?.data).toMatchObject({
          status: "cancelled",
          taskId: note.data.taskId,
        });

        // Past the note's sleep, a grandchild that was not stopped would have written its marker.
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, noteStartedAt + GRANDCHILD_SLEEP_MS + 8_000 - Date.now()),
          ),
        );
        expect(existsSync(marker)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "ends an idle child's own idle agents when the root session ends",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ toolResults }) => {
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "writer", input: { message: "Draft the note." } }] };
    }
    return "Draft ready.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Delegate writing to the writer.\n",
          "agent/subagents/writer/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Drafts notes.",
  model: mockModel(({ toolResults }) => {
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "helper", input: { message: "Gather the notes." } }] };
    }
    return "Draft with notes.";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/subagents/writer/instructions.md": "Ask the helper for notes, then draft.\n",
          "agent/subagents/writer/subagents/helper/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Gathers notes.",
  model: mockModel(() => "Notes gathered."),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/subagents/writer/subagents/helper/instructions.md": "Gather notes.\n",
        },
        installDependencies: true,
        name: "session-end-idle-cascade",
      });
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const client = new Client({ host: server.url });
        const { session, response } = await client.sessions.create({ message: "Draft the note." });
        const first = await response.result();
        const writer = startedTask(first.events, "writer")!;
        expect(first.events).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ message: "Draft ready." }),
            type: "message.completed",
          }),
        );

        // Both agents answered, so each is idle in its own parked session.
        const writerTurn = await collectUntil(session.streamSubagent(writer), (events) => {
          const helper = startedTask(events, "helper");
          return helper !== undefined && settledTask(events, helper.data.taskId) !== undefined;
        });
        const helper = startedTask(writerTurn, "helper")!;

        await session.reset();

        // The writer ends its own session, and its finalization ends the helper's.
        const ended = (events: readonly MessageStreamEvent[]) =>
          events.some((event) => event.type === "session.completed");
        expect(ended(await collectUntil(session.streamSubagent(writer), ended))).toBe(true);
        expect(ended(await collectUntil(session.streamSubagent(helper), ended))).toBe(true);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
