import { expect, it, vi } from "vitest";

import { textStreamResult } from "#internal/testing/approval-resume.js";
import { alice, ofType, probe, recorded } from "#internal/testing/session-host/probe.js";
import {
  createStoreEngine,
  type StoreEngineOptions,
} from "#internal/testing/session-host/store-engine.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const CALLBACK_BASE_URL = "http://store-wakes.in-process";

async function withStoreEngine(
  name: string,
  options: StoreEngineOptions & { readonly sessionTimeoutMs?: number },
  body: (engine: ReturnType<typeof createStoreEngine>) => Promise<void>,
): Promise<void> {
  const { sessionTimeoutMs, ...engineOptions } = options;
  const agent = await probe({
    name,
    respond: () => textStreamResult("Noted."),
    ...(sessionTimeoutMs !== undefined && { sessionTimeoutMs }),
  });
  await agent.test.run(async () => {
    const engine = createStoreEngine(
      { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
      { callbackBaseUrl: CALLBACK_BASE_URL, ...engineOptions },
    );
    try {
      await body(engine);
    } finally {
      await engine.dispose();
    }
  });
}

it("ends a parked session whose timeout wake fires before the deadline", async () => {
  await withStoreEngine(
    "store-wakes-early",
    { sessionTimeoutMs: 200, wakeEarlyMs: 5 },
    async ({ durable, idle, runtime }) => {
      const { sessionId } = await (
        await alice(runtime, "store-wakes-early:alice").send("Alice leaves a note.", {
          auth: null,
        })
      ).result();
      await vi.waitFor(async () => expect(await durable.status(sessionId)).toBe("ended"), {
        interval: 20,
        timeout: 5_000,
      });
      await idle();
      expect(
        ofType(await recorded(runtime, sessionId), "session.ended").map(
          (event) => event.data.outcome,
        ),
      ).toEqual(["completed"]);
    },
  );
});

it("runs a message that arrives while the run parks, when the engine drops the wake", async () => {
  await withStoreEngine(
    "store-wakes-held",
    { heldWakes: "drop" },
    async ({ durable, idle, runtime, store }) => {
      const thread = alice(runtime, "store-wakes-held:alice");
      const { sessionId } = await (
        await thread.send("Alice asks for a summary.", { auth: null })
      ).result();
      await idle();
      const setStatus = store.setStatus;
      let sent = false;
      store.setStatus = async (id, status) => {
        await setStatus(id, status);
        if (status !== "parked" || sent) return;
        sent = true;
        await thread.send("Bob adds a question.", { auth: null });
      };
      await thread.send("Alice asks a follow-up.", { auth: null });
      await vi.waitFor(
        async () =>
          expect(ofType(await recorded(runtime, sessionId), "turn.settled")).toHaveLength(3),
        { interval: 20, timeout: 5_000 },
      );
      await idle();
      expect(await durable.status(sessionId)).toBe("parked");
    },
  );
});

it("ends a session whose timeout passes while the run parks, when the engine drops the wake", async () => {
  await withStoreEngine(
    "store-wakes-due",
    { heldWakes: "drop", sessionTimeoutMs: 60_000 },
    async ({ advanceClock, durable, runtime, store }) => {
      const setStatus = store.setStatus;
      let advanced = false;
      store.setStatus = async (id, status) => {
        await setStatus(id, status);
        if (status !== "parked" || advanced) return;
        advanced = true;
        advanceClock(60_000);
      };
      const { sessionId } = await (
        await alice(runtime, "store-wakes-due:alice").send("Alice leaves a note.", { auth: null })
      ).result();
      await vi.waitFor(async () => expect(await durable.status(sessionId)).toBe("ended"), {
        interval: 20,
        timeout: 5_000,
      });
    },
  );
});

it("runs a message that arrives while the run asks for its timed wake, when the engine drops the wake", async () => {
  let sent = false;
  let send: (() => Promise<void>) | undefined;
  await withStoreEngine(
    "store-wakes-timed",
    {
      heldWakes: "drop",
      beforeTimedWake: async () => {
        if (sent || send === undefined) return;
        sent = true;
        await send();
      },
    },
    async ({ idle, runtime }) => {
      const thread = alice(runtime, "store-wakes-timed:alice");
      send = async () => {
        await thread.send("Bob adds a question.", { auth: null });
      };
      const { sessionId } = await (
        await thread.send("Alice asks for a summary.", { auth: null })
      ).result();
      await vi.waitFor(
        async () =>
          expect(ofType(await recorded(runtime, sessionId), "turn.settled")).toHaveLength(2),
        { interval: 20, timeout: 5_000 },
      );
      await idle();
      expect(sent).toBe(true);
    },
  );
});
