import { defineEval } from "eve/evals";

const SANDBOX_USER = "vercel-sandbox";

// This runs in the deterministic world suites as well as the real-model suite.
// It protects parity between Docker and hosted Vercel Sandbox, whose custom
// image execution default is otherwise root even when the Dockerfile has USER.
export default defineEval({
  description: "Sandbox: authored commands run as the non-root sandbox user.",
  async test(t) {
    await t.send("Run the bash command `whoami` and reply with its output verbatim.");

    t.succeeded();
    t.calledTool("bash", { output: new RegExp(SANDBOX_USER) });
    t.messageIncludes(SANDBOX_USER);
  },
});
