import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const SUBAGENT = "background-command";

// The `background-command` subagent's sandbox sets `idleTimeoutMs: 0`. Its
// first turn runs an export that `bash` leaves running, then the child session
// goes idle. eve finds the export still in progress and leaves the sandbox
// running, so the second turn finds the same process alive. The `idle-stop`
// eval covers the other side: a process that no `bash` call is waiting on ends
// with the idle stop.
export default defineEval({
  description:
    "Sandbox: a command that bash left running keeps an idle subagent's sandbox running until a later turn.",
  timeoutMs: 150_000,
  async test(t) {
    const started = await t.send(
      `Ask the \`${SUBAGENT}\` subagent with message: Alice starts the nightly export and leaves it running.`,
    );
    started.expectOk();
    const task = started.events.find(
      (event) => event.type === "task.started" && event.data.name === SUBAGENT,
    );
    if (task?.type !== "task.started") {
      throw new Error(`The first turn did not start the ${SUBAGENT} subagent.`);
    }
    t.check(started.reply, includes("still running after 1 seconds"));

    const checked = await started.session.send(
      [
        `Call the \`${SUBAGENT}\` subagent tool again with the same taskId, and reply with its exact reply.`,
        `Continue the \`${SUBAGENT}\` subagent task \`${task.data.taskId}\` with message: Bob checks on the export the next morning.`,
      ].join(" "),
    );
    checked.expectOk();

    t.succeeded();
    t.event("child.opened", { data: { name: SUBAGENT }, count: 1 });
    t.check(checked.reply, includes("export: running"));
  },
});
