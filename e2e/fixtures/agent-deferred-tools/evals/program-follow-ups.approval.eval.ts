import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import type { EveEvalTurn } from "eve/evals";
import { defineEval } from "eve/evals";

const FOLLOW_UP_TOOL = "send_follow_up";
/** The customer whose follow-up Bob declines. */
const DECLINED = /globex/iu;

function customerOf(input: unknown): string {
  const customer = (input as { readonly customer?: unknown } | null)?.customer;
  return typeof customer === "string" ? customer : "";
}

// Each follow-up a program sends asks for approval under the tool's own name, so Bob reviews
// the notes one by one and the program continues with whatever he decides: the approved notes
// go out, and the declined one rejects in the program without stopping the others.
export default defineEval({
  tags: ["real-model"],
  description:
    "A model-written program sends a follow-up to each customer on a list through a tool that asks for approval; the approved ones are sent and the declined one is not.",

  async test(t) {
    let turn: EveEvalTurn = await t.send(
      [
        "Alice has three customers with overdue invoices on her list: Acme, Globex, and Initech.",
        "She would like a short payment follow-up note sent to each of them with the desk's follow-up tool.",
        "Bob reviews every note before it goes out, so please send all three from one eve__execute program, started together, so he can review them in one pass.",
        "If Bob holds one note back, the other two should still go out.",
        "Afterwards tell Alice which customers received their follow-up and which did not.",
      ].join(" "),
    );
    const session = turn.session;

    // Bob approves Acme's and Initech's notes and declines Globex's, in as many passes as the
    // notes reach him.
    for (let pass = 0; pass < 4; pass += 1) {
      const notes = session.pendingInteractions.filter(
        (interaction) => interaction.call?.name === FOLLOW_UP_TOOL,
      );
      if (notes.length === 0) break;
      turn = await session.respond(
        notes.map((interaction) => ({
          interactionId: interaction.interactionId,
          optionId: DECLINED.test(customerOf(interaction.call?.input)) ? "deny" : "approve",
        })),
      );
    }

    turn.expectOk();
    // A program that used Promise.all fails once Bob declines a note, which is still a program.
    t.event("call.requested", { data: { capability: { name: EXECUTE_TOOL } } });
    t.eventsSatisfy("every follow-up was sent from a program", (events) => {
      const sends = events.filter(
        (event) => event.type === "call.requested" && event.data.capability.name === FOLLOW_UP_TOOL,
      );
      return (
        sends.length >= 3 &&
        sends.every((event) => event.type === "call.requested" && "callId" in event.data.owner)
      );
    });
    t.calledTool(FOLLOW_UP_TOOL, { input: { customer: /acme/iu }, output: { sent: true } });
    t.calledTool(FOLLOW_UP_TOOL, { input: { customer: /initech/iu }, output: { sent: true } });
    // Bob's decline rejects that one call, and no call for Globex ever completes.
    t.calledTool(FOLLOW_UP_TOOL, { input: { customer: DECLINED }, status: "rejected" });
    t.calledTool(FOLLOW_UP_TOOL, {
      count: 0,
      input: { customer: DECLINED },
      status: "completed",
    });
    turn.messageIncludes(DECLINED);
  },
});
