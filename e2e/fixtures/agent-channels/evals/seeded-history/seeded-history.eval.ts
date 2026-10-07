import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { postChannel } from "../custom-channels/shared";

type MessageResponse = { ok: boolean; sessionId?: string };

function importedBeforeReceived(types: readonly string[]): boolean {
  const imported = types.indexOf("history.imported");
  return imported !== -1 && imported < types.indexOf("message.received");
}

/**
 * History passed to `create()` and `send()` becomes real prior conversation:
 * the stream publishes it before the turn it joins, and the agent answers
 * from it.
 */
export default defineEval({
  description: "A channel starts a session from prior history and adds more on a later message.",

  async test(t) {
    const sessionRef = crypto.randomUUID();
    const created = await postChannel<MessageResponse>(t.target, "/seeded", {
      mode: "create",
      sessionRef,
    });
    await t.require(
      created,
      satisfies(
        (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
        "create() returns a session",
      ),
    );

    const firstTurn = t.target.watchTurn(created.sessionId!);
    const first = await postChannel<MessageResponse>(t.target, "/seeded", {
      message: "Alice again. What was the code word you gave me earlier? Reply with just the word.",
      sessionRef,
    });
    await t.require(first.sessionId, equals(created.sessionId));
    const turn = await firstTurn.result();
    turn.succeeded();
    await t.require(
      turn.events.map((event) => event.type),
      satisfies(importedBeforeReceived, "created history precedes the first message"),
    );
    turn.messageIncludes("heron");

    const laterTurn = t.target.watchTurn(created.sessionId!, { startIndex: turn.events.length });
    await postChannel<MessageResponse>(t.target, "/seeded", {
      message: "Alice here. What is the checklist code word now? Reply with just the word.",
      sessionRef,
      withBob: true,
    });
    const later = await laterTurn.result();
    later.succeeded();
    await t.require(
      later.events.map((event) => event.type),
      satisfies(importedBeforeReceived, "sent history precedes its message"),
    );
    later.messageIncludes("egret");
  },
});
