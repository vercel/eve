import { defineEval } from "eve/evals";

import { postChannel } from "./shared";

export default defineEval({
  description: "A channel uses per-delivery state to label Alice's meeting notes.",
  async test(t) {
    const { sessionId } = await postChannel<{ sessionId: string }>(t.target, "/delivery", {});
    const turn = await t.target.attach(sessionId).watch().result();
    turn.succeeded();
    turn.event("delivery.admitted", { data: { source: { channel: "channel:delivery" } } });
    turn.event("delivery.consumed", {
      data: { parts: [{ kind: "text", text: "Alice: Please acknowledge the meeting notes." }] },
    });
  },
});
