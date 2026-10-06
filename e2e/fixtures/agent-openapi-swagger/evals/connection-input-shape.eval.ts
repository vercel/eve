import { defineEval } from "eve/evals";

const ADD_PET_TOOL = "petstore__addPet";

export default defineEval({
  tags: ["real-model"],
  description:
    "A real model builds a nested connection tool input from the TypeScript signature search returns.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice runs the Maple Street pet store, whose store id is `maple-street`.",
        "This morning she took in a golden retriever named Biscuit. He is ready for adoption,",
        "belongs in the Dogs category, and his photo is at https://example.com/photos/biscuit.jpg.",
        "Please add Biscuit to the store's catalog through the petstore connection,",
        "then tell Alice the id the store assigns to him.",
      ].join(" "),
    );

    turn.expectOk();
    t.calledTool("search");
    t.calledTool(ADD_PET_TOOL, { output: isStoredBiscuit });
    t.messageIncludes("4217");
  },
});

function isStoredBiscuit(value: unknown): boolean {
  const { status, body } = (value ?? {}) as { status?: unknown; body?: Record<string, unknown> };
  const category = body?.category as { name?: unknown } | undefined;
  return (
    status === 200 &&
    body?.id === 4217 &&
    body.storeId === "maple-street" &&
    body.name === "Biscuit" &&
    body.status === "available" &&
    typeof category?.name === "string" &&
    /dog/iu.test(category.name)
  );
}
