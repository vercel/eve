import { nameIs, type SemanticErrorRule } from "../rule.js";

/**
 * Error class names verified against the vendored `@workflow/errors` and
 * `@workflow/world-local` source: every class assigns `this.name`
 * explicitly in its constructor (`this.name = 'ReplayDivergenceError'`,
 * `'DataDirVersionError'`, …), so the discriminator is stable and
 * survives structured clone across workflow step boundaries.
 */
export const WORKFLOW_RULES: readonly SemanticErrorRule[] = [
  {
    id: "workflow-store-version-mismatch",
    name: "Local session store incompatible",
    tags: ["workflow"],
    when: nameIs("DataDirVersionError"),
    message:
      "The local workflow store (`.eve/.workflow-data`) was created by an incompatible version.",
    hint: "Remove that directory to reset local sessions, then retry.",
  },
  {
    id: "workflow-store-inaccessible",
    name: "Local session store inaccessible",
    tags: ["workflow"],
    when: nameIs("DataDirAccessError"),
    message: "The local workflow store (`.eve/.workflow-data`) could not be created or accessed.",
    hint: "Check filesystem permissions and free disk space, then retry.",
  },
  {
    id: "workflow-replay-divergence",
    name: "Durable replay diverged",
    tags: ["workflow"],
    when: nameIs("ReplayDivergenceError"),
    message:
      "The durable workflow replay diverged from the recorded run — usually caused by code changing mid-session in a way the runtime cannot reconcile.",
    hint: "Start a fresh session (`/new` in `eve dev`).",
  },
  {
    id: "workflow-event-log-corrupted",
    name: "Durable event log corrupted",
    tags: ["workflow"],
    when: nameIs("CorruptedEventLogError"),
    message: "The durable event log for this run is corrupted.",
    hint: "Remove `.eve/.workflow-data` to reset local sessions, then retry.",
  },
  {
    id: "workflow-run-not-found",
    name: "Session run not found",
    tags: ["workflow"],
    when: nameIs("WorkflowRunNotFoundError"),
    message: "This session's durable run no longer exists (the local store was reset or pruned).",
    hint: "Start a new session.",
  },
];
