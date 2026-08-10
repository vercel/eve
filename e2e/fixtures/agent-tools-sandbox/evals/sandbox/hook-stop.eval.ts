import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const STOP_SANDBOX_TOKEN = "sandbox-stop-hook-ready-R7V";
const STOP_SANDBOX_MARKER_PATH = "/workspace/stopped-by-hook.txt";

// The first response activates an authored hook that writes a marker and
// stops compute. Reading that marker on the next turn proves the configured
// backend reopens the same durable sandbox state.
export default defineEval({
  description: "Sandbox: an authored hook can stop compute and the next turn reopens it.",
  async test(t) {
    const first = await t.send(`Reply with this exact token: ${STOP_SANDBOX_TOKEN}`);
    first.expectOk();

    const second = await t.send(
      `Run the bash command \`cat ${STOP_SANDBOX_MARKER_PATH}\` and reply with the file contents verbatim.`,
    );

    await t.require(second.sessionId, equals(first.sessionId));
    t.succeeded();
    t.calledTool("bash", { output: new RegExp(STOP_SANDBOX_TOKEN) });
    t.messageIncludes(STOP_SANDBOX_TOKEN);
  },
});
