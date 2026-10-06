import { defineEval } from "eve/evals";

/** Failed tool outputs carry the error message; match its text whatever its wrapping. */
const mentions = (text: string) => (value: unknown) => JSON.stringify(value).includes(text);

export default defineEval({
  description:
    "execute returns each MCP result shape, validates input before a call reaches the server, and suggests the closest tool for an unknown name.",

  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") {
      t.skip("Requires the deterministic mock model to issue the exact calls.");
    }

    const turn = await t.send("KENNEL_MCP_E2E");
    turn.expectOk();

    // structuredContent wins over the text copy of the same result.
    turn.calledTool("kennel__find_pet", {
      count: 1,
      output: { petId: 4217, name: "Biscuit", kennel: "B3" },
    });
    // A text result without an output schema is parsed as JSON, and the
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
    turn.calledTool("kennel__pet_photo", { count: 1, output: mentions('"type":"image"') });
    t.messageIncludes("photo-image-parts=1");
    // An isError result fails the call.
    turn.calledTool("kennel__discharge_pet", {
      count: 1,
      output: mentions("adoption is in progress"),
      status: "failed",
    });

    // Invalid input and an unknown name fail validation, so neither becomes a
    // connection call. The model reads the signature from the first error and
    // corrects the booking, and the second error suggests the closest tool.
    t.messageIncludes("suggestion=yes");
    // The corrected booking is the only one the server sees.
    turn.calledTool("kennel__book_visit", {
      count: 1,
      output: { visitId: "V-88", petId: 4217, visit: { kind: "grooming" } },
    });
    t.messageIncludes("KENNEL_MCP_DONE");
  },
});
