import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const DOCKERFILE_MARKER = "microsandbox-dockerfile-ok-P6N";
const WORKSPACE_MARKER = "microsandbox-workspace-ok-W7R";
const SKILL_MARKER = "microsandbox-skill-ok-S8K";

export default defineEval({
  description: "Microsandbox: a Dockerfile image boots with mounted workspace and skills.",
  async test(t) {
    const result = await t.send(
      "Run the bash command `cat /usr/local/share/eve-dockerfile-marker " +
        "/workspace/workspace-marker.txt $HOME/.agents/skills/mounted-skill/SKILL.md` " +
        "and reply with the command output verbatim.",
    );

    t.succeeded();
    t.calledTool("bash", { count: 1 });
    t.check(result.message, includes(DOCKERFILE_MARKER));
    t.check(result.message, includes(WORKSPACE_MARKER));
    t.check(result.message, includes(SKILL_MARKER));
  },
});
