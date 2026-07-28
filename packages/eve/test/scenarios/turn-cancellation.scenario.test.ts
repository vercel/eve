import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import {
  type HandleMessageStreamEvent,
  isCurrentTurnBoundaryEvent,
} from "../../src/protocol/message.js";
import { createEveCancelTurnRoutePath } from "../../src/protocol/routes.js";
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

export default defineAgent({ model: "openai/gpt-5.4-mini" });
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

function createParentDescriptor(remoteUrl: string): ScenarioAppDescriptor {
  return {
    dependencies: { zod: "^4.3.6" },
    files: {
      "agent/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4-mini" });
`,
      "agent/instructions.md": "Delegate cancellation waits as requested.\n",
      "agent/subagents/local-sleeper/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({
  description: "Runs the wait-for-cancel tool and waits for cancellation.",
  model: "openai/gpt-5.4-mini",
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
      const remoteServer = await startEveDev(remoteApp.appRoot);

      try {
        const parentApp = await scenarioApp(createParentDescriptor(remoteServer.url));
        const parentServer = await startEveDev(parentApp.appRoot);

        try {
          const parentClient = new Client({ host: parentServer.url });
          const parentSession = parentClient.session();
          const response = await parentSession.send(
            [
              "Call tools in parallel: local-sleeper, remote-sleeper",
              'message: "Use wait-for-cancel."',
            ].join("\n"),
          );
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

          const localIterator = parentClient
            .session({ sessionId: localCalled.data.childSessionId, streamIndex: 0 })
            .stream()
            [Symbol.asyncIterator]();

          const remoteClient = new Client({
            auth: { bearer: REMOTE_TOKEN },
            host: remoteServer.url,
          });
          const remoteIterator = remoteClient
            .session({ sessionId: remoteCalled.data.childSessionId, streamIndex: 0 })
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
            createEveCancelTurnRoutePath(response.sessionId),
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
          expect(followUp.message).toBe("still-alive");
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
});

type SubagentCalledEvent = Extract<HandleMessageStreamEvent, { type: "subagent.called" }>;

async function readSubagentCalls(input: {
  readonly count: number;
  readonly iterator: AsyncIterator<HandleMessageStreamEvent>;
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

function isWaitForCancelToolCall(event: HandleMessageStreamEvent): boolean {
  return (
    event.type === "actions.requested" &&
    event.data.actions.some(
      (action) => action.kind === "tool-call" && action.toolName === "wait-for-cancel",
    )
  );
}

async function readUntil(input: {
  readonly iterator: AsyncIterator<HandleMessageStreamEvent>;
  readonly label: string;
  readonly matches: (event: HandleMessageStreamEvent) => boolean;
}): Promise<{ readonly event: HandleMessageStreamEvent }> {
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
  readonly iterator: AsyncIterator<HandleMessageStreamEvent>;
  readonly label: string;
}): Promise<readonly HandleMessageStreamEvent[]> {
  const events: HandleMessageStreamEvent[] = [];
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

function expectCancellationBoundary(events: readonly HandleMessageStreamEvent[]): void {
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
