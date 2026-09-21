import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const MARKER = "reused-vercel-shared-ok-R7K";
const PATH = "/workspace/reused-marker.txt";

export default defineEval({
  description:
    "Reused Vercel image: sessions share compute and logical lifecycle does not tear it down.",
  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "mock") t.skip("Requires the Vercel reused-image provider.");
    const write = await t.send(
      `Run the bash command \`printf %s ${MARKER} > ${PATH}\` and reply with the command output verbatim.`,
    );
    write.expectOk();
    const read = await t.send(
      `Run the bash command \`cat ${PATH} /workspace/.eve/provider\` and reply with the command output verbatim.`,
    );
    read.expectOk();
    if (write.sessionId === undefined || read.sessionId === undefined)
      throw new Error("Reused sandbox eval did not receive session IDs.");
    if (write.sessionId === read.sessionId)
      throw new Error("Reused sandbox eval requires two distinct eve sessions.");
    t.check(read.message, includes(MARKER));
    if (process.env.EVE_E2E_MODEL === "mock")
      t.check(read.message, includes("vercel-reused-image"));

    const stopped = await write.session.send("Run sandbox lifecycle `stop` and reply done.");
    stopped.expectOk();
    const afterStop = await t.send(
      `Run the bash command \`cat ${PATH}\` and reply with the command output verbatim.`,
    );
    t.check(afterStop.message, includes(MARKER));

    const deleted = await stopped.session.send("Run sandbox lifecycle `delete` and reply done.");
    deleted.expectOk();
    const afterDelete = await t.send(
      `Run the bash command \`cat ${PATH}\` and reply with the command output verbatim.`,
    );
    t.check(afterDelete.message, includes(MARKER));
    t.succeeded();
  },
});
