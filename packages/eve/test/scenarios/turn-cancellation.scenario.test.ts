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
          const called = await readSubagentCalls({
            count: 2,
            iterator: parentIterator,
            label: "local and remote subagent dispatch",
          });
          const localCalled = called.find((event) => event.data.remote === undefined);
          const remoteCalled = called.find((event) => event.data.remote !== undefined);
          if (localCalled === undefined || remoteCalled === undefined) {
            throw new Error("Expected one local and one remote subagent.called event.");
          }
          expect(remoteCalled.data.remote?.url).toBe(remoteServer.url);

          const localIterator = parentClient.sessions
            .attach(localCalled.data.childSessionId)
            .stream()
            [Symbol.asyncIterator]();

          const remoteClient = new Client({
            auth: { bearer: REMOTE_TOKEN },
            host: remoteServer.url,
          });
          const remoteIterator = remoteClient.sessions
            .attach(remoteCalled.data.childSessionId)
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
          expect(parentEvents.some((event) => event.type === "subagent.completed")).toBe(false);

          const followUp = await (
            await parentSession.send("Reply with the exact string `still-alive` and nothing else.")
          ).result();
          expect(followUp.sessionId).toBe(response.sessionId);
          expect(followUp.status).toBe("waiting");
          expect(followUp.message, JSON.stringify(followUp.events)).toBe("still-alive");
          expect(followUp.events.some((event) => event.type === "turn.cancelled")).toBe(false);
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
    "task_cancel preserves a remote child and its history after stopping nested work",
    async () => {
      const remoteApp = await scenarioApp({
        ...REMOTE_DESCRIPTOR,
        files: {
          ...REMOTE_DESCRIPTOR.files,
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, userMessages }) => {
    if (lastUserMessage?.includes("recall-history")) {
      return userMessages.some((message) => message.includes("history-marker-391"))
        ? "HISTORY_RETAINED history-marker-391" : "HISTORY_LOST";
    }
    return { toolCalls: [{ name: "workflow", input: {
      js: 'return await ctx.agent("nested-sleeper", { message: "Use wait-for-cancel." });',
    } }] };
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/channels/eve.ts": `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  async auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${REMOTE_TOKEN}") return null;
    if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
      const body = await request.clone().json();
      if (body.callback) console.log("CANCELLATION_CALLBACK " + JSON.stringify(body.callback));
    }
    return {
      attributes: {}, authenticator: "scenario-bearer",
      principalId: "cancellation-parent", principalType: "service",
    };
  },
});
`,
          "agent/tools/workflow.ts": createParentDescriptor("").files["agent/tools/workflow.ts"]!,
          "agent/subagents/nested-sleeper/agent.ts":
            createParentDescriptor("").files["agent/subagents/local-sleeper/agent.ts"]!,
          "agent/subagents/nested-sleeper/tools/wait-for-cancel.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Wait until the current turn is cancelled.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    console.log("NESTED_WORK_STARTED");
    return new Promise((_resolve, reject) => {
      const abort = () => {
        console.log("NESTED_WORK_ABORTED");
        reject(ctx.abortSignal.reason);
      };
      if (ctx.abortSignal.aborted) return abort();
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
    });
  },
});
`,
        },
      });
      const remoteServer = await startEveDev(remoteApp.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const parentDescriptor = createParentDescriptor(remoteServer.url);
        const parentApp = await scenarioApp({
          ...parentDescriptor,
          files: {
            ...parentDescriptor.files,
            "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    const command = lastUserMessage ?? "";
    const last = toolResults.at(-1);
    if (command === "start-remote") {
      return toolResults.some((result) => result.name === "remote-sleeper")
        ? "started"
        : { toolCalls: [{ name: "remote-sleeper", input: { message: "history-marker-391" } }] };
    }
    if (command.startsWith("cancel-task ")) {
      return last?.name === "task_cancel" ? "cancelled"
        : { toolCalls: [{ name: "task_cancel", input: { taskIds: [command.slice(12)] } }] };
    }
    if (command.startsWith("continue-agent ")) {
      return last?.name === "workflow" ? JSON.stringify(last.output)
        : { toolCalls: [{ name: "workflow", input: {
            js: 'return await ctx.agent("remote-sleeper", { agentId: '
              + JSON.stringify(command.slice(15)) + ', message: "recall-history" });',
          } }] };
    }
    return "still-alive";
  }),
  modelContextWindowTokens: 32_000,
});
`,
          },
        });
        const parentServer = await startEveDev(parentApp.appRoot, {
          env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
        });
        try {
          const parentClient = new Client({ host: parentServer.url });
          const { session, response } = await parentClient.sessions.create({
            message: "start-remote",
          });
          const started = await response.result();
          const receiptEvent = started.events.find(
            (event) =>
              event.type === "action.result" &&
              event.data.result.kind === "tool-result" &&
              event.data.result.toolName === "remote-sleeper",
          );
          if (receiptEvent?.type !== "action.result")
            throw new Error("Missing remote task receipt.");
          const receipt = receiptEvent.data.result.output as { agentId: string; taskId: string };
          expect(receipt).toMatchObject({
            agentId: expect.any(String),
            taskId: expect.any(String),
          });
          const parentIterator = session.stream({ startIndex: 0 })[Symbol.asyncIterator]();
          const [called] = await readSubagentCalls({
            count: 1,
            iterator: parentIterator,
            label: "remote dispatch",
          });
          await parentIterator.return?.();
          if (called === undefined) throw new Error("Missing remote child.");
          const remoteClient = new Client({
            auth: { bearer: REMOTE_TOKEN },
            host: remoteServer.url,
          });
          const child = remoteClient.sessions.attach(called.data.childSessionId);
          const childIterator = child.stream()[Symbol.asyncIterator]();
          const [nestedCalled] = await readSubagentCalls({
            count: 1,
            iterator: childIterator,
            label: "nested child dispatch",
          });
          if (nestedCalled === undefined) throw new Error("Missing nested child.");
          const nested = remoteClient.sessions.attach(nestedCalled.data.childSessionId);
          const nestedIterator = nested.stream()[Symbol.asyncIterator]();
          await readUntil({
            iterator: nestedIterator,
            label: "nested active work",
            matches: isWaitForCancelToolCall,
          });

          await expect
            .poll(remoteServer.stdout, { timeout: EVENT_TIMEOUT_MS })
            .toContain("NESTED_WORK_STARTED");

          const cancelled = await (await session.send(`cancel-task ${receipt.taskId}`)).result();
          expect(cancelled.message).toBe("cancelled");
          const [childEvents, nestedEvents] = await Promise.all([
            readThroughBoundary({ iterator: childIterator, label: "remote cancellation" }),
            readThroughBoundary({ iterator: nestedIterator, label: "nested cancellation" }),
          ]);
          expectCancellationBoundary(childEvents);
          expectCancellationBoundary(nestedEvents);

          await expect
            .poll(remoteServer.stdout, { timeout: EVENT_TIMEOUT_MS })
            .toContain("NESTED_WORK_ABORTED");

          const continued = await withinEventDeadline(
            (await session.send(`continue-agent ${receipt.agentId}`)).result(),
            "same remote child continuation after callback settlement",
          );
          expect(continued.message, JSON.stringify(continued.events)).toContain(
            "HISTORY_RETAINED history-marker-391",
          );
          const captured = remoteServer.stdout().match(/CANCELLATION_CALLBACK (\{[^\n]+\})/);
          if (captured?.[1] === undefined) throw new Error("Missing original callback metadata.");
          const callback = JSON.parse(captured[1]) as {
            url: string;
            callId: string;
            subagentName: string;
          };
          const acknowledgement = {
            callId: callback.callId,
            subagentName: callback.subagentName,
            kind: "turn.failed",
            error: {
              code: "SUBAGENT_EXECUTION_FAILED",
              message: "The agent invocation was cancelled.",
            },
            outcome: {
              kind: "parked",
              result: { kind: "cancelled" },
              usageDelta: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
          };
          for (let repetition = 0; repetition < 2; repetition += 1) {
            const late = await fetch(callback.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(acknowledgement),
            });
            expect(late.status).toBe(202);
          }
          const unrelatedFailure = await fetch(callback.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...acknowledgement,
              outcome: {
                ...acknowledgement.outcome,
                result: { kind: "failed", error: "Unrelated failure" },
              },
            }),
          });
          expect(unrelatedFailure.status).toBe(404);
          const alive = await (await session.send("check-parent")).result();
          expect(alive.message).toBe("still-alive");
          const finalChild = await child.snapshot();
          expect(finalChild.events.some((event) => event.type === "session.failed")).toBe(false);
          expect(JSON.stringify(finalChild.events)).toContain(
            "HISTORY_RETAINED history-marker-391",
          );
          expect(
            (await nested.snapshot()).events.filter((event) => event.type === "turn.started"),
          ).toHaveLength(1);
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
        const calls = events.filter((event) => event.type === "subagent.called");
        const requests = events.flatMap((event) =>
          event.type === "input.requested" ? event.data.requests : [],
        );
        expect(calls).toHaveLength(1);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.requestId.startsWith(`${response.sessionId}:limit:`)).toBe(true);

        const requestId = requests[0]?.requestId;
        if (requestId === undefined) throw new Error("Root limit prompt has no request id.");
        const declined = await (await session.respond([{ optionId: "stop", requestId }])).result();
        expect(declined.status).toBe("waiting");
        expectCancellationBoundary(declined.events);
        expect(declined.events.some((event) => event.type === "subagent.called")).toBe(false);
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

type SubagentCalledEvent = Extract<MessageStreamEvent, { type: "subagent.called" }>;

async function readSubagentCalls(input: {
  readonly count: number;
  readonly iterator: AsyncIterator<MessageStreamEvent>;
  readonly label: string;
}): Promise<readonly SubagentCalledEvent[]> {
  return await withinEventDeadline(
    (async () => {
      const events: SubagentCalledEvent[] = [];
      while (events.length < input.count) {
        const next = await input.iterator.next();
        if (next.done) throw new Error(`Stream ended before ${input.label}.`);
        if (next.value.type === "subagent.called") events.push(next.value);
      }
      return events;
    })(),
    input.label,
  );
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
