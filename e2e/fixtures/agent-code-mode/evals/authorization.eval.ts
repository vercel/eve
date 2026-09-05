import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Nested authorization reaches the parent and resumes the program with its saved challenge.",
  async test(t) {
    const live = await t.start("CODEMODE-AUTH-START");
    const required = await live.waitForEvent("authorization.required");
    if (required?.data.authorization?.url === undefined)
      throw new Error("Missing authorization URL.");
    const callbackUrl = new URL(required.data.authorization.url);
    const waiting = await live.result();
    waiting.expectOk();
    waiting.event("authorization.required", { count: 1 });
    if (callbackUrl.origin !== new URL(t.target.url).origin)
      throw new Error(
        `Unexpected callback origin ${callbackUrl.origin}; expected ${new URL(t.target.url).origin}.`,
      );
    const response = await fetch(callbackUrl);
    if (!response.ok) throw new Error(`Authorization callback failed: ${response.status}`);
    let session = live.session;
    let completed = 0;
    let completedCalls = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const next = t.target.watchTurn(live.sessionId, { startIndex: session.state!.streamIndex });
      const turn = await next.result();
      turn.expectOk();
      turn.noFailedActions();
      completed += turn.events.filter(
        (event) => event.type === "authorization.completed" && event.data.outcome === "authorized",
      ).length;
      completedCalls += turn.events.filter(
        (event) =>
          event.type === "action.result" &&
          event.data.status === "completed" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "code_mode",
      ).length;
      if (turn.message?.includes("CODEMODE-AUTH-RESULT")) {
        t.check(completed, equals(1));
        t.check(completedCalls, equals(1));
        turn.messageIncludes('"first":"ECHO:before-auth"');
        turn.messageIncludes('"authorized":true');
        turn.messageIncludes('"actor":"code-mode-e2e-user"');
        return;
      }
      session = next.session;
    }
    throw new Error("Code mode did not complete after authorization.");
  },
});
