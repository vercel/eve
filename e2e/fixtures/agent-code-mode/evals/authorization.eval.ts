import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Nested authorization reaches the parent and resumes the program with its saved challenge.",
  async test(t) {
    const live = await t.start("CODEMODE-AUTH-START");
    const required = await live.waitForEvent("authorization.required");
    if (required?.data.authorization?.url === undefined)
      throw new Error("Missing authorization URL.");
    const callbackUrl = new URL(required.data.authorization.url);
    if (callbackUrl.origin !== new URL(t.target.url).origin)
      throw new Error("Unexpected callback origin.");
    const response = await fetch(callbackUrl);
    if (!response.ok) throw new Error(`Authorization callback failed: ${response.status}`);
    const turn = await live.result();
    turn.expectOk();
    turn.event("authorization.required", { count: 1 });
    turn.event("authorization.completed", { count: 1, data: { outcome: "authorized" } });
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.messageIncludes('"first":"ECHO:before-auth"');
    turn.messageIncludes('"authorized":true');
    turn.messageIncludes('"actor":"code-mode-e2e-user"');
    t.noFailedActions();
  },
});
