import { randomUUID } from "node:crypto";

import { defineEval } from "eve/evals";

import { CHECKLIST, CHECKLIST_V2 } from "../../agent/constants.js";

/**
 * Alice saves an on-demand release checklist, then a second version. The second
 * version is a draft until she approves publishing it, and a new conversation
 * then offers the published version.
 */
export default defineEval({
  description: "A custom skill's draft goes live only through an approved publish.",
  tags: ["custom-skills", "approval"],
  timeoutMs: 180_000,
  async test(t) {
    const alice = { "x-eve-fixture-user": `alice-${randomUUID()}` };
    const session = await t.session({ headers: alice });

    const first = await session.send(
      `Save the release checklist skill: call \`skills__create\` exactly once with name ` +
        `"${CHECKLIST.name}", description "${CHECKLIST.description}", instructions ` +
        `"${CHECKLIST.instructions}", and applicationMode "on-demand". Then reply with ` +
        `SKILL_SAVED and the status it returned.`,
      { headers: alice },
    );
    first.expectOk();
    first.calledTool("skills__create", {
      count: 1,
      output: { success: true, status: "active", version: 1 },
    });

    const draft = await session.send(
      `Save version two of the release checklist: call \`skills__create\` exactly once with ` +
        `name "${CHECKLIST.name}", description "${CHECKLIST_V2}", instructions "Check the ` +
        `build, the changelog, then the rollout plan.", and applicationMode "on-demand". Then ` +
        `reply with SKILL_SAVED and the status it returned. Do not publish it.`,
      { headers: alice },
    );
    draft.expectOk();
    draft.calledTool("skills__create", {
      count: 1,
      output: { success: true, status: "draft", version: 2, liveVersion: 1 },
    });
    draft.notCalledTool("skills__publish");

    const asking = await session.send(
      `Publish version two of the release checklist: call \`skills__list\`, then call ` +
        `\`skills__publish\` once with name "${CHECKLIST.name}", the id \`skills__list\` ` +
        `returned for it, and version 2. When it finishes, reply with PUBLISHED and the live ` +
        `version it returned.`,
      { headers: alice },
    );
    const { interactionId } = asking.session.requireInteraction({ toolName: "skills__publish" });
    asking.calledTool("skills__publish", { count: 0, status: "completed" });

    const published = await session.respond([{ optionId: "approve", interactionId }], {
      headers: alice,
    });
    published.expectOk();
    published.calledTool("skills__publish", {
      count: 1,
      output: { success: true, liveVersion: 2 },
      status: "completed",
    });

    const later = await t.session({ headers: alice });
    const offered = await later.send(
      "Which release checklist skill can you load? Name its description; do not load it.",
      { headers: alice },
    );
    offered.expectOk();
    offered.messageIncludes(/CHECKLIST_V2_OFFERED|version two/iu);
    t.succeeded();
  },
});
