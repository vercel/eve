import { describe, expect, it } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#context/session-context.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  buildSerializedContext,
  captureEvents,
  expectSingleTurn,
} from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import { startSessionOwner, waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";

const alice: SessionAuthContext = {
  attributes: { role: "member" },
  authenticator: "test-idp",
  issuer: "https://idp.example",
  principalId: "alice",
  principalType: "user",
};

/** Each differs from alice in one field of the principal tuple. */
const otherPrincipals: readonly [string, SessionAuthContext][] = [
  ["authenticator", { ...alice, authenticator: "other-idp" }],
  ["issuer", { ...alice, issuer: "https://other-idp.example" }],
  ["type", { ...alice, principalType: "service" }],
  ["id", { ...alice, principalId: "bob" }],
];

const START = "Use the hold_turn tool, then the record_auth tool.";
const STEER = "Now use the record_auth tool.";

describe("steering an active turn", () => {
  it.each(otherPrincipals)(
    "queues a message from a principal with another %s as the next turn",
    async (field, other) => {
      const harness = await createSteeringRuntime(`steer-other-${field}`);
      const continuationToken = `http:steer-other-${field}`;

      await harness.runtime.run(async () => {
        const run = await startRun(continuationToken);
        const stream = captureEvents(run);
        try {
          await harness.held;
          await sendMessage(run.runId, continuationToken, other, STEER);
          harness.release();

          const first = await stream.nextUntil("first turn", isSessionWaiting);
          expectSingleTurn(first, "turn_0");
          expect(receivedMessages(first)).toEqual([START]);
          expect(harness.recorded()).toEqual([{ auth: alice, turnId: "turn_0" }]);

          const second = await stream.nextUntil("queued turn", isSessionWaiting);
          expectSingleTurn(second, "turn_1");
          expect(receivedMessages(second)).toEqual([STEER]);
          expect(harness.recorded()).toEqual([
            { auth: alice, turnId: "turn_0" },
            { auth: other, turnId: "turn_1" },
          ]);
        } finally {
          stream.dispose();
          await run.cancel().catch(() => {});
        }
      });
    },
  );

  it("joins a message from the turn's own principal and runs it with the refreshed claims", async () => {
    const harness = await createSteeringRuntime("steer-same-principal");
    const continuationToken = "http:steer-same-principal";
    const refreshed: SessionAuthContext = { ...alice, attributes: { role: "admin" } };

    await harness.runtime.run(async () => {
      const run = await startRun(continuationToken);
      const stream = captureEvents(run);
      try {
        await harness.held;
        await sendMessage(run.runId, continuationToken, refreshed, STEER);
        harness.release();

        const turn = await stream.nextUntil("steered turn", isSessionWaiting);
        expectSingleTurn(turn, "turn_0");
        expect(receivedMessages(turn)).toEqual([START, STEER]);
        expect(harness.recorded()).toEqual([{ auth: refreshed, turnId: "turn_0" }]);
      } finally {
        stream.dispose();
        await run.cancel().catch(() => {});
      }
    });
  });
});

interface SteeringRuntime {
  /** Resolves once `hold_turn` is running, so the turn is active. */
  readonly held: Promise<void>;
  readonly recorded: () => readonly { auth: unknown; turnId: string }[];
  readonly release: () => void;
  readonly runtime: Awaited<ReturnType<typeof createTestRuntime>>;
}

/**
 * `hold_turn` keeps the first step running until released; `record_auth`
 * records the identity each turn runs as. The mock model chains them from the
 * first message, and calls `record_auth` alone for a message naming only it.
 */
async function createSteeringRuntime(agentName: string): Promise<SteeringRuntime> {
  const held = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const recorded: { auth: unknown; turnId: string }[] = [];
  const tools = [
    mockTool({
      name: "hold_turn",
      async execute() {
        held.resolve();
        await released.promise;
        return { stepKey: "held" };
      },
    }),
    mockTool({
      name: "record_auth",
      inputSchema: { additionalProperties: true, properties: {}, type: "object" },
      execute(_input, ctx: SessionContext) {
        recorded.push({ auth: ctx.session.auth.current, turnId: ctx.session.turn.id });
        return { recorded: true };
      },
    }),
  ];
  const runtime = await createTestRuntime({ agent: { name: agentName }, tools });
  for (const tool of tools) {
    const manifestTool = runtime.manifest.tools.find((entry) => entry.name === tool.name);
    if (manifestTool === undefined) throw new Error(`Missing ${tool.name} in the test manifest.`);
    runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
      default: { execute: tool.execute },
    };
  }
  return {
    held: held.promise,
    recorded: () => recorded,
    release: () => released.resolve(),
    runtime,
  };
}

async function startRun(continuationToken: string) {
  return await startSessionOwner(workflowEntry, [
    {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message: START },
      serializedContext: buildSerializedContext({
        auth: { ...alice },
        channelKind: "http",
        continuationToken,
      }),
    },
  ]);
}

async function sendMessage(
  runId: string,
  continuationToken: string,
  auth: SessionAuthContext,
  message: string,
): Promise<void> {
  const inbox = sessionInboxHookToken(continuationToken);
  await waitForHook({ runId }, { token: inbox });
  await resumeHook(inbox, { auth, kind: "send", payload: { message } });
}

function isSessionWaiting(event: MessageStreamEvent): boolean {
  return event.type === "session.waiting";
}

function receivedMessages(events: readonly MessageStreamEvent[]): unknown[] {
  return filterEventsByType(events, "message.received").map((event) => event.data.message);
}
