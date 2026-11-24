import { defineEval } from "eve/evals";

export default defineEval({
  description: "A tool extracts typed fields with sources and returns them with usage.",
  async test(t) {
    const turn = await t.send(
      "Alice uses extract-request to read the invoice number and contacts from her invoice.",
    );
    turn.expectOk();
    turn.calledTool("extract-request");
    turn.messageIncludes('"isError":false');
    turn.messageIncludes('"invoiceNumber":"INV-2041"');
    turn.messageIncludes('"source":{"type":"text","part":0,"start":8,"end":16}');
    turn.messageIncludes('"contacts":["Ana","Bo"]');
    turn.messageIncludes('"totalTokens":34');
    t.succeeded();
  },
});
