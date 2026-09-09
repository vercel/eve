import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "Queued channel requests run separately in arrival order with their original auth.",
  timeoutMs: 240_000,
  async test(t) {
    const threadId = crypto.randomUUID();
    const post = async (message: string, actor: "alice" | "bob" | "carol" | null) => {
      const response = await t.target.fetch(`/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor, message, turnPolicy: "queue" }),
      });
      if (!response.ok) throw new Error(`Message delivery failed (${response.status}).`);
      return (await response.json()) as { sessionId: string };
    };

    const { sessionId } = await post("Please wait for cancellation.", "alice");
    const active = t.target.watchTurn(sessionId);
    await active.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some(
            (action) => action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
          ),
      },
    });

    const requests = [
      { actor: "bob", marker: "bob-first" },
      { actor: "carol", marker: "carol-first" },
      { actor: "carol", marker: "carol-second" },
      { actor: null, marker: "guest-first" },
    ] as const;
    const messages: string[] = [];
    for (const { actor, marker } of requests) {
      const message = `The team is recording separate work requests. Please call record-request with marker "${marker}" exactly once for this request, then report its result.`;
      messages.push(message);
      const accepted = await post(message, actor);
      t.check(accepted.sessionId, equals(sessionId));
    }

    // Cancellation releases the held turn only after every follow-up is accepted.
    const stop = await t.target.fetch(`/threads/${threadId}/stop`, { method: "POST" });
    if (!stop.ok) throw new Error(`Stop failed (${stop.status}).`);
    const cancelled = await active.result();
    cancelled.event("turn.cancelled", { count: 1 });
    cancelled.notEvent("turn.failed");

    let cursor = active.session.state?.streamIndex;
    if (cursor === undefined) throw new Error("Missing stream cursor after cancellation.");
    const turnIds = new Set<string>();
    const deliveryIds = new Set<string>();
    for (const [index, { actor, marker }] of requests.entries()) {
      const live = t.target.watchTurn(sessionId, { startIndex: cursor });
      const turn = await live.result();
      turn.expectOk();
      turn.calledTool("record-request", { count: 1, status: "completed" });
      turn.event("message.received", { count: 1, data: { message: messages[index] } });
      turn.event("action.result", {
        count: 1,
        data: {
          status: "completed",
          result: {
            kind: "tool-result",
            toolName: "record-request",
            output: `request=${marker};actor=${actor ?? "anonymous"}`,
          },
        },
      });
      turn.notEvent("turn.cancelled");
      turn.notEvent("turn.failed");
      const received = turn.events.find((event) => event.type === "message.received");
      if (received === undefined) throw new Error("Missing queued message event.");
      await t.require(received.data.message, equals(messages[index]));
      turnIds.add(received.data.turnId);
      const ids = received.meta.deliveryIds ?? [];
      t.check(ids.length, equals(1)).label("the turn belongs to one delivery");
      for (const id of ids) deliveryIds.add(id);
      cursor = live.session.state?.streamIndex;
      if (cursor === undefined) throw new Error("Missing stream cursor after queued turn.");
    }
    t.check(turnIds.size, equals(requests.length)).label("each request owns a distinct turn");
    t.check(deliveryIds.size, equals(requests.length)).label(
      "each request retains its delivery ID",
    );
    t.succeeded();
  },
});
