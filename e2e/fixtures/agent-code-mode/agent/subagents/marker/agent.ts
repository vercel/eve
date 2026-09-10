import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Return a deterministic marker for code-mode e2e coverage.",
  model: mockModel(({ lastUserMessage }) => {
    // The delegation prompt wraps the caller's text; echo only that last line.
    const message = (lastUserMessage ?? "").trim().split("\n").at(-1) ?? "";
    if (message === "FAIL-CHILD") throw new Error("Fixture child failed.");
    return `MARKER:${message}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
