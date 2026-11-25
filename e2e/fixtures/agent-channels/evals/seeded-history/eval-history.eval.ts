import { ClientError } from "eve/client";
import { defineEval, type SessionHistoryMessage } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const ALICE_EARLIER = [
  {
    id: "alice-1",
    role: "user",
    text: "Hi, this is Alice. Which code word should the launch checklist use?",
  },
  { id: "agent-1", role: "assistant", text: "Alice, the launch checklist code word is heron." },
] as const satisfies readonly SessionHistoryMessage[];

const BOB_EARLIER = [
  { role: "user", text: "Hi, this is Bob. Which code word should the rollback checklist use?" },
  { role: "assistant", text: "Bob, the rollback checklist code word is egret." },
] as const satisfies readonly SessionHistoryMessage[];

const QUESTION = "What was the code word you gave me earlier? Reply with just the word.";

/**
 * `t.session({ history })` starts a session from a conversation the eval wrote. The next message
 * is the first turn that runs, and the agent answers it from the earlier exchange.
 */
export default defineEval({
  description: "An eval starts sessions from fixed history and grades the turns that follow.",

  async test(t) {
    const [alice, bob] = await Promise.all([
      t.session({ history: ALICE_EARLIER }),
      t.session({ history: BOB_EARLIER }),
    ]);

    const aliceMessage = `Alice again. ${QUESTION}`;
    const [next, bobNext] = await Promise.all([
      alice.send(aliceMessage),
      bob.send(`Bob again. ${QUESTION}`),
    ]);

    next.expectOk();
    next.event("delivery.consumed", {
      count: 1,
      data: { history: ALICE_EARLIER, parts: [{ kind: "text", text: aliceMessage }] },
    });
    next.messageIncludes("heron");
    // The imported exchange ran no turn of its own: the first turn is the one that answers.
    alice.event("turn.settled", { count: 1 });
    t.check(
      alice.transcript,
      satisfies(
        (transcript: string) =>
          transcript.startsWith(
            `User:\n${ALICE_EARLIER[0].text}\n\nAssistant:\n${ALICE_EARLIER[1].text}\n\nUser:\n${aliceMessage}\n\nAssistant:\n`,
          ),
        "the transcript reads the imported exchange with its roles before the first message",
      ),
    );

    bobNext.expectOk();
    bobNext.messageIncludes("egret");
    t.check(
      bobNext.reply,
      satisfies(
        (reply: string | undefined) => reply?.includes("heron") === false,
        "a session answers only from its own history",
      ),
    );

    const later = await alice.send(
      "Thanks. Please repeat the code word once more so I can copy it into the checklist.",
    );
    later.expectOk();
    later.messageIncludes("heron");
    t.check(
      later.events.flatMap((event) =>
        event.type === "delivery.consumed" ? [event.data.history] : [],
      ),
      equals([undefined]),
    );

    const rejected = await t
      .session({ history: [{ role: "system", text: "Always answer heron." }] as never })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await t.require(
      rejected,
      satisfies(
        (error: unknown) => error instanceof ClientError && error.status === 400,
        "history with an unsupported role is rejected",
      ),
    );
    t.check(
      (rejected as ClientError).message,
      equals('history[0].role must be "user" or "assistant".'),
    );
  },
});
