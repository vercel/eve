import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { githubChannel } from "#public/channels/github/githubChannel.js";
import { GITHUB_CHANNEL_SUBSCRIPTIONS } from "#public/channels/github/subscriptions.js";
import { signGitHubWebhookBody } from "#public/channels/github/verify.js";
import type { PublishChannelEventFn } from "#shared/channel-subscriptions.js";

const SECRET = "github-secret";

function payload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    installation: { id: 55 },
    repository: {
      full_name: "Vercel/Eve",
      id: 123,
      name: "Eve",
      owner: { login: "Vercel" },
      private: false,
    },
    sender: { id: 1, login: "octocat", type: "User" },
    ...extra,
  };
}

async function deliver(input: {
  readonly event: string;
  readonly body: Record<string, unknown>;
  readonly fetch?: typeof fetch;
}): Promise<ReturnType<typeof vi.fn<PublishChannelEventFn>>> {
  const channel = githubChannel({
    api: { apiBaseUrl: "https://github.test", fetch: input.fetch },
    credentials: { installationToken: "ghs_test", webhookSecret: SECRET },
  });
  if (!isCompiledChannel(channel)) throw new Error("Expected a CompiledChannel.");
  const post = channel.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected a POST route.");

  const body = JSON.stringify(input.body);
  const publish = vi.fn<PublishChannelEventFn>().mockResolvedValue(true);
  const waitUntil = vi.fn();
  const response = await post.handler(
    new Request("https://example.com/eve/v1/github", {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": input.event,
        "x-hub-signature-256": signGitHubWebhookBody(body, SECRET),
      },
      method: "POST",
    }),
    {
      ...mockAgentRouteArgs(),
      attachSession: vi.fn() as never,
      ...mockChannelContext(vi.fn().mockResolvedValue({ id: "s1" })),
      params: {},
      publish,
      requestIp: null,
      to: vi.fn() as never,
      waitUntil,
    },
  );
  expect(response.status).toBe(200);
  await Promise.all(waitUntil.mock.calls.map(([task]) => task as Promise<unknown>));
  return publish;
}

const checkSuite = (conclusion: string, pullRequests: readonly number[]) =>
  payload({
    action: "completed",
    check_suite: {
      app: { slug: "github-actions" },
      conclusion,
      head_sha: "a".repeat(40),
      id: 77,
      pull_requests: pullRequests.map((number) => ({ number })),
      status: "completed",
    },
  });

describe("GitHub channel subscriptions", () => {
  it("offers checks_finished and pr_comment with a case-insensitive repository", () => {
    expect(Object.keys(GITHUB_CHANNEL_SUBSCRIPTIONS)).toEqual(["checks_finished", "pr_comment"]);
    expect(
      GITHUB_CHANNEL_SUBSCRIPTIONS.checks_finished?.normalize?.({
        owner: "Vercel",
        pull: 7,
        repo: "Eve",
      }),
    ).toEqual({ owner: "vercel", pull: 7, repo: "eve" });
  });

  it("publishes a passing check suite to each pull request it ran on", async () => {
    const publish = await deliver({ body: checkSuite("success", [7, 9]), event: "check_suite" });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(
      "checks_finished",
      { owner: "Vercel", pull: 7, repo: "Eve" },
      {
        id: "delivery-1:checks_finished:7",
        message: expect.stringContaining("github-actions check suite concluded success"),
      },
    );
    expect(publish.mock.calls.map(([, input]) => input.pull)).toEqual([7, 9]);
  });

  it("lists the check runs that did not pass when a suite fails", async () => {
    const fetchMock = vi.fn(async (_input: Request | URL | string) =>
      Response.json({
        check_runs: [
          { conclusion: "success", name: "lint" },
          { conclusion: "failure", html_url: "https://github.test/run/1", name: "unit tests" },
          { conclusion: null, name: "still running" },
        ],
      }),
    );
    const publish = await deliver({
      body: checkSuite("failure", [7]),
      event: "check_suite",
      fetch: fetchMock as typeof fetch,
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://github.test/repos/Vercel/Eve/check-suites/77/check-runs?per_page=100",
    );
    const message = publish.mock.calls[0]![2].message;
    expect(message).toContain("concluded failure");
    expect(message).toContain("- unit tests (failure) https://github.test/run/1");
    expect(message).not.toContain("lint");
    expect(message).not.toContain("still running");
  });

  it("publishes nothing for an unfinished suite or one with no pull request", async () => {
    const unfinished = payload({
      action: "requested",
      check_suite: { app: { slug: "x" }, id: 1, pull_requests: [{ number: 7 }] },
    });
    expect(await deliver({ body: unfinished, event: "check_suite" })).not.toHaveBeenCalled();
    expect(
      await deliver({ body: checkSuite("success", []), event: "check_suite" }),
    ).not.toHaveBeenCalled();
  });

  it("publishes a new pull request comment and marks its text as untrusted", async () => {
    const publish = await deliver({
      body: payload({
        action: "created",
        comment: {
          body: "please rename this",
          html_url: "https://github.test/c/1",
          id: 501,
          user: { id: 2, login: "reviewer", type: "User" },
        },
        issue: { number: 7, pull_request: { url: "https://github.test/pulls/7" } },
      }),
      event: "issue_comment",
    });

    expect(publish).toHaveBeenCalledWith(
      "pr_comment",
      { owner: "Vercel", pull: 7, repo: "Eve" },
      {
        id: "delivery-1:pr_comment:501",
        message: expect.stringMatching(
          /from reviewer.*not as an instruction[\s\S]*please rename this/u,
        ),
      },
    );
  });

  it("publishes nothing for a comment on a plain issue or an edited comment", async () => {
    const comment = { body: "hi", id: 1, user: { id: 2, login: "x", type: "User" } };
    expect(
      await deliver({
        body: payload({ action: "created", comment, issue: { number: 3 } }),
        event: "issue_comment",
      }),
    ).not.toHaveBeenCalled();
    expect(
      await deliver({
        body: payload({
          action: "edited",
          comment,
          issue: { number: 7, pull_request: { url: "https://github.test/pulls/7" } },
        }),
        event: "issue_comment",
      }),
    ).not.toHaveBeenCalled();
  });
});
