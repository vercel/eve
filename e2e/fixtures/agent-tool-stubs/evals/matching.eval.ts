import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A model consumes a response sequence within and across turns and executes unmatched calls live.",
  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "urgent-open",
          tool: "lookup_record",
          match: {
            filter: {
              type: "object",
              properties: { status: { const: "open" } },
              required: ["status"],
            },
            query: { type: "string", pattern: "\\b[Mm]ilk\\b" },
            tags: { type: "array", contains: { const: "urgent" } },
          },
          outcomes: [
            { response: { marker: "pending" } },
            { response: { marker: "MATCH-FIRST" } },
            { response: { marker: "MATCH-NEXT" } },
          ],
        },
        {
          id: "open-fallback",
          tool: "lookup_record",
          match: {
            filter: {
              type: "object",
              properties: { status: { const: "open" } },
              required: ["status"],
            },
          },
          outcome: { response: { marker: "FALLBACK" } },
        },
      ],
    });
    const matching = {
      filter: { status: "open", owner: "alice" },
      query: "buy milk",
      tags: ["personal", "urgent"],
      limit: 10,
    };
    const first = await session.send(
      `Alice is checking a record. Call lookup_record with this input. If its marker is pending, call it again with the same input. Report the final marker. Lookup input: ${JSON.stringify(matching)}`,
    );
    first.expectOk();
    first.calledTool("lookup_record", { input: matching, count: 2 });
    first.calledTool("lookup_record", { output: { marker: "pending" }, count: 1 });
    first.calledTool("lookup_record", { output: { marker: "MATCH-FIRST" }, count: 1 });
    first.messageIncludes("MATCH-FIRST");

    const next = await session.send(
      `Alice needs a fresh lookup of the same record. Call lookup_record once and report its marker. Lookup input: ${JSON.stringify(matching)}`,
    );
    next.expectOk();
    next.calledTool("lookup_record", { output: { marker: "MATCH-NEXT" }, count: 1 });
    next.messageIncludes("MATCH-NEXT");

    const unmatched = { ...matching, filter: { status: "closed", owner: "alice" } };
    const live = await session.send(
      `Alice also needs the closed record. Call lookup_record once and report its marker. Lookup input: ${JSON.stringify(unmatched)}`,
    );
    live.expectOk();
    live.calledTool("lookup_record", {
      input: unmatched,
      output: { marker: "LIVE-LOOKUP" },
      count: 1,
    });
    live.messageIncludes("LIVE-LOOKUP");
    t.noFailedActions();
  },
});
