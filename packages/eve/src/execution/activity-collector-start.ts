import { randomBytes } from "node:crypto";

import { getChannelActivityPresenter } from "#channel/activity-presenter.js";
import type { ActivitySinkV1 } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import {
  ActivityObserverKey,
  ActivityRootTurnIdKey,
  ParentSessionKey,
  ScheduleIdKey,
} from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import type { ActivityCollectorInput } from "#execution/activity-collector.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { rootTurnWork } from "#execution/session-activity-projection.js";
import { submitActivity } from "#execution/submit-activity.js";
import {
  createWorkflowCallbackUrl,
  resolveWorkflowCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";
import {
  activityCollectorWorkflowReference,
  startWorkflowOnCurrentDeployment,
} from "#execution/workflow-runtime.js";
import { createLogger } from "#internal/logging.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { createEveActivityRoutePath } from "#protocol/routes.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.activity-collector-start");

/** How long a collector outlives a session with no timeout of its own. */
const DEFAULT_COLLECTOR_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * Starts a root session's activity collector on its first tool call, in the
 * step that publishes the call, so a session that calls no tools pays nothing
 * for it. The call's own activity reaches the collector right after, and the
 * tasks it starts inherit the sink, since they capture their context later.
 *
 * Only root sessions of a channel with an activity presenter start one, and
 * never a schedule's session, which posts only its final reply.
 */
export async function observeRootActivity(input: {
  readonly ctx: ContextContainer;
  readonly event: MessageStreamEvent;
  readonly sessionId: string;
}): Promise<void> {
  const { ctx, event } = input;
  if (event.type !== "actions.requested" || event.data.actions.length === 0) return;
  if (ctx.has(ActivityObserverKey) || ctx.has(ParentSessionKey) || ctx.has(ScheduleIdKey)) return;
  if (getChannelActivityPresenter(ctx.require(ChannelKey)) === undefined) return;
  const sink = await startActivityCollector(ctx);
  if (sink === undefined) return;
  ctx.set(ActivityObserverKey, { sink });
  const work = rootTurnWork({
    rootTurnId: ctx.get(ActivityRootTurnIdKey),
    sessionId: input.sessionId,
    turnId: event.data.turnId,
  });
  await submitActivity({
    events: [
      { eventId: `${work.id}:started`, kind: "work.started", startedAt: event.meta.at, work },
    ],
    sink,
  });
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
