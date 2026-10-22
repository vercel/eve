import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A dynamic-only event receiver is present in the built fixture and rejects deliveries without Connect authorization.",
  async test(t) {
    const response = await t.target.fetch("/eve/v1/hooks/runtime-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    // Local worlds have no project identity; deployed worlds verify and reject the missing token.
    if (response.status !== 401 && response.status !== 503)
      throw new Error(
        `Expected the event receiver to reject an unauthenticated delivery, got ${response.status}.`,
      );
    if ((await response.text()) !== "")
      throw new Error("The receiver must not expose configuration or account data.");
  },
});
