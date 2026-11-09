import { SEARCH_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { noCallRejectedWholesale } from "./first-try";

export default defineEval({
  tags: ["real-model"],
  description:
    "A real model finds an MCP connection's tools with eve__search, reads a tool's structured result, and builds a nested tool input from its signature.",

  async test(t) {
    const turn = await t.send(
      [
        "Bob works the front desk at the Maple Street kennel. Biscuit, a boarding golden retriever,",
        "needs a grooming visit on October 14, 2026. Alice (555-0100) should be notified about it.",
        "Use `eve__search` to find the `kennel` connection's tools, look up Biscuit's pet id,",
        "then book the visit with `eve__tool`.",
        "Reply with the visit id the kennel returns.",
      ].join(" "),
    );

    turn.expectOk();
    t.toolOrder([SEARCH_TOOL, "kennel__find_pet", "kennel__book_visit"]);
    // The pet id comes from find_pet's structured result, not the prompt.
    t.calledTool("kennel__find_pet", { output: { petId: 4217 } });
    t.calledTool("kennel__book_visit", {
      count: 1,
      output: {
        visitId: "V-88",
        petId: 4217,
        visit: { kind: "grooming", date: "2026-10-14" },
        contacts: [{ name: /alice/iu, phone: /555-0100/u }],
      },
    });
    t.messageIncludes("V-88");

    // Tracked, not gated: no step had every tool call rejected, a proxy for building
    // the nested input right on the first try.
    t.check(
      noCallRejectedWholesale(turn),
      satisfies((firstTry: boolean) => firstTry, "every step that requested tools ran one").soft(),
    );
  },
});
