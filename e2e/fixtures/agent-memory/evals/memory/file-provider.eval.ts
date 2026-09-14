import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { FILE_MEMORY_FACT, FILE_MEMORY_PHRASE } from "../../agent/constants.js";

export default defineEval({
  description: "File memory persists, recalls, and does not duplicate an unchanged document.",
  async test(t) {
    const saved = await t.send(
      `Call \`file__save_memory\` exactly once with this exact \`text\` argument: ` +
        `"${FILE_MEMORY_FACT}" Then reply with exactly FILE_MEMORY_SAVED.`,
    );
    saved.expectOk();
    saved.calledTool("file__save_memory", {
      count: 1,
      input: { text: FILE_MEMORY_FACT },
      status: "completed",
    });
    saved.messageIncludes("FILE_MEMORY_SAVED");

    const nextSession = t.newSession();
    const recalled = await nextSession.send(
      "What is the verification phrase in file memory? Reply with the phrase only. Do not call tools.",
    );
    recalled.expectOk();
    recalled.usedNoTools();
    recalled.messageIncludes(FILE_MEMORY_PHRASE);
    await t.require(recalled.sessionId === saved.sessionId, equals(false));

    const recalledAgain = await nextSession.send(
      "What is the verification phrase in file memory? Reply with the phrase only. Do not call tools.",
    );
    recalledAgain.expectOk();
    recalledAgain.usedNoTools();
    recalledAgain.messageIncludes(FILE_MEMORY_PHRASE);
  },
});
