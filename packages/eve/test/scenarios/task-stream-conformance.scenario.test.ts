import { readFile, writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { ClientSession, MessageResponse } from "../../src/client/index.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  isCurrentTurnBoundaryEvent,
  type MessageStreamEvent,
} from "../../src/protocol/message.js";
import { TASK_PROTOCOL_VERSION } from "../../src/tasks/protocol.js";
import {
  materializeScenarioApp,
  type ScenarioApp,
  type ScenarioAppDescriptor,
} from "../../src/internal/testing/scenario-app.js";
import {
  deriveTaskStreamStates,
  findVolatileStrings,
  normalizeTaskStream,
  parseTaskStream,
  projectTaskStream,
  serializeTaskStream,
  TASK_STREAM_FIXTURE_VERSION,
  TASK_STREAM_MANIFEST_KEYS,
  type TaskStreamFixture,
  type TaskStreamFixtureManifest,
} from "../../src/internal/testing/task-stream-fixtures.js";
import { startEveDev, type RunningEveDev } from "./dev-server-harness.js";

// Records the published task stream fixtures from real runs of two eve
// deployments with scripted mock models, and fails when a fresh recording
// no longer matches them. Regenerate with EVE_UPDATE_TASK_STREAM_FIXTURES=1.

const FIXTURE_DIR = new URL(
  `../../conformance/task-streams/v${TASK_STREAM_FIXTURE_VERSION}/`,
  import.meta.url,
);
const MANIFEST_URL = new URL("manifest.json", FIXTURE_DIR);
const UPDATE = process.env.EVE_UPDATE_TASK_STREAM_FIXTURES === "1";
const SETUP_TIMEOUT_MS = 480_000;
const FIXTURE_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 120_000;
const ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };
const REMOTE_TOKEN = "task-stream-fixtures-token";

/** Published fixtures, in manifest order. */
const FIXTURE_NAMES = [
  "foreground-agent-call",
  "background-agent-call",
  "detach-on-steer",
  "task-cancel",
  "agent-timed-out",
  "remote-agent-input-request",
] as const;

const MESSAGES = {
  background: "Draft the Orbit launch post, no rush.",
  cancel: "Remind me about the design review in ten minutes.",
  cancelFollowUp: "Actually, cancel that reminder.",
  detach: "Check the d0 and sre dashboards.",
  detachSteer: "Also check the Plain queue, please.",
  foreground: "Ask the researcher about the Orbit launch.",
  remote: "Refund order 42 through billing.",
  timeout: "Ask the auditor to review the Q3 ledger.",
} as const;

const REPLIES = {
  background: "The launch post draft is ready.",
  cancel: "Cancelled the reminder.",
  detach: "d0 and sre are both healthy.",
  foreground: "The researcher found three sources.",
  remote: "Billing refunded order 42.",
  timeout: "The auditor did not finish in time.",
} as const;

const USAGE = "const usage = { inputTokens: 100, outputTokens: 10 };";

const PARENT_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

${USAGE}
const reply = (text) => ({ text, usage });
const call = (...calls) => ({ toolCalls: calls.map(([id, name, input]) => ({ id, name, input })), usage });
const M = ${JSON.stringify(MESSAGES)};
const R = ${JSON.stringify(REPLIES)};

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults, userMessages }) => {
    const latest = lastUserMessage ?? "";
    const result = (id) => toolResults.find((candidate) => candidate.id === id);
    const delivered = latest.startsWith("<task_result");
    switch (userMessages[0]) {
      case M.foreground:
        return result("research-call")
          ? reply(R.foreground)
          : call(["research-call", "researcher", { message: "Summarize the coverage of the Orbit launch." }]);
      case M.background:
        if (delivered) return reply(R.background);
        return result("draft-call")
          ? reply("Started the draft; I will share it when it is ready.")
          : call(["draft-call", "writer", { background: true, message: "Draft the Orbit launch post." }]);
      case M.detach:
        if (delivered) return reply(R.detach);
        if (latest === M.detachSteer) return reply("Checking the Plain queue now; d0 and sre moved to the background.");
        return call(
          ["d0-call", "lookup", { seconds: 6, source: "d0" }],
          ["sre-call", "lookup", { seconds: 12, source: "sre" }],
        );
      case M.cancel:
        if (latest === M.cancelFollowUp) {
          if (result("cancel-call")) return reply(R.cancel);
          const taskId = /remind-[0-9a-z]{6}/u.exec(JSON.stringify(result("review-call")?.output))?.[0];
          return call(["cancel-call", "task_cancel", { taskId }]);
        }
        return result("review-call")
          ? reply("I will remind you in ten minutes.")
          : call(["review-call", "remind", { note: "Design review.", seconds: 600 }]);
      case M.timeout:
        return result("audit-call")
          ? reply(R.timeout)
          : call(["audit-call", "auditor", { message: "Review the Q3 ledger." }]);
      case M.remote:
        return result("refund-call")
          ? reply(R.remote)
          : call(["refund-call", "billing", { message: "Refund order 42." }]);
      default:
        return reply("Unexpected: " + latest);
    }
  }),
  modelContextWindowTokens: 32_000,
});
`;

function subagentSource(input: {
  readonly description: string;
  readonly respond: string;
  readonly timeout?: number;
}): string {
  return `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

${USAGE}

export default defineAgent({
  description: ${JSON.stringify(input.description)},
  model: mockModel(${input.respond}),
  modelContextWindowTokens: 32_000,${input.timeout === undefined ? "" : `\n  timeout: ${String(input.timeout)},`}
});
`;
}

function sleepingToolSource(input: {
  readonly description: string;
  readonly inputSchema: string;
  readonly seconds: string;
  readonly result: string;
}): string {
  return `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: ${JSON.stringify(input.description)},
  inputSchema: ${input.inputSchema},
  async execute(input) {
    "use workflow";
    await sleep(${input.seconds} * 1000);
    return ${input.result};
  },
});
`;
}

const REMOTE_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

${USAGE}

export default defineAgent({
  model: mockModel(({ toolResults }) =>
    toolResults.some((result) => result.id === "billing-refund-call")
      ? { text: "Refunded order 42.", usage }
      : { toolCalls: [{ id: "billing-refund-call", name: "refund", input: { orderId: "42" } }], usage },
  ),
  modelContextWindowTokens: 32_000,
});
`;

interface Recording {
  readonly description: string;
  readonly events: readonly MessageStreamEvent[];
  readonly sessionId: string;
}

describe("published task stream fixtures", () => {
  let remote: RunningEveDev;
  let parent: RunningEveDev;
  let published: TaskStreamFixtureManifest | undefined;
  const apps: ScenarioApp[] = [];
  const updated = new Map<string, TaskStreamFixture>();
  const failures: string[] = [];

  beforeAll(async () => {
    if (!UPDATE) {
      published = JSON.parse(await readFile(MANIFEST_URL, "utf8")) as TaskStreamFixtureManifest;
    }
    const remoteApp = await materialize({
      dependencies: { zod: "^4.3.6" },
      files: {
        "agent/agent.ts": REMOTE_AGENT,
        "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${REMOTE_TOKEN}") return null;
    return { attributes: {}, authenticator: "fixture-bearer", principalId: "parent-app", principalType: "service" };
  },
});
`,
        "agent/instructions.md": "Handle billing requests.\n",
        "agent/tools/refund.ts": `import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund an order once a person approves it.",
  inputSchema: z.object({ orderId: z.string() }),
  approval: once(),
  async execute({ orderId }) {
    return { orderId, refunded: true };
  },
});
`,
      },
      installDependencies: true,
      name: "task-stream-billing",
    });
    remote = await startEveDev(remoteApp.appRoot, { env: ENV });

    const parentApp = await materialize({
      dependencies: { zod: "^4.3.6" },
      files: {
        "agent/agent.ts": PARENT_AGENT,
        "agent/channels/eve.ts": `import { none } from "eve/channels/auth";\nimport { eveChannel } from "eve/channels/eve";\n\nexport default eveChannel({ auth: none() });\n`,
        "agent/instructions.md": "Delegate work to the right agent or tool.\n",
        "agent/subagents/auditor/agent.ts": subagentSource({
          description: "Audits ledgers.",
          respond: `({ toolResults }) =>
    toolResults.length === 0
      ? { toolCalls: [{ id: "auditor-scan-call", name: "scan", input: {} }], usage }
      : { text: "Scanned.", usage }`,
          timeout: 3_000,
        }),
        "agent/subagents/auditor/instructions.md": "Scan the ledger, then report.\n",
        "agent/subagents/auditor/tools/scan.ts": sleepingToolSource({
          description: "Scan the ledger slowly.",
          inputSchema: "z.object({})",
          result: '"late"',
          seconds: "60",
        }),
        "agent/subagents/billing.ts": `import { defineRemoteAgent } from "eve";
import { bearer } from "eve/agents/auth";

export default defineRemoteAgent({
  auth: bearer(${JSON.stringify(REMOTE_TOKEN)}),
  description: "Handles billing requests.",
  url: ${JSON.stringify(remote.url)},
});
`,
        "agent/subagents/researcher/agent.ts": subagentSource({
          description: "Researches launch coverage.",
          respond: `() => ({ text: "Three sources cover the Orbit launch.", usage })`,
        }),
        "agent/subagents/researcher/instructions.md": "Answer from what you know.\n",
        "agent/subagents/writer/agent.ts": subagentSource({
          description: "Drafts launch posts.",
          respond: `({ toolResults }) =>
    toolResults.length === 0
      ? { toolCalls: [{ id: "writer-gather-call", name: "gather", input: {} }], usage }
      : { text: "Draft: Orbit ships today.", usage }`,
        }),
        "agent/subagents/writer/instructions.md": "Gather notes, then draft.\n",
        "agent/subagents/writer/tools/gather.ts": sleepingToolSource({
          description: "Gather the launch notes.",
          inputSchema: "z.object({})",
          result: '{ notes: "Orbit ships today." }',
          seconds: "6",
        }),
        "agent/tools/lookup.ts": sleepingToolSource({
          description: "Look up a dashboard.",
          inputSchema: "z.object({ seconds: z.number(), source: z.string() })",
          result: '{ source: input.source, status: "healthy" }',
          seconds: "input.seconds",
        }),
        "agent/tools/remind.ts": sleepingToolSource({
          description: "Remind the user after a delay.",
          inputSchema: "z.object({ note: z.string(), seconds: z.number() })",
          result: "{ reminder: input.note }",
          seconds: "input.seconds",
        }),
      },
      installDependencies: true,
      name: "task-stream-parent",
    });
    parent = await startEveDev(parentApp.appRoot, { env: ENV });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (failures.length > 0) {
      console.error(
        [
          `failed fixtures: ${failures.join(", ")}`,
          `parent stderr:\n${parent?.stderr()}`,
          `remote stderr:\n${remote?.stderr()}`,
        ].join("\n\n"),
      );
    }
    if (UPDATE && failures.length === 0 && updated.size === FIXTURE_NAMES.length) {
      const manifest: TaskStreamFixtureManifest = {
        description:
          "Session streams recorded from real eve runs with scripted mock models. Each file holds one session's events, one JSON object per line, exactly as session.stream() yields them, with run-specific IDs, timestamps, versions, and origins replaced by stable placeholders.",
        fixtureVersion: TASK_STREAM_FIXTURE_VERSION,
        fixtures: FIXTURE_NAMES.map((name) => updated.get(name)!),
        streamVersion: EVE_MESSAGE_STREAM_VERSION,
        taskProtocolVersion: TASK_PROTOCOL_VERSION,
      };
      await writeFile(
        MANIFEST_URL,
        `${JSON.stringify(manifest, [...TASK_STREAM_MANIFEST_KEYS], 2)}\n`,
      );
    }
    await parent?.stop();
    await remote?.stop();
    await Promise.all(apps.map((app) => app.cleanup().catch(() => {})));
  }, 120_000);

  async function materialize(descriptor: ScenarioAppDescriptor): Promise<ScenarioApp> {
    const app = await materializeScenarioApp(descriptor);
    apps.push(app);
    return app;
  }

  function fixture(
    name: (typeof FIXTURE_NAMES)[number],
    run: (client: Client) => Promise<Recording>,
  ): void {
    it(
      name,
      async () => {
        try {
          const recording = await run(new Client({ host: parent.url }));
          const events = normalizeTaskStream(recording.events, {
            origins: {
              [remote.url]: "https://billing.example",
              [parent.url]: "https://agent.example",
            },
            sessionId: recording.sessionId,
          });
          expect(findVolatileStrings(events)).toEqual([]);
          const entry: TaskStreamFixture = {
            description: recording.description,
            file: `${name}.ndjson`,
            name,
            sessionId: "session-root",
            tasks: deriveTaskStreamStates(events),
          };
          const file = new URL(entry.file, FIXTURE_DIR);
          if (UPDATE) {
            await writeFile(file, serializeTaskStream(events));
            updated.set(name, entry);
            return;
          }
          expect(published?.streamVersion).toBe(EVE_MESSAGE_STREAM_VERSION);
          expect(published?.taskProtocolVersion).toBe(TASK_PROTOCOL_VERSION);
          expect(published?.fixtures.find((candidate) => candidate.name === name)).toEqual(entry);
          const recorded = parseTaskStream(await readFile(file, "utf8"));
          expect(
            projectTaskStream(events),
            "The recording no longer matches the published fixture. Rerun with EVE_UPDATE_TASK_STREAM_FIXTURES=1, review the diff, and add a changeset.",
          ).toEqual(projectTaskStream(recorded));
        } catch (error) {
          failures.push(name);
          throw error;
        }
      },
      FIXTURE_TIMEOUT_MS,
    );
  }

  fixture("foreground-agent-call", async (client) => {
    const { session, response } = await client.sessions.create({ message: MESSAGES.foreground });
    await response.result();
    const events = await recordUntilReply(session, REPLIES.foreground);
    expect(deriveTaskStreamStates(events)).toMatchObject([
      { kind: "agent", mode: "foreground", name: "researcher", status: "completed" },
    ]);
    return {
      description:
        "A waited agent call: task.started with a local child, then task.settled completed; the answer is the call's tool result.",
      events,
      sessionId: session.state.sessionId,
    };
  });

  fixture("background-agent-call", async (client) => {
    const { session, response } = await client.sessions.create({ message: MESSAGES.background });
    await response.result();
    const events = await recordUntilReply(session, REPLIES.background);
    expect(deriveTaskStreamStates(events)).toMatchObject([
      { delivered: true, kind: "agent", mode: "background", name: "writer", status: "completed" },
    ]);
    return {
      description:
        "An agent call with background: true: the call returns a receipt, the turn ends, and the answer arrives later as a task.result input that starts a result turn. The child's task.started can land before or after the first turn ends.",
      events,
      sessionId: session.state.sessionId,
    };
  });

  fixture("detach-on-steer", async (client) => {
    const { session, response } = await client.sessions.create({ message: MESSAGES.detach });
    const turn = followTurn(response, (events) => count(events, "task.started") === 2);
    await turn.reached;
    await (await session.send(MESSAGES.detachSteer)).result();
    await turn.finished;
    const events = await recordUntilReply(session, REPLIES.detach);
    const tasks = deriveTaskStreamStates(events);
    expect(tasks).toMatchObject([
      { detached: "steer", kind: "workflow", mode: "foreground", status: "completed" },
      { detached: "steer", kind: "workflow", mode: "foreground", status: "completed" },
    ]);
    const deliveries = events.filter(
      (event) => event.type === "message.received" && event.data.kind === "task.result",
    );
    expect(deliveries).toHaveLength(1);
    return {
      description:
        "Two waited workflow tool calls detached by a steering message: task.detached with reason steer for each, receipts as their tool results, and both results delivered together in one task.result input.",
      events,
      sessionId: session.state.sessionId,
    };
  });

  fixture("task-cancel", async (client) => {
    const { session, response } = await client.sessions.create({ message: MESSAGES.cancel });
    const turn = followTurn(response, (events) => count(events, "task.started") === 1);
    await turn.reached;
    await (await session.send(MESSAGES.cancelFollowUp)).result();
    await turn.finished;
    const events = await recordUntilReply(session, REPLIES.cancel);
    expect(deriveTaskStreamStates(events)).toMatchObject([
      {
        delivered: false,
        detached: "steer",
        kind: "workflow",
        mode: "foreground",
        status: "cancelled",
      },
    ]);
    return {
      description:
        'A waited workflow tool call that a steering message moved to the background, then stopped by the model with task_cancel: the tool result is { status: "cancelled" }, task.settled reports cancelled, and no result is ever delivered.',
      events,
      sessionId: session.state.sessionId,
    };
  });

  fixture("agent-timed-out", async (client) => {
    const { session, response } = await client.sessions.create({ message: MESSAGES.timeout });
    await response.result();
    const events = await recordUntilReply(session, REPLIES.timeout);
    expect(deriveTaskStreamStates(events)).toMatchObject([
      { errorCode: "TIMED_OUT", kind: "agent", name: "auditor", status: "failed" },
    ]);
    return {
      description:
        "A waited agent call still working at its timeout: task.settled failed with error code TIMED_OUT, which is also the call's tool result.",
      events,
      sessionId: session.state.sessionId,
    };
  });

  fixture("remote-agent-input-request", async (client) => {
    const { session, response } = await client.sessions.create({ message: MESSAGES.remote });
    const first = await response.result();
    const asked = first.events.findLast((event) => event.type === "input.requested");
    if (asked?.type !== "input.requested") {
      throw new Error(`No input request; saw ${first.events.map((e) => e.type).join(", ")}`);
    }
    const request = asked.data.requests[0]!;
    const approve =
      request.options?.find((option) => /approve|allow|yes/iu.test(option.id))?.id ?? "approve";
    await (await session.respond([{ optionId: approve, requestId: request.requestId }])).result();
    const events = await recordUntilReply(session, REPLIES.remote);
    expect(deriveTaskStreamStates(events)).toMatchObject([
      { inputRequests: 1, kind: "agent", name: "billing", remote: true, status: "completed" },
    ]);
    return {
      description:
        "A waited call to a remote agent whose tool needs approval: task.started with child.remote, the approval proxied onto the caller's stream as input.requested with the call's taskId, the child's input.resolved once it takes the answer, then task.settled completed.",
      events,
      sessionId: session.state.sessionId,
    };
  });
});

/**
 * Follows the session from its first event until `reply` completes and the
 * session parks, then returns every event through the durable tail.
 */
async function recordUntilReply(
  session: ClientSession,
  reply: string,
): Promise<readonly MessageStreamEvent[]> {
  const iterator = session.stream({ startIndex: 0 })[Symbol.asyncIterator]();
  const seen: MessageStreamEvent[] = [];
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  try {
    while (!repliedAndParked(seen, reply)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out; saw ${seen.map((e) => e.type).join(", ")}`);
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for stream events.")), remaining),
        ),
      ]);
      if (next.done) break;
      seen.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  // Let anything the owner publishes after parking reach the durable tail.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return (await session.snapshot()).events;
}

function repliedAndParked(events: readonly MessageStreamEvent[], reply: string): boolean {
  const index = events.findLastIndex(
    (event) => event.type === "message.completed" && event.data.message === reply,
  );
  return index >= 0 && events.slice(index).some((event) => event.type === "session.waiting");
}

/**
 * Follows a turn's response to its boundary and resolves `reached` once
 * `ready` holds, so the test can steer while the turn still waits.
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
