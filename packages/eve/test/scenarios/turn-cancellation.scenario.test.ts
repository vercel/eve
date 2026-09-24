import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { type MessageStreamEvent, isCurrentTurnBoundaryEvent } from "../../src/protocol/message.js";
import { createEveSessionCancelRoutePath } from "../../src/protocol/routes.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const EVENT_TIMEOUT_MS = 30_000;
const REMOTE_TOKEN = "layer-3-scenario-token";

const REMOTE_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: { zod: "^4.3.6" },
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage }) =>
    lastUserMessage?.includes("wait-for-cancel") === true
      ? { toolCalls: [{ name: "wait-for-cancel", input: {} }] }
      : "cancelled",
  ),
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${REMOTE_TOKEN}") return null;
    return {
      attributes: {},
      authenticator: "scenario-bearer",
      principalId: "cancellation-parent",
      principalType: "service",
    };
  },
});
`,
    "agent/instructions.md": "Call explicitly requested tools.\n",
    "agent/tools/wait-for-cancel.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Wait until the current turn is cancelled.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(ctx.abortSignal.reason);
      if (ctx.abortSignal.aborted) return abort();
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
    });
  },
});
`,
  },
  installDependencies: true,
  name: "remote-cancellation-child",
};

function createParentDescriptor(
  remoteUrl: string,
  options: { readonly sessionInputLimit?: number } = {},
): ScenarioAppDescriptor {
  return {
    dependencies: { zod: "^4.3.6" },
    files: {
      "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const message = request.lastUserMessage ?? "";
  if (message.includes("Use workflow exactly once")) {
    // The program runs as a detached task; the turn waits on it with task_wait.
    const receipt = request.toolResults.find((result) => result.name === "workflow");
    if (request.toolResults.some((result) => result.name === "task_wait")) return "waited";
    if (receipt !== undefined) {
      const taskId = /Started task ([\\w-]+)\\./u.exec(String(receipt.output))?.[1];
      return { toolCalls: [{ name: "task_wait", input: { taskId } }] };
    }
    const localOnly = message.includes("local-sleeper only");
    return {
      toolCalls: [
        {
          name: "workflow",
          input: {
            js: localOnly
              ? 'return await ctx.agent("local-sleeper", { message: "Use wait-for-cancel." });'
              : 'return await Promise.all([ctx.agent("local-sleeper", { message: "Use wait-for-cancel." }), ctx.agent("remote-sleeper", { message: "Use wait-for-cancel." })]);',
          },
        },
      ],
    };
  }
  return "still-alive";
});

export default defineAgent({
  ${options.sessionInputLimit === undefined ? "" : `limits: { maxInputTokensPerSession: ${String(options.sessionInputLimit)} },`}
  model,
  modelContextWindowTokens: 32_000,
});
`,
      "agent/instructions.md": "Delegate cancellation waits as requested.\n",
      "agent/tools/workflow.ts": `import { workflow } from "eve/tools/workflow";

export default workflow();
`,
      "agent/subagents/local-sleeper/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Runs the wait-for-cancel tool and waits for cancellation.",
  model: mockModel(({ lastUserMessage }) =>
    lastUserMessage?.includes("wait-for-cancel") === true
      ? { toolCalls: [{ name: "wait-for-cancel", input: {} }] }
      : "cancelled",
  ),
  modelContextWindowTokens: 32_000,
});
`,
      "agent/subagents/local-sleeper/instructions.md":
        "Call wait-for-cancel immediately and do nothing else.\n",
      "agent/subagents/local-sleeper/tools/wait-for-cancel.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Wait until the current turn is cancelled.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(ctx.abortSignal.reason);
      if (ctx.abortSignal.aborted) return abort();
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
    });
  },
});
`,
      "agent/subagents/remote-sleeper.ts": `import { defineRemoteAgent } from "eve";
import { bearer } from "eve/agents/auth";

export default defineRemoteAgent({
  auth: bearer("${REMOTE_TOKEN}"),
  description: "Runs the wait-for-cancel tool and waits for cancellation.",
  url: ${JSON.stringify(remoteUrl)},
});
`,
    },
    installDependencies: true,
    name: "mixed-cancellation-parent",
  };
}

describe("turn cancellation descendant cascade", () => {
  it(
    "cancels racing local and authenticated remote children then continues the parent",
    async () => {
      const remoteApp = await scenarioApp(REMOTE_DESCRIPTOR);
      const remoteServer = await startEveDev(remoteApp.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });

      try {
        const parentApp = await scenarioApp(createParentDescriptor(remoteServer.url));
        const parentServer = await startEveDev(parentApp.appRoot, {
          env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
        });

        try {
          const parentClient = new Client({ host: parentServer.url });
          const { session: parentSession, response } = await parentClient.sessions.create({
            message: [
              "Use workflow exactly once to call local-sleeper and remote-sleeper in parallel.",
              'Pass both the message "Use wait-for-cancel." and return Promise.all of their results.',
            ].join("\n"),
          });
          const parentIterator = response[Symbol.asyncIterator]();
          const started = await readTaskStarts({
            count: 2,
            iterator: parentIterator,
            label: "local and remote subagent dispatch",
          });
          const agents = started.filter((event) => event.data.kind === "agent");
          const localChild = agents.find((event) => event.data.child?.remote === undefined)?.data;
          const remoteChild = agents.find((event) => event.data.child?.remote !== undefined)?.data;
          if (localChild?.child === undefined || remoteChild?.child === undefined) {
            throw new Error("Expected one local and one remote task.started event.");
          }
          const workflowCall = started.find((event) => event.data.kind === "workflow")?.data;
          if (workflowCall === undefined) {
            throw new Error("Expected a task.started event for the workflow tool call.");
          }
          expect(remoteChild.child.remote?.url).toBe(remoteServer.url);

          const localIterator = parentClient.sessions
            .attach(localChild.child.sessionId)
            .stream()
            [Symbol.asyncIterator]();

          const remoteClient = new Client({
            auth: { bearer: REMOTE_TOKEN },
            host: remoteServer.url,
          });
          const remoteIterator = remoteClient.sessions
            .attach(remoteChild.child.sessionId)
            .stream()
            [Symbol.asyncIterator]();
          await Promise.all([
            readUntil({
              iterator: localIterator,
              label: "local wait-for-cancel tool call",
              matches: isWaitForCancelToolCall,
            }),
            readUntil({
              iterator: remoteIterator,
              label: "remote wait-for-cancel tool call",
              matches: isWaitForCancelToolCall,
            }),
          ]);

          // A plain cancel stops the turn and every working task: the detached program and
          // the agent calls it awaits.
          const cancelResponse = await parentClient.fetch(
            createEveSessionCancelRoutePath(response.sessionId),
            { method: "POST" },
          );
          expect(cancelResponse.status).toBe(202);
          await expect(cancelResponse.json()).resolves.toMatchObject({
            ok: true,
            sessionId: response.sessionId,
            status: "accepted",
          });

          const [localEvents, remoteEvents] = await Promise.all([
            readThroughBoundary({
              iterator: localIterator,
              label: "local cancellation boundary",
            }),
            readThroughBoundary({
              iterator: remoteIterator,
              label: "remote cancellation boundary",
            }),
          ]);
          const parentEvents = await readThroughBoundary({
            iterator: parentIterator,
            label: "parent cancellation boundary",
          });

          expectCancellationBoundary(localEvents);
          expectCancellationBoundary(remoteEvents);
          expectCancellationBoundary(parentEvents);
          // The owner cancels the workflow tool call and its agent calls before the turn ends,
          // and reports each once; the children's confirmations and the cancelled run's
          // unwinding add nothing later.
          const cancelledTasks = [
            `${localChild.taskId}:cancelled`,
            `${remoteChild.taskId}:cancelled`,
            `${workflowCall.taskId}:cancelled`,
          ].sort();
          const settled = (events: readonly MessageStreamEvent[]) =>
            events
              .flatMap((event) =>
                event.type === "task.settled" ? [`${event.data.taskId}:${event.data.status}`] : [],
              )
              .sort();
          const boundary = parentEvents.findIndex((event) => event.type === "turn.cancelled");
          expect(settled(parentEvents.slice(0, boundary))).toEqual(cancelledTasks);
          expect(settled(parentEvents.slice(boundary))).toEqual([]);

          const followUp = await (
            await parentSession.send("Reply with the exact string `still-alive` and nothing else.")
          ).result();
          expect(followUp.sessionId).toBe(response.sessionId);
          expect(followUp.status).toBe("waiting");
          expect(followUp.message, JSON.stringify(followUp.events)).toBe("still-alive");
          expect(followUp.events.some((event) => event.type === "turn.cancelled")).toBe(false);
          expect(settled(followUp.events)).toEqual([]);
        } catch (error) {
          throw new Error(
            [
              `parent stdout:\n${parentServer.stdout()}`,
              `parent stderr:\n${parentServer.stderr()}`,
              `remote stdout:\n${remoteServer.stdout()}`,
              `remote stderr:\n${remoteServer.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        } finally {
          await parentServer.stop();
        }
      } finally {
        await remoteServer.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "declines the root continuation after a generated child inherits zero input quota",
    async () => {
      const parentApp = await scenarioApp(
        createParentDescriptor("http://127.0.0.1:1", { sessionInputLimit: 1 }),
      );
      const parentServer = await startEveDev(parentApp.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });

      try {
        const parentClient = new Client({ host: parentServer.url });
        const { session, response } = await parentClient.sessions.create({
          message:
            "Use workflow exactly once to call local-sleeper only with message Use wait-for-cancel.",
        });
        const events = await readThroughBoundary({
          iterator: response[Symbol.asyncIterator](),
          label: "root session-limit prompt",
        });
        const requests = events.flatMap((event) =>
          event.type === "input.requested" ? event.data.requests : [],
        );
        expect(requests).toHaveLength(1);
        // The detached program's agent call can start after the root's prompt.
        await readUntil({
          iterator: session.stream({ startIndex: 0 })[Symbol.asyncIterator](),
          label: "generated child dispatch",
          matches: isAgentTaskStart,
        });
        expect(requests[0]?.requestId.startsWith(`${response.sessionId}:limit:`)).toBe(true);

        const requestId = requests[0]?.requestId;
        if (requestId === undefined) throw new Error("Root limit prompt has no request id.");
        const declined = await (await session.respond([{ optionId: "stop", requestId }])).result();
        expect(declined.status).toBe("waiting");
        expectCancellationBoundary(declined.events);
        expect(declined.events.some((event) => event.type === "task.started")).toBe(false);
        const all: MessageStreamEvent[] = [];
        for await (const event of session.stream({ follow: false, startIndex: 0 })) all.push(event);
        expect(all.filter(isAgentTaskStart)).toHaveLength(1);
      } catch (error) {
        throw new Error(
          [
            `parent stdout:\n${parentServer.stdout()}`,
            `parent stderr:\n${parentServer.stderr()}`,
          ].join("\n\n"),
          { cause: error },
        );
      } finally {
        await parentServer.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

type TaskStartedEvent = Extract<MessageStreamEvent, { type: "task.started" }>;

async function readTaskStarts(input: {
  readonly count: number;
  readonly iterator: AsyncIterator<MessageStreamEvent>;
  readonly label: string;
}): Promise<readonly TaskStartedEvent[]> {
  return await withinEventDeadline(
    (async () => {
      const events: TaskStartedEvent[] = [];
      // The `workflow` tool call is a task too; only its agent calls are counted.
      while (events.filter((event) => event.data.kind === "agent").length < input.count) {
        const next = await input.iterator.next();
        if (next.done) throw new Error(`Stream ended before ${input.label}.`);
        if (next.value.type === "task.started") events.push(next.value);
      }
      return events;
    })(),
    input.label,
  );
}

function isAgentTaskStart(event: MessageStreamEvent): boolean {
  return event.type === "task.started" && event.data.kind === "agent";
}

function isWaitForCancelToolCall(event: MessageStreamEvent): boolean {
  return (
    event.type === "actions.requested" &&
    event.data.actions.some(
      (action) => action.kind === "tool-call" && action.toolName === "wait-for-cancel",
    )
  );
}

async function readUntil(input: {
  readonly iterator: AsyncIterator<MessageStreamEvent>;
  readonly label: string;
  readonly matches: (event: MessageStreamEvent) => boolean;
}): Promise<{ readonly event: MessageStreamEvent }> {
  return await withinEventDeadline(
    (async () => {
      while (true) {
        const next = await input.iterator.next();
        if (next.done) throw new Error(`Stream ended before ${input.label}.`);
        if (input.matches(next.value)) return { event: next.value };
      }
    })(),
    input.label,
  );
}

async function readThroughBoundary(input: {
  readonly iterator: AsyncIterator<MessageStreamEvent>;
  readonly label: string;
}): Promise<readonly MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  await withinEventDeadline(
    (async () => {
      while (true) {
        const next = await input.iterator.next();
        if (next.done) throw new Error(`Stream ended before ${input.label}.`);
        events.push(next.value);
        if (isCurrentTurnBoundaryEvent(next.value)) return;
      }
    })(),
    input.label,
  );
  if (input.iterator.return !== undefined) {
    await withinEventDeadline(
      input.iterator.return(undefined),
      `${input.label} stream cancellation`,
    );
  }
  return events;
}

function expectCancellationBoundary(events: readonly MessageStreamEvent[]): void {
  const types = events.map((event) => event.type);
  expect(types).toContain("turn.cancelled");
  expect(types.at(-1)).toBe("session.waiting");
  expect(types).not.toContain("step.failed");
  expect(types).not.toContain("turn.failed");
  expect(types).not.toContain("session.failed");
}

async function withinEventDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          EVENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
