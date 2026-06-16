import { defineSchedule } from "eve/schedules";

/**
 * Markdown (task-mode) schedule used by `evals/schedule-dispatch.eval.ts`.
 *
 * The eval fires it out of band through the dev-only dispatch route
 * (`t.target.dispatchSchedule("heartbeat")`), which runs the exact path the
 * production cron handler uses, then attaches to the started session and
 * asserts the agent ran the `record-heartbeat` tool. The prompt is pinned to a
 * single deterministic tool call so the smoke test is stable across models.
 */
export default defineSchedule({
  cron: "0 0 * * *",
  markdown: [
    "Call the `record-heartbeat` tool exactly once with note 'cron-tick'.",
    "Do not call any other tool. You have no other task.",
  ].join("\n"),
});
