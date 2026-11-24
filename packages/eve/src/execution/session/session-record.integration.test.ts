import { describe, expect, it, vi } from "vitest";

import { createSession } from "#channel/session.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";
import {
  createStoreEngine,
  type StoreEngine,
} from "#internal/testing/session-host/store-engine.js";
import { alice, ofType, probe, recorded } from "#internal/testing/session-host/probe.js";
import type { ProbeOptions } from "#internal/testing/session-host/probe.js";

vi.setConfig({ testTimeout: 60_000 });

interface Gate {
  opened: boolean;
  started: PromiseWithResolvers<void>;
}

async function eachRecord(
  options: Omit<ProbeOptions, "respond"> & {
    readonly respond: (gate: Gate) => ProbeOptions["respond"];
  },
  scenario: (engine: StoreEngine, thread: string, gate: Gate) => Promise<void>,
): Promise<void> {
  let gate: Gate = { opened: false, started: Promise.withResolvers() };
  const agent = await probe({
    ...options,
    respond: (prompt, call, signal) => options.respond(gate)(prompt, call, signal),
  });
  await agent.test.run(async () => {
    const run = async (crashAt: number | undefined): Promise<number> => {
      gate = { opened: false, started: Promise.withResolvers() };
      const engine = createStoreEngine(
        { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
        { deliveries: "batched", stepBoundary: workflowStepBoundary },
      );
      try {
        engine.crashOnRecord((count) => count === crashAt);
        await scenario(engine, `${options.name}:${crashAt ?? "whole"}`, gate);
        return engine.records();
      } finally {
        await engine.dispose();
      }
    };
    const records = await run(undefined);
    expect(records).toBeGreaterThan(1);
    for (let crashAt = 1; crashAt <= records; crashAt++) await run(crashAt);
  });
}

describe("a session continued from its record", () => {
  it("settles a cancelled turn when the process stops before the cancel settles", async () => {
    await eachRecord(
      {
        name: "record-cancel",
        respond: (gate) => async (_prompt, _call, signal) => {
          if (gate.opened) return textStreamResult("Here is the summary, Alice.");
          gate.opened = true;
          gate.started.resolve();
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
          throw signal?.reason;
        },
      },
      async ({ runtime, idle }, token, gate) => {
        const thread = alice(runtime, token);
        const asked = await thread.send("Alice asks for the long report.", { auth: null });
        await gate.started.promise;
        await createSession(asked.sessionId, runtime).cancel({ auth: null });
        await idle();
        const next = await (
          await thread.send("Alice asks for a summary instead.", { auth: null })
        ).result();
        expect(next).toMatchObject({ sessionId: asked.sessionId, status: "completed" });
        const settled = ofType(await recorded(runtime, asked.sessionId), "turn.settled");
        expect(settled.map(({ data }) => data.outcome)).toEqual(["cancelled", "completed"]);
      },
    );
  });

  it("answers a keyed delivery sent while a turn runs when the process stops", async () => {
    await eachRecord(
      {
        name: "record-queued",
        respond: (gate) => async (prompt) => {
          if (!gate.opened) {
            gate.opened = true;
            gate.started.resolve();
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return textStreamResult(
            prompt.includes("Alice adds a reminder.") ? "Reminder noted, Alice." : "Noted, Alice.",
          );
        },
      },
      async ({ runtime, idle }, token, gate) => {
        const thread = alice(runtime, token);
        const opened = await thread.send("Alice opens her notes.", {
          auth: null,
          idempotencyKey: `${token}:open`,
        });
        await gate.started.promise;
        await thread.send("Alice adds a reminder.", {
          auth: null,
          idempotencyKey: `${token}:remind`,
        });
        await idle();
        const events = await recorded(runtime, opened.sessionId);
        expect(JSON.stringify(events)).toContain("Reminder noted, Alice.");
        expect(ofType(events, "turn.settled").map(({ data }) => data.outcome)).not.toContain(
          "failed",
        );
      },
    );
  });
});
