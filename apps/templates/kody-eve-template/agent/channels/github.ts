import { connectGitHubCredentials } from "@vercel/connect/eve";
import {
  defaultGitHubAuth,
  type GitHubComment,
  githubChannel,
} from "eve/channels/github";

const BOT_NAME = "Kody";

/**
 * Matches an `@Kody` mention on a word boundary, the same pattern the
 * channel's built-in comment gate uses. Kept in sync with {@link BOT_NAME}.
 */
const MENTION_PATTERN = /@kody(?=$|[^A-Za-z0-9_-])/iu;

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
 * bot authors, and the agent's own `kody[bot]` login.
 */
const isIgnoredComment = (comment: GitHubComment): boolean => {
  if (comment.body.includes("<!-- eve:github:")) {
    return true;
  }
  const { author } = comment;
  if (author === undefined) {
    return false;
  }
  return (
    author.type === "Bot" ||
    author.login.toLowerCase() === `${BOT_NAME.toLowerCase()}[bot]`
  );
};

const isTrustedCommenter = (comment: GitHubComment): boolean => {
  const association = comment.raw.author_association;
  return (
    typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association)
  );
};

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
 * GitHub channel: @mentions on issues and pull requests, answered in-thread as
 * "Kody", plus a summary comment on every newly opened pull request.
 *
 * @remarks
 * - Credentials are brokered by Vercel Connect. The connector UID comes from
 *   the `GITHUB_CONNECTOR` environment variable (falling back to
 *   `github/kody-agent`); tokens are resolved per call and never exposed to
 *   the model.
 * - `onComment` replaces the built-in mention gate to add an authorization
 *   check: it keeps the default mention and ignore rules, then dispatches
 *   only when the commenter's `author_association` marks them as trusted with
 *   the repo (owner, member, or collaborator). Mentions from anyone else are
 *   acknowledged without a session, so arbitrary accounts on a public repo
 *   cannot drive the agent's write tools.
 * - `onPullRequest` dispatches only on the `opened` action and skips PRs
 *   opened by bots (Dependabot and similar), so automated PRs don't each get
 *   a summary comment. It is deliberately not gated by `author_association`:
 *   summarizing outside contributors' PRs is the point, and the injected task
 *   is scoped to posting a single summary comment. All other PR actions are
 *   acknowledged without dispatching.
 */
export default githubChannel({
  botName: BOT_NAME,
  credentials: connectGitHubCredentials(
    process.env.GITHUB_CONNECTOR ?? "github/kody-agent"
  ),
  onComment: (ctx, comment) =>
    !isIgnoredComment(comment) &&
    MENTION_PATTERN.test(comment.body) &&
    isTrustedCommenter(comment)
      ? { auth: defaultGitHubAuth(ctx) }
      : null,
  onPullRequest: (ctx, pullRequest) =>
    pullRequest.action === "opened" && ctx.sender.type !== "Bot"
      ? { auth: defaultGitHubAuth(ctx), context: [PR_SUMMARY_TASK] }
      : null,
});
