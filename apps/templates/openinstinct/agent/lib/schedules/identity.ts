import type { SessionContext } from "eve/context";
import { z } from "zod";

const scheduledReportIdentitySchema = z.object({
  linqReplyAnchorMessageId: z.string().min(1).optional(),
  scheduleId: z.uuid(),
  scheduledReportLeaseToken: z.uuid(),
  scheduledReportSequence: z.coerce.number().int().positive(),
  scheduledRunId: z.uuid(),
  scheduledRunSessionId: z.string().min(1).optional(),
});
const scheduledRunIdentitySchema = z.object({
  scheduledRunId: z.uuid(),
  scheduledRunLeaseToken: z.uuid(),
});

export function scheduledRunIdentity(auth: SessionContext["session"]["auth"]) {
  const caller =
    auth.current?.authenticator === "scheduled-worker"
      ? auth.current
      : auth.initiator?.authenticator === "scheduled-worker"
        ? auth.initiator
        : undefined;
  if (caller?.authenticator !== "scheduled-worker") return undefined;
  const identity = scheduledRunIdentitySchema.safeParse(caller.attributes);
  return identity.success
    ? {
        leaseToken: identity.data.scheduledRunLeaseToken,
        runId: identity.data.scheduledRunId,
      }
    : undefined;
}

export function scheduledReportIdentity(
  auth: SessionContext["session"]["auth"]
) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.authenticator !== "scheduled-result") return undefined;
  const identity = scheduledReportIdentitySchema.safeParse(caller.attributes);
  return identity.success
    ? {
        replyAnchorMessageId: identity.data.linqReplyAnchorMessageId,
        scheduleId: identity.data.scheduleId,
        leaseToken: identity.data.scheduledReportLeaseToken,
        runId: identity.data.scheduledRunId,
        sequence: identity.data.scheduledReportSequence,
        workerSessionId: identity.data.scheduledRunSessionId,
      }
    : undefined;
}
