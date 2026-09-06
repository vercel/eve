import { defineEval, type EveEvalTurn } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const cases = [
  {
    parentActive: false,
    steering: true,
    description: "after the parent acknowledges delegation",
  },
  { parentActive: true, steering: true, description: "while the parent also has an active turn" },
  {
    parentActive: true,
    steering: false,
    description: "an unrelated follow-up preserves the work",
  },
] as const;

export default cases.map(({ parentActive, steering, description }) =>
  defineEval({
    description: `Background subagent steering: ${description}.`,
    // The parent chooses whether and how to redirect work. A scripted parent
    // would bake an implementation option into the acceptance test.
    tags: ["real-model", "background-steering"],
    timeoutMs: 240_000,
    async test(t) {
      const memo = crypto.randomUUID();
      const original = `WORKER-RESULT:ORIGINAL:${memo}`;
      const steered = `WORKER-RESULT:STEERED:${memo}`;
      const expected = steering ? steered : original;
      let parent = await t.start(
        [
          "Call steering-worker exactly once in the background with this exact message:",
          `ASSIGNMENT ${memo}`,
          "Acknowledge the receipt without reporting a result. Relay its final result verbatim when it completes.",
          "End this turn after acknowledging the receipt; the worker will keep running.",
        ].join("\n"),
      );

      const sessionId = parent.sessionId;
      try {
        const acknowledged = await parent.result();
        acknowledged.expectOk();
        const parentTurns: EveEvalTurn[] = [acknowledged];
        // Admission can acknowledge before the child starts. Keep observing
        // from the cursor instead of assuming subagent.called precedes it.
        if (!parent.events.some((event) => event.type === "subagent.called")) {
          parent = t.target.watchTurn(sessionId, {
            startIndex: parent.session.state!.streamIndex,
          });
        }
        const called = await parent.waitForEvent("subagent.called", {
          data: { name: "steering-worker" },
        });
        await t.require(
          called.data.agentId,
          satisfies((value) => typeof value === "string", "the worker has an agent id"),
        );
        const child = t.target.watchTurn(called.data.childSessionId);
        await child.waitForEvent("actions.requested", {
          data: {
            actions: (actions) =>
              actions.some(
                (action) =>
                  action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
              ),
          },
        });

        if (parentActive) {
          // Establish a running child before holding another parent turn;
          // holding the launch turn can delay dispatch until its wait ends.
          parent = await parent.session.start("Please wait for cancellation.");
          await parent.waitForEvent("actions.requested", {
            data: {
              actions: (actions) =>
                actions.some(
                  (action) =>
                    action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
                ),
            },
          });
        }

        await t.require(
          child.events,
          satisfies(
            (events: typeof child.events) =>
              !events.some((event) =>
                ["turn.completed", "turn.cancelled", "turn.failed", "session.waiting"].includes(
                  event.type,
                ),
              ),
            "the follow-up arrives before the original child turn settles",
          ),
        );

        parent = await parent.session.start(
          steering
            ? "Actually, use STEERED instead of ORIGINAL."
            : "What is 2 + 2? Reply with just the number.",
          { turnPolicy: "steer" },
        );
        await t.require(parent.sessionId, equals(sessionId));

        if (parentActive) {
          // start() observes from the current cursor, including the turn
          // cancelled by this steering message before its replacement begins.
          const cancelled = await parent.result();
          cancelled.notEvent("turn.failed");
          cancelled.event("turn.cancelled", { count: 1 });
          parentTurns.push(cancelled);
          parent = t.target.watchTurn(sessionId, {
            startIndex: parent.session.state!.streamIndex,
          });
        }
        // Observe through the result-bearing task wake, not just the parent's
        // acknowledgment of the steering message or an AGENT_BUSY failure wake.
        for (let attempt = 0; attempt < 6; attempt++) {
          const turn = await parent.result();
          parentTurns.push(turn);
          if (
            turn.events.some(
              (event) =>
                event.type === "message.received" &&
                (JSON.stringify(event.data.message).includes(original) ||
                  JSON.stringify(event.data.message).includes(steered)),
            )
          ) {
            break;
          }
          parent = t.target.watchTurn(sessionId, {
            startIndex: parent.session.state!.streamIndex,
          });
        }

        const calls = parentTurns.flatMap((turn) =>
          turn.events.filter((event) => event.type === "subagent.called"),
        );
        await t.require(
          calls,
          satisfies(
            (events: typeof calls) =>
              events.length > 0 &&
              events.every(
                (event) =>
                  event.data.name === "steering-worker" &&
                  event.data.agentId === called.data.agentId &&
                  event.data.childSessionId === called.data.childSessionId,
              ),
            "all delegations address the original worker session",
          ),
        );

        const firstChildTurn = await child.result();
        const childWasCancelled = firstChildTurn.events.some(
          (event) => event.type === "turn.cancelled",
        );
        if (steering && childWasCancelled) {
          // Also permits cancel-and-resume of the same child; no specific
          // control API or task-id lifetime is required by these assertions.
          const resumed = await t.target
            .watchTurn(called.data.childSessionId, { startIndex: child.session.state!.streamIndex })
            .result();
          resumed.expectOk();
          resumed.messageIncludes(expected);
        } else {
          firstChildTurn.expectOk();
          firstChildTurn.notEvent("turn.cancelled");
          firstChildTurn.messageIncludes(expected);
        }
        if (steering) {
          firstChildTurn.eventsSatisfy(
            "the original child never emits the superseded result",
            (events) =>
              !events.some(
                (event) =>
                  event.type === "message.completed" && event.data.message?.includes(original),
              ),
          );
        }

        // A queued follow-up extends observation beyond the first result wake
        // without cancelling a duplicate wake that is already pending.
        parent = await parent.session.start(
          "Reply with exactly STEERING-CHECKPOINT. Do not repeat any earlier result or call tools.",
          { turnPolicy: "queue" },
        );
        let checkpointReached = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          const turn = await parent.result();
          parentTurns.push(turn);
          turn.notEvent("subagent.called");
          if (turn.message?.includes("STEERING-CHECKPOINT")) {
            checkpointReached = true;
            break;
          }
          parent = t.target.watchTurn(sessionId, {
            startIndex: parent.session.state!.streamIndex,
          });
        }
        t.check(checkpointReached, equals(true)).label("parent processes the queued checkpoint");

        const replies = parentTurns.flatMap((turn) =>
          turn.events.flatMap((event) =>
            event.type === "message.completed" && event.data.message !== null
              ? [event.data.message]
              : [],
          ),
        );
        t.check(replies.filter((message) => message.includes("WORKER-RESULT:")).length, equals(1));
        t.check(
          replies.some((message) => message.includes(expected)),
          equals(true),
        );
        if (steering)
          t.check(
            replies.some((message) => message.includes(original)),
            equals(false),
          );
        else
          t.check(
            replies.some((message) => message.trim() === "4"),
            equals(true),
          );
        for (const turn of parentTurns) {
          turn.notEvent("turn.failed");
          turn.notEvent("session.failed");
        }
      } finally {
        // Reset owns admitted background tasks; cancelling only the parent
        // turn would leave workers alive when a gate fails.
        try {
          const cleanup = await t.target.fetch(`/eve/v1/session/${sessionId}/reset`, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          });
          t.check(cleanup.ok, equals(true)).label("reset cleans up background work");
        } catch (error) {
          t.log(`Background steering cleanup failed: ${String(error)}`);
          t.check(false, equals(true)).label("reset cleans up background work");
        }
      }
    },
  }),
);
