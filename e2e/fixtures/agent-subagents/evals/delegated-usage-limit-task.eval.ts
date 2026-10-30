import { defineEval } from "eve/evals";

import { SURVEY_DIRECTIVE } from "../constants";
import { expectSurveyCountedAgainstParent } from "./delegated-usage-limit.shared";

/** The parent starts one survey-worker task and waits for it; the task's reply carries its usage. */
export default defineEval({
  description:
    "An agent task's token usage counts against the parent's session limit and continuation prompt.",
  timeoutMs: 90_000,
  async test(t) {
    const session = await expectSurveyCountedAgainstParent(
      t,
      `${SURVEY_DIRECTIVE} Alice asks for the tide station survey.`,
    );
    session.event("task.started", { count: 1, data: { name: "survey-worker" } });
  },
});
