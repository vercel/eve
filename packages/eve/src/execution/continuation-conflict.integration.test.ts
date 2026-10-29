import type { AnyEventRequest } from "@workflow/world";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import type { DeliverHookPayload, SessionCommand } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";

// A run that loses its continuation to an owner forwards what it was created with, and what it
// accepted before its hooks were gone, to that owner. These drive both runs on a real World.

vi.setConfig({ testTimeout: 90_000 });

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const BOB = { ...ALICE, principalId: "bob" };

type Seen = readonly [kind: string, text: string, turnId: string, principalId: unknown];

interface Race {
  /** What the owner consumed and settled, with the turn and the turn's principal. */
  readonly seen: Seen[];
  /** Lets Alice's first turn finish its model call. */
  readonly releaseAlice: () => void;
  /** Starts a run that loses the continuation, and waits for it to finish forwarding. */
  readonly lose: (input: {
    /** Who created the losing run. */
    readonly by: typeof ALICE;
    readonly command: Extract<SessionCommand, { readonly kind: "send" }>;
    /** Accepted by the losing run after it claims its own inbox, before it learns it lost. */
    readonly caught: readonly (DeliverHookPayload | SessionCommand)[];
  }) => Promise<void>;
  /** Fails the owner's acceptance of the forward whose text is this, once. */
  readonly failForwardOnce: (text: string) => void;
  /** How many forwards the owner refused. */
  readonly failedForwards: () => number;
  /** The owner's received inputs, as text. */
  readonly received: () => readonly string[];
}

/** Event data as text, with serialized payload bytes decoded. */
function readable(data: unknown): string {
  return JSON.stringify(data, (_key, value: unknown) =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
  );
}

async function withRace(name: string, body: (race: Race) => Promise<void>) {
  const seen: Seen[] = [];
  let releaseAlice!: () => void;
  const aliceGate = new Promise<void>((resolve) => (releaseAlice = resolve));
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (call) => {
        if (JSON.stringify(call.prompt).includes("alice asks")) await aliceGate;
        return textStreamResult("ok");
      },
      modelId: name,
      provider: "eve-test",
    }),
  );
  const textOf = (parts: readonly { kind: string; text?: string }[]) =>
    parts.find((part) => part.kind === "text")?.text ?? "";
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "delivery.consumed"(event, ctx) {
                seen.push([
                  "consumed",
                  textOf(event.data.parts),
                  event.data.turnId,
                  ctx.session.auth.current?.principalId,
                ]);
              },
              "turn.settled"(event, ctx) {
                seen.push([
                  "settled",
                  "",
                  event.data.turnId,
                  ctx.session.auth.current?.principalId,
                ]);
              },
            },
          }),
        }),
        logicalPath: "hooks/observe.ts",
      },
    ],
  });
  const continuationToken = `http:${name}`;
  await runtime.run(async () => {
    const world = await getWorld();
    const createBatch = world.events.createBatch;
    world.events.createBatch = undefined;
    const create = world.events.create.bind(world.events);
    let failing: string | undefined;
    let failedForwards = 0;
    const received: string[] = [];
    let ownerRunId: string | undefined;
    let pendingCaught: readonly (DeliverHookPayload | SessionCommand)[] = [];
    const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      const [runId, event] = args as [string, AnyEventRequest];
      if (
        failing !== undefined &&
        runId === ownerRunId &&
        event.eventType === "hook_received" &&
        readable(event.eventData).includes(failing)
      ) {
        failing = undefined;
        failedForwards += 1;
        throw new Error("The owner's inbox is unavailable");
      }
      const created = await create(...args);
      if (runId === ownerRunId && event.eventType === "hook_received")
        received.push(readable(event.eventData));
      const ownInbox = sessionInboxHookToken(sessionCommandHookToken(runId));
      if (
        runId !== ownerRunId &&
        event.eventType === "hook_created" &&
        (event.eventData as { token?: string }).token === ownInbox
      ) {
        const caught = pendingCaught;
        pendingCaught = [];
        for (const payload of caught) await resumeHook(ownInbox, payload);
      }
      return created;
    });

    const owner = await startSessionOwner(workflowEntry, [
      {
        input: { message: "alice asks" },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken,
        }),
      },
    ]);
    ownerRunId = owner.runId;
    try {
      await vi.waitFor(
        () => expect(seen).toContainEqual(["consumed", "alice asks", "turn_0", "alice"]),
        {
          timeout: 30_000,
        },
      );
      await body({
        failForwardOnce: (text) => void (failing = text),
        failedForwards: () => failedForwards,
        received: () => received,
        async lose({ by, command, caught }) {
          pendingCaught = caught;
          const loser = await startSessionOwner(workflowEntry, [
            {
              continuationConflictCommand: command,
              idempotencyKey: `op_${name}`,
              input: command.payload,
              kind: "initial",
              ownerDeploymentId: "dpl_inline",
              serializedContext: buildSerializedContext({
                auth: by,
                channelKind: "http",
                continuationToken,
              }),
            },
          ]);
          await loser.returnValue;
        },
        releaseAlice,
        seen,
      });
    } finally {
      releaseAlice();
      await owner.cancel().catch(() => {});
      spy.mockRestore();
      world.events.createBatch = createBatch;
    }
  });
}

const delivery = () => createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" });

describe("a run that loses its continuation", () => {
  it("forwards without repeating what the owner accepted when a later forward fails", async () => {
    await withRace("continuation-conflict-retry", async (race) => {
      race.failForwardOnce("second");
      await race.lose({
        by: ALICE,
        caught: [
          { auth: ALICE, delivery: delivery(), kind: "send", payload: { message: "second" } },
          { auth: ALICE, delivery: delivery(), kind: "send", payload: { message: "third" } },
        ],
        command: { auth: ALICE, delivery: delivery(), kind: "send", payload: { message: "first" } },
      });
      race.releaseAlice();
      await vi.waitFor(
        () =>
          expect(
            race.seen.filter(([kind, text]) => kind === "consumed" && text === "third"),
          ).toHaveLength(1),
        { timeout: 30_000 },
      );
      expect(race.failedForwards()).toBe(1);
      for (const text of ["first", "second", "third"]) {
        expect(
          race.received().filter((data) => data.includes(text)),
          text,
        ).toHaveLength(1);
        expect(
          race.seen.filter(([kind, consumed]) => kind === "consumed" && consumed === text),
          text,
        ).toHaveLength(1);
      }
    });
  });

  it("keeps another principal's forwarded messages out of the owner's active turn", async () => {
    await withRace("continuation-conflict-principal", async (race) => {
      await race.lose({
        by: BOB,
        caught: [
          {
            auth: BOB,
            deliveryMetadata: [{ ...delivery(), payloadIndex: 0 }],
            kind: "deliver",
            payloads: [{ message: "bob delivers" }],
          },
        ],
        command: {
          auth: BOB,
          delivery: delivery(),
          kind: "send",
          payload: { message: "bob sends" },
        },
      });
      // Both of Bob's messages are with the owner while Alice's turn is still running.
      expect(race.seen).toEqual([["consumed", "alice asks", "turn_0", "alice"]]);
      race.releaseAlice();
      await vi.waitFor(
        () => expect(race.seen.filter(([kind]) => kind === "settled")).toHaveLength(2),
        { timeout: 30_000 },
      );
      expect(race.seen).toEqual([
        ["consumed", "alice asks", "turn_0", "alice"],
        ["settled", "", "turn_0", "alice"],
        ["consumed", "bob sends", "turn_1", "bob"],
        ["consumed", "bob delivers", "turn_1", "bob"],
        ["settled", "", "turn_1", "bob"],
      ]);
    });
  });
});
