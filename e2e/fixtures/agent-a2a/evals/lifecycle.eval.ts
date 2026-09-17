import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

type Task = { id: string; contextId: string; status: { state: string }; artifacts?: unknown[] };
type Reply<T> = { result: T; error?: { code: number } };
async function rpc<T>(
  target: EveEvalTargetHandle,
  method: string,
  params: object,
  principal = "alice",
): Promise<Reply<T>> {
  const response = await target.fetch("/eve/v1/a2a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "a2a-version": "1.0",
      "x-e2e-principal": principal,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  if (!response.ok) throw new Error(`A2A HTTP ${response.status}`);
  return (await response.json()) as Reply<T>;
}
function message(text: string, taskId?: string) {
  return {
    message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], taskId },
    configuration: { returnImmediately: true, historyLength: 0 },
  };
}
async function settled(target: EveEvalTargetHandle, id: string): Promise<Task> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await rpc<Task>(target, "GetTask", { id, historyLength: 0 });
    if (response.error) throw new Error(`GetTask failed: ${response.error.code}`);
    if (!["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"].includes(response.result.status.state))
      return response.result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("A2A task did not settle.");
}
export default defineEval({
  description:
    "A2A discovery, ownership, input continuation, artifacts, cancellation, and SSE across workflow worlds.",
  async test(t) {
    const card = await t.target.fetch("/.well-known/agent-card.json");
    await t.require(card.status, equals(200));
    await t.require(
      JSON.stringify(await card.json()),
      satisfies(
        (value: string) => value.includes('"protocolVersion":"1.0"'),
        "card advertises A2A 1.0",
      ),
    );
    const unauthorized = await t.target.fetch("/eve/v1/a2a", { method: "POST", body: "{}" });
    await t.require(unauthorized.status, equals(401));
    const started = await rpc<{ task: Task }>(
      t.target,
      "SendMessage",
      message("Help Alice choose a city for her trip."),
    );
    const id = started.result.task.id;
    await t.require(
      (await settled(t.target, id)).status.state,
      equals("TASK_STATE_INPUT_REQUIRED"),
    );
    for (const method of ["GetTask", "CancelTask", "SubscribeToTask"]) {
      await t.require((await rpc(t.target, method, { id }, "bob")).error?.code, equals(-32001));
    }
    await rpc(t.target, "SendMessage", message("Paris", id));
    const completed = await settled(t.target, id);
    await t.require(completed.status.state, equals("TASK_STATE_COMPLETED"));
    await t.require(
      JSON.stringify(completed.artifacts),
      satisfies(
        (value: string) => value.includes("itinerary is ready"),
        "completed task contains its result",
      ),
    );
    const listing = await rpc<{ tasks: Task[]; totalSize: number }>(t.target, "ListTasks", {
      contextId: id,
    });
    await t.require(listing.result.totalSize, equals(1));
    await t.require(listing.result.tasks[0]?.artifacts, equals(undefined));
    const otherListing = await rpc<{ totalSize: number }>(
      t.target,
      "ListTasks",
      { contextId: id },
      "bob",
    );
    await t.require(otherListing.result.totalSize, equals(0));
    const pending = await rpc<{ task: Task }>(
      t.target,
      "SendMessage",
      message("Help Bob choose a city for his trip."),
    );
    await settled(t.target, pending.result.task.id);
    await rpc(t.target, "CancelTask", { id: pending.result.task.id });
    await t.require(
      (await settled(t.target, pending.result.task.id)).status.state,
      equals("TASK_STATE_CANCELED"),
    );
    const stream = await t.target.fetch("/eve/v1/a2a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-e2e-principal": "alice",
        "a2a-version": "1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stream",
        method: "SendStreamingMessage",
        params: message("Prepare Alice's itinerary for Paris."),
      }),
    });
    await t.require(stream.headers.get("content-type"), equals("text/event-stream"));
    const events = await stream.text();
    await t.require(
      events,
      satisfies(
        (value: string) =>
          value.includes('"task"') &&
          value.includes('"artifactUpdate"') &&
          value.includes('"TASK_STATE_COMPLETED"'),
        "stream contains a snapshot, artifact, and completion",
      ),
    );
    await t.require(
      (
        await rpc(t.target, "SendMessage", {
          ...message("Plan Alice's trip."),
          tenant: "unsupported",
        })
      ).error?.code,
      equals(-32602),
    );
  },
});
