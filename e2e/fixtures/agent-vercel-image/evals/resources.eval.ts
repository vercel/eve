import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Vercel image: Dockerfile, workspace, and static and dynamic skills are available.",
  async test(t) {
    const result = await t.send(
      "Run the bash command `cat /tmp/eve-image-marker /workspace/workspace-marker.txt $HOME/.agents/skills/mounted-skill/SKILL.md $HOME/.agents/skills/dynamic-drive/references/drive.txt /workspace/.eve/provider` and reply with the command output verbatim.",
    );
    t.succeeded();
    t.calledTool("bash", { count: 1 });
    for (const marker of [
      "vercel-image-dockerfile-ok-D4K",
      "vercel-image-workspace-ok-W5K",
      "vercel-image-skill-ok-S6K",
      "vercel-image-dynamic-skill-ok-D7K",
    ])
      t.check(result.message, includes(marker));
  },
});
