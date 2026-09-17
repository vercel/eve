import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Vercel base image: workspace, skills, and post-open initialization persist.",
  async test(t) {
    const command = "cat /workspace/.eve/initialization-count";
    const first = await t.send(
      `Run the bash command \`${command}\` and reply with the command output verbatim.`,
    );
    const second = await t.send(
      `Run the bash command \`${command}\` and reply with the command output verbatim.`,
    );
    const resources = await t.send(
      "Run the bash command `cat /workspace/workspace-marker.txt $HOME/.agents/skills/mounted-skill/SKILL.md` and reply with the command output verbatim.",
    );
    t.succeeded();
    t.check(first.message, includes("1"));
    t.check(second.message, includes("1"));
    t.check(resources.message, includes("vercel-image-workspace-ok-W5K"));
    t.check(resources.message, includes("vercel-image-skill-ok-S6K"));
  },
});
