import { expect, it, vi } from "vitest";

import { textStreamResult } from "#internal/testing/approval-resume.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowStepBoundary } from "#execution/workflow-host/step-boundary.js";
import { createStoreEngine } from "#internal/testing/session-host/store-engine.js";
import { SESSION_LIMITS, storeDurable } from "#platform/engine.js";
import { sessionRuntime } from "#execution/session-runtime.js";
import { builtInHosts } from "#runtime/app.js";
import {
  alice,
  ofType,
  probe,
  recorded,
  violations,
} from "#internal/testing/session-host/probe.js";

vi.setConfig({ testTimeout: 60_000 });

it("yields a turn before its deadline, and its next attempt closes the first one's lines and finishes it", async () => {
  const agent = await probe({
    name: "turn-deadline",
    respond: async (_prompt, call) => {
      if (call === 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
      return textStreamResult(call === 1 ? "Too late, Alice." : "Noted, Alice.");
    },
  });
  await agent.test.run(async () => {
    const engine = createStoreEngine(
      { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
      { deadlineMs: 400, deliveries: "batched", stepBoundary: workflowStepBoundary },
    );
    try {
      const result = await (
        await alice(engine.runtime, "turn-deadline").send("Alice asks for a note.", { auth: null })
      ).result();
      expect(result).toMatchObject({ reply: "Noted, Alice.", status: "completed" });
      await engine.idle();
      const events = await recorded(engine.runtime, result.sessionId);
      expect(ofType(events, "model.requested")).toHaveLength(2);
      expect(ofType(events, "turn.settled").map(({ data }) => data.outcome)).toEqual(["completed"]);
      expect(JSON.stringify(events)).not.toContain("Too late, Alice.");
      expect(await violations(engine.runtime, result.sessionId)).toEqual([]);
    } finally {
      await engine.dispose();
    }
  });
  expect(agent.prompts).toHaveLength(2);
});

it("aborts the model call of a turn that yields at its deadline before its next attempt runs", async () => {
  let firstSignal: AbortSignal | undefined;
  let abortedBeforeRetry: boolean | undefined;
  const agent = await probe({
    name: "turn-deadline-abort",
    respond: async (_prompt, call, signal) => {
      if (call === 1) {
        firstSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return textStreamResult("Too late, Alice.");
      }
      abortedBeforeRetry = firstSignal?.aborted;
      return textStreamResult("Noted, Alice.");
    },
  });
  await agent.test.run(async () => {
    const engine = createStoreEngine(
      { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
      { deadlineMs: 400, deliveries: "batched", stepBoundary: workflowStepBoundary },
    );
    try {
      const result = await (
        await alice(engine.runtime, "turn-deadline-abort").send("Alice asks for a note.", {
          auth: null,
        })
      ).result();
      expect(result).toMatchObject({ reply: "Noted, Alice.", status: "completed" });
      await engine.idle();
    } finally {
      await engine.dispose();
    }
  });
  expect(firstSignal).toBeDefined();
  expect(abortedBeforeRetry).toBe(true);
});

it("serves a message that another replica writes to the store while the run waits for a time", async () => {
  const agent = await probe({
    events: {
      async "turn.started"(_event, ctx) {
        await ctx.getSandbox();
      },
    },
    name: "store-replica",
    respond: (_prompt, call) => textStreamResult(call === 1 ? "Noted, Alice." : "Done, Bob."),
    sandboxIdle: { idleTimeoutMs: 3_600_000 },
  });
  await agent.test.run(async () => {
    const config = { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() };
    const engine = createStoreEngine(config, {
      deliveries: "batched",
      stepBoundary: workflowStepBoundary,
    });
    try {
      const first = await (
        await alice(engine.runtime, "store-replica").send("Alice opens the notes.", { auth: null })
      ).result();
      await vi.waitFor(
        async () => expect(await engine.durable.status(first.sessionId)).toBe("running"),
        { interval: 20, timeout: 5_000 },
      );
      const replica = storeDurable({ store: engine.store, wake: async () => {} });
      const replicaRuntime = sessionRuntime(replica.durable, builtInHosts(), config);
      const sent = await alice(replicaRuntime, "store-replica").send("Bob asks for a summary.", {
        auth: null,
      });
      const next = await Promise.race([
        sent.result(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("The run did not see the replica's message.")), 8_000),
        ),
      ]);
      expect(next).toMatchObject({ reply: "Done, Bob.", sessionId: first.sessionId });
    } finally {
      await engine.dispose();
    }
  });
});

it("keeps the record of a session whose history is over the record limit in the content store", async () => {
  const notes = "Alice's quarterly notes. ".repeat(12_000);
  const agent = await probe({
    name: "record-content",
    respond: () => textStreamResult("Noted, Alice."),
  });
  await agent.test.run(async () => {
    const engine = createStoreEngine(
      { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
      { deliveries: "batched", stepBoundary: workflowStepBoundary, outOfLine: true },
    );
    try {
      const result = await (
        await alice(engine.runtime, "record-content").send(notes, { auth: null })
      ).result();
      expect(result).toMatchObject({ reply: "Noted, Alice.", status: "completed" });
      await engine.idle();
      expect(await engine.durable.status(result.sessionId)).toBe("parked");
      const next = await (
        await alice(engine.runtime, "record-content").send("Alice asks for a summary.", {
          auth: null,
        })
      ).result();
      expect(next).toMatchObject({ reply: "Noted, Alice.", sessionId: result.sessionId });
    } finally {
      await engine.dispose();
    }
  });
});

it.each([
  {
    stored: true,
    title:
      "keeps a turn's large history out of line in the content store, and deletes it when the session ends",
  },
  {
    stored: false,
    title: "keeps a turn's large history inline in its step result without a content store",
  },
])("$title", async ({ stored }) => {
  const notes = "Alice's quarterly notes. ".repeat(2_000);
  const agent = await probe({
    name: "turn-content",
    respond: () => textStreamResult("Noted, Alice."),
  });
  await agent.test.run(async () => {
    const engine = createStoreEngine(
      { compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource() },
      {
        deliveries: "batched",
        stepBoundary: workflowStepBoundary,
        outOfLine: stored,
      },
    );
    try {
      const result = await (
        await alice(engine.runtime, `turn-content:${stored}`).send(notes, { auth: null })
      ).result();
      expect(result).toMatchObject({ reply: "Noted, Alice.", status: "completed" });
      await engine.idle();
      const { content } = engine.store;
      if (stored) {
        expect(engine.largestStepResult()).toBeLessThan(SESSION_LIMITS.stepResultBytes / 8);
        expect(content.size(result.sessionId)).toBeGreaterThan(0);
      } else {
        expect(engine.largestStepResult()).toBeGreaterThan(notes.length);
      }
      await engine.runtime.dispatchSession({
        command: { deliveryId: "end", kind: "reset" },
        sessionId: result.sessionId,
      });
      await engine.idle();
      expect(content.size(result.sessionId)).toBe(0);
    } finally {
      await engine.dispose();
    }
  });
  expect(agent.prompts.at(-1)).toContain("Alice's quarterly notes.");
});
