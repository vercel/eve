import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice corrects a misspelled request option, then Bob corrects an option sent to the wrong route.",
  tags: ["client", "regression"],
  async test(t) {
    const post = (path: string, body: unknown) =>
      t.target.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: t.abortSignal,
      });
    const message = "Alice is preparing her workday. Reply with a brief greeting.";
    const rejected = await post("/eve/v1/session", { message, outputschema: {} });
    await t.require(rejected.status, equals(400));
    const error = (await rejected.json()) as { error: string };
    await t.require(
      error.error,
      satisfies(
        (text: string) =>
          text.includes("Unknown field 'outputschema'") &&
          text.includes("Accepted fields:") &&
          text.includes("outputSchema"),
        "the error names the typo and the supported option",
      ),
    );

    const created = await post("/eve/v1/session", { message });
    await t.require(created.status, equals(202));
    const { sessionId } = (await created.json()) as { sessionId: string };
    const first = await t.target.attach(sessionId).watch().result();
    first.expectOk();
    first.event("delivery.consumed", { count: 1, data: { parts: [{ text: message }] } });

    const path = `/eve/v1/session/${encodeURIComponent(sessionId)}`;
    const followup = "Bob is joining Alice for the day. Give them a brief acknowledgement.";
    const wrongRoute = await post(path, { message: followup, operationId: crypto.randomUUID() });
    await t.require(wrongRoute.status, equals(400));
    const wrongRouteError = (await wrongRoute.json()) as { error: string };
    await t.require(
      wrongRouteError.error,
      satisfies(
        (text: string) =>
          text.includes("Unknown field 'operationId'") && text.includes("Accepted fields:"),
        "a create-only option is rejected on the follow-up route",
      ),
    );
    const corrected = await post(path, { message: followup });
    await t.require(corrected.status, equals(202));
    const second = await t.target
      .attach(sessionId, { startIndex: (first.events.at(-1)?.meta.position.line ?? -1) + 1 })
      .watch()
      .result();
    second.expectOk();
    second.event("delivery.consumed", { count: 1, data: { parts: [{ text: followup }] } });
  },
});
