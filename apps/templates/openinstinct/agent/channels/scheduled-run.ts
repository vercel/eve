import { defineChannel, POST } from "eve/channels";
import { localDev, routeAuth, vercelOidc } from "eve/channels/auth";
import { parseAnswers, SessionNotActiveError } from "eve/client";
import {
  APPROVE_OPTION_ID,
  DENY_OPTION_ID,
  type Answer,
  type Interaction,
} from "eve/events";
import { z } from "zod";
import { dispatchScheduledReport } from "@agent/lib/schedules/report";
import {
  claimScheduledAgentRunInput,
  finishScheduledAgentRunInput,
  restoreScheduledAgentRunInput,
} from "@db/services/scheduled-agent-jobs";

const scheduledRunTargetSchema = z.strictObject({
  restart: z.boolean().optional(),
  runId: z.uuid(),
});
const reportSchema = z.strictObject({ runId: z.uuid() });
const respondSchema = z.strictObject({
  answer: z.string().trim().min(1).max(8_000),
  leaseToken: z.uuid(),
  runId: z.uuid(),
});
const internalRouteAuth = [vercelOidc(), localDev()];

export default defineChannel({
  audience({ caller }) {
    return caller.type === "principal" && caller.principal.kind === "user"
      ? "private"
      : "unknown";
  },
  async receive(input, { from }) {
    const target = scheduledRunTargetSchema.parse(input.target);
    const source = from(`scheduled-run:${target.runId}`);
    if (target.restart) {
      // Retire the overrunning worker; the next send starts a fresh session.
      await source.end({
        reason: "Scheduled worker exceeded its runtime.",
      });
    }
    return source.send(input.message, {
      auth: input.auth,
      title: `Scheduled run ${target.runId}`,
    });
  },
  routes: [
    POST(
      "/internal/scheduled-run/report",
      async (request, { attachSession, to, waitUntil }) => {
        const auth = await routeAuth(request, internalRouteAuth);
        if (auth instanceof Response) return auth;
        const parsed = reportSchema.safeParse(await request.json());
        if (parsed.success) {
          waitUntil(
            dispatchScheduledReport({ attachSession, to }, parsed.data.runId)
          );
        }
        return new Response(null, { status: 202 });
      }
    ),
    POST(
      "/internal/scheduled-run/respond",
      async (request, { attachSession }) => {
        const auth = await routeAuth(request, internalRouteAuth);
        if (auth instanceof Response) return auth;
        const input = respondSchema.parse(await request.json());
        const claimed = await claimScheduledAgentRunInput(
          input.runId,
          input.leaseToken
        );
        if (
          !claimed?.run.pendingInputRequests ||
          !claimed.run.workerSessionId
        ) {
          return new Response(null, { status: 409 });
        }
        const responses = parseAnswers(
          answersFromText(input.answer, claimed.run.pendingInputRequests)
        );
        if (responses.length === 0) {
          await restoreScheduledAgentRunInput(
            input.runId,
            input.leaseToken,
            "The answer did not match the pending request."
          );
          return new Response(null, { status: 422 });
        }
        try {
          await attachSession(claimed.run.workerSessionId).respond(responses, {
            auth: {
              attributes: {
                conversationChannel: claimed.job.conversationChannel,
                conversationId: claimed.job.conversationId,
                scheduleId: claimed.job.id,
                scheduledRunId: claimed.run.id,
                workspaceId: claimed.job.workspaceId,
              },
              authenticator: "scheduled-input",
              issuer: "open-instinct",
              principalId: claimed.job.createdByUserId,
              principalType: "user",
            },
          });
          await finishScheduledAgentRunInput(input.runId, input.leaseToken);
          return new Response(null, { status: 202 });
        } catch (error) {
          if (SessionNotActiveError.is(error)) {
            await restoreScheduledAgentRunInput(
              input.runId,
              input.leaseToken,
              "The scheduled session is no longer active."
            );
            return new Response(null, { status: 409 });
          }
          await restoreScheduledAgentRunInput(
            input.runId,
            input.leaseToken,
            error instanceof Error ? error.message : String(error)
          );
          return new Response(null, { status: 502 });
        }
      }
    ),
  ],
});

const approvalAliases = new Map([
  ["approve", APPROVE_OPTION_ID],
  ["approved", APPROVE_OPTION_ID],
  ["yes", APPROVE_OPTION_ID],
  ["deny", DENY_OPTION_ID],
  ["denied", DENY_OPTION_ID],
  ["no", DENY_OPTION_ID],
]);

// Answers each pending request from the user's text: an option's number, ID,
// or label selects it, and other text answers requests that accept free text.
function answersFromText(
  text: string,
  requests: readonly Interaction[]
): Answer[] {
  const normalized = text.trim().toLowerCase();
  return requests.flatMap(({ interactionId, request }): Answer[] => {
    const options = request.options ?? [];
    if (options.length === 0) return [{ interactionId, text }];
    const byNumber = /^\d+$/.test(normalized)
      ? options[Number(normalized) - 1]
      : undefined;
    const alias =
      request.kind === "approval" ? approvalAliases.get(normalized) : undefined;
    const option =
      byNumber ??
      options.find(
        ({ id, label }) =>
          id.toLowerCase() === normalized ||
          label.toLowerCase() === normalized ||
          id === alias
      );
    if (option) return [{ interactionId, optionId: option.id }];
    return request.allowFreeform ? [{ interactionId, text }] : [];
  });
}
