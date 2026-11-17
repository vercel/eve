import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";
import {
  beginBrowserTrace,
  completeBrowserTrace,
  recordBrowserTraceEvents,
} from "@db/services/browser-traces";
import { traceTimelineRows } from "@agent/subagents/browser-agent/lib/trace/timeline";
import { deliveredText } from "@agent/lib/content-text";
import { listWorkerBrowserSessions } from "@db/services/browsers";
import type { AccessScope } from "@shared/identity/access-scope";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { taskCompletionOutputSchema } from "@agent/subagents/browser-agent/lib/completion";
import { harvestBrowserTraceDomains } from "@agent/subagents/browser-agent/lib/trace/domains";

function traceScope(ctx: HookContext) {
  const initiator = ctx.session.auth.initiator;
  return initiator ? scopeFromPrincipal(initiator) : undefined;
}

function logTraceFailure(sessionId: string, cause: unknown) {
  console.warn("[browser-trace] telemetry write failed", { cause, sessionId });
}

async function sweepLiveBrowserDomains(scope: AccessScope, sessionId: string) {
  const browsers = await listWorkerBrowserSessions(scope, sessionId);
  await Promise.all(
    browsers.map((browser) =>
      harvestBrowserTraceDomains(scope, sessionId, browser)
    )
  );
}

async function finishTrace(
  ctx: HookContext,
  emittedAt: string,
  outcome: {
    resultMessage?: string;
    status: "success" | "failure" | "error" | "cancelled";
  }
) {
  const scope = traceScope(ctx);
  if (!scope) return;
  await completeBrowserTrace(scope, ctx.session.id, {
    completedAt: emittedAt,
    resultMessage: outcome.resultMessage,
    status: outcome.status,
  });
  await sweepLiveBrowserDomains(scope, ctx.session.id);
}

export default defineHook({
  events: {
    async "*"(event, ctx) {
      try {
        const scope = traceScope(ctx);
        if (!scope) return;
        await recordBrowserTraceEvents(
          scope,
          ctx.session.id,
          traceTimelineRows(event, ctx)
        );
      } catch (error) {
        logTraceFailure(ctx.session.id, error);
      }
    },
    async "delivery.consumed"(event, ctx) {
      try {
        const scope = traceScope(ctx);
        if (!scope) return;
        await beginBrowserTrace(scope, {
          sessionId: ctx.session.id,
          startedAt: ctx.now.toISOString(),
          task: deliveredText(event.data.parts),
        });
      } catch (error) {
        logTraceFailure(ctx.session.id, error);
      }
    },
    async "content.completed"(event, ctx) {
      if (event.data.kind !== "result") return;
      try {
        const completion = taskCompletionOutputSchema.safeParse(
          event.data.value
        );
        if (!completion.success) return;
        await finishTrace(ctx, ctx.now.toISOString(), {
          resultMessage: completion.data.message,
          status: completion.data.status,
        });
      } catch (error) {
        logTraceFailure(ctx.session.id, error);
      }
    },
    async "turn.settled"(event, ctx) {
      if (event.data.outcome === "completed") return;
      try {
        await finishTrace(
          ctx,
          ctx.now.toISOString(),
          event.data.outcome === "failed"
            ? { resultMessage: event.data.error?.message, status: "error" }
            : { status: "cancelled" }
        );
      } catch (error) {
        logTraceFailure(ctx.session.id, error);
      }
    },
    async "session.ended"(event, ctx) {
      if (event.data.outcome !== "failed") return;
      try {
        await finishTrace(ctx, ctx.now.toISOString(), { status: "error" });
      } catch (error) {
        logTraceFailure(ctx.session.id, error);
      }
    },
  },
});
