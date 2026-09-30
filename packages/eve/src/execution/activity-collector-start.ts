import { randomBytes } from "node:crypto";

import { getChannelActivityPresenter } from "#channel/activity-presenter.js";
import type { ActivitySinkV1 } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { ActivityObserverKey, ParentSessionKey, ScheduleIdKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type { ActivityCollectorInput } from "#execution/activity-collector.js";
import { projectActionStarted } from "#execution/activity-events.js";
import { agentCallLabel } from "#execution/tasks/task-id-input.js";
import {
  resolvePreparedActivity,
  type PreparedCoordinationDispatch,
} from "#execution/coordination-dispatch-shared.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { findTask, readTaskTable } from "#execution/tasks/table.js";
import { submitActivity } from "#execution/submit-activity.js";
import {
  createWorkflowCallbackUrl,
  resolveWorkflowCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";
import {
  activityCollectorWorkflowReference,
  startWorkflowOnCurrentDeployment,
} from "#execution/workflow-runtime.js";
import { projectToolStartLabel } from "#harness/action-presentation.js";
import type { HarnessSession } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type { ActivityEventV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import { createEveActivityRoutePath } from "#protocol/routes.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { rootTurnWork } from "#execution/session-activity-projection.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { PLAN_TOOL_NAME } from "#tools/provided/plan.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

const log = createLogger("execution.activity-collector-start");

/** What starting and seeding a collector reads from a dispatch step. */
export type ObservedDispatch = Pick<
  PreparedCoordinationDispatch,
  "activityObserver" | "adapter" | "batch" | "plan" | "serializedContext"
> & {
  readonly session: Pick<HarnessSession, "rootSessionId" | "sessionId" | "state"> & {
    readonly agent: Pick<HarnessSession["agent"], "tools">;
  };
};

/** How long a collector outlives a session with no timeout of its own. */
const DEFAULT_COLLECTOR_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * Starts a root session's activity collector when the session starts its
 * first task, so a session that never starts one pays nothing for it. The
 * model step that made the calls ran before the collector existed, so the
 * collector is seeded with the turn and its task calls; everything after
 * reaches it from the session, including the calls' `task.started`.
 *
 * Only root sessions of a channel with an activity presenter start one, and
 * never a schedule's session, which posts only its final reply.
 */
export async function observeTaskActivity<T extends ObservedDispatch>(prepared: T): Promise<T> {
  if (prepared.activityObserver !== undefined) return prepared;
  const taskCalls = prepared.plan.filter((call) => call.entry.entryPoint !== "execute");
  if (taskCalls.length === 0) return prepared;
  if (getChannelActivityPresenter(prepared.adapter) === undefined) return prepared;
  const ctx = await deserializeContext(prepared.serializedContext);
  if (!presentsActivity(ctx)) return prepared;

  const sink = await startActivityCollector(ctx);
  if (sink === undefined) return prepared;
  ctx.set(ActivityObserverKey, { sink });
  const activityObserver = resolvePreparedActivity(
    { sink },
    prepared.session,
    prepared.batch.event.turnId,
  );
  if (activityObserver === undefined) return prepared;
  await submitActivity({
    events: seedActivity(prepared, taskCalls, activityObserver.workIdentity),
    sink,
  });
  return { ...prepared, activityObserver, serializedContext: serializeContext(ctx) };
}

/**
 * Starts a root session's collector on its first call to the `plan` tool, in
 * the step that publishes the call, so the call's plan reaches the collector.
 * A turn that plans without starting a task still gets its card.
 */
export async function observePlanActivity(input: {
  readonly ctx: ContextContainer;
  readonly event: MessageStreamEvent;
  readonly sessionId: string;
}): Promise<void> {
  const { ctx, event } = input;
  if (event.type !== "actions.requested" || ctx.has(ActivityObserverKey)) return;
  const plans = event.data.actions.some(
    (action) => action.kind === "tool-call" && action.toolName === PLAN_TOOL_NAME,
  );
  if (!plans || !presentsActivity(ctx)) return;
  if (getChannelActivityPresenter(ctx.require(ChannelKey)) === undefined) return;
  const sink = await startActivityCollector(ctx);
  if (sink === undefined) return;
  ctx.set(ActivityObserverKey, { sink });
  const work = rootTurnWork({ sessionId: input.sessionId, turnId: event.data.turnId });
  await submitActivity({
    events: [
      { eventId: `${work.id}:started`, kind: "work.started", startedAt: event.meta.at, work },
    ],
    sink,
  });
}

/** Only root sessions present activity, and never a schedule's, which posts only its reply. */
function presentsActivity(ctx: ContextContainer): boolean {
  return !ctx.has(ParentSessionKey) && !ctx.has(ScheduleIdKey);
}

async function startActivityCollector(ctx: ContextContainer): Promise<ActivitySinkV1 | undefined> {
  const bundle = ctx.require(BundleKey);
  const sessionTimeoutMs = resolveEffectiveAgentRuntime(bundle, ctx).limits?.sessionTimeoutMs;
  const retention = bundle.resolvedAgent.config?.experimental?.workflow?.retention;
  const token = randomBytes(32).toString("base64url");
  const collectorInput: ActivityCollectorInput = {
    expiresAt: new Date(
      Date.now() +
        (typeof sessionTimeoutMs === "number" ? sessionTimeoutMs : DEFAULT_COLLECTOR_RETENTION_MS),
    ).toISOString(),
    serializedContext: serializeContext(ctx),
    token,
  };
  try {
    await startWorkflowOnCurrentDeployment(activityCollectorWorkflowReference, [collectorInput], {
      experimental_retention: retention,
    });
  } catch {
    log.warn("failed to start activity collector");
    return undefined;
  }
  const fallbackOrigin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";
  const baseUrl = resolveWorkflowCallbackBaseUrl(fallbackOrigin);
  return { url: createWorkflowCallbackUrl(baseUrl, createEveActivityRoutePath(token)), version: 1 };
}

/** The turn's work and its task calls, as the model step would have reported them. */
function seedActivity(
  prepared: ObservedDispatch,
  taskCalls: readonly RuntimeWorkflowTaskRequest[],
  lineage: ActivityWorkIdentityV1,
): readonly ActivityEventV1[] {
  const at = new Date().toISOString();
  const table = readTaskTable(prepared.session.state);
  const turnStarted: ActivityEventV1 = {
    eventId: `${lineage.id}:started`,
    kind: "work.started",
    startedAt: at,
    work: lineage,
  };
  return [
    turnStarted,
    ...taskCalls.flatMap((call) => {
      const definition = prepared.session.agent.tools.find((tool) => tool.name === call.toolName);
      const isAgent =
        call.entry.entryPoint !== "execute" && findTask(table, call.entry.taskId)?.kind === "agent";
      return projectActionStarted({
        at,
        callId: call.callId,
        kind: "tool",
        label:
          projectToolStartLabel(definition, call.input) ??
          (isAgent ? agentCallLabel(call.toolName, call.input) : undefined),
        lineage,
        name: call.toolName,
        stepIndex: prepared.batch.event.stepIndex,
      });
    }),
  ];
}
