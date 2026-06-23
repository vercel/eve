import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN, guardedEchoResults } from "./shared.js";

/**
 * Separation regression: executable-with-approval and client-resolved are two
 * distinct paths.
 *
 * - Path A — `guarded-echo` is an approval-gated *executable* tool: it parks for
 *   APPROVAL (confirmation), then its `execute` runs and the tool's own output
 *   (the executor token) is the result.
 * - Path B — `ask_question` is client-resolved: it parks for INPUT (not
 *   approval) and the user's answer IS the result; no executor runs.
 *
 * Same parking machinery, opposite result sources — this asserts they don't
 * collapse into one another.
 */
export default defineEval({
  description:
    "Approval-gated execution and client-resolved input are separate paths: approval runs the executor; client input supplies the result.",
  async test(t) {
    // Path A — approval gate on an executable tool.
    await t.send('Call the guarded-echo tool with note "sep".');
    const [approvalRequest] = t.expectInputRequests({ toolName: "guarded-echo" });
    if (approvalRequest === undefined) {
      throw new Error("Expected a guarded-echo approval request.");
    }
    if (approvalRequest.display !== undefined && approvalRequest.display !== "confirmation") {
      throw new Error(
        `Approval must present as a confirmation, got ${String(approvalRequest.display)}.`,
      );
    }
    const approved = await t.respondAll("approve");
    approved.expectOk();
    const [echoed] = guardedEchoResults(t.events);
    if (echoed === undefined || !echoed.includes(GUARDED_ECHO_TOKEN)) {
      throw new Error("Approved executable tool did not run its executor.");
    }

    // Path B — client-resolved input on the same session.
    await t.send(
      [
        "Now use the `ask_question` tool exactly once to ask me which color I prefer.",
        "Set prompt to: 'Pick a color.'",
        'Provide exactly two options: - id "red", label "Red" - id "blue", label "Blue"',
        "Do not answer the question yourself, wait for my response.",
      ].join("\n"),
    );
    const [inputRequest] = t.expectInputRequests({ toolName: "ask_question" });
    if (inputRequest === undefined) {
      throw new Error("Expected an ask_question input request.");
    }
    if (inputRequest.display === "confirmation") {
      throw new Error("Client-resolved input must not present as an approval confirmation.");
    }
    const answered = await t.respondAll("blue");
    answered.expectOk();

    // The client-resolved tool produced no executor result of its own — only the
    // earlier approved guarded-echo did.
    if (guardedEchoResults(t.events).length !== 1) {
      throw new Error("Unexpected extra executor result from the client-resolved path.");
    }

    t.didNotFail();
    t.completed();
    t.messageIncludes(/\bblue\b/i);
  },
});
