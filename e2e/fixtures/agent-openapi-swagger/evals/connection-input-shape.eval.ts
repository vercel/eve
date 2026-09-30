import { defineEval, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const ADD_PET_TOOL = "petstore__addPet";

export default defineEval({
  tags: ["real-model"],
  description:
    "A real model builds a nested connection_execute input from the connection_search signature.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice runs the Maple Street pet store, whose store id is `maple-street`.",
        "This morning she took in a golden retriever named Biscuit. He is ready for adoption,",
        "belongs in the Dogs category, and his photo is at https://example.com/photos/biscuit.jpg.",
        "Use `connection_search` to find how to add a pet in the `petstore` connection, then add",
        "Biscuit with `connection_execute`. Reply with the id the store assigns to him.",
      ].join(" "),
    );

    turn.expectOk();
    t.toolOrder(["connection_search", "connection_execute"]);
    // The nested action carries the operation's HTTP result.
    t.calledTool(ADD_PET_TOOL, { output: isStoredBiscuit });
    t.messageIncludes("4217");

    // Tracked, not gated: how often the first attempt already had the right shape.
    t.check(
      firstAddPetSucceeded(turn),
      satisfies(
        (succeeded: boolean) => succeeded,
        "the first addPet call has a valid input shape",
      ).soft(),
    );
  },
});

function isStoredBiscuit(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { status, body } = value as { status?: unknown; body?: Record<string, unknown> };
  const category = body?.category as { name?: unknown } | undefined;
  return (
    status === 200 &&
    body?.id === 4217 &&
    body.storeId === "maple-street" &&
    body.name === "Biscuit" &&
    body.status === "available" &&
    typeof category?.name === "string" &&
    /dog/iu.test(category.name) &&
    Array.isArray(body.photoUrls) &&
    body.photoUrls.includes("https://example.com/photos/biscuit.jpg")
  );
}

/** Whether the first connection_execute call for addPet completed with a 200 response. */
function firstAddPetSucceeded(turn: EveEvalTurn): boolean {
  const first = turn.events
    .flatMap((event) => (event.type === "actions.requested" ? event.data.actions : []))
    .find(
      (action) =>
        action.kind === "tool-call" &&
        action.toolName === "connection_execute" &&
        (action.input as { tool?: unknown }).tool === "addPet",
    );
  if (first === undefined) return false;
  const result = turn.events.find(
    (event) => event.type === "action.result" && event.data.result.callId === first.callId,
  );
  if (result?.type !== "action.result" || result.data.status !== "completed") return false;
  return (result.data.result as { output?: { status?: unknown } }).output?.status === 200;
}
