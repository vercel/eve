import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "code_mode awaits and reuses a child session, with a fresh subagent budget for each program.",
  async test(t) {
    const first = await t.send("CODEMODE-CONTINUE-START");
    first.expectOk();
    first.messageIncludes("MARKER:first");

    await t.send("CODEMODE-RESUME-START");
    t.succeeded();
    t.calledTool("code_mode", { count: 2 });
    t.calledSubagent("marker", { count: 3 });
    t.eventsSatisfy("all three calls reuse one child session", (events) => {
      const ids = events.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "marker"
          ? [event.data.childSessionId]
          : [],
      );
      return ids.length === 3 && ids[0] !== undefined && ids.every((id) => id === ids[0]);
    });
    t.messageIncludes("MARKER:second");
    t.messageIncludes("MARKER:third");
    t.messageIncludes("CODE_MODE_SUBAGENT_LIMIT_REACHED");
  },
});
