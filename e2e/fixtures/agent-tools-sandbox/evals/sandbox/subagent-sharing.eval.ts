import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const PARENT_TOKEN = "sandbox-parent-write-ok-N4K";
const PARENT_PATH = "/workspace/parent-write.txt";
const CHILD_TOKEN = "sandbox-child-write-ok-V8C";
const CHILD_PATH = "/workspace/child-write.txt";

export default defineEval({
  description: "Sandbox: a declared child can share the parent's live workspace.",
  async test(t) {
    const parentWrite = await t.send(
      `Run the bash command \`printf %s ${PARENT_TOKEN} > ${PARENT_PATH}\`. ` +
        "Reply with the single word: done.",
    );
    parentWrite.expectOk();

    const childTurn = await t.send(
      `Ask the \`shared-sandbox\` subagent with message: ` +
        `Run the bash command \`cat ${PARENT_PATH} && printf %s ${CHILD_TOKEN} > ${CHILD_PATH}\` ` +
        "and reply with the command output verbatim.",
    );
    await t.require(childTurn.message, includes(PARENT_TOKEN));

    const parentRead = await t.send(
      `Run the bash command \`cat ${CHILD_PATH}\` and reply with the file contents verbatim.`,
    );

    t.succeeded();
    t.calledSubagent("shared-sandbox", { output: new RegExp(PARENT_TOKEN) });
    t.check(parentRead.message, includes(CHILD_TOKEN));
  },
});
