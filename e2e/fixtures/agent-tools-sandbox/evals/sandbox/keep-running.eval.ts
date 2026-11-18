import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const SUBAGENT = "keep-running";

// The `keep-running` subagent's sandbox sets `idleTimeoutMs: 0`. Its first
// turn starts a detached job that `bash` doesn't track, then calls a tool that
// keeps the sandbox running while the job writes to its log. The child session
// goes idle, eve's check finds the log fresh and leaves the sandbox running, so
// the second turn finds the same job alive. The `idle-stop` eval covers a
// detached process that nothing keeps running.
export default defineEval({
  description:
    "Sandbox: a tool that calls keepRunning() keeps an idle subagent's sandbox running for a detached job until a later turn.",
  timeoutMs: 150_000,
  async test(t) {
    const started = await t.send(
      `Ask the \`${SUBAGENT}\` subagent with message: Alice starts the nightly training job and keeps the sandbox running for it.`,
    );
    started.expectOk();
    const task = started.events.find(
      (event) => event.type === "task.started" && event.data.name === SUBAGENT,
    );
    if (task?.type !== "task.started") {
      throw new Error(`The first turn did not start the ${SUBAGENT} subagent.`);
    }
    t.check(started.reply, includes("job: running"));
    t.check(started.reply, includes('"kept":true'));

    const checked = await started.session.send(
      [
        `Call the \`${SUBAGENT}\` subagent tool again with the same taskId, and reply with its exact reply.`,
        `Continue the \`${SUBAGENT}\` subagent task \`${task.data.taskId}\` with message: Bob checks on the job the next morning.`,
      ].join(" "),
    );
    checked.expectOk();

    t.succeeded();
    t.event("child.opened", { data: { name: SUBAGENT }, count: 1 });
    t.check(checked.reply, includes("job: running"));
  },
});
