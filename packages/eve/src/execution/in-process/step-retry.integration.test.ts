import { expect, it, onTestFinished, vi } from "vitest";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { withInterruptedSession } from "#internal/testing/interrupted-session.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

// What a host does with a turn step whose completion is lost: it runs the step again as a retry,
// up to a limit. The in-process host's step faults (`step-attempts.ts`) stand in for Workflow's
// retries, so each case runs on both. What eve does with a retry is in
// `step-retry-owner.integration.test.ts`, in process.

vi.setConfig({ testTimeout: 90_000 });

const ofType = <T extends SessionStreamEvent["type"]>(
  events: readonly SessionStreamEvent[],
  type: T,
) =>
  events.filter((event): event is Extract<SessionStreamEvent, { type: T }> => event.type === type);

const HOSTS = ["workflow", "in-process"] as const;

it.each(HOSTS)(
  "runs a turn step whose completion was lost again, as a retry, until the retry limit (%s)",
  async (host) => {
    const { prompts, ran } = await withInterruptedSession(
      `retry-limit-${host}`,
      {
        host,
        // Every attempt of the first step loses its completion; the step that fails the turn
        // keeps its own.
        loseTurnStep: (completion) => completion <= 4,
        respond: (prompt, call) =>
          prompt.includes("Try again")
            ? textStreamResult("Done.")
            : toolCallStreamResult({
                input: "{}",
                toolCallId: `lookup-${call}`,
                toolName: "lookup",
              }),
        tools: [{ name: "lookup" }],
      },
      async (session) => {
        const turn = await session.next("failed turn");
        expect(ofType(turn, "turn.settled")).toMatchObject([
          { data: { error: { code: "TURN_FAILED" }, outcome: "failed" } },
        ]);
        await session.send("Try again, please.");
        const next = await session.next("next turn");
        expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
      },
    );
    // The first retry knew it was one: it read what its attempt did.
    expect(prompts[1]).toContain("This call completed, but its result was lost");
    // The first attempt and three retries ran; the attempt past the limit didn't.
    expect(ran).toEqual(["lookup", "lookup", "lookup", "lookup"]);
  },
);

// Workflow's own exhaustion of a step that threw, which the in-process host's step faults copy.
it("fails the turn, not the session, when a step fails every attempt (workflow)", async () => {
  // A failed attempt waits this long for its stream's writes before it retries.
  vi.stubEnv("WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS", "500");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const { observed } = await withInterruptedSession(
    "retry-exhausted",
    {
      host: "workflow",
      // Every attempt of the first step fails to write; the recovery step's write succeeds.
      failTurnStepWrites: 4,
      respond: (_prompt, call) =>
        call === 1
          ? toolCallStreamResult({ input: "{}", toolCallId: "lookup", toolName: "lookup" })
          : textStreamResult("Done."),
      tools: [{ name: "lookup" }],
    },
    async (session) => {
      const turn = await session.next("failed turn");
      // The turn reports a fixed failure, under an id its log line carries, not what the last
      // attempt threw.
      expect(ofType(turn, "turn.settled")).toMatchObject([
        {
          data: {
            error: {
              code: "TURN_FAILED",
              id: expect.any(String),
              message: "This turn failed before it finished. Send another message to continue.",
            },
            outcome: "failed",
          },
        },
      ]);
      expect(JSON.stringify(turn)).not.toContain("The session stream is unavailable");
      await session.send("Try again, please.");
      const next = await session.next("next turn");
      expect(ofType(next, "turn.settled")).toMatchObject([{ data: { outcome: "completed" } }]);
    },
  );
  expect(observed).toBe(1);
});
