import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "The agent recovers from an injected lookup timeout without a follow-up prompt.",
  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "lookup",
          tool: "lookup_record",
          outcomes: [
            { throw: { name: "TimeoutError", message: "Record service timed out" } },
            { response: { marker: "RECOVERED-RECORD" } },
          ],
        },
      ],
    });
    const input = { filter: { status: "open", owner: "alice" }, query: "milk", tags: [], limit: 1 };
    const turn = await session.send(
      `Alice asks: what is the marker for my open milk record? Lookup input: ${JSON.stringify(input)}`,
    );
    turn.expectOk();
    turn.calledTool("lookup_record", { input, status: "failed", count: 1 });
    turn.calledTool("lookup_record", {
      input,
      status: "completed",
      output: { marker: "RECOVERED-RECORD" },
      count: 1,
    });
    turn.messageIncludes("RECOVERED-RECORD");
  },
});
