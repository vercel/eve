import { randomUUID } from "node:crypto";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { PERSONA, PERSONA_MARKER } from "../../agent/constants.js";

/**
 * Alice saves an always-on sign-off. Her next conversation follows it without
 * loading anything, and Bob, who never saved it, doesn't see it.
 */
export default defineEval({
  description: "A personal always-on skill applies to its owner's later sessions only.",
  tags: ["custom-skills"],
  timeoutMs: 120_000,
  async test(t) {
    const run = randomUUID();
    const alice = { "x-eve-fixture-user": `alice-${run}` };
    const bob = { "x-eve-fixture-user": `bob-${run}` };

    const saving = await t.session({ headers: alice });
    const saved = await saving.send(
      `Save the sign-off skill: call \`skills__create\` exactly once with name "${PERSONA.name}", ` +
        `description "${PERSONA.description}", instructions "${PERSONA.instructions}", and ` +
        `applicationMode "always". Then reply with SKILL_SAVED and the status it returned.`,
      { headers: alice },
    );
    saved.expectOk();
    saved.calledTool("skills__create", {
      count: 1,
      output: { success: true, status: "active", applicationMode: "always" },
      status: "completed",
    });

    const later = await t.session({ headers: alice });
    const greeted = await later.send("Say hello in one short sentence. Do not call tools.", {
      headers: alice,
    });
    greeted.expectOk();
    greeted.usedNoTools();
    greeted.messageIncludes(PERSONA_MARKER);

    const other = await t.session({ headers: bob });
    const bobGreeted = await other.send("Say hello in one short sentence. Do not call tools.", {
      headers: bob,
    });
    bobGreeted.expectOk();
    await t.require(bobGreeted.reply?.includes(PERSONA_MARKER) ?? false, equals(false));
  },
});
