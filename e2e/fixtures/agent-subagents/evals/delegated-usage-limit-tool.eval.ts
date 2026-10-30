import { defineEval } from "eve/evals";

import { SURVEY_TOOL_DIRECTIVE } from "../constants";
import { expectSurveyCountedAgainstParent } from "./delegated-usage-limit.shared";

/**
 * The parent calls a workflow tool that opens a `ctx.agent` session with
 * survey-worker; the tool's outcome carries the session's usage.
 */
export default defineEval({
  description:
    "A workflow tool's ctx.agent token usage counts against the parent's session limit and continuation prompt.",
  timeoutMs: 90_000,
  async test(t) {
    const session = await expectSurveyCountedAgainstParent(
      t,
      `${SURVEY_TOOL_DIRECTIVE} Alice asks for the tide station survey.`,
    );
    session.calledTool("survey-through-tool", { count: 1 });
  },
});
