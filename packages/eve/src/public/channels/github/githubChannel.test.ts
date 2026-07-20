import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionKey } from "#context/keys.js";
import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  clearGitHubInstallationTokenCache,
  seedGitHubInstallationTokenForTests,
} from "#public/channels/github/auth.js";
import { defaultGitHubAuth } from "#public/channels/github/defaults.js";
import { githubChannel } from "#public/channels/github/githubChannel.js";
import { type GitHubChannelState } from "#public/channels/github/state.js";
import { signGitHubWebhookBody } from "#public/channels/github/verify.js";

const SECRET = "github-secret";

function prContextFetch() {
  return vi.fn((input: Request | URL | string): Promise<Response> => {
    if (String(input).includes("/files")) {
      return Promise.resolve(new Response(JSON.stringify([])));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          base: {
            ref: "main",
            repo: { default_branch: "main", full_name: "vercel/eve" },
            sha: "base-sha",
          },
          head: {
            ref: "feature",
            repo: { full_name: "octocat/eve" },
            sha: "head-sha",
          },
          number: 7,
          title: "Add GitHub context",
          user: { id: 42, login: "octocat", type: "User" },
        }),
      ),
    );
  });
}

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a CompiledChannel.");
  return channel as CompiledChannel<T>;
}

function getAdapter(channel: unknown): ChannelAdapter<any> {
  return asCompiled(channel).adapter;
}

function withState(
  adapter: ChannelAdapter<any>,
  state: Partial<GitHubChannelState>,
): ChannelAdapter<any> {
  return { ...adapter, state: { ...adapter.state, ...state } };
}

function stubAccessor() {
  return { get: () => undefined, set: () => {} } as any;
}

function createAlsContext(sandbox?: MockSandbox): ContextContainer {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "test-session",
    turn: { id: "test-turn", sequence: 0 },
  });
  if (sandbox !== undefined) ctx.setVirtualContext(SandboxKey, sandbox.access);
  return ctx;
}

const stubAlsContext = createAlsContext();

function callEvent(
  adapter: ChannelAdapter,
  event: HandleMessageStreamEvent,
  ctx: any,
  sandbox?: MockSandbox,
): Promise<HandleMessageStreamEvent> {
  return contextStorage.run(
    sandbox === undefined ? stubAlsContext : createAlsContext(sandbox),
    () => callAdapterEventHandler(adapter, event, ctx),
  );
}

function makeEvent<T extends HandleMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): HandleMessageStreamEvent {
  return { data, type } as HandleMessageStreamEvent;
}

function signedRequest(event: string, payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  return new Request("https://example.com/eve/v1/github", {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": event,
      "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
    },
    method: "POST",
  });
}

function signedRequestWithoutGitHubHeaders(payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  return new Request("https://example.com/eve/v1/github", {
    body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
    },
    method: "POST",
  });
}

/** Builds a webhook request carrying a deliberately invalid HMAC signature. */
function badlySignedRequest(event: string, payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  return new Request("https://example.com/eve/v1/github", {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": event,
      "x-hub-signature-256": "sha256=deliberately-invalid",
    },
    method: "POST",
  });
}

function basePayload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    installation: { id: 55 },
    repository: {
      full_name: "vercel/eve",
      id: 123,
      name: "eve",
      owner: { login: "vercel" },
      private: false,
    },
    sender: { id: 1, login: "octocat", type: "User" },
    ...extra,
  };
}

async function firePost(
  channel: unknown,
  request: Request,
): Promise<{
  readonly response: Response;
  readonly send: ReturnType<typeof vi.fn>;
  readonly waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled<GitHubChannelState>(channel);
  const post = compiled.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected github channel to define a POST route.");
  }
  const send = vi.fn().mockResolvedValue({ continuationToken: "github:test", id: "s1" });
  const waitUntil = vi.fn();

  const response = await post.handler(request, {
    cancel: vi.fn(),
    getSession: vi.fn() as any,
    params: {},
    receive: vi.fn() as any,
    requestIp: null,
    send,
    waitUntil,
  });

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}

describe("githubChannel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearGitHubInstallationTokenCache();
    for (const apiBaseUrl of ["https://api.github.com", "https://github.test"]) {
      seedGitHubInstallationTokenForTests({ apiBaseUrl, installationId: 55, token: "ghs_test" });
    }
  });

  it("acks ping deliveries without dispatching", async () => {
    const channel = githubChannel({ credentials: { webhookSecret: SECRET } });
    const { response, send } = await firePost(channel, signedRequest("ping", basePayload({})));

    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches mentioned issue comments with auth, context, token, and state", async () => {
    const channel = githubChannel({
      botName: "testbot",
      credentials: { webhookSecret: SECRET },
    });
    const { send } = await firePost(
      channel,
      signedRequest(
        "issue_comment",
        basePayload({
          action: "created",
          comment: {
            body: "@testbot help me",
            html_url: "https://github.test/vercel/eve/issues/5#issuecomment-10",
            id: 10,
            user: { id: 1, login: "octocat", type: "User" },
          },
          issue: { number: 5 },
        }),
      ),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload.message).toContain("<github_context>");
    expect(payload.message).toContain("help me");
    expect(payload.inputResponses).toBeUndefined();
    expect(options).toMatchObject({
      auth: {
        attributes: {
          conversation_kind: "issue",
          delivery_id: "delivery-1",
          issue_number: "5",
          repository: "vercel/eve",
          user_login: "octocat",
        },
        authenticator: "github-webhook",
        principalId: "github:1",
      },
      continuationToken: "repo:123:issue:5",
      state: {
        conversationKind: "issue",
        issueNumber: 5,
        owner: "vercel",
        repo: "eve",
        triggeringCommentId: 10,
      },
    });
  });

  it("dispatches Connect-forwarded issue comments without GitHub event headers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = githubChannel({
      botName: "testbot",
      credentials: { webhookSecret: SECRET },
    });
    const { send } = await firePost(
      channel,
      signedRequestWithoutGitHubHeaders(
        basePayload({
          action: "created",
          comment: {
            body: "@testbot help me",
            html_url: "https://github.test/vercel/eve/issues/5#issuecomment-10",
            id: 10,
            user: { id: 1, login: "octocat", type: "User" },
          },
          issue: { number: 5 },
        }),
      ),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload.message).toContain("delivery_id: inferred:issue_comment:10:created");
    expect(payload.message).toContain("help me");
    expect(options).toMatchObject({
      auth: {
        attributes: {
          delivery_id: "inferred:issue_comment:10:created",
        },
      },
      continuationToken: "repo:123:issue:5",
    });
    expect(warn).toHaveBeenCalledWith(
      "[eve:github.channel] GitHub webhook missing standard headers; inferred metadata from payload",
      expect.objectContaining({
        deliveryId: "inferred:issue_comment:10:created",
        event: "issue_comment",
        missingHeaders: ["x-github-event", "x-github-delivery"],
        repository: "vercel/eve",
      }),
    );
  });

  it("verifies inbound webhooks via webhookVerifier instead of HMAC when supplied", async () => {
    const verifier = vi.fn().mockResolvedValue(true);
    const channel = githubChannel({
      botName: "testbot",
      credentials: { webhookVerifier: verifier },
    });
    const { response, send } = await firePost(
      channel,
      badlySignedRequest(
        "issue_comment",
        basePayload({
          action: "created",
          comment: {
            body: "@testbot help me",
            id: 10,
            user: { id: 1, login: "octocat", type: "User" },
          },
          issue: { number: 5 },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns 401 when webhookVerifier rejects", async () => {
    const verifier = vi.fn().mockRejectedValue(new Error("nope"));
    const channel = githubChannel({
      botName: "testbot",
      credentials: { webhookVerifier: verifier },
    });
    const { response, send } = await firePost(
      channel,
      signedRequest(
        "issue_comment",
        basePayload({
          action: "created",
          comment: {
            body: "@testbot help me",
            id: 10,
            user: { id: 1, login: "octocat", type: "User" },
          },
          issue: { number: 5 },
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not dispatch unmentioned default issue comments", async () => {
    const channel = githubChannel({
      botName: "testbot",
      credentials: { webhookSecret: SECRET },
    });
    const { send } = await firePost(
      channel,
      signedRequest(
        "issue_comment",
        basePayload({
          action: "created",
          comment: { body: "hello", id: 10, user: { id: 1, login: "octocat" } },
          issue: { number: 5 },
        }),
      ),
    );

    expect(send).not.toHaveBeenCalled();
  });

  it("injects default pull-request metadata context for PR timeline comments", async () => {
    const fetchMock = prContextFetch();
    const channel = githubChannel({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      botName: "testbot",
      credentials: {
        appId: "test-app",
        webhookSecret: SECRET,
      },
    });

    const { send } = await firePost(
      channel,
      signedRequest(
        "issue_comment",
        basePayload({
          action: "created",
          comment: {
            body: "@testbot review this",
            id: 10,
            user: { id: 1, login: "octocat", type: "User" },
          },
          issue: { number: 7, pull_request: {} },
        }),
      ),
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://github.test/repos/vercel/eve/pulls/7");
    const [payload] = send.mock.calls[0]!;
    expect(payload.context?.[0]).toContain("title: Add GitHub context");
    expect(payload.context?.[0]).toContain("head_sha: head-sha");
  });

  it("dispatches inline review comments to the review-thread token", async () => {
    const channel = githubChannel({
      api: { apiBaseUrl: "https://github.test", fetch: prContextFetch() },
      botName: "testbot",
      credentials: { appId: "test-app", webhookSecret: SECRET },
    });
    const { send } = await firePost(
      channel,
      signedRequest(
        "pull_request_review_comment",
        basePayload({
          action: "created",
          comment: {
            body: "@testbot simplify this",
            id: 101,
            in_reply_to_id: 99,
            user: { id: 1, login: "octocat", type: "User" },
          },
          pull_request: { head: { sha: "abc123" }, number: 7 },
        }),
      ),
    );

    expect(send.mock.calls[0]?.[1]).toMatchObject({
      continuationToken: "repo:123:pull:7:review-comment:99",
      state: {
        conversationKind: "review_thread",
        headSha: "abc123",
        pullRequestNumber: 7,
        reviewThreadRootCommentId: 99,
      },
    });
  });

  it("lets custom hooks drop comments and receive pre-dispatch context without state", async () => {
    const hook = vi.fn().mockReturnValue(null);
    const channel = githubChannel({
      credentials: { webhookSecret: SECRET },
      onComment(ctx, comment) {
        expect("state" in ctx).toBe(false);
        expect(defaultGitHubAuth(ctx).subject).toBe("octocat");
        return hook(comment.body);
      },
    });
    const { send } = await firePost(
      channel,
      signedRequest(
        "issue_comment",
        basePayload({
          action: "created",
          comment: { body: "custom", id: 10, user: { id: 1, login: "octocat" } },
          issue: { number: 5 },
        }),
      ),
    );

    expect(hook).toHaveBeenCalledWith("custom");
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches opt-in issue webhook hooks", async () => {
    const hook = vi.fn();
    const channel = githubChannel({
      credentials: { webhookSecret: SECRET },
      onIssue(ctx, issue) {
        hook(ctx.conversation, issue);
        return { auth: defaultGitHubAuth(ctx) };
      },
    });

    const { send } = await firePost(
      channel,
      signedRequest(
        "issues",
        basePayload({
          action: "opened",
          issue: { number: 5, title: "Track webhook issue events" },
        }),
      ),
    );

    expect(hook).toHaveBeenCalledWith(
      { issueNumber: 5, kind: "issue", pullRequestNumber: null },
      expect.objectContaining({ action: "opened", issueNumber: 5 }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload.message).toContain("Issue opened: #5 Track webhook issue events");
    expect(options).toMatchObject({
      continuationToken: "repo:123:issue:5",
      state: {
        conversationKind: "issue",
        issueNumber: 5,
        owner: "vercel",
        repo: "eve",
      },
    });
  });

  it("dispatches opt-in pull request webhook hooks with checkout-ready state", async () => {
    const hook = vi.fn();
    const channel = githubChannel({
      api: { apiBaseUrl: "https://github.test", fetch: prContextFetch() },
      credentials: { appId: "test-app", webhookSecret: SECRET },
      onPullRequest(ctx, pullRequest) {
        hook(ctx.conversation, pullRequest);
        return { auth: defaultGitHubAuth(ctx) };
      },
    });

    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const { send } = await firePost(
      channel,
      signedRequest(
        "pull_request",
        basePayload({
          action: "opened",
          pull_request: {
            base: {
              ref: "main",
              repo: { default_branch: "main" },
              sha: baseSha,
            },
            head: { ref: "feature", sha: headSha },
            number: 7,
            title: "Add webhook PR handling",
          },
        }),
      ),
    );

    expect(hook).toHaveBeenCalledWith(
      { issueNumber: null, kind: "pull_request", pullRequestNumber: 7 },
      expect.objectContaining({ action: "opened", headSha, pullRequestNumber: 7 }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload.message).toContain("Pull request opened: #7 Add webhook PR handling");
    expect(options).toMatchObject({
      continuationToken: "repo:123:pull:7",
      state: {
        baseRef: "main",
        baseSha,
        conversationKind: "pull_request",
        defaultBranch: "main",
        headRef: "feature",
        headSha,
        issueNumber: 7,
        pullRequestNumber: 7,
      },
    });
  });

  it.each([
    { event: "check_suite", label: "Check suite", object: "check_suite" },
    { event: "check_run", label: "Check run", object: "check_run" },
    { event: "workflow_run", label: "Workflow run", object: "workflow_run" },
  ])("dispatches opt-in $event webhook hooks on the first associated PR", async (testCase) => {
    const hook = vi.fn();
    const commonConfig = {
      api: { apiBaseUrl: "https://github.test", fetch: prContextFetch() },
      credentials: { appId: "test-app", webhookSecret: SECRET },
    };
    const channel =
      testCase.event === "check_suite"
        ? githubChannel({
            ...commonConfig,
            onCheckSuite(ctx, checkSuite) {
              hook(ctx.conversation, checkSuite);
              return { auth: defaultGitHubAuth(ctx) };
            },
          })
        : testCase.event === "check_run"
          ? githubChannel({
              ...commonConfig,
              onCheckRun(ctx, checkRun) {
                hook(ctx.conversation, checkRun);
                return { auth: defaultGitHubAuth(ctx) };
              },
            })
          : githubChannel({
              ...commonConfig,
              onWorkflowRun(ctx, workflowRun) {
                hook(ctx.conversation, workflowRun);
                return { auth: defaultGitHubAuth(ctx) };
              },
            });
    const headSha = "c".repeat(40);
    const ciPayload: Record<string, unknown> = {
      conclusion: "failure",
      head_sha: headSha,
      id: 9001,
      pull_requests: [{ number: 7 }, { number: 9 }],
      status: "completed",
    };
    if (testCase.event !== "workflow_run") {
      ciPayload.app = { slug: "github-actions" };
    }

    const { send } = await firePost(
      channel,
      signedRequest(
        testCase.event,
        basePayload({
          action: "completed",
          [testCase.object]: ciPayload,
        }),
      ),
    );

    expect(hook).toHaveBeenCalledWith(
      { issueNumber: null, kind: "pull_request", pullRequestNumber: 7 },
      expect.objectContaining({
        action: "completed",
        app: { slug: "github-actions" },
        conclusion: "failure",
        headSha,
        pullRequests: [7, 9],
        status: "completed",
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload.message).toContain(`${testCase.label} completed: 9001 (failure)`);
    expect(options).toMatchObject({
      continuationToken: "repo:123:pull:7",
      state: {
        conversationKind: "pull_request",
        headSha,
        issueNumber: 7,
        pullRequestNumber: 7,
      },
    });
  });

  it("invokes CI hooks without dispatching when no pull request is associated", async () => {
    const hook = vi.fn();
    const channel = githubChannel({
      credentials: { webhookSecret: SECRET },
      onCheckSuite(ctx, checkSuite) {
        hook(ctx.conversation, checkSuite.pullRequests);
        return { auth: defaultGitHubAuth(ctx) };
      },
    });

    const { send } = await firePost(
      channel,
      signedRequest(
        "check_suite",
        basePayload({
          action: "completed",
          check_suite: {
            app: { slug: "github-actions" },
            conclusion: "failure",
            head_sha: "abc123",
            id: 9001,
            pull_requests: [],
            status: "completed",
          },
        }),
      ),
    );

    expect(hook).toHaveBeenCalledWith(
      { issueNumber: null, kind: "pull_request", pullRequestNumber: null },
      [],
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores issue, pull request, and CI webhooks without opt-in hooks", async () => {
    const channel = githubChannel({
      credentials: { webhookSecret: SECRET },
    });

    const issue = await firePost(
      channel,
      signedRequest(
        "issues",
        basePayload({
          action: "opened",
          issue: { number: 5, title: "Ignored issue" },
        }),
      ),
    );
    const pullRequest = await firePost(
      channel,
      signedRequest(
        "pull_request",
        basePayload({
          action: "opened",
          pull_request: { number: 7, title: "Ignored PR" },
        }),
      ),
    );
    const ciEvents = await Promise.all(
      ["check_suite", "check_run", "workflow_run"].map((event) =>
        firePost(
          channel,
          signedRequest(
            event,
            basePayload({
              action: "completed",
              [event]: {
                app: { slug: "github-actions" },
                conclusion: "failure",
                head_sha: "abc123",
                id: 9001,
                pull_requests: [{ number: 7 }],
                status: "completed",
              },
            }),
          ),
        ),
      ),
    );

    expect(issue.send).not.toHaveBeenCalled();
    expect(pullRequest.send).not.toHaveBeenCalled();
    for (const ciEvent of ciEvents) expect(ciEvent.send).not.toHaveBeenCalled();
  });

  it("posts final messages through the issue comments API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 77 })));
    const adapter = withState(
      getAdapter(
        githubChannel({
          api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
          credentials: {
            appId: "test-app",
            webhookSecret: SECRET,
          },
        }),
      ),
      {
        conversationKind: "issue",
        installationId: 55,
        issueNumber: 5,
        owner: "vercel",
        repo: "eve",
        repositoryId: 123,
      },
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Final answer",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://github.test/repos/vercel/eve/issues/5/comments",
    );
  });

  it("turn.started adds an eyes reaction to the triggering comment", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 77 }))));
    const adapter = withState(
      getAdapter(
        githubChannel({
          api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
          credentials: {
            appId: "test-app",
            webhookSecret: SECRET,
          },
        }),
      ),
      {
        conversationKind: "issue",
        installationId: 55,
        issueNumber: 5,
        owner: "vercel",
        repo: "eve",
        repositoryId: 123,
        triggeringCommentId: 10,
      },
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("turn.started", {
        sequence: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://github.test/repos/vercel/eve/issues/comments/10/reactions",
    ]);
  });

  it("turn.started checks out the triggering GitHub ref", async () => {
    const headSha = "a".repeat(40);
    const sandbox = mockSandbox({
      run(options) {
        if (options.command.includes("git rev-parse HEAD 2>/dev/null")) {
          return { exitCode: 128, stderr: "", stdout: "" };
        }
        if (options.command.includes("git rev-parse HEAD")) {
          return { exitCode: 0, stderr: "", stdout: `${headSha}\n` };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });
    const adapter = withState(
      getAdapter(
        githubChannel({
          credentials: {
            appId: "test-app",
            webhookSecret: SECRET,
          },
        }),
      ),
      {
        conversationKind: "issue",
        headSha,
        installationId: 55,
        issueNumber: 5,
        owner: "vercel",
        repo: "eve",
        repositoryId: 123,
      },
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("turn.started", {
        sequence: 0,
        turnId: "t1",
      }),
      ctx,
      sandbox,
    );

    expect(ctx.state.checkoutPath).toBe("/workspace");
    expect(ctx.state.headSha).toBe(headSha);
    expect(sandbox.commandLog).toContain(
      `cd '/workspace' && GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin '${headSha}'`,
    );
  });
});
