import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { checkPatterns } from "../../agent/lib/email/config.js";

const statuses = (
  body: string,
  plainText: string | undefined,
  sendType: "broadcast" | "one-off"
) => checkPatterns(body, plainText, sendType).map((row) => row.status);

export default defineEval({
  description:
    "checkPatterns fails a broadcast with no unsubscribe placeholder, bare names, or no plain " +
    "text.",
  test(t) {
    t.check(
      statuses(
        "Hi {{{FIRST_NAME}}}, the sale ends Friday.",
        undefined,
        "broadcast"
      ),
      equals(["fail", "fail", "fail"])
    );
    t.check(
      statuses(
        "Hi {{{FIRST_NAME|there}}}. Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}",
        "Hi there.",
        "broadcast"
      ),
      equals(["pass", "pass", "pass"])
    );
    t.check(
      statuses("Hi {{{FIRST_NAME|there}}}.", "Hi there.", "one-off"),
      equals(["unsure", "pass", "pass"])
    );
  },
});
