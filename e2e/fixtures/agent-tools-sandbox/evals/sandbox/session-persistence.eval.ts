import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

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

    const second = await t.send(
      `Run the bash command \`cat ${PERSIST_PATH}\` and reply with the file contents verbatim.`,
    );

    await t.require(second.sessionId, equals(first.sessionId));

    t.succeeded();
    t.calledTool("bash", {
      output: new RegExp(PERSIST_TOKEN),
    });
    t.messageIncludes(PERSIST_TOKEN);
  },
});
