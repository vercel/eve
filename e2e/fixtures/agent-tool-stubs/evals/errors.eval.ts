import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "The agent reports an injected tool failure, then uses a successful result on retry.",
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
    const first = await session.send(
      "Alice needs a record lookup. Call lookup_record once with the following input. " +
        "If it fails, quote the tool's error message and wait for Alice to request another attempt. " +
        `Lookup input: ${JSON.stringify(input)}`,
    );
    first.expectOk();
    first.calledTool("lookup_record", { input, status: "failed", count: 1 });
    first.messageIncludes("Record service timed out");

    const retried = await session.send(
      "Alice asks you to retry the record lookup once and report its marker. " +
        `Lookup input: ${JSON.stringify(input)}`,
    );
    retried.expectOk();
    retried.calledTool("lookup_record", {
      input,
      status: "completed",
      output: { marker: "RECOVERED-RECORD" },
      count: 1,
    });
    retried.messageIncludes("RECOVERED-RECORD");
  },
});
