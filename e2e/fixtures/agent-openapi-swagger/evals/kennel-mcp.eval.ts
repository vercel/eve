import { defineEval, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  tags: ["real-model"],
  description:
    "A real model reads an MCP tool's structured result and builds a nested MCP tool input from its signature.",

  async test(t) {
    const turn = await t.send(
      [
        "Bob works the front desk at the Maple Street kennel. Biscuit, a boarding golden retriever,",
        "needs a grooming visit on October 14, 2026. Alice (555-0100) should be notified about it.",
        "Use `connection_search` on the `kennel` connection to find the tools you need, look up",
        "Biscuit's pet id, then book the visit with `connection_execute`.",
        "Reply with the visit id the kennel returns.",
      ].join(" "),
    );

    turn.expectOk();
    t.calledTool("connection_search");
    // The pet id comes from find_pet's structured result, not the prompt.
    t.calledTool("kennel__find_pet", { output: { petId: 4217 } });
    t.calledTool("kennel__book_visit", {
      count: 1,
      output: {
        visitId: "V-88",
        petId: 4217,
        visit: { kind: "grooming", date: "2026-10-14" },
        contacts: [{ name: /alice/iu, phone: /555-0100/u }],
      },
    });
    t.messageIncludes("V-88");

    // Tracked, not gated: whether the model built the nested input on its first try.
    t.check(
      firstBookingSucceeded(turn),
      satisfies(
        (succeeded: boolean) => succeeded,
        "the first book_visit call has a valid input shape",
      ).soft(),
    );
  },
});

function firstBookingSucceeded(turn: EveEvalTurn): boolean {
  const first = turn.events
    .flatMap((event) => (event.type === "actions.requested" ? event.data.actions : []))
    .find(
      (action) =>
        action.kind === "tool-call" &&
        action.toolName === "connection_execute" &&
        (action.input as { tool?: unknown }).tool === "book_visit",
    );
  if (first === undefined) return false;
  const result = turn.events.find(
    (event) => event.type === "action.result" && event.data.result.callId === first.callId,
  );
  return result?.type === "action.result" && result.data.status === "completed";
}
