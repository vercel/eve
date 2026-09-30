import { defineEval } from "eve/evals";

/** Failed tool outputs carry the error message; match its text whatever its wrapping. */
const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

export default defineEval({
  description:
    "connection_execute returns each MCP result shape, and its errors let the model correct a call.",

  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic mock model to issue the exact calls.");
    }

    const turn = await t.send("KENNEL_MCP_E2E");
    turn.expectOk();
    t.succeeded();

    // structuredContent wins over the text copy of the same result.
    turn.calledTool("kennel__find_pet", {
      count: 1,
      output: { petId: 4217, name: "Biscuit", kennel: "B3" },
    });
    // Text-only results without an output schema are parsed as JSON, and the
    // omitted `day` reaches the server as its schema default.
    turn.calledTool("kennel__list_feedings", {
      count: 1,
      input: { day: "today" },
      output: (value) =>
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((entry) => (entry as { day?: unknown }).day === "today"),
    });
    // Image content stays MCP content, and the model receives it as a file part.
    turn.calledTool("kennel__pet_photo", {
      count: 1,
      output: mentions('"type":"image"'),
    });
    t.messageIncludes("photo-image-parts=1");

    // isError results fail both the outer call and the nested action.
    turn.calledTool("connection_execute", {
      count: 1,
      status: "failed",
      input: { tool: "discharge_pet" },
      output: mentions("adoption is in progress"),
    });
    turn.calledTool("kennel__discharge_pet", { count: 1, status: "failed" });

    // Invalid input never reaches the server and returns the tool's signature.
    turn.calledTool("connection_execute", {
      count: 1,
      status: "failed",
      input: { tool: "book_visit", input: { petId: "4217" } },
      output: (value) =>
        mentions("Invalid input for")(value) && mentions("book_visit(input:")(value),
    });
    // The corrected call is the only one the server sees.
    turn.calledTool("kennel__book_visit", {
      count: 1,
      output: { visitId: "V-88", petId: 4217, visit: { kind: "grooming" } },
    });

    // An unknown tool name points at the closest real one.
    turn.calledTool("connection_execute", {
      count: 1,
      status: "failed",
      input: { tool: "find_pets" },
      output: mentions("Closest tools: find_pet"),
    });
    t.messageIncludes("KENNEL_MCP_DONE");
  },
});
