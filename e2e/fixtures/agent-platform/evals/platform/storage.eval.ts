import { defineEval } from "eve/evals";

import { BOB_FACT, PLATFORM_NOTE } from "../../agent/constants.js";

export default defineEval({
  description: "Memory writes land in the document storage that agent/platform.ts gives.",
  async test(t) {
    const saved = await t.send(
      `Alice is planning the release with Bob. Please save this note with \`notes__save_memory\`: ` +
        `"${BOB_FACT}" Then reply with NOTE_SAVED.`,
    );
    saved.expectOk();
    saved.calledTool("notes__save_memory", {
      count: 1,
      input: { text: BOB_FACT },
      status: "completed",
    });
    saved.messageIncludes("NOTE_SAVED");

    const nextSession = await t.session();
    const recalled = await nextSession.send(
      "Alice asks what her notes say about Bob's review day. Reply with the day. Do not call tools.",
    );
    recalled.expectOk();
    recalled.usedNoTools();
    recalled.messageIncludes("THURSDAY");

    const ledger = await nextSession.send(
      "Bob asks to see the platform ledger. Call `platform_ledger` once and report what it says.",
    );
    ledger.expectOk();
    ledger.calledTool("platform_ledger", { count: 1, status: "completed" });
    ledger.messageIncludes(`LEDGER ${PLATFORM_NOTE} WRITTEN`);
  },
});
