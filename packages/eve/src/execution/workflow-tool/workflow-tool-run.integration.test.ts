import { describe, expect, it } from "vitest";
import { ownerInboxTestWorkflow } from "#internal/testing/owner-inbox-workflow.js";
import {
  confirmDeployWorkflow,
  failingDeployWorkflow,
  reportingDeployWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { readStartedOwner } from "#execution/inbox/readiness.js";
import { sendInbox } from "#execution/inbox/send.js";
import { start } from "#internal/workflow/runtime.js";

function workflowId(body: (...args: never[]) => unknown): string {
  const id = Reflect.get(body, "workflowId");
  if (typeof id !== "string") throw new Error("Expected compiled workflow fixture.");
  return id;
}

describe("unified owner transport", () => {
  it("claims before publication and retains ordered arrivals", async () => {
    const run = await start(ownerInboxTestWorkflow, [{ token: "owner-test:ordered", count: 2 }]);
    const address = await readStartedOwner(run.runId);
    await sendInbox(address, { eventId: "one", kind: "session.submit", payload: "one" });
    await sendInbox(address, { eventId: "two", kind: "session.submit", payload: "two" });
    expect((await run.returnValue).map((event) => event.payload)).toEqual(["one", "two"]);
  });

  it("resolves duplicate starts to the claimed owner without polling", async () => {
    const first = await start(ownerInboxTestWorkflow, [{ token: "owner-test:conflict", count: 1 }]);
    const owner = await readStartedOwner(first.runId);
    const second = await start(ownerInboxTestWorkflow, [
      { token: "owner-test:conflict", count: 1 },
    ]);
    expect(await readStartedOwner(second.runId)).toEqual(owner);
    await expect(second.returnValue).resolves.toEqual([]);
    await sendInbox(owner, { eventId: "finish", kind: "session.submit", payload: "done" });
    await first.returnValue;
  });

  it("answers a workflow question using the tool's existing inbox", async () => {
    const run = await start(ownerInboxTestWorkflow, [
      { token: "owner-test:ask", toolWorkflowId: workflowId(confirmDeployWorkflow) },
    ]);
    const received = await run.returnValue;
    expect(received.map((event) => event.kind)).toEqual(["tool.request", "tool.outcome"]);
    expect(received[0]!.payload).toMatchObject({ replyTo: { kind: "inbox" } });
    expect(received[1]!.payload).toMatchObject({
      result: { status: "completed", output: { approved: true, service: "api" } },
    });
  });

  it("preserves report ordering before a terminal outcome", async () => {
    const run = await start(ownerInboxTestWorkflow, [
      { token: "owner-test:report", toolWorkflowId: workflowId(reportingDeployWorkflow) },
    ]);
    expect((await run.returnValue).map((event) => event.kind)).toEqual([
      "tool.report",
      "tool.outcome",
    ]);
  });

  it("returns authored failures through the same owner inbox", async () => {
    const run = await start(ownerInboxTestWorkflow, [
      { token: "owner-test:failure", toolWorkflowId: workflowId(failingDeployWorkflow) },
    ]);
    expect((await run.returnValue)[0]!.payload).toMatchObject({
      result: { status: "failed", error: { message: "deploy of api exploded" } },
    });
  });
});
