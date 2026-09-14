import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const TOKEN = "sandbox-named-sharing-ok-Q2H";
const PATH = "/workspace/named-sharing.txt";

export default defineEval({
  description: "Sandbox: separate child sessions can resolve one provider-owned named sandbox.",
  async test(t) {
    const write = await t.send(
      `Ask the \`named-sandbox\` subagent with message: Run the bash command ` +
        `\`printf %s ${TOKEN} > ${PATH}\` and reply with the single word: done.`,
    );
    write.expectOk();
    const writeSessionId = write.sessionId;
    if (writeSessionId === undefined) throw new Error("Named sandbox write has no session id.");
    const writeWatcher = t.target.watchTurn(writeSessionId, {
      startIndex: requireStreamIndex(t),
    });
    const writeCompletion = await writeWatcher.result();
    writeCompletion.expectOk();

    const read = await writeWatcher.session.send(
      `Ask the \`named-sandbox\` subagent with message: Run the bash command ` +
        `\`cat ${PATH}\` and reply with the command output verbatim.`,
    );
    read.expectOk();
    const readSessionId = read.sessionId;
    if (readSessionId === undefined) throw new Error("Named sandbox read has no session id.");
    const readCompletion = await t.target
      .watchTurn(readSessionId, { startIndex: requireStreamIndex(writeWatcher.session) })
      .result();
    readCompletion.expectOk();

    t.succeeded();
    t.calledSubagent("named-sandbox", { count: 2 });
    t.check(readCompletion.message, includes(TOKEN));
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Named sandbox turn has no stream index.");
  return streamIndex;
}
