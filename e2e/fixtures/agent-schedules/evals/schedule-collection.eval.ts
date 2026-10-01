import { defineEval } from "eve/evals";
export default defineEval({
  description:
    "A principal-owned scheduled task, created with a delivery after approval, calls a fixture tool with the intended recipient.",
  async test(t) {
    if (!t.target.capabilities.devRoutes)
      t.skip("Schedule collection invocation requires dev routes.");
    // Admitting an occurrence needs retained hooks, which the default local world lacks.
    if (process.env.EVE_E2E_WORKFLOW_WORLD === undefined)
      t.skip("Schedule collection occurrences require a Workflow world with retained hooks.");
    const turn = await t.send(
      "Alice is setting up a one-time email reminder for January 1, 2030. Create the schedule named collection-email with a request to use record-email to send a fixture note to alice@example.test with subject Scheduled note, and deliver the result to the fixture-log. Confirm the schedule is saved and do not send the email now.",
    );
    turn.expectOk();
    const approval = turn.session.requireInputRequest({
      display: "confirmation",
      toolName: "schedule__requests__create",
    });
    const created = await turn.session.respond([
      { optionId: "approve", requestId: approval.requestId },
    ]);
    created.expectOk();
    created.session.calledTool("schedule__requests__create", {
      input: { name: "collection-email", deliveries: ["fixture-log"] },
      status: "completed",
    });
    const client = await t.send(
      "Inspect the schedule named collection-email with share-schedule using its get operation.",
    );
    client.succeeded();
    client.calledTool("share-schedule", { input: { operation: "get", name: "collection-email" } });
    const manual = await t.send("Use share-schedule to invoke collection-email once.");
    manual.succeeded();
    manual.calledTool("share-schedule", {
      input: { operation: "invoke", name: "collection-email" },
    });
    const output = manual.toolCalls.find(
      (call) => call.name === "share-schedule" && call.input.operation === "invoke",
    )?.output;
    const sessionId =
      output && typeof output === "object" && !Array.isArray(output)
        ? Reflect.get(output, "sessionId")
        : undefined;
    if (typeof sessionId !== "string")
      throw new Error("Dynamic invocation did not return its admitted session.");
    const scheduled = await t.target.attachSession(sessionId);
    scheduled.succeeded();
    scheduled.calledTool("record-email", {
      input: { to: "alice@example.test", subject: "Scheduled note" },
      output: { recipient: "alice@example.test", accepted: true },
    });
    // eve runs the schedule's delivery once the occurrence settles.
    const delivered = await t.send("Use share-schedule to read what collection-email delivered.");
    delivered.succeeded();
    const content = delivered.toolCalls.find(
      (call) => call.name === "share-schedule" && call.input.operation === "delivery",
    )?.output;
    if (typeof Reflect.get(Object(content), "content") !== "string")
      throw new Error("The fixture-log delivery did not record the occurrence's result.");
    t.succeeded();
  },
});
