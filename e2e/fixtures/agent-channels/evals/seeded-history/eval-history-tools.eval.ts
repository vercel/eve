import { defineEval, type SessionHistoryMessage } from "eve/evals";

const EARLIER = [
  { role: "user", text: "Hi, this is Alice. Is ticket T-1 still open?" },
  {
    role: "assistant",
    parts: [
      {
        type: "tool",
        name: "lookup_ticket",
        input: { id: "T-1" },
        output: { owner: "Bob", status: "open" },
      },
      {
        type: "tool",
        name: "list_notes",
        input: { id: "T-1" },
        error: "The notes service timed out.",
      },
      {
        type: "text",
        text: "Alice, ticket T-1 is open and Bob owns it, but I could not load its notes.",
      },
    ],
  },
] as const satisfies readonly SessionHistoryMessage[];

/**
 * Assistant history entries accept ordered `parts` carrying completed tool calls and text.
 * The model reads each call and its result as prior conversation, and eve runs none of them.
 */
export default defineEval({
  description: "An eval starts a session from structured history with completed tool calls.",

  async test(t) {
    if (!t.target.capabilities.devRoutes) {
      t.skip("Target has no dev routes; fixed session history is dev-only.");
    }

    const session = await t.session({ history: EARLIER });

    const message = "Alice again. Please list the tool results you have for ticket T-1.";
    const turn = await session.send(message);
    turn.expectOk();
    turn.event("delivery.consumed", {
      count: 1,
      data: {
        history: [
          { role: "user", text: EARLIER[0].text },
          {
            parts: EARLIER[1].parts,
            role: "assistant",
            text: EARLIER[1].parts[2].text,
          },
        ],
        parts: [{ kind: "text", text: message }],
      },
    });
    turn.messageIncludes(
      '{"isError":false,"name":"lookup_ticket","output":{"owner":"Bob","status":"open"}}',
    );
    turn.messageIncludes(
      '{"isError":true,"name":"list_notes","output":"The notes service timed out."}',
    );
    turn.usedNoTools();
    session.event("turn.settled", { count: 1 });
  },
});
