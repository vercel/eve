import { defineEval } from "eve/evals";
export default defineEval({
  description:
    "A principal-owned subscription derives an email destination from creator identity and executes its task through an authored channel.",
  async test(t) {
    if (!t.target.capabilities.devRoutes)
      t.skip("Schedule collection invocation requires dev routes.");
    const turn = await t.send(
      "Alice is setting up a one-time email reminder for January 1, 2030. Create the schedule named collection-email with a payload task to send a fixture email with subject Scheduled note and body A fixture note., and destination creator-email. Confirm the schedule is saved and do not send the email now.",
    );
    turn.expectOk();
    const approval = turn.session.requireInputRequest({
      display: "confirmation",
      toolName: "schedule__requests__manage",
    });
    const created = await turn.session.respond([
      { optionId: "approve", requestId: approval.requestId },
    ]);
    created.expectOk();
    created.session.calledTool("schedule__requests__manage", {
      input: {
        operation: "create",
        name: "collection-email",
        payload: { destination: "creator-email" },
      },
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
      throw new Error("Dynamic invocation did not return its dispatched session.");
    const scheduled = await t.target.attachSession(sessionId);
    scheduled.succeeded();
    scheduled.calledTool("record-email", {
      input: { to: "alice@example.test", subject: "Scheduled note" },
      output: { recipient: "alice@example.test", accepted: true },
    });
    // The authored outbox channel records the scheduled session's reply.
    const delivered = await t.send("Use share-schedule to read what collection-email delivered.");
    delivered.succeeded();
    const content = delivered.toolCalls.find(
      (call) => call.name === "share-schedule" && call.input.operation === "delivery",
    )?.output;
    if (typeof Reflect.get(Object(content), "content") !== "string")
      throw new Error("The outbox channel did not record the occurrence's result.");
    t.succeeded();
  },
});
