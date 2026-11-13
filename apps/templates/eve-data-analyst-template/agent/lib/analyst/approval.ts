import type { SessionAuthContext } from "eve/context";
import type {
  ApprovalPolicy,
  ApprovalResponsePolicy,
} from "eve/tools/approval";

import { isInteractiveHuman, resolveAnalystRole } from "#lib/analyst/access";
import type { RoleResolution } from "#lib/analyst/access";
import { recordQueryEstimate } from "#lib/analyst/approval-card";
import { analystConfig } from "#lib/analyst/config";
import {
  explainQuery,
  isWarehouseUnavailable,
  WarehouseUnavailableError,
} from "#lib/analyst/postgres";
import { isString } from "#lib/values";

/** run_sql input as seen by the approval policy. */
export interface RunSqlApprovalInput {
  readonly purpose: string;
  readonly sql: string;
}

const isSamePrincipal = (a: SessionAuthContext, b: SessionAuthContext) =>
  a.authenticator === b.authenticator &&
  a.issuer === b.issuer &&
  a.principalType === b.principalType &&
  a.principalId === b.principalId;

/* Postgres messages have no final period, while the analyst's own messages do. */
const asSentence = (text: string): string =>
  /[.!?]$/u.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`;

const slackUserId = (auth: SessionAuthContext): string | null => {
  const userId = auth.attributes.user_id;
  return auth.authenticator === "slack-webhook" && isString(userId)
    ? userId
    : null;
};

/**
 * Decides whether a run_sql call needs the asker's approval, based on its planner cost.
 *
 * @param ctx - Approval context with the caller and the proposed input.
 * @returns `not-applicable` for cheap queries, `user-approval` for expensive ones, or a denial with a reason the model can act on.
 * @remarks Plans the exact wrapped query. Non-human callers are told to narrow expensive queries instead of waiting for approval. Planner errors fail closed as denials whose reason carries the Postgres message. Connection, authentication, role-setup, and server failures tell the model to stop and tell the person, and every other error tells it to fix the SQL or report a missing grant. Use it inside an inline `approval: { request, response }` object; eve compiles the tool's `approval` property from source.
 */
export const requestRunSqlApproval: ApprovalPolicy<
  RunSqlApprovalInput
> = async ({ callId, session, toolInput }) => {
  const caller = session.auth.current;
  let access: RoleResolution;
  try {
    access = resolveAnalystRole(caller);
  } catch (error) {
    // Missing or invalid settings, as right after deploying: a thrown policy error would fail the
    // whole turn, so deny with the setup message for the model to relay instead.
    return {
      reason: error instanceof Error ? error.message : String(error),
      type: "denied",
    };
  }
  if (!access.ok) {
    return { reason: access.reason, type: "denied" };
  }
  if (!toolInput?.sql) {
    return "not-applicable";
  }
  try {
    const plan = await explainQuery(toolInput.sql, access.role);
    if (plan.forbidden) {
      return {
        reason: `Queries can't call ${plan.forbidden}().`,
        type: "denied",
      };
    }
    const threshold = analystConfig().ANALYST_APPROVAL_COST;
    if (plan.totalCost <= threshold) {
      return "not-applicable";
    }
    if (!(caller && isInteractiveHuman(caller))) {
      return {
        reason:
          "This query is too expensive to run without a person's approval. Narrow it with a tighter time range or more aggregation and try again.",
        type: "denied",
      };
    }
    recordQueryEstimate(callId, {
      askerSlackUserId: slackUserId(caller),
      planRows: plan.planRows,
      sql: toolInput.sql,
      threshold,
      totalCost: plan.totalCost,
    });
    return "user-approval";
  } catch (error) {
    const detail = asSentence(
      error instanceof Error ? error.message : String(error)
    );
    if (!isWarehouseUnavailable(error)) {
      return {
        reason: `Postgres rejected this query while planning it: ${detail} If it names a table or column the person can't access, tell them. Otherwise fix the SQL and try again.`,
        type: "denied",
      };
    }
    // WarehouseUnavailableError messages already say so; raw SQLSTATE failures need the lead-in.
    const unavailable =
      error instanceof WarehouseUnavailableError
        ? detail
        : `The warehouse is unavailable: ${detail}`;
    return {
      reason: `${unavailable} Tell the person and stop, because changing the query won't help.`,
      type: "denied",
    };
  }
};

/**
 * Admits an approval response only from the person who asked.
 *
 * @param ctx - Response context with the requesting and responding principals.
 * @returns `allowed` for the asking principal when it is a person or `local-dev`, otherwise a rejection.
 */
export const respondToRunSqlApproval: ApprovalResponsePolicy<
  RunSqlApprovalInput
> = ({ request, response }) =>
  request.principal &&
  isSamePrincipal(request.principal, response.principal) &&
  isInteractiveHuman(response.principal)
    ? { status: "allowed" }
    : {
        reason:
          "Only the person who asked this question can run or cancel this query.",
        status: "rejected",
      };
