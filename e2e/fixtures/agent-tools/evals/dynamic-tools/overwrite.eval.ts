import { defineEval } from "eve/evals";

// session.started and turn.started resolvers merge: the turn-scoped
// `shared` wins over the session-scoped one, while `session_only`
// remains available from session scope.
export default defineEval({
  description: "Dynamic tools smoke: turn-scoped resolver tools win merges over session-scoped.",
  async test(t) {
    const first = await t.send("Call the `shared` tool and report the source and turn values.");
    first.expectOk();

    const second = await t.send("Call the `session_only` tool and report the source value.");
    second.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("shared", {
      isError: false,
      output: { source: "turn" },
    });
    t.calledTool("session_only", {
      isError: false,
      output: { source: "session" },
    });
  },
});
