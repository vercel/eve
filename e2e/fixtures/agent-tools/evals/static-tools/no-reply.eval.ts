import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

// A turn that ends with the opt-in `no_reply` tool completes without a final
// message, and the session keeps answering later turns normally.
export default defineEval({
  description: "The no_reply tool ends a turn without a reply.",
  async test(t) {
    const quiet = await t.send(
      "Alice is logging a routine note for the team: the nightly backup finished on schedule. The note needs no answer, so end your turn with the `no_reply` tool instead of writing a message.",
    );
    quiet.expectOk();
    quiet.requireToolCall("no_reply");
    t.check(
      quiet.message,
      satisfies((message) => message === undefined, "the turn sends no reply"),
    );

    const followUp = await quiet.session.send(
      "Bob is catching up on the thread. What did Alice's note say about the nightly backup?",
    );
    followUp.expectOk();
    t.check(
      followUp.message,
      satisfies(
        (message) => typeof message === "string" && /backup/iu.test(message),
        "the next turn replies normally",
      ),
    );
    t.succeeded();
  },
});
