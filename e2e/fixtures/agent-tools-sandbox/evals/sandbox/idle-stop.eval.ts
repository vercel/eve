import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const SUBAGENT = "idle-stop";
const NOTE_TOKEN = "idle-stop-note-K4D";

// The `idle-stop` subagent's sandbox sets `idleTimeoutMs: 0`. Its first turn
// starts a background worker and writes a note, then the child session goes
// idle and eve stops its sandbox. The parent continues the same child in a
// second turn: the worker is gone because compute stopped, and the note
// remains because files persist across the stop.
export default defineEval({
  description:
    "Sandbox: with idleTimeoutMs 0, an idle subagent's sandbox stops, ending its processes and keeping its files.",
  // A stopped sandbox resumes on the second turn, which takes longer than a running one.
  timeoutMs: 150_000,
  async test(t) {
    const started = await t.send(
      `Ask the \`${SUBAGENT}\` subagent with message: Alice starts the nightly report worker and leaves Bob a note.`,
    );
    started.expectOk();
    const taskId = started.events.find(
      (event) => event.type === "task.started" && event.data.name === SUBAGENT,
    );
    if (taskId?.type !== "task.started") {
      throw new Error(`The first turn did not start the ${SUBAGENT} subagent.`);
    }
    t.check(started.reply, includes("worker: running"));

    const checked = await started.session.send(
      [
        `Call the \`${SUBAGENT}\` subagent tool again with the same taskId, and reply with its exact reply.`,
        `Continue the \`${SUBAGENT}\` subagent task \`${taskId.data.taskId}\` with message: Bob checks on the worker the next morning.`,
      ].join(" "),
    );
    checked.expectOk();

    t.succeeded();
    t.event("child.opened", { data: { name: SUBAGENT }, count: 1 });
    t.check(checked.reply, includes("worker: gone"));
    t.check(checked.reply, includes(`note: ${NOTE_TOKEN}`));
  },
});
