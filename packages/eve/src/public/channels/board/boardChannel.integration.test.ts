import { describe, expect, it } from "vitest";

import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { createTestBoard, type TestBoard } from "#internal/testing/board-server.js";
import type { ChannelSendOptions } from "#channel/channel-operations.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import {
  boardChannel,
  type BoardChannelConfig,
  type BoardChannelState,
} from "#public/channels/board/boardChannel.js";
import { createBoardClient } from "#public/channels/board/client.js";
import type { MessageContent } from "#shared/message-content.js";

type Delivery = ChannelSendOptions<BoardChannelState> & {
  readonly address: string;
  readonly message: MessageContent;
};

/**
 * A channel on a real in-memory board, with its wake route driven the way the local poller
 * drives it. `deliver` sees each send, and can throw to stand in for the session.
 */
function boardHarness(
  config: Omit<BoardChannelConfig, "url" | "api" | "credentials">,
  deliver: (address: string) => void = () => {},
) {
  const team = createTestBoard();
  const acks: string[] = [];
  // Posts wait for the channel's first pull, which registers its watchers: a watcher sees only
  // what's posted after it registers.
  const queued: (() => Promise<void>)[] = [];
  const api = {
    async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/watchers/matches")) {
        for (const post of queued.splice(0)) await post();
      }
      if (request.url.endsWith("/ack")) acks.push(request.url);
      return await team.fetch(request);
    },
  };
  const channel = boardChannel({
    ...config,
    api,
    credentials: { token: () => team.eveToken() },
    url: team.url,
  });
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const wake = (channel as CompiledChannel<BoardChannelState>).routes.find(
    (route) => route.method === "POST",
  );
  if (!wake || !isHttpRouteDefinition(wake)) throw new Error("Expected the wake route.");

  const deliveries: Delivery[] = [];
  const resets: string[] = [];
  const context = mockChannelContext<BoardChannelState>((address, input) => {
    deliver(address);
    if ("message" in input) deliveries.push({ ...input, address });
    return { id: "delivery" };
  });

  return {
    acks,
    deliveries,
    resets,
    team,
    /** Posts before the next pull; resolves with the posted message once it lands. */
    queue(post: () => Promise<{ id: string; thread: string }>) {
      return new Promise<{ id: string; thread: string }>((resolve, reject) => {
        queued.push(() => post().then(resolve, reject));
      });
    },
    /** One pull: the board holds it open until a match arrives. */
    async pull() {
      const response = await wake.handler(
        new Request("http://localhost:3000/eve/v1/board/wake", {
          headers: { "x-eve-board-poll": "1" },
          method: "POST",
        }),
        {
          ...mockAgentRouteArgs(),
          attachSession: (() => {
            throw new Error("unused");
          }) as never,
          ...context,
          from(address) {
            const source = context.from(address);
            return {
              ...source,
              async reset(options) {
                resets.push(address);
                return await source.reset(options);
              },
            };
          },
          params: {},
          requestIp: null,
          to: (() => {
            throw new Error("unused");
          }) as never,
          waitUntil: () => {},
        },
      );
      expect(response.status).toBe(200);
    },
    agent: createBoardClient({
      api,
      credentials: { token: () => team.eveToken() },
      profile: "eve",
      url: team.url,
    }),
  };
}

async function postAs(team: TestBoard, person: string, body: Record<string, unknown>) {
  const response = await team.fetch(
    new Request(`${team.url}/messages`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${await team.personToken(person)}`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { message: { id: string; thread: string } }).message;
}

describe("boardChannel against @vercel/board", () => {
  it("starts a fresh session when the thread's session was stranded by an eve upgrade", async () => {
    let stranded = true;
    const board = boardHarness({ tail: "dev" }, () => {
      if (!stranded) return;
      stranded = false;
      throw new SessionStrandedError({ eveVersion: "0.0.1" });
    });
    const posted = board.queue(() =>
      postAs(board.team, "alice", { channel: "dev", text: "Is the deploy done?" }),
    );

    await board.pull();
    const root = await posted;

    const address = `eve:thread:${root.thread}`;
    expect(board.resets).toEqual([address]);
    expect(board.deliveries.map((delivery) => [delivery.address, delivery.message])).toEqual([
      [address, "Is the deploy done?"],
    ]);
    // The match was acked rather than handed back for the board to retry.
    expect(board.acks).toHaveLength(1);
  });

  it("gives each watcher its own session and context, and skips the agent's own posts", async () => {
    const board = boardHarness({
      watchers: {
        thread: { tail: "dev" },
        review: { tail: "dev --label pr", context: ["Review the pull request."] },
      },
    });
    // The agent's own post matches `thread`, whose name isn't its profile, so the board delivers it.
    void board.queue(() => board.agent.post("dev", { text: "Starting on the flaky test." }));
    const posted = board.queue(() =>
      postAs(board.team, "alice", {
        channel: "dev",
        labels: { pr: "acme/www#12" },
        text: "Please review my fix.",
      }),
    );

    for (let pull = 0; pull < 5 && board.deliveries.length < 2; pull += 1) await board.pull();
    const pr = await posted;

    expect(
      board.deliveries
        .map((delivery) => ({
          address: delivery.address,
          context: delivery.context?.slice(1),
          message: delivery.message,
          watcher: delivery.auth?.attributes.watcher,
        }))
        .sort((a, b) => a.address.localeCompare(b.address)),
    ).toEqual([
      {
        address: `review:thread:${pr.thread}`,
        context: ["Review the pull request."],
        message: "Please review my fix.",
        watcher: "review",
      },
      {
        address: `thread:thread:${pr.thread}`,
        context: [],
        message: "Please review my fix.",
        watcher: "thread",
      },
    ]);
    // Three matches were pulled and acked: the agent's own post was seen and skipped.
    if (board.acks.length < 3) await board.pull();
    expect(board.acks).toHaveLength(3);
    expect(board.deliveries).toHaveLength(2);
  });
});
