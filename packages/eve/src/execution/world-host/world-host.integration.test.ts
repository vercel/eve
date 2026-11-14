import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ActivationOutcome } from "#execution/actor/actors.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { withMemoryQueue } from "#execution/world/memory-queue.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import {
  address,
  recorded,
  replies,
  shape,
  violations,
} from "#internal/testing/in-process-sessions.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { createWorldHost, type WorldHostOptions } from "./host.js";

// Sessions of a compiled agent that run only when something arrives for them: the World (in this
// process's memory, with a queue that delivers here) keeps each session and delivers its
// activations; each runs the session until it waits again, and nothing holds it between them.

/** Calls `deploy` until it has a result, then says how it went. */
function deployModel(prompts: string[]) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        const results = prompt
          .flatMap((message) => (message.role === "tool" ? message.content : []))
          .filter((part) => part.type === "tool-result");
        const users = prompt.filter((message) => message.role === "user").length;
        if (users > 1) return textStreamResult(`Turn ${String(users)}.`);
        return results.length > 0
          ? textStreamResult(`Deploy: ${String(results.length)}.`)
          : toolCallsStreamResult([
              { input: '{"env":"prod"}', toolCallId: "call-deploy", toolName: "deploy" },
            ]);
      },
      modelId: "world-host-scripted",
      provider: "eve-test",
    }),
  );
}

/** Calls `step` `steps` times, one call per model step, then says it's done. */
function stepsModel(steps: number, pauseMs = 0) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
        const done = prompt
          .flatMap((message) => (message.role === "tool" ? message.content : []))
          .filter((part) => part.type === "tool-result").length;
        return done >= steps
          ? textStreamResult(`Done after ${String(done)}.`)
          : toolCallsStreamResult([
              { input: "{}", toolCallId: `call-step-${String(done)}`, toolName: "step" },
            ]);
      },
      modelId: "world-host-steps",
      provider: "eve-test",
    }),
  );
}

const toolModule = (name: string, ran: string[], approved = false) => ({
  loadNamespace: async () => ({
    default: defineTool({
      ...(approved && { approval: always() }),
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

/** Runs `body` against a World host for the test runtime's compiled agent. */
async function withWorldHost(
  model: ReturnType<typeof deployModel>,
  modules: ReturnType<typeof toolModule>[],
  body: (input: {
    readonly host: ReturnType<typeof createWorldHost>;
    readonly world: ReturnType<typeof withMemoryQueue>;
    readonly outcomes: {
      readonly sessionId: string;
      readonly outcome: ActivationOutcome;
      readonly at: number;
    }[];
  }) => Promise<void>,
  options: Partial<WorldHostOptions> & { readonly limits?: { sessionTimeoutMs?: number } } = {},
) {
  const { limits, ...hostOptions } = options;
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        ...(limits !== undefined && { limits }),
      }),
      name: "world-host-agent",
    },
    modules,
  });
  await test.run(async () => {
    const world = withMemoryQueue(memoryWorld());
    const outcomes: { sessionId: string; outcome: ActivationOutcome; at: number }[] = [];
    const host = createWorldHost({
      agents: { agent: createBundledRuntimeCompiledArtifactsSource() },
      world,
      observe: ({ outcome, sessionId }) => outcomes.push({ at: Date.now(), outcome, sessionId }),
      ...hostOptions,
    });
    await host.serve();
    try {
      await body({ host, outcomes, world });
    } finally {
      await host.close();
      await world.close();
    }
  });
}

describe("a World host", () => {
  it("runs a turn when a message arrives, holds nothing while an approval waits, and runs the tool once approved", async () => {
    const prompts: string[] = [];
    const ran: string[] = [];
    await withWorldHost(
      deployModel(prompts),
      [toolModule("deploy", ran, true)],
      async ({ host, outcomes, world }) => {
        const runtime = host.runtime("agent");
        const asked = await (
          await address(runtime, "alice-world").send("Deploy to prod.", { auth: null })
        ).result();
        expect(asked.interactions).toHaveLength(1);
        await world.idle();
        // Every activation ended idle: nothing holds the session while Alice decides.
        expect(outcomes.length).toBeGreaterThan(0);
        expect(outcomes.every(({ outcome }) => outcome.kind === "idle")).toBe(true);
        expect(ran).toEqual([]);

        const answered = await (
          await address(runtime, "alice-world").deliver(
            {
              answers: [
                { interactionId: asked.interactions[0]!.interactionId, optionId: "approve" },
              ],
            },
            { auth: null },
          )
        ).result();
        expect(answered.reply).toBe("Deploy: 1.");
        const next = await (
          await address(runtime, "alice-world").send("And again?", { auth: null })
        ).result();
        expect(next.sessionId).toBe(asked.sessionId);
        expect(ran).toEqual(["deploy"]);
        await world.idle();
        await expect(violations(runtime, asked.sessionId)).resolves.toEqual([]);
      },
    );
  });

  it("comes to the conversation a Workflow deployment does", async () => {
    const ran: string[] = [];
    await withWorldHost(
      deployModel([]),
      [toolModule("deploy", ran, true)],
      async ({ host, world }) => {
        const conversation = async (
          runtime: ReturnType<typeof host.runtime> | ReturnType<typeof createWorkflowRuntime>,
          token: string,
        ) => {
          const asked = await (
            await address(runtime, token).send("Deploy to prod.", { auth: null })
          ).result();
          await (
            await address(runtime, token).deliver(
              {
                answers: [
                  { interactionId: asked.interactions[0]!.interactionId, optionId: "approve" },
                ],
              },
              { auth: null },
            )
          ).result();
          await (await address(runtime, token).send("And again?", { auth: null })).result();
          return asked.sessionId;
        };
        const here = host.runtime("agent");
        const sessionId = await conversation(here, "alice-world-parity");
        await world.idle();
        const deployed = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const deployedId = await conversation(deployed, "alice-workflow-parity");
        expect(shape(await recorded(here, sessionId))).toEqual(
          shape(await recorded(deployed, deployedId)),
        );
      },
    );
  });

  it("hands a turn longer than one delivery to the next, and runs each call once", async () => {
    const ran: string[] = [];
    await withWorldHost(
      stepsModel(6, 60),
      [toolModule("step", ran)],
      async ({ host, outcomes, world }) => {
        const runtime = host.runtime("agent");
        const done = await (
          await address(runtime, "alice-long").send("Take six steps.", { auth: null })
        ).result();
        expect(done.reply).toBe("Done after 6.");
        await world.idle();
        expect(ran).toHaveLength(6);
        // More than one delivery ran it: each handed off to the next where a step ended.
        expect(
          outcomes.filter(({ outcome }) => outcome.kind === "continue").length,
        ).toBeGreaterThan(0);
        await expect(violations(runtime, done.sessionId)).resolves.toEqual([]);
      },
      { deliveryBudgetMs: 200 },
    );
  });

  it("ends an idle session on its timeout, from an alarm its timer armed after it stopped", async () => {
    await withWorldHost(
      stepsModel(0),
      [],
      async ({ host, outcomes, world }) => {
        const runtime = host.runtime("agent");
        const sent = await (
          await address(runtime, "alice-timeout").send("Hello.", { auth: null })
        ).result();
        await world.idle();
        // It stopped with an alarm for its timeout.
        expect(
          outcomes.some(({ outcome }) => outcome.kind === "idle" && outcome.alarm !== undefined),
        ).toBe(true);
        const reader = (await runtime.getEventStream(sent.sessionId)).getReader();
        for (let next = await reader.read(); !next.done; next = await reader.read())
          if (next.value.type === "session.ended") break;
        await reader.cancel();
        // The activation the alarm ran ended the session's actor as it stopped.
        await world.idle();
        expect((await host.actors.info(sent.sessionId))?.status).toBe("completed");
      },
      { limits: { sessionTimeoutMs: 4_000 } },
    );
  });

  it("hands a message sent while an activation works to that activation", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          calls += 1;
          // The first turn's model call waits until the test has sent its second message.
          if (calls === 1) await held;
          const users = prompt.filter((message) => message.role === "user").length;
          return textStreamResult(`Read ${String(users)}.`);
        },
        modelId: "world-host-steer",
        provider: "eve-test",
      }),
    );
    await withWorldHost(model, [], async ({ host, outcomes, world }) => {
      const runtime = host.runtime("agent");
      const first = await address(runtime, "alice-steer").send("First.", { auth: null });
      // Wait until the first activation is in its model call, then send again.
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await address(runtime, "alice-steer").send("Second.", { auth: null });
      release();
      await first.result();
      await second.result();
      const settledAt = Date.now();
      await world.idle();
      const events = await recorded(runtime, first.sessionId);
      // The second message reached the turn the first activation was running, as it would in
      // one process: the reply read both (it steered the turn, or ran in a turn of its own).
      expect(replies(events).at(-1)).toBe("Read 2.");
      // The activation that was working took the second message too, and settled it before it
      // ended; the message's own wake finds the session as that activation left it.
      expect(outcomes[0]!.at).toBeGreaterThanOrEqual(settledAt - 5);
      expect(outcomes.length).toBeLessThanOrEqual(2);
    });
  });
});
