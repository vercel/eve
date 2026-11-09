import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { postChannel } from "../custom-channels/shared";

type MessageResponse = { created?: boolean; ok: boolean; sessionId?: string };

/**
 * History passed to `create()` and `send()` becomes real prior conversation: the delivery that
 * brings it records it when a turn consumes it, and the agent answers from it.
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
        (value: MessageResponse) =>
          value.ok === true && value.created === true && typeof value.sessionId === "string",
        "create() creates a session",
      ),
    );

    const firstMessage =
      "Alice again. What was the code word you gave me earlier? Reply with just the word.";
    const firstTurn = t.target.attach(created.sessionId!).watch();
    const first = await postChannel<MessageResponse>(t.target, "/seeded", {
      message: firstMessage,
      sessionRef,
    });
    await t.require(first.sessionId, equals(created.sessionId));
    const turn = await firstTurn.result();
    turn.succeeded();
    turn.event("delivery.consumed", {
      count: 1,
      data: {
        history: [
          { id: "alice-1", role: "user" },
          { id: "agent-1", role: "assistant" },
        ],
        parts: [{ kind: "text", text: firstMessage }],
      },
    });
    turn.messageIncludes("heron");

    const laterMessage =
      "Alice here. What is the checklist code word now? Reply with just the word.";
    const laterTurn = t.target
      .attach(created.sessionId!, {
        startIndex: (turn.events.at(-1)?.meta.position.line ?? -1) + 1,
      })
      .watch();
    await postChannel<MessageResponse>(t.target, "/seeded", {
      message: laterMessage,
      sessionRef,
      withBob: true,
    });
    const later = await laterTurn.result();
    later.succeeded();
    later.event("delivery.consumed", {
      count: 1,
      data: {
        history: [
          { id: "bob-1", role: "user" },
          { id: "agent-2", role: "assistant" },
        ],
        parts: [{ kind: "text", text: laterMessage }],
      },
    });
    later.messageIncludes("egret");
  },
});
