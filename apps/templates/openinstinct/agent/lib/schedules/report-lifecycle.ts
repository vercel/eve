import type { SessionContext } from "eve/context";
import {
  finalizeScheduledReport,
  releaseScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";

export function scheduledReportFromSession(session: SessionContext) {
  return scheduledReportIdentity(session.session.auth);
}

export async function finalizeScheduledReportDelivery(
  session: SessionContext,
  status: "delivered" | "suppressed" = "delivered"
) {
  const report = scheduledReportFromSession(session);
  if (report) {
    const finalized = await finalizeScheduledReport(
      report.runId,
      report.leaseToken,
      status
    );
    if (finalized) {
      console.info("[scheduled-run] report finalized", {
        runId: report.runId,
        sessionId: session.session.id,
        status,
      });
    }
  }
}

export async function releaseScheduledReportDelivery(
  session: SessionContext,
  errorMessage: string
) {
  const report = scheduledReportFromSession(session);
  if (report) {
    const released = await releaseScheduledReport(
      report.runId,
      report.leaseToken,
      errorMessage
    );
    console.warn("[scheduled-run] report turn failed", {
      released,
      runId: report.runId,
      sessionId: session.session.id,
    });
  }
}
