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
    "Published sessions retain their executable and pending work while new sessions follow code upgrades and rollback.",
  tags: ["redeploy"],
  timeoutMs: 30 * 60_000,

  async test(t) {
    const fixture = await createRedeployFixture(t);
    const historicalPackage = await realpath(resolve("node_modules", "historical-eve-0-49-0"));
    if ((await readEveVersion(historicalPackage)) !== OLD_VERSION) {
      throw new Error(`Expected published eve@${OLD_VERSION}.`);
    }
    const originalMarker = await readFile(MARKER_PATH, "utf8");
    const sessions = [t.newSession(), t.newSession(), t.newSession(), t.newSession()];
    const [idle, blocking, cancellable, background] = sessions as [
      EveEvalSession,
      EveEvalSession,
      EveEvalSession,
      EveEvalSession,
    ];

    try {
      const historicalRuntime = await fixture.stagePublishedEve(historicalPackage);
      await writeMarker(OLD_MARKER, true);
      await fixture.deploy(historicalRuntime, "inbox-upgrade-published");

      const first = await idle.send("UPGRADE-read-first", {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(90_000)]),
      });
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

      const { session: fresh, execution: newExecution } = await createSessionOnDeployment(
        t,
        sessions,
        NEW_MARKER,
        oldExecution,
      );
      const upgraded = await followRetainedDeployment(t, idle, "next", oldExecution);
      const next = upgraded.turn;
      await t.require(
        { sessionId: next.sessionId, execution: upgraded.execution },
        satisfies(
          (value: { sessionId: string; execution: Execution }) =>
            value.sessionId === sessionId &&
            value.execution.deploymentId === oldExecution.deploymentId &&
            value.execution.runId !== sessionId,
          "the published parent retains its session ID and executes on its original deployment through a child",
        ),
      );
      let replayIndex = streamIndex;
      for (let attempt = 0; attempt < upgraded.attempts; attempt++) {
        const replay = t.target.watchTurn(sessionId, { startIndex: replayIndex });
        const replayed = await replay.result();
        replayed.expectOk();
        replayed.event("turn.completed", { count: 1 });
        if (attempt === upgraded.attempts - 1) replayed.messageIncludes(OLD_MARKER);
        replayIndex = requireStreamIndex(replay.session);
      }

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
      await followRetainedDeployment(t, blocking, "afteranswer", oldExecution);
      await blocking.send("UPGRADE-gate-retained");
      const retainedRequest = blocking.requireInputRequest({ toolName: "upgrade_gate" });
      const retainedExecution = readRequestedExecution(retainedRequest.prompt);
      await requireExecution(t, retainedExecution, OLD_MARKER, oldExecution.deploymentId);
      const retainedAnswer = await blocking.respond([
        { requestId: retainedRequest.requestId, optionId: "continue" },
      ]);
      retainedAnswer.expectOk();
      await requireGateResult(
        t,
        retainedAnswer.requireToolCall("upgrade_gate").output,
        "retained",
        retainedExecution,
      );

      const cancellation = await cancellable.cancel();
      await t.require(
        cancellation.status,
        satisfies(
          (status: string) => status === "accepted",
          "the old session accepts cancellation",
        ),
      );
      // The parked turn already emitted its boundary; cancellation must not invent another.
      const afterCancel = await followRetainedDeployment(
        t,
        cancellable,
        "aftercancel",
        oldExecution,
      );
      afterCancel.turn.notEvent("turn.cancelled");
      afterCancel.turn.notEvent("input.requested");

      await pendingBackground.respond([
        { requestId: backgroundRequest.requestId, optionId: "continue" },
      ]);
      const completedBackground = await requireTaskCompletion(
        t,
        pendingBackground,
        receipt.taskId,
        backgroundExecution,
      );
      await followRetainedDeployment(t, completedBackground, "aftertask", oldExecution);
      const newTask = await completedBackground.send("UPGRADE-task-afterupgrade");
      newTask.expectOk();
      const newReceipt = parseOutput(newTask.requireToolCall("upgrade_task").output) as {
        taskId: string;
      };
      const newPending = await waitForTaskRequest(t, completedBackground);
      const newRequest = newPending.requireInputRequest({ toolName: "upgrade_task" });
      const newTaskExecution = readRequestedExecution(newRequest.prompt);
      await requireExecution(t, newTaskExecution, OLD_MARKER, oldExecution.deploymentId);
      await newPending.respond([{ requestId: newRequest.requestId, optionId: "continue" }]);
      const newCompleted = await requireTaskCompletion(
        t,
        newPending,
        newReceipt.taskId,
        newTaskExecution,
        "afterupgrade",
      );
      await followRetainedDeployment(t, newCompleted, "afternewtask", oldExecution);

      // Roll back authored code while retaining the current runtime.
      await writeMarker(OLD_MARKER);
      await fixture.deploy(fixture.currentPackage, "inbox-upgrade-code-rollback");
      const rollback = await followCodeDeployment(t, fresh, "rollback", OLD_MARKER, [
        oldExecution,
        newExecution,
      ]);
      await requireExecution(t, rollback.execution, OLD_MARKER);
      await followRetainedDeployment(t, idle, "rollback", oldExecution);
      await followRetainedDeployment(t, newCompleted, "taskrollback", oldExecution);
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

async function followCodeDeployment(
  t: EveEvalContext,
  session: EveEvalSession,
  key: string,
  marker: string,
  previous: readonly Execution[],
) {
  const sessionId = session.sessionId;
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]);
  for (let attempt = 0; attempt < 10; attempt++) {
    // An alias can serve old ingress after an info request reached the new deployment.
    // Probe with read-only turns; every accepted turn must preserve the session.
    const turn = await session.send(`UPGRADE-read-${key}${attempt}`, { signal });
    const execution = readExecution(turn);
    await t.require(
      turn.sessionId === sessionId,
      satisfies(
        (same: boolean) => same,
        "code changes preserve the session ID during alias propagation",
      ),
    );
    const prior = previous.find((entry) => entry.deploymentId === execution.deploymentId);
    if (prior === undefined) {
      await requireExecution(t, execution, marker);
      return { turn, execution, attempts: attempt + 1 };
    }
    await requireExecution(t, execution, prior.marker, prior.deploymentId);
    t.log(
      `${key}: prior deployment still accepted a read-only turn; waiting for alias propagation`,
    );
    await t.sleep(1_000);
  }
  throw new Error(`Alias did not select ${marker} on a new deployment within ten read-only turns.`);
}

async function createSessionOnDeployment(
  t: EveEvalContext,
  sessions: EveEvalSession[],
  marker: string,
  previous: Execution,
) {
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]);
  for (let attempt = 0; attempt < 10; attempt++) {
    const session = t.newSession();
    sessions.push(session);
    const first = await session.send("UPGRADE-read-fresh", { signal });
    const execution = readExecution(first);
    if (execution.deploymentId !== previous.deploymentId) {
      await requireExecution(t, execution, marker);
      await t.require(
        execution.runId === first.sessionId,
        satisfies(
          (same: boolean) => same,
          "the fresh cohort starts its parent on the new deployment",
        ),
      );
      return { session, execution };
    }
    await requireExecution(t, execution, previous.marker, previous.deploymentId);
    t.log(
      "A prior ingress created another legacy session during alias propagation; retaining it for cleanup",
    );
    await t.sleep(1_000);
  }
  throw new Error("Alias did not create a session on the new deployment within ten attempts.");
}

async function followRetainedDeployment(
  t: EveEvalContext,
  session: EveEvalSession,
  key: string,
  expected: Execution,
) {
  const sessionId = session.sessionId;
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]);
  for (let attempt = 0; attempt < 10; attempt++) {
    const turn = await session.send(`UPGRADE-read-${key}${attempt}`, { signal });
    const execution = readExecution(turn);
    await requireExecution(t, execution, expected.marker, expected.deploymentId);
    await t.require(
      turn.sessionId === sessionId,
      satisfies((same: boolean) => same, "retained execution preserves the session ID"),
    );
    // Old ingress runs this ordinary read inline in the original session.
    // A child on the old deployment proves the new ingress caused a retained dispatch.
    if (execution.runId !== sessionId) return { turn, execution, attempts: attempt + 1 };
    t.log(`${key}: old ingress still executed inline; waiting for a retained child`);
    await t.sleep(1_000);
  }
  throw new Error("Alias did not exercise retained child execution within ten read-only turns.");
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
  key = "background",
) {
  let session = initial;
  for (let turn = 0; turn < 6; turn++) {
    for (const event of session.events) {
      if (event.type !== "message.received" || typeof event.data.message !== "string") continue;
      const message = event.data.message;
      if (!message.includes(`Background task ${taskId} (upgrade_task) is completed.`)) continue;
      const start = message.indexOf("{");
      if (start === -1) throw new Error("Completed task notification has no result.");
      await requireGateResult(t, JSON.parse(message.slice(start)), key, expected);
      return session;
    }
    const live = t.target.watchTurn(session.sessionId!, {
      startIndex: requireStreamIndex(session),
    });
    (await live.result()).expectOk();
    session = live.session;
  }
  throw new Error("Background task did not complete within six turns.");
}
