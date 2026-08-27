import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Creating an issue from an untrusted session parks on an approval card with the write itself pending; the eval principal is untrusted, so this is also what the dev TUI shows.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    await t.send(
      'Open a new issue on the repository titled "Track the flaky login test" with a one-line body. No need to summarize the repo first.',
    );
    t.parked();
    t.requireInputRequest({ toolName: "github__createIssue" });
    t.calledTool("github__createIssue", { status: "pending" });
  },
});
