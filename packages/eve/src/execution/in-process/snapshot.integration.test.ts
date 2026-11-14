import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import { memoryWorld } from "#execution/world/memory-world.js";

import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

import type { Runtime } from "#channel/types.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { checkpointPosition } from "#execution/in-process/snapshot.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  address,
  dyingAfter,
  recorded,
  shape,
  throughJson,
  violations,
} from "#internal/testing/in-process-sessions.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

// Calls both tools in one step, then replies with how each came out.
const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const results = prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" ? [`${part.toolName}:${part.output.type}`] : [],
            )
          : [],
      );
      return results.length > 0
        ? textStreamResult(`Done: ${results.sort().join(", ")}.`)
        : toolCallsStreamResult([
            { input: "{}", toolCallId: "call-deploy", toolName: "deploy_change" },
            { input: "{}", toolCallId: "call-publish", toolName: "publish_change" },
          ]);
    },
    modelId: "in-process-scripted",
    provider: "eve-test",
  }),
);

const approvedTool = (name: string, ran: string[]) => ({
  loadNamespace: async () => ({
    default: defineTool({
      approval: always(),
      description: `Run ${name}.`,
      execute: async () => {
        ran.push(name);
        return { ran: name };
      },
      inputSchema: {},
    }),
  }),
  logicalPath: `tools/${name}.ts`,
});

/** Alice asks for both calls; she approves one and denies the other, then asks again. */
async function approveAndDeny(runtime: Runtime, token: string) {
  const alice = address(runtime, token);
  const asked = await (await alice.send("Deploy and publish.", { auth: null })).result();
  const answers = asked.interactions.map((interaction) => ({
    interactionId: interaction.interactionId,
    optionId: interaction.call?.callId === "call-deploy" ? "approve" : "deny",
  }));
  const answered = await (await alice.deliver({ answers }, { auth: null })).result();
  const followUp = await (await alice.send("Thanks, Bob.", { auth: null })).result();
  const events = await recorded(runtime, asked.sessionId);
  return {
    answered,
    asked,
    events,
    followUp,
    violations: await violations(runtime, asked.sessionId),
  };
}

describe("the in-process runtime's timers", () => {
  it("ends a session that sits idle past its timeout as Workflow does", async () => {
    const test = await createTestRuntime({
      agent: { limits: { sessionTimeoutMs: 400 }, name: "in-process-timeout" },
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime({ compiledArtifactsSource });
      /** Follows the session's stream until it ends, after one turn and then silence. */
      const idle = async (runtime: Runtime, token: string) => {
        const sent = await address(runtime, token).send("Alice says hello.", { auth: null });
        await sent.result();
        const reader = (await runtime.getEventStream(sent.sessionId)).getReader();
        const events: SessionStreamEvent[] = [];
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          events.push(next.value);
          if (next.value.type === "session.ended") break;
        }
        await reader.cancel();
        return { events, violations: await violations(runtime, sent.sessionId) };
      };
      try {
        const startedAt = Date.now();
        const here = await idle(inProcess, "alice-timeout-in-process");
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
        const deployed = await idle(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-timeout-workflow",
        );
        expect(here.events.at(-1)).toMatchObject({ type: "session.ended" });
        expect(shape(here.events)).toEqual(shape(deployed.events));
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
      } finally {
        await inProcess.dispose();
      }
    });
  });
});

describe("snapshots of in-process sessions", () => {
  it("restores a session waiting on approvals in a fresh runtime, which continues it as Workflow does", async () => {
    const ran: string[] = [];
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-restore",
      },
      modules: [approvedTool("deploy_change", ran), approvedTool("publish_change", ran)],
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const token = "alice-restore";
      const first = createInProcessRuntime({ compiledArtifactsSource });
      const asked = await (
        await address(first, token).send("Deploy and publish.", { auth: null })
      ).result();
      expect(asked.interactions).toHaveLength(2);
      const snapshot = throughJson(await first.snapshot(asked.sessionId));
      expect(snapshot.open).toMatchObject({ at: "pause", pause: { on: "interaction" } });
      await first.dispose();

      const second = createInProcessRuntime({ compiledArtifactsSource });
      try {
        await expect(second.restore(snapshot)).resolves.toEqual({ sessionId: asked.sessionId });
        const answers = asked.interactions.map((interaction) => ({
          interactionId: interaction.interactionId,
          optionId: interaction.call?.callId === "call-deploy" ? "approve" : "deny",
        }));
        const answered = await (
          await address(second, token).deliver({ answers }, { auth: null })
        ).result();
        expect(answered.reply).toBe("Done: deploy_change:json, publish_change:execution-denied.");
        await (await address(second, token).send("Thanks, Bob.", { auth: null })).result();
        expect(ran).toEqual(["deploy_change"]);
        const restored = await recorded(second, asked.sessionId);
        await expect(violations(second, asked.sessionId)).resolves.toEqual([]);

        // The same conversation, never interrupted, on Workflow.
        ran.splice(0);
        const deployed = await approveAndDeny(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-restore-workflow",
        );
        expect(shape(restored)).toEqual(shape(deployed.events));
      } finally {
        await second.dispose();
      }
    });
  });

  it("continues a turn the store caught mid-call from its last step, and the model reads the call may have run", async () => {
    let release: () => void = () => {};
    const building = new Promise<void>((resolve) => (release = resolve));
    const prompts: string[] = [];
    const slowModel = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const seen = JSON.stringify(prompt);
          prompts.push(seen);
          if (seen.includes("may or may not have taken effect"))
            return textStreamResult("The build may have run; I'll check it first.");
          return prompt.some((message) => message.role === "tool")
            ? textStreamResult("Built.")
            : toolCallsStreamResult([
                { input: "{}", toolCallId: "call-build", toolName: "slow_build" },
              ]);
        },
        modelId: "in-process-slow",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model: slowModel, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-interrupted",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Run the build.",
              execute: async () => {
                await building;
                return { built: true };
              },
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/slow_build.ts",
        },
      ],
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const token = "alice-interrupted";
      const world = memoryWorld();
      const first = createInProcessRuntime({ compiledArtifactsSource }, { world });
      const sent = await address(first, token).send("Run the build.", { auth: null });
      const reader = (await first.getEventStream(sent.sessionId)).getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read())
        if (next.value.type === "call.started") break;
      await reader.cancel();
      // The store holds the session mid-step: the step that's running, to run again.
      const snapshot = (await createWorldSessionStore(world).load(sent.sessionId))!;
      expect(snapshot.open).toMatchObject({ at: "step" });
      // This process carries on; what was loaded doesn't see it.
      release();
      await sent.result();
      await first.dispose();

      const second = createInProcessRuntime({ compiledArtifactsSource });
      try {
        await second.restore(snapshot);
        const after = (await second.getEventStream(sent.sessionId)).getReader();
        for (let next = await after.read(); !next.done; next = await after.read())
          if (next.value.type === "turn.settled") break;
        await after.cancel();
        expect(prompts.at(-1)).toContain(
          "slow_build {}: The step running this call was interrupted. The call may or may not have taken effect.",
        );
        const events = await recorded(second, sent.sessionId);
        // One turn, which went on: the call the cut-off attempt started closes, and the rerun
        // step's model call reads that it may have run.
        expect(events.filter(({ type }) => type === "turn.settled")).toMatchObject([
          { data: { outcome: "completed" } },
        ]);
        expect(
          events.filter(({ type }) => type === "call.settled").map(({ data }) => data),
        ).toMatchObject([{ callId: "call-build", outcome: "abandoned" }]);
        await expect(violations(second, sent.sessionId)).resolves.toEqual([]);
      } finally {
        await second.dispose();
      }
    });
  });

  it("keeps a message sent mid-turn before its address accepts it, so a restore still answers it", async () => {
    let release: () => void = () => {};
    const building = new Promise<void>((resolve) => (release = resolve));
    const prompts: string[] = [];
    const slowModel = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const seen = JSON.stringify(prompt);
          prompts.push(seen);
          const last = prompt.at(-1);
          if (last?.role === "user" && JSON.stringify(last).includes("And the docs?"))
            return textStreamResult("The docs are next.");
          return prompt.some((message) => message.role === "tool") ||
            seen.includes("may or may not have taken effect")
            ? textStreamResult("Built.")
            : toolCallsStreamResult([
                { input: "{}", toolCallId: "call-build", toolName: "slow_build" },
              ]);
        },
        modelId: "in-process-queued",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model: slowModel, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-queued",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Run the build.",
              execute: async () => {
                await building;
                return { built: true };
              },
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/slow_build.ts",
        },
      ],
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const token = "alice-queued";
      const world = memoryWorld();
      const first = createInProcessRuntime({ compiledArtifactsSource }, { world });
      const sent = await address(first, token).send("Run the build.", { auth: null });
      const reader = (await first.getEventStream(sent.sessionId)).getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read())
        if (next.value.type === "call.started") break;
      await reader.cancel();
      // Bob's question arrives while the build runs: kept by the time the send returns.
      await address(first, token).send("And the docs?", { auth: null });
      const snapshot = (await createWorldSessionStore(world).load(sent.sessionId))!;
      expect(JSON.stringify(snapshot.inputs?.unread)).toContain("And the docs?");
      release();
      await sent.result();
      await first.dispose();

      prompts.splice(0);
      const second = createInProcessRuntime({ compiledArtifactsSource });
      try {
        await second.restore(snapshot);
        const after = (await second.getEventStream(sent.sessionId)).getReader();
        const replies: string[] = [];
        for (let next = await after.read(); !next.done; next = await after.read()) {
          if (next.value.type === "content.completed")
            replies.push(JSON.stringify(next.value.data));
          if (next.value.type === "turn.settled" && replies.some((r) => r.includes("docs are")))
            break;
        }
        await after.cancel();
        await second.idle(sent.sessionId);
        // The question was read after the cut-off build's step ran again, and answered.
        expect(prompts.some((p) => p.includes("And the docs?"))).toBe(true);
        expect((await second.snapshot(sent.sessionId)).inputs?.unread).toEqual([]);
        await expect(violations(second, sent.sessionId)).resolves.toEqual([]);
      } finally {
        await second.dispose();
      }
    });
  });

  it("settles a cancel again after the process died inside its settle, folding what it wrote", async () => {
    let modelStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => (modelStarted = resolve));
    const waitingModel = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ abortSignal, prompt }) => {
          if (!JSON.stringify(prompt).includes("Still there?")) {
            modelStarted();
            // Alice's first turn runs until she cancels it.
            await new Promise((_, reject) =>
              abortSignal?.addEventListener("abort", () => reject(abortSignal.reason)),
            );
          }
          return textStreamResult("Here.");
        },
        modelId: "in-process-cancel-crash",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model: waitingModel, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-cancel-crash",
      },
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const kept = memoryWorld();
      const dying = dyingAfter(kept, (line) => line.includes('"turn.settled"'));
      const first = createInProcessRuntime({ compiledArtifactsSource }, { world: dying.world });
      const token = "alice-cancel-crash";
      const { sessionId } = await address(first, token).send("Deploy the change.", { auth: null });
      await started;
      await first.dispatchSession({
        command: { deliveryId: "alice-cancel", kind: "cancel" },
        sessionId,
      });
      await dying.death;
      await first.dispose();

      const saved = (await createWorldSessionStore(kept).load(sessionId))!;
      // The settle's lines are past the last step the store kept, which names the settle as
      // where the turn goes on.
      expect(saved.lines.length).toBeGreaterThan(checkpointPosition(saved.checkpoint));
      expect(saved.open).toMatchObject({ at: "cancel", control: { deliveryId: "alice-cancel" } });

      const second = createInProcessRuntime({ compiledArtifactsSource }, { world: kept });
      try {
        await second.restore(saved);
        await second.idle(sessionId);
        const reply = await address(second, token).send("Still there?", { auth: null });
        await expect(reply.result()).resolves.toMatchObject({ status: "completed" });
        await second.idle(sessionId);
        const events = await recorded(second, sessionId);
        expect(
          events.flatMap(({ data, type }) => (type === "turn.settled" ? [data] : [])),
        ).toMatchObject([{ outcome: "cancelled" }, { outcome: "completed" }]);
        await expect(violations(second, sessionId)).resolves.toEqual([]);
      } finally {
        await second.dispose();
      }
    });
  });

  it("refuses a snapshot in another format, saying why", async () => {
    const test = await createTestRuntime({ agent: { name: "in-process-format" } });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const first = createInProcessRuntime({ compiledArtifactsSource });
      const sent = await address(first, "alice-format").send("Hello.", { auth: null });
      await sent.result();
      const snapshot = await first.snapshot(sent.sessionId);
      await first.dispose();
      const second = createInProcessRuntime({ compiledArtifactsSource });
      try {
        await expect(
          second.restore(
            JSON.parse(JSON.stringify({ ...snapshot, format: "eve.in-process-session/1" })),
          ),
        ).rejects.toThrow(
          `Session "${sent.sessionId}" can't be restored here: its snapshot is in format "eve.in-process-session/1"`,
        );
      } finally {
        await second.dispose();
      }
    });
  });
});
