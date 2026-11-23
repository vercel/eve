import { randomUUID } from "node:crypto";

import { defineEval } from "eve/evals";

/**
 * The app turns custom skills on per person: Alice has them, and Bob, whose
 * flag is off, sees none of the extension's tools or its manage skill.
 */
export default defineEval({
  description: "A per-user flag hides the custom skills tools and manage skill.",
  tags: ["custom-skills"],
  timeoutMs: 120_000,
  async test(t) {
    const ask = async (user: string) => {
      const headers = { "x-eve-fixture-user": `${user}-${randomUUID()}` };
      const session = await t.session({ headers });
      const turn = await session.send(
        "Which custom skill tools can you call right now? List their names, and say whether " +
          "you have the skill that explains how custom skills work. Do not call any tool.",
        { headers },
      );
      turn.expectOk();
      return turn;
    };

    const alice = await ask("alice");
    alice.messageIncludes("TOOLS:skills__create,skills__list,skills__publish MANAGE:yes");

    const bob = await ask("no-skills-bob");
    bob.messageIncludes("TOOLS:none MANAGE:no");
    t.succeeded();
  },
});
