import { defineEval } from "eve/evals";

const GUARDED_ECHO_OPENAI_TOKEN = "guarded-echo-openai-ok-R2D7";

/**
 * Regression coverage for https://github.com/vercel/eve/issues/236.
 *
 * An `always()`-gated executable tool on the OpenAI Responses provider:
 * a text approval must execute the tool and the transcript must replay on a
 * follow-up turn. This mirrors channels such as Telegram that fall back to the
 * text of a direct reply when it does not target a freeform prompt. For local
 * function tools the `tool-approval-response` part is not a provider-level
 * closure. OpenAI rejects any replay containing a `function_call` without a
 * matching `function_call_output` with `No tool output found for function
 * call call_<id>`.
 */
export default defineEval({
  tags: ["real-model"],
  description: "HITL regression (#236): text approval executes and replays on OpenAI Responses.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "openai-approve".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    parked.notEvent("compaction.completed");
    t.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    // No compaction and no structured `respond()`: this is the payload shape
    // produced when a Telegram reply falls back to an ordinary text message.
    const approved = await t.send("approve");
    approved.expectOk();
    approved.notEvent("compaction.completed");
    approved.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          output: new RegExp(GUARDED_ECHO_OPENAI_TOKEN),
          toolName: "guarded-echo",
        },
        status: "completed",
      },
      count: 1,
    });

    const followup = await t.send("Reply with exactly OPENAI-REPLAY-OK.");
    followup.expectOk();
    followup.notEvent("compaction.completed");
    followup.messageIncludes(/OPENAI-REPLAY-OK/i);

    t.succeeded();
  },
});
