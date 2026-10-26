import { createHmac } from "node:crypto";
import { afterEach, expect, describe, it, vi } from "vitest";

import { type CompiledChannel, isCompiledChannel } from "#channel/compiled-channel.js";
import type { Runtime } from "#channel/types.js";
import { dispatchChannelRequest } from "#internal/nitro/routes/channel-dispatch.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { slackChannel } from "#public/channels/slack/index.js";
import { HITL_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import { teamsChannel } from "#public/channels/teams/index.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { H3Event } from "nitro";

vi.mock("#internal/nitro/routes/runtime-stack.js", () => ({
  resolveNitroChannelRuntimeBundle: vi.fn(),
}));

vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({ getDeploymentId: async () => "dpl_test" }),
}));

const mockedResolveNitroChannelRuntimeBundle = vi.mocked(resolveNitroChannelRuntimeBundle);

function asCompiled(channel: unknown): CompiledChannel {
  if (!isCompiledChannel(channel)) throw new Error("Expected compiled channel.");
  return channel;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * A runtime whose sessions have all ended, as after a run cancelled outside
 * eve. Like a real one, it answers after the webhook has been acknowledged.
 */
function runtimeWithNoActiveSession(acknowledged: Promise<void>): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(async () => {
      await acknowledged;
      return { status: "session_not_active" };
    }) as Runtime["dispatchContinuation"],
    dispatchSession: vi.fn(),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    resolveContinuation: vi.fn(),
  };
}

describe("an inactive press through the production dispatcher", () => {
  /** A card edit that starts, then waits until the test lets it finish. */
  function heldEdit() {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    return {
      async hold(): Promise<void> {
        started.resolve();
        await release.promise;
      },
      release: () => release.resolve(),
      started: started.promise,
    };
  }

  /**
   * Serves `request` with `channel`'s real route against a runtime that has no
   * active session, and returns the one task handed to the platform. It is
   * wrapped, since awaiting a returned promise would wait for the task itself.
   */
  async function dispatchInactivePress(
    channel: CompiledChannel,
    request: Request,
  ): Promise<{ readonly task: Promise<unknown> }> {
    const acknowledged = createDeferred<void>();
    const definition = channel as CompiledChannel & {
      routes: readonly { readonly handler: ResolvedChannelDefinition["handler"] }[];
    };
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      agentName: "test-agent",
      channels: [
        {
          adapter: channel.adapter,
          definition: channel,
          fetch: async () => new Response("ok"),
          handler: definition.routes[0]!.handler,
          logicalPath: "agent/channels/press.ts",
          method: "POST",
          name: "press",
          sourceId: "channel-press",
          sourceKind: "module",
          urlPath: "/press",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime: runtimeWithNoActiveSession(acknowledged.promise),
    });
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();
    Object.assign(request, { ip: "127.0.0.1" });
    const handOff: (task: Promise<unknown>) => void = waitUntil;
    const event = { context: { params: {} }, req: request, waitUntil: handOff } as H3Event;
    await dispatchChannelRequest(event, "POST /press", {} as never);
    acknowledged.resolve();
    expect(waitUntil).toHaveBeenCalledTimes(1);
    return { task: waitUntil.mock.calls[0]![0] };
  }

  async function expectHeldUntilRelease(
    task: Promise<unknown>,
    edit: ReturnType<typeof heldEdit>,
  ): Promise<void> {
    let settled = false;
    void task.then(() => {
      settled = true;
    });
    await edit.started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled, "the request let go before the card's edit finished").toBe(false);
    edit.release();
    await task;
    expect(settled).toBe(true);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a Teams button press's request alive until its card is retired", async () => {
    const edit = heldEdit();
    const channel = asCompiled(
      teamsChannel({
        api: {
          fetch: async (input: string | URL | Request, init?: RequestInit) => {
            if (new Request(input, init).method === "PUT") await edit.hold();
            return new Response(JSON.stringify({ id: "card" }));
          },
        },
        credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
      }),
    );
    // An Action.Submit button posts a message activity carrying its data.
    const request = new Request("https://eve.test/press", {
      body: JSON.stringify({
        channelData: { tenant: { id: "TENANT" } },
        conversation: { conversationType: "personal", id: "CONV" },
        from: { id: "USER", name: "Ada" },
        id: "PRESS",
        recipient: { id: "BOT", name: "eve Bot" },
        replyToId: "CARD",
        serviceUrl: "https://smba.example.test/teams",
        type: "message",
        value: {
          eve_input: { optionId: "approve", prompt: "Deploy?", requestId: "REQ" },
        },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const { task } = await dispatchInactivePress(channel, request);
    await expectHeldUntilRelease(task, edit);
  });

  it("keeps a Slack button press's request alive until its card is retired", async () => {
    const edit = heldEdit();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (new Request(input, init).url.endsWith("/chat.update")) await edit.hold();
      return Response.json({ ok: true, ts: "1700000000.000010" });
    });
    const signingSecret = "test-signing-secret";
    const channel = asCompiled(
      slackChannel({
        credentials: { botToken: "xoxb-test", signingSecret },
      }),
    );
    const body = new URLSearchParams({
      payload: JSON.stringify({
        actions: [
          {
            action_id: `${HITL_ACTION_PREFIX}tool-approval:approval_abc123:button:0`,
            text: { text: "Approve", type: "plain_text" },
            value: "approve",
          },
        ],
        channel: { id: "C01" },
        message: {
          blocks: [{ text: { text: "Approve?", type: "mrkdwn" }, type: "section" }],
          thread_ts: "1700000000.000001",
          ts: "1700000000.000010",
        },
        team: { id: "T01" },
        type: "block_actions",
        user: { id: "U_APPROVER", name: "ada", team_id: "T01", username: "ada" },
      }),
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const request = new Request("https://eve.test/press", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": signature,
      },
      method: "POST",
    });

    const { task } = await dispatchInactivePress(channel, request);
    await expectHeldUntilRelease(task, edit);
  });
});
