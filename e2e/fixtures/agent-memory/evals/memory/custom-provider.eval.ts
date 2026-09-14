import { defineEval } from "eve/evals";

export default defineEval({
  description: "A custom provider recalls context, mutates through a tool, and supersedes it.",
  async test(t) {
    const update = await t.send(
      "Update the profile memory to NEW_PROFILE_VALUE, then confirm the update.",
    );
    update.expectOk();
    update.calledTool("profile__save", { count: 1 });
    update.messageIncludes("MEMORY_TOOL_UPDATED");

    const recalled = await t.send(
      "Report the current profile memory exactly as instructed, without calling a tool.",
    );
    recalled.expectOk();
    recalled.messageIncludes("MEMORY_RECALL:NEW_PROFILE_VALUE");
    recalled.usedNoTools();

    t.succeeded();
    t.calledTool("profile__save", { count: 1 });
  },
});
