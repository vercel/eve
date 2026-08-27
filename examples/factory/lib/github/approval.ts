import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { intakeIssueNumber, isAutonomous, isScheduleAppAuth, isTrusted } from "../trust.js";

/**
 * Baseline policy for reversible repository writes (comments, issue creation,
 * assignees, reviewer requests, stateless issue updates).
 *
 * @remarks
 * Unattended factory runs are denied outright rather than parked: nobody is
 * watching an autonomous turn, so an approval card would strand the session
 * forever, and a denial resolves server-side in one step. Trusted callers
 * (stamped at dispatch) and schedule app turns run without a card because
 * these writes are reversible and low blast radius. Everyone else, the local
 * dev TUI included, parks on a card, which is also how the approval flow
 * stays demoable.
 */
export function writePolicy(ctx: ApprovalContext): ApprovalStatus {
  const auth = ctx.session.auth.current;
  if (isAutonomous(auth)) {
    return {
      reason:
        "Unattended factory runs may only apply labels, comment on their intake issue, and open draft pull requests.",
      type: "denied",
    };
  }
  if (isTrusted(auth) || isScheduleAppAuth(auth)) {
    return "not-applicable";
  }
  return "user-approval";
}

/**
 * `addIssueComment`: an unattended run may narrate on the issue it was
 * dispatched from, and nowhere else.
 *
 * @remarks
 * A progress comment is as reversible and low blast radius as the label
 * writes {@link labelPolicy} already allows, so denying it bought no safety,
 * only a silent-until-done run. The scope is the containment: the intake
 * issue number is stamped into the session auth at dispatch (on the signed
 * webhook, never from model input), and only a comment targeting that number
 * runs, so instructions injected through the issue body cannot make the run
 * comment anywhere else in the repository. Attended callers follow
 * {@link writePolicy} unchanged.
 */
export function commentPolicy(ctx: ApprovalContext): ApprovalStatus {
  const auth = ctx.session.auth.current;
  if (!isAutonomous(auth)) {
    return writePolicy(ctx);
  }
  const intakeIssue = intakeIssueNumber(auth);
  const input = ctx.toolInput as { issueNumber?: unknown } | undefined;
  if (intakeIssue !== null && input?.issueNumber === intakeIssue) {
    return "not-applicable";
  }
  return {
    reason: `Unattended factory runs may comment only on the issue they were dispatched from${
      intakeIssue === null ? "" : ` (#${intakeIssue})`
    }.`,
    type: "denied",
  };
}

/**
 * The shared factory brain: durable notes about the target repository that
 * feed into every future run.
 *
 * @remarks
 * Reads are always allowed and never routed here; this policy gates writes
 * only. Because a brain entry becomes context for every later run, an
 * unattended run is denied writes rather than parked (nobody is watching, and
 * a labeled issue's body is untrusted input that must not be able to poison
 * the shared brain). Trusted callers and schedule turns write without a card;
 * every other human caller, the dev TUI included, parks on one.
 */
export function factoryBrainPolicy(ctx: ApprovalContext): ApprovalStatus {
  const auth = ctx.session.auth.current;
  if (isAutonomous(auth)) {
    return {
      reason: "Unattended factory runs may read the factory brain but not write to it.",
      type: "denied",
    };
  }
  if (isTrusted(auth) || isScheduleAppAuth(auth)) {
    return "not-applicable";
  }
  return "user-approval";
}

/**
 * Label writes: the one reversible write an unattended run also needs, so it
 * can mark the work item as picked up.
 */
export function labelPolicy(ctx: ApprovalContext): ApprovalStatus {
  return isAutonomous(ctx.session.auth.current) ? "not-applicable" : writePolicy(ctx);
}

/**
 * Policy for shipping work: marking a pull request ready for review.
 *
 * @remarks
 * This parks for every human caller, trusted or not; shipping is the factory's
 * human gate. Unattended runs are denied outright.
 */
export function shipPolicy(ctx: ApprovalContext): ApprovalStatus {
  if (isAutonomous(ctx.session.auth.current)) {
    return {
      reason: "Unattended factory runs stop at a draft pull request; a person marks it ready.",
      type: "denied",
    };
  }
  return "user-approval";
}

/**
 * Closing and reopening issues: routine, reversible triage, so it runs for
 * every caller that can reach it, unattended runs included.
 *
 * @remarks
 * Closing a duplicate or stale issue is everyday triage, and a reopen undoes
 * it, so gating it as a ship action added friction without protecting much.
 * The only sessions that reach the issue-lifecycle tools are trusted mentions,
 * autonomous label runs, and the local dev TUI; an untrusted public commenter
 * never gets a session (see the channel's `onComment`), so allowing this can't
 * hand issue control to an arbitrary account. Unlike {@link commentPolicy}
 * this is deliberately not scoped to one issue, because deduplication closes
 * the duplicates, not the intake issue.
 */
export function closeIssuePolicy(): ApprovalStatus {
  return "not-applicable";
}

/**
 * `createPullRequest`: a draft runs for every caller, anything that can be
 * merged follows {@link shipPolicy}.
 *
 * @remarks
 * A draft cannot merge, so an unattended run can deliver its finished work
 * without a card while marking the PR ready stays a human act.
 */
export function createPullRequestPolicy(ctx: ApprovalContext): ApprovalStatus {
  const input = ctx.toolInput as { draft?: unknown } | undefined;
  if (input?.draft === true) {
    return "not-applicable";
  }
  return shipPolicy(ctx);
}

/**
 * `updateIssue`: setting `state` closes or reopens the issue, so those calls
 * follow {@link closeIssuePolicy}; stateless updates follow
 * {@link writePolicy}.
 *
 * @remarks
 * The split keeps the two paths honest: a close or reopen through
 * `updateIssue` is the same reversible triage as `closeIssue` and runs the
 * same way, while a stateless edit (title, body, labels) stays under the
 * baseline write policy.
 */
export function updateIssuePolicy(ctx: ApprovalContext): ApprovalStatus {
  const input = ctx.toolInput as { state?: unknown } | undefined;
  if (input?.state !== undefined) {
    return closeIssuePolicy();
  }
  return writePolicy(ctx);
}
