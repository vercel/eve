import { defineEval, toolCallsOf } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Queued channel requests batch only adjacent matching identities and retain their auth.",
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
    await active.waitForEvent("call.requested", {
      data: { capability: { name: "wait-for-cancellation" } },
    });

    const groups = [
      { actor: "bob", markers: ["bob-first"] },
      { actor: "carol", markers: ["carol-first", "carol-second"] },
      { actor: "bob", markers: ["bob-second"] },
      { actor: null, markers: ["guest-first"] },
      { actor: null, markers: ["guest-second"] },
    ] as const;
    const messageFor = (marker: string) =>
      `The team is recording work requests. Please call record-request with marker "${marker}" exactly once for this request, then report its result.`;
    for (const { actor, markers } of groups) {
      for (const marker of markers) {
        const accepted = await post(messageFor(marker), actor);
        t.check(accepted.sessionId, equals(sessionId));
      }
    }

    // Cancellation releases the held turn only after every follow-up is accepted.
    const stop = await t.target.fetch(`/threads/${threadId}/stop`, { method: "POST" });
    if (!stop.ok) throw new Error(`Stop failed (${stop.status}).`);
    const cancelled = await active.result();
    cancelled.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });
    cancelled.notEvent("turn.settled", { data: { outcome: "failed" } });

    let cursor = active.session.state?.streamIndex;
    if (cursor === undefined) throw new Error("Missing stream cursor after cancellation.");
    const turnIds = new Set<string>();
    const deliveryIds = new Set<string>();
    for (const { actor, markers } of groups) {
      const live = t.target.watchTurn(sessionId, { startIndex: cursor });
      const turn = await live.result();
      turn.expectOk();
      turn.calledTool("record-request", { count: markers.length, status: "completed" });
      const outputs = toolCallsOf(turn.events).flatMap((call) =>
        call.name === "record-request" && call.status === "completed" ? [call.output] : [],
      );
      t.check(
        outputs,
        equals(markers.map((marker) => `request=${marker};actor=${actor ?? "anonymous"}`)),
      ).label("each request records under its own identity");
      turn.notEvent("turn.settled", { data: { outcome: "cancelled" } });
      turn.notEvent("turn.settled", { data: { outcome: "failed" } });
      // Each batched delivery is consumed into the one turn, in order.
      const received = turn.events.flatMap((event) =>
        event.type === "delivery.consumed" ? [event.data] : [],
      );
      await t.require(
        received.map(({ parts }) =>
          parts.map((part) => (part.kind === "text" ? part.text : "")).join(""),
        ),
        equals(markers.map(messageFor)),
      );
      for (const delivery of received) {
        turnIds.add(delivery.turnId);
        deliveryIds.add(delivery.deliveryId);
      }
      t.check(new Set(received.map((delivery) => delivery.turnId)).size, equals(1)).label(
        "the batch shares one turn",
      );
      cursor = live.session.state?.streamIndex;
      if (cursor === undefined) throw new Error("Missing stream cursor after queued turn.");
    }
    t.check(turnIds.size, equals(groups.length)).label("each identity group owns a distinct turn");
    t.check(deliveryIds.size, equals(groups.flatMap((group) => group.markers).length)).label(
      "each request retains its delivery ID",
    );
    t.succeeded();
  },
});
