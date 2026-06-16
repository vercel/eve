import { defineEval } from "eve/evals";

// Durable sessions keep their sandbox filesystem across turns: a file written
// in turn one must still be readable in turn two of the same session. The
// second turn can only answer from the persisted file, so the token in its
// reply proves `/workspace` state survived the turn boundary.
const PERSIST_TOKEN = "sandbox-persist-ok-D6L";
const PERSIST_PATH = "/workspace/persist-note.txt";

export default defineEval({
  description: "Sandbox: workspace filesystem persists across turns in the same session.",
  async test(t) {
    const first = await t.send(
      `Run the bash command \`printf %s ${PERSIST_TOKEN} > ${PERSIST_PATH}\`. ` +
        "Reply with the single word: done.",
    );
    first.expectOk();
    const firstSessionId = t.sessionId;

    const second = await t.send(
      `Run the bash command \`cat ${PERSIST_PATH}\` and reply with the file contents verbatim.`,
    );
    second.expectOk();

    if (t.sessionId !== firstSessionId) {
      throw new Error(
        `Expected both turns in one session; got ${String(firstSessionId)} then ${String(t.sessionId)}.`,
      );
    }

    t.didNotFail();
    t.completed();
    t.calledTool("bash", {
      isError: false,
      output: new RegExp(PERSIST_TOKEN),
    });
    t.messageIncludes(PERSIST_TOKEN);
  },
});
