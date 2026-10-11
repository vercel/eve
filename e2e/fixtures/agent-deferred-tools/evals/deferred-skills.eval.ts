import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "eve__skill({ name }) loads deferred skills from SKILL.md frontmatter, defineSkill, and a dynamic resolver.",

  async test(t) {
    requireMockModel(t);

    const turn = await t.send("DEFERRED-SKILLS Alice asks how to fill a refund form.");

    turn.expectOk();
    turn.noFailedActions();
    t.loadedSkill("pdf-forms", { count: 1, output: /pdf-forms-skill-ok-R7K2/u });
    t.loadedSkill("release_notes", { count: 1, output: /release-notes-skill-ok-L3M8/u });
    t.loadedSkill("tenant-playbook", { count: 1, output: /tenant-playbook-ok-T9P4/u });
    t.messageIncludes(
      "pdf-forms-skill-ok-R7K2 release-notes-skill-ok-L3M8 tenant-playbook-ok-T9P4",
    );
  },
});
