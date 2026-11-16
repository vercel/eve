import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An ambiguous work item stops the pipeline at classification: the agent asks the requester instead of building on guesses, and nothing reaches the implementer.",
  tags: ["slow"],
  async test(t) {
    const turn = await t.send(
      "Alice has asked Bob to investigate an email problem, but the ticket only says that an email is wrong. Help them identify which message, what happened, and what should happen before planning a change."
    );
    t.calledTool("triage_work_item");
    t.calledAgent("classifier");
    t.calledAgent("implementer", { count: 0 });
    t.calledAgent("reviewer", { count: 0 });
    t.judge(
      "Does the submission ask the user specific clarifying questions about which email problem they mean, rather than proceeding to build something or claiming work was done?",
      {
        on: turn.reply || "(the run parked on a question instead of replying)",
      }
    ).atLeast(0.5);
  },
});
