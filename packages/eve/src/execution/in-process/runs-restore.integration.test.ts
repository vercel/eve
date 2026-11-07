import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import { localTestWorld } from "#internal/testing/local-world.js";

import { defineDynamic } from "#dynamic/definition.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import {
  address,
  follow,
  dyingAfter,
  recorded,
  replies,
  throughJson,
  violations,
} from "#internal/testing/in-process-sessions.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

// A session's runs across a restore. Without the store that kept the sessions a run opened, the
// run is lost, and its call reports it may have partly run. With it, a subagent's run goes on: it
// reads again what its hooks received, reaches the child it opened, and the child's cut-off step
// runs once more. Either way the restored turn goes on waiting where it paused, with no model
// call before it hears from its runs.

const textOf = (prompt: unknown) => JSON.stringify(prompt);

/** An agent compiled around `model`, under `name`. */
function agentWith(model: MockLanguageModelV4, name: string) {
  return {
    definition: defineAgent({
      model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
    }),
    name,
  };
}

/** Something that waits until `release()`; `started` resolves once something waits on it. */
function gate() {
  let release: () => void = () => {};
  const open = new Promise<void>((resolve) => (release = resolve));
  let reached: () => void = () => {};
  const started = new Promise<void>((resolve) => (reached = resolve));
  return {
    release,
    started,
    async wait() {
      reached();
      await open;
    },
  };
}

/**
 * Alice's agent asks a copy of itself, with the `agent` tool, to summarize Bob's notes. The copy
 * answers once `child` lets it; the parent says it waits, then reports what came back.
 */
function bobsNotesModel(child: () => Promise<void>, answers: { readonly interrupted: string }) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const text = textOf(prompt);
        if (text.includes("Summarize Bob's notes") && !text.includes("Alice asks")) {
          await child();
          return textStreamResult("Bob's notes: ship on Friday.");
        }
        if (text.includes("may have partly run")) return textStreamResult(answers.interrupted);
        if (text.includes("ship on Friday"))
          return textStreamResult("Alice, the helper says to ship on Friday.");
        return prompt.some((message) => message.role === "tool")
          ? textStreamResult("Waiting on the helper.")
          : toolCallsStreamResult([
              {
                input: JSON.stringify({ message: "Summarize Bob's notes." }),
                toolCallId: "call-agent-0",
                toolName: "agent",
              },
            ]);
      },
      modelId: "in-process-restore-runs",
      provider: "eve-test",
    }),
  );
}

describe("in-process runs across a restore", () => {
  it("restores a parent whose subagent was mid-turn, and the task reports it may have partly run", async () => {
    const child = gate();
    const model = bobsNotesModel(() => child.wait(), {
      interrupted: "Alice, the helper was interrupted; I'll check its work.",
    });
    const test = await createTestRuntime({ agent: agentWith(model, "in-process-restore-run") });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const first = createInProcessRuntime({ compiledArtifactsSource });
      const sent = await address(first, "alice-restore-run").send("Alice asks a helper.", {
        auth: null,
      });
      await child.started;
      await follow(
        first,
        sent.sessionId,
        (seen) => seen.filter((event) => event.type === "model.settled").length === 2,
      );
      const snapshot = throughJson(await first.snapshot(sent.sessionId));
      expect(snapshot.open).toMatchObject({ at: "pause" });
      expect(snapshot.runs).toMatchObject([
        { children: [expect.any(String)], input: { callId: "call-agent-0", toolName: "agent" } },
      ]);
      // This process carries on; the snapshot doesn't see it.
      child.release();
      await follow(first, sent.sessionId, (seen) =>
        seen.some((event) => event.type === "turn.settled"),
      );
      await first.dispose();

      const second = createInProcessRuntime({ compiledArtifactsSource });
      try {
        await second.restore(snapshot);
        await follow(second, sent.sessionId, (seen) =>
          seen.some((event) => event.type === "turn.settled"),
        );
        const events = await recorded(second, sent.sessionId);
        expect(
          events.filter((event) => event.type === "call.settled").map((event) => event.data),
        ).toMatchObject([
          {
            callId: "call-agent-0",
            error: { message: expect.stringContaining("may have partly run") },
            outcome: "failed",
          },
        ]);
        // The restored turn goes on waiting where it paused, and its next model call reads the
        // task's result: no model call in between.
        expect(replies(events)).toEqual([
          "Waiting on the helper.",
          "Alice, the helper was interrupted; I'll check its work.",
        ]);
        await expect(violations(second, sent.sessionId)).resolves.toEqual([]);
      } finally {
        await second.dispose();
      }
    });
  }, 90_000);

  it("continues a parent and its mid-turn subagent from the store after a crash, and the parent reads the subagent's reply", async () => {
    const child = gate();
    let childCalls = 0;
    const model = bobsNotesModel(
      async () => {
        childCalls++;
        await child.wait();
      },
      { interrupted: "Alice, the helper was interrupted." },
    );
    const test = await createTestRuntime({ agent: agentWith(model, "in-process-restore-child") });
    const directory = mkdtempSync(join(tmpdir(), "eve-restore-child-"));
    try {
      await test.run(async () => {
        const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
        const world = localTestWorld(directory);
        const first = createInProcessRuntime({ compiledArtifactsSource }, { world });
        const sent = await address(first, "alice-restore-child").send("Alice asks a helper.", {
          auth: null,
        });
        await child.started;
        await follow(
          first,
          sent.sessionId,
          (seen) =>
            seen.some((event) => event.type === "child.opened") &&
            seen.filter((event) => event.type === "model.settled").length === 2,
        );
        await first.idle(sent.sessionId);
        // The process dies with the subagent's model call in flight: the store keeps nothing after.
        const stopping = first.dispose();
        child.release();
        await stopping;
        const saved = await createWorldSessionStore(world).load(sent.sessionId);
        expect(saved?.runs).toMatchObject([
          { children: [expect.any(String)], input: { callId: "call-agent-0", toolName: "agent" } },
        ]);
        const childId = saved?.runs?.[0]?.children[0];

        const second = createInProcessRuntime({ compiledArtifactsSource }, { world });
        try {
          // Only the parent is restored: its run goes on, and reaches the child the store kept.
          await second.restore(saved!);
          await follow(second, sent.sessionId, (seen) =>
            seen.some((event) => event.type === "turn.settled"),
          );
          const events = await recorded(second, sent.sessionId);
          expect(events.filter((event) => event.type === "child.opened")).toHaveLength(1);
          expect(
            events.filter((event) => event.type === "call.settled").map((event) => event.data),
          ).toMatchObject([{ callId: "call-agent-0", outcome: "completed" }]);
          expect(replies(events)).toEqual([
            "Waiting on the helper.",
            "Alice, the helper says to ship on Friday.",
          ]);
          // The child's cut-off step ran once more, in the restored process.
          expect(childCalls).toBe(2);
          expect(replies(await recorded(second, childId!))).toEqual([
            "Bob's notes: ship on Friday.",
          ]);
          await expect(violations(second, sent.sessionId)).resolves.toEqual([]);
          await expect(violations(second, childId!)).resolves.toEqual([]);
        } finally {
          await second.dispose();
        }
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 90_000);

  it("keeps what a subagent's run sends as the parent's input, so a crash while applying it loses none of it", async () => {
    let childCalls = 0;
    const model = bobsNotesModel(
      async () => {
        childCalls++;
      },
      { interrupted: "Alice, the helper was interrupted." },
    );
    const test = await createTestRuntime({ agent: agentWith(model, "in-process-reply-crash") });
    const directory = mkdtempSync(join(tmpdir(), "eve-reply-crash-"));
    try {
      await test.run(async () => {
        const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
        const kept = localTestWorld(directory);
        // The process dies once the parent's step that applies the run's first messages wrote
        // the child it opened. By then the child answered, and kept its answered turn, so the
        // run, going on in the next process, can't get that answer again: only the parent's
        // kept input has it.
        const dying = dyingAfter(kept, (line) => line.includes('"child.opened"'));
        const first = createInProcessRuntime({ compiledArtifactsSource }, { world: dying.world });
        const { sessionId } = await address(first, "alice-reply-crash").send(
          "Alice asks a helper.",
          { auth: null },
        );
        await dying.death;
        await first.dispose();
        const saved = await createWorldSessionStore(kept).load(sessionId);
        expect(saved!.inputs?.unread).toContainEqual(
          expect.objectContaining({ runMessage: expect.objectContaining({ kind: "reply" }) }),
        );

        const second = createInProcessRuntime({ compiledArtifactsSource }, { world: kept });
        try {
          await second.restore(saved!);
          await follow(second, sessionId, (seen) =>
            replies(seen).includes("Alice, the helper says to ship on Friday."),
          );
          await second.idle(sessionId);
          const events = await recorded(second, sessionId);
          // The step ran again with what it read and folded what it wrote, and the reply settled
          // the call with the subagent's answer.
          expect(events.filter((event) => event.type === "child.opened")).toHaveLength(1);
          expect(
            events.filter((event) => event.type === "call.settled").map((event) => event.data),
          ).toMatchObject([
            {
              callId: "call-agent-0",
              outcome: "completed",
              output: "Bob's notes: ship on Friday.",
            },
          ]);
          expect(replies(events)).toEqual([
            "Waiting on the helper.",
            "Alice, the helper says to ship on Friday.",
          ]);
          expect(childCalls).toBe(1);
          await expect(violations(second, sessionId)).resolves.toEqual([]);
          // Read by a step the store kept, the reply is no longer the parent's input.
          expect(
            ((await createWorldSessionStore(kept).load(sessionId))?.inputs?.unread ?? []).filter(
              (input) => "runMessage" in input && input.runMessage.kind === "reply",
            ),
          ).toEqual([]);
        } finally {
          await second.dispose();
        }
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 90_000);

  it("continues a subagent that had a follow-up after a crash, and the parent reads its answer to it", async () => {
    const followUp = gate();
    const childCalls = { bob: 0, carol: 0 };
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const text = textOf(prompt);
          if (text.includes("You are the subagent")) {
            if (!textOf(prompt.at(-1)).includes("Summarize Carol's notes")) {
              childCalls.bob++;
              return textStreamResult("Bob's notes: ship on Friday.");
            }
            childCalls.carol++;
            await followUp.wait();
            return textStreamResult("Carol's notes: hold until Monday.");
          }
          if (text.includes("hold until Monday"))
            return textStreamResult("Alice, Carol's notes say to hold until Monday.");
          if (text.includes("call-agent-1")) return textStreamResult("Waiting on Carol's notes.");
          const taskId = /taskId (agent-[a-z0-9]+)/.exec(text)?.[1];
          if (text.includes("ship on Friday.</task_result>") && taskId !== undefined)
            return toolCallsStreamResult([
              {
                input: JSON.stringify({ message: "Summarize Carol's notes.", taskId }),
                toolCallId: "call-agent-1",
                toolName: "agent",
              },
            ]);
          return prompt.some((message) => message.role === "tool")
            ? textStreamResult("Waiting on the helper.")
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "Summarize Bob's notes." }),
                  toolCallId: "call-agent-0",
                  toolName: "agent",
                },
              ]);
        },
        modelId: "in-process-follow-up",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({ agent: agentWith(model, "in-process-follow-up") });
    const directory = mkdtempSync(join(tmpdir(), "eve-follow-up-"));
    try {
      await test.run(async () => {
        const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
        const world = localTestWorld(directory);
        const first = createInProcessRuntime({ compiledArtifactsSource }, { world });
        const { sessionId } = await address(first, "alice-follow-up").send("Alice asks a helper.", {
          auth: null,
        });
        await followUp.started;
        await first.idle(sessionId);
        // The process dies while the subagent works on the follow-up.
        const stopping = first.dispose();
        followUp.release();
        await stopping;
        const saved = await createWorldSessionStore(world).load(sessionId);

        const second = createInProcessRuntime({ compiledArtifactsSource }, { world });
        try {
          // Only the parent is restored. Its run goes on with both of its calls, and the child
          // answers the follow-up from where it was cut off.
          await second.restore(saved!);
          await follow(second, sessionId, (seen) =>
            seen.some((event) => event.type === "turn.settled"),
          );
          const events = await recorded(second, sessionId);
          expect(replies(events)).toEqual([
            "Waiting on the helper.",
            "Waiting on Carol's notes.",
            "Alice, Carol's notes say to hold until Monday.",
          ]);
          expect(events.filter((event) => event.type === "child.opened")).toHaveLength(1);
          expect(events.filter((event) => event.type === "child.sent")).toHaveLength(2);
          // Bob's answer isn't asked again; Carol's cut-off step runs once more.
          expect(childCalls).toEqual({ bob: 1, carol: 2 });
          await expect(violations(second, sessionId)).resolves.toEqual([]);
        } finally {
          await second.dispose();
        }
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 60_000);
});
