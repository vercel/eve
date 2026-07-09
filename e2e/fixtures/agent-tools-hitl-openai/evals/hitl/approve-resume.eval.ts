import { defineEval } from "eve/evals";

const GUARDED_ECHO_OPENAI_TOKEN = "guarded-echo-openai-ok-R2D7";

/**
 * Regression coverage for https://github.com/vercel/eve/issues/236.
 *
 * An `always()`-gated executable tool on the OpenAI Responses provider:
 * approve-resume must execute the tool and the transcript must replay on a
 * follow-up turn. For local function tools the `tool-approval-response` part
 * is not a provider-level closure. OpenAI rejects any replay containing a
 * `function_call` without a matching `function_call_output` with
 * `No tool output found for function call call_<id>`.
 */
export default defineEval({
  description: "HITL regression (#236): approve-resume executes and replays on OpenAI Responses.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "openai-approve".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const approved = await t.respond({
      requestId: request.requestId,
      optionId: "approve",
    });
    approved.expectOk();
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
    followup.messageIncludes(/OPENAI-REPLAY-OK/i);

    t.succeeded();
  },
});
