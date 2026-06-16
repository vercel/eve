import {
  callGitHubApi,
  createGitHubIssueComment,
  createGitHubReaction,
  createGitHubReviewCommentReply,
  type GitHubApiMethod,
  type GitHubApiOptions,
  type GitHubApiResponse,
  type GitHubJsonObject,
  type GitHubPostedComment,
  type GitHubReactionContent,
} from "#public/channels/github/api.js";
import type { GitHubChannelCredentials } from "#public/channels/github/auth.js";
import type {
  GitHubConversationKind,
  GitHubRepositoryRef,
} from "#public/channels/github/inbound.js";

/** Minimal config needed to rebuild GitHub API handles. */
export interface GitHubBindingConfig {
  readonly api?: GitHubApiOptions;
  readonly credentials?: GitHubChannelCredentials;
}

/** Serializable state fields needed to rebuild GitHub API handles. */
export interface GitHubBindingState {
  readonly conversationKind: GitHubConversationKind;
  readonly installationId: number | null;
  readonly issueNumber: number | null;
  readonly owner: string;
  readonly pullRequestNumber: number | null;
  readonly repo: string;
  readonly repositoryId: number;
  readonly reviewCommentId: number | null;
  readonly reviewThreadRootCommentId: number | null;
  readonly triggeringCommentId: number | null;
}

/** GitHub operations exposed to hooks and events. */
export interface GitHubHandle {
  readonly installationId: number | undefined;
  readonly repository: GitHubRepositoryRef;
  /**
   * Calls an arbitrary GitHub REST path with installation-token auth. Use this
   * for any GitHub operation the channel does not wrap natively.
   */
  request<T = unknown>(input: {
    readonly body?: GitHubJsonObject;
    readonly method: GitHubApiMethod;
    readonly path: string;
  }): Promise<GitHubApiResponse<T>>;
}

/** Thread-scoped operations for the current GitHub conversation. */
export interface GitHubThread {
  readonly kind: GitHubConversationKind;
  /**
   * Posts a reply into the conversation. On review threads (`kind ===
   * "review_thread"`) this adds a review-comment reply; otherwise it adds an
   * issue or PR timeline comment.
   */
  post(message: string): Promise<GitHubPostedComment>;
  /**
   * Adds a reaction to the triggering comment. Silently no-ops when there is no
   * comment to react to (e.g. a proactive `receive()` conversation with no
   * triggering comment).
   */
  react(content: GitHubReactionContent): Promise<void>;
}

/** Rebuilds GitHub API and thread handles from durable channel state. */
export function buildGitHubBinding(input: {
  readonly config: GitHubBindingConfig;
  readonly state: GitHubBindingState;
}): { readonly github: GitHubHandle; readonly thread: GitHubThread } {
  const { config, state } = input;
  const repository: GitHubRepositoryRef = {
    fullName: `${state.owner}/${state.repo}`,
    id: state.repositoryId,
    name: state.repo,
    owner: state.owner,
    private: false,
  };
  const installationId = state.installationId ?? undefined;

  const github: GitHubHandle = {
    installationId,
    repository,
    request(req) {
      return callGitHubApi({
        api: config.api,
        body: req.body,
        credentials: config.credentials,
        installationId,
        method: req.method,
        path: req.path,
      });
    },
  };

  const thread: GitHubThread = {
    kind: state.conversationKind,
    post(message) {
      if (state.conversationKind === "review_thread") {
        return createGitHubReviewCommentReply({
          api: config.api,
          body: message,
          commentId: requiredStateNumber(
            state.reviewThreadRootCommentId ?? state.reviewCommentId,
            "reviewThreadRootCommentId",
          ),
          credentials: config.credentials,
          installationId,
          owner: state.owner,
          pullRequestNumber: requiredStateNumber(state.pullRequestNumber, "pullRequestNumber"),
          repo: state.repo,
        });
      }
      return createGitHubIssueComment({
        api: config.api,
        body: message,
        credentials: config.credentials,
        installationId,
        issueNumber: requiredStateNumber(
          state.issueNumber ?? state.pullRequestNumber,
          "issueNumber",
        ),
        owner: state.owner,
        repo: state.repo,
      });
    },
    async react(content) {
      const commentId =
        state.conversationKind === "review_thread"
          ? state.reviewCommentId
          : state.triggeringCommentId;
      if (commentId === null) return;
      await createGitHubReaction({
        api: config.api,
        commentId,
        content,
        credentials: config.credentials,
        installationId,
        owner: state.owner,
        repo: state.repo,
        subject:
          state.conversationKind === "review_thread"
            ? "pull_request_review_comment"
            : "issue_comment",
      });
    },
  };

  return { github, thread };
}

function requiredStateNumber(value: number | null | undefined, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`githubChannel: missing ${name}.`);
}
