import {
  defaultGitHubAuth,
  type GitHubComment,
  type GitHubInboundContext,
  githubChannel,
} from "eve/channels/github";
import { FACTORY_BRANCH_PREFIX, FACTORY_LABEL } from "#lib/constants.js";
import { mentionPattern, resolveBotName } from "#lib/github/bot-name.js";
import { githubCredentials } from "#lib/github/credentials.js";
import { stampAutonomous, stampTrusted } from "#lib/trust.js";

/**
 * Commenter roles allowed to start a session by mentioning the agent.
 *
 * @remarks
 * GitHub's `author_association` on the comment payload. Anything outside this
 * set (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, MANNEQUIN) is a user the
 * repo hasn't trusted with write access, so their mentions are acknowledged
 * without dispatching.
 */
const TRUSTED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

/**
 * Replicates the channel's built-in ignore rules: eve's own marker comments,
 * bot authors, and the agent's own `<bot>[bot]` login.
 */
const isIgnoredComment = (comment: GitHubComment, botName: string): boolean => {
  if (comment.body.includes("<!-- eve:github:")) {
    return true;
  }
  const { author } = comment;
  if (author === undefined) {
    return false;
  }
  return author.type === "Bot" || author.login.toLowerCase() === `${botName.toLowerCase()}[bot]`;
};

const isTrustedCommenter = (comment: GitHubComment): boolean => {
  const association = comment.raw.author_association;
  return typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association);
};

/**
 * Repository roles allowed to hand an issue to the factory by labeling it.
 *
 * @remarks
 * GitHub's fine-grained role names from the collaborator-permission endpoint.
 * Triage is the floor: it is the permission normally required to apply a
 * label by hand.
 */
const TRUSTED_LABELER_ROLES = new Set(["admin", "maintain", "write", "triage"]);

/**
 * Whether the webhook sender holds at least triage permission on the repo.
 *
 * @remarks
 * The issues webhook carries the issue author's association, never the
 * labeler's, and GitHub fires the `labeled` action even for labels attached
 * at creation time, which issue templates let unauthenticated reporters do.
 * Verifying the sender's permission against the API is what keeps the
 * unattended pipeline maintainer-triggered. Fails closed: an API error
 * acknowledges the event without dispatching.
 */
const isTrustedLabeler = async (ctx: GitHubInboundContext): Promise<boolean> => {
  try {
    const response = await ctx.github.request<{
      permission?: string;
      role_name?: string;
    }>({
      method: "GET",
      path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/collaborators/${encodeURIComponent(ctx.sender.login)}/permission`,
    });
    if (!response.ok) {
      return false;
    }
    const role = response.body.role_name ?? response.body.permission;
    return typeof role === "string" && TRUSTED_LABELER_ROLES.has(role);
  } catch {
    return false;
  }
};

/**
 * Task injected into an unattended intake session (an issue labeled with the
 * factory label). The issue's content is already in the session's context
 * when this runs.
 */
const FACTORY_INTAKE_TASK = [
  `This issue was handed to the factory with the "${FACTORY_LABEL}" label, and this run is unattended: nobody is watching to answer a question or approve an action, so never use ask_question and never attempt an action that needs approval.`,
  "Run the work item through the full pipeline. If the classifier needs clarification, post its questions as a comment on the issue and stop; someone will re-label the issue when they've answered.",
  "Keep the requester in the loop as you go: post a short comment on this issue when a station completes, except the last one. Comments on this issue are the one conversational write this run has; you cannot comment anywhere else.",
  "Deliver the finished work as a draft pull request. The message you end the run with appears on this issue for you: link the pull request there, and let it stand in for the progress comment for this final step.",
].join("\n\n");

/**
 * How many automated CI-fix attempts a factory pull request gets before the
 * factory pauses and hands the problem to a person.
 */
const MAX_CI_FIX_ATTEMPTS = 2;

/**
 * Task injected when a check suite fails on one of the factory's own pull
 * requests. The session is anchored to that pull request's thread.
 *
 * @remarks
 * The attempt cap is counted from the fix-attempt comments earlier runs
 * posted on the pull request, because each dispatch is a fresh session with
 * no memory of the last one: the thread is the only durable record they
 * share. That's also why the task posts the attempt comment before fixing,
 * not after; a run that dies mid-fix still leaves its mark for the next one
 * to count.
 */
const CI_FIX_TASK = [
  "A CI check suite failed on one of the factory's own pull requests. This run is unattended: nobody is watching to answer a question or approve an action, so never use ask_question and never attempt an action that needs approval.",
  "Before anything else, read the pull request and its check runs fresh. If the checks are green by now, or the failure belongs to a commit that is no longer the branch head, stop without posting anything.",
  `Count your own earlier fix-attempt comments on this pull request. If there are already ${MAX_CI_FIX_ATTEMPTS}, do not attempt another fix. Post one comment saying the factory is pausing its automated CI fixes on this pull request to avoid looping, ${MAX_CI_FIX_ATTEMPTS} attempts have not turned the checks green, and further troubleshooting needs a person. Then stop.`,
  "Otherwise, first post a short comment that a CI fix attempt is starting and what looks broken (future runs count these comments to know when to stop). Diagnose with github__getCiFailureContext, then run the fix as a revision: send the implementer the pull request's context, its branch name, and your diagnosis, and have the reviewer judge the updated branch. Pushing the fix re-runs the checks; do not open a new pull request.",
].join("\n\n");

/**
 * Task injected into the session dispatched when a pull request opens. The
 * PR's metadata and changed-file patches are already in the session's context
 * when this runs; the repo itself is checked out into the sandbox.
 */
const PR_SUMMARY_TASK = [
  "A pull request was just opened. Post one comment that helps reviewers get oriented.",
  "Open with a short paragraph saying what the PR does and why, grounded in its title, description, and diff. Never guess at intent the diff doesn't show.",
  "Then add a markdown table breaking down the changed files: the file path, the kind of change (added, modified, removed, renamed), and what changed in one short phrase. For a very large PR, list the files that carry the substance and roll the rest into a final count row.",
  "Close with one line pointing reviewers at where to start. This comment is a summary, not a review: don't approve, request changes, or ask the author for anything.",
].join("\n\n");

/**
 * GitHub channel: the factory's main intake and delivery surface, as
 * "Foreman".
 *
 * @remarks
 * - Credentials are brokered by Vercel Connect through the shared handle in
 *   `agent/lib/github/credentials.ts`; tokens are resolved per call and never
 *   exposed to the model.
 * - The name the factory answers to is resolved from the GitHub App's own
 *   slug (`agent/lib/github/bot-name.ts`), so the mention follows whatever
 *   the deployer named their app with no configuration, and a hardcoded
 *   handle can't collide with an unrelated GitHub user. `botName` is passed
 *   as the resolver function, not a resolved value: eve calls it on first
 *   use inside request handling, where the deployment's OIDC token exists
 *   (at module load it doesn't, so a value resolved here would pin the
 *   fallback), caches a fulfilled name, and retries a rejection on the next
 *   event.
 * - `onComment` replaces the built-in mention gate to add an authorization
 *   check: it keeps the default mention and ignore rules, then dispatches
 *   only when the commenter's `author_association` marks them as trusted with
 *   the repo (owner, member, or collaborator). The dispatch stamps the
 *   `trusted` auth attribute, which is what lets the approval policies run
 *   reversible writes without a card. Mentions from anyone else are
 *   acknowledged without a session, so arbitrary accounts on a public repo
 *   cannot drive the agent's write tools.
 * - `onIssue` is the unattended intake: adding the factory label hands the
 *   issue to the pipeline. Only the `labeled` action dispatches, and the
 *   labeler's repository permission is verified against the API first,
 *   because GitHub fires `labeled` even for labels attached at creation time
 *   and issue templates let unauthenticated reporters do exactly that; below
 *   triage, the event is acknowledged without a session. The factory label is
 *   matched against the issue's current `labels` array rather than a single
 *   "added label" field, because eve exposes the issue object as `issue.raw`,
 *   not the raw webhook payload that carries the just-added label. The turn
 *   itself runs unattended: the auth is rewritten to the constructed
 *   autonomous principal with the intake issue number stamped in, and the
 *   approval policies deny it everything except labels, progress comments on
 *   that one issue, closing or reopening issues, and draft pull requests.
 * - `onPullRequest` dispatches only on the `opened` action and skips PRs
 *   opened by bots, which covers Dependabot and the factory's own
 *   `foreman[bot]` pull requests. It is deliberately not gated by
 *   `author_association`: summarizing outside contributors' PRs is the point,
 *   and the injected task is scoped to posting a single summary comment.
 * - `onCheckSuite` is the red-CI fix loop, scoped to the factory's own work:
 *   it dispatches only when a suite completes with a failure conclusion on a
 *   pull request whose head branch carries the factory prefix, so a person's
 *   red PR never triggers an uninvited fix. The session runs unattended under
 *   the autonomous principal, anchored to the pull request, and the injected
 *   task bounds the loop by counting earlier fix-attempt comments on the
 *   thread. Requires the connector to subscribe to the `check_suite` webhook
 *   event.
 * - Human-in-the-loop prompts are the channel's own (eve ≥ 0.34 posts them by
 *   default): when a session stops for approval or input, the channel renders
 *   the request as a comment with a mention-based reply instruction. Passing
 *   the `botName` resolver is what makes both the instruction and the reply's
 *   mention-stripping correct, and `onComment`'s gate is what keeps a reply
 *   an authorization signal: only mentions from owners, members, and
 *   collaborators ever reach the waiting session.
 */
export default githubChannel({
  botName: resolveBotName,
  credentials: githubCredentials,
  onCheckSuite: (ctx, suite) => {
    const raw = suite.raw as {
      head_branch?: unknown;
      check_suite?: { head_branch?: unknown };
    };
    const headBranch = raw.head_branch ?? raw.check_suite?.head_branch;
    const [pullNumber] = suite.pullRequests;
    if (
      suite.action !== "completed" ||
      suite.conclusion !== "failure" ||
      pullNumber === undefined ||
      typeof headBranch !== "string" ||
      !headBranch.startsWith(FACTORY_BRANCH_PREFIX)
    ) {
      return null;
    }
    return {
      auth: stampAutonomous(defaultGitHubAuth(ctx), pullNumber),
      context: [CI_FIX_TASK],
    };
  },
  onComment: async (ctx, comment) => {
    // A resolution failure means the mention can't be matched; acknowledge
    // without dispatching and let the next event retry.
    const botName = await resolveBotName().catch(() => null);
    if (botName === null) {
      return null;
    }
    return !isIgnoredComment(comment, botName) &&
      mentionPattern(botName).test(comment.body) &&
      isTrustedCommenter(comment)
      ? { auth: stampTrusted(defaultGitHubAuth(ctx)) }
      : null;
  },
  onIssue: async (ctx, issue) => {
    const { labels } = issue.raw as {
      labels?: ReadonlyArray<{ name?: unknown }>;
    };
    const hasFactoryLabel =
      Array.isArray(labels) && labels.some((entry) => entry?.name === FACTORY_LABEL);
    if (
      issue.action !== "labeled" ||
      !hasFactoryLabel ||
      ctx.sender.type === "Bot" ||
      !(await isTrustedLabeler(ctx))
    ) {
      return null;
    }
    return {
      auth: stampAutonomous(defaultGitHubAuth(ctx), issue.issueNumber),
      context: [FACTORY_INTAKE_TASK],
    };
  },
  onPullRequest: (ctx, pullRequest) =>
    pullRequest.action === "opened" && ctx.sender.type !== "Bot"
      ? { auth: defaultGitHubAuth(ctx), context: [PR_SUMMARY_TASK] }
      : null,
});
