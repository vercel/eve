import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createRedeployFixture, readEveVersion } from "@eve-e2e/config/redeploy";
import { defineEval, type EveEvalContext, type EveEvalSession, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const OLD_VERSION = "0.49.0";
const OLD_MARKER = "upgrade-published";
const NEW_MARKER = "upgrade-checkout";
const MARKER_PATH = resolve("agent", "lib", "upgrade-marker.ts");

interface Execution {
  readonly deploymentId: string;
  readonly marker: string;
  readonly runId: string;
}

interface GateResult {
  readonly before: Execution;
  readonly after: Execution;
  readonly answer: string;
  readonly key: string;
}

export default defineEval({
  description:
    "Published sessions retain pending work and their stream while later turns execute upgraded and rolled-back agent code.",
  tags: ["redeploy"],
  timeoutMs: 30 * 60_000,

  async test(t) {
    const fixture = await createRedeployFixture(t);
    const historicalPackage = await realpath(resolve("node_modules", "historical-eve-0-49-0"));
    if ((await readEveVersion(historicalPackage)) !== OLD_VERSION) {
      throw new Error(`Expected published eve@${OLD_VERSION}.`);
    }
    const originalMarker = await readFile(MARKER_PATH, "utf8");
    const sessions = [
      t.newSession(),
      t.newSession(),
      t.newSession(),
      t.newSession(),
      t.newSession(),
    ];
    const [idle, blocking, cancellable, background, fresh] = sessions as [
      EveEvalSession,
      EveEvalSession,
      EveEvalSession,
      EveEvalSession,
      EveEvalSession,
    ];

    try {
      await writeMarker(OLD_MARKER, true);
      await fixture.deploy(historicalPackage, "inbox-upgrade-published");

      const first = await idle.send("UPGRADE-read-first");
      const oldExecution = readExecution(first);
      await requireExecution(t, oldExecution, OLD_MARKER);
      const sessionId = first.sessionId;
      const streamIndex = requireStreamIndex(idle);

      await blocking.send("UPGRADE-gate-blocking");
      const blockingRequest = blocking.requireInputRequest({ toolName: "upgrade_gate" });
      const blockingExecution = readRequestedExecution(blockingRequest.prompt);
      await requireExecution(t, blockingExecution, OLD_MARKER, oldExecution.deploymentId);

      await cancellable.send("UPGRADE-gate-cancel");
      cancellable.requireInputRequest({ toolName: "upgrade_gate" });

      const admitted = await background.send("UPGRADE-task-background");
      admitted.expectOk();
      admitted.event("turn.completed", { count: 1 });
      const receipt = parseOutput(admitted.requireToolCall("upgrade_task").output) as {
        taskId?: string;
      };
      if (typeof receipt.taskId !== "string")
        throw new Error("Background task did not return a task ID.");
      const pendingBackground = await waitForTaskRequest(t, background);
      const backgroundRequest = pendingBackground.requireInputRequest({ toolName: "upgrade_task" });
      const backgroundExecution = readRequestedExecution(backgroundRequest.prompt);
      await requireExecution(t, backgroundExecution, OLD_MARKER, oldExecution.deploymentId);

      await writeMarker(NEW_MARKER);
      await fixture.deploy(fixture.currentPackage, "inbox-upgrade-checkout");

      const next = await idle.send("UPGRADE-read-next");
      const newExecution = readExecution(next);
      await requireExecution(t, newExecution, NEW_MARKER);
      await t.require(
        { sessionId: next.sessionId, execution: newExecution },
        satisfies(
          (value: { sessionId: string; execution: Execution }) =>
            value.sessionId === sessionId &&
            value.execution.deploymentId !== oldExecution.deploymentId &&
            value.execution.runId !== sessionId,
          "the published parent starts a child turn on the accepting deployment and retains its session ID",
        ),
      );
      const replayed = await t.target.watchTurn(sessionId, { startIndex: streamIndex }).result();
      replayed.expectOk();
      replayed.messageIncludes(NEW_MARKER);
      replayed.event("turn.completed", { count: 1 });

      const answered = await blocking.respond([
        { requestId: blockingRequest.requestId, optionId: "continue" },
      ]);
      answered.expectOk();
      await requireGateResult(
        t,
        answered.requireToolCall("upgrade_gate").output,
        "blocking",
        blockingExecution,
      );
      const afterAnswer = await blocking.send("UPGRADE-read-afteranswer");
      await requireExecution(t, readExecution(afterAnswer), NEW_MARKER, newExecution.deploymentId);

      const cancelledLive = t.target.watchTurn(cancellable.sessionId!, {
        startIndex: requireStreamIndex(cancellable),
      });
      await cancelledLive.cancel();
      const cancelled = await cancelledLive.result();
      cancelled.event("turn.cancelled", { count: 1 });
      cancelled.notEvent("turn.failed");
      cancelled.notEvent("session.failed");
      const afterCancel = await cancelledLive.session.send("UPGRADE-read-aftercancel");
      await requireExecution(t, readExecution(afterCancel), NEW_MARKER, newExecution.deploymentId);

      await pendingBackground.respond([
        { requestId: backgroundRequest.requestId, optionId: "continue" },
      ]);
      await requireTaskCompletion(t, pendingBackground, receipt.taskId, backgroundExecution);

      const newSession = await fresh.send("UPGRADE-read-fresh");
      await requireExecution(t, readExecution(newSession), NEW_MARKER, newExecution.deploymentId);

      // Roll back authored code while retaining the runtime that understands both cohorts.
      await writeMarker(OLD_MARKER);
      await fixture.deploy(fixture.currentPackage, "inbox-upgrade-code-rollback");
      for (const session of [idle, fresh]) {
        const beforeId = session.sessionId;
        const rollback = await session.send("UPGRADE-read-rollback");
        const execution = readExecution(rollback);
        await requireExecution(t, execution, OLD_MARKER);
        await t.require(
          rollback.sessionId === beforeId && execution.deploymentId !== newExecution.deploymentId,
          satisfies(
            (value: boolean) => value,
            "code rollback preserves existing session IDs and selects the rollback deployment",
          ),
        );
      }
      t.succeeded();
    } finally {
      // These isolated fixture sessions have finished the probe; retire their durable resources.
      for (const session of sessions) {
        if (session.sessionId === undefined) continue;
        try {
          const response = await t.target.fetch(
            `/eve/v1/session/${encodeURIComponent(session.sessionId)}/reset`,
            { method: "POST" },
          );
          if (!response.ok) t.log(`Upgrade probe cleanup returned HTTP ${response.status}.`);
        } catch {
          t.log("Upgrade probe cleanup could not reach the session reset route.");
        }
      }
      await writeFile(MARKER_PATH, originalMarker);
      await fixture.restore();
    }
  },
});

async function writeMarker(marker: string, legacy = false): Promise<void> {
  const config = legacy ? { experimental: { tasks: true } } : {};
  await writeFile(
    MARKER_PATH,
    `export const UPGRADE_MARKER = ${JSON.stringify(marker)};\n` +
      `export const UPGRADE_LEGACY_CONFIG = ${JSON.stringify(config)};\n`,
  );
}

function requireStreamIndex(session: EveEvalSession): number {
  if (session.state === undefined) throw new Error("Session has no stream cursor.");
  return session.state.streamIndex;
}

function readExecution(turn: EveEvalTurn): Execution {
  turn.expectOk();
  return parseExecution(turn.requireToolCall("upgrade_read").output);
}

function readRequestedExecution(prompt: string): Execution {
  const start = prompt.indexOf("{");
  if (start === -1) throw new Error("Upgrade request has no execution provenance.");
  return parseExecution(JSON.parse(prompt.slice(start)));
}

function parseExecution(value: unknown): Execution {
  value = parseOutput(value);
  if (
    typeof value !== "object" ||
    value === null ||
    !("deploymentId" in value) ||
    typeof value.deploymentId !== "string" ||
    !("marker" in value) ||
    typeof value.marker !== "string" ||
    !("runId" in value) ||
    typeof value.runId !== "string"
  ) {
    throw new Error("Upgrade probe returned invalid execution provenance.");
  }
  return { deploymentId: value.deploymentId, marker: value.marker, runId: value.runId };
}

function parseOutput(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function requireExecution(
  t: EveEvalContext,
  actual: Execution,
  marker: string,
  deploymentId?: string,
) {
  await t.require(
    actual,
    satisfies(
      (value: Execution) =>
        value.marker === marker &&
        typeof value.runId === "string" &&
        value.runId.startsWith("wrun_") &&
        typeof value.deploymentId === "string" &&
        value.deploymentId.startsWith("dpl_") &&
        (deploymentId === undefined || value.deploymentId === deploymentId),
      `execution uses ${marker}${deploymentId === undefined ? "" : ` on ${deploymentId}`}`,
    ),
  );
  t.log(`execution ${JSON.stringify(actual)}`);
}

async function requireGateResult(
  t: EveEvalContext,
  actual: unknown,
  key: string,
  expected: Execution,
) {
  await t.require(
    parseOutput(actual),
    satisfies(
      (value: GateResult) =>
        value.key === key &&
        value.answer === "continue" &&
        [value.before, value.after].every(
          (execution) =>
            execution.marker === expected.marker &&
            execution.deploymentId === expected.deploymentId &&
            execution.runId === expected.runId,
        ),
      "the pending workflow resumes and completes on its original executable and owner",
    ),
  );
}

async function waitForTaskRequest(
  t: EveEvalContext,
  initial: EveEvalSession,
): Promise<EveEvalSession> {
  let session = initial;
  for (let turn = 0; turn < 6; turn++) {
    if (session.pendingInputRequests.some((request) => request.action.toolName === "upgrade_task"))
      return session;
    const live = t.target.watchTurn(session.sessionId!, {
      startIndex: requireStreamIndex(session),
    });
    (await live.result()).noFailedActions();
    session = live.session;
  }
  throw new Error("Background workflow did not publish its input request within six turns.");
}

async function requireTaskCompletion(
  t: EveEvalContext,
  initial: EveEvalSession,
  taskId: string,
  expected: Execution,
) {
  let session = initial;
  for (let turn = 0; turn < 6; turn++) {
    for (const event of session.events) {
      if (event.type !== "message.received" || typeof event.data.message !== "string") continue;
      const message = event.data.message;
      if (!message.includes(`Background task ${taskId} (upgrade_task) is completed.`)) continue;
      const start = message.indexOf("{");
      if (start === -1) throw new Error("Completed task notification has no result.");
      await requireGateResult(t, JSON.parse(message.slice(start)), "background", expected);
      return;
    }
    const live = t.target.watchTurn(session.sessionId!, {
      startIndex: requireStreamIndex(session),
    });
    (await live.result()).expectOk();
    session = live.session;
  }
  throw new Error("Background task did not complete within six turns.");
}
