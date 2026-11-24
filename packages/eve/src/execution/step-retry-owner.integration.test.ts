import { expect, it, onTestFinished, vi } from "vitest";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
} from "#instrumentation/providers.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { withInterruptedSession } from "#internal/testing/interrupted-session.js";
import { startTestApp, testEntities } from "#internal/testing/test-platform.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";

vi.setConfig({ testTimeout: 30_000 });

const ofType = <T extends SessionStreamEvent["type"]>(
  events: readonly SessionStreamEvent[],
  type: T,
) =>
  events.filter((event): event is Extract<SessionStreamEvent, { type: T }> => event.type === type);

const respondToConversation = (prompt: string, call: number) =>
  prompt.includes("Thanks!")
    ? textStreamResult("You're welcome.")
    : !prompt.includes("plan:billing")
      ? toolCallStreamResult({
          input: JSON.stringify({ service: "billing" }),
          toolCallId: `deploy-${call}`,
          toolName: "deploy",
        })
      : !prompt.includes('"toolName":"lookup"') && !prompt.includes("- lookup")
        ? toolCallStreamResult({ input: "{}", toolCallId: `lookup-${call}`, toolName: "lookup" })
        : textStreamResult("Billing is deployed, and Alice's record is ready.");

function transcript(events: readonly SessionStreamEvent[]) {
  const texts = new Map(
    ofType(events, "content.completed").map(({ data }) => [data.partId, data.value]),
  );
  return ofType(events, "turn.settled").map(({ data }) => ({
    outcome: data.outcome,
    reply: (data.reply ?? []).map((partId) => texts.get(partId)),
  }));
}

async function converse(lost: number | undefined) {
  let completions = 0;
  const { prompts, ran } = await withInterruptedSession(
    `replay-sweep-${lost ?? "none"}`,
    {
      loseTurnStep: (completion) => {
        completions = completion;
        return completion === lost;
      },
      respond: respondToConversation,
      tools: [{ name: "deploy", workflow: true }, { name: "lookup" }],
    },
    async (session) => {
      const settled = async (label: string) => {
        while (ofType(await session.next(label), "turn.settled").length === 0);
      };
      await settled("first turn");
      await session.send("Thanks!");
      await settled("second turn");
      expect(transcript(session.events())).toEqual([
        { outcome: "completed", reply: ["Billing is deployed, and Alice's record is ready."] },
        { outcome: "completed", reply: ["You're welcome."] },
      ]);
      const deploys = new Set(
        ofType(session.events(), "call.requested")
          .filter(({ data }) => data.capability.name === "deploy")
          .map(({ data }) => data.callId),
      );
      expect(
        ofType(session.events(), "call.settled").filter(
          ({ data }) => deploys.has(data.callId) && data.outcome === "completed",
        ),
      ).toHaveLength(1);
      await vi.waitFor(() => expect(session.interrupted()).toBe(lost === undefined ? 0 : 1));
    },
  );
  expect(ran).toEqual(["lookup"]);
  expect(prompts.at(-1)).toContain("Help Alice with her account.");
  expect(prompts.at(-1)).toContain("Billing is deployed, and Alice's record is ready.");
  return completions;
}

const TURN_STEPS = 4;

it("runs the conversation in its turn steps when none loses its completion", async () => {
  expect(await converse(undefined)).toBe(TURN_STEPS);
});

it.each(Array.from({ length: TURN_STEPS }, (_, index) => index + 1))(
  "comes to the same conversation when turn step %i loses its completion",
  async (lost) => {
    await converse(lost);
  },
);

it("does not run an approved call again when the step that ran it is interrupted", async () => {
  const { prompts, ran } = await withInterruptedSession(
    "retry-approved",
    {
      interruptAfter: { nth: 2, type: "interaction.opened" },
      respond: (_prompt, call) =>
        call === 1
          ? toolCallStreamResult({ input: "{}", toolCallId: "deploy", toolName: "deploy" })
          : call <= 3
            ? toolCallStreamResult({ input: "{}", toolCallId: "notify", toolName: "notify" })
            : textStreamResult("Deployed and notified."),
      tools: [
        { approval: true, name: "deploy" },
        { approval: true, name: "notify" },
      ],
    },
    async (session) => {
      await session.next("deploy approval");
      const [deploy] = ofType(session.events(), "interaction.opened");
      await session.answer(deploy!.data.interactionId, "approve");
      await session.next("notify approval");
      await vi.waitFor(() => expect(session.interrupted()).toBe(1));
      await session.next("notify approval again");
      const opened = ofType(session.events(), "interaction.opened").map(
        (event) => event.data.interactionId,
      );
      expect(opened).toHaveLength(3);
      expect(
        ofType(session.events(), "interaction.settled").map((event) => [
          event.data.interactionId,
          event.data.outcome,
        ]),
      ).toEqual([
        [opened[0], "accepted"],
        [opened[1], "abandoned"],
      ]);
      await session.answer(opened[2]!, "approve");
      await session.next("reply");
    },
  );
  expect(ran).toEqual(["deploy", "notify"]);
  expect(prompts).toHaveLength(4);
  expect(prompts[2]).toContain("result was lost");
  expect(prompts[2]).not.toContain("earlier interactive prompt");
});

it("fails the turn, not the session, when its steps are interrupted too many times", async () => {
  let lastCallId: string | undefined;
  const { ran, prompts } = await withInterruptedSession(
    "retry-too-often",
    {
      loseTurnStep: (completion) => completion % 2 === 1 && completion <= 7,
      respond: (prompt, call) =>
        prompt.includes("Try again")
          ? textStreamResult("Done.")
          : toolCallStreamResult({
              input: JSON.stringify({ operation: `lookup-${call}` }),
              toolCallId: `lookup-${call}`,
              toolName: "lookup",
            }),
      tools: [{ name: "lookup" }],
    },
    async (session) => {
      const turn = await session.next("failed turn");
      expect(ofType(turn, "turn.settled")).toMatchObject([
        { data: { error: { code: "STEP_INTERRUPTED" }, outcome: "failed" } },
      ]);
      lastCallId = ofType(session.events(), "call.started").at(-1)?.data.callId;
      await session.send("Try again, please.");
      const next = await session.next("next turn");
      expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(ran.length).toBeGreaterThan(0);
  expect(lastCallId).toBeDefined();
  expect(prompts.at(-1)).toContain(lastCallId);
});

it("keeps an approved call's recorded outcome in history after retry exhaustion", async () => {
  const { prompts, ran } = await withInterruptedSession(
    "retry-approved-exhausted",
    {
      loseTurnStep: (completion) => completion >= 2 && completion <= 5,
      respond: (prompt, call) =>
        prompt.includes("Check what happened")
          ? textStreamResult("I will check the deployment before continuing.")
          : toolCallStreamResult({
              input: "{}",
              toolCallId: `${call === 1 ? "deploy" : "notify"}-${call}`,
              toolName: call === 1 ? "deploy" : "notify",
            }),
      tools: [
        { name: "deploy", approval: true },
        { name: "notify", approval: true },
      ],
    },
    async (session) => {
      await session.next("approval");
      const [approval] = ofType(session.events(), "interaction.opened");
      await session.answer(approval!.data.interactionId, "approve");
      for (let attempt = 0; attempt < 6; attempt++) {
        const events = await session.next("approval retry or failed turn");
        if (ofType(events, "turn.settled").length > 0) break;
      }
      expect(ofType(session.events(), "turn.settled")).toMatchObject([
        { data: { error: { code: "TURN_FAILED", id: expect.any(String) }, outcome: "failed" } },
      ]);
      await session.send("Check what happened before continuing.");
      const next = await session.next("next turn");
      expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(ran).toEqual(["deploy"]);
  expect(prompts.at(-1)).toContain("This call completed, but its result was lost");
});

it("retries a step whose stream write failed, and each model attempt settles once", async () => {
  const name = "retry-dead-stream";
  const started: string[] = [];
  const settled: { readonly key: string; readonly outcome: string }[] = [];
  await registerInstrumentationProvider({
    agentName: name,
    platform: testEntities(),
    slot: "capture",
    value: defineInstrumentation({
      events: {
        "model.started": (event) => void started.push(event.idempotencyKey),
        "model.settled": (event) =>
          void settled.push({ key: event.idempotencyKey, outcome: event.outcome }),
      },
    }),
  });
  finalizeInstrumentationProviders({ platform: testEntities(), serviceName: name });
  onTestFinished(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.app")];
    startTestApp();
  });

  const { prompts } = await withInterruptedSession(
    name,
    {
      failWriteOf: '"content.',
      respond: () => textStreamResult("Alice's account is ready."),
      tools: [],
    },
    async (session) => {
      const turn = await session.next("turn");
      expect(ofType(turn, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
      expect(session.failedWrites()).toBe(1);
    },
  );
  expect(prompts).toHaveLength(2);
  expect(started).toHaveLength(2);
  expect(settled.map(({ key }) => key)).toEqual(started);
  expect(settled.map(({ outcome }) => outcome)).toEqual(["abandoned", "completed"]);
});

it("cancels a turn stopped while its step kept failing, and the session goes on", async () => {
  const { prompts } = await withInterruptedSession(
    "retry-exhausted-stopped",
    {
      failTurnStepWrites: 4,
      holdRetryUntilStopped: true,
      respond: () => textStreamResult("Done."),
      tools: [],
    },
    async (session) => {
      await vi.waitFor(() => expect(session.failedWrites()).toBeGreaterThan(0));
      await session.cancel();
      const turn = await session.next("cancelled turn");
      expect(ofType(turn, "turn.settled")).toMatchObject([{ data: { outcome: "cancelled" } }]);
      expect(ofType(turn, "turn.settled")[0]?.data).not.toHaveProperty("error");
      await session.send("Try again, please.");
      const next = await session.next("next turn");
      expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(prompts.at(-1)).toContain("Help Alice with her account.");
});
