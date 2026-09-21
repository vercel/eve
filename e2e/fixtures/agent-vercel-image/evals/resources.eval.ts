import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Vercel image: Dockerfile, workspace, and skills are available.",
  async test(t) {
    const result = await t.send(
      "Run the bash command `cat /usr/local/share/eve-image-marker /workspace/workspace-marker.txt $HOME/.agents/skills/mounted-skill/SKILL.md /workspace/.eve/provider` and reply with the command output verbatim.",
    );
    t.succeeded();
    t.calledTool("bash", { count: 1 });
    for (const marker of [
      "vercel-image-dockerfile-ok-D4K",
      "vercel-image-workspace-ok-W5K",
      "vercel-image-skill-ok-S6K",
    ])
      t.check(result.message, includes(marker));
  },
});
