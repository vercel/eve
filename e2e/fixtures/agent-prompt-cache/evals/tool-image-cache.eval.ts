import { defineEval } from "eve/evals";
import { expectCacheReuse, expectHealthyTurn } from "@eve-e2e/config/cache-checks";
import { EVENT_OVERVIEW } from "../event-overview";
import { purchasingSheets } from "../purchasing-sheets";

// A tool image must stay byte-identical in every later prompt: session history
// keeps a sandbox ref and each model call loads the same bytes. Rewriting an
// earlier image (for example, stubbing it when a turn ends) breaks the
// provider's cached prefix, and Anthropic invalidates its whole message cache
// when images appear or disappear. The follow-up turns therefore gate on
// reading the preceding prompt, image included, from the provider cache.
export default defineEval({
  tags: ["real-model"],
  description: "A tool image stays in the cached prompt prefix on later turns.",
  async test(t) {
    const session = await t.session();

    const shown = await session.send(
      "Alice is laying out the main hall for the community centre event, and Bob will print " +
        "the room signs. Please call `floor_plan` exactly once, look at the image, and tell Bob " +
        `in one short sentence which colour marks the stage.\n\n${eventBackground()}`,
    );
    expectHealthyTurn(shown);
    shown.calledTool("floor_plan", { count: 1 });

    const tables = await session.send(
      "Bob is preparing table numbers. Without calling any tool, look at the floor plan again " +
        "and tell him how many tables it shows.",
    );
    const stage = await session.send(
      "Alice wants one last check before the signs are printed. Without calling any tool, " +
        "which colour marks the stage on the floor plan?",
    );
    for (const turn of [tables, stage]) {
      expectHealthyTurn(turn);
      turn.usedNoTools();
    }
    for (const turn of [shown, tables, stage])
      turn.notEvent("context.settled", { data: { kind: "compaction", outcome: "completed" } });

    // Live vision answers vary, so they are tracked rather than gated.
    tables.messageIncludes(/\b(8|eight)\b/iu).soft();
    stage.messageIncludes(/blue/iu).soft();

    expectCacheReuse(t, [shown, tables, stage]);
  },
});

// Keeps the first request above every provider's cache minimum.
function eventBackground(): string {
  const sheets = purchasingSheets.map((sheet) => `${sheet.title}\n\n${sheet.notes}`).join("\n\n");
  return `${EVENT_OVERVIEW}\n\n${sheets}`;
}
