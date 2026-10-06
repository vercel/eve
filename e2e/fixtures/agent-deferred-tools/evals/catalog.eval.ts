import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Deferred entries stay out of the tool list, which keeps search and execute, and one sorted listing names them.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-CATALOG");

    turn.expectOk();
    turn.usedNoTools();
    t.messageIncludes("DEFERRED-IN-TOOLS: none");
    t.messageIncludes("CATALOG-TOOLS: search, execute");
    const tools = /^Tools: (.+)$/mu.exec(turn.message ?? "")?.[1]?.split(", ") ?? [];
    t.check(
      tools,
      satisfies(
        (names: string[]) =>
          ["deploy_service", "ledger_us_west", "refund_invoice", "research_report"].every((name) =>
            names.includes(name),
          ) && !names.includes("account_overview"),
        "the listing names inline, workflow, and dynamic deferred tools, and no direct tool",
      ),
    );
    t.check(
      tools,
      satisfies(
        (names: string[]) => names.every((name, index) => index === 0 || names[index - 1]! < name),
        "the listed tools are sorted",
      ),
    );
    t.messageIncludes("Agents: billing_specialist");
    t.messageIncludes("Skills: pdf-forms, release_notes, tenant-playbook");
    t.messageIncludes("Connections:\n- petstore: Pet store inventory API.");
  },
});
