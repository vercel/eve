import { defineEval } from "eve/evals";

/**
 * Confirms the decision model answers inside `check_send_readiness` on real models.
 *
 * @remarks
 * The same reason as the lint case: the tool fails open, so only an assertion on `judged` shows a
 * decision model that has stopped answering. Pinned to one delegation and one tool call, and the
 * brief forbids Resend and Notion so nothing is built or sent.
 */
export default defineEval({
  description:
    "check_send_readiness gets answers from the decision model for its copy rules.",
  async test(t) {
    await t.send(
      "Tool test, so skip brand context. Delegate once to the email specialist with this brief: " +
        "'Tool test only. Do not call Resend or Notion. Call check_send_readiness once with " +
        'sendType broadcast, subject "Spring sale ends Friday", body "Hi ' +
        "{{{FIRST_NAME|there}}}, our spring sale ends Friday. Acme Inc, 500 Howard St, San " +
        'Francisco CA 94105. Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}" and plainText "Our ' +
        'spring sale ends Friday." Reply with exactly JUDGED=true or JUDGED=false, matching ' +
        "the judged field.' Then repeat its reply exactly."
    );
    t.succeeded();
    t.calledAgent("email");
    t.messageIncludes("JUDGED=true");
  },
});
