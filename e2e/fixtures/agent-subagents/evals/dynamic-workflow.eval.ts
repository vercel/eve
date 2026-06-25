import { defineEval } from "eve/evals";

const SUBAGENT_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";

/** Dynamic Workflow smoke: sandboxed JavaScript dispatches a durable child. */
export default defineEval({
  description: "Dynamic Workflow smoke: model-authored JavaScript delegates to a local subagent.",
  async test(t) {
    const turn = await t.send(
      "Use the Workflow tool exactly once. In its JavaScript, call the echo-marker subagent with message 'workflow ping' and return that subagent's output. Do not call echo-marker directly. Then reply with the returned output verbatim.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("Workflow", { times: 1 });
    t.calledSubagent("echo-marker", { output: /SUBAGENT_TOKEN=echo-marker-9F2X/ });
    t.messageIncludes(SUBAGENT_TOKEN);
    t.noFailedActions();
  },
});
