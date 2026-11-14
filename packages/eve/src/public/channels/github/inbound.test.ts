import { describe, expect, it } from "vitest";

import {
  extractGitHubCommentTrigger,
  githubContinuationToken,
  parseGitHubWebhookEvent,
  shouldDispatchGitHubComment,
} from "#public/channels/github/inbound.js";

function basePayload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    installation: { id: 55 },
    repository: {
      full_name: "vercel/eve",
      id: 123,
      name: "eve",
      owner: { login: "vercel" },
      private: true,
    },
    sender: {
      html_url: "https://github.test/octocat",
      id: 1,
      login: "octocat",
      type: "User",
      url: "https://api.github.test/users/octocat",
    },
    ...extra,
  };
}

function parse(event: string, payload: Record<string, unknown>, contentType = "application/json") {
  return parseGitHubWebhookEvent({
    body:
      contentType === "application/x-www-form-urlencoded"
        ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
        : JSON.stringify(payload),
    contentType,
    headers: new Headers({
      "x-github-delivery": "delivery-1",
      "x-github-event": event,
      "x-github-hook-id": "77",
    }),
  });
}

function parseWithoutGitHubHeaders(payload: Record<string, unknown>) {
  return parseGitHubWebhookEvent({
    body: JSON.stringify(payload),
    contentType: "application/json",
    headers: new Headers(),
  });
}

describe("GitHub inbound parsing", () => {
  it("detects issue comments versus PR timeline comments", () => {
    const issue = parse(
      "issue_comment",
      basePayload({
        action: "created",
        comment: { body: "@testbot hello", id: 10, user: { id: 1, login: "octocat" } },
        issue: { number: 5 },
      }),
    );
    const pr = parse(
      "issue_comment",
      basePayload({
        action: "created",
        comment: { body: "@testbot hello", id: 11, user: { id: 1, login: "octocat" } },
        issue: { number: 7, pull_request: {} },
      }),
    );

    expect(issue).toMatchObject({
      comment: { issueNumber: 5, pullRequestNumber: null },
      conversation: { kind: "issue" },
      kind: "issue_comment",
    });
    expect(pr).toMatchObject({
      comment: { issueNumber: 7, pullRequestNumber: 7 },
      conversation: { kind: "pull_request" },
      kind: "issue_comment",
    });
  });

  it("infers issue comment events when forwarded without GitHub headers", () => {
    const event = parseWithoutGitHubHeaders(
      basePayload({
        action: "created",
        comment: { body: "@testbot hello", id: 10, user: { id: 1, login: "octocat" } },
        issue: { number: 5 },
      }),
    );

    expect(event).toMatchObject({
      comment: { issueNumber: 5, pullRequestNumber: null },
      conversation: { kind: "issue", issueNumber: 5 },
      delivery: {
        event: "issue_comment",
        id: "inferred:issue_comment:10:created",
      },
      kind: "issue_comment",
    });
  });

  it("infers pull request and review comment events when forwarded without GitHub headers", () => {
    const pullRequest = parseWithoutGitHubHeaders(
      basePayload({
        action: "opened",
        pull_request: {
          id: 777,
          number: 7,
        },
      }),
    );
    const reviewComment = parseWithoutGitHubHeaders(
      basePayload({
        action: "created",
        comment: { body: "@testbot simplify", id: 101, user: { id: 1, login: "octocat" } },
        pull_request: { number: 7 },
      }),
    );

    expect(pullRequest).toMatchObject({
      delivery: { event: "pull_request", id: "inferred:pull_request:777:opened" },
      kind: "pull_request",
      pullRequest: { pullRequestNumber: 7 },
    });
    expect(reviewComment).toMatchObject({
      comment: { id: 101, pullRequestNumber: 7 },
      delivery: {
        event: "pull_request_review_comment",
        id: "inferred:pull_request_review_comment:101:created",
      },
      kind: "pull_request_review_comment",
    });
  });

  it("derives inline review-thread roots and supports form-encoded payloads", () => {
    const event = parse(
      "pull_request_review_comment",
      basePayload({
        action: "created",
        comment: {
          body: "@testbot simplify this",
          id: 101,
          in_reply_to_id: 99,
          user: { id: 1, login: "octocat" },
        },
        pull_request: {
          base: {
            ref: "main",
            repo: { default_branch: "main" },
            sha: "base123",
          },
          head: { ref: "feature", sha: "abc123" },
          number: 7,
        },
      }),
      "application/x-www-form-urlencoded",
    );

    expect(event).toMatchObject({
      comment: { id: 101, reviewThreadRootCommentId: 99 },
      conversation: { kind: "review_thread", pullRequestNumber: 7 },
      baseRef: "main",
      baseSha: "base123",
      defaultBranch: "main",
      headRef: "feature",
      headSha: "abc123",
      kind: "pull_request_review_comment",
    });
  });

  it("normalizes pull request webhook refs for checkout-ready state", () => {
    const event = parse(
      "pull_request",
      basePayload({
        action: "opened",
        pull_request: {
          base: {
            ref: "main",
            repo: { default_branch: "main" },
            sha: "base123",
          },
          head: { ref: "feature", sha: "abc123" },
          number: 7,
        },
      }),
    );

    expect(event).toMatchObject({
      baseRef: "main",
      baseSha: "base123",
      defaultBranch: "main",
      headRef: "feature",
      headSha: "abc123",
      kind: "pull_request",
      pullRequest: { headSha: "abc123", pullRequestNumber: 7 },
    });
  });

  it.each([
    {
      event: "check_suite",
      idField: "checkSuiteId",
      object: "check_suite",
    },
    {
      event: "check_run",
      idField: "checkRunId",
      object: "check_run",
    },
  ])("normalizes $event webhook payloads", ({ event, idField, object }) => {
    const parsed = parse(
      event,
      basePayload({
        action: "completed",
        [object]: {
          app: { slug: "github-actions" },
          conclusion: "failure",
          head_sha: "abc123",
          id: 9001,
          pull_requests: [{ number: 7 }, { number: 9 }],
          status: "completed",
        },
      }),
    );

    expect(parsed).toMatchObject({
      [object === "check_suite" ? "checkSuite" : "checkRun"]: {
        action: "completed",
        app: { slug: "github-actions" },
        conclusion: "failure",
        headSha: "abc123",
        [idField]: 9001,
        pullRequests: [7, 9],
        status: "completed",
      },
      conversation: { kind: "pull_request", pullRequestNumber: 7 },
      kind: event,
    });
  });

  it("normalizes workflow_run payloads with the GitHub Actions app identity", () => {
    const event = parse(
      "workflow_run",
      basePayload({
        action: "completed",
        workflow_run: {
          conclusion: "failure",
          head_sha: "abc123",
          id: 9001,
          pull_requests: [{ number: 7 }],
          status: "completed",
        },
      }),
    );

    expect(event).toMatchObject({
      conversation: { kind: "pull_request", pullRequestNumber: 7 },
      kind: "workflow_run",
      workflowRun: {
        action: "completed",
        app: { slug: "github-actions" },
        conclusion: "failure",
        headSha: "abc123",
        pullRequests: [7],
        status: "completed",
        workflowRunId: 9001,
      },
    });
  });

  it("extracts and strips the bot mention from a comment body", () => {
    expect(
      extractGitHubCommentTrigger({
        body: "Can you help, @testbot?",
        botName: "testbot",
      }),
    ).toMatchObject({
      kind: "mention",
      message: "Can you help, ?",
    });
    expect(
      extractGitHubCommentTrigger({
        body: "no mention here",
        botName: "testbot",
      }),
    ).toBeNull();
  });

  it("ignores bot and hidden-marker comments in default dispatch", () => {
    expect(
      shouldDispatchGitHubComment({
        author: {
          htmlUrl: undefined,
          id: 2,
          login: "github-actions[bot]",
          type: "Bot",
          url: undefined,
        },
        body: "@testbot run",
        botName: "testbot",
      }),
    ).toBe(false);
    expect(
      shouldDispatchGitHubComment({
        body: "<!-- eve:github:status:s1:x -->\n@testbot run",
        botName: "testbot",
      }),
    ).toBe(false);
  });

  it("builds continuation tokens for GitHub-native conversation anchors", () => {
    expect(
      githubContinuationToken({
        conversationKind: "issue",
        issueNumber: 5,
        repositoryId: 123,
      }),
    ).toBe("repo:123:issue:5");
    expect(
      githubContinuationToken({
        conversationKind: "review_thread",
        pullRequestNumber: 7,
        repositoryId: 123,
        reviewThreadRootCommentId: 99,
      }),
    ).toBe("repo:123:pull:7:review-comment:99");
  });
});
