import { describe, expect, it } from "vitest";

import { withMemoryQueue } from "#execution/world/memory-queue.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { activationLoop, type ActorProgram } from "./activation-loop.js";
import type { ActivationOutcome } from "./actors.js";
import { worldActors } from "./world/world-actors.js";

// The activation loop with a program of its own, on a World in this process with a queue: what
// any actor kind gets from it, a World host's sessions aside.

const kind = {
  kind: "looped",
  queueNamespace: "evelooped",
  streamNamespace: "eve-looped",
  workflowName: "eve/looped",
};

const until = async (condition: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Runs `test` with actors whose activations run `program`, observing each outcome. */
async function withLoop(
  program: Parameters<typeof activationLoop>[0],
  test: (input: {
    readonly actors: ReturnType<typeof worldActors>;
    readonly outcomes: ActivationOutcome[];
  }) => Promise<void>,
  budgetMs = 10_000,
) {
  const world = withMemoryQueue(memoryWorld());
  const actors = worldActors(world, kind);
  const outcomes: ActivationOutcome[] = [];
  const consumer = actors.activation!.consumer(
    activationLoop(program, { holdForTimerMs: 200, settleMs: 20 }),
    { budgetMs, observe: ({ outcome }) => outcomes.push(outcome) },
  );
  await consumer.serve();
  try {
    await test({ actors, outcomes });
  } finally {
    await world.close();
  }
}

describe("the activation loop", () => {
  it("resumes, hands each message over once, and stops when its program waits", async () => {
    const taken: unknown[] = [];
    let resumed = 0;
    await withLoop(
      async (actor): Promise<ActorProgram> => ({
        async resume() {
          resumed += 1;
        },
        async deliver(message) {
          taken.push(message.body);
          await actor.append([{ kind: "test.took", value: message.body }], {
            consumedThrough: message.id,
          });
        },
        quiescent: async () => true,
        nextTimer: () => undefined,
        drain: async () => {},
        stop: async () => ({ ended: false }),
      }),
      async ({ actors, outcomes }) => {
        const key = actors.newKey();
        await actors.create(key, { meta: {} });
        await actors.send({ key }, "a");
        await actors.send({ key }, "b");
        await until(() => taken.length === 2 && outcomes.length >= 1);
        expect(taken).toEqual(["a", "b"]);
        expect(outcomes.every((outcome) => outcome.kind === "idle")).toBe(true);
        expect(resumed).toBe(outcomes.length);
      },
    );
  });

  it("isn't activated again by the wake of a message an activation already took", async () => {
    const taken: unknown[] = [];
    let activations = 0;
    await withLoop(
      async (actor): Promise<ActorProgram> => {
        activations += 1;
        return {
          resume: async () => {},
          async deliver(message) {
            taken.push(message.body);
            await actor.append([{ kind: "test.took", value: message.body }], {
              consumedThrough: message.id,
            });
          },
          quiescent: async () => true,
          nextTimer: () => undefined,
          drain: async () => {},
          stop: async () => ({ ended: false }),
        };
      },
      async ({ actors, outcomes }) => {
        const key = actors.newKey();
        await actors.create(key, { meta: {} });
        await actors.send({ key }, "a");
        await until(() => taken.length === 1 && outcomes.length === activations);
        const before = activations;
        // A wake that comes late, as one an activation already read the message of does: the
        // log is as the last activation left it, so nothing activates.
        await actors.activation!.wake(key);
        await actors.activation!.wake(key);
        await until(() => false, 100).catch(() => {});
        expect(activations).toBe(before);
        // A message sent since does.
        await actors.send({ key }, "b");
        await until(() => taken.length === 2 && outcomes.length === activations);
        expect(activations).toBe(before + 1);
        expect(taken).toEqual(["a", "b"]);
      },
    );
  });

  it("sets its program's timer as the alarm, and is activated again for it", async () => {
    let activations = 0;
    let due = 0;
    await withLoop(
      async (): Promise<ActorProgram> => {
        activations += 1;
        if (activations === 1) due = Date.now() + 1_000;
        return {
          resume: async () => {},
          deliver: async () => {},
          quiescent: async () => true,
          nextTimer: () => (activations === 1 ? due : undefined),
          drain: async () => {},
          stop: async () => ({ ended: false }),
        };
      },
      async ({ actors, outcomes }) => {
        const key = actors.newKey();
        await actors.create(key, { meta: {} });
        await actors.activation!.wake(key);
        await until(() => activations === 2 && outcomes.length === 2);
        expect(outcomes[0]).toEqual({ alarm: due, kind: "idle" });
        expect(outcomes[1]).toEqual({ kind: "idle" });
      },
    );
  });

  it("drains near its deadline and continues in the next delivery", async () => {
    let activations = 0;
    let drained = 0;
    await withLoop(
      async (): Promise<ActorProgram> => {
        activations += 1;
        const busyUntil = activations === 1 ? Number.POSITIVE_INFINITY : 0;
        return {
          resume: async () => {},
          deliver: async () => {},
          quiescent: async () => Date.now() >= busyUntil,
          nextTimer: () => undefined,
          async drain() {
            drained += 1;
          },
          stop: async () => ({ ended: false }),
        };
      },
      async ({ actors, outcomes }) => {
        const key = actors.newKey();
        await actors.create(key, { meta: {} });
        await actors.activation!.wake(key);
        await until(() => outcomes.length >= 2);
        expect(outcomes.slice(0, 2)).toEqual([{ kind: "continue" }, { kind: "idle" }]);
        expect(drained).toBe(1);
      },
      150,
    );
  });

  it("ends its actor when its program is done for good, freeing its aliases", async () => {
    await withLoop(
      async (): Promise<ActorProgram> => ({
        resume: async () => {},
        deliver: async () => {},
        quiescent: async () => true,
        nextTimer: () => undefined,
        drain: async () => {},
        stop: async () => ({ ended: true }),
      }),
      async ({ actors, outcomes }) => {
        const key = actors.newKey();
        await actors.create(key, { aliases: ["looped-alias"], meta: {} });
        await actors.activation!.wake(key);
        await until(() => outcomes.length === 1);
        await until(() => false, 50).catch(() => {});
        expect(await actors.lookup("looped-alias")).toBeUndefined();
      },
    );
  });
});
