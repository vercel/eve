import { ClientError } from "eve/client";
import { defineEval, type SessionHistoryMessage } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const EARLIER = [
  { role: "user", text: "Hi, this is Alice. Is ticket T-1 still open?" },
  {
    role: "assistant",
    text: "Alice, ticket T-1 is open and Bob owns it, but I could not load its notes.",
    toolCalls: [
      { name: "lookup_ticket", input: { id: "T-1" }, output: { owner: "Bob", status: "open" } },
      { name: "list_notes", input: { id: "T-1" }, error: "The notes service timed out." },
    ],
  },
] as const satisfies readonly SessionHistoryMessage[];

/**
 * History can carry the tool calls an assistant message made. The agent reads each call and its
 * result as part of the earlier conversation, and eve runs none of them.
 */
export default defineEval({
  description: "An eval starts a session from history with completed tool calls.",

  async test(t) {
    const session = await t.session({ history: EARLIER });

    const message = "Alice again. Please list the tool results you have for ticket T-1.";
    const turn = await session.send(message);
    turn.expectOk();
    turn.event("delivery.consumed", {
      count: 1,
      data: { history: EARLIER, parts: [{ kind: "text", text: message }] },
    });
    turn.messageIncludes(
      '{"isError":false,"name":"lookup_ticket","output":{"owner":"Bob","status":"open"}}',
    );
    turn.messageIncludes(
      '{"isError":true,"name":"list_notes","output":"The notes service timed out."}',
    );
    // The imported calls are conversation the agent reads, not calls it made.
    turn.usedNoTools();
    session.event("turn.settled", { count: 1 });

    const rejected = await t
      .session({
        history: [{ role: "assistant", text: "Checking.", toolCalls: [{ name: "lookup_ticket" }] }],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await t.require(
      rejected,
      satisfies(
        (error: unknown) => error instanceof ClientError && error.status === 400,
        "a tool call without a result is rejected",
      ),
    );
    t.check(
      (rejected as ClientError).message,
      equals("history[0].toolCalls[0] must have exactly one of output or error."),
    );
  },
});
