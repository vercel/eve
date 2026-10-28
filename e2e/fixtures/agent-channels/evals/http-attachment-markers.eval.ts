import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice's HTTP client uses ordinary file data rather than adapter-owned attachment markers.",
  tags: ["client", "regression"],
  async test(t) {
    const session = await t.session();
    for (const path of ["/eve/v1/session", `/eve/v1/session/${encodeURIComponent(session.id)}`]) {
      const response = await t.target.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: [{ type: "file", mediaType: "image/png", data: "chat-sdk-file:?p=placeholder" }],
        }),
        signal: t.abortSignal,
      });
      await t.require(response.status, equals(400));
      await t.require((await response.json()).ok, equals(false));
    }
  },
});
