import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { postChannel } from "./shared";

export default defineEval({
  description:
    "Idle session allocation and replayed fixed-session admission produce one turn per operation.",
  async test(t) {
    const address = `admission-${crypto.randomUUID()}`;
    const [first, concurrent] = await Promise.all([
      postChannel<{ sessionId: string }>(t.target, "/admission", { address }),
      postChannel<{ sessionId: string }>(t.target, "/admission", { address }),
    ]);
    await t.require(first.sessionId, equals(concurrent.sessionId));
    const request = {
      address,
      sessionId: first.sessionId,
      operationId: "one",
      message: "Reply with exactly: admitted-once",
    };
    const accepted = await postChannel<{ deliveryId: string }>(t.target, "/admission", request);
    const turn = await t.target.watchTurn(first.sessionId).result();
    turn.expectOk();
    turn.event("message.received", { count: 1, data: { message: request.message } });
    const replay = await postChannel<{ deliveryId: string }>(t.target, "/admission", request);
    await t.require(replay.deliveryId, equals(accepted.deliveryId));
    const next = t.target.watchTurn(first.sessionId, { startIndex: turn.events.length });
    await postChannel(t.target, "/admission", {
      ...request,
      operationId: "two",
      message: "Reply with exactly: second-operation",
    });
    const second = await next.result();
    second.expectOk();
    second.event("message.received", {
      count: 1,
      data: { message: "Reply with exactly: second-operation" },
    });
  },
});
