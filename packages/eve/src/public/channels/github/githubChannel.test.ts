import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { SandboxKey, SessionKey } from "#context/keys.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defaultGitHubAuth } from "#public/channels/github/defaults.js";
import { githubChannel } from "#public/channels/github/githubChannel.js";
import { type GitHubChannelState } from "#public/channels/github/state.js";
import { signGitHubWebhookBody } from "#public/channels/github/verify.js";
import type { SandboxRunOptions } from "#public/definitions/sandbox.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";

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
  const accessor = { get: () => undefined, set: () => {} } as any;
  // A step enters its projection before it publishes.
  enterSessionProjection(accessor, undefined);
  return accessor;
}

function createAlsContext(sandbox?: Pick<MockSandbox, "access">): ContextContainer {
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
  event: UnstampedMessageStreamEvent,
  ctx: any,
  sandbox?: Pick<MockSandbox, "access">,
): Promise<UnstampedMessageStreamEvent> {
  return contextStorage.run(
    sandbox === undefined ? stubAlsContext : createAlsContext(sandbox),
    () => callAdapterEventHandler(adapter, event, ctx),
  );
}

function makeEvent<T extends UnstampedMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): UnstampedMessageStreamEvent {
  return { data, type } as UnstampedMessageStreamEvent;
}

const CHECKOUT_HEAD_SHA = "a".repeat(40);

/**
 * A real session over mock primitives, opened with `networkPolicy`. Only the
 * provider's policy setter is faked: it records every write and the policy in
 * force when `git fetch` runs.
 */
function networkPolicySandbox(input: {
  readonly fetchExitCode?: number;
  readonly networkPolicy: SandboxNetworkPolicy;
}) {
  let inForce = input.networkPolicy;
  const writes: SandboxNetworkPolicy[] = [];
  const fetchPolicies: SandboxNetworkPolicy[] = [];
  const primitives = mockSandbox({
    run(options: SandboxRunOptions) {
      if (options.command.includes("git rev-parse HEAD 2>/dev/null")) {
        return { exitCode: 128, stderr: "", stdout: "" };
      }
      if (options.command.includes("git rev-parse HEAD")) {
        return { exitCode: 0, stderr: "", stdout: `${CHECKOUT_HEAD_SHA}\n` };
      }
      if (options.command.includes("git fetch")) {
        fetchPolicies.push(inForce);
        const exitCode = input.fetchExitCode ?? 0;
        return { exitCode, stderr: exitCode === 0 ? "" : "fatal: could not read", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  }).session;
  const session = buildSandboxSession(primitives, async (policy) => {
    writes.push(policy);
    inForce = policy;
  });
  const access: SandboxAccess = {
    async captureState() {
      return { session: null };
    },
    async get() {
      return session;
    },
    async stop() {},
  };
  return {
    access,
    fetchPolicies,
    inForce: () => inForce,
    writes,
  };
}

async function runCheckoutTurn(sandbox: Pick<MockSandbox, "access">) {
  const adapter = withState(
    getAdapter(
      githubChannel({
        credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
      }),
    ),
    {
      conversationKind: "issue",
      headSha: CHECKOUT_HEAD_SHA,
      installationId: 55,
      issueNumber: 5,
      owner: "vercel",
      repo: "eve",
      repositoryId: 123,
    },
  );
  const ctx = buildAdapterContext(adapter, stubAccessor());
  await callEvent(adapter, makeEvent("turn.started", { sequence: 0, turnId: "t1" }), ctx, sandbox);
  return ctx;
}

function checkoutFailureMessages(records: readonly { message: string; fields?: unknown }[]) {
  return records
    .filter((record) => record.message === "GitHub checkout failed — swallowed")
    .map((record) => JSON.stringify(record.fields));
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
  const send = vi.fn().mockResolvedValue({ id: "s1" });
  const waitUntil = vi.fn();

  const response = await post.handler(request, {
    ...mockAgentRouteArgs(),
    attachSession: vi.fn() as any,
    ...mockChannelContext(send),
    params: {},
    to: vi.fn() as any,
    requestIp: null,
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
      onComment: (ctx) => ({ auth: defaultGitHubAuth(ctx), title: "GitHub run" }),
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
    const [continuationToken, input] = send.mock.calls[0]!;
    expect(input.message).toBe("help me");
    expect(input.context).toEqual([expect.stringContaining("<github_context>")]);
    expect(input.context[0]).toContain("bot_name: testbot");
    expect(input.context[0]).toContain("is_mentioned: true");
    expect(input.inputResponses).toBeUndefined();
    expect(continuationToken).toBe("repo:123:issue:5");
    expect(input).toMatchObject({
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
      state: {
        conversationKind: "issue",
        issueNumber: 5,
        owner: "vercel",
        repo: "eve",
        triggeringCommentId: 10,
      },
      title: "GitHub run",
    });
  });

  it("marks an accepted unmentioned issue comment as not mentioned", async () => {
    const channel = githubChannel({
      botName: "testbot",
      credentials: { webhookSecret: SECRET },
      onComment: () => ({ auth: null }),
    });
    const { send } = await firePost(
      channel,
      signedRequest(
        "issue_comment",
        basePayload({
          action: "created",
          comment: {
            body: "Could you investigate?",
            id: 10,
            user: { id: 1, login: "octocat", type: "User" },
          },
          issue: { number: 5 },
        }),
      ),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].context[0]).toContain("bot_name: testbot");
    expect(send.mock.calls[0]![1].context[0]).toContain("is_mentioned: false");
  });

  it("resolves a lazy botName on first dispatch and caches it", async () => {
    const resolveBotName = vi.fn().mockResolvedValue("testbot");
    const channel = githubChannel({
      botName: resolveBotName,
      credentials: { webhookSecret: SECRET },
    });
    const commentRequest = () =>
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
      );

    const first = await firePost(channel, commentRequest());
    const second = await firePost(channel, commentRequest());

    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(first.send.mock.calls[0]![1].message).toBe("help me");
    expect(resolveBotName).toHaveBeenCalledTimes(1);
  });

  it("retries a failed botName resolver on the next delivery instead of pinning", async () => {
    const logs = captureLogRecords();
    const resolveBotName = vi
      .fn()
      .mockRejectedValueOnce(new Error("no request context"))
      .mockRejectedValueOnce(new Error("no request context"))
      .mockResolvedValue("testbot");
    const channel = githubChannel({
      botName: resolveBotName,
      credentials: { webhookSecret: SECRET },
    });
    const commentRequest = () =>
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
      );

    const first = await firePost(channel, commentRequest());
    const second = await firePost(channel, commentRequest());

    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "githubChannel: botName resolver failed; retrying on the next event",
      }),
    );
  });

  it("falls back to the credentials' appSlug when botName is not configured", async () => {
    const channel = githubChannel({
      credentials: { appSlug: "testbot", webhookSecret: SECRET },
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
    expect(send.mock.calls[0]![1].message).toBe("help me");
  });

  it("keeps GitHub metadata separate from the comment text", async () => {
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
            body: "@testbot Yes",
            html_url: "https://github.test/vercel/eve/issues/5#issuecomment-10",
            id: 10,
            user: { id: 1, login: "octocat", type: "User" },
          },
          issue: { number: 5 },
        }),
      ),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [, input] = send.mock.calls[0]!;
    expect(input.message).toBe("Yes");
    expect(input.context).toEqual([expect.stringContaining("<github_context>")]);
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
    const [continuationToken, input] = send.mock.calls[0]!;
    expect(input.message).toBe("help me");
    expect(input.context).toEqual([
      expect.stringContaining("delivery_id: inferred:issue_comment:10:created"),
    ]);
    expect(continuationToken).toBe("repo:123:issue:5");
    expect(input).toMatchObject({
      auth: {
        attributes: {
          delivery_id: "inferred:issue_comment:10:created",
        },
      },
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
    const logs = captureLogRecords();
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
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "warn", message: "github inbound verification failed" }),
    );
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
        installationToken: "ghs_test",
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
    const [, input] = send.mock.calls[0]!;
    expect(input.context?.[0]).toContain("<github_context>");
    expect(input.context?.[1]).toContain("title: Add GitHub context");
    expect(input.context?.[1]).toContain("head_sha: head-sha");
  });

  it("dispatches inline review comments to the review-thread token", async () => {
    const channel = githubChannel({
      api: { apiBaseUrl: "https://github.test", fetch: prContextFetch() },
      botName: "testbot",
      credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
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

    expect(send.mock.calls[0]?.[0]).toBe("repo:123:pull:7:review-comment:99");
    expect(send.mock.calls[0]?.[1]).toMatchObject({
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
    const [continuationToken, input] = send.mock.calls[0]!;
    expect(input.message).toContain("Issue opened: #5 Track webhook issue events");
    expect(continuationToken).toBe("repo:123:issue:5");
    expect(input).toMatchObject({
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
      credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
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
    const [continuationToken, input] = send.mock.calls[0]!;
    expect(input.message).toContain("Pull request opened: #7 Add webhook PR handling");
    expect(continuationToken).toBe("repo:123:pull:7");
    expect(input).toMatchObject({
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
      credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
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
    const [continuationToken, input] = send.mock.calls[0]!;
    expect(input.message).toContain(`${testCase.label} completed: 9001 (failure)`);
    expect(continuationToken).toBe("repo:123:pull:7");
    expect(input).toMatchObject({
      state: {
        conversationKind: "pull_request",
        headSha,
        issueNumber: 7,
        pullRequestNumber: 7,
      },
    });
  });

  it("invokes CI hooks without dispatching when no pull request is associated", async () => {
    const logs = captureLogRecords();
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
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "GitHub CI event cannot dispatch without an associated pull request",
      }),
    );
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

  it("renders the mention instruction from a lazy botName resolver", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 79 })));
    const adapter = withState(
      getAdapter(
        githubChannel({
          api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
          botName: () => Promise.resolve("testbot"),
          credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
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
      makeEvent("input.requested", {
        requests: [
          {
            action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "deploy" },
            options: [
              { id: "approve", label: "Yes" },
              { id: "deny", label: "No" },
            ],
            prompt: "Approve this change?",
            requestId: "call_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      body: "Approve this change?\n\n1. Yes\n2. No\n\nAnswer by mentioning me in a reply, e.g. `@testbot Yes`.",
    });
  });

  it("omits the mention instruction when no bot name is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 78 })));
    const adapter = withState(
      getAdapter(
        githubChannel({
          api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
          credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
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

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "deploy" },
            options: [
              { id: "approve", label: "Yes" },
              { id: "deny", label: "No" },
            ],
            prompt: "Approve this change?",
            requestId: "call_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      buildAdapterContext(adapter, stubAccessor()),
    );

    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      body: "Approve this change?\n\n1. Yes\n2. No",
    });
  });

  it("does not post an empty input request comment", async () => {
    const fetchMock = vi.fn();
    const adapter = withState(
      getAdapter(
        githubChannel({
          api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
          credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
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

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      buildAdapterContext(adapter, stubAccessor()),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turn.started adds an eyes reaction to the triggering comment", async () => {
    const logs = captureLogRecords();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 77 }))));
    const adapter = withState(
      getAdapter(
        githubChannel({
          api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
          credentials: {
            installationToken: "ghs_test",
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
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "error", message: "GitHub checkout failed — swallowed" }),
    );
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
            installationToken: "ghs_test",
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

// #3506: the configured network policy is the limit. Checkout may only attach
// its credential to GitHub hosts the policy already allows, and never leaves it behind.
describe("GitHub checkout network policy", () => {
  const gitHubHosts: SandboxNetworkPolicy = {
    allow: { "codeload.github.com": [], "github.com": [] },
  };

  it.fails("refuses to check out under deny-all without writing a policy", async () => {
    const logs = captureLogRecords();
    const sandbox = networkPolicySandbox({ networkPolicy: "deny-all" });

    await runCheckoutTurn(sandbox);

    expect(sandbox.writes).toEqual([]);
    expect(sandbox.fetchPolicies).toEqual([]);
    const [failure] = checkoutFailureMessages(logs.records);
    expect(failure).toContain("github.com");
    expect(failure).toContain("codeload.github.com");
  });

  it.fails("fetches with the credential on allowed GitHub hosts only", async () => {
    const sandbox = networkPolicySandbox({ networkPolicy: gitHubHosts });

    const ctx = await runCheckoutTurn(sandbox);

    expect(ctx.state.headSha).toBe(CHECKOUT_HEAD_SHA);
    expect(sandbox.fetchPolicies).toHaveLength(1);
    const fetchPolicy = sandbox.fetchPolicies[0];
    const allow = typeof fetchPolicy === "object" ? fetchPolicy.allow : undefined;
    expect(allow).not.toBeInstanceOf(Array);
    expect(Object.keys(allow ?? {}).sort()).toEqual(["codeload.github.com", "github.com"]);
    expect(JSON.stringify(allow)).toContain("Authorization");
    expect(sandbox.inForce()).toEqual(gitHubHosts);
  });

  it.fails("restores the configured policy when the fetch fails", async () => {
    const logs = captureLogRecords();
    const sandbox = networkPolicySandbox({ fetchExitCode: 128, networkPolicy: gitHubHosts });

    await runCheckoutTurn(sandbox);

    expect(sandbox.fetchPolicies).toHaveLength(1);
    expect(checkoutFailureMessages(logs.records)).toHaveLength(1);
    expect(sandbox.inForce()).toEqual(gitHubHosts);
  });
});
